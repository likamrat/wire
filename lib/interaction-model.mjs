import { recordedResponseTiming } from "./response-timing.mjs";
import { findTextFindings } from "./privacy-text.mjs";

const safeText = value => typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
    && !findTextFindings(value).some(finding => finding.mandatory);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const sameResponse = (left, right) => ["eventId", "apiCallId", "at", "turnId", "model", "modelStatus"].every(key => left[key] === right[key]);
function validEvidence(value) {
    return value?.version === 1 && safeText(value.sourceSessionId) && safeText(value.promptEventId)
        && (value.promptMessageId === null || safeText(value.promptMessageId))
        && typeof value.partial === "boolean" && typeof value.ambiguous === "boolean"
        && ["unlinked", "truncated", "conflict", "invalid"].every(key => value[key] === undefined || typeof value[key] === "boolean")
        && Array.isArray(value.responses) && value.responses.length <= 256
        && (!value.responses.length || safeText(value.promptMessageId))
        && value.responses.every(response => safeText(response?.eventId)
            && (response.apiCallId === null || safeText(response.apiCallId))
            && (response.turnId === null || safeText(response.turnId))
            && (response.at === null || instant(response.at))
            && ["recorded", "missing", "excluded"].includes(response.modelStatus)
            && (response.modelStatus === "recorded" ? safeText(response.model) : response.model === null));
}

function invalidEvidence(scope) {
    return { version: 1, sourceSessionId: scope?.sourceSessionId ?? null, promptEventId: scope?.promptEventId ?? null,
        promptMessageId: null, responses: [], partial: true, ambiguous: true, invalid: true };
}

export function retainInteractionModelMetadata(event) {
    const data = event.data ?? {};
    const model = safeText(data.model) ? data.model : null;
    return { version: 1, model, modelStatus: model ? "recorded" : data.model == null ? "missing" : "excluded",
        originatingMessageId: safeText(data.originatingMessageId) ? data.originatingMessageId : null,
        apiCallId: safeText(data.apiCallId) ? data.apiCallId : null };
}

// Only old retained timing projections may recover omitted fields from already-qualified evidence.
// Raw incoming events must pass through retention instead, including explicit missing models.
export function restoreRetainedInteractionModelMetadata(events, records, sourceSessionId) {
    const known = new Map();
    for (const record of records) {
        const evidence = record.originalModelEvidence;
        if (record.sourceSessionId !== sourceSessionId || record.assessmentMembershipPruned
            || !["recorded", "partial"].includes(interactionModelFact(record).status)) continue;
        for (const response of evidence.responses) {
            const entry = { response, messageId: evidence.promptMessageId }, previous = known.get(response.eventId);
            known.set(response.eventId, !known.has(response.eventId) ? entry
                : previous && previous.messageId === entry.messageId && sameResponse(previous.response, response) ? previous : null);
        }
    }
    return events.map(event => {
        const data = event.data, entry = known.get(event.id);
        if (!entry || event.type !== "assistant.message" || event.agentId || data?.parentToolCallId
            || data?.wireResponseMetadataVersion !== 1
            || ["wireOriginalModel", "model", "apiCallId"].some(key => Object.hasOwn(data, key))
            || data.originatingMessageId !== entry.messageId || event.timestamp !== entry.response.at
            || (data.turnId ?? null) !== entry.response.turnId) return event;
        return { ...event, data: { ...data, wireOriginalModel: {
            version: 1, model: entry.response.model, modelStatus: entry.response.modelStatus,
            originatingMessageId: entry.messageId, apiCallId: entry.response.apiCallId,
        } } };
    });
}

function responseMetadata(event) {
    const retained = event.data?.wireOriginalModel;
    if (!retained) return retainInteractionModelMetadata(event);
    if (retained.version !== 1 || !["recorded", "missing", "excluded"].includes(retained.modelStatus)
        || (retained.modelStatus === "recorded" ? !safeText(retained.model) : retained.model !== null)) {
        return { ...retainInteractionModelMetadata(event), model: null, modelStatus: "excluded" };
    }
    const normalized = retainInteractionModelMetadata({ data: retained });
    return { ...normalized, modelStatus: retained.modelStatus === "excluded" ? "excluded" : normalized.modelStatus };
}

