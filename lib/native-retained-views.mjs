import { createHash, createHmac, randomBytes } from "node:crypto";
import { BoardError } from "./store.mjs";
import { isNativePersistence } from "./native-persistence.mjs";
import { NATIVE_RETAINED_CONTRACT, NATIVE_READ_LIMITS } from "./native-read-model.mjs";
import { NATIVE_SEGMENTED_SOURCES, nativeSegmentedRowKey, nativeCallKey, unitPrefix } from "./native-segmented-codec.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { projectRetainedNativeEntries, nativeActivityRows, nativeObservationInstant, nativeMessageCreationInstants } from "./retained-population.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { OUTCOMES } from "./analytics.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { time } from "./time.mjs";
import { SEARCH_TYPES, SEARCH_MATCH_POLICY_ID, indexSearchText, rankTextSearch, textSearchHit } from "./search-text.mjs";
import { corpusText, retainedTextTitle } from "./search-corpus-content.mjs";
import { sourceFactText, nativeSourceFactComplete } from "./search-corpus-sources.mjs";

const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code, status = 422) => { throw Object.assign(
    new BoardError(code === "NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE"
        ? "Some saved Microsoft text is unavailable. Search cannot verify all matching activity."
        : `Retained Microsoft view unavailable (${code}). Read a current view; no operation was replayed.`, status), { code }); };
const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
const countKeys = ["conversations", "variants", "messages", "parts", "taskStates", "calls", "returnedResults"];
const counts = () => Object.fromEntries(countKeys.map(key => [key, 0]));
const outcomes = () => Object.fromEntries(OUTCOMES.map(key => [key, 0]));
const title = source => source === "microsoft-365-chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork";
const previewText = (value, fallback) => {
    const text = corpusText(value), preview = retainedTextTitle(text, fallback);
    return preview + (text.trim().length > preview.length ? "..." : "");
};
const reference = (key, domain, value) => createHmac("sha256", key).update(JSON.stringify([domain, value])).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const maximumResponseBytes = 8 * 1024 * 1024;
const freeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

function validate(input, fields) {
    if (!exact(input, ["schemaVersion", "revision", "sources", "page", ...fields]) || input.schemaVersion !== 1
        || input.revision !== null && (!Number.isSafeInteger(input.revision) || input.revision < 0)
        || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 2
        || input.sources.some(source => !NATIVE_SEGMENTED_SOURCES.includes(source))
        || new Set(input.sources).size !== input.sources.length
        || !exact(input.page, ["limit", "after"]) || !Number.isInteger(input.page.limit)
        || input.page.limit < 1 || input.page.limit > 100 || input.page.after !== null && !hash(input.page.after)) {
        fail("NATIVE_VIEW_INPUT_INVALID");
    }
}

function publicReadback(reader) {
    return { schemaVersion: 1, snapshotRef: reader.source.sourceSnapshotRef,
        committed: reader.readback.committed, current: reader.readback.current, deletionVersion: reader.source.deletionVersion };
}

