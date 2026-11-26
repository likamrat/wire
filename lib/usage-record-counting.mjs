import { stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { BoardError, exclusiveBoard, loadBoardState, stageEvidenceSnapshot } from "./store.mjs";
import { collectorFor, retainEvent } from "./collector.mjs";
import { RECOLLECTION_LIMITS as limits } from "./recollection.mjs";
import { discoverSources } from "./source-discovery.mjs";
import { sourceHost } from "./source-host.mjs";
import { readTail, sourceFileStamp, TAIL_LIMITS } from "./collector-io.mjs";
import { managedErrorServers, qualifiedResultPaths } from "./history.mjs";
import { deletionHash, filterDeletedEvents, filterDeletedRecords } from "./deletion-identities.mjs";
import { historyGap } from "./prompt-linkage.mjs";
import { textFindings } from "./privacy.mjs";
import { retainedUsage, usageMatcherEvents } from "./usage-receipts.mjs";
import { readUsageIndex, usageIndexFile, indexedUsage } from "./copilot-usage-index.mjs";
import { recordedUsage } from "./interaction-usage.mjs";

// Counts tokens in chats WIRE already read, from Copilot's own per-call records. Ordinary collection reads those
// records only when a chat changes, so this explicit, previewed and separately confirmed operation is the only way
// a finished chat gains a total. It writes nothing but the previewed totals and one receipt.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = value => deletionHash(JSON.stringify(value));
const credential = value => textFindings(typeof value === "string" ? value : JSON.stringify(value)).some(f => f.mandatory);
const refused = (code, message) => Object.assign(new BoardError(`Nothing was saved. ${message}`, 409), { code });
const changed = message => refused("USAGE_COUNT_CHANGED", message);
const PREVIEW_MS = 120000;
// Reasons ordinary collection already names, plus the bounds of this operation.
const indexReasons = { "index-unavailable": "no-records", "index-prompt-unbound": "prompt-not-matched", "index-boundary": "calls-outside-rounds",
    "index-incomplete": "calls-outside-rounds", "index-no-calls": "no-calls", "index-turn-open": "exchange-open", "index-invalid-row": "records-unreadable" };

function validate(input, allowed) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
        throw new BoardError("Invalid token-count arguments.", 422);
    }
}

// The same journal view ordinary collection meters: one bounded reread of the original, retained with its rules.
async function readJournal(access, file, source, deletion, budget) {
    const before = sourceFileStamp(await stat(file));
    const ids = new Set(source.managedWorkIqEventIds ?? []), diagnostics = { credentialExclusions: 0 }, retained = [];
    let cursor, bytes = 0, firstPromptEventId;
    do {
        await access.verify();
        if (bytes >= budget) return { bytes, stamp: before, exhausted: true };
        const tail = await readTail(file, source.sessionId, cursor, Math.min(TAIL_LIMITS.chunkBytes, budget - bytes), { completionMetadata: true });
        if (tail.reset) return { bytes, stamp: before, changed: true };
        bytes += tail.bytesRead;
        if (!firstPromptEventId && !tail.cursor.droppedBytes) firstPromptEventId = tail.events.find(e => e.type === "user.message")?.id;
        const raw = filterDeletedEvents(tail.events, source.sessionId, deletion);
        const context = { managedWorkIqEventIds: ids, managedErrorServers: managedErrorServers(raw, retained, ids),
            resultPaths: qualifiedResultPaths(raw, retained, ids), usagePayloads: qualifiedResultPaths(raw, retained, ids, true),
            metering: true, sourceSessionId: source.sessionId };
        for (const event of raw) {
            const kept = retainEvent(event, diagnostics, { ...context,
                agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!firstPromptEventId || event.id === firstPromptEventId) });
            if (!kept) continue;
            if (credential(kept)) { if (kept.type === "user.message") retained.push(historyGap(`wire-gap-${deletionHash(kept.id)}`, "credential-excluded")); }
            else retained.push(kept);
        }
        const previous = cursor?.offset;
        cursor = tail.cursor;
        if (cursor.offset === previous) break;
    } while (cursor.backlogBytes > cursor.partialBytes);
    if (cursor.backlogBytes > cursor.partialBytes) return { bytes, stamp: before, exhausted: true };
    if (sourceFileStamp(await stat(file)) !== before) return { bytes, stamp: before, changed: true };
    return { bytes, stamp: before, events: usageMatcherEvents(retained) };
}

