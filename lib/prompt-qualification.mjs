import { open } from "node:fs/promises";
import { TAIL_LIMITS } from "./collector-io.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { sourceHost } from "./source-host.mjs";

const prefixLimit = 65536;
const tailOverhead = prefixLimit + 256; // Startup prefix plus both 128-byte cursor anchors.
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const PROMPT_LOOKUP_VERSION = 2;

async function readFirstPrompt(config, source) {
    let handle, bytesRead = 0, first, startupEventId, identity;
    try {
        const files = sourceHost(config);
        handle = await open(files.historyFile(source.sessionId), "r");
        const info = await files.statHandle(source.sessionId, handle, undefined, { hostLookup: true });
        const buffer = Buffer.alloc(prefixLimit);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        bytesRead += read.bytesRead;
        const lines = buffer.subarray(0, read.bytesRead).toString("utf8").split("\n");
        lines.pop();
        let startup;
        for (const line of lines) {
            let event;
            try { event = JSON.parse(line); }
            catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                return { checkpoint: { status: "unavailable", reason: "invalid-child-prefix" }, bytesRead, authorship: null };
            }
            if (!startup) {
                startup = event;
                if (event?.type !== "session.start" || event.data?.sessionId !== source.sessionId || event.data.version !== 1) {
                    return { checkpoint: { status: "unavailable", reason: "child-identity-mismatch" }, bytesRead, authorship: null };
                }
                startupEventId = event.id;
                identity = files.identity(source.sessionId, info, event.id);
            }
            if (event?.type === "user.message") { first = event; break; }
        }
    } catch (error) {
        if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
        return { checkpoint: { status: "unavailable", reason: error.code === "ENOENT" ? "child-history-missing" : "child-history-unreadable" }, bytesRead, authorship: null };
    } finally { await handle?.close(); }
    return { first, startupEventId, identity, bytesRead };
}

// A targeted author correction, never a source import or a collector-cursor rewind.
export async function qualifyRetainedKickoff(config, source, creator, records, previous, budget) {
    if (!config?.approved || !source?.eligible || !creator?.eligible
        || !uuid.test(source.sessionId) || !uuid.test(creator.sessionId)
        || source.promptCreation?.actor !== "agent"
        || ![creator.sessionId, creator.appId, ...(creator.workspaceIds ?? [])].includes(source.promptCreation.creatorSessionId)) {
        throw new TypeError("Kickoff qualification requires approved, eligible creator and child sources.");
    }
    if (budget < prefixLimit) return { checkpoint: previous, bytesRead: 0, authorship: null };
    const prefix = await readFirstPrompt(config, source);
    if (prefix.checkpoint) return prefix;
    const { first } = prefix;
    let bytesRead = prefix.bytesRead;
    const record = records.find(record => record.userPrompt?.sourceEventId === first?.id
        && record.userPrompt.sourceTimestamp === first?.timestamp && record.userPrompt.text === first?.data?.content);
    if (!record) return { checkpoint: { status: "unavailable", reason: "retained-first-message-not-verified" }, bytesRead, authorship: null };
    const prompt = record.userPrompt;
    let cursor = previous?.eventId === first.id && previous.creatorSessionId === creator.sessionId ? previous.cursor : undefined;
    const checkpoint = { eventId: first.id, creatorSessionId: creator.sessionId, status: "pending" };
    while (budget - bytesRead >= tailOverhead + TAIL_LIMITS.chunkBytes) {
        let tail;
        try {
            tail = await sourceHost(config).readHistory(creator.sessionId, cursor,
                Math.min(TAIL_LIMITS.chunkBytes, budget - bytesRead - tailOverhead), { hostLookup: true });
        } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM", "HISTORY_STARTUP_INVALID", "HISTORY_IDENTITY_UNSUPPORTED"].includes(error.code)) throw error;
            return { checkpoint: { ...checkpoint, status: "unavailable", reason: error.code === "ENOENT" ? "creator-history-missing" : "creator-history-unverified" }, bytesRead, authorship: null };
        }
        bytesRead += tail.bytesRead + tailOverhead;
        cursor = tail.cursor;
        for (const event of tail.events) {
            const data = event.data;
            if (event.type !== "external_tool.requested" || data?.toolName !== "create_session"
                || data.sessionId !== creator.sessionId || typeof data.toolCallId !== "string" || !uuid.test(event.id)
                || !Number.isFinite(Date.parse(event.timestamp)) || event.timestamp > first.timestamp
                || Date.parse(event.timestamp) < Date.now() - config.windowDays * 86400000
                || data.arguments?.kickoff?.prompt !== prompt.text) continue;
            const current = { authorship: promptAuthorship.fromEvent(first) };
            return { checkpoint: { ...checkpoint, status: "qualified", creatorEventId: event.id },
                bytesRead, eventId: first.id, authorship: promptAuthorship.correlateKickoff(current) };
        }
        if (cursor.backlogBytes <= cursor.partialBytes) return {
            checkpoint: { ...checkpoint, status: "unavailable", reason: "creator-kickoff-not-in-bounded-history" }, bytesRead, authorship: null,
        };
    }
    return { checkpoint: { ...checkpoint, cursor }, bytesRead, authorship: null };
}