// One admitted root traversal. Only a bounded output page and scalar counters survive it.
export function createNativeRetainedViews(context, persistence, lifecycle) {
    if (!isNativePersistence(persistence, context, lifecycle)
        || !["withRetainedReader", "pinRetainedReader", "withPinnedRetainedReader", "releaseRetainedReader"]
            .every(name => typeof persistence[name] === "function")) fail("NATIVE_VIEW_BINDING_REQUIRED", 503);
    const cursors = new Map(), acceptedViews = new Map();
    const offeredReaders = new Map(), readingReaders = new Map();
    const readerKey = (owner, revision, sourceRevision) => JSON.stringify([owner, revision, sourceRevision]);
    function forgetReader(cache, key) {
        const held = cache.get(key);
        if (held) persistence.releaseRetainedReader(held.frame);
        cache.delete(key);
    }
    function keepReader(cache, key, held) {
        cache.delete(key); cache.set(key, held);
        while (cache.size > 128) forgetReader(cache, cache.keys().next().value);
    }
    let closed = false;
    function check(signal) {
        if (closed) fail("NATIVE_VIEW_CLOSED", 403);
        signal?.throwIfAborted();
    }
    function cursor(input, request, reader, key, kind) {
        const { page, revision, at, sourceRevision, ...selector } = input;
        const selectionRef = reference(key, "native-public-view-v1", [kind, selector]);
        const basis = { owner: request.owner, revision: reader.revision, sourceRevision: reader.source.sourceRevisionRef,
            selectionRef, limit: page.limit };
        let after = null;
        if (page.after !== null) {
            const previous = cursors.get(page.after);
            if (!previous || previous.expires < Date.now()
                || nativeRetentionHash(previous.basis) !== nativeRetentionHash(basis)) fail("NATIVE_VIEW_CURSOR_STALE", 409);
            after = previous.after;
        }
        return { basis, after, next(value) {
            for (const [token, held] of cursors) if (held.expires < Date.now()) cursors.delete(token);
            if (cursors.size >= 128) cursors.delete(cursors.keys().next().value);
            const token = randomBytes(32).toString("hex");
            cursors.set(token, { basis, after: value, expires: Date.now() + 600000 });
            return token;
        } };
    }
    function pageBuilder(limit, after) {
        const items = [];
        let last = null, more = false, size = 0;
        return {
            add(position, item) {
                if (after !== null && position <= after) return;
                if (items.length >= limit) { more = true; return; }
                const length = bytes(item);
                if (length > maximumResponseBytes / 2) fail("NATIVE_VIEW_ITEM_TOO_LARGE", 413);
                if (size + length > maximumResponseBytes / 2) { more = true; return; }
                if (more) return;
                size += length; last = position; items.push(item);
            },
            finish(cursor, remaining = 0) { return { items, limit, nextCursor: more || remaining > items.length ? cursor.next(last) : null }; },
        };
    }
    function header(reader, cursor, kind) {
        return { schemaVersion: 1, kind, revision: reader.revision, sourceRevision: reader.source.sourceRevisionRef,
            selectionRef: cursor.basis.selectionRef, definitions: reader.definitions, readback: publicReadback(reader) };
    }
    function acceptView(kind, input, request, reader, groupId, analysis, membershipRef) {
        for (const [token, held] of acceptedViews) if (held.expires < Date.now()) acceptedViews.delete(token);
        if (acceptedViews.size >= 128) acceptedViews.delete(acceptedViews.keys().next().value);
        const token = randomBytes(32).toString("hex");
        const timeContext = time.normalize(input.analytics.timeContext);
        acceptedViews.set(token, freeze({ kind, owner: request.owner, revision: reader.revision,
            sourceRevision: reader.source.sourceRevisionRef, definitions: structuredClone(reader.definitions),
            sources: [...input.sources], analytics: kind === "all" ? { layer: "tool", filters: { scope: "all" }, timeContext }
                : { ...structuredClone(input.analytics), timeContext },
            ...(kind === "current" && groupId ? { groupId } : {}),
            ...(kind === "current" && analysis ? { analysis: structuredClone(analysis), membershipRef } : {}),
            expires: Date.now() + 600000 }));
        return token;
    }
    function acceptedView(input, request) {
        const original = acceptedViews.get(input.viewId);
        if (!original || original.owner !== request.owner || original.expires < Date.now()
            || original.revision !== input.revision || original.kind !== "current") fail("NATIVE_VIEW_SELECTION_STALE", 409);
        return original;
    }
    function validateViewRequest(input, field) {
        const fields = Array.isArray(field) ? field : [field];
        if (!exact(input, ["schemaVersion", "revision", "viewId", ...fields, "page"]) || !hash(input.viewId)
            || !Number.isSafeInteger(input.revision) || input.revision < 0) fail("NATIVE_VIEW_INPUT_INVALID");
        validate({ schemaVersion: input.schemaVersion, revision: input.revision, sources: ["microsoft-365-chat"],
            page: input.page }, []);
    }
    async function run(input, request, kind, signal, work, identityInput = input) {
        check(signal);
        const key = kind === "native-retained-detail" && hash(input.sourceRevision)
            ? readerKey(request.owner, input.revision, input.sourceRevision) : null;
        const pinned = key && (readingReaders.get(key) ?? offeredReaders.get(key));
        const consume = async (reader, assertCurrent, state) => {
            const current = () => { check(signal); assertCurrent(); };
            const id = (domain, value) => reference(state.pseudonymKey, domain, value);
            const position = cursor(identityInput, request, reader, state.pseudonymKey, kind);
            const result = await work(reader, current, id, position);
            current();
            if (bytes(result) > maximumResponseBytes) fail("NATIVE_VIEW_RESPONSE_TOO_LARGE", 413);
            if (!pinned) {
                const offeredKey = readerKey(request.owner, reader.revision, reader.source.sourceRevisionRef);
                const authority = nativeRetentionHash([reader.readback.current, reader.source.deletionVersion]);
                const existing = readingReaders.get(offeredKey) ?? offeredReaders.get(offeredKey);
                if (!existing || existing.authority !== authority) {
                    forgetReader(readingReaders, offeredKey); forgetReader(offeredReaders, offeredKey);
                    keepReader(offeredReaders, offeredKey, { authority, frame: persistence.pinRetainedReader(reader, request) });
                }
            }
            return freeze(result);
        };
        const value = pinned
            ? await persistence.withPinnedRetainedReader(pinned.frame, request, consume)
            : await persistence.withRetainedReader({ revision: input.revision }, request, consume);
        check(signal);
        if (pinned) {
            offeredReaders.delete(key);
            keepReader(readingReaders, key, pinned);
        }
        return value;
    }
    const projected = entry => projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries: [entry] }).records[0];
    async function* conversations(reader, input, current, signal) {
        for await (const row of reader.iterateRows({ prefix: "u/", signal })) {
            current();
            if (row.unitKind === "conversation" && input.sources.includes(row.sourceId)) yield row;
        }
    }
    async function* entries(reader, unit, current, signal) {
        for await (const member of reader.iterateRows({
            prefix: unitPrefix(unit.sourceId, unit.conversationKey, unit.unitKind, unit.unitKey) + "/", signal,
        })) {
            current();
            yield await reader.entryAt(member.inputOrdinal, { signal });
        }
    }
    async function textMatches(analysis, type, content, label, signal, titleText) {
        if (!analysis || !analysis.types.includes(type)) return false;
        content = corpusText(content);
        const item = { id: "native-selected-text", revision: "current", type, content,
            title: corpusText(titleText ?? retainedTextTitle(content, label)), source: { label } };
        return (await rankTextSearch([indexSearchText(item)], analysis.query, analysis.types, signal)).length === 1;
    }
    async function messageMatch(record, analysis, signal) {
        if (!analysis) return false;
        const conversation = record.nativeConversation, label = title(record.sourceId);
        let matched = false;
        for (const message of conversation.messages) {
            const type = message.value?.author === "user" ? "interaction" : message.value?.author === "assistant" ? "reply" : "context";
            if (!analysis.types.includes(type)) continue;
            if (message.availability !== "recorded") fail("NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE", 428);
            matched = await textMatches(analysis, type, message.value.text, label, signal) || matched;
        }
        if (analysis.types.includes("context")) for (const group of conversation.sourceObservations ?? []) {
            if (!nativeSourceFactComplete(group)) fail("NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE", 428);
            for (const fact of group.facts) {
                const text = sourceFactText(fact);
                if (text.incomplete) fail("NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE", 428);
                if (text.content) matched = await textMatches(analysis, "context", text.content, label, signal) || matched;
            }
        }
        return matched;
    }
    async function callRow(reader, unit, current, signal, analysis) {
        let first, name = null, nameConflict = false, state = null, stateConflict = false;
        const names = new Set(), inputs = new Set(), starts = new Set();
        let textBytes = 0;
        const retain = (set, value) => {
            if (set.has(value)) return;
            textBytes += Buffer.byteLength(value) + 64;
            if (textBytes > NATIVE_READ_LIMITS.bytes) fail("NATIVE_VIEW_TEXT_SELECTION_TOO_LARGE", 413);
            set.add(value);
        };
        for await (const entry of entries(reader, unit, current, signal)) {
            const record = entry.record;
            const call = record.identity.nativeCalls.find(value => nativeCallKey(record.scope, value.nativeCallId) === unit.unitKey);
            if (!call) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
            first ??= nativeActivityRows([projected(entry)], "tool").find(row => row.id === unit.unitKey);
            if (record.identity.nativeType === "ts" && record.retention?.current !== false) starts.add(nativeObservationInstant(record));
            for (const value of call.nativeToolName === null ? [] : [call.nativeToolName]) {
                retain(names, value);
                if (name !== null && name !== value) nameConflict = true;
                name ??= value;
            }
            const outcome = record.identity.callIds.length === 1 ? record.outcomes.tool?.state : null;
            if (outcome && outcome !== "unknown") {
                if (state !== null && state !== outcome) stateConflict = true;
                state ??= outcome;
            }
            if (analysis?.types.includes("action")) {
                const individual = record.callFacts.find(fact => fact.nativeCallId === call.nativeCallId)?.fields ?? {};
                const field = record.identity.callIds.length === 1 ? individual.input ?? record.fields.input : individual.input;
                if (["recorded", "recorded-empty"].includes(field?.availability)) {
                    retain(inputs, typeof field.value === "string" ? field.value : JSON.stringify(field.value));
                }
            }
        }
        if (!first) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
        const row = { ...first, startedAt: starts.size === 1 ? [...starts][0] : null,
            tool: nameConflict ? null : name, nativeToolNames: [...names],
            outcome: stateConflict ? "unknown" : ({ succeeded: "success", failed: "failure" })[state] ?? "unknown" };
        if (analysis) row.textMatched = await textMatches(analysis, "action",
            [...row.nativeToolNames, ...inputs, row.outcome].join("\n"), title(unit.sourceId), signal,
            row.tool ?? "Native tool name not qualified");
        return row;
    }
    async function query(input, request, { signal, accepted, onMember, onRow, issueViews = true,
        groupId = accepted?.groupId, analysis = accepted?.analysis, verifyMembership = false,
        kind = "native-retained-page", identityInput = input, finish, includeRecognition = false, allowEmptyGroup = false } = {}) {
        validate(input, ["analytics"]);
        validateAnalyticsInput(input.analytics);
        signal ??= new AbortController().signal;
        if (analysis && analysis.matchPolicyId !== SEARCH_MATCH_POLICY_ID) fail("NATIVE_VIEW_SELECTION_STALE", 409);
        return run(input, request, kind, signal, async (reader, current, id, cursor) => {
            if (accepted && (reader.source.sourceRevisionRef !== accepted.sourceRevision
                || nativeRetentionHash(reader.definitions) !== nativeRetentionHash(accepted.definitions))) {
                fail("NATIVE_VIEW_SELECTION_STALE", 409);
            }
            const timeContext = time.normalize(input.analytics.timeContext), bucket = input.analytics.bucket ?? "day";
            const dateRange = time.range(input.analytics.filters ?? {}, timeContext.timeZone);
            const filters = { ...input.analytics.filters, ...dateRange };
            const layer = input.analytics.layer ?? "tool";
            const contextEligible = !groupId && layer === "tool"
                && !["tools", "outcomes", "services", "workloads", "endpoints", "activityTypes"].some(name => filters[name]?.length);
            let conversationMatched = false;
            const groupBy = input.analytics.groupBy ?? "workload";
            const groupLabel = row => groupBy === "tool" ? row.tool ?? "Tool name not qualified"
                : groupBy === "endpoint" ? row.endpoint.label : row.workload;
            const matchesGroup = row => !groupId || id("native-group", [groupBy, groupLabel(row)]) === groupId;
            const selected = row => projection.selected({ ...row,
                sourceSessionId: id("native-conversation", row.sourceSessionId) }, filters) && matchesGroup(row)
                    && (!analysis || conversationMatched || row.textMatched);
            const beforeOutcome = row => projection.selected({ ...row,
                sourceSessionId: id("native-conversation", row.sourceSessionId) }, { ...filters, outcomes: undefined }) && matchesGroup(row)
                    && (!analysis || conversationMatched || row.textMatched);
            const aggregate = { complete: true, layer, ...counts(), outcomes: outcomes(), selectedRows: 0 };
            const groups = new Map(), tools = new Map(), sourceGroups = new Map(), dates = new Map(), facet = { count: 0, outcomes: outcomes() };
            let datedRows = 0;
            const membership = analysis ? createHash("sha256").update("wire-native-analysis-membership-v1\0") : null;
            let groupBytes = 0;
            let selectedTools, activityDateRange;
            function observeGroup(target, by, label, row) {
                if (!target.has(label)) {
                    const item = { id: id("native-group", [by, label]), label, count: 0, outcomes: outcomes() };
                    groupBytes += bytes(item) + 256;
                    if (groupBytes > NATIVE_READ_LIMITS.bytes) fail("NATIVE_VIEW_GROUPS_TOO_LARGE", 413);
                    target.set(label, item);
                }
                const group = target.get(label);
                group.count++; group.outcomes[row.outcome]++;
            }
            function observe(row) {
                if (beforeOutcome(row)) { facet.count++; facet.outcomes[row.outcome]++; }
                if (!selected(row)) return false;
                membership?.update(nativeRetentionHash(["action", layer, row.scenarioId, row.id]));
                onRow?.(row, id);
                observeGroup(groups, groupBy, groupLabel(row), row);
                if (!finish) observeGroup(tools, "tool", row.tool ?? "Tool name not qualified", row);
                if (!finish && row.tool) selectedTools.add(row.tool);
                if (!finish) {
                    if (row.startedAt) {
                        const instant = new Date(row.startedAt).toISOString();
                        activityDateRange.datedRows++;
                        if (!activityDateRange.firstAt || instant < activityDateRange.firstAt) activityDateRange.firstAt = instant;
                        if (!activityDateRange.lastAt || instant > activityDateRange.lastAt) activityDateRange.lastAt = instant;
                    } else activityDateRange.undatedRows++;
                }
                if (!finish && row.startedAt) {
                    const date = time.bucketDate(row.startedAt, bucket, timeContext.timeZone);
                    if (!dates.has(date)) {
                        if (dates.size >= 400) fail("NATIVE_VIEW_TIMELINE_TOO_LARGE", 413);
                        dates.set(date, { count: 0, outcomes: outcomes() });
                    }
                    const point = dates.get(date);
                    point.count++; point.outcomes[row.outcome]++; datedRows++;
                }
                return true;
            }
            const page = pageBuilder(input.page.limit, cursor.after);
            for await (const unit of conversations(reader, input, current, signal)) {
                const totals = counts();
                const selectedOutcomes = outcomes();
                let observations = false, allCalls = 0, selectedRows = 0;
                let recognition = null;
                let contextDateMatched = false;
                const contextRow = { sourceId: unit.sourceId, sourceSessionId: id("native-conversation", unit.unitKey),
                    projectId: null, scope: "history", promptAuthor: "unknown", startedAt: null, workload: "Unknown" };
                selectedTools = new Set();
                activityDateRange = { firstAt: null, lastAt: null, datedRows: 0, undatedRows: 0 };
                conversationMatched = false;
                for await (const entry of entries(reader, unit, current, signal)) {
                    const record = entry.record;
                    observations = true;
                    totals.variants++;
                    totals.messages += Number(Boolean(record.fields.message));
                    totals.parts += record.messageParts?.length ?? 0;
                    totals.taskStates += Number(Boolean(record.outcomes.task));
                    const message = record.fields.message ?? record.messageParts?.find(part => part.availability === "recorded");
                    if ((!finish || includeRecognition) && message?.availability === "recorded" && typeof message.value?.text === "string"
                        && (!recognition || message.value.author === "user" && recognition.kind !== "prompt")) {
                        recognition = { kind: message.value.author === "user" ? "prompt" : message.value.author === "assistant" ? "reply" : "context",
                            text: previewText(message.value.text, "Recorded message is empty.") };
                    }
                    if ((!finish || includeRecognition) && !recognition) for (const fact of record.chatSource?.observations ?? []) {
                        const text = sourceFactText(fact);
                        if (text.content) {
                            recognition = { kind: "context", text: previewText(text.content, "Recorded update") };
                            break;
                        }
                    }
                    if (contextEligible && (filters.from || filters.to) && unit.sourceId === "microsoft-365-chat" && !contextDateMatched) {
                        contextDateMatched = nativeMessageCreationInstants(projected(entry))
                            .some(startedAt => projection.selected({ ...contextRow, startedAt }, filters));
                    }
                    if (analysis) conversationMatched = await messageMatch(projected(entry), analysis, signal) || conversationMatched;
                }
                if (layer === "reported-api") for await (const entry of entries(reader, unit, current, signal)) {
                    for (const row of nativeActivityRows([projected(entry)], layer)) {
                        let canonical = row;
                        if (row.parentCallId) {
                            const call = await reader.lookupRow(unitPrefix(unit.sourceId, unit.conversationKey, "call", row.parentCallId, "u"), { signal });
                            if (!call) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
                            const parent = await callRow(reader, call, current, signal);
                            canonical = { ...row, tool: parent.tool, nativeToolNames: parent.nativeToolNames };
                        }
                        if (analysis) canonical.textMatched = await textMatches(analysis, "action",
                            [...canonical.nativeToolNames, canonical.outcome, canonical.status, canonical.errorCode]
                                .filter(value => value !== null && value !== undefined).join("\n"),
                            title(unit.sourceId), signal, canonical.tool ?? "Native tool name not qualified");
                        if (!observe(canonical)) continue;
                        totals.returnedResults++; selectedRows++; selectedOutcomes[row.outcome]++;
                    }
                }
                for await (const call of reader.iterateRows({
                    prefix: unitPrefix(unit.sourceId, unit.conversationKey, "call", null, "u"), signal,
                })) {
                    allCalls++;
                    if (layer !== "tool") continue;
                    const row = await callRow(reader, call, current, signal, analysis);
                    if (!observe(row)) continue;
                    totals.calls++; selectedRows++; selectedOutcomes[row.outcome]++;
                }
                // Preserve conversation-only membership without inventing a tool row.
                const noCall = contextEligible && (!analysis || conversationMatched) && observations
                    && (filters.from || filters.to ? contextDateMatched : !allCalls && projection.selected(contextRow, filters));
                if (!selectedRows && !noCall) continue;
                membership?.update(nativeRetentionHash(["conversation", unit.unitKey, conversationMatched, selectedRows]));
                onMember?.(unit, id("native-conversation", unit.unitKey), selectedRows, recognition?.text);
                totals.conversations = 1;
                for (const key of countKeys) aggregate[key] += totals[key];
                aggregate.selectedRows += selectedRows;
                for (const key of OUTCOMES) aggregate.outcomes[key] += selectedOutcomes[key];
                if (!sourceGroups.has(unit.sourceId)) sourceGroups.set(unit.sourceId,
                    { sourceId: unit.sourceId, conversations: 0, count: 0, outcomes: outcomes() });
                const source = sourceGroups.get(unit.sourceId);
                source.conversations++; source.count += selectedRows;
                for (const key of OUTCOMES) source.outcomes[key] += selectedOutcomes[key];
                page.add(nativeSegmentedRowKey(unit), { id: id("native-conversation", unit.unitKey),
                    sourceId: unit.sourceId, title: recognition?.text ?? "No recorded message text",
                    presentation: { kind: recognition?.kind ?? "unavailable",
                        tools: [...selectedTools].sort().slice(0, 3), toolCount: selectedTools.size,
                        contextDateBasis: !selectedRows && noCall && contextDateMatched ? "ordinary-message-created" : null,
                        activityDateRange },
                    counts: totals, selectedRows, outcomes: selectedOutcomes });
            }
            current();
            const membershipRef = membership ? id("native-analysis-membership", [
                reader.source.sourceRevisionRef, input.sources, input.analytics, groupId ?? null,
                analysis.matchPolicyId, analysis.query, analysis.types, membership.digest("hex"), aggregate,
            ]) : null;
            if (verifyMembership && analysis && membershipRef !== accepted.membershipRef) fail("NATIVE_VIEW_SELECTION_STALE", 409);
            if (groupId && !aggregate.selectedRows && !allowEmptyGroup) fail("NATIVE_VIEW_GROUP_UNAVAILABLE", 404);
            if (finish) return finish({ ...header(reader, cursor, kind), aggregates: aggregate }, cursor, id);
            function grouping(target, by) {
                const ordered = [...target.values()].sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
                const visible = ordered.slice(0, input.analytics.limit ?? 10);
                const other = { groupCount: ordered.length - visible.length, count: aggregate.selectedRows, outcomes: { ...aggregate.outcomes } };
                for (const group of visible) {
                    other.count -= group.count;
                    for (const key of OUTCOMES) other.outcomes[key] -= group.outcomes[key];
                }
                return { complete: true, groupBy: by, groupCount: target.size, groups: visible, other: other.groupCount ? other : null };
            }
            let timePoints;
            try { timePoints = projection.calendarBuckets(dates.keys(), bucket, timeContext, input.analytics.filters ?? {}, dateRange); }
            catch (error) {
                if (error instanceof RangeError && error.message.startsWith("Timeline exceeds 400 buckets")) fail("NATIVE_VIEW_TIMELINE_TOO_LARGE", 413);
                throw error;
            }
            return { ...header(reader, cursor, kind), aggregates: aggregate, ...(groupId ? { groupId } : {}),
                ...(analysis ? { textSelection: { purpose: "analysis", matchPolicyId: SEARCH_MATCH_POLICY_ID,
                    coverage: "complete", layer, types: [...analysis.types], membershipRef,
                    reportScope: "complete-matched-conversations" } } : {}),
                ...(issueViews ? { viewId: acceptView("current", input, request, reader, groupId, analysis, membershipRef),
                    allViewId: acceptView("all", input, request, reader) } : {}),
                grouping: grouping(groups, groupBy), toolGroups: grouping(tools, "tool"),
                sourceGroups: [...sourceGroups.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
                resultFacet: { complete: true, scope: "before-outcome", ...facet },
                timeSeries: { qualification: datedRows ? "source-observation-qualified" : "unqualified",
                    datedRows, undatedRows: aggregate.selectedRows - datedRows, bucket, timeZone: timeContext.timeZone,
                    points: timePoints.map(point => ({ ...point, ...(dates.get(point.date) ?? { count: 0, outcomes: outcomes() }) })) },
                coverage: { history: "selected-retained-root-not-complete-source-history",
                    activityDates: datedRows ? "source-observation-qualified" : "unqualified",
                    services: "unqualified", responseLatency: "unsupported", pageIsPopulation: false },
                page: page.finish(cursor) };
        }, identityInput);
    }
    async function drilldown(input, request, { signal } = {}) {
        validateViewRequest(input, "groupId");
        if (!hash(input.groupId)) fail("NATIVE_VIEW_INPUT_INVALID");
        const original = acceptedView(input, request);
        if (original.groupId && original.groupId !== input.groupId) fail("NATIVE_VIEW_GROUP_UNAVAILABLE", 404);
        return query({ schemaVersion: 1, revision: input.revision, sources: [...original.sources],
            analytics: original.analytics, page: input.page }, request, {
            signal, accepted: original, groupId: input.groupId, kind: "native-retained-drilldown", identityInput: input,
        });
    }
    async function analyze(input, request, { signal } = {}) {
        validateViewRequest(input, ["query", "types"]);
        if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4000
            || !Array.isArray(input.types) || input.types.some(type => !["interaction", "context", "reply", "action"].includes(type))
            || new Set(input.types).size !== input.types.length) fail("NATIVE_VIEW_INPUT_INVALID");
        const original = acceptedView(input, request);
        if (original.analysis) fail("NATIVE_VIEW_ANALYSIS_BASE_REQUIRED", 409);
        const analysis = freeze({ query: input.query, matchPolicyId: SEARCH_MATCH_POLICY_ID, types: (input.types.length
            ? [...input.types] : ["interaction", "context", "reply", "action"]).sort() });
        return query({ schemaVersion: 1, revision: input.revision, sources: [...original.sources],
            analytics: original.analytics, page: input.page }, request, {
            signal, accepted: original, analysis, kind: "native-retained-analysis", identityInput: input,
        });
    }
    async function inventory(input, request, { signal } = {}) {
        validateViewRequest(input, "dimension");
        const dimensions = ["tools", "outcomes", "sources", "conversations", "services", "endpoints", "workloads", "promptAuthors"];
        if (!dimensions.includes(input.dimension)) fail("NATIVE_VIEW_INPUT_INVALID");
        const original = acceptedView(input, request), analytics = structuredClone(original.analytics);
        const filter = input.dimension === "conversations" ? "sourceSessionIds" : input.dimension;
        if (analytics.filters) delete analytics.filters[filter];
        const available = ["tools", "outcomes", "sources", "conversations"].includes(input.dimension);
        const options = new Map();
        let optionBytes = 0, unavailable = 0;
        function add(value, label, count) {
            if (value === null) { unavailable += count; return; }
            if (!options.has(value)) {
                optionBytes += bytes([value, label]) + 256;
                if (optionBytes > NATIVE_READ_LIMITS.bytes) fail("NATIVE_VIEW_INVENTORY_TOO_LARGE", 413);
                options.set(value, { value, label, count: 0 });
            }
            options.get(value).count += count;
        }
        return query({ schemaVersion: 1, revision: input.revision, sources: [...original.sources],
            analytics, page: input.page }, request, { signal, accepted: original, issueViews: false,
            includeRecognition: input.dimension === "conversations",
            kind: "native-retained-inventory", identityInput: input,
            onRow(row) {
                if (input.dimension === "tools") add(row.tool, row.tool, 1);
                if (input.dimension === "outcomes") add(row.outcome, row.outcome, 1);
            },
            onMember(unit, publicId, count, recognition) {
                if (input.dimension === "sources") add(unit.sourceId, title(unit.sourceId), count);
                if (input.dimension === "conversations") add(publicId, title(unit.sourceId)
                    + (recognition ? ": " + recognition : ": Message text unavailable"), count);
            },
            finish(header, cursor, id) {
                const page = pageBuilder(input.page.limit, cursor.after);
                const ordered = [...options.values()].map(value => ({ value, position: JSON.stringify([value.label, value.value]) }))
                    .sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
                for (const { value: item, position } of ordered) {
                    const identity = id("native-filter-option", [input.dimension, item.value]);
                    page.add(position, { id: identity, ...item });
                }
                return { ...header, dimension: input.dimension, qualification: available ? "available" : "unqualified",
                    ...(available ? {} : { reason: `native-${input.dimension}-unqualified` }),
                    aggregates: available ? { complete: true, options: options.size, unavailableRows: unavailable,
                        selectedRows: header.aggregates.selectedRows } : null,
                    page: page.finish(cursor) };
            },
        });
    }
    async function resolveSelection(input, request, { signal } = {}) {
        if (!exact(input, ["schemaVersion", "viewId", "kind", "revision", "nativeIds"]) || input.schemaVersion !== 1
            || !hash(input.viewId) || !["all", "current", "selected"].includes(input.kind)
            || !Number.isSafeInteger(input.revision) || input.revision < 0
            || !Array.isArray(input.nativeIds) || input.nativeIds.length > NATIVE_READ_LIMITS.records
            || input.nativeIds.some(value => !hash(value)) || new Set(input.nativeIds).size !== input.nativeIds.length
            || input.kind === "all" && input.nativeIds.length) fail("NATIVE_VIEW_INPUT_INVALID");
        const original = acceptedViews.get(input.viewId);
        if (!original || original.owner !== request.owner || original.expires < Date.now()
            || original.revision !== input.revision || original.kind !== (input.kind === "all" ? "all" : "current")) {
            fail("NATIVE_VIEW_SELECTION_STALE", 409);
        }
        const scenarioIds = [], found = new Set(), requested = new Set(input.nativeIds);
        let identityBytes = 0;
        await query({ schemaVersion: 1, revision: original.revision, sources: [...original.sources],
            analytics: original.analytics, page: { limit: 1, after: null } }, request, {
            signal, accepted: original, issueViews: false, verifyMembership: true, finish: header => header,
            onMember(unit, publicId) {
                if (requested.has(publicId)) found.add(publicId);
                if (input.kind === "selected" && !requested.has(publicId)) return;
                identityBytes += Buffer.byteLength(unit.unitKey);
                if (scenarioIds.length >= NATIVE_READ_LIMITS.records || identityBytes > NATIVE_READ_LIMITS.bytes) {
                    fail("NATIVE_VIEW_REPORT_SELECTION_TOO_LARGE", 422);
                }
                scenarioIds.push(unit.unitKey);
            },
        });
        if (found.size !== requested.size) fail("NATIVE_VIEW_SELECTION_STALE", 409);
        const frame = input.kind !== "selected" || scenarioIds.length ? await persistence.reportSource.captureSelection({
            revision: original.revision, sources: [...original.sources], scenarioIds,
        }, request) : null;
        check(signal);
        if (acceptedViews.get(input.viewId) !== original || original.expires < Date.now()) fail("NATIVE_VIEW_SELECTION_STALE", 409);
        if (frame && (frame.source.sourceRevisionRef !== original.sourceRevision
            || nativeRetentionHash(frame.source.definitions) !== nativeRetentionHash(original.definitions))) {
            fail("NATIVE_VIEW_SELECTION_STALE", 409);
        }
        return freeze({ kind: input.kind, revision: original.revision,
            sourceRevision: original.sourceRevision, definitions: original.definitions, frame });
    }
    async function resolvePeriods(input, request, { signal } = {}) {
        if (!exact(input, ["schemaVersion", "viewId", "revision", "options", "periods", "datePolicy"])
            || input.schemaVersion !== 1 || !hash(input.viewId) || !Number.isSafeInteger(input.revision)
            || input.datePolicy !== "replace-original-dates" || !exact(input.periods, ["baseline", "later"])) {
            fail("NATIVE_VIEW_INPUT_INVALID");
        }
        const original = acceptedView(input, request);
        validateAnalyticsInput(input.options);
        const normalized = options => {
            const { from, to, ...filters } = options.filters ?? {};
            return { ...options, layer: options.layer ?? "tool", groupBy: options.groupBy ?? "workload",
                bucket: options.bucket ?? "day", limit: options.limit ?? 10, timeContext: time.normalize(options.timeContext), filters };
        };
        const options = normalized(original.analytics);
        if (!["tool", "reported-api"].includes(options.layer)
            || nativeRetentionHash(normalized(input.options)) !== nativeRetentionHash(options)) fail("NATIVE_VIEW_PERIOD_SCOPE_CHANGED", 409);
        for (const range of Object.values(input.periods)) {
            if (!exact(range, ["from", "to"])) fail("NATIVE_VIEW_INPUT_INVALID");
            time.calendar(range.from); time.calendar(range.to); time.range(range, options.timeContext.timeZone);
        }
        await query({ schemaVersion: 1, revision: original.revision, sources: [...original.sources],
            analytics: original.analytics, page: { limit: 1, after: null } }, request, {
            signal, accepted: original, issueViews: false, verifyMembership: true, finish: header => header,
        });
        const rowIds = { baseline: [], later: [], undated: [] }, parents = new Set(), contexts = new Set();
        let identityBytes = 0;
        const retain = (set, value) => {
            if (set.has(value)) return;
            identityBytes += Buffer.byteLength(value);
            if (set.size >= NATIVE_READ_LIMITS.records || identityBytes > NATIVE_READ_LIMITS.bytes) {
                fail("NATIVE_VIEW_REPORT_SELECTION_TOO_LARGE", 422);
            }
            set.add(value);
        };
        for (const name of ["baseline", "later", "undated"]) {
            const selected = new Set(), range = name === "undated" ? {} : input.periods[name];
            await query({ schemaVersion: 1, revision: original.revision, sources: [...original.sources],
                analytics: { ...options, filters: { ...options.filters, ...range } }, page: { limit: 1, after: null } }, request, {
                signal, accepted: original, issueViews: false, allowEmptyGroup: true, finish: header => header,
                onRow(row) {
                    if (name === "undated" && row.startedAt !== null) return;
                    retain(selected, row.id); retain(parents, row.scenarioId);
                },
                onMember(unit, _publicId, count) {
                    if (name === "undated" && count === 0) { retain(contexts, unit.unitKey); retain(parents, unit.unitKey); }
                },
            });
            rowIds[name] = [...selected].sort();
        }
        check(signal);
        if (acceptedViews.get(input.viewId) !== original || original.expires < Date.now()) fail("NATIVE_VIEW_SELECTION_STALE", 409);
        const frame = await persistence.reportSource.captureSelection({
            revision: original.revision, sources: [...original.sources], scenarioIds: [...parents].sort(),
        }, request);
        check(signal);
        if (acceptedViews.get(input.viewId) !== original || original.expires < Date.now()) fail("NATIVE_VIEW_SELECTION_STALE", 409);
        if (frame && (frame.source.sourceRevisionRef !== original.sourceRevision
            || nativeRetentionHash(frame.source.definitions) !== nativeRetentionHash(original.definitions))) {
            fail("NATIVE_VIEW_SELECTION_STALE", 409);
        }
        return freeze({ kind: "periods", revision: original.revision, sourceRevision: original.sourceRevision,
            definitions: original.definitions, frame,
            membership: { rowIds, contextScenarioIds: [...contexts].sort(), datePolicy: input.datePolicy,
                predicateRef: nativeRetentionHash([original.sourceRevision, original.definitions, original.sources, options, original.analysis ?? null,
                    original.groupId ?? null, input.periods, rowIds]) } });
    }
    async function detail(input, request, { signal } = {}) {
        const seek = Object.hasOwn(input ?? {}, "at"), rooted = Object.hasOwn(input ?? {}, "sourceRevision");
        const section = input?.section ?? "observations";
        validate(input, ["conversationId", ...(Object.hasOwn(input ?? {}, "section") ? ["section"] : []),
            ...(seek ? ["at"] : []), ...(rooted ? ["sourceRevision"] : [])]);
        if (!["observations", "messages", "context", "calls"].includes(section) || seek && section !== "observations") fail("NATIVE_VIEW_INPUT_INVALID");
        const textSection = ["messages", "context"].includes(section);
        if (!hash(input.conversationId)) fail("NATIVE_VIEW_INPUT_INVALID");
        if (rooted && (input.revision === null || !hash(input.sourceRevision))
            || seek && (!rooted || input.page.after !== null || !Number.isSafeInteger(input.at) || input.at < 0)) fail("NATIVE_VIEW_INPUT_INVALID");
        return run(input, request, "native-retained-detail", signal, async (reader, current, id, cursor) => {
            if (rooted && reader.source.sourceRevisionRef !== input.sourceRevision) fail("NATIVE_VIEW_CURSOR_STALE", 409);
            let unit;
            for await (const candidate of conversations(reader, input, current, signal)) {
                if (id("native-conversation", candidate.unitKey) === input.conversationId) { unit = candidate; break; }
            }
            if (!unit) fail("NATIVE_VIEW_CONVERSATION_UNAVAILABLE", 404);
            const prefix = unitPrefix(unit.sourceId, unit.conversationKey, "conversation", unit.unitKey) + "/";
            if (seek) {
                const member = await reader.lookupRow(prefix + String(input.at).padStart(16, "0"), { signal });
                if (!member || member.kind !== "membership" || member.conversationKey !== unit.conversationKey
                    || member.sourceId !== unit.sourceId || member.inputOrdinal !== input.at) fail("NATIVE_VIEW_CONVERSATION_UNAVAILABLE", 404);
            }
            const after = seek ? input.at === 0 ? null : String(input.at - 1).padStart(16, "0") : cursor.after;
            const page = pageBuilder(input.page.limit, after);
            let total = 0;
            for await (const member of reader.iterateRows({ prefix, signal })) {
                current();
                total++;
            }
            if (section === "calls") {
                let sectionCount = 0;
                for await (const call of reader.iterateRows({ prefix: unitPrefix(unit.sourceId, unit.conversationKey, "call", null, "u"), signal })) {
                    current(); sectionCount++;
                    const row = await callRow(reader, call, current, signal);
                    let first;
                    const inputFacts = [], evidenceFacts = [];
                    let inputBytes = 0;
                    for await (const entry of entries(reader, call, current, signal)) {
                        first ??= entry;
                        if (entry.record.identity.nativeType === "ts" && first.record.identity.nativeType !== "ts") first = entry;
                        const identity = entry.record.identity.nativeCalls.find(value => nativeCallKey(entry.record.scope, value.nativeCallId) === call.unitKey);
                        if (!identity) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
                        const individual = entry.record.callFacts.find(fact => fact.nativeCallId === identity.nativeCallId)?.fields ?? {};
                        const single = entry.record.identity.callIds.length === 1;
                        const fields = { ...(single ? entry.record.fields : {}), ...individual };
                        const evidence = { ordinal: entry.inputOrdinal, fields, outcomes: single ? entry.record.outcomes : {},
                            retention: entry.record.retention };
                        inputBytes += bytes(evidence);
                        evidenceFacts.push(evidence);
                        if (fields.input) {
                            const fact = { ordinal: entry.inputOrdinal, input: fields.input };
                            inputBytes += bytes(fact);
                            if (inputBytes > maximumResponseBytes / 2) fail("NATIVE_VIEW_ITEM_TOO_LARGE", 413);
                            inputFacts.push(fact);
                        }
                        if (inputBytes > maximumResponseBytes / 2) fail("NATIVE_VIEW_ITEM_TOO_LARGE", 413);
                    }
                    if (!first) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
                    const record = first.record;
                    page.add(nativeSegmentedRowKey(call), {
                        id: id("native-call", call.unitKey), ordinal: first.inputOrdinal,
                        fields: { ...(row.tool ? { toolName: { availability: "recorded", value: row.tool } } : {}),
                            ...(inputFacts[0] ? { input: inputFacts[0].input } : {}) },
                        outcomes: {}, messageParts: [], callFacts: [], sourceFacts: [], retention: record.retention,
                        callSummaries: [{ id: id("native-call", call.unitKey), tool: row.tool, outcome: row.outcome }],
                        inputFacts, evidenceFacts,
                    });
                }
                return { ...header(reader, cursor, "native-retained-detail"), conversationId: input.conversationId,
                    sourceId: unit.sourceId, focusOrdinal: null, section, sectionCount,
                    aggregates: { complete: true, variants: total }, page: page.finish(cursor) };
            }
            let loaded = 0;
            let sectionCount = 0;
            for await (const member of reader.iterateRows({ prefix, ...(textSection ? {} : { after: after === null ? null : prefix + after }), signal })) {
                current();
                const position = String(member.inputOrdinal).padStart(16, "0");
                const entry = await reader.entryAt(member.inputOrdinal, { signal });
                const record = entry.record;
                if (textSection) {
                    const authored = ["user", "assistant"].includes(record.fields.message?.value?.author);
                    if (section === "messages" ? !authored : authored || !(record.fields.message || record.messageParts?.length
                        || record.chatSource?.observations?.length || record.outcomes.task)) continue;
                    sectionCount++;
                    if (after !== null && position <= after) continue;
                }
                const callSummaries = [];
                for (const identity of record.identity.nativeCalls) {
                    const key = nativeCallKey(record.scope, identity.nativeCallId);
                    const call = await reader.lookupRow(unitPrefix(unit.sourceId, unit.conversationKey, "call", key, "u"), { signal });
                    if (!call) fail("NATIVE_VIEW_MEMBERSHIP_INVALID", 503);
                    const row = await callRow(reader, call, current, signal);
                    callSummaries.push({ id: id("native-call", key), tool: row.tool, outcome: row.outcome });
                }
                page.add(position, { id: id("native-observation", [unit.unitKey, entry.inputOrdinal]),
                    ordinal: entry.inputOrdinal, fields: record.fields, outcomes: record.outcomes,
                    ...(textSection ? { messageIdentity: id("native-message", record.identity) } : {}),
                    messageParts: record.messageParts ?? [], callFacts: record.callFacts, callSummaries,
                    sourceFacts: record.chatSource?.observations ?? [], retention: record.retention });
                if (++loaded > input.page.limit && !textSection) break;
            }
            current();
            return { ...header(reader, cursor, "native-retained-detail"), conversationId: input.conversationId,
                sourceId: unit.sourceId, focusOrdinal: seek ? input.at : null,
                ...(textSection ? { section, sectionCount } : {}),
                aggregates: { complete: true, variants: total }, page: page.finish(cursor) };
        });
    }
    async function search(input, request, { signal = new AbortController().signal } = {}) {
        validate(input, ["query", "types"]);
        if (typeof input.query !== "string" || input.query.length > 4000 || !input.query.trim()
            || !Array.isArray(input.types) || input.types.some(type => !SEARCH_TYPES.includes(type))
            || new Set(input.types).size !== input.types.length) fail("NATIVE_VIEW_INPUT_INVALID");
        return run(input, request, "native-retained-search", signal, async (reader, current, id, cursor) => {
            const items = [];
            let matched = 0, scanned = 0, incomplete = 0, retainedBytes = 0, remaining = 0;
            async function candidate(type, identity, text, unit, ordinal, titleText) {
                current();
                const content = corpusText(text), label = title(unit.sourceId);
                if (!content) return;
                const candidate = { id: id("native-search", [type, identity]), type,
                    title: corpusText(titleText ?? retainedTextTitle(content, label)), content,
                    revision: reader.source.sourceRevisionRef,
                    source: { label, sourceId: unit.sourceId },
                    target: { conversationId: id("native-conversation", unit.unitKey), ordinal },
                };
                scanned++;
                const [match] = await rankTextSearch([indexSearchText(candidate)], input.query, input.types, signal);
                if (!match) return;
                matched++;
                const position = `${2 - match.tier}/${candidate.id}`;
                if (cursor.after !== null && position <= cursor.after) return;
                remaining++;
                const hit = textSearchHit(candidate, match);
                // Return bounded excerpts, not a second corpus containing all matched source text.
                const { content: _content, ...publicHit } = hit;
                const size = bytes(publicHit);
                if (size > maximumResponseBytes / 2) fail("NATIVE_VIEW_ITEM_TOO_LARGE", 413);
                items.push({ position, value: publicHit, size });
                retainedBytes += size;
                items.sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : 0);
                while (items.length > input.page.limit + 1 || retainedBytes > maximumResponseBytes / 2) {
                    retainedBytes -= items.pop().size;
                }
            }
            for await (const unit of conversations(reader, input, current, signal)) {
                for await (const entry of entries(reader, unit, current, signal)) {
                    const record = projected(entry), conversation = record.nativeConversation;
                    for (const message of conversation.messages) {
                        if (message.availability !== "recorded") { incomplete++; continue; }
                        const type = message.value.author === "user" ? "interaction" : message.value.author === "assistant" ? "reply" : "context";
                        await candidate(type, message.observationKey, message.value.text, unit, entry.inputOrdinal);
                    }
                    for (const group of conversation.sourceObservations ?? []) for (const fact of group.facts) {
                        const text = sourceFactText(fact);
                        if (text.incomplete) incomplete++;
                        await candidate("context", fact.key, text.content, unit, entry.inputOrdinal);
                    }
                    for (const call of conversation.calls) {
                        const inputs = call.observations.flatMap(observation => ["recorded", "recorded-empty"].includes(observation.fields.input?.availability)
                            ? [typeof observation.fields.input.value === "string" ? observation.fields.input.value : JSON.stringify(observation.fields.input.value)] : []);
                        await candidate("action", [entry.inputOrdinal, call.key], [...call.nativeToolNames, ...inputs, call.outcome.state].join("\n"),
                            unit, entry.inputOrdinal, call.nativeToolNames.join(", ") || "Native tool name not qualified");
                    }
                    for (const row of nativeActivityRows([record], "reported-api")) {
                        await candidate("action", row.id, [row.tool, row.outcome, row.status, row.errorCode]
                            .filter(value => value !== null && value !== undefined).join("\n"),
                        unit, entry.inputOrdinal, row.tool ?? "Native tool name not qualified");
                    }
                }
                for await (const call of reader.iterateRows({
                    prefix: unitPrefix(unit.sourceId, unit.conversationKey, "call", null, "u"), signal,
                })) {
                    const row = await callRow(reader, call, current, signal);
                    if (row.tool) await candidate("tool", call.unitKey, row.tool, unit, call.witnessOrdinal, row.tool);
                }
            }
            current();
            const page = pageBuilder(input.page.limit, null);
            for (const item of items) page.add(item.position, item.value);
            return { ...header(reader, cursor, "native-retained-search"),
                matchPolicyId: SEARCH_MATCH_POLICY_ID, aggregates: { complete: true, matched, scanned, unavailableText: incomplete },
                coverage: { history: "selected-retained-root-not-complete-source-history", actionUnit: "native-call-observation",
                    fields: "authorized-messages-source-facts-and-call-inputs", pageIsPopulation: false },
                page: page.finish(cursor, remaining) };
        });
    }
    async function readback(input, request, { signal, receiptOwner = request.owner } = {}) {
        if (!exact(input, ["schemaVersion", "operationId"]) || input.schemaVersion !== 1
            || typeof input.operationId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.operationId)) {
            fail("NATIVE_VIEW_INPUT_INVALID");
        }
        const checkRequest = () => {
            check(signal);
            const value = request.check();
            if (value && typeof value.then === "function") {
                Promise.resolve(value).catch(() => {});
                fail("NATIVE_VIEW_REQUEST_REVOKED", 403);
            }
            if (value !== undefined && value !== true) fail("NATIVE_VIEW_REQUEST_REVOKED", 403);
        };
        checkRequest();
        const status = await persistence.status({ operationId: input.operationId }, { owner: receiptOwner });
        checkRequest();
        const unconfirmed = reason => freeze({ schemaVersion: 1, kind: "native-operation-readback",
            operationId: input.operationId, status: "unconfirmed", reason });
        const receipt = status.receipt;
        if (!receipt || receipt.status !== "committed") return unconfirmed("operation-not-committed");
        return persistence.withRetainedReader({ revision: status.revision }, request, (reader, assertCurrent) => {
            check(signal); assertCurrent();
            const original = reader.readback.committed;
            if (!original || original.operationId !== input.operationId) return unconfirmed("different-committed-operation");
            if (reader.readback.accountRef !== status.accountRef || receipt.partition !== status.accountRef
                || reader.readback.snapshot !== receipt.snapshot
                || ["revision", "generation", "configurationRevision", "privacyRevision"].some(key => original[key] !== receipt[key])) {
                return unconfirmed("committed-readback-mismatch");
            }
            return freeze({ schemaVersion: 1, kind: "native-operation-readback", operationId: input.operationId,
                status: "matched", revision: reader.revision, sourceRevision: reader.source.sourceRevisionRef,
                readback: publicReadback(reader) });
        });
    }
    return Object.freeze({ query, detail, search, analyze, inventory, drilldown, readback, resolveSelection, resolvePeriods,
        close() {
            closed = true; cursors.clear(); acceptedViews.clear();
            for (const cache of [offeredReaders, readingReaders]) for (const key of cache.keys()) forgetReader(cache, key);
        } });
}
