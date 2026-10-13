import { stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { BoardError, exclusiveBoard, stageEvidenceSnapshot } from "./store.mjs";
import { collectorFor, retainEvent, mergedRecords, collectionCoverage } from "./collector.mjs";
import { discoverSources } from "./source-discovery.mjs";
import { readTail, TAIL_LIMITS } from "./collector-io.mjs";
import { extractScenarios } from "./history.mjs";
import { extractGraphActivities } from "./graph-history.mjs";
import { deletionHash, recordUnits, filterDeletedRecords, activityDeletionVersion, eventIdentity } from "./deletion-identities.mjs";
import { textFindings } from "./privacy.mjs";
import { time } from "./time.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fingerprint = value => deletionHash(JSON.stringify(value));
const fileStamp = info => [info.size, info.mtimeMs, info.ctimeMs, info.ino, info.birthtimeMs].join(":");
const safeName = value => textFindings(String(value)).some(f => f.mandatory) ? "Chat name withheld" : value;
const limits = { sources: 128, bytes: TAIL_LIMITS.cycleBytes, records: 20000 };
const boundary = "Optional response captures and personal feedback stay deleted. Saved reports/comparisons, original Copilot files and source/capture settings stay unchanged. Missing, unsupported, anonymous local-only and HTTP diagnostic history cannot be recovered here.";

function validate(input, allowed) {
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new BoardError("Invalid recollection arguments.", 422);
}
function scopeFor(input, config, now) {
    validate(input, ["sourceSessionIds", "from", "to", "timeContext", "restorePrompts"]);
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
            restorePrompts: input.restorePrompts, bounds, window, since, until };
    } catch (error) { throw new BoardError(error.message, 422); }
}

