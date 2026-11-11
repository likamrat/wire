import { isDeepStrictEqual } from "node:util";
import { textFindings } from "./privacy.mjs";
import { eventIdentity, filterDeletedEvents, filterDeletedRecords } from "./deletion-identities.mjs";
import { time } from "./time.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
const scopeFields = [["agentId"], ["data", "parentToolCallId"], ["data", "turnId"]];
const rootKeys = new Set(["id", "type", "timestamp", "agentId", "parentId", "data"]);
const completionKeys = new Set(["toolCallId", "success", "model", "parentToolCallId", "turnId"]);
const startKeys = new Set(["toolCallId", "toolName", "mcpToolName", "mcpServerName", "mcpConfigServerName",
    "arguments", "parentToolCallId", "model", "turnId", "mcpTransport", "toolTitle", "mcpConfigSource"]);
const chainTypes = new Set(["tool.execution_start", "tool.execution_complete", "assistant.message",
    "assistant.turn_start", "assistant.turn_end", "user.message", "subagent.started", "hook.start", "hook.end"]);
const instant = value => {
    try { return Date.parse(time.instant(value)); }
    catch (error) { if (error instanceof RangeError) return null; throw error; }
};
const credential = value => textFindings(JSON.stringify(value)).some(finding => finding.mandatory);
const incomplete = call => call.completionEventId === null && call.completedAt === null && call.durationMs === null
    && call.reportedOutcome === "unknown" && call.toolSucceeded === null && Array.isArray(call.apiResults)
    && call.apiResults.length === 0 && (!Object.hasOwn(call, "failureEvidence") || call.failureEvidence === null);
export { incomplete as isIncompleteWorkIqCall };
const scopeValue = (event, path) => {
    const parent = path.length === 1 ? event : event.data;
    const key = path.at(-1);
    return { present: Object.hasOwn(parent ?? {}, key), value: parent?.[key] };
};
const sameScope = (start, end) => scopeFields.every(path => {
    const a = scopeValue(start, path), b = scopeValue(end, path);
    return a.present === b.present && (!a.present || id(a.value) && id(b.value) && a.value === b.value);
});
const rootEnvelope = event => id(event.id) && typeof event.type === "string" && chainTypes.has(event.type)
    && Object.keys(event).every(key => rootKeys.has(key))
    && event.data && typeof event.data === "object" && !Array.isArray(event.data)
    && (!Object.hasOwn(event, "parentId") || id(event.parentId));
const envelope = (event, keys) => rootEnvelope(event) && Object.keys(event.data).every(key => keys.has(key));
const isHook = event => event.type === "hook.start" || event.type === "hook.end";
const object = value => value && typeof value === "object" && !Array.isArray(value);
const labelsValid = start => ["toolTitle", "mcpConfigSource"].every(key => !Object.hasOwn(start.data, key)
    || typeof start.data[key] === "string" && start.data[key].trim() && Buffer.byteLength(start.data[key]) <= 512
        && !/[\u0000-\u001f\u007f]/.test(start.data[key]));

function qualifiedHooks(chain, start, sourceSessionId, observedInvocations) {
    const hooks = chain.filter(isHook).toReversed();
    if (!hooks.length) return true;
    if (hooks.length !== 6 || chain.length !== 7) return false;
    const invocationIds = new Set();
    const types = ["preToolUse", "preMcpToolCall", "postToolUse"];
    let parentId = start.id;
    for (const [index, type] of types.entries()) {
        const begin = hooks[index * 2], end = hooks[index * 2 + 1], input = begin.data.input;
        const observed = observedInvocations.get(begin.data.hookInvocationId);
        if (begin.type !== "hook.start" || end.type !== "hook.end"
            || begin.parentId !== parentId || end.parentId !== begin.id
            || !envelope(begin, new Set(["hookInvocationId", "hookType", "input"]))
            || !envelope(end, new Set(["hookInvocationId", "hookType", "success"]))
            || begin.data.hookType !== type || end.data.hookType !== type
            || !id(begin.data.hookInvocationId) || end.data.hookInvocationId !== begin.data.hookInvocationId
            || invocationIds.has(begin.data.hookInvocationId) || typeof end.data.success !== "boolean"
            || observed?.length !== 2 || !observed.some(entry => entry.event === begin) || !observed.some(entry => entry.event === end)
            || !object(input) || input.sessionId !== sourceSessionId
            || [begin, end].some(event => Object.hasOwn(event, "agentId")
                && (!id(event.agentId) || event.agentId !== start.agentId))) return false;
        const keys = type === "preToolUse" ? ["sessionId", "cwd", "toolCalls"]
            : type === "preMcpToolCall" ? ["sessionId", "timestamp", "cwd", "toolCallId", "serverName", "toolName", "arguments"]
                : ["sessionId", "timestamp", "cwd", "toolName", "toolArgs", "toolResult"];
        if (Object.keys(input).some(key => !keys.includes(key))
            || Object.hasOwn(input, "cwd") && typeof input.cwd !== "string"
            || Object.hasOwn(input, "timestamp") && (!Number.isFinite(input.timestamp) || input.timestamp < 0)) return false;
        if (type === "preToolUse") {
            const call = input.toolCalls?.[0];
            if (!Array.isArray(input.toolCalls) || input.toolCalls.length !== 1 || !object(call)
                || Object.keys(call).some(key => !["id", "name", "args"].includes(key))
                || call.id !== start.data.toolCallId || call.name !== start.data.toolName
                || !isDeepStrictEqual(call.args, start.data.arguments)) return false;
        } else if (type === "preMcpToolCall") {
            if (input.toolCallId !== start.data.toolCallId || input.serverName !== "workiq"
                || input.toolName !== (start.data.mcpToolName ?? start.data.toolName.replace(/^workiq-/, ""))
                || !isDeepStrictEqual(input.arguments, start.data.arguments)) return false;
        } else if (input.toolName !== start.data.toolName || !isDeepStrictEqual(input.toolArgs, start.data.arguments)) return false;
        invocationIds.add(begin.data.hookInvocationId);
        parentId = end.id;
    }
    return true;
}