// One chat: its journal, then only its own index rows, then the qualification ordinary collection uses.
async function examineChat(access, files, source, members, deletion, budget) {
    const outcome = (reason, extra = {}) => ({ ...extra, results: new Map(members.map(r => [r.scenarioId, { reason }])) });
    let journal;
    try { journal = await readJournal(access, files.historyFile(source.sessionId), source, deletion, budget); }
    catch (error) {
        access.check();
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code) || error instanceof BoardError && error.status === 422) {
            return outcome("chat-unavailable", { bytes: 0, stamp: null });
        }
        throw error;
    }
    if (journal.exhausted) return outcome("too-large", journal);
    if (journal.changed) return outcome("chat-changed", journal);
    // Like collection, the approval is checked immediately before each chat's records are opened.
    await access.grantCurrent();
    let index;
    try { index = readUsageIndex(usageIndexFile(files.databaseFile()), source.sessionId); }
    catch (error) {
        if (error.code !== "usage_index_unreadable") throw error;
        return outcome(error.reason === "bounds" ? "too-large" : "records-unreadable", journal);
    }
    if (!index) return outcome("no-records", journal);
    const results = new Map();
    for (const record of members) {
        let reason = null;
        // Journal receipts win, exactly as in ordinary collection.
        if (retainedUsage(journal.events, record, false)) { results.set(record.scenarioId, { reason: "journal-receipts" }); continue; }
        const calls = indexedUsage(journal.events, record, index, code => { reason = indexReasons[code] ?? "records-unreadable"; return null; });
        results.set(record.scenarioId, calls ? { calls, total: recordedUsage(calls).total } : { reason });
    }
    return { bytes: journal.bytes, stamp: journal.stamp, rowDigest: digest(index), results };
}

// Approved local chats in the approved window with retained interactions that have tool calls and no total.
function population(state, discovery, config, now) {
    const roster = new Map(discovery.roster.filter(row => row.eligible).map(row => [row.sessionId, row]));
    const since = now - config.windowDays * 86400000;
    const chats = new Map();
    for (const record of state.evidence ?? []) {
        if (record.usageCalls?.length || !record.toolCalls?.length || !roster.has(record.sourceSessionId)
            || typeof record.userPrompt?.text !== "string" || !record.userPrompt.sourceEventId
            || !(Date.parse(record.userPrompt.sourceTimestamp) >= since)
            || !filterDeletedRecords([record], state.deletion).length) continue;
        if (!chats.has(record.sourceSessionId)) chats.set(record.sourceSessionId, { source: roster.get(record.sourceSessionId), members: [], latest: "" });
        const chat = chats.get(record.sourceSessionId);
        chat.members.push(record);
        if (record.userPrompt.sourceTimestamp > chat.latest) chat.latest = record.userPrompt.sourceTimestamp;
    }
    return [...chats.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.source.sessionId.localeCompare(b.source.sessionId));
}

