import { findTextFindings } from "./privacy-text.mjs";
import { createHash } from "node:crypto";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
    && !findTextFindings(value).some(item => item.mandatory);
const count = n => Number.isSafeInteger(n) && n >= 0;
const originDigest = data => safeId(data?.interactionId) ? createHash("sha256").update("usage-origin:" + data.interactionId).digest("hex") : null;

// Only the per-request journal receipt. Checkpoints and shutdown model metrics
// subsume earlier calls; ephemeral observer events are not a second data source.
export function retainUsageReceipt(event) {
    if (event.type !== "session.usage_record" || event.checkpoint || event.ephemeral) return null;
    const u = event.data?.usage, accounting = u?.accounting;
    if (!u || !safeId(u.apiCallId) && !safeId(accounting?.usageId) && !originDigest(u)) return null;
    const read = u.cacheReadTokens ?? null, write = u.cacheWriteTokens ?? null;
    // A main-loop follow-up after a tool result can be agent-initiated. Neither
    // initiator label establishes ownership; retainedUsage checks the explicit links.
    const valid = !event.agentId && !event.data.parentToolCallId && !u.parentToolCallId && !u.fusion
        && (u.initiator === undefined || u.initiator === "user" || u.initiator === "agent")
        && (u.interactionType === undefined || ["conversation-user","conversation-agent"].includes(u.interactionType))
        && safeId(u.model) && (!u.copilotUsage?.model || u.model === u.copilotUsage.model)
        && [u.inputTokens, u.outputTokens].every(count) && [read, write].every(n => n === null || count(n))
        && count(u.inputTokens - (read ?? 0) - (write ?? 0)) && count(u.inputTokens + u.outputTokens)
        && (!accounting || safeId(accounting.usageId) && (accounting.sourceSessionId === undefined || safeId(accounting.sourceSessionId))
            && (accounting.sequence === undefined || count(accounting.sequence)));
    return { id: event.id, type: event.type, timestamp: event.timestamp, data: {
        apiCallId: safeId(u.apiCallId) ? u.apiCallId : safeId(accounting?.usageId) ? accounting.usageId : null, origin: originDigest(u),
        accounting: accounting && valid ? { source: accounting.sourceSessionId ?? null, id: accounting.usageId, seq: accounting.sequence ?? null } : null,
        model: valid ? u.model : null, tokens: valid ? { ...(read === null || write === null ? { input: u.inputTokens } : {}),
            freshInput: read === null || write === null ? null : u.inputTokens - read - write,
            cacheRead: read, cacheWrite: write, output: u.outputTokens } : null,
    } };
}

export function retainUsageBoundary(event) {
    const d = event.data, range = d?.eventRange;
    if (event.agentId || event.checkpoint || event.ephemeral || d?.schemaVersion !== 1
        || !safeId(range?.startEventId) || !safeId(range.endEventId) || d.sourceEventId !== range.endEventId
        || !["natural", "terminal_tool", "agent_stop_block_limit"].includes(d.stopReason)) return null;
    return { id: event.id, type: event.type, timestamp: event.timestamp, data: { start: range.startEventId, end: range.endEventId } };
}

