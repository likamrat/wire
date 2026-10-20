const gapReasons = new Set(["malformed-line", "oversized-line", "initial-window", "context-evicted", "credential-excluded", "unavailable"]);
const idValue = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);

export function validEventEnvelope(event) {
    return event && !Array.isArray(event) && typeof event.id === "string" && event.id
        && typeof event.type === "string" && typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp));
}

export function retainedToolRequestIds(event) {
    const requests = event.data?.toolRequests;
    return Array.isArray(requests) && requests.length <= 256
        && requests.every(request => idValue(request?.toolCallId))
        ? [...new Set(requests.map(request => request.toolCallId))] : [];
}

export function createPromptLinks(events) {
    const messages = new Map(), requests = new Map();
    for (const event of events) {
        const data = event.data ?? {};
        if (event.type === "user.message" && idValue(data.messageId)) {
            if (!messages.has(data.messageId)) messages.set(data.messageId, []);
            messages.get(data.messageId).push(event);
        }
        if (event.type !== "assistant.message") continue;
        const ids = data.wireToolRequestIds ?? retainedToolRequestIds(event);
        for (const id of Array.isArray(ids) ? ids.filter(idValue) : []) {
            if (!requests.has(id)) requests.set(id, []);
            requests.get(id).push(event);
        }
    }
    return (call, preceding) => {
        const all = requests.get(call.data?.toolCallId) ?? [];
        const candidates = all.filter(response => idValue(response.data?.originatingMessageId));
        if (!candidates.length) return null;
        const linked = candidates.map(response => {
            const data = response.data ?? {}, origins = messages.get(data.originatingMessageId);
            if (!origins?.length || response.agentId || data.parentToolCallId || call.agentId || call.data?.parentToolCallId) return { reason: "unlinked" };
            if (origins.length !== 1) return { reason: "ambiguous-link" };
            const prompt = origins[0];
            if (!(Date.parse(prompt.timestamp) <= Date.parse(response.timestamp)
                && Date.parse(response.timestamp) <= Date.parse(call.timestamp))) return { reason: "ambiguous-link" };
            if (!idValue(data.turnId) || !idValue(call.data?.turnId) || candidates.length !== all.length) {
                return prompt.id === preceding?.id ? { event: prompt, method: "recorded-order" } : { reason: "unlinked" };
            }
            return data.turnId === call.data.turnId ? { event: prompt, method: "explicit-message" } : { reason: "ambiguous-link" };
        });
        const reason = linked.some(link => link.reason === "ambiguous-link") ? "ambiguous-link"
            : linked.some(link => link.reason) ? "unlinked"
                : linked.some(link => link.event.id !== linked[0].event.id) ? "ambiguous-link" : null;
        return reason ? { reason, method: "unavailable" } : { event: linked[0].event,
            method: linked.every(link => link.method === "explicit-message") ? "explicit-message" : "recorded-order" };
    };
}

export function canLinkMissingPrompt(prior, next) {
    if (prior.sourceSessionId !== next.sourceSessionId || prior.userPrompt?.sourceEventId
        || prior.userPrompt?.text !== null || prior.userPrompt.capture?.version !== 1
        || prior.userPrompt.capture.reason === "ambiguous-link"
        || prior.userPrompt.capture.original !== "unavailable" || !next.userPrompt?.sourceEventId
        || next.promptAssociationEvidence?.method !== "explicit-message") return false;
    const fields = ["toolCalls", "graphActivities"];
    return fields.some(field => prior[field]?.length) && fields.every(field => (prior[field] ?? []).every(item =>
        next[field]?.some(update => field === "toolCalls" ? item.toolCallId && item.startEventId
            && item.toolCallId === update.toolCallId && item.startEventId === update.startEventId
            : item.activityId && item.activityId === update.activityId)));
}

// Existing call identities own their groups. Evicted context must not create a second origin for a saved call.
export function alignPromptUpdates(current, updates) {
    const units = new Map(), origins = new Map();
    const key = (record, field, item) => JSON.stringify([record.sourceSessionId, field,
        field === "toolCalls" ? [item.toolCallId, item.startEventId] : item.activityId]);
    const origin = record => JSON.stringify([record.sourceSessionId, record.userPrompt?.sourceEventId]);
    const add = (map, key, record) => map.set(key, map.has(key) && map.get(key) !== record ? null : record);
    for (const record of current.filter(record => record.workloadKind === "recorded-history" && !record.isLegacy)) {
        if (record.userPrompt?.sourceEventId) add(origins, origin(record), record);
        for (const field of ["toolCalls", "graphActivities"]) for (const item of record[field] ?? []) add(units, key(record, field, item), record);
    }
    return updates.flatMap(next => {
        const buckets = new Map();
        const owners = new Set(["toolCalls", "graphActivities"].flatMap(field =>
            (next[field] ?? []).map(item => units.get(key(next, field, item))).filter(Boolean)));
        const owner = owners.size === 1 ? [...owners][0] : null;
        const groupOwner = owner && (owner.userPrompt?.sourceEventId === next.userPrompt?.sourceEventId
            || canLinkMissingPrompt(owner, next)) ? owner : null;
        for (const field of ["toolCalls", "graphActivities"]) for (const item of next[field] ?? []) {
            const identity = key(next, field, item);
            if (units.has(identity) && !units.get(identity)) continue;
            const prior = units.get(identity) ?? (next.userPrompt?.sourceEventId ? origins.get(origin(next)) : null) ?? groupOwner;
            const id = prior?.scenarioId ?? next.scenarioId;
            if (!buckets.has(id)) buckets.set(id, { prior, update: { ...next, scenarioId: id, toolCalls: [],
                ...(next.graphActivities ? { graphActivities: [] } : {}) } });
            buckets.get(id).update[field].push(field === "graphActivities" ? { ...item, scenarioId: id } : item);
        }
        return [...buckets.values()].map(({ prior, update }) => {
            if (!prior || prior.userPrompt?.sourceEventId === update.userPrompt?.sourceEventId || canLinkMissingPrompt(prior, update)) return update;
            const conflictingLink = prior.userPrompt?.capture && (update.promptAssociationEvidence?.method === "explicit-message"
                || update.userPrompt?.capture?.reason === "ambiguous-link");
            return { ...update, userPrompt: conflictingLink ? { ...prior.userPrompt,
                capture: { ...prior.userPrompt.capture, reason: "ambiguous-link" } } : prior.userPrompt, followUpPrompts: prior.followUpPrompts,
                promptAssociationEvidence: prior.promptAssociationEvidence,
                originalModelEvidence: prior.originalModelEvidence, responseTiming: prior.responseTiming };
        });
    });
}

export function historyGap(id, reason, offset = 0) {
    if (!gapReasons.has(reason) || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Invalid history gap.");
    return { id, type: "wire.history_gap", data: { reason, offset } };
}

export function isHistoryGap(event) {
    return event?.type === "wire.history_gap" && typeof event.id === "string" && event.id.startsWith("wire-gap-")
        && gapReasons.has(event.data?.reason) && Number.isSafeInteger(event.data.offset) && event.data.offset >= 0;
}

export function unavailablePrompt(reason = "unlinked", gap) {
    return {
        text: null, status: "unavailable", provenance: "unavailable",
        authorship: { actor: "unknown", basis: "missing-source" },
        capture: { version: 1, kind: "unknown", original: "unavailable", hostContext: "unknown", reason },
        ...(gap ? { gapId: gap.id } : {}),
    };
}