async function scan(config, scope, state) {
    const discovery = discoverSources(config);
    const sources = scope.sourceSessionIds.map(id => {
        const source = discovery.roster.find(row => row.sessionId === id);
        if (!source?.eligible) throw new BoardError("A selected chat is no longer eligible in the approved local source. Preview again; nothing was recollected.", 409);
        return { ...source, checkedAt: scope.window.until };
    });
    let bytes = 0;
    const updates = [], availability = [], stamps = [];
    for (const source of sources) {
        const file = path.join(config.sessionRoot, source.sessionId, "events.jsonl");
        const diagnostics = { credentialExclusions: 0 };
        let info, cursor, events = [], problem, firstPromptEventId;
        try {
            info = await stat(file);
            const before = fileStamp(info);
            do {
                if (bytes >= limits.bytes) { problem = "The bounded reread budget was reached; unscanned history is not included."; break; }
                const tail = await readTail(file, source.sessionId, cursor, Math.min(TAIL_LIMITS.chunkBytes, limits.bytes - bytes));
                if (tail.reset) throw new BoardError("Source history changed during preview. Preview again.", 409);
                bytes += tail.bytesRead;
                // Without a complete readable prefix, the agent-created kickoff is not identifiable.
                if (!firstPromptEventId && tail.cursor.droppedBytes === 0
                    && tail.cursor.malformedLines === 0 && tail.cursor.oversizedLines === 0) {
                    firstPromptEventId = tail.events.find(event => event.type === "user.message")?.id;
                }
                events.push(...tail.events.map(event => retainEvent(event, diagnostics, {
                    agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!firstPromptEventId || event.id === firstPromptEventId),
                })).filter(event => {
                    if (!event) return false;
                    if (textFindings(JSON.stringify(event)).some(f => f.mandatory)) { diagnostics.credentialExclusions++; return false; }
                    return true;
                }));
                const previous = cursor?.offset;
                cursor = tail.cursor;
                if (cursor.offset === previous) break;
            } while (cursor.backlogBytes > cursor.partialBytes);
            if (fileStamp(await stat(file)) !== before) throw new BoardError("Source history changed during preview. Preview again.", 409);
            stamps.push([source.sessionId, before]);
        } catch (error) {
            if (error instanceof BoardError && error.status === 409) throw error;
            if (!(error instanceof BoardError) && !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
            problem = error instanceof BoardError ? error.message : `Local history unavailable (${error.code}).`;
            events = [];
            stamps.push([source.sessionId, "unavailable", error.code ?? error.message]);
        }
        const partialWindow = Boolean(problem || cursor?.droppedBytes || cursor?.malformedLines
            || cursor?.oversizedLines || diagnostics.credentialExclusions);
        const work = extractScenarios(events, source, scope.since, scope.until, { partialWindow });
        const graph = extractGraphActivities(events, source, { since: scope.since, until: scope.until, partialWindow });
        updates.push(...work.scenarios, ...graph.scenarios);
        availability.push({ sourceSessionId: source.sessionId, name: safeName(source.name), problem: problem ?? null,
            droppedBytes: cursor?.droppedBytes ?? 0, unreadBytes: cursor?.backlogBytes ?? 0,
            malformedLines: cursor?.malformedLines ?? 0, oversizedLines: cursor?.oversizedLines ?? 0,
            credentialExclusions: diagnostics.credentialExclusions, missingResults: work.missingResults });
    }
    const currentUnits = (state.evidence ?? []).flatMap(recordUnits);
    const currentAliases = new Map(currentUnits.flatMap(unit => unit.aliases.map(alias => [alias, unit])));
    const deleted = new Set(state.deletion?.identities ?? []);
    const deletedEvents = new Set(state.deletion?.events ?? []);
    const promptAuthorizations = structuredClone(state.deletion?.promptAuthorizations ?? {});
    const selectedAliases = new Set(), selected = [];
    const restoredPrompts = new Set();
    let alreadyPresent = 0, unsupported = 0, reauthorized = 0, toolCalls = 0, graphRecords = 0, promptOnly = 0;
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
            if (unit.aliases.some(id => selectedAliases.has(id))) throw new BoardError("Source records have ambiguous duplicate identities. Nothing was recollected.", 409);
            unit.aliases.forEach(id => selectedAliases.add(id));
            const wasDeleted = unit.aliases.some(id => deleted.has(id));
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
    return { records: cleaned, identities, promptAuthorizations, availability, stamps, counts: {
        records, reauthorized, newRecords: records - reauthorized - promptOnly, promptOnly, restoredPrompts: restoredPrompts.size,
        toolCalls, graphRecords, alreadyPresent, unsupported, savedReports: state.exports.length },
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
    const readable = state => { if (state.deletion?.pending) throw new BoardError("Finish the existing sealed deletion cleanup before recollecting.", 409); };
    const publicReceipt = ({ ownerHash, receiptHash, ...value }) => value;
    const allowed = (entry, owner, token) => entry.ownerHash === deletionHash(owner)
        || typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && entry.receiptHash === deletionHash(token);
    function prune(owner) {
        for (const [id, entry] of previews) if (entry.owner === owner || entry.expires < now()) previews.delete(id);
    }
    return {
        async sources() {
            const config = collector().approvedRecollectionSource();
            const discovery = discoverSources(config);
            const sources = await Promise.all(discovery.roster.filter(row => row.eligible).map(async row => {
                let available = true;
                try { available = (await stat(path.join(config.sessionRoot, row.sessionId, "events.jsonl"))).isFile(); }
                catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error; available = false; }
                return { sourceSessionId: row.sessionId, name: safeName(row.name), available };
            }));
            return { sources, windowDays: config.windowDays, since: new Date(now() - config.windowDays * 86400000).toISOString(),
                until: new Date(now()).toISOString(), excludedSources: discovery.roster.length - sources.length,
                skippedSources: discovery.counts.skippedByLimit, boundary, limits };
        },
        async preview(owner, input) {
            return coordinate(() => exclusiveBoard(session, async state => {
                readable(state);
                const config = collector().approvedRecollectionSource();
                const scope = scopeFor(input, config, now());
                const target = await scan(config, scope, state);
                prune(owner);
                if (previews.size >= 128) throw new BoardError("Too many active recollection previews. Close unused panels.", 429);
                const operationId = randomUUID(), receiptToken = randomBytes(32).toString("hex"), expires = now() + 120000;
                previews.set(operationId, { owner, scope, expires, revision: state.revision, configHash: fingerprint(config),
                    targetHash: fingerprint(target), receiptHash: deletionHash(receiptToken) });
                return { operationId, receiptToken, scope, expiresAt: new Date(expires).toISOString(),
                    counts: target.counts, availability: target.availability, boundary };
            }));
        },
        async confirm(owner, input) {
            validate(input, ["operationId", "confirmed"]);
            if (!uuid.test(input.operationId) || input.confirmed !== true) throw new BoardError("Explicit recollection confirmation is required.", 422);
            return coordinate(() => exclusiveBoard(session, async (state, save) => {
                readable(state);
                const prior = state.recollection?.operations?.[input.operationId];
                if (prior) {
                    if (!allowed(prior, owner)) throw new BoardError("Recollection belongs to another panel.", 403);
                    return publicReceipt(prior);
                }
                const preview = previews.get(input.operationId);
                if (!preview || preview.owner !== owner) throw new BoardError("Recollection preview is unavailable. Preview and confirm again; nothing was replayed.", 409);
                previews.delete(input.operationId);
                const config = collector().approvedRecollectionSource();
                if (preview.expires < now() || state.revision !== preview.revision || fingerprint(config) !== preview.configHash) throw new BoardError("Evidence, source approval or preview changed. Nothing recollected. Preview again.", 409);
                const target = await scan(config, preview.scope, state);
                const currentSince = now() - config.windowDays * 86400000;
                if (fingerprint(target) !== preview.targetHash || target.records.flatMap(recordUnits).some(unit => Date.parse(unit.at) < currentSince)) {
                    throw new BoardError("Source history or the approved window changed. Nothing recollected. Preview again.", 409);
                }
                if (!target.counts.records) throw new BoardError("No available new or deleted request records match. Nothing recollected.", 422);
                const at = new Date(now()).toISOString();
                const selected = new Set(target.identities);
                if (state.deletion) state.deletion = { ...state.deletion, epoch: activityDeletionVersion(state) + 1,
                    identities: state.deletion.identities.filter(id => !selected.has(id)), promptAuthorizations: target.promptAuthorizations };
                const records = target.records.map(record => ({ ...record,
                    toolCalls: record.toolCalls.map(item => ({ ...item, recollection: { ...item.recollection, operationId: input.operationId, at } })),
                    graphActivities: record.graphActivities.map(item => ({ ...item, recollection: { ...item.recollection, operationId: input.operationId, at } })),
                }));
                const merged = mergedRecords(state.evidence ?? [], records).map(record => {
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
                const rows = Object.fromEntries((state.importCoverage?.roster ?? []).map(row => [row.sessionId, {
                    scanned: row.scanned, cursor: row.cursor, error: row.error, diagnostics: row.diagnostics,
                }]));
                const importCoverage = collectionCoverage(target.discovery, rows, merged, preview.scope.window.since, preview.scope.window.until);
                importCoverage.dynamic = { ...state.importCoverage?.dynamic, ...importCoverage.dynamic };
                await stageEvidenceSnapshot(session, state, { records: merged, importCoverage });
                const operation = { operationId: input.operationId, ownerHash: deletionHash(owner), receiptHash: preview.receiptHash,
                    phase: "complete", completedAt: at, counts: target.counts };
                state.recollection = { schemaVersion: 1, operations: { ...state.recollection?.operations, [input.operationId]: operation } };
                state.revision++;
                await beforeSave?.();
                await save(state);
                onCommitted?.(state);
                return publicReceipt(operation);
            }));
        },
        async status(owner, input) {
            validate(input, ["operationId", "receiptToken"]);
            if (!uuid.test(input.operationId)) throw new BoardError("Invalid recollection receipt.", 422);
            return exclusiveBoard(session, state => {
                const entry = state.recollection?.operations?.[input.operationId];
                if (!entry) return { operationId: input.operationId, phase: "not-started" };
                if (!allowed(entry, owner, input.receiptToken)) throw new BoardError("Recollection receipt is not authorized for this panel.", 403);
                return publicReceipt(entry);
            });
        },
        cancel(owner, input) {
            validate(input, ["operationId"]);
            const entry = previews.get(input.operationId);
            if (entry?.owner === owner) previews.delete(input.operationId);
            return { cancelled: true };
        },
    };
}
