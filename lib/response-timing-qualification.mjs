import path from "node:path";
import { readTail, TAIL_LIMITS, hash } from "./collector-io.mjs";
import { recordedResponseTiming, retainResponseTimingEvent } from "./response-timing.mjs";
import { recordedInteractionModels, retainInteractionModelMetadata } from "./interaction-model.mjs";

const overhead = 65536 + 256;
function metadata(event, models = false) {
    if (!event || typeof event !== "object") return null;
    if (event.type === "user.message") return { id: event.id, type: event.type, timestamp: event.timestamp,
        data: { ...(typeof event.data?.messageId === "string" ? { messageId: event.data.messageId } : {}) } };
    if (event.type === "tool.execution_start") return { id: event.id, type: event.type, timestamp: event.timestamp,
        ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}),
        data: { ...(typeof event.data?.parentToolCallId === "string" ? { parentToolCallId: event.data.parentToolCallId } : {}) } };
    const timing = retainResponseTimingEvent(event);
    return models && timing?.type === "assistant.message"
        ? { ...timing, data: { ...timing.data, wireOriginalModel: retainInteractionModelMetadata(event) } } : timing;
}

// Same approved source, window and collector byte budget; this checkpoint contains metadata only.
export async function qualifyRetainedResponseTimings(config, source, records, previous, budget, since) {
    return qualifyRetainedMetadata(config, source, records, previous, budget, since, false);
}

export async function qualifyRetainedInteractionModels(config, source, records, previous, budget, since) {
    return qualifyRetainedMetadata(config, source, records, previous, budget, since, true);
}

async function qualifyRetainedMetadata(config, source, records, previous, budget, since, models) {
    if (!config?.approved || !source?.eligible || !/^[a-f0-9-]{36}$/i.test(source.sessionId)) {
        throw new TypeError("Response timing requires an approved eligible source.");
    }
    const targets = records.filter(record => record.sourceSessionId === source.sessionId && !record.assessmentMembershipPruned
        && record.userPrompt?.sourceEventId && Number.isFinite(Date.parse(record.userPrompt.sourceTimestamp))
        && record.userPrompt.sourceTimestamp >= since && record.userPrompt.sourceTimestamp <= new Date().toISOString())
        .map(record => ({ sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp }));
    const unique = [...new Map(targets.map(prompt => [prompt.sourceEventId, prompt])).values()];
    const version = models ? 2 : 1, field = models ? "models" : "timings";
    const signature = hash(JSON.stringify(unique));
    if (!unique.length) return { bytesRead: 0, checkpoint: { version, signature, status: "complete", [field]: {} } };
    const state = previous?.version === version && previous.signature === signature ? structuredClone(previous)
        : { version, signature, status: "pending", cursor: null, context: [], [field]: {},
            ...(models ? { until: new Date().toISOString() } : {}) };
    if (state.status === "complete") return { bytesRead: 0, checkpoint: state };
    const targetPrompt = event => event?.type === "user.message" && unique.some(prompt =>
        event.id === prompt.sourceEventId && event.timestamp === prompt.sourceTimestamp);
    const messageIds = new Set(state.context.filter(targetPrompt).map(event => event.data.messageId).filter(id => typeof id === "string"));
    let selectedInterval = targetPrompt(state.context.findLast(event => event.type === "user.message"));
    let bytesRead = 0;
    const finish = () => {
        if (models) {
            for (const prompt of unique) {
                const record = records.find(record => record.sourceSessionId === source.sessionId
                    && record.userPrompt?.sourceEventId === prompt.sourceEventId);
                const matched = state.context.some(event => event.type === "user.message"
                    && event.id === prompt.sourceEventId && event.timestamp === prompt.sourceTimestamp);
                state.models[prompt.sourceEventId] = matched ? recordedInteractionModels(state.context, record) ?? null : null;
            }
            state.context = [];
            return;
        }
        if (!state.context.length) return;
        const prompt = unique.find(value => value.sourceEventId === state.context[0].id);
        if (prompt) state.timings[prompt.sourceEventId] = recordedResponseTiming(state.context, prompt);
        state.context = [];
    };
    const failModels = reason => {
        state.context = []; state.models = {}; state.reason = reason; state.status = "complete";
    };
    while (budget - bytesRead >= overhead + TAIL_LIMITS.chunkBytes) {
        const tail = await readTail(path.join(config.sessionRoot, source.sessionId, "events.jsonl"), source.sessionId, state.cursor);
        bytesRead += tail.bytesRead + overhead;
        if (tail.reset) {
            if (models) { failModels("source-changed"); break; }
            state.context = []; state.timings = {};
        }
        state.cursor = tail.cursor;
        if (tail.cursor.malformedLines || tail.cursor.oversizedLines) {
            if (models) { failModels("source-lines-skipped"); break; }
            state.context = []; state.status = "complete";
            state.timings = Object.fromEntries(unique.map(prompt => [prompt.sourceEventId,
                { schemaVersion: 1, status: "unavailable", reason: "source-lines-skipped" }]));
            break;
        }
        for (const original of tail.events) {
            if (models && (!original || typeof original !== "object" || Array.isArray(original)
                || typeof original.id !== "string" || !original.id || typeof original.type !== "string"
                || !Number.isFinite(Date.parse(original.timestamp)))) {
                failModels("source-lines-skipped"); break;
            }
            if (models && (original.timestamp < since || original.timestamp > state.until)) continue;
            if (models && original.type === "user.message") {
                selectedInterval = targetPrompt(original);
                if (selectedInterval && typeof original.data?.messageId === "string") {
                    if (state.context.some(event => event.type === "assistant.message"
                        && event.data?.originatingMessageId === original.data.messageId && !event.data.wireOriginalModel)) {
                        failModels("response-before-prompt"); break;
                    }
                    messageIds.add(original.data.messageId);
                }
            }
            const ownedModel = models && original.type === "assistant.message" && messageIds.has(original.data?.originatingMessageId);
            let event = metadata(original, ownedModel);
            if (!event) continue;
            if (models) {
                if (!selectedInterval && !ownedModel) {
                    if (!["user.message", "assistant.message"].includes(event.type)) continue;
                    // Retain every response identity/owner guard, not unrelated model or timing payloads.
                    // A later duplicate can still contradict a selected response regardless of its position.
                    if (event.type === "assistant.message") event = { ...event, data: {
                        ...(event.data.originatingMessageId !== undefined ? { originatingMessageId: event.data.originatingMessageId } : {}),
                        ...(event.data.parentToolCallId !== undefined ? { parentToolCallId: event.data.parentToolCallId } : {}),
                    } };
                }
                // Consecutive identical metadata adds no evidence; every differing delivery still reaches conflict checks.
                if (JSON.stringify(state.context.at(-1)) === JSON.stringify(event)) continue;
                state.context.push(event);
                if (state.context.length > TAIL_LIMITS.maxContextEvents
                    || Buffer.byteLength(JSON.stringify(state.context)) > TAIL_LIMITS.maxContextBytes) {
                    failModels("model-context-limit"); break;
                }
                continue;
            }
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
        if (models && state.reason) break;
        if (state.cursor.backlogBytes <= state.cursor.partialBytes) {
            if (models && (state.cursor.partialBytes || state.cursor.droppedBytes)) {
                failModels("source-window-incomplete"); break;
            }
            finish();
            state.status = "complete";
            if (!models) for (const prompt of unique) state.timings[prompt.sourceEventId] ??= { schemaVersion: 1, status: "unavailable", reason: "prompt-not-in-bounded-window" };
            break;
        }
    }
    return { bytesRead, checkpoint: state };
}