export function mergeInteractionModelEvidence(prior, next) {
    if (prior && (!validEvidence(prior) || prior.invalid) || next && (!validEvidence(next) || next.invalid)) {
        return invalidEvidence(next ?? prior);
    }
    if (!prior) return next;
    if (!next) return prior;
    if (prior.sourceSessionId !== next.sourceSessionId || prior.promptEventId !== next.promptEventId
        || prior.promptMessageId && next.promptMessageId && prior.promptMessageId !== next.promptMessageId) {
        return { ...prior, ambiguous: true };
    }
    const responses = new Map(), requests = new Map();
    let conflict = prior.conflict === true || next.conflict === true;
    for (const response of [...prior.responses, ...next.responses]) {
        const previous = responses.get(response.eventId);
        if (previous && !sameResponse(previous, response)) conflict = true;
        if (!previous) responses.set(response.eventId, response);
        if (response.apiCallId && response.model) {
            const model = requests.get(response.apiCallId);
            if (model && model !== response.model) conflict = true;
            requests.set(response.apiCallId, response.model);
        }
    }
    return { ...next, promptMessageId: next.promptMessageId ?? prior.promptMessageId,
        ambiguous: prior.ambiguous || next.ambiguous, conflict,
        unlinked: prior.unlinked || next.unlinked || false,
        truncated: prior.truncated || next.truncated || responses.size > 256,
        responses: [...responses.values()].slice(0, 256) };
}

export function recordedInteractionModels(events, record, { partialWindow = false } = {}) {
    // Raw manual histories can contain non-event JSON; retain duplicate deliveries for conflict checks.
    const rows = events.filter(event => event && typeof event === "object" && !Array.isArray(event)
        && typeof event.id === "string" && event.id && typeof event.type === "string");
    partialWindow ||= rows.length !== events.length;
    events = rows;
    const prior = record.originalModelEvidence;
    if (!safeText(record.sourceSessionId) || !safeText(record.userPrompt?.sourceEventId)) return undefined;
    if (prior && (!validEvidence(prior) || prior.sourceSessionId !== record.sourceSessionId
        || prior.promptEventId !== record.userPrompt.sourceEventId)) {
        return invalidEvidence({ sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId });
    }
    const prompt = events.find(event => event.type === "user.message" && event.id === record.userPrompt?.sourceEventId
        && event.timestamp === record.userPrompt?.sourceTimestamp);
    const messageId = safeText(prompt?.data?.messageId) ? prompt.data.messageId : prior?.promptMessageId ?? null;
    if (!messageId && !prior) return undefined;
    let ambiguous = Boolean(messageId && events.some(event => event.type === "user.message"
        && (event.id !== record.userPrompt.sourceEventId && event.data?.messageId === messageId
            || event.id === record.userPrompt.sourceEventId && event.data?.messageId !== messageId)));
    const start = prompt ? events.indexOf(prompt) : -1;
    const following = events.findIndex((event, index) => index > start && event.type === "user.message");
    const unlinked = start >= 0 && events.slice(start + 1, following < 0 ? events.length : following)
        .some(event => event.type === "assistant.message" && !event.agentId && !event.data?.parentToolCallId
            && !responseMetadata(event).originatingMessageId);
    const responses = events.filter(event => event.type === "assistant.message" && !event.agentId && !event.data?.parentToolCallId
        && safeText(event.id) && !ambiguous && messageId && responseMetadata(event).originatingMessageId === messageId).map(event => {
        const data = responseMetadata(event);
        return { eventId: event.id, apiCallId: data.apiCallId, at: instant(event.timestamp) ? event.timestamp : null,
            turnId: safeText(event.data?.turnId) ? event.data.turnId : null,
            model: data.model, modelStatus: data.modelStatus };
    });
    const ownedIds = new Set([...prior?.responses ?? [], ...responses].map(response => response.eventId));
    const conflict = events.some(event => event.type === "assistant.message" && ownedIds.has(event.id)
        && (event.agentId || event.data?.parentToolCallId || responseMetadata(event).originatingMessageId !== messageId));
    ambiguous ||= responses.some(response => instant(response.at) && instant(record.userPrompt.sourceTimestamp)
        && Date.parse(response.at) < Date.parse(record.userPrompt.sourceTimestamp));
    if (prior && !prompt && !ambiguous && !unlinked && !conflict && !partialWindow && responses.every(response =>
        prior.responses.some(previous => sameResponse(previous, response)))) return prior;
    const next = {
        version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt?.sourceEventId,
        promptMessageId: messageId, ambiguous, unlinked, conflict,
        responses: responses.slice(0, 256), truncated: partialWindow || responses.length > 256,
        partial: recordedResponseTiming(events, record.userPrompt).status !== "measured",
    };
    return mergeInteractionModelEvidence(prior ?? { ...next, responses: [] }, next);
}

