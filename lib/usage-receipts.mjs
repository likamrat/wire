import { findTextFindings } from "./privacy-text.mjs";
import { createHash } from "node:crypto";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
    && !findTextFindings(value).some(item => item.mandatory);
const count = n => Number.isSafeInteger(n) && n >= 0;
const originDigest = data => safeId(data?.interactionId) ? createHash("sha256").update("usage-origin:" + data.interactionId).digest("hex") : null;

// Longer opaque provider IDs have no documented length bound; accept only one
// base64 alphabet with trailing padding, since the raw value is never retained.
const longOpaqueKey = value => value.length > 512 && value.length <= 4096 && value.length % 4 !== 1
    && /^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/.test(value) && (!value.endsWith("=") || value.length % 4 === 0);

function requestKey(value) {
    if (safeId(value)) return value;
    if (typeof value !== "string" || !/^[A-Za-z0-9+/_=-]{1,512}$/.test(value) && !longOpaqueKey(value)
        || findTextFindings(value).some(item => item.mandatory)) return null;
    // A raw request ID cannot occupy this internal namespace.
    return "!" + createHash("sha256").update("usage-request:" + value).digest("hex");
}

export function modelRequestKey(metadata) {
    if (metadata?.apiCallRef !== undefined) return metadata.apiCallId === null && typeof metadata.apiCallRef === "string" && /^![a-f0-9]{64}$/.test(metadata.apiCallRef)
        ? metadata.apiCallRef : null;
    return requestKey(metadata?.apiCallId);
}

// toolUsage meters the operation that completed, independently of conversation model receipts.
export function retainToolTokens(event, sourceSessionId) {
    const u = event.data?.toolUsage;
    if (event.type !== "tool.execution_complete" || event.checkpoint || event.ephemeral || !safeId(event.data?.toolCallId)
        || !safeId(u?.requestId) || typeof u.model !== "string" || !u.model.trim() || typeof event.data.success !== "boolean") return null;
    if (u.accounting !== undefined && (!safeId(u.accounting?.usageId) || u.accounting.sourceSessionId !== sourceSessionId
        || !safeId(sourceSessionId) || !count(u.accounting.sequence))) return null;
    const {inputTokens:input, outputTokens:output, totalTokens:reported} = u;
    if ([input,output,reported].every(n => n === undefined) || [input,output,reported].some(n => n !== undefined && !count(n))) return null;
    const sum = input !== undefined && output !== undefined ? input + output : null;
    if (sum !== null && (!count(sum) || reported !== undefined && reported !== sum)
        || reported !== undefined && (input > reported || output > reported)) return null;
    return { operationRef:createHash("sha256").update("tool-usage:" + u.requestId).digest("hex"),
        input:input ?? null, output:output ?? null, total:reported ?? sum };
}

export function toolTokenReadings(records) {
    const refs = new Map(), starts = new Map(), candidates = [];
    const claim = (map,key,value) => map.set(key, !map.has(key) || map.get(key) === value ? value : null);
    for (const record of records) for (const call of record.toolCalls ?? []) {
        const meter = call.toolTokenReceipt;
        if (!meter || !["copilot-app","copilot-app-chat"].includes(record.sourceHost)
            || !record.sourceSessionId || !call.toolCallId || !call.startEventId || !call.completionEventId) continue;
        const ref = JSON.stringify([record.sourceSessionId,meter.operationRef]), start = JSON.stringify([record.sourceSessionId,call.toolCallId]);
        const reading = {input:meter.input, output:meter.output, total:meter.total};
        const owner = JSON.stringify([start,call.startEventId,call.completionEventId,reading]);
        claim(refs,ref,owner); claim(starts,start,ref);
        candidates.push({call,ref,start,owner,reading});
    }
    return new Map(candidates.filter(c => refs.get(c.ref) === c.owner && starts.get(c.start) === c.ref).map(c => [c.call,c.reading]));
}

