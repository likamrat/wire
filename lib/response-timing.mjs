const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const unavailable = reason => ({ schemaVersion: 1, status: "unavailable", reason });

export function retainResponseTimingEvent(event) {
    if (!event || !["assistant.message", "assistant.turn_start", "assistant.turn_end"].includes(event.type)
        || typeof event.id !== "string" || !instant(event.timestamp)) return null;
    const data = event.data ?? {};
    return {
        id: event.id, type: event.type, timestamp: event.timestamp,
        ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {}),
        data: {
            ...(typeof data.turnId === "string" ? { turnId: data.turnId } : {}),
            ...(typeof data.parentToolCallId === "string" ? { parentToolCallId: data.parentToolCallId } : {}),
            ...(event.type === "assistant.message" ? {
                wireResponseMetadataVersion: 1,
                hasResponseText: typeof data.content === "string" && data.content.length > 0,
                hasToolRequests: Array.isArray(data.toolRequests) && data.toolRequests.length > 0,
                finalAnswer: data.phase === "final_answer",
                ...(typeof data.originatingMessageId === "string" ? { originatingMessageId: data.originatingMessageId } : {}),
            } : {}),
        },
    };
}

export function recordedResponseTiming(events, prompt) {
    const unique = new Map();
    for (const event of events) {
        const previous = unique.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) return unavailable("conflicting-timing-events");
        if (!previous) unique.set(event.id, event);
    }
    events = [...unique.values()];
    const start = events.findIndex(event => event.type === "user.message" && event.id === prompt?.sourceEventId
        && event.timestamp === prompt.sourceTimestamp);
    if (start < 0) return unavailable("prompt-not-in-window");
    const next = events.findIndex((event, index) => index > start && event.type === "user.message");
    const end = next < 0 ? events.length : next;
    const user = events[start];
    let final, complete, invalidated = false;
    for (const event of events.slice(start + 1, end)) {
        if (event.agentId || event.data?.parentToolCallId) continue;
        if (!instant(event.timestamp) || Date.parse(event.timestamp) < Date.parse(user.timestamp)) return unavailable("invalid-response-timing");
        if (["tool.execution_start", "assistant.turn_start"].includes(event.type)) {
            invalidated ||= Boolean(complete);
            final = null; complete = null; continue;
        }
        if (event.type === "assistant.message") {
            invalidated ||= Boolean(complete);
            final = null; complete = null;
            const projected = event.data?.wireResponseMetadataVersion === 1 ? event : retainResponseTimingEvent(event);
            const data = projected?.data;
            if (data?.finalAnswer && data.hasResponseText && !data.hasToolRequests && typeof data.turnId === "string"
                && (!data.originatingMessageId || data.originatingMessageId === user.data?.messageId)) final = projected;
        } else if (event.type === "assistant.turn_end" && final && event.data?.turnId === final.data.turnId
            && instant(event.timestamp) && Date.parse(event.timestamp) >= Date.parse(final.timestamp)) complete = event;
    }
    if (!final || !complete || !instant(user.timestamp)) return unavailable(invalidated ? "later-work-after-final-response" : "final-response-not-established");
    const durationMs = Date.parse(final.timestamp) - Date.parse(user.timestamp);
    if (!Number.isFinite(durationMs) || durationMs < 0) return unavailable("invalid-response-timing");
    return {
        schemaVersion: 1, status: "measured", reason: null, durationMs,
        boundary: "recorded-request-to-final-answer", promptEventId: user.id,
        finalEventId: final.id, completionEventId: complete.id,
        requestedAt: user.timestamp, respondedAt: final.timestamp, completedAt: complete.timestamp,
        association: final.data.originatingMessageId ? "explicit-message-link" : "single-recorded-message-interval",
    };
}