export function interactionModelFact(record) {
    const retained = record.originalModelEvidence;
    const evidence = retained && validEvidence(retained)
        ? mergeInteractionModelEvidence({ ...retained, responses: [] }, retained) : retained;
    if (evidence && (!validEvidence(evidence) || evidence.invalid)) {
        return { label: "Model", value: "Not verified (invalid model metadata)", status: "unverified" };
    }
    if (evidence && (evidence.sourceSessionId !== record.sourceSessionId
        || evidence.promptEventId !== record.userPrompt?.sourceEventId || evidence.ambiguous)) {
        return { label: "Model", value: "Not verified (interaction link unavailable)", status: "unverified" };
    }
    if (evidence?.conflict) return { label: "Model", value: "Conflicting records", status: "conflicting" };
    const responses = (evidence?.responses ?? []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const known = responses.filter(response => response.model);
    const unordered = known.some((response, index) => known.slice(0, index).some(previous => previous.model !== response.model
        && (!response.turnId || !previous.turnId || response.turnId === previous.turnId
            || !Number.isFinite(Date.parse(response.at)) || !Number.isFinite(Date.parse(previous.at))
            || Date.parse(response.at) === Date.parse(previous.at))));
    const models = responses
        .map(response => response.model).filter((model, index, values) => model && model !== values[index - 1]);
    const missing = evidence?.unlinked || evidence?.responses.some(response => !response.model);
    const suffix = missing ? " (some response models missing)" : evidence?.partial || evidence?.truncated ? " (partial record)" : "";
    if (!models.length && record.toolCalls?.some(call => safeText(call.model))) {
        return { label: "Model", value: "Not verified (tool metadata only)", status: "unverified" };
    }
    if (!models.length && evidence?.responses.some(response => response.modelStatus === "excluded")) {
        return { label: "Model", value: "Not recorded (excluded metadata)", status: "unavailable" };
    }
    const value = unordered ? [...new Set(models)].join(", ") + " (order not recorded)" : models.join(" then ");
    return { label: new Set(models).size > 1 ? "Models" : "Model",
        value: models.length ? value + suffix : "Not recorded",
        status: models.length ? suffix ? "partial" : "recorded" : "unavailable" };
}

export function projectInteractionModels(records) {
    const key = record => JSON.stringify([record.sourceSessionId, record.userPrompt?.sourceEventId ?? record.scenarioId]);
    const groups = new Map();
    for (const record of records) {
        const id = key(record), prior = groups.get(id);
        groups.set(id, prior ? { ...prior,
            originalModelEvidence: mergeInteractionModelEvidence(prior.originalModelEvidence, record.originalModelEvidence),
            toolCalls: [...prior.toolCalls ?? [], ...record.toolCalls ?? []],
        } : record);
    }
    const facts = new Map([...groups].map(([id, record]) => [id, interactionModelFact(record)]));
    return records.map(record => {
        const { originalModelEvidence, ...visible } = record;
        return { ...visible, originalModel: facts.get(key(record)) };
    });
}
