import path from "node:path";
import { readTail, TAIL_LIMITS, hash } from "./collector-io.mjs";
import { recordedResponseTiming, retainResponseTimingEvent } from "./response-timing.mjs";

const overhead = 65536 + 256;
function metadata(event) {
    if (event.type === "user.message") return { id: event.id, type: event.type, timestamp: event.timestamp,
        data: { ...(typeof event.data?.messageId === "string" ? { messageId: event.data.messageId } : {}) } };
    if (event.type === "tool.execution_start") return { id: event.id, type: event.type, timestamp: event.timestamp,
        ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}),
        data: { ...(typeof event.data?.parentToolCallId === "string" ? { parentToolCallId: event.data.parentToolCallId } : {}) } };
    return retainResponseTimingEvent(event);
}

// Same approved source, window and collector byte budget; this checkpoint contains metadata only.
export async function qualifyRetainedResponseTimings(config, source, records, previous, budget, since) {
    if (!config?.approved || !source?.eligible || !/^[a-f0-9-]{36}$/i.test(source.sessionId)) {
        throw new TypeError("Response timing requires an approved eligible source.");
    }
    const targets = records.filter(record => record.sourceSessionId === source.sessionId && !record.assessmentMembershipPruned
        && record.userPrompt?.sourceEventId && Number.isFinite(Date.parse(record.userPrompt.sourceTimestamp))
        && record.userPrompt.sourceTimestamp >= since && record.userPrompt.sourceTimestamp <= new Date().toISOString())
        .map(record => ({ sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp }));
    const unique = [...new Map(targets.map(prompt => [prompt.sourceEventId, prompt])).values()];
    const signature = hash(JSON.stringify(unique));
    if (!unique.length) return { bytesRead: 0, checkpoint: { version: 1, signature, status: "complete", timings: {} } };
    const state = previous?.version === 1 && previous.signature === signature ? structuredClone(previous)
        : { version: 1, signature, status: "pending", cursor: null, context: [], timings: {} };
    if (state.status === "complete") return { bytesRead: 0, checkpoint: state };
    let bytesRead = 0;
    const finish = () => {
        if (!state.context.length) return;
        const prompt = unique.find(value => value.sourceEventId === state.context[0].id);
        if (prompt) state.timings[prompt.sourceEventId] = recordedResponseTiming(state.context, prompt);
        state.context = [];
    };
    while (budget - bytesRead >= overhead + TAIL_LIMITS.chunkBytes) {
        const tail = await readTail(path.join(config.sessionRoot, source.sessionId, "events.jsonl"), source.sessionId, state.cursor);
        bytesRead += tail.bytesRead + overhead;
        if (tail.reset) { state.context = []; state.timings = {}; }
        state.cursor = tail.cursor;
        if (tail.cursor.malformedLines || tail.cursor.oversizedLines) {
            state.context = []; state.status = "complete";
            state.timings = Object.fromEntries(unique.map(prompt => [prompt.sourceEventId,
                { schemaVersion: 1, status: "unavailable", reason: "source-lines-skipped" }]));
            break;
        }
        for (const original of tail.events) {
            const event = metadata(original);
            if (!event) continue;
            if (event.type === "user.message") {
                finish();
                if (unique.some(prompt => prompt.sourceEventId === event.id && prompt.sourceTimestamp === event.timestamp)) state.context = [event];
            } else if (state.context.length) {
                if (state.context.length >= TAIL_LIMITS.maxContextEvents) {
                    state.timings[state.context[0].id] = { schemaVersion: 1, status: "unavailable", reason: "timing-context-limit" };
                    state.context = [];
                } else state.context.push(event);
            }
        }
        if (state.cursor.backlogBytes <= state.cursor.partialBytes) {
            finish();
            state.status = "complete";
            for (const prompt of unique) state.timings[prompt.sourceEventId] ??= { schemaVersion: 1, status: "unavailable", reason: "prompt-not-in-bounded-window" };
            break;
        }
    }
    return { bytesRead, checkpoint: state };
}
