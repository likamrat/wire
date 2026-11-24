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
    const valid = !event.agentId && !u.parentToolCallId && !u.initiator && !u.fusion
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

export function retainedUsage(events, record, model, timing, unavailable = () => null) {
    if (!model || model.partial || model.truncated || model.ambiguous || model.conflict || model.unlinked || model.invalid
        || record.assessmentMembershipPruned || timing?.status !== "measured" || !model.responses.length
        || !record.toolCalls?.every(c => c.promptLink?.promptEventId === model.promptEventId)) return unavailable("interaction-link-or-boundary");
    const prompt = events.find(e => e.id === model.promptEventId && e.type === "user.message");
    const end = events.findIndex(e => e.type === "assistant.turn_end" && e.id === timing.completionEventId);
    if (!prompt || end <= events.indexOf(prompt) || !safeId(prompt.data.messageId) || model.promptMessageId !== prompt.data.messageId) return unavailable("outside-read-window");
    const window = events.slice(events.indexOf(prompt), end + 1);
    if (window.some(e => e.agentId || e.type === "subagent.started" || e.type === "wire.history_gap")) return unavailable("incomplete-or-nested");
    const origin = prompt.data.wireUsageOrigin;
    if (origin && events.some(e => e.type === "user.message" && e.id !== prompt.id && e.data.wireUsageOrigin === origin)) return unavailable("conflicting-link");
    const expected = new Map();
    for (const r of model.responses) {
        if (!r.apiCallId || !r.at || !r.model || r.modelStatus !== "recorded"
            || expected.has(r.apiCallId) && expected.get(r.apiCallId) !== r.model) return unavailable("unverified-model-call");
        expected.set(r.apiCallId, r.model);
    }
    if (!model.responses.some(r => r.eventId === timing.finalEventId)) return unavailable("interaction-link-or-boundary");
    const found = new Map(), ids = new Map(), sequences = new Map(), eventIds = new Map();
    const windowEvents = new Set(window);
    const relatedIds = new Set([...expected.keys(), ...events.filter(e => e.type === "session.usage_record" && origin && e.data.origin === origin)
        .map(e => e.data.apiCallId)]);
    for (const e of events) {
        if (e.type === "assistant.message") {
            const m = e.data.wireOriginalModel;
            if (relatedIds.has(m?.apiCallId) && (m.originatingMessageId !== model.promptMessageId || expected.has(m.apiCallId) && m.model !== expected.get(m.apiCallId)
                || e.agentId || e.data.parentToolCallId)) return unavailable("conflicting-link");
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
            || expected.has(r.apiCallId) && r.model !== expected.get(r.apiCallId)
            || r.accounting?.source && r.accounting.source !== record.sourceSessionId
            || r.origin && origin && r.origin !== origin) return unavailable("invalid-receipt");
        const prior = found.get(r.apiCallId);
        if (prior && (JSON.stringify(prior.data) !== JSON.stringify(r) || e.id === prior.id && e.timestamp !== prior.timestamp)) return unavailable("conflicting-receipt");
        if (!prior) found.set(r.apiCallId, e);
    }
    if ([...expected.keys()].some(id => !found.has(id))) return unavailable(found.size ? "partial-receipts" : "no-linked-receipt");
    return [...found.values()].map(e => ({ receiptId: e.id, apiCallId: e.data.apiCallId,
        origin: e.data.origin, at: e.timestamp, model: e.data.model, tokens: e.data.tokens })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export const retainedInteractionId = data => safeId(data?.interactionId) ? { wireUsageOrigin: originDigest(data) } : {};

// Older prompts can age out of the bounded tail. Keep their committed facts
// unless new evidence actually contests or extends their membership.
export function revisitsUsage(incoming, record) {
    if (!record.usageCalls?.length) return false;
    const apis = new Map(record.usageCalls.map(call => [call.apiCallId, call]));
    const origins = new Set(record.usageCalls.map(call => call.origin).filter(Boolean));
    return incoming.some(e => {
        if (e.type === "assistant.message") {
            const m = e.data.wireOriginalModel;
            return apis.has(m?.apiCallId) || m?.originatingMessageId === record.originalModelEvidence?.promptMessageId;
        }

        if (e.type !== "session.usage_record") return false;
        const prior = apis.get(e.data.apiCallId);
        return prior ? prior.model !== e.data.model || prior.origin !== e.data.origin || JSON.stringify(prior.tokens) !== JSON.stringify(e.data.tokens)
            : origins.has(e.data.origin);
    });
}

export function retainedReceiptContext(events, records, sourceSessionId) {
    const messages = new Set(), apiCalls = new Set(), origins = new Set();
    for (const record of records) if (record.sourceSessionId === sourceSessionId && !record.assessmentMembershipPruned && record.toolCalls?.length) {
        const model = record.originalModelEvidence;
        if (model?.promptMessageId && !model.invalid && !model.ambiguous && !model.conflict) {
            messages.add(model.promptMessageId);
            for (const response of model.responses) if (response.apiCallId) apiCalls.add(response.apiCallId);
        }
    }
    for (const e of events) if (e.type === "user.message" && messages.has(e.data.messageId) && e.data.wireUsageOrigin) origins.add(e.data.wireUsageOrigin);
    return events.filter(e => e.type !== "session.usage_record" || apiCalls.has(e.data.apiCallId) || origins.has(e.data.origin));
}
