import { stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { BoardError, exclusiveBoard, loadBoardState, stageEvidenceSnapshot } from "./store.mjs";
import { collectorFor, retainEvent, mergedRecords, collectionCoverage } from "./collector.mjs";
import { discoverSources } from "./source-discovery.mjs";
import { sourceHost } from "./source-host.mjs";
import { sourceMetadataStamp } from "./source-reader.mjs";
import { readTail, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { extractScenarios, managedErrorServers } from "./history.mjs";
import { extractGraphActivities } from "./graph-history.mjs";
import { deletionHash, recordUnits, filterDeletedRecords, filterDeletedEvents, activityDeletionVersion, eventIdentity, callIdentity } from "./deletion-identities.mjs";
import { textFindings } from "./privacy.mjs";
import { time } from "./time.mjs";
import { sourceCorrections } from "./recollection-corrections.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fingerprint = value => deletionHash(JSON.stringify(value));
const safeName = value => textFindings(String(value)).some(f => f.mandatory) ? "Chat name withheld" : value;
const limits = { sources: 128, bytes: TAIL_LIMITS.cycleBytes, records: 20000 };
const boundary = "Optional response captures and personal feedback stay deleted. Saved reports/comparisons, original Copilot files and source/capture settings stay unchanged. Missing, unsupported, anonymous local-only and HTTP diagnostic history cannot be recovered here.";

const refused = (code, message) => Object.assign(new BoardError(message, 409), { code });
const selectionChanged = () => refused("RECOLLECTION_SELECTION_CHANGED", "The selected chat or its source mapping changed. Preview again.");
function selectedSources(discovery, scope) {
    const roster = new Map(discovery.roster.map(row => [row.sessionId, row]));
    return scope.sourceSessionIds.map(id => {
        const source = roster.get(id);
        if (!source?.eligible) throw refused("RECOLLECTION_SELECTION_CHANGED",
            "A selected chat is no longer eligible in the approved local source. Preview again; nothing was recollected.");
        return { ...source, checkedAt: scope.window.until };
    });
}
function selectedSourceProof(discovery, rows) {
    if (!/^[a-f0-9]{64}$/.test(discovery.sourceIdentity ?? "")) throw selectionChanged();
    return fingerprint([discovery.adapter, discovery.schemaVersion, discovery.sourceIdentity, rows]);
}

// The whole roster is used for coverage, not as the identity of a user-selected recovery.
function reviewedEffects({ discovery, assertCheckpoints, ...effects }) { return fingerprint(effects); }

async function recheckSelectedMetadata(config, scope, target, verify) {
    if (sourceMetadataStamp(sourceHost(config)) === target.discovery.metadataStamp) return;
    await verify();
    const current = await discoverSources(config, { includeIdentity: true });
    await verify();
    if (selectedSourceProof(current, selectedSources(current, scope)) !== target.selectedSourceProof) throw selectionChanged();
    target.discovery.metadataStamp = current.metadataStamp;
}

function checkSelectedSources(config, target) {
    const files = sourceHost(config);
    files.assertCurrent();
    if (sourceMetadataStamp(files) !== target.discovery.metadataStamp) throw refused("RECOLLECTION_METADATA_CHANGED",
        "The Copilot source changed during validation. Preview again.");
    for (const [id, stamp, unavailable] of target.stamps) {
        let current;
        try { current = sourceFileStamp(statSync(files.historyFile(id))); }
        catch (error) {
            if (stamp === null && unavailable === error.code) continue;
            throw refused("RECOLLECTION_EFFECTS_CHANGED", "Selected source history is no longer available. Preview again.");
        }
        if (current !== stamp) throw refused("RECOLLECTION_EFFECTS_CHANGED", "Selected source history changed. Preview again.");
    }
}

function addMissingRecords(existing, incoming) {
    const records = new Map(existing.map(record => [record.scenarioId, record]));
    for (const next of incoming) {
        const prior = records.get(next.scenarioId);
        if (!prior) { records.set(next.scenarioId, next); continue; }
        if (prior.sourceSessionId !== next.sourceSessionId) throw new BoardError("Selected record ownership changed. Preview again.", 409);
        // A reviewed missing call is not permission to refresh its existing parent's prompt, timing or author.
        records.set(next.scenarioId, { ...prior, toolCalls: [...prior.toolCalls ?? [],
            ...next.toolCalls.map((call, i) => ({ ...call, order: (prior.toolCalls?.length ?? 0) + i + 1 }))],
            ...(next.graphActivities.length ? { graphActivities: [...prior.graphActivities ?? [], ...next.graphActivities] } : {}) });
    }
    return [...records.values()];
}

function validate(input, allowed) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new BoardError("Invalid recollection arguments.", 422);
}
function scopeFor(input, config, now) {
    validate(input, ["sourceSessionIds", "from", "to", "timeContext", "restorePrompts", "correctExisting"]);
    if (input.correctExisting !== undefined && typeof input.correctExisting !== "boolean") throw new BoardError("Choose whether to review corrections to saved calls.", 422);
    if (typeof input.restorePrompts !== "boolean") throw new BoardError("Choose whether to restore original prompts.", 422);
    if (!Array.isArray(input.sourceSessionIds) || !input.sourceSessionIds.length || input.sourceSessionIds.length > limits.sources
        || input.sourceSessionIds.some(id => !uuid.test(id)) || new Set(input.sourceSessionIds).size !== input.sourceSessionIds.length) {
        throw new BoardError(`Select between 1 and ${limits.sources} eligible local chats.`, 422);
    }
    try {
        const context = time.normalize(input.timeContext);
        time.calendar(input.from); time.calendar(input.to);
        const bounds = time.range({ from: input.from, to: input.to }, context.timeZone);
        const window = { since: new Date(now - config.windowDays * 86400000).toISOString(), until: new Date(now).toISOString() };
        const since = new Date(Math.max(Date.parse(bounds.from), Date.parse(window.since))).toISOString();
        const until = new Date(Math.min(Date.parse(bounds.to) - 1, now)).toISOString();
        if (since > until) throw new Error("The selected dates do not overlap the already-approved collection window.");
        return { sourceSessionIds: [...input.sourceSessionIds].sort(), from: input.from, to: input.to, timeContext: context,
            restorePrompts: input.restorePrompts, ...(input.correctExisting ? { correctExisting: true } : {}), bounds, window, since, until };
    } catch (error) { throw new BoardError(error.message, 422); }
}

const continuable = (access, scope) => access.newOnly && scope.sourceSessionIds.length === 1
    && scope.from === scope.to && !scope.restorePrompts && !scope.correctExisting;
const contextLimit = () => new BoardError("This chat exceeds the bounded recovery context. No complete selection was prepared.", 413);
function trackOriginalIdentities(seen, raw) {
    for (const e of raw) {
        if (!["user.message", "tool.execution_start", "tool.execution_complete"].includes(e.type)) continue;
        const key = fingerprint(["event", e.id]), value = fingerprint(e);
        if (seen.events.has(key) && seen.events.get(key) !== value) seen.ambiguous = true;
        seen.events.set(key, value);
        if (e.type !== "user.message" && e.data?.toolCallId) {
            const call = fingerprint([e.type, e.data.toolCallId]);
            if (seen.calls.has(call) && seen.calls.get(call) !== key) seen.ambiguous = true;
            seen.calls.set(call, key);
        }
        if (seen.events.size > limits.records || seen.calls.size > limits.records) throw contextLimit();
    }
}
const ambiguousRead = () => refused("RECOLLECTION_EFFECTS_CHANGED", "Ambiguous call or event identities in the selected history. No continued recovery was prepared.");

async function scan(access, scope, state, carry) {
    const { config } = access;
    await access.verify();
    const discovery = await discoverSources(config, { includeIdentity: true });
    const sources = selectedSources(discovery, scope);
    const proof = selectedSourceProof(discovery, sources);
    let bytes = 0;
    const updates = [], availability = [], stamps = [], suppressedStarts = carry?.suppressedStarts ?? new Set();
    const corrections = [], dependencies = [], checkpointChecks = [];
    let unresolved = 0, checkpointConflicts = 0, continuedRead;
    for (const source of sources) {
        await access.verify();
        const managedWorkIqEventIds = new Set(source.managedWorkIqEventIds ?? []);
        const diagnostics = carry?.diagnostics ?? { credentialExclusions: 0 };
        const context = scope.correctExisting ? await access.correctionContext(source.sessionId) : null;
        const qualification = scope.correctExisting && sourceCorrections({ state, source, scope, context });
        if (context) { dependencies.push([source.sessionId, context.proof]); checkpointChecks.push(context.assertCurrent); }
        let info, cursor = carry?.cursor, events = carry?.events ?? [], problem, firstPromptEventId = carry?.firstPromptEventId;
        let contextBytes = carry?.contextBytes ?? 0;
        const pageable = continuable(access, scope);
        const seen = carry?.seen ?? { events: new Map(), calls: new Map(), ambiguous: false };
        try {
            const file = sourceHost(config).historyFile(source.sessionId);
            info = await stat(file);
            const before = sourceFileStamp(info);
            if (carry && (!pageable || carry.proof !== proof || carry.stamp !== before)) throw selectionChanged();
            do {
                await access.verify();
                if (pageable && limits.bytes - bytes <= 65536 + 512 + (cursor?.partialBytes ?? 0) && cursor?.backlogBytes > cursor.partialBytes) {
                    if (sourceFileStamp(await stat(file)) !== before) throw selectionChanged();
                    if (info.size > TAIL_LIMITS.initialFileBytes || cursor.droppedBytes) {
                        throw new BoardError("This chat exceeds the 64 MiB history window. Its full selected day cannot be verified.", 413);
                    }
                    if ((carry?.steps ?? 0) >= 2) throw new BoardError("The three bounded reading steps did not cover this chat. No recovery was prepared.", 413);
                    if (seen.ambiguous) throw ambiguousRead();
                    const advanced = cursor.offset > (carry?.cursor.offset ?? 0);
                    if (!advanced) throw contextLimit();
                    return { more: { proof, stamp: before, cursor, events, firstPromptEventId, diagnostics, suppressedStarts,
                        contextBytes, seen, steps: (carry?.steps ?? 0) + 1, totalBytes: (carry?.totalBytes ?? 0) + bytes },
                    discovery, selectedSourceProof: proof, stamps: [[source.sessionId, before]],
                    progress: { bytesRead: bytes, totalBytesRead: (carry?.totalBytes ?? 0) + bytes,
                        offset: cursor.offset, remainingBytes: cursor.backlogBytes } };
                }
                if (bytes >= limits.bytes) { problem = "The bounded reread budget was reached; unscanned history is not included."; break; }
                const tail = await readTail(file, source.sessionId, cursor, Math.min(TAIL_LIMITS.chunkBytes, limits.bytes - bytes),
                    { completionMetadata: Boolean(qualification), chargeGuards: pageable });
                if (tail.reset) throw new BoardError("Source history changed during preview. Preview again.", 409);
                bytes += tail.bytesRead;
                // Without a complete readable prefix, the agent-created kickoff is not identifiable.
                if (!firstPromptEventId && tail.cursor.droppedBytes === 0
                    && tail.cursor.malformedLines === 0 && tail.cursor.oversizedLines === 0) {
                    firstPromptEventId = tail.events.find(event => event.type === "user.message")?.id;
                }
                const raw = access.newOnly ? filterDeletedEvents(tail.events, source.sessionId, state.deletion) : tail.events;
                if (pageable) trackOriginalIdentities(seen, raw);
                if (raw !== tail.events) {
                    const admitted = new Set(raw);
                    for (const event of tail.events) if (event.type === "tool.execution_start" && !admitted.has(event)
                        && event.timestamp >= scope.since && event.timestamp <= scope.until && typeof event.data?.toolCallId === "string") {
                        suppressedStarts.add(callIdentity(source.sessionId, event.data.toolCallId));
                    }
                }
                const errorServers = managedErrorServers(raw, events, managedWorkIqEventIds);
                if (qualification) bytes += await qualification.observe(tail, file, limits.bytes - bytes, access,
                    e => retainEvent(e, diagnostics, { managedErrorServers: errorServers }));
                const retained = raw.map(event => retainEvent(event, diagnostics, {
                    managedWorkIqEventIds, managedErrorServers: errorServers,
                    agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!firstPromptEventId || event.id === firstPromptEventId),
                })).filter(event => {
                    if (!event) return false;
                    if (textFindings(JSON.stringify(event)).some(f => f.mandatory)) { diagnostics.credentialExclusions++; return false; }
                    return true;
                });
                if (pageable) {
                    contextBytes += retained.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
                    if (contextBytes > limits.bytes || events.length + retained.length > limits.records || suppressedStarts.size > limits.records) throw contextLimit();
                }
                for (const event of retained) events.push(event);
                const previous = cursor?.offset;
                cursor = tail.cursor;
                if (cursor.offset === previous && (!pageable || cursor.backlogBytes <= cursor.partialBytes)) break;
            } while (cursor.backlogBytes > cursor.partialBytes);
            if (carry && seen.ambiguous) throw ambiguousRead();
            if (carry && (cursor.backlogBytes || cursor.droppedBytes || cursor.malformedLines || cursor.oversizedLines
                || diagnostics.credentialExclusions || diagnostics.unsupportedPromptContents)) {
                throw new BoardError(`Cannot verify the selected day: ${cursor.backlogBytes} unread bytes, ${cursor.malformedLines} malformed and ${cursor.oversizedLines} oversized entries, ${diagnostics.credentialExclusions} privacy exclusions and ${diagnostics.unsupportedPromptContents ?? 0} unsupported prompts. Nothing can be confirmed.`, 422);
            }
            if (carry) continuedRead = { bytesRead: bytes, totalBytesRead: carry.totalBytes + bytes, steps: carry.steps + 1, remainingBytes: 0 };
            if (sourceFileStamp(await stat(file)) !== before) throw new BoardError("Source history changed during preview. Preview again.", 409);
            stamps.push([source.sessionId, before]);
        } catch (error) {
            access.check();
            if (error.code?.startsWith("wire_access_") || error.code === "session_expired") throw error;
            if (carry || error instanceof BoardError && (error.status === 409 || error.status === 413)) throw error;
            if (!(error instanceof BoardError) && !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
            problem = error instanceof BoardError ? error.message : `Local history unavailable (${error.code}).`;
            events = [];
            stamps.push([source.sessionId, info ? sourceFileStamp(info) : null, error.code ?? error.message]);
        }
        const partialWindow = Boolean(problem || cursor?.droppedBytes || cursor?.malformedLines
            || cursor?.oversizedLines || diagnostics.credentialExclusions || diagnostics.unsupportedPromptContents);
        const work = extractScenarios(events, source, scope.since, scope.until, { partialWindow });
        const graph = extractGraphActivities(events, source, { since: scope.since, until: scope.until, partialWindow });
        updates.push(...work.scenarios, ...graph.scenarios);
        if (qualification) {
            const result = qualification.finish(problem ? null : cursor);
            if (!problem) corrections.push(...result.changes);
            unresolved += result.unresolved + (problem ? result.changes.length : 0);
            checkpointConflicts += result.checkpointConflicts;
        }
        availability.push({ sourceSessionId: source.sessionId, name: safeName(source.name), problem: problem ?? null,
            droppedBytes: cursor?.droppedBytes ?? 0, unreadBytes: cursor?.backlogBytes ?? 0,
            malformedLines: cursor?.malformedLines ?? 0, oversizedLines: cursor?.oversizedLines ?? 0,
            credentialExclusions: diagnostics.credentialExclusions,
            ...(diagnostics.unsupportedPromptContents ? { unsupportedPromptContents: diagnostics.unsupportedPromptContents } : {}),
            missingResults: work.missingResults });
    }
    const currentUnits = (state.evidence ?? []).flatMap(recordUnits);
    const currentAliases = new Map(currentUnits.flatMap(unit => unit.aliases.map(alias => [alias, unit])));
    const deleted = new Set(state.deletion?.identities ?? []);
    const deletedEvents = new Set(state.deletion?.events ?? []);
    const promptAuthorizations = structuredClone(state.deletion?.promptAuthorizations ?? {});
    const selectedAliases = new Set(), selected = [];
    const restoredPrompts = new Set();
    let alreadyPresent = 0, unsupported = 0, reauthorized = 0, toolCalls = 0, graphRecords = 0, promptOnly = 0, excludedDeleted = 0;
    for (const record of mergedRecords([], updates)) {
        const next = { ...record, toolCalls: [], graphActivities: [] };
        const purgedPrompts = [record.userPrompt, ...record.followUpPrompts ?? []].filter(prompt =>
            scope.restorePrompts && prompt?.sourceEventId && typeof prompt.text === "string" && prompt.text.length
            && deletedEvents.has(eventIdentity(record.sourceSessionId, prompt.sourceEventId)));
        for (const unit of recordUnits(record)) {
            const at = Date.parse(unit.at);
            if (unit.local || !["toolCalls", "graphActivities"].includes(unit.family) || !Number.isFinite(at)
                || at < Date.parse(scope.since) || at > Date.parse(scope.until)) { unsupported++; continue; }
            const existing = unit.aliases.map(id => currentAliases.get(id)).find(Boolean);
            if (existing) {
                const oldPrompts = [existing.record.userPrompt, ...existing.record.followUpPrompts ?? []];
                if (!purgedPrompts.some(prompt => !oldPrompts.some(old => old?.sourceEventId === prompt.sourceEventId && old.text === prompt.text))) {
                    alreadyPresent++; continue;
                }
                promptOnly++;
            }
            const wasDeleted = unit.aliases.some(id => deleted.has(id));
            if (access.newOnly && (wasDeleted || state.deletion?.contextCalls?.includes(callIdentity(record.sourceSessionId, unit.item.toolCallId)))) {
                excludedDeleted++;
                continue;
            }
            if (unit.aliases.some(id => selectedAliases.has(id))) throw new BoardError("Source records have ambiguous duplicate identities. Nothing was recollected.", 409);
            unit.aliases.forEach(id => selectedAliases.add(id));
            if (wasDeleted) reauthorized++;
            if (unit.family === "toolCalls") toolCalls++; else graphRecords++;
            next[unit.family].push({ ...(existing?.item ?? unit.item), recollection: { previouslyDeleted: wasDeleted, promptOnly: Boolean(existing) } });
            for (const prompt of purgedPrompts) {
                const id = eventIdentity(record.sourceSessionId, prompt.sourceEventId);
                restoredPrompts.add(id);
                promptAuthorizations[id] = [...new Set([...(promptAuthorizations[id] ?? []), ...unit.aliases])].sort();
            }
        }
        if (next.toolCalls.length || next.graphActivities.length) selected.push(next);
    }
    const records = toolCalls + graphRecords;
    if (records > limits.records) throw new BoardError("This recollection exceeds the 20,000-record bound. Choose fewer chats or a shorter period.", 413);
    const identities = [...selectedAliases].sort();
    const deletion = state.deletion ? { ...state.deletion, promptAuthorizations,
        identities: state.deletion.identities.filter(id => !selectedAliases.has(id)) } : undefined;
    const cleaned = filterDeletedRecords(selected, deletion);
    if (records + corrections.length > limits.records) throw new BoardError("Choose a smaller recovery selection.", 413);
    if (corrections.length > 32) throw new BoardError("Review at most 32 saved-call corrections at once. Choose fewer chats or a shorter period.", 413);
    return { records: cleaned, identities, promptAuthorizations, availability, stamps, corrections, dependencies, selectedSourceProof: proof,
        ...(continuedRead ? { continuedRead } : {}),
        assertCheckpoints: () => checkpointChecks.forEach(check => check()), counts: {
        records: records + corrections.length, reauthorized, newRecords: records - reauthorized - promptOnly, promptOnly, restoredPrompts: restoredPrompts.size,
        toolCalls, graphRecords, alreadyPresent: Math.max(0, alreadyPresent - corrections.length), unsupported, savedReports: state.exports.length,
        ...(scope.correctExisting ? { verifiedCompletions: corrections.filter(c => c.kind === "completion").length,
            verifiedMetadata: corrections.filter(c => c.kind === "metadata").length, unresolved, checkpointConflicts } : {}),
        ...(access.newOnly ? { excludedDeleted, suppressedSourceStarts: suppressedStarts.size } : {}) },
        discovery: { ...discovery, checkedAt: scope.window.until, roster: discovery.roster.map(source => ({ ...source, checkedAt: scope.window.until })) } };
}

export function createRecollectionController(session, { now = Date.now, onCommitted, coordinateRecorder = work => work(), beforeSave } = {}) {
    const previews = new Map();
    const collector = () => {
        const value = collectorFor(session);
        if (!value) throw new BoardError("Collection runtime is unavailable. Nothing was recollected.", 503);
        return value;
    };
    const coordinate = work => coordinateRecorder(() => collector().exclusiveActivity(work));
    let activeRead = null;
    function discardRead(owner, id) {
        if (!activeRead || owner !== undefined && owner !== activeRead.owner || id !== undefined && id !== activeRead.operationId) return;
        const prior = activeRead;
        activeRead = null;
        clearTimeout(prior.timer);
        prior.carry = null;
        previews.delete(prior.operationId);
    }
    const invalidRead = () => refused("RECOLLECTION_PREVIEW_EXPIRED", "This reading step is no longer available. Preview again.");
    function checkWindow(at, config) {
        if (!Number.isFinite(at) || at < now() - config.windowDays * 86400000) {
            throw refused("RECOLLECTION_EFFECTS_CHANGED", "The selection is no longer inside the approved window. Preview again.");
        }
    }
    function nextStep(owner, input, phase) {
        validate(input, ["operationId", "continuation"]);
        const entry = activeRead;
        if (!entry || !uuid.test(input.operationId) || !uuid.test(input.continuation)
            || entry.owner !== owner || entry.operationId !== input.operationId || entry.phase !== phase
            || entry.continuation !== input.continuation || entry.expires <= now()) {
            throw new BoardError("This step is unavailable to this panel. It was not repeated.", 409);
        }
        entry.continuation = null;
        return entry;
    }
    function holdPage(entry, phase, part) {
        if (activeRead && activeRead !== entry) throw new BoardError("Another large-chat review is active. Finish or cancel it first.", 409);
        if (entry.expires <= now()) throw invalidRead();
        if (!entry.timer) {
            entry.timer = setTimeout(() => discardRead(entry.owner, entry.operationId), entry.expires - now());
            entry.timer.unref();
        }
        entry.carry = part.more;
        entry.phase = phase;
        entry.continuation = randomUUID();
        activeRead = entry;
        return { phase, operationId: entry.operationId, continuation: entry.continuation,
            expiresAt: new Date(entry.expires).toISOString(), progress: part.progress };
    }
    function guardedStep(access, entry) {
        if (!entry) return access;
        const check = () => {
            access.check();
            if (activeRead !== entry || entry.expires <= now()) throw invalidRead();
            checkWindow(entry.preview?.oldestUnitAt ?? Date.parse(entry.scope.until), access.config);
        };
        check();
        if (entry.generation !== access.generation || entry.configHash !== fingerprint(access.config)) throw selectionChanged();
        return { ...access, check, verify: async () => { check(); await access.verify(); check(); } };
    }
    const readable = state => { if (state.deletion?.pending) throw new BoardError("Finish the existing sealed deletion cleanup before recollecting.", 409); };
    async function publishPage(access, scope, revision, part, entry, phase) {
        await recheckSelectedMetadata(access.config, scope, part, access.verify);
        return exclusiveBoard(session, current => {
            readable(current); access.check();
            if (current.revision !== revision) throw refused("RECOLLECTION_BASIS_CHANGED", "Saved activity changed. Preview again.");
            checkSelectedSources(access.config, part);
            return holdPage(entry, phase, part);
        }, { readOnly: true });
    }
    const publicReceipt = ({ ownerHash, receiptHash, ...value }) => value;
    const allowed = (entry, owner, token) => entry.ownerHash === deletionHash(owner)
        || typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && entry.receiptHash === deletionHash(token);
    function prune(owner) {
        for (const [id, entry] of previews) if (entry.owner === owner || entry.expires < now()) previews.delete(id);
    }
    return {
        async sources(owner, ticket) {
            return coordinate(async () => {
            const access = await collector().openRecollectionScope(owner, ticket, "sources");
            const { config } = access;
            await access.verify();
            const discovery = await discoverSources(config);
            const sources = await Promise.all(discovery.roster.filter(row => row.eligible).map(async row => {
                access.check();
                let available = true;
                try { available = (await stat(sourceHost(config).historyFile(row.sessionId))).isFile(); }
                catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error; available = false; }
                return { sourceSessionId: row.sessionId, name: safeName(row.name), available };
            }));
            await access.verify();
            if (sourceMetadataStamp(sourceHost(config)) !== discovery.metadataStamp) throw new BoardError("The source list changed. Read the eligible chats again.", 409);
            return { sources, ...(access.newOnly ? { newOnly: true, correctionsAvailable: typeof access.correctionContext === "function" } : {}), windowDays: config.windowDays, since: new Date(now() - config.windowDays * 86400000).toISOString(),
                until: new Date(now()).toISOString(), excludedSources: discovery.roster.length - sources.length,
                skippedSources: discovery.counts.skippedByLimit, boundary, limits };
            });
        },
        async preview(owner, input, ticket) {
            return coordinate(async () => {
                const resuming = Object.hasOwn(input ?? {}, "continuation");
                const entry = resuming ? nextStep(owner, input, "reading") : null;
                if (!resuming) discardRead(owner);
                try {
                    const access = guardedStep(await collector().openRecollectionScope(owner, ticket, "preview"), entry);
                    const { config } = access;
                    if (!entry && access.newOnly && input?.restorePrompts !== false) throw new BoardError("History recovery preserves deleted prompts.", 422);
                    const state = await loadBoardState(session, { readOnly: true });
                    readable(state);
                    if (entry && state.revision !== entry.revision) throw refused("RECOLLECTION_BASIS_CHANGED", "Saved activity changed. Preview again.");
                    const scope = entry?.scope ?? scopeFor(input, config, now());
                    if (scope.correctExisting && !access.newOnly) throw new BoardError("Correcting saved calls requires guarded recovery.", 403);
                    const target = await scan(access, scope, state, entry?.carry);
                    await access.verify();
                    if (target.more) {
                        if (!entry) prune(owner);
                        return await publishPage(access, scope, state.revision, target, entry ?? { owner, scope, revision: state.revision, generation: access.generation,
                            configHash: fingerprint(config), operationId: randomUUID(), expires: Date.parse(scope.window.until) + 120000 },
                        "reading");
                    }
                    await recheckSelectedMetadata(config, scope, target, access.verify);
                    return await exclusiveBoard(session, current => {
                        readable(current);
                        access.check();
                        if (current.revision !== state.revision) throw new BoardError("Saved activity changed. Preview again.", 409);
                        checkSelectedSources(config, target);
                        target.assertCheckpoints();
                        prune(owner);
                        if (previews.size >= 128) throw new BoardError("Too many active recollection previews. Close unused panels.", 429);
                        const operationId = entry?.operationId ?? randomUUID(), receiptToken = randomBytes(32).toString("hex"), expires = entry?.expires ?? now() + 120000;
                        // The fixed scope can start on the rolling boundary. Qualify the actual
                        // proposed units, not the age of an otherwise empty part of that day.
                        const oldestUnitAt = entry ? target.records.flatMap(recordUnits).reduce((at, unit) =>
                            Math.min(at, Date.parse(unit.at)), Date.parse(scope.until)) : null;
                        if (entry) checkWindow(oldestUnitAt, config);
                        if (entry) discardRead(owner, operationId);
                        previews.set(operationId, { owner, scope, expires, generation: access.generation, revision: state.revision, configHash: fingerprint(config),
                            continued: !!entry, continuedStamp: entry ? target.stamps[0][1] : null, oldestUnitAt,
                            selectedSourceProof: target.selectedSourceProof, targetHash: reviewedEffects(target), receiptHash: deletionHash(receiptToken) });
                        return { operationId, receiptToken, scope, expiresAt: new Date(expires).toISOString(),
                            ...(entry ? { continued: true, progress: target.continuedRead } : {}),
                            counts: target.counts, availability: target.availability, boundary,
                            ...(scope.correctExisting ? { correctable: target.corrections.map(({ scenarioId, toolCallId, kind, next }) =>
                                ({ scenarioId, toolCallId, kind, tool: next.tool, startedAt: next.startedAt,
                                    fromOutcome: kind === "completion" ? "unknown" : next.reportedOutcome, toOutcome: next.reportedOutcome })) } : {}) };
                    }, { readOnly: true });
                } catch (error) { if (entry) discardRead(owner, entry.operationId); throw error; }
            });
        },
        async confirm(owner, input, ticket) {
            const resuming = Object.hasOwn(input ?? {}, "continuation");
            validate(input, resuming ? ["operationId", "continuation"] : ["operationId", "confirmed"]);
            if (!uuid.test(input.operationId) || !resuming && input.confirmed !== true) throw new BoardError("Explicit recollection confirmation is required.", 422);
            return coordinate(async () => {
                const observed = await loadBoardState(session, { readOnly: true });
                readable(observed);
                const prior = observed.recollection?.operations?.[input.operationId];
                if (prior) {
                    if (!allowed(prior, owner)) throw new BoardError("Recollection belongs to another panel.", 403);
                    return publicReceipt(prior);
                }
                const entry = resuming ? nextStep(owner, input, "verifying") : null;
                const preview = entry?.preview ?? previews.get(input.operationId);
                if (!preview || preview.owner !== owner) throw new BoardError("Recollection preview is unavailable. Preview and confirm again; nothing was replayed.", 409);
                previews.delete(input.operationId);
                try {
                    const access = guardedStep(await collector().openRecollectionScope(owner, ticket, "confirm"), entry), { config } = access;
                    if (preview.expires <= now()) throw refused("RECOLLECTION_PREVIEW_EXPIRED", "The preview expired. Preview again.");
                    if (preview.generation !== access.generation || observed.revision !== preview.revision || fingerprint(config) !== preview.configHash) throw refused("RECOLLECTION_BASIS_CHANGED", "Evidence, source approval or preview changed. Preview again.");
                    if (preview.continued) {
                        checkWindow(preview.oldestUnitAt, config);
                        if (sourceFileStamp(await stat(sourceHost(config).historyFile(preview.scope.sourceSessionIds[0]))) !== preview.continuedStamp) throw selectionChanged();
                    }
                    const target = await scan(access, preview.scope, observed, entry?.carry);
                    await access.verify();
                    if (target.more) {
                        if (!preview.continued || target.more.proof !== preview.selectedSourceProof) throw selectionChanged();
                        return await publishPage(access, preview.scope, preview.revision, target, entry ?? { owner, scope: preview.scope,
                            expires: preview.expires, operationId: input.operationId, generation: preview.generation, configHash: preview.configHash, preview }, "verifying");
                    }
                    await recheckSelectedMetadata(config, preview.scope, target, access.verify);
                    if (target.selectedSourceProof !== preview.selectedSourceProof) throw selectionChanged();
                    const currentSince = now() - config.windowDays * 86400000;
                    if (reviewedEffects(target) !== preview.targetHash || target.records.flatMap(recordUnits).some(unit => Date.parse(unit.at) < currentSince)) {
                        throw refused("RECOLLECTION_EFFECTS_CHANGED", "Selected source history or the approved window changed. Preview again.");
                    }
                    if (!target.counts.records) throw new BoardError("No available new or deleted request records match. Nothing recollected.", 422);
                    const committed = await access.admit(() => exclusiveBoard(session, async (state, save) => {
                        readable(state);
                        access.check();
                        if (state.revision !== preview.revision) throw refused("RECOLLECTION_BASIS_CHANGED", "Saved activity changed. Preview again.");
                        const at = new Date(now()).toISOString();
                        const selected = new Set(target.identities);
                        if (state.deletion && !access.newOnly) state.deletion = { ...state.deletion, epoch: activityDeletionVersion(state) + 1,
                            identities: state.deletion.identities.filter(id => !selected.has(id)), promptAuthorizations: target.promptAuthorizations };
                        const records = target.records.map(record => ({ ...record,
                            toolCalls: record.toolCalls.map(item => ({ ...item, recollection: { ...item.recollection, operationId: input.operationId, at } })),
                            graphActivities: record.graphActivities.map(item => ({ ...item, recollection: { ...item.recollection, operationId: input.operationId, at } })),
                    }));
                    let merged = access.newOnly ? addMissingRecords(state.evidence ?? [], records) : mergedRecords(state.evidence ?? [], records).map(record => {
                        const incoming = records.find(row => row.scenarioId === record.scenarioId);
                        if (!incoming || !preview.scope.restorePrompts) return record;
                        const canRestore = prompt => {
                            if (!prompt?.sourceEventId || typeof prompt.text !== "string") return false;
                            const id = eventIdentity(record.sourceSessionId, prompt.sourceEventId);
                            return state.deletion?.events.includes(id) && target.promptAuthorizations[id]?.some(alias => selected.has(alias));
                        };
                        const followUpPrompts = [...record.followUpPrompts ?? []];
                        for (const prompt of incoming.followUpPrompts ?? []) if (canRestore(prompt)) {
                            const index = followUpPrompts.findIndex(prior => prior.sourceEventId === prompt.sourceEventId);
                            if (index < 0) followUpPrompts.push(prompt); else followUpPrompts[index] = prompt;
                        }
                        return { ...record, ...(canRestore(incoming.userPrompt) ? { userPrompt: incoming.userPrompt } : {}), followUpPrompts };
                    });
                    if (target.corrections.length) {
                        const byRecord = new Map();
                        for (const change of target.corrections) {
                            if (!byRecord.has(change.scenarioId)) byRecord.set(change.scenarioId, new Map());
                            byRecord.get(change.scenarioId).set(change.toolCallId, change);
                        }
                        let applied = 0;
                        merged = merged.map(record => !byRecord.has(record.scenarioId) ? record : { ...record,
                            toolCalls: record.toolCalls.map(call => {
                                const change = byRecord.get(record.scenarioId).get(call.toolCallId);
                                if (!change) return call;
                                if (fingerprint(call) !== change.before) throw new BoardError("Selected saved call changed. Preview again.", 409);
                                applied++;
                                return change.next;
                            }) });
                        if (applied !== target.corrections.length) throw new BoardError("Correction membership changed. Preview again.", 409);
                    }
                    const rows = Object.fromEntries((state.importCoverage?.roster ?? []).map(row => [row.sessionId, {
                        scanned: row.scanned, cursor: row.cursor, error: row.error, diagnostics: row.diagnostics,
                    }]));
                    const importCoverage = collectionCoverage(target.discovery, rows, merged, preview.scope.window.since, preview.scope.window.until);
                    importCoverage.dynamic = { ...state.importCoverage?.dynamic, ...importCoverage.dynamic };
                    const assertCurrent = () => {
                        access.check();
                        target.assertCheckpoints();
                        if (preview.expires <= now()) throw refused("RECOLLECTION_PREVIEW_EXPIRED", "The preview expired. Preview again.");
                        if (target.corrections.some(c => Date.parse(c.next.startedAt) < now() - config.windowDays * 86400000)
                            || target.records.some(record => recordUnits(record).some(unit => Date.parse(unit.at) < now() - config.windowDays * 86400000))) {
                            throw new BoardError("The source, window or preview changed. Nothing recollected. Preview again.", 409);
                        }
                        checkSelectedSources(config, target);
                    };
                    const preparePublication = async failure => {
                        if (failure && failure.code !== "RECOLLECTION_METADATA_CHANGED") throw failure;
                        // Inside writer admission do not reacquire its lease. The final synchronous guard
                        // still checks the exact source files, checkpoints and freshly validated metadata.
                        access.check();
                        await recheckSelectedMetadata(config, preview.scope, target, access.check);
                    };
                    await beforeSave?.();
                    await preparePublication();
                    assertCurrent();
                    access.dispatched();
                    await stageEvidenceSnapshot(session, state, { records: merged, importCoverage });
                    const operation = { operationId: input.operationId, ownerHash: deletionHash(owner), receiptHash: preview.receiptHash,
                        phase: "complete", completedAt: at, counts: target.counts,
                        ...(target.corrections.length ? { correctionProof: fingerprint([target.corrections, target.dependencies]) } : {}) };
                    state.recollection = { schemaVersion: 1, operations: { ...state.recollection?.operations, [input.operationId]: operation } };
                    state.revision++;
                    await save(state, assertCurrent, preparePublication);
                    onCommitted?.(state);
                    return publicReceipt(operation);
                    }));
                    if (entry) discardRead(owner, input.operationId);
                    return committed;
                } catch (error) { if (entry) discardRead(owner, input.operationId); throw error; }
            });
        },
        async status(owner, input) {
            validate(input, ["operationId", "receiptToken"]);
            if (!uuid.test(input.operationId)) throw new BoardError("Invalid recollection receipt.", 422);
            return coordinate(() => exclusiveBoard(session, state => {
                const entry = state.recollection?.operations?.[input.operationId];
                if (!entry && activeRead?.phase === "verifying" && activeRead.operationId === input.operationId && activeRead.expires > now()) {
                    if (activeRead.owner !== owner && !(typeof input.receiptToken === "string" && /^[a-f0-9]{64}$/.test(input.receiptToken)
                        && deletionHash(input.receiptToken) === activeRead.preview.receiptHash)) throw new BoardError("Recollection receipt is not authorized for this panel.", 403);
                    return { operationId: input.operationId, phase: "verification-incomplete" };
                }
                if (!entry) return { operationId: input.operationId, phase: "not-started" };
                if (!allowed(entry, owner, input.receiptToken)) throw new BoardError("Recollection receipt is not authorized for this panel.", 403);
                return publicReceipt(entry);
            }, { readOnly: true }));
        },
        cancel(owner, input) {
            validate(input, ["operationId"]);
            const entry = previews.get(input.operationId);
            if (entry?.owner === owner) previews.delete(input.operationId);
            discardRead(owner, input.operationId);
            return { cancelled: true };
        },
        release(owner) {
            discardRead(owner);
            for (const [id, entry] of previews) if (owner === undefined || entry.owner === owner) previews.delete(id);
        },
    };
}