function indexStamp(files) {
    try { return sourceFileStamp(statSync(usageIndexFile(files.databaseFile()))); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}

export function createUsageRecordCountController(session, { now = Date.now, onCommitted, coordinateRecorder = work => work() } = {}) {
    const previews = new Map();
    const collector = () => {
        const value = collectorFor(session);
        if (!value) throw new BoardError("Collection runtime is unavailable. Nothing was counted.", 503);
        return value;
    };
    const coordinate = work => coordinateRecorder(() => collector().exclusiveActivity(work));
    async function openScope(owner, ticket, purpose) {
        const access = await collector().openRecollectionScope(owner, ticket, purpose);
        const unavailable = () => {
            const message = "Reading Copilot's token records is off, paused or needs a new approval.";
            return purpose === "confirm" ? refused("USAGE_COUNT_UNAVAILABLE", message) : Object.assign(new BoardError(message, 409), { code: "USAGE_COUNT_UNAVAILABLE" });
        };
        // Never under Pause, and only while the token-record approval still names this file and Copilot account.
        if (access.config.enabled !== true || access.config.usageRecords !== true || typeof access.usageRecordsCurrent !== "function") throw unavailable();
        access.grantCurrent = async () => { if (!await access.usageRecordsCurrent()) throw unavailable(); access.check(); };
        await access.grantCurrent();
        return access;
    }
    const readable = state => { if (state.deletion?.pending) throw new BoardError("Finish the existing sealed deletion cleanup first.", 409); };
    const publicReceipt = ({ ownerHash, receiptHash, ...value }) => value;
    const allowed = (entry, owner, token) => entry.ownerHash === deletionHash(owner)
        || typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && entry.receiptHash === deletionHash(token);
    function prune(owner) {
        for (const [id, entry] of previews) if (entry.owner === owner || entry.expires <= now()) previews.delete(id);
    }
    return {
        async preview(owner, input = {}, ticket) {
            validate(input, []);
            return coordinate(async () => {
                const access = await openScope(owner, ticket, "preview"), { config } = access, files = sourceHost(config);
                const state = await loadBoardState(session, { readOnly: true });
                readable(state);
                await access.verify();
                const discovery = await discoverSources(config);
                const chats = population(state, discovery, config, now());
                const candidates = chats.reduce((n, chat) => n + chat.members.length, 0);
                if (candidates > limits.records) throw new BoardError(`More than ${limits.records.toLocaleString("en-US")} interactions need checking. Nothing was read.`, 413);
                const examined = [], refusals = new Map(), members = [];
                const refuse = (reason, n = 1) => refusals.set(reason, (refusals.get(reason) ?? 0) + n);
                let bytes = 0;
                for (const [n, chat] of chats.entries()) {
                    if (n >= limits.sources) { refuse("over-limit", chat.members.length); continue; }
                    if (bytes >= limits.bytes) { refuse("too-large", chat.members.length); continue; }
                    const result = await examineChat(access, files, chat.source, chat.members, state.deletion, limits.bytes - bytes);
                    bytes += result.bytes;
                    examined.push({ sessionId: chat.source.sessionId, stamp: result.stamp, rowDigest: result.rowDigest ?? null });
                    for (const record of chat.members) {
                        const value = result.results.get(record.scenarioId);
                        if (value.calls) members.push({ scenarioId: record.scenarioId, sourceSessionId: record.sourceSessionId, calls: digest(value.calls), total: value.total });
                        else refuse(value.reason);
                    }
                }
                await access.verify();
                return exclusiveBoard(session, current => {
                    readable(current); access.check();
                    if (current.revision !== state.revision) throw new BoardError("Saved activity changed while checking. Check again.", 409);
                    prune(owner);
                    if (previews.size >= 128) throw new BoardError("Too many open token-count previews. Close unused panels.", 429);
                    const operationId = randomUUID(), receiptToken = randomBytes(32).toString("hex"), expires = now() + PREVIEW_MS;
                    const counts = { interactions: members.length, chats: new Set(members.map(m => m.sourceSessionId)).size,
                        tokens: members.reduce((n, m) => n + m.total, 0), refused: [...refusals.values()].reduce((n, v) => n + v, 0) };
                    if (members.length) previews.set(operationId, { owner, expires, generation: access.generation, revision: state.revision,
                        configHash: digest(config), grant: digest(config.usageRecordsGrant ?? null),
                        chats: examined.filter(c => members.some(m => m.sourceSessionId === c.sessionId)), members, counts,
                        receiptHash: deletionHash(receiptToken) });
                    return { ...(members.length ? { operationId, receiptToken, expiresAt: new Date(expires).toISOString() } : {}), counts,
                        refusals: [...refusals].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
                        limits: { chats: limits.sources, bytes: limits.bytes, fileBytes: TAIL_LIMITS.initialFileBytes, records: limits.records } };
                }, { readOnly: true });
            });
        },
        async confirm(owner, input, ticket) {
            validate(input, ["operationId", "confirmed"]);
            if (!uuid.test(input.operationId ?? "") || input.confirmed !== true) throw new BoardError("Explicit confirmation is required.", 422);
            return coordinate(async () => {
                const observed = await loadBoardState(session, { readOnly: true });
                readable(observed);
                const prior = observed.usageRecordCounts?.operations?.[input.operationId];
                if (prior) {
                    if (!allowed(prior, owner)) throw new BoardError("This token count belongs to another panel.", 403);
                    return publicReceipt(prior);
                }
                const preview = previews.get(input.operationId);
                if (!preview || preview.owner !== owner) throw refused("USAGE_COUNT_EXPIRED", "This preview is no longer available. Check again.");
                previews.delete(input.operationId);
                if (preview.expires <= now()) throw refused("USAGE_COUNT_EXPIRED", "The preview expired. Check again.");
                const access = await openScope(owner, ticket, "confirm"), { config } = access, files = sourceHost(config);
                if (access.generation !== preview.generation || digest(config) !== preview.configHash || digest(config.usageRecordsGrant ?? null) !== preview.grant) {
                    throw changed("The source or token-record approval changed. Check again.");
                }
                if (observed.revision !== preview.revision) throw changed("Saved activity changed. Check again.");
                const since = now() - config.windowDays * 86400000;
                const byId = new Map((observed.evidence ?? []).map(r => [r.scenarioId, r]));
                const discovery = await discoverSources(config);
                const roster = new Map(discovery.roster.filter(row => row.eligible).map(row => [row.sessionId, row]));
                // A change elsewhere in Copilot's records doesn't refuse by itself: the previewed chats' rows are reread
                // and must still match. The file must then stay as reread until the write.
                const confirmedIndex = indexStamp(files);
                let bytes = 0;
                for (const chat of preview.chats) {
                    const members = preview.members.filter(m => m.sourceSessionId === chat.sessionId).map(m => byId.get(m.scenarioId));
                    if (!roster.has(chat.sessionId) || members.some(r => !r || r.usageCalls?.length || !(Date.parse(r.userPrompt?.sourceTimestamp) >= since))) {
                        throw changed("A previewed chat or interaction is no longer eligible. Check again.");
                    }
                    const result = await examineChat(access, files, roster.get(chat.sessionId), members, observed.deletion, limits.bytes - bytes);
                    bytes += result.bytes;
                    if (result.stamp !== chat.stamp) throw changed("A previewed chat's history changed. Check again.");
                    if (result.rowDigest !== chat.rowDigest) throw changed("Copilot's token records for a previewed chat changed. Check again.");
                    for (const record of members) {
                        const value = result.results.get(record.scenarioId);
                        if (!value.calls || digest(value.calls) !== preview.members.find(m => m.scenarioId === record.scenarioId).calls) {
                            throw changed("A previewed total no longer matches. Check again.");
                        }
                        chat.calls ??= new Map();
                        chat.calls.set(record.scenarioId, value.calls);
                    }
                }
                await access.verify();
                const assertCurrent = () => {
                    access.check();
                    if (preview.expires <= now()) throw refused("USAGE_COUNT_EXPIRED", "The preview expired. Check again.");
                    if (indexStamp(files) !== confirmedIndex) throw changed("Copilot's token records changed while saving. Check again.");
                    for (const chat of preview.chats) {
                        let stamp = null;
                        try { stamp = sourceFileStamp(statSync(files.historyFile(chat.sessionId))); } catch { stamp = null; }
                        if (stamp !== chat.stamp) throw changed("A previewed chat's history changed. Check again.");
                    }
                };
                const calls = new Map(preview.chats.flatMap(chat => [...chat.calls]));
                // Like a collection pass that read token records, the write commits only while the same account holds the approval.
                const grantCurrent = access.grantCurrent;
                return access.admit(() => exclusiveBoard(session, async (state, save) => {
                    readable(state);
                    if (state.revision !== preview.revision) throw changed("Saved activity changed. Check again.");
                    await grantCurrent();
                    assertCurrent();
                    let written = 0;
                    const records = state.evidence.map(record => {
                        if (!calls.has(record.scenarioId)) return record;
                        if (record.usageCalls?.length) throw changed("A previewed interaction already has a total. Check again.");
                        written++;
                        return { ...record, usageCalls: calls.get(record.scenarioId), usageGap: null };
                    });
                    if (written !== calls.size) throw changed("Previewed interactions changed. Check again.");
                    access.dispatched();
                    await stageEvidenceSnapshot(session, state, { records, importCoverage: state.importCoverage });
                    const operation = { operationId: input.operationId, ownerHash: deletionHash(owner), receiptHash: preview.receiptHash,
                        phase: "complete", completedAt: new Date(now()).toISOString(), counts: preview.counts };
                    state.usageRecordCounts = { schemaVersion: 1, operations: { ...state.usageRecordCounts?.operations, [input.operationId]: operation } };
                    state.revision++;
                    await save(state, assertCurrent, async failure => { if (failure) throw failure; await grantCurrent(); });
                    onCommitted?.(state);
                    return publicReceipt(operation);
                }));
            });
        },
        async status(owner, input) {
            validate(input, ["operationId", "receiptToken"]);
            if (!uuid.test(input.operationId ?? "")) throw new BoardError("Invalid token-count receipt.", 422);
            return exclusiveBoard(session, state => {
                const entry = state.usageRecordCounts?.operations?.[input.operationId];
                if (!entry) return { operationId: input.operationId, phase: "not-started" };
                if (!allowed(entry, owner, input.receiptToken)) throw new BoardError("This token-count receipt is not authorized for this panel.", 403);
                return publicReceipt(entry);
            }, { readOnly: true });
        },
        cancel(owner, input) {
            validate(input, ["operationId"]);
            if (previews.get(input.operationId)?.owner === owner) previews.delete(input.operationId);
            return { cancelled: true };
        },
        release(owner) {
            for (const [id, entry] of previews) if (owner === undefined || entry.owner === owner) previews.delete(id);
        },
    };
}