// The caller supplies original and projected entries separately from one verified read, never from a checkpoint.
// This pure transform grants no publication authority; the collector must recheck its lease and deletion epoch.
export function recoverSameReadCompletions({ sourceSessionId, sourceIdentity, since, until,
    readStart, readEnd, original, projected, records, deletion, completionOffsets }) {
    const from = instant(since), to = instant(until);
    if (!id(sourceSessionId) || !Number.isSafeInteger(readStart) || readStart < 0 || !Number.isSafeInteger(readEnd)
        || readEnd < readStart || readEnd - readStart > 4 * 1024 ** 2
        || typeof sourceIdentity !== "string" || !sourceIdentity || sourceIdentity.length > 1024
        || from === null || to === null || from > to
        || !Array.isArray(original) || !Array.isArray(projected) || !Array.isArray(records)
        || completionOffsets !== undefined && (!(completionOffsets instanceof Set)
            || [...completionOffsets].some(offset => !Number.isSafeInteger(offset) || offset < readStart || offset >= readEnd))) {
        throw new TypeError("Recovery requires a verified bounded read and record arrays.");
    }
    const entries = [...original.map(entry => ({ ...entry, original: true })),
        ...projected.map(entry => ({ ...entry, original: false }))].sort((a, b) => a.offset - b.offset);
    let boundary = readStart;
    const byId = new Map(), starts = new Map(), ends = new Map(), hookInvocations = new Map();
    const append = (map, key, entry) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(entry);
    };
    for (const entry of entries) {
        if (!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.endOffset) || entry.offset < boundary
            || entry.endOffset <= entry.offset || entry.endOffset > readEnd || !entry.event || typeof entry.event !== "object") {
            throw new TypeError("Recovery entries require distinct ordered positions within the verified read.");
        }
        boundary = entry.endOffset;
        append(byId, entry.event.id, entry);
        if (entry.event.type === "tool.execution_start") append(starts, entry.event.data?.toolCallId, entry);
        if (entry.event.type === "tool.execution_complete") append(ends, entry.event.data?.toolCallId, entry);
        if (isHook(entry.event)) append(hookInvocations, entry.event.data?.hookInvocationId, entry);
    }
    const targets = new Map();
    records.forEach((record, recordIndex) => {
        if (record.sourceSessionId !== sourceSessionId) return;
        (record.toolCalls ?? []).forEach((call, callIndex) =>
            append(targets, call.toolCallId, { record, recordIndex, call, callIndex }));
    });
    const admittedEvents = new Set(filterDeletedEvents(entries.map(entry => entry.event), sourceSessionId, deletion));
    const deletedEvents = new Set(deletion?.events ?? []);
    const retainedCalls = new Map();
    const updates = new Map(), dispositions = [];
    for (const completion of entries.filter(entry => !entry.original && entry.event.type === "tool.execution_complete"
        && (!completionOffsets || completionOffsets.has(entry.offset)))) {
        const end = completion.event, callId = end.data?.toolCallId;
        const reject = reason => dispositions.push({ offset: completion.offset, status: "unavailable", reason });
        if (end.type !== "tool.execution_complete" || end.data?.success !== true || !id(end.id) || !id(callId)
            || !envelope(end, completionKeys)) {
            reject("unsupported-completion"); continue;
        }
        if (byId.get(end.id)?.length !== 1 || ends.get(callId)?.length !== 1 || starts.get(callId)?.length !== 1
            || targets.get(callId)?.length !== 1) {
            reject("ambiguous-or-missing-match"); continue;
        }
        const startEntry = starts.get(callId)[0], start = startEntry.event;
        const target = targets.get(callId)[0], { call, record, recordIndex, callIndex } = target;
        if (!startEntry.original || byId.get(start.id)?.length !== 1 || !id(start.id) || !envelope(start, startKeys) || !labelsValid(start)
            || record.workloadKind !== "recorded-history" || record.isLegacy || record.sample
            || !call.tool?.startsWith("workiq-") || !incomplete(call)) {
            reject("target-not-incomplete"); continue;
        }
        if (credential([end, start.id, start.agentId, start.parentId, start.data?.arguments,
            start.data?.parentToolCallId, start.data?.turnId])) {
            reject("credential-excluded"); continue;
        }
        const logical = start.data?.mcpToolName ?? start.data?.toolName?.replace(/^workiq-/, "");
        if (call.startEventId !== start.id || call.startedAt !== start.timestamp || call.tool !== `workiq-${logical}`
            || !isDeepStrictEqual(call.requestArgs, start.data.arguments)
            || !(start.data?.mcpServerName === "workiq" || start.data?.mcpConfigServerName === "workiq"
                || start.data?.toolName === `workiq-${logical}`)) {
            reject("start-mismatch"); continue;
        }
        const startTime = instant(start.timestamp), endTime = instant(end.timestamp);
        if (startTime === null || endTime === null || startEntry.offset >= completion.offset || startTime > endTime
            || startTime < from || endTime > to) {
            reject("invalid-chronology"); continue;
        }
        if (!sameScope(start, end) || ["parentToolCallId", "turnId"].some(key =>
            call[key] !== (Object.hasOwn(start.data, key) ? start.data[key] : null))) {
            reject("scope-mismatch"); continue;
        }
        let child = completion, chainValid = true;
        const chain = [];
        while (Object.hasOwn(child.event, "parentId")) {
            const parentId = child.event.parentId, matches = byId.get(parentId);
            if (!id(parentId) || matches?.length !== 1) { chainValid = false; break; }
            const parent = matches[0], parentTime = instant(parent.event.timestamp);
            if ((!parent.original && parent.event.type !== "hook.start") || !rootEnvelope(parent.event)
                || parent.offset >= child.offset || parent.offset < startEntry.offset
                || parentTime === null || parentTime > instant(child.event.timestamp)
                || !isHook(parent.event) && !sameScope(start, parent.event)) { chainValid = false; break; }
            chain.push(parent.event);
            if (parent === startEntry) break;
            if (!Object.hasOwn(parent.event, "parentId")) { chainValid = false; break; }
            child = parent;
        }
        if (!chainValid || !qualifiedHooks(chain, start, sourceSessionId, hookInvocations)) { reject("unresolved-parent-chain"); continue; }
        const dependencies = [start, ...chain, end];
        if (!retainedCalls.has(record)) {
            const retained = filterDeletedRecords([record], deletion)[0];
            retainedCalls.set(record, new Map((retained?.toolCalls ?? []).map(value => [value.toolCallId, value])));
        }
        if (dependencies.some(event => deletedEvents.has(eventIdentity(sourceSessionId, event.id)))
            || dependencies.some(event => !admittedEvents.has(event))
            || !isDeepStrictEqual(retainedCalls.get(record).get(call.toolCallId), call)) {
            reject("deleted-or-suppressed"); continue;
        }
        const next = { ...call, completionEventId: end.id, completedAt: end.timestamp,
            durationMs: endTime - startTime, reportedOutcome: "succeeded", toolSucceeded: true };
        const model = end.data.model;
        if (call.model === null && call.modelSource === "unavailable" && typeof model === "string" && model.trim()
            && model.isWellFormed() && Buffer.byteLength(model) <= 512 && !/[\u0000-\u001f\u007f]/.test(model)) {
            next.model = model;
            next.modelSource = "completion-event";
        }
        if (!updates.has(recordIndex)) updates.set(recordIndex, new Map());
        updates.get(recordIndex).set(callIndex, next);
        dispositions.push({ offset: completion.offset, status: "recovered" });
    }
    return { records: updates.size ? records.map((record, index) => !updates.has(index) ? record : {
        ...record, toolCalls: record.toolCalls.map((call, indexInRecord) => updates.get(index).get(indexInRecord) ?? call),
    }) : records, dispositions };
}