export async function qualifyRetainedPromptEvents(config, source, records, previous, budget) {
    if (!config?.approved || !source?.eligible || !uuid.test(source.sessionId)) throw new TypeError("Prompt qualification requires an approved eligible source.");
    const updates = [], candidates = new Map(records.map(record => [record.userPrompt.sourceEventId, record.userPrompt]));
    if (previous?.lookupVersion !== PROMPT_LOOKUP_VERSION) previous = undefined;
    const priorBytes = previous?.lookupBytes ?? 0;
    if (priorBytes + prefixLimit + tailOverhead >= TAIL_LIMITS.initialFileBytes) return {
        checkpoint: { ...previous, status: "unavailable", reason: "original-event-lookup-budget" }, bytesRead: 0, updates,
    };
    if (budget < prefixLimit) return { checkpoint: previous, bytesRead: 0, updates };
    const prefix = await readFirstPrompt(config, source);
    if (prefix.checkpoint) return { ...prefix, updates };
    let bytesRead = prefix.bytesRead, lookupBytes = priorBytes + prefix.bytesRead, cursor = previous?.cursor;
    let lookupWindow = previous?.lookupWindow ?? "tail", tailCursor = previous?.tailCursor;
    let earlyEventIds = (previous?.earlyEventIds ?? []).filter(id => candidates.has(id)), windowProbed = previous?.windowProbed ?? false;
    if (lookupWindow === "head" && !earlyEventIds.length && tailCursor) {
        cursor = tailCursor; tailCursor = undefined; lookupWindow = "tail";
    }
    const matched = new Set(previous?.matchedEventIds ?? []);
    const checkpoint = () => ({ lookupVersion: PROMPT_LOOKUP_VERSION, status: "pending", cursor, lookupWindow, tailCursor,
        earlyEventIds, windowProbed, lookupBytes, matchedEventIds: [...matched],
        firstPromptEventId: prefix.first?.id ?? null });
    while (budget - bytesRead >= tailOverhead + TAIL_LIMITS.chunkBytes && TAIL_LIMITS.initialFileBytes - lookupBytes > tailOverhead) {
        let tail;
        try {
            tail = await sourceHost(config).readHistory(source.sessionId, cursor,
                Math.min(TAIL_LIMITS.chunkBytes, budget - bytesRead - tailOverhead, TAIL_LIMITS.initialFileBytes - lookupBytes - tailOverhead),
                { startAtBeginning: lookupWindow === "head", hostLookup: true });
        } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM", "HISTORY_STARTUP_INVALID", "HISTORY_IDENTITY_UNSUPPORTED"].includes(error.code)) throw error;
            return { checkpoint: { status: "unavailable", reason: "original-history-unavailable" }, bytesRead, updates };
        }
        bytesRead += tail.bytesRead + tailOverhead;
        lookupBytes += tail.bytesRead + tailOverhead;
        if (tail.cursor.identity !== prefix.identity) return {
            checkpoint: { status: "unavailable", reason: "original-history-changed" }, bytesRead, updates: [],
        };
        cursor = tail.cursor;
        for (const event of tail.events) {
            const retained = candidates.get(event.id);
            if (event.type !== "user.message" || !retained || matched.has(event.id)) continue;
            matched.add(event.id);
            if (event.timestamp !== retained.sourceTimestamp || event.data?.content !== retained.text) {
                updates.push({ eventId: event.id, authorship: { actor: "unknown", basis: "conflicting-source" } });
                continue;
            }
            updates.push({ eventId: event.id, authorship: promptAuthorship.fromEvent(event, {
                agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!prefix.first || event.id === prefix.first.id),
            }) });
        }
        if ([...candidates.keys()].every(id => matched.has(id))) return {
            checkpoint: { ...checkpoint(), status: "complete" }, bytesRead, updates,
        };
        if (!windowProbed && lookupWindow === "tail") {
            windowProbed = true;
            const earliest = tail.events.reduce((value, event) => {
                const date = Date.parse(event.timestamp);
                return Number.isFinite(date) ? Math.min(value, date) : value;
            }, Infinity);
            earlyEventIds = Number.isFinite(earliest) && cursor.droppedBytes > 0
                ? [...candidates].filter(([id, prompt]) => !matched.has(id) && Date.parse(prompt.sourceTimestamp) < earliest).map(([id]) => id) : [];
            if (earlyEventIds.length) {
                // Timestamps locate a bounded window, never establish authorship. Only exact retained identities can match.
                tailCursor = cursor; cursor = undefined; lookupWindow = "head";
                continue;
            }
        }
        if (lookupWindow === "head" && earlyEventIds.every(id => matched.has(id))) {
            cursor = tailCursor; tailCursor = undefined; lookupWindow = "tail";
            continue;
        }
        if (cursor.backlogBytes <= cursor.partialBytes) return { checkpoint: { ...checkpoint(), status: "complete" }, bytesRead, updates };
    }
    return { checkpoint: TAIL_LIMITS.initialFileBytes - lookupBytes <= tailOverhead
        ? { ...checkpoint(), status: "unavailable", reason: "original-event-lookup-budget" } : checkpoint(), bytesRead, updates };
}