// The run ID and the originating-message ID are independent explicit claims.
// The exchange boundary establishes completeness, not membership by proximity.
export function retainedUsage(events, record, partialWindow, unavailable = () => null) {
    if (partialWindow || record.assessmentMembershipPruned) return unavailable("outside-read-window");
    const prompt = events.find(e => e.type === "user.message" && e.id === record.userPrompt?.sourceEventId
        && e.timestamp === record.userPrompt.sourceTimestamp);
    if (!prompt || prompt.data.wirePromptCapture?.conflict || prompt.data.wireUsageExcluded
        || ["credential-excluded","unsupported-content"].includes(prompt.data.wirePromptCapture?.reason)) return unavailable("outside-read-window");
    const origin = prompt.data.wireUsageOrigin, message = prompt.data.messageId;
    if (!origin && !safeId(message)) return unavailable("interaction-link-or-boundary");
    const start = events.indexOf(prompt);
    if (events.some(e => e.type === "user.message" && e !== prompt && (e.id === prompt.id || origin && e.data.wireUsageOrigin === origin
        || message && e.data.messageId === message))) return unavailable("conflicting-link");
    const own = e => Boolean(origin && e.data.wireUsageOrigin === origin || message && e.data.originatingMessageId === message);
    const rival = e => Boolean(origin && e.data.wireUsageOrigin && e.data.wireUsageOrigin !== origin
        || message && e.data.originatingMessageId && e.data.originatingMessageId !== message);
    const closures = events.filter(e => e.type === "session.completion_receipt" && e.data.start === prompt.id);
    const responses = events.filter(e => e.type === "assistant.message" && own(e));
    let end;
    if (closures.length) {
        const endId = closures[0].data.end;
        end = events.findIndex(e => e.id === endId && e.type === "assistant.turn_end");
        if (closures.some(e => e.data.end !== endId || events.indexOf(e) <= end)
            || events.some(e => e.type === "session.completion_receipt" && e.data.end === endId && e.data.start !== prompt.id)) return unavailable("conflicting-link");
    } else {
        const final = responses.at(-1);
        if (!final?.data.finalAnswer || final.data.hasToolRequests || !safeId(final.data.turnId)) return unavailable("interaction-link-or-boundary");
        end = events.findIndex((e,i) => i > events.indexOf(final) && e.type === "assistant.turn_end" && e.data.turnId === final.data.turnId);
    }
    if (end <= start || !responses.length) return unavailable("interaction-link-or-boundary");
    const boundary = events[end];
    if (boundary.data.wireUsageExcluded || events.some((e,i) => e.id === boundary.id && i !== end
        && (e.type !== boundary.type || e.data.turnId !== boundary.data.turnId || e.agentId !== boundary.agentId))) return unavailable("conflicting-link");
    const window = events.slice(start + 1, end + 1), windowEvents = new Set(window);
    if (window.some(e => e.agentId || e.data.parentToolCallId || e.data.wireUsageExcluded || e.type === "subagent.started" || e.type === "wire.history_gap"
        || e.type === "user.message")) return unavailable("incomplete-or-nested");
    if (responses.some(e => !windowEvents.has(e) || rival(e))) return unavailable("conflicting-link");
    const expected = new Map(), toolRequests = new Set(), responseEvents = new Map();
    for (const e of responses) {
        const { apiCallId, model } = e.data.wireOriginalModel ?? {};
        if (!apiCallId || expected.get(apiCallId) && model && expected.get(apiCallId) !== model
            || responseEvents.has(e.id) && responseEvents.get(e.id) !== apiCallId) return unavailable("unverified-model-call");
        responseEvents.set(e.id, apiCallId);
        expected.set(apiCallId, model ?? expected.get(apiCallId) ?? null);
        for (const id of e.data.wireToolRequestIds ?? []) toolRequests.add(id);
    }
    if (window.some(e => e.type === "assistant.message" && !own(e))
        || events.some(e => responseEvents.has(e.id) && (e.type !== "assistant.message" || !own(e)))) return unavailable("conflicting-link");
    const nextPrompt = events.findIndex((e,i) => i > end && e.type === "user.message");
    if (events.slice(end + 1, nextPrompt < 0 ? undefined : nextPrompt).some(e => ["assistant.turn_start","tool.execution_start","subagent.started"].includes(e.type)
        || e.type === "assistant.message")) return unavailable("incomplete-or-nested");
    const starts = new Map(window.filter(e => e.type === "tool.execution_start").map(e => [e.id, e.data.toolCallId]));
    if (!record.toolCalls?.some(c => starts.get(c.startEventId) === c.toolCallId
        && (c.promptLink?.promptEventId === prompt.id || toolRequests.has(c.toolCallId)))
        || events.some(e => e.type === "assistant.message" && !own(e) && e.data.wireToolRequestIds?.some(id => toolRequests.has(id))))
        return unavailable("interaction-link-or-boundary");
    const found = new Map(), ids = new Map(), sequences = new Map(), eventIds = new Map();
    const relatedIds = new Set([...expected.keys(), ...events.filter(e => e.type === "session.usage_record" && origin && e.data.origin === origin)
        .map(e => e.data.apiCallId)]);
    for (const e of events) {
        if (e.type === "assistant.message") {
            const m = e.data.wireOriginalModel;
            if (relatedIds.has(m?.apiCallId) && (!own(e) || rival(e) || e.agentId || e.data.parentToolCallId)) return unavailable("conflicting-link");
        }
        if (e.type !== "session.usage_record") continue;
        const r = e.data;
        const related = relatedIds.has(r.apiCallId);
        for (const [index, key] of [[eventIds,e.id],[ids, r.accounting?.id], [sequences, r.accounting?.seq]]) {
            if (key == null) continue;
            if (index.has(key) && index.get(key) !== r.apiCallId && (related || relatedIds.has(index.get(key)))) return unavailable("conflicting-receipt");
            index.set(key, r.apiCallId);
        }
        if (!related) {
            if (windowEvents.has(e) && (!origin || !r.origin)) return unavailable("conflicting-link");
            continue;
        }
        if (!r.tokens || !r.apiCallId || Date.parse(e.timestamp) < Date.parse(prompt.timestamp)
            || expected.get(r.apiCallId) && r.model !== expected.get(r.apiCallId)
            || r.accounting?.source && r.accounting.source !== record.sourceSessionId
            || r.origin && origin && r.origin !== origin) return unavailable("invalid-receipt");
        const prior = found.get(r.apiCallId);
        if (prior && (JSON.stringify(prior.data) !== JSON.stringify(r) || e.id === prior.id && e.timestamp !== prior.timestamp)) return unavailable("conflicting-receipt");
        if (!prior) found.set(r.apiCallId, e);
    }
    if ([...expected.keys()].some(id => !found.has(id))) return unavailable(found.size ? "partial-receipts" : "no-linked-receipt");
    // This link identifies a request's tool start, not the author of the prompt.
    const requestedBy = new Map(), startsByCall = Map.groupBy(window.filter(e => e.type === "tool.execution_start"), e => e.data.toolCallId);
    for (const response of responses) for (const id of response.data.wireToolRequestIds ?? []) {
        const api = response.data.wireOriginalModel?.apiCallId;
        requestedBy.set(id, requestedBy.has(id) && requestedBy.get(id) !== api ? null : api);
    }
    const linked = new Map();
    for (const call of record.toolCalls ?? []) {
        const api = requestedBy.get(call.toolCallId), matches = startsByCall.get(call.toolCallId);
        if (!api || !call.startEventId || matches?.length !== 1 || matches[0].id !== call.startEventId) continue;
        if (!linked.has(api)) linked.set(api, []);
        linked.get(api).push(call.startEventId);
    }
    return [...found.values()].map(e => ({ receiptId: e.id, apiCallId: e.data.apiCallId,
        origin: e.data.origin, at: e.timestamp, model: e.data.model, tokens: e.data.tokens,
        ...(linked.has(e.data.apiCallId) ? { linkedToolStarts:linked.get(e.data.apiCallId) } : {}) })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export const retainedInteractionId = data => safeId(data?.interactionId) ? { wireUsageOrigin: originDigest(data) } : {};

// Older prompts can age out of the bounded tail. Keep their committed facts
// unless new evidence actually contests or extends their membership.
export function revisitsUsage(incoming, record) {
    if (!record.usageCalls?.length) return false;
    const apis = new Map(record.usageCalls.map(call => [call.apiCallId, call]));
    const origins = new Set(record.usageCalls.map(call => call.origin).filter(Boolean));
    return incoming.some(e => {
        if (e.type === "user.message") return e.id === record.userPrompt?.sourceEventId || origins.has(e.data.wireUsageOrigin)
            || e.data.messageId && e.data.messageId === record.originalModelEvidence?.promptMessageId;
        if (e.type === "session.completion_receipt") return e.data.start === record.userPrompt?.sourceEventId;
        if (e.type === "assistant.message") {
            const m = e.data.wireOriginalModel;
            return apis.has(m?.apiCallId) || origins.has(e.data.wireUsageOrigin)
                || m?.originatingMessageId && m.originatingMessageId === record.originalModelEvidence?.promptMessageId;
        }

        if (e.type !== "session.usage_record") return false;
        const prior = apis.get(e.data.apiCallId);
        return prior ? prior.model !== e.data.model || prior.origin !== e.data.origin || JSON.stringify(prior.tokens) !== JSON.stringify(e.data.tokens)
            : origins.has(e.data.origin);
    });
}

export function retainedReceiptContext(events, records, sourceSessionId) {
    const messages = new Set(), apiCalls = new Set(), origins = new Set(), promptIds = new Set();
    for (const record of records) if (record.sourceSessionId === sourceSessionId && !record.assessmentMembershipPruned && record.toolCalls?.length) {
        const model = record.originalModelEvidence;
        if (record.userPrompt?.sourceEventId) promptIds.add(record.userPrompt.sourceEventId);
        if (model?.promptMessageId && !model.invalid && !model.ambiguous && !model.conflict) {
            messages.add(model.promptMessageId);
            for (const response of model.responses) if (response.apiCallId) apiCalls.add(response.apiCallId);
        }
    }
    for (const e of events) if (e.type === "user.message" && (messages.has(e.data.messageId) || promptIds.has(e.id)) && e.data.wireUsageOrigin) origins.add(e.data.wireUsageOrigin);
    return events.filter(e => e.type === "session.completion_receipt" ? promptIds.has(e.data.start)
        : e.type !== "session.usage_record" || apiCalls.has(e.data.apiCallId) || origins.has(e.data.origin));
}