// Only the per-request journal receipt. Checkpoints and shutdown model metrics
// subsume earlier calls; ephemeral observer events are not a second data source.
export function retainUsageReceipt(event) {
    if (event.type !== "session.usage_record" || event.checkpoint || event.ephemeral) return null;
    const u = event.data?.usage, accounting = u?.accounting;
    const api = requestKey(u?.apiCallId), accountingId = requestKey(accounting?.usageId);
    if (!u || !api && !accountingId && !originDigest(u)) return null;
    const read = u.cacheReadTokens ?? null, write = u.cacheWriteTokens ?? null;
    // A main-loop follow-up after a tool result can be agent-initiated. Neither
    // initiator label establishes ownership; retainedUsage checks the explicit links.
    const valid = (u.apiCallId === undefined || Boolean(api)) && !event.agentId && !event.data.parentToolCallId && !u.parentToolCallId && !u.fusion
        && (u.initiator === undefined || u.initiator === "user" || u.initiator === "agent")
        && (u.interactionType === undefined || ["conversation-user","conversation-agent"].includes(u.interactionType))
        && safeId(u.model) && (!u.copilotUsage?.model || u.model === u.copilotUsage.model)
        && [u.inputTokens, u.outputTokens].every(count) && [read, write].every(n => n === null || count(n))
        && count(u.inputTokens - (read ?? 0) - (write ?? 0)) && count(u.inputTokens + u.outputTokens)
        && (!accounting || accountingId && (accounting.sourceSessionId === undefined || safeId(accounting.sourceSessionId))
            && (accounting.sequence === undefined || count(accounting.sequence)));
    return { id: event.id, type: event.type, timestamp: event.timestamp, data: {
        apiCallId: api ?? accountingId, origin: originDigest(u),
        accounting: accounting && valid ? { source: accounting.sourceSessionId ?? null, id: accountingId, seq: accounting.sequence ?? null } : null,
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

// Restored correlation fields are metering inputs only. They must never become
// conversation content, new tool calls, prompt authorship or response timing.
export function meteringDependency(event, toolIds) {
    // Shutdown and notification markers are already retained without content.
    if(event.type==="wire.usage_link" || ["session.usage_record","session.completion_receipt","session.shutdown","system.notification"].includes(event.type)) return event;
    const keys = event.type==="assistant.message" ? ["wireOriginalModel","wireUsageOrigin","originatingMessageId","turnId","hasToolRequests","finalAnswer"]
        : event.type==="tool.execution_start" ? ["toolCallId","turnId"] : ["assistant.turn_end","assistant.turn_start"].includes(event.type) ? ["turnId"] : null;
    if (!keys) throw new TypeError("Unsupported metering link type.");
    const data={meteringType:event.type};
    for(const key of [...keys,"wireUsageExcluded","parentToolCallId"]) if(event.data[key]!==undefined)data[key]=event.data[key];
    if(event.type==="assistant.message") {
        data.wireToolRequestIds=(event.data.wireToolRequestIds??[]).filter(id=>!toolIds || toolIds.has(id));
        const ref=modelRequestKey(data.wireOriginalModel);
        if(ref?.startsWith("!")) data.wireOriginalModel={...data.wireOriginalModel,apiCallId:null,apiCallRef:ref};
    }
    return {id:event.id,type:"wire.usage_link",timestamp:event.timestamp,...(event.agentId?{agentId:event.agentId}:{}),data};
}
export function usageMatcherEvents(events) {
    return events.map(e => {
        if (e.type !== "wire.usage_link") return e;
        const {meteringType,...data} = e.data;
        if (!["assistant.message","assistant.turn_start","assistant.turn_end","tool.execution_start"].includes(meteringType)) throw new TypeError("Unsupported retained metering dependency.");
        return {...e,type:meteringType,data};
    });
}

function hasIndependentMessageOwnership(events, prompt, sourceSessionId) {
    const run = prompt.data.wireUsageOrigin, roots = events.filter(e => e.type === "user.message");
    const claimants = roots.filter(e => e.data.wireUsageOrigin === run);
    const messages = new Set(claimants.map(e => e.data.messageId));
    if (messages.size !== claimants.length || new Set(claimants.map(e => e.id)).size !== claimants.length
        || [...messages].some(message => !safeId(message)
        || roots.filter(e => e.data.messageId === message).length !== 1)
        || claimants.some(e => e.agentId || e.data.parentToolCallId || e.data.wireUsageExcluded || e.data.wirePromptCapture?.conflict
            || ["credential-excluded","unsupported-content"].includes(e.data.wirePromptCapture?.reason))) return false;
    const responses = events.filter(e => e.type === "assistant.message"), owners = new Map();
    for (const e of responses) {
        const message = e.data.originatingMessageId, origin = e.data.wireUsageOrigin;
        if (origin !== run && !messages.has(message)) continue;
        const api = modelRequestKey(e.data.wireOriginalModel);
        if (!messages.has(message) || origin && origin !== run || !api || e.agentId || e.data.parentToolCallId
            || e.data.wireUsageExcluded || owners.has(api) && owners.get(api) !== message) return false;
        owners.set(api, message);
    }
    if (![...owners.values()].includes(prompt.data.messageId)
        || responses.some(e => owners.has(modelRequestKey(e.data.wireOriginalModel))
            && owners.get(modelRequestKey(e.data.wireOriginalModel)) !== e.data.originatingMessageId)) return false;
    for (const e of events) if (e.type === "session.usage_record") {
        const r = e.data, owned = owners.has(r.apiCallId);
        if (r.origin === run && !owned || owned && (r.origin && r.origin !== run || !r.tokens
            || r.accounting?.source && r.accounting.source !== sourceSessionId)) return false;
    }
    return true;
}

// The run ID and the originating-message ID are independent explicit claims.
// The exchange boundary establishes completeness, not membership by proximity.
export function retainedUsage(events, record, partialWindow, unavailable = () => null) {
    if (partialWindow || record.assessmentMembershipPruned) return unavailable("outside-read-window");
    const prompt = events.find(e => e.type === "user.message" && e.id === record.userPrompt?.sourceEventId
        && e.timestamp === record.userPrompt.sourceTimestamp);
    if (!prompt || prompt.data.wirePromptCapture?.conflict || prompt.data.wireUsageExcluded) return unavailable("outside-read-window");
    let origin = prompt.data.wireUsageOrigin;
    const message = prompt.data.messageId;
    if (!origin && !safeId(message)) return unavailable("interaction-link-or-boundary");
    const start = events.indexOf(prompt);
    // The producer delivers a steering message into the running interaction under the same run
    // ID, and later replies still name the root prompt. It continues this exchange; it is not a rival.
    const rootRun = origin, continuation = e => e.type === "user.message" && e !== prompt && Boolean(rootRun)
        && e.data.wireDelivery === "steering" && e.data.wireUsageOrigin === rootRun && !e.agentId && !e.data.wireUsageExcluded
        && events.indexOf(e) > start && e.data.messageId !== message;
    if (events.some(e => e.type === "user.message" && e !== prompt
        && (e.id === prompt.id || message && e.data.messageId === message))) return unavailable("conflicting-link");
    if (origin && events.some(e => e.type === "user.message" && e !== prompt && !continuation(e) && e.data.wireUsageOrigin === origin)) {
        if (!hasIndependentMessageOwnership(events, prompt, record.sourceSessionId)) return unavailable("conflicting-link");
        // A reused telemetry run is not an owner. All remaining guards use the independently proved message/request path.
        origin = null;
    }
    // Missing history anywhere from this prompt to the next independent prompt hides part of the
    // exchange. Explicit conflicts above still win; report this before any boundary judgment, so it never clears a verified total.
    const independent = events.findIndex((e, i) => i > start && e.type === "user.message" && !continuation(e));
    // Known membership outside this exchange is a conflict, even where missing history would otherwise preserve a total.
    if (record.toolCalls?.some(c => { const at = events.findIndex(e => e.id === c.startEventId && e.type === "tool.execution_start");
        return at >= 0 && (at < start || independent >= 0 && at > independent); })) return unavailable("conflicting-link");
    if (events.slice(start + 1, independent < 0 ? undefined : independent).some(e => e.type === "wire.history_gap")) return unavailable("history-gap");
    // The producer can repeat an earlier originatingMessageId on replies to later prompts, while each
    // reply's run ID names the prompt that started it. When both sides record a run, it decides ownership.
    const byRun = e => Boolean(origin && e.data.wireUsageOrigin);
    const own = e => byRun(e) ? e.data.wireUsageOrigin === origin : Boolean(message && e.data.originatingMessageId === message);
    const rival = e => byRun(e) ? e.data.wireUsageOrigin !== origin
        : Boolean(message && e.data.originatingMessageId && e.data.originatingMessageId !== message);
    const closures = events.filter(e => e.type === "session.completion_receipt" && e.data.start === prompt.id);
    const responses = events.filter(e => e.type === "assistant.message" && own(e));
    // A shutdown ends the exchange; owned replies after it resumed work this record cannot bound.
    const shutdown = events.findIndex((e, i) => i > start && e.type === "session.shutdown" && !e.agentId);
    if (shutdown >= 0 && responses.some(e => events.indexOf(e) > shutdown)) return unavailable("conflicting-link");
    let end, unfinished = false;
    if (closures.length) {
        const endId = closures[0].data.end;
        end = events.findIndex(e => e.id === endId && e.type === "assistant.turn_end");
        if (closures.some(e => e.data.end !== endId || events.indexOf(e) <= end)
            || events.some(e => e.type === "session.completion_receipt" && e.data.end === endId && e.data.start !== prompt.id)) return unavailable("conflicting-link");
    } else {
        const final = responses.at(-1);
        if (final?.data.finalAnswer && !final.data.hasToolRequests && safeId(final.data.turnId)) {
            end = events.findIndex((e,i) => i > events.indexOf(final) && e.type === "assistant.turn_end" && e.data.turnId === final.data.turnId);
        } else {
            // An exchange stopped before a final answer still spent every recorded call. It is
            // complete once the next independent prompt begins; later replies to it still conflict.
            const next = final ? events.findIndex((e,i) => i > events.indexOf(final)
                && (e.type === "user.message" && !continuation(e) || e.type === "session.shutdown" && !e.agentId)) : -1;
            if (next < 0) return unavailable("interaction-link-or-boundary");
            end = next - 1; unfinished = true;
        }
    }
    if (end <= start || !responses.length) return unavailable("interaction-link-or-boundary");
    const boundary = events[end];
    if (boundary.data.wireUsageExcluded || events.some((e,i) => e.id === boundary.id && i !== end
        && (e.type !== boundary.type || e.data.turnId !== boundary.data.turnId || e.agentId !== boundary.agentId))) return unavailable("conflicting-link");
    const window = events.slice(start + 1, end + 1), windowEvents = new Set(window);
    // The record's calls must all belong to this exchange; a call grouped from another prompt makes the total wrong.
    if (record.toolCalls?.some(c => { const s = events.find(e => e.id === c.startEventId && e.type === "tool.execution_start");
        return s && !windowEvents.has(s); })) return unavailable("conflicting-link");
    // A gap is missing evidence, not a rival: it never clears an already verified total.
    if (window.some(e => e.type === "wire.history_gap")) return unavailable("history-gap");
    if (window.some(e => e.agentId || e.data.parentToolCallId || e.data.wireUsageExcluded || e.type === "subagent.started"
        || e.type === "user.message" && !continuation(e))) return unavailable("incomplete-or-nested");
    if (responses.some(e => !windowEvents.has(e) || rival(e))) return unavailable("conflicting-link");
    const expected = new Map(), toolRequests = new Set(), responseEvents = new Map();
    for (const e of responses) {
        const apiCallId = modelRequestKey(e.data.wireOriginalModel), model = e.data.wireOriginalModel?.model;
        if (!apiCallId || expected.get(apiCallId) && model && expected.get(apiCallId) !== model
            || responseEvents.has(e.id) && responseEvents.get(e.id) !== apiCallId) return unavailable("unverified-model-call");
        responseEvents.set(e.id, apiCallId);
        expected.set(apiCallId, model ?? expected.get(apiCallId) ?? null);
        for (const id of e.data.wireToolRequestIds ?? []) toolRequests.add(id);
    }
    // Right after a background notification the producer writes an assistant message with no model
    // metadata, turn, run or originating message. It cannot carry or claim a model call, so it is no rival.
    // It shares a model round with this exchange's own metered replies; an otherwise unmetered round still conflicts.
    const metered = e => e.type === "assistant.message" && !e.agentId && own(e) && modelRequestKey(e.data.wireOriginalModel);
    const meteredRound = from => {
        const to = events.findIndex((e, i) => i > from && e.type === "assistant.turn_end" && !e.agentId);
        return { to, metered: from > start && to > from && events.slice(from + 1, to).some(e => metered(e) && e.data.turnId === events[from].data.turnId) };
    };
    // The producer writes the note either inside a round or between rounds, just before the round that answers
    // the notification. Between rounds, only the note's own tool completion may separate it from that round.
    const inMeteredRound = at => {
        const from = events.findLastIndex((e, i) => i < at && e.type === "assistant.turn_start" && !e.agentId), round = meteredRound(from);
        if (round.to > at) return round.metered;
        const next = events.findIndex((e, i) => i > at && e.type === "assistant.turn_start" && !e.agentId);
        return next > at && events.slice(at + 1, next).every(e => e.type === "tool.execution_complete" && !e.agentId
            && (events[at].data.wireToolRequestIds ?? []).includes(e.data.toolCallId)) && meteredRound(next).metered;
    };
    const synthesized = e => {
        const m = e.data.wireOriginalModel, at = events.indexOf(e);
        return e.type === "assistant.message" && events[at - 1]?.type === "system.notification" && !events[at - 1].agentId && inMeteredRound(at)
            && !e.agentId && !e.data.parentToolCallId && !modelRequestKey(m) && !m?.model && !m?.originatingMessageId
            && !e.data.wireUsageOrigin && !e.data.originatingMessageId && !e.data.turnId && !e.data.finalAnswer;
    };
    if (window.some(e => e.type === "assistant.message" && !own(e) && !synthesized(e))
        || events.some(e => responseEvents.has(e.id) && (e.type !== "assistant.message" || !own(e)))) return unavailable("conflicting-link");
    const nextPrompt = events.findIndex((e,i) => i > end && e.type === "user.message" && !continuation(e));
    const after = events.slice(end + 1, nextPrompt < 0 ? undefined : nextPrompt);
    if (after.some(e => e.type === "wire.history_gap")) return unavailable("history-gap");
    if (after.some(e => ["assistant.turn_start","tool.execution_start","subagent.started"].includes(e.type)
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
            if (relatedIds.has(modelRequestKey(m)) && (!own(e) || rival(e) || e.agentId || e.data.parentToolCallId)) return unavailable("conflicting-link");
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
        const api = modelRequestKey(response.data.wireOriginalModel);
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
        origin: e.data.origin, at: e.timestamp, model: e.data.model, tokens: e.data.tokens, ...(unfinished ? { unfinished: true } : {}),
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
            return apis.has(modelRequestKey(m)) || origins.has(e.data.wireUsageOrigin)
                || m?.originatingMessageId && m.originatingMessageId === record.originalModelEvidence?.promptMessageId;
        }

        if (e.type !== "session.usage_record") return false;
        const prior = apis.get(e.data.apiCallId);
        return prior ? prior.model !== e.data.model || prior.origin !== e.data.origin || JSON.stringify(prior.tokens) !== JSON.stringify(e.data.tokens)
            : origins.has(e.data.origin);
    });
}

export function retainedReceiptContext(events, records, sourceSessionId) {
    const messages = new Set(), apiCalls = new Set(), origins = new Set(), promptIds = new Map();
    for (const record of records) if (record.sourceSessionId === sourceSessionId && !record.assessmentMembershipPruned && record.toolCalls?.length) {
        for (const call of record.usageCalls ?? []) apiCalls.add(call.apiCallId);
        const model = record.originalModelEvidence;
        if (record.userPrompt?.sourceEventId) promptIds.set(record.userPrompt.sourceEventId, record.userPrompt.sourceTimestamp);
        if (model?.promptMessageId && !model.invalid && !model.ambiguous && !model.conflict) {
            messages.add(model.promptMessageId);
            for (const response of model.responses) {
                const api = modelRequestKey(response);
                if (api) apiCalls.add(api);
            }
        }
    }
    const runOwners = new Map(), pending = new Map();
    for (const e of events) {
        if (e.type === "user.message" && e.data.wireUsageOrigin) {
            const run = e.data.wireUsageOrigin;
            if (messages.has(e.data.messageId) || promptIds.has(e.id)) origins.add(run);
            const owned = promptIds.has(e.id) && promptIds.get(e.id) === e.timestamp && !e.data.wireUsageExcluded && !e.data.wirePromptCapture?.conflict
                && !["credential-excluded","unsupported-content"].includes(e.data.wirePromptCapture?.reason);
            runOwners.set(run, owned && !runOwners.has(run) ? e : null);
        } else if (e.type === "session.usage_record" && promptIds.size && e.data.apiCallId && !e.data.origin && !apiCalls.has(e.data.apiCallId)) {
            pending.set(e.data.apiCallId, undefined);
        }
    }
    // A request-only receipt can arrive before the exchange closes. Keep its original
    // only for a known Work IQ prompt, even when model evidence lacks a logical message ID.
    if (pending.size) for (const e of events) if (e.type === "assistant.message") {
        const api = modelRequestKey(e.data.wireOriginalModel);
        if (!pending.has(api)) continue;
        const owner = runOwners.get(e.data.wireUsageOrigin);
        const linked = owner && !e.agentId && !e.data.parentToolCallId && !e.data.wireUsageExcluded
            && (!e.data.originatingMessageId || e.data.originatingMessageId === owner.data.messageId);
        const prior = pending.get(api);
        pending.set(api, linked && (prior === undefined || prior === owner) ? owner : null);
    }
    for (const [api, owner] of pending) if (owner) apiCalls.add(api);
    return events.filter(e => e.type === "session.completion_receipt" ? promptIds.has(e.data.start)
        : e.type !== "session.usage_record" || apiCalls.has(e.data.apiCallId) || origins.has(e.data.origin));
}
