import { textFindings } from "./privacy.mjs";
import { findCredentialFindings } from "./privacy-text.mjs";
import { validateNativeChatSource } from "./native-chat-observation-contract.mjs";
import { validateNativeReadback } from "./native-retention-state.mjs";
import { time } from "./time.mjs";
import { isValidatedNativeRetainedRecord } from "./native-retention-contract.mjs";
import { retainedErrorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";

export const NATIVE_READ_CONTRACT = "m365-native-v0-review-only";
export const NATIVE_RETAINED_CONTRACT = "m365-native-screened-observations-v1";
export const NATIVE_COWORK_MESSAGE_AUTHOR_PARSER = "cowork-source-v5-748365-message-authors";
export const NATIVE_COWORK_LEGACY_RESULT_FACTS_PARSER = "cowork-source-v6-result-facts";
export const NATIVE_COWORK_RESULT_FACTS_PARSER = "cowork-source-v7-748365-result-facts";
export const NATIVE_READ_LIMITS = Object.freeze({ records: 10000, bytes: 16 * 1024 * 1024, textBytes: 1024 * 1024 });
export const NATIVE_JSON_LIMITS = Object.freeze({ depth: 64, nodes: 1000000 });
const retainedObservationPopulation = "Source-qualified immutable content variants; repeat captures add provenance, not activity. Current marks the latest accepted variant, not source chronology.";
function nativeDefinitions({ messageParts, chatSource }) {
    return {
        conversationPopulation: "Every supplied authorized conversation, including conversations with no tool calls.",
        ordering: "Source page/frame/record coordinates retained; input order is not inferred chronology.",
        authorization: "Source verification and capture generation are historical metadata, never a current authorization lease.",
        messagePopulation: "Source-qualified representation observations; variants are not additional user turns.",
        ...(messageParts ? {
            messagePartPopulation: "Derived literal message-part views at exact source pointers; original parent observations, native identities and ordering remain unchanged. Parts are not additional turns, calls or completed replies.",
        } : {}),
        toolUnit: "Native call identity within source/account/conversation; observations are not additional executions.",
        resultUnit: "Observed intermediary-reported result entries, never declared requests or tool outcomes.",
        referenceUnit: "Source result-reference entries, not unique entities, HTTP requests or API outcomes.",
        measurementPopulation: "Only supplied qualified measurements with their own units/boundaries; no cross-boundary aggregation.",
        ...(chatSource ? {
            sourceObservationPopulation: "Original Chat task/trigger/invocation facts with source and decoded coordinates; not calls, outcomes, services, generated UI values or current-build qualification.",
        } : {}),
    };
}
export function nativeRetainedDefinitions({ messageParts = false, chatSource = false } = {}) {
    if (typeof messageParts !== "boolean" || typeof chatSource !== "boolean") throw new NativeReadModelError("invalid-definition-flags", "$definitions");
    return Object.freeze({ ...nativeDefinitions({ messageParts, chatSource }), retainedObservationPopulation });
}
const blockers = Object.freeze([
    "cowork-missing-input-or-no-input-provenance",
    "cowork-original-nested-batch-outcomes",
    "chat-enterprise-execution-result-coverage",
]);
const availability = ["recorded", "recorded-empty", "explicit-null", "absent-in-response", "excluded-by-policy",
    "credential-excluded", "unsupported", "unqualified", "conflicting"];
const fieldNames = ["message", "toolName", "input", "failure", "approval", "model", "callElapsed", "resultReferences", "resultEvidence", "messageCreatedAt", "messageUpdatedAt", "observationTime"];
const messageTimeFields = new Map([["messageCreatedAt", "createdAt"], ["messageUpdatedAt", "timestamp"]]);
const byteLength = value => new TextEncoder().encode(value).length;
const key = (...parts) => JSON.stringify(parts);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(name => [name, stable(value[name])])) : value;
const retentionDiagnostics = new WeakMap();
const retentionStages = new Set(["normalize-batch", "validate-pre-stage", "validate-disk-readback",
    "validate-retained-read", "project-retained-read"]);
const screeningDomains = new Set(["serialized-structure", "string-value", "field-name"]);
const credentialCategories = new Set(["credentials", "credential_assignments", "private_keys", "credential_urls"]);
export const nativeConversationIdentity = scope => key("m365-native-v0", scope.surface, scope.account.tenantId,
    scope.account.subjectId, scope.conversationId, "conversation");

export class NativeReadModelError extends TypeError {
    constructor(code, path) {
        super(`${code} at ${path}`);
        this.name = "NativeReadModelError";
        this.code = code;
        this.path = path;
    }
}

export function nativeRetentionDiagnostic(error) {
    const value = retentionDiagnostics.get(error);
    return value && value.code === "credential-bearing-retained-observations"
        && retentionStages.has(value.stage) && screeningDomains.has(value.scanDomain)
        && credentialCategories.has(value.credentialCategory) ? value : null;
}

export function annotateNativeRetentionDiagnostic(error, stage, target = error) {
    if (stage !== undefined && !retentionStages.has(stage)) throw new TypeError("Invalid native retention diagnostic stage.");
    const value = retentionDiagnostics.get(error);
    if (value) retentionDiagnostics.set(target, stage !== undefined && value.stage === undefined
        ? Object.freeze({ ...value, stage }) : value);
    return target;
}

export function nativeWriterAdmission() {
    return { admitted: false, status: "withheld", contractVersion: NATIVE_READ_CONTRACT,
        blockers: [...blockers], syntheticEvidenceCanClearBlockers: false };
}

export function assertNativeWriterAdmission() {
    throw new NativeReadModelError("native-writer-admission-withheld", "$");
}

const fail = (code, path) => { throw new NativeReadModelError(code, path); };
function shape(value, required, optional, path) {
    if (!object(value)) fail("expected-object", path);
    for (const name of required) if (!Object.hasOwn(value, name)) fail("missing-field", `${path}.${name}`);
    for (const name of Object.keys(value)) if (![...required, ...optional].includes(name)) fail("unsupported-field", path);
}
function text(value, path, max = 1024) {
    if (typeof value !== "string" || !value.trim() || byteLength(value) > max) fail("invalid-text", path);
    if (nativeValueHasCredentials(value, path)) fail("credential-bearing-metadata", path);
    return value;
}
function member(value, values, path) {
    if (!values.includes(value)) fail("unsupported-value", path);
}
function integer(value, path) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid-count", path);
}
export function normalizeNativeMessageTime(value, path = "$") {
    if (typeof value !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        fail("invalid-native-message-time", path);
    }
    const milliseconds = value.replace(/(\.\d{3})\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "$1");
    try {
        time.instant(milliseconds);
        const normalized = new Date(milliseconds).toISOString();
        time.instant(normalized);
        return normalized;
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        fail("invalid-native-message-time", path);
    }
}
export function normalizeNativeObservationTime(value, unit, path = "$") {
    if (unit === "iso8601") return normalizeNativeMessageTime(value, path);
    if (unit !== "epoch-ms" || !Number.isSafeInteger(value)) fail("invalid-native-observation-time", path);
    try {
        const instant = new Date(value).toISOString();
        time.instant(instant);
        return instant;
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        fail("invalid-native-observation-time", path);
    }
}
function assertJsonInput(root, path = "$") {
    const measured = new WeakMap(), active = new WeakSet();
    const bytesWithinBound = bytes => {
        if (bytes > NATIVE_READ_LIMITS.bytes) fail("record-byte-bound", path);
        return bytes;
    };
    function stringBytes(value) {
        let bytes = 2;
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
            else if (code < 32) bytes += 6;
            else if (code < 128) bytes++;
            else if (code < 2048) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
                bytes += 4; index++;
            } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
            else bytes += 3;
            bytesWithinBound(bytes);
        }
        return bytes;
    }
    function measure(value, depth) {
        if (depth > NATIVE_JSON_LIMITS.depth) fail("json-structure-bound", path);
        if (value === undefined || ["function", "symbol", "bigint"].includes(typeof value)
            || typeof value === "number" && !Number.isFinite(value)) fail("non-json-value", path);
        if (value === null || typeof value !== "object") {
            return { bytes: typeof value === "string" ? stringBytes(value) : value === null ? 4 : String(value).length, nodes: 1, height: 0 };
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) fail("non-json-object", path);
        if (active.has(value)) fail("non-json-input", path);
        // Reuse the measurement, not the allowance: every alias expands again in JSON.
        const cached = measured.get(value);
        if (cached) {
            if (depth + cached.height > NATIVE_JSON_LIMITS.depth) fail("json-structure-bound", path);
            return cached;
        }
        active.add(value);
        const array = Array.isArray(value);
        if (array && value.length > NATIVE_JSON_LIMITS.nodes) fail("json-structure-bound", path);
        let bytes = 2, nodes = 1, height = 0, entries = 0;
        for (const name of Reflect.ownKeys(value)) {
            if (typeof name !== "string") fail("non-json-value", path);
            if (array && name === "length") continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor.get || descriptor.set) fail("non-json-accessor", path);
            if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length)) fail("non-json-array-field", path);
            const child = measure(descriptor.value, depth + 1);
            nodes += child.nodes; height = Math.max(height, child.height + 1);
            if (array || descriptor.enumerable) {
                bytes = bytesWithinBound(bytes + (entries ? 1 : 0) + (array ? 0 : stringBytes(name) + 1) + child.bytes);
                entries++;
            }
            if (nodes > NATIVE_JSON_LIMITS.nodes) fail("json-structure-bound", path);
        }
        if (array && entries !== value.length) fail("non-json-value", path);
        active.delete(value);
        const result = { bytes, nodes, height };
        measured.set(value, result);
        return result;
    }
    return measure(root, 0);
}
export const measureNativeJson = value => Object.freeze(assertJsonInput(value));
function withinSerializedString(serialized, finding) {
    for (let index = finding.start; index < finding.end; index++) {
        if (serialized[index] === "\\") index++;
        else if (serialized[index] === '"') return false;
    }
    return true;
}
function nativeCredentialFinding(value, path = "$") {
    assertJsonInput(value, path);
    const json = JSON.stringify(value);
    // URL userinfo cannot span JSON string tokens; credential assignments can.
    const serialized = findCredentialFindings(json).find(finding => finding.mandatory
        && (finding.category !== "credential_urls" || withinSerializedString(json, finding)));
    if (serialized) return { scanDomain: "serialized-structure", credentialCategory: serialized.category };
    const pending = [value], objects = new WeakSet(), strings = new Set(), fields = new Set();
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string") {
            if (strings.has(item)) continue;
            strings.add(item);
            const finding = findCredentialFindings(item).find(finding => finding.mandatory);
            if (finding) return { scanDomain: "string-value", credentialCategory: finding.category };
        } else if (item && typeof item === "object" && !objects.has(item)) {
            objects.add(item);
            for (const [name, child] of Object.entries(item)) {
                if (!fields.has(name)) {
                    fields.add(name);
                    const finding = findCredentialFindings(name).find(finding => finding.mandatory);
                    if (finding) return { scanDomain: "field-name", credentialCategory: finding.category };
                }
                pending.push(child);
            }
        }
    }
    return null;
}
export function nativeValueHasCredentials(value, path = "$") {
    return nativeCredentialFinding(value, path) !== null;
}
function screenRetainedValue(value, path, stage) {
    const finding = nativeCredentialFinding(value);
    if (!finding) return;
    const error = new NativeReadModelError("credential-bearing-retained-observations", path);
    retentionDiagnostics.set(error, Object.freeze({ code: error.code, ...finding }));
    throw annotateNativeRetentionDiagnostic(error, stage);
}
function refs(value, path) {
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.length || rows.length > 32) fail("invalid-evidence-references", path);
    for (const [index, row] of rows.entries()) {
        shape(row, ["sourceDocument", "pointer"], ["nativeEventId"], `${path}[${index}]`);
        text(row.sourceDocument, `${path}[${index}].sourceDocument`);
        text(row.pointer, path, 2048);
        if (!row.pointer.startsWith("/")) fail("invalid-source-pointer", path);
        if (row.nativeEventId !== undefined) text(row.nativeEventId, `${path}[${index}].nativeEventId`);
    }
    return rows;
}
function fact(value, evidence, path) {
    shape(value, ["availability"], ["value", "reason", "scope", "unit", "basis", "boundary", "comparableToUserResponseLatency"], path);
    member(value.availability, availability, `${path}.availability`);
    const carriesValue = ["recorded", "recorded-empty", "explicit-null"].includes(value.availability);
    if (carriesValue !== Object.hasOwn(value, "value")) fail("availability-value-conflict", path);
    if (value.availability === "explicit-null" && value.value !== null) fail("expected-explicit-null", path);
    if (value.availability === "recorded-empty" && value.value !== "") fail("expected-recorded-empty-string", path);
    if (value.availability === "recorded" && value.value === null) fail("use-explicit-null", path);
    if (!carriesValue && !value.reason) fail("missing-qualification", path);
    if (value.reason !== undefined) text(value.reason, `${path}.reason`, 2048);
    for (const name of ["scope", "unit", "basis", "boundary"]) if (value[name] !== undefined) text(value[name], `${path}.${name}`, 256);
    if (value.comparableToUserResponseLatency !== undefined && typeof value.comparableToUserResponseLatency !== "boolean") fail("invalid-timing-qualification", path);
    if (value.value !== undefined && nativeValueHasCredentials(value.value, path)) fail("credential-bearing-fact", path);
    if (value.value !== undefined && byteLength(JSON.stringify(value.value)) > NATIVE_READ_LIMITS.textBytes) fail("fact-byte-bound", path);
    return { ...value, evidence: refs(evidence, `${path}.evidence`) };
}
function validateField(name, value, path) {
    for (const metadata of ["scope", "unit", "basis", "boundary", "comparableToUserResponseLatency"]) {
        const allowed = name === "model" && metadata === "scope"
            || name === "callElapsed" && metadata !== "scope"
            || messageTimeFields.has(name) && metadata === "scope"
            || name === "observationTime" && ["scope", "unit", "basis"].includes(metadata);
        if (value[metadata] !== undefined && !allowed) fail("field-qualification-conflict", path);
    }
    if (messageTimeFields.has(name) && value.scope !== "message") fail("message-time-scope-required", path);
    if (name === "observationTime" && (value.scope !== "observation" || value.basis !== "cowork.data.ts"
        || value.unit !== undefined && !["iso8601", "epoch-ms"].includes(value.unit))) fail("observation-time-qualification-conflict", path);
    if (value.availability === "recorded-empty" && name !== "input" && !messageTimeFields.has(name) && name !== "observationTime") fail("unsupported-empty-fact", path);
    if (value.availability !== "recorded") return;
    const data = value.value;
    if (messageTimeFields.has(name)) return normalizeNativeMessageTime(data, path);
    if (name === "observationTime") return normalizeNativeObservationTime(data, value.unit, path);
    if (name === "message") {
        shape(data, ["author", "representation", "text"], [], path);
        member(data.author, ["user", "assistant", "tool", "unknown"], path);
        member(data.representation, ["plain-text", "card-text", "reply-fragment", "follow-up"], path);
        if (typeof data.text !== "string" || byteLength(data.text) > NATIVE_READ_LIMITS.textBytes) fail("invalid-message-text", path);
    } else if (name === "toolName") text(data, path, 256);
    else if (name === "approval" && typeof data !== "boolean") fail("invalid-approval-fact", path);
    else if (name === "model") {
        text(data, path, 256);
        member(value.scope, ["snapshot", "turn", "call", "subagent"], `${path}.scope`);
    } else if (name === "callElapsed") {
        if (!Number.isFinite(data) || data < 0 || value.unit !== "ms") fail("invalid-duration", path);
        text(value.boundary, `${path}.boundary`, 256);
        text(value.basis, `${path}.basis`, 256);
        if (value.comparableToUserResponseLatency !== false) fail("unqualified-timing-comparison", path);
    } else if (name === "failure") {
        shape(data, ["code", "messageStatus"], ["messageSignal", "reason", "diagnostic"], path);
        if (data.code !== null && (typeof data.code !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(data.code)
            || textFindings(data.code).some(f => f.mandatory || f.category === "opaque_identifiers"))) fail("unsafe-error-code", path);
        member(data.messageStatus, ["not-supplied", "text-excluded", "size-excluded", "sensitive-excluded", "unsupported-format", "recorded", "redacted"], path);
        if (data.reason !== undefined) member(data.reason, ["error-code-recorded", "error-details-excluded",
            "error-details-recorded", "result-content-excluded", "no-structured-error", "unsupported-error-format"], path);
        if (data.diagnostic !== undefined) {
            const checked = retainedErrorDiagnostic(data.diagnostic);
            if (!checked || checked.source !== "native-tool-error" || checked.status !== data.messageStatus
                || key(stable(checked)) !== key(stable(data.diagnostic))) fail("unqualified-native-diagnostic", path);
        } else if (["recorded", "redacted"].includes(data.messageStatus)) fail("native-diagnostic-required", path);
        if (data.messageSignal != null) {
            member(data.messageSignal, ["access-denial", "request-timeout", "pending-call-dropped-before-response"], path);
            if (data.messageStatus !== "text-excluded") fail("failure-signal-exclusion-conflict", path);
        }
    } else if (name === "resultEvidence") {
        const checked = normalizeResultEvidence(data);
        if (!checked || checked.source !== "native-tool-result"
            || checked.applicationError !== null || checked.statusCode !== null || checked.resultCount !== null
            || checked.diagnostic !== undefined || key(stable(checked)) !== key(stable(data))) fail("unqualified-native-result-evidence", path);
    } else if (name === "resultReferences") {
        shape(data, ["nativeField", "cardinality", "itemFieldTypes"], [], path);
        if (data.nativeField !== "wr") fail("unqualified-reference-channel", path);
        integer(data.cardinality, path);
        if (!object(data.itemFieldTypes)) fail("invalid-reference-shape", path);
        for (const [field, types] of Object.entries(data.itemFieldTypes)) {
            member(field, ["u", "t", "s", "tp", "d", "ic", "fn", "au", "did", "iid", "sl"], path);
            if (!object(types)) fail("invalid-reference-field-types", path);
            let count = 0;
            for (const [type, n] of Object.entries(types)) {
                member(type, ["string", "number", "boolean", "object", "array", "null"], path);
                integer(n, path); count += n;
            }
            if (count > data.cardinality) fail("reference-cardinality-conflict", path);
        }
    }
}
function nativeIdentity(record, surface, path, parserVersion) {
    if (!object(record)) fail("invalid-native-record", path);
    if (surface === "chat") {
        text(record.messageId, `${path}.messageId`);
        for (const name of ["storageMessageId", "requestId", "messageType", "splitChildStorageMessageId"]) {
            if (record[name] != null && record[name] !== "") text(record[name], `${path}.${name}`);
        }
        const stored = typeof record.storageMessageId === "string" && record.storageMessageId.length > 0;
        let calls = [];
        if (record.invocation !== undefined) {
            if (typeof record.invocation !== "string" || byteLength(record.invocation) > NATIVE_READ_LIMITS.textBytes) fail("unsupported-invocation", path);
            try {
                const outer = JSON.parse(record.invocation);
                assertJsonInput(outer, `${path}.invocation.decoded`);
                if (!Array.isArray(outer)) fail("unsupported-invocation", path);
                calls = outer.map(row => typeof row === "string" ? JSON.parse(row) : row);
                assertJsonInput(calls, `${path}.invocation.calls`);
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                fail("malformed-invocation", path);
            }
            for (const call of calls) {
                if (!object(call) || call.type !== "function" || !object(call.function)) fail("unsupported-invocation", path);
                text(call.id, path); text(call.function.name, path, 256);
            }
            if (new Set(calls.map(call => call.id)).size !== calls.length) fail("ambiguous-native-call-id", path);
        }
        const links = calls.map(call => ({ kind: "tool-call", nativeId: call.id, field: "invocation.id" }));
        if (record.splitChildStorageMessageId) links.push({ kind: "split-child-storage-reference",
            nativeId: record.splitChildStorageMessageId, field: "splitChildStorageMessageId", qualification: "unresolved-namespace" });
        return { namespace: stored ? "storage-message" : "message-observation", id: stored ? record.storageMessageId : record.messageId,
            observationId: record.messageId, nativeType: record.messageType || "ordinary", requestId: record.requestId ?? null,
            callIds: [...new Set(calls.map(call => call.id))],
            links,
            callSources: calls.map(call => ({ id: call.id, name: call.function.name, input: call.function.arguments,
                inputPresent: Object.hasOwn(call.function, "arguments") })) };
    }
    if (record.task) {
        text(record.task.sessionId, `${path}.task.sessionId`);
        const taskId = record.task.taskId == null || record.task.taskId === "" ? null : text(record.task.taskId, `${path}.task.taskId`);
        const threadIds = [...new Set([record.task.ic3ThreadId, record.snapshot?.ic3ThreadId].filter(value => value != null && value !== ""))];
        for (const threadId of threadIds) text(threadId, `${path}.threadId`);
        const links = record.task.parentConversationId ? [{ kind: "parent-conversation",
            nativeId: text(record.task.parentConversationId, `${path}.task.parentConversationId`), field: "task.parentConversationId" }] : [];
        return { namespace: taskId ? "task" : "session", id: taskId || record.task.sessionId, observationId: record.task.sessionId,
            taskId, sessionId: record.task.sessionId, threadIds,
            nativeType: "task-snapshot", requestId: null, callIds: [], links, callSources: [] };
    }
    text(record.id, `${path}.id`); text(record.event, `${path}.event`);
    if (!object(record.data)) fail("invalid-native-data", path);
    if (["ts", "tx"].includes(record.event) && record.data.tn != null) text(record.data.tn, `${path}.data.tn`, 256);
    const links = [];
    const add = (kind, field) => {
        if (record.data[field] == null || record.data[field] === "") return;
        links.push({ kind, nativeId: text(record.data[field], `${path}.data.${field}`), field });
    };
    if (["ts", "tx"].includes(record.event)) add("tool-call", "tid");
    if (["ts", "tx"].includes(record.event)) add("parent-tool-call", "pid");
    if (record.event === "u" || record.event === "a"
        && [NATIVE_COWORK_MESSAGE_AUTHOR_PARSER, NATIVE_COWORK_RESULT_FACTS_PARSER].includes(parserVersion)) add("message", "id");
    if (["th", "fr"].includes(record.event)) add("message", "mid");
    if (["ts", "th"].includes(record.event)) add("agent-reference", "aid");
    if (record.event === "ta") { add("approval", "aid"); add("tool-call", "tid"); }
    if (record.event === "taa") add("approval", "aid");
    if (["sa", "sx"].includes(record.event)) add("agent-announcement", "tid");
    return { namespace: "event", id: record.id, observationId: record.id, nativeType: record.event, requestId: null,
        callIds: ["ts", "tx"].includes(record.event) && record.data.tid ? [record.data.tid] : [], links,
        callSources: ["ts", "tx"].includes(record.event) && record.data.tid ? [{
            id: record.data.tid, name: record.data.tn, input: record.data.inp, inputPresent: Object.hasOwn(record.data, "inp"),
        }] : [] };
}
function outcome(value, unit, states, evidence, path) {
    shape(value, ["unit", "state", "basis"], ["aggregateToolSuccess"], path);
    if (value.unit !== unit) fail("outcome-unit-conflict", path);
    member(value.state, states, `${path}.state`); text(value.basis, `${path}.basis`, 256);
    if (value.aggregateToolSuccess !== undefined && value.aggregateToolSuccess !== false) fail("task-is-not-tool-aggregate", path);
    return { ...value, evidence: refs(evidence, `${path}.evidence`) };
}
function qualifiedFields(values, evidenceReferences, path, allowed = fieldNames) {
    if (!object(values) || !object(evidenceReferences)) fail("invalid-qualified-fields", path);
    const fields = {};
    for (const [name, value] of Object.entries(values)) {
        member(name, allowed, `${path}.qualifiedFields`);
        fields[name] = fact(value, evidenceReferences[name], `${path}.qualifiedFields.${name}`);
        const calendarInstant = validateField(name, fields[name], `${path}.qualifiedFields.${name}`);
        if (calendarInstant !== undefined) fields[name].calendarInstant = calendarInstant;
    }
    return fields;
}
function decodeNativeInput(value, path) {
    let decoded = value;
    if (typeof decoded === "string") {
        try { decoded = JSON.parse(decoded); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    assertJsonInput(decoded, path);
    return decoded;
}
function validateCallSourceFields(fields, callSource, scope, identity, path) {
    if (fields.toolName?.availability === "recorded" && fields.toolName.value !== callSource?.name) fail("native-tool-name-conflict", path);
    if (fields.input && scope.surface === "cowork" && identity.nativeType !== "ts") fail("input-source-record-unqualified", path);
    if (fields.input && (scope.surface === "chat" || identity.nativeType === "ts")) {
        const knownInput = ["recorded", "recorded-empty", "explicit-null"].includes(fields.input.availability);
        if (knownInput && !callSource?.inputPresent) fail("input-not-recorded-by-source", path);
        if (knownInput) {
            const decoded = decodeNativeInput(callSource.input, `${path}.qualifiedFields.input.decoded`);
            if (nativeValueHasCredentials(decoded, `${path}.qualifiedFields.input.decoded`)) fail("credential-bearing-fact", path);
            if (key(stable(fields.input.value)) !== key(stable(callSource.input))
                && key(stable(fields.input.value)) !== key(stable(decoded))) fail("input-source-conflict", path);
        }
        if (fields.input.availability === "absent-in-response" && callSource?.inputPresent) fail("input-absence-conflict", path);
    }
}
function validateObservationContext(envelope, path) {
    const scope = envelope.scope;
    shape(scope, ["harness", "surface", "account", "conversationId"], [], `${path}.scope`);
    if (scope.harness !== "microsoft-365-copilot") fail("unsupported-harness", path);
    member(scope.surface, ["chat", "cowork"], path);
    shape(scope.account, ["tenantId", "subjectId", "verification"], [], `${path}.scope.account`);
    text(scope.account.tenantId, path); text(scope.account.subjectId, path); text(scope.conversationId, path);
    member(scope.account.verification, ["verified", "unqualified", "conflicting"], `${path}.scope.account.verification`);
    shape(envelope.capture, ["captureId", "capturedAt", "generation", "parserVersion", "sourceSchema", "operation"], ["origin", "bodyDigest"], `${path}.capture`);
    for (const name of ["captureId", "parserVersion", "sourceSchema", "operation"]) text(envelope.capture[name], `${path}.capture.${name}`);
    if (typeof envelope.capture.capturedAt !== "string" || !Number.isFinite(Date.parse(envelope.capture.capturedAt))) fail("invalid-capture-time", path);
    integer(envelope.capture.generation, `${path}.capture.generation`);
    if (envelope.capture.origin !== undefined) {
        text(envelope.capture.origin, path);
        let origin;
        try { origin = new URL(envelope.capture.origin); } catch { fail("invalid-source-origin", path); }
        if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
            || !["", "/"].includes(origin.pathname)) fail("invalid-source-origin", path);
    }
    if (envelope.capture.bodyDigest !== undefined && !/^[a-f0-9]{64}$/.test(envelope.capture.bodyDigest)) fail("invalid-source-digest", path);
    shape(envelope.ordering, ["pageOrdinal", "recordOrdinal", "completeness"], ["frameOrdinal", "nativeEventId", "sequence", "sequenceScope"], `${path}.ordering`);
    for (const name of ["pageOrdinal", "recordOrdinal", "frameOrdinal", "sequence"]) if (envelope.ordering[name] !== undefined) integer(envelope.ordering[name], path);
    if (envelope.ordering.nativeEventId !== undefined) text(envelope.ordering.nativeEventId, path);
    if (envelope.ordering.sequenceScope !== undefined) member(envelope.ordering.sequenceScope, ["conversation", "request", "unknown"], path);
    member(envelope.ordering.completeness, ["response-only", "first-page-only", "drained-exposed-history", "gapped-domain-unqualified", "unknown"], path);
    return scope;
}
function validateObservationCoverage(coverage, path) {
    if (!Array.isArray(coverage) || coverage.length > 100) fail("invalid-coverage", path);
    for (const row of coverage) {
        shape(row, ["kind", "meaning"], ["subject", "path", "observedMissingIntegers", "inferredLostEvents"], `${path}.coverage`);
        text(row.kind, path, 100); text(row.meaning, path, 2048);
        for (const name of ["subject", "path"]) if (row[name] !== undefined) text(row[name], path, 2048);
        if (row.observedMissingIntegers !== undefined) integer(row.observedMissingIntegers, path);
        if (row.inferredLostEvents != null) fail("sequence-loss-not-established", path);
    }
}
function validateMessageTimeReferences(fields, chatSource, identity, path) {
    for (const [name, original] of messageTimeFields) if (fields[name]) {
        if (!chatSource) fail("message-time-source-unqualified", path);
        if (fields[name].evidence.some(reference => reference.sourceDocument !== chatSource.source.sourceDocument
            || reference.pointer !== `${chatSource.source.pointer}/${original}`
            || reference.nativeEventId !== undefined && reference.nativeEventId !== identity.observationId)) {
            fail("message-time-reference-conflict", path);
        }
    }
}
function validateObservationTimeReference(fields, scope, identity, path) {
    const value = fields.observationTime;
    if (!value) return;
    if (scope.surface !== "cowork" || identity.namespace !== "event") fail("observation-time-source-unqualified", path);
    const [reference] = value.evidence;
    if (value.evidence.length !== 1 || reference.nativeEventId !== identity.id
        || !reference.pointer.endsWith("/data/ts") || /~(?![01])/.test(reference.pointer)
        || reference.pointer.split("/").includes("*")) fail("observation-time-reference-conflict", path);
}
function validateNativeResultFields(fields, scope, identity, capture, path) {
    const diagnostic = fields.failure?.value?.diagnostic, result = fields.resultEvidence;
    if (!diagnostic && !result) return;
    if (scope.surface !== "cowork" || identity.nativeType !== "tx"
        || ![NATIVE_COWORK_LEGACY_RESULT_FACTS_PARSER, NATIVE_COWORK_RESULT_FACTS_PARSER].includes(capture.parserVersion)) {
        fail("native-result-source-unqualified", path);
    }
    const exactReference = ref => ref.nativeEventId === identity.id
        && !/~(?![01])/.test(ref.pointer) && !ref.pointer.split("/").includes("*");
    if (diagnostic) {
        if (diagnostic.code !== undefined || diagnostic.statusCode !== undefined || diagnostic.details !== undefined) {
            fail("native-error-format-unqualified", path);
        }
        if (fields.failure.evidence.length !== 1
            || fields.failure.evidence.some(ref => !exactReference(ref) || !ref.pointer.endsWith("/data/err"))) {
            fail("native-error-reference-unqualified", path);
        }
    }
    if (result) {
        if (result.availability !== "recorded") fail("native-result-source-unqualified", path);
        if (result.value.description !== undefined && capture.parserVersion !== NATIVE_COWORK_RESULT_FACTS_PARSER) {
            fail("native-description-source-unqualified", path);
        }
        if (result.evidence.length > 2 || result.evidence.some(ref => !exactReference(ref) || !/\/data(?:\/out|\/d)?$/.test(ref.pointer))
            || new Set(result.evidence.map(ref => key(ref.sourceDocument, ref.pointer.replace(/\/(?:out|d)$/, "")))).size !== 1
            || new Set(result.evidence.map(ref => ref.pointer)).size !== result.evidence.length) {
            fail("native-result-reference-unqualified", path);
        }
        const outputRecorded = !["not-supplied", "unsupported-format"].includes(result.value.contentStatus);
        const descriptionRecorded = result.value.description && result.value.description.status !== "not-supplied";
        if (outputRecorded && !result.evidence.some(ref => ref.pointer.endsWith("/data/out"))
            || descriptionRecorded && !result.evidence.some(ref => ref.pointer.endsWith("/data/d"))) {
            fail("native-result-reference-unqualified", path);
        }
    }
}
function validateEnvelope(envelope, index) {
    const path = `$[${index}]`;
    shape(envelope, ["contractVersion", "scope", "capture", "record", "ordering", "qualifiedFields", "evidenceReferences", "coverage"], ["outcomes", "checkpoint", "callFacts", "chatSource", "messageParts"], path);
    if (envelope.contractVersion !== NATIVE_READ_CONTRACT) fail("unsupported-contract", path);
    const scope = validateObservationContext(envelope, path);
    if (!object(envelope.qualifiedFields) || !object(envelope.evidenceReferences)) fail("invalid-qualified-fields", path);
    shape(envelope.evidenceReferences, [], [...fieldNames, "taskOutcome", "toolOutcome", "returnedResults"], `${path}.evidenceReferences`);
    const fields = qualifiedFields(envelope.qualifiedFields, envelope.evidenceReferences, path);
    validateObservationCoverage(envelope.coverage, path);
    const identity = nativeIdentity(envelope.record, scope.surface, `${path}.record`, envelope.capture.parserVersion);
    validateNativeResultFields(fields, scope, identity, envelope.capture, path);
    validateObservationTimeReference(fields, scope, identity, path);
    if (fields.observationTime) {
        const value = fields.observationTime, present = Object.hasOwn(envelope.record.data, "ts");
        if (["recorded", "recorded-empty", "explicit-null"].includes(value.availability)
            && (!present || value.value !== envelope.record.data.ts)
            || value.availability === "absent-in-response" && present) fail("observation-time-source-conflict", path);
    }
    if (nativeValueHasCredentials(envelope.record, `${path}.record`)) fail("credential-bearing-native-carrier", `${path}.record`);
    const messageParts = [];
    if (envelope.messageParts !== undefined) {
        if (scope.surface !== "cowork" || !["rc", "aq", "aa"].includes(identity.nativeType)
            || !Array.isArray(envelope.messageParts) || envelope.messageParts.length > 256) fail("unsupported-message-parts", `${path}.messageParts`);
        if (envelope.messageParts.length && fields.message) fail("duplicate-message-location", path);
        const seen = new Set();
        for (const [ordinal, part] of envelope.messageParts.entries()) {
            const at = `${path}.messageParts[${ordinal}]`;
            shape(part, ["message", "evidence"], [], at);
            if (!object(part.evidence)) fail("message-part-single-reference-required", at);
            const message = fact(part.message, part.evidence, `${at}.message`);
            validateField("message", message, `${at}.message`);
            if (message.availability === "recorded" && message.value.author !== "unknown") fail("message-part-author-unqualified", at);
            const reference = message.evidence[0];
            if (reference.nativeEventId !== identity.id) fail("message-part-source-event-conflict", at);
            if (/~(?![01])/.test(reference.pointer) || reference.pointer.split("/").includes("*")) fail("message-part-exact-pointer-required", at);
            const identityKey = key(reference.sourceDocument, reference.pointer, message.value?.representation ?? null);
            if (seen.has(identityKey)) fail("duplicate-message-part", at);
            seen.add(identityKey);
            messageParts.push(message);
        }
    }
    if (envelope.chatSource !== undefined && nativeValueHasCredentials(envelope.chatSource, `${path}.chatSource`)) {
        fail("chat-source-credential-bearing-fact", `${path}.chatSource`);
    }
    const chatSource = envelope.chatSource === undefined ? undefined
        : validateNativeChatSource(envelope.chatSource, envelope, `${path}.chatSource`, fail);
    validateMessageTimeReferences(fields, chatSource, identity, path);
    for (const [name, original] of messageTimeFields) if (fields[name]) {
        const value = fields[name], present = Object.hasOwn(envelope.record, original);
        if (["recorded", "recorded-empty", "explicit-null"].includes(value.availability)
            && (!present || value.value !== envelope.record[original])
            || value.availability === "absent-in-response" && present) fail("message-time-source-conflict", path);
    }
    if (chatSource && identity.callSources.length) {
        for (const [index, row] of chatSource.observations.entries()) if (row.kind === "native-invocation") {
            const source = identity.callSources[Number(row.source.decodedPointer.slice(1))];
            const at = `${path}.chatSource.observations[${index}]`;
            if (!source || row.fields.nativeCallId.availability !== "recorded" || row.fields.nativeCallId.value !== source.id) {
                fail("chat-source-native-call-conflict", at);
            }
            validateCallSourceFields({ toolName: row.fields.toolName, input: row.fields.input }, source, scope, identity, at);
        }
    }
    if (identity.namespace === "event" && envelope.ordering.nativeEventId !== undefined
        && envelope.ordering.nativeEventId !== identity.id) fail("order-event-identity-conflict", path);
    if (identity.namespace === "event" && /^seq:\d+$/.test(identity.id) && envelope.ordering.sequence !== undefined
        && envelope.ordering.sequence !== Number(identity.id.slice(4))) fail("order-sequence-conflict", path);
    if (identity.callSources.length > 1 && (Object.keys(fields).some(name => !["message", "approval"].includes(name) && !messageTimeFields.has(name)
        && !(name === "model" && ["snapshot", "turn"].includes(fields.model.scope)))
        || envelope.outcomes?.tool || envelope.outcomes?.nestedApi)) fail("ambiguous-call-facts", path);
    validateCallSourceFields(fields, identity.callSources[0], scope, identity, path);
    const callFacts = [];
    if (envelope.callFacts !== undefined) {
        if (scope.surface !== "chat" || !Array.isArray(envelope.callFacts) || envelope.callFacts.length > 100) fail("unsupported-call-facts", path);
        const seen = new Set();
        for (const [ordinal, row] of envelope.callFacts.entries()) {
            const at = `${path}.callFacts[${ordinal}]`;
            shape(row, ["nativeCallId", "qualifiedFields", "evidenceReferences"], [], at);
            text(row.nativeCallId, `${at}.nativeCallId`);
            if (seen.has(row.nativeCallId)) fail("duplicate-call-facts", at);
            seen.add(row.nativeCallId);
            const source = identity.callSources.find(call => call.id === row.nativeCallId);
            if (!source) fail("call-facts-identity-not-in-source", at);
            shape(row.evidenceReferences, [], ["toolName", "input"], `${at}.evidenceReferences`);
            const individual = qualifiedFields(row.qualifiedFields, row.evidenceReferences, at, ["toolName", "input"]);
            if (Object.keys(individual).some(name => fields[name])) fail("duplicate-call-fact-location", at);
            validateCallSourceFields(individual, source, scope, identity, at);
            callFacts.push({ nativeCallId: row.nativeCallId, fields: individual });
        }
    }
    const nativeInputs = scope.surface === "cowork" && identity.nativeType === "ts" && Object.hasOwn(envelope.record.data, "inp")
        ? [envelope.record.data.inp] : identity.callSources.filter(source => source.inputPresent).map(source => source.input);
    for (const input of nativeInputs) {
        if (nativeValueHasCredentials(decodeNativeInput(input, `${path}.record.input.decoded`), `${path}.record.input.decoded`)) {
            fail("credential-bearing-native-carrier", `${path}.record`);
        }
    }
    if (fields.approval && (scope.surface !== "cowork" || identity.nativeType !== "taa"
        || fields.approval.availability !== "recorded" || fields.approval.value !== envelope.record.data.approved)) fail("approval-not-established", path);
    if (fields.message?.availability === "recorded" && scope.surface === "chat") {
        const actor = { user: "user", bot: "assistant", tool: "tool" }[envelope.record.author] || "unknown";
        if (fields.message.value.author !== actor) fail("native-message-author-conflict", path);
    }
    if (fields.resultReferences?.availability === "recorded" && Object.hasOwn(envelope.record.data || {}, "wr")) {
        const raw = envelope.record.data.wr;
        if (!Array.isArray(raw) || raw.length !== fields.resultReferences.value.cardinality) fail("reference-source-cardinality-conflict", path);
    }
    if (envelope.checkpoint !== undefined) {
        shape(envelope.checkpoint, ["status", "operation", "selector", "direction", "privateContinuationRef", "generation"],
            ["lastObservedEventId", "committedCursor", "stableHeadQualified"], `${path}.checkpoint`);
        integer(envelope.checkpoint.generation, path);
        if (envelope.checkpoint.committedCursor != null) fail("cursor-not-reader-data", path);
    }
    const outcomes = {}, supplied = envelope.outcomes || {};
    shape(supplied, [], ["task", "tool", "nestedApi"], `${path}.outcomes`);
    if (supplied.task) {
        const sourceState = envelope.record.task?.state;
        if (identity.nativeType !== "task-snapshot") fail("task-outcome-source-unqualified", path);
        if (identity.nativeType === "task-snapshot" && supplied.task.state !== (sourceState || "unknown")) fail("native-task-state-conflict", path);
        outcomes.task = outcome(supplied.task, "native-task",
            ["running", "needs_user_input", "pending_activity", "completed", "failed", "cancelled", "unknown"],
            envelope.evidenceReferences.taskOutcome, `${path}.outcomes.task`);
    }
    if (supplied.tool) {
        const actual = scope.surface === "cowork" && identity.nativeType === "tx"
            ? envelope.record.data.ok === true ? "succeeded" : envelope.record.data.ok === false ? "failed" : "unknown" : "unknown";
        if (!identity.callIds.length || supplied.tool.state !== actual) fail("native-tool-outcome-not-established", path);
        outcomes.tool = outcome(supplied.tool, "native-tool", ["succeeded", "failed", "cancelled", "unknown"],
            envelope.evidenceReferences.toolOutcome, `${path}.outcomes.tool`);
    }
    if (supplied.nestedApi) {
        const nested = supplied.nestedApi;
        shape(nested, ["unit", "availability", "observed", "declaredRequestCount", "declaredRequestCountIsSuccessDenominator"], [], `${path}.outcomes.nestedApi`);
        if (nested.unit !== "nested-api-result" || nested.declaredRequestCountIsSuccessDenominator !== false) fail("nested-unit-or-denominator-conflict", path);
        member(nested.availability, availability, path);
        if (nested.declaredRequestCount !== null) integer(nested.declaredRequestCount, path);
        if (!Array.isArray(nested.observed) || nested.observed.length > 100) fail("invalid-returned-results", path);
        if (nested.observed.length && nested.availability !== "recorded") fail("returned-result-availability-conflict", path);
        for (const row of nested.observed) {
            shape(row, ["index", "indexKind", "statusCode", "errorCode", "paginationPresent", "evidenceLevel"], [], path);
            integer(row.index, path);
            if (row.indexKind !== "response-array-position" || row.evidenceLevel !== "intermediary-reported") fail("unqualified-returned-result", path);
            if (row.statusCode !== null && (!Number.isInteger(row.statusCode) || row.statusCode < 100 || row.statusCode > 599)) fail("invalid-status", path);
            if (row.errorCode !== null && (typeof row.errorCode !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(row.errorCode)
                || textFindings(row.errorCode).some(f => f.mandatory || f.category === "opaque_identifiers"))) fail("unsafe-error-code", path);
            if (row.paginationPresent !== null && row.paginationPresent !== true) fail("unknown-pagination-is-not-false", path);
        }
        outcomes.nestedApi = { ...nested, evidence: refs(envelope.evidenceReferences.returnedResults, `${path}.outcomes.nestedApi`) };
    }
    const { callSources, ...publicIdentity } = identity;
    publicIdentity.nativeCalls = callSources.map(call => {
        const nameFact = callFacts.find(row => row.nativeCallId === call.id)?.fields.toolName || fields.toolName;
        return { nativeCallId: call.id,
            nativeToolName: !nameFact || nameFact.availability === "recorded" ? call.name ?? null : null };
    });
    return { scope, capture: envelope.capture, ordering: envelope.ordering, identity: publicIdentity, fields, outcomes, callFacts, coverage: envelope.coverage,
        ...(chatSource ? { chatSource } : {}), ...(envelope.messageParts !== undefined ? { messageParts } : {}) };
}

/** Attach already-decoded source facts, without importing or activating a decoder. */
export function retainNativeChatSourceObservations(decoded) {
    assertJsonInput(decoded);
    const value = JSON.parse(JSON.stringify(decoded));
    shape(value, ["status", "parserProvenance", "admission", "provenance", "envelopes", "sourceObservations", "limitations"], [], "$");
    if (value.status !== "inactive" || key(stable(value.admission)) !== key(stable(nativeWriterAdmission()))) fail("chat-source-admission-conflict", "$");
    shape(value.provenance, ["scope", "capture", "ordering", "source"], ["identity"], "$.provenance");
    if (!Array.isArray(value.envelopes) || value.envelopes.length !== 1 || !value.provenance.identity) fail("chat-source-carrier-required", "$.envelopes");
    const envelope = value.envelopes[0];
    if (!object(envelope)) fail("chat-source-carrier-required", "$.envelopes[0]");
    if (envelope.chatSource !== undefined) fail("chat-source-already-attached", "$.envelopes[0]");
    for (const field of ["scope", "capture", "ordering"]) {
        if (key(stable(envelope[field])) !== key(stable(value.provenance[field]))) fail("chat-source-provenance-conflict", `$.provenance.${field}`);
    }
    const enriched = { ...envelope, chatSource: {
        schemaVersion: 1, parserProvenance: value.parserProvenance,
        source: value.provenance.source, identity: value.provenance.identity,
        observations: value.sourceObservations, limitations: value.limitations,
    } };
    projectNativeReadModel([enriched]);
    return [enriched];
}

function sourceObservationRecords(envelopes) {
    if (!Array.isArray(envelopes) || envelopes.length > NATIVE_READ_LIMITS.records) fail("invalid-record-batch", "$");
    assertJsonInput(envelopes);
    let serialized;
    try {
        serialized = JSON.stringify(envelopes, (_, value) => {
            if (value === undefined || ["function", "symbol", "bigint"].includes(typeof value)
                || typeof value === "number" && !Number.isFinite(value)) fail("non-json-value", "$");
            return value;
        });
    } catch (error) {
        if (error instanceof NativeReadModelError) throw error;
        fail("non-json-input", "$");
    }
    if (byteLength(serialized) > NATIVE_READ_LIMITS.bytes) fail("record-byte-bound", "$");
    const records = JSON.parse(serialized).map(validateEnvelope);
    if (records.reduce((count, record) => count + (record.fields.message ? 1 : 0) + (record.messageParts?.length ?? 0), 0) > NATIVE_READ_LIMITS.records) {
        fail("message-view-count-bound", "$");
    }
    return records;
}

function projectObservationRecords(records, inputOrdinals) {
    const conversations = new Map(), seenObservations = new Map();
    let partBytes = 0;
    for (const [index, record] of records.entries()) {
        const ordinal = inputOrdinals ? inputOrdinals[index] : index;
        const { scope, identity } = record;
        const scopeParts = ["m365-native-v0", scope.surface, scope.account.tenantId, scope.account.subjectId, scope.conversationId];
        const conversationKey = nativeConversationIdentity(scope);
        if (!conversations.has(conversationKey)) conversations.set(conversationKey, {
            key: conversationKey, scope, observations: [], messages: [], calls: [], taskOutcomes: [], resultReferences: [],
            returnedResults: [], measurements: [], coverage: [], callMap: new Map(), sourceVerification: [],
        });
        const conversation = conversations.get(conversationKey);
        const sourceKey = key(...scopeParts, identity.namespace, identity.id);
        const capturedObservationKey = key(sourceKey, identity.observationId, record.capture.captureId, record.ordering.pageOrdinal,
            record.ordering.frameOrdinal ?? null, record.ordering.recordOrdinal, record.fields.message?.value?.representation ?? null);
        const observationKey = record.retention ? key("native-retained-observation", sourceKey, identity.observationId, record.retention.variant)
            : capturedObservationKey;
        const retention = record.retention ? { retention: record.retention } : {};
        const fingerprint = key(stable(record));
        if (seenObservations.has(observationKey)) {
            if (seenObservations.get(observationKey) !== fingerprint) fail("conflicting-observation-identity", `$[${ordinal}]`);
            continue;
        }
        seenObservations.set(observationKey, fingerprint);
        const { chatSource, messageParts, ...carrier } = record;
        const parts = (messageParts ?? []).map(message => {
            const reference = message.evidence[0];
            const viewKey = key("native-message-part", observationKey, reference.sourceDocument, reference.pointer, message.value?.representation ?? null);
            const part = { ...message, sourceKey, observationKey: viewKey, parentObservationKey: observationKey, ...retention,
                unit: "message-representation-part", identityBasis: "derived-source-part-view" };
            partBytes += byteLength(JSON.stringify(part)) + byteLength(JSON.stringify(viewKey));
            if (partBytes > NATIVE_READ_LIMITS.bytes) fail("message-part-byte-bound", "$");
            return part;
        });
        const observation = { ...carrier, sourceKey, observationKey, inputOrdinal: ordinal,
            ...(record.retention ? { capturedObservationKey } : {}),
            ...(parts.length ? { messagePartKeys: parts.map(part => part.observationKey) } : {}) };
        if (chatSource) {
            conversation.sourceObservations ??= [];
            conversation.sourceObservations.push({
                observationKey, sourceKey, unit: "chat-source-observation-set", status: "source-facts-only",
                ...retention,
                parserProvenance: chatSource.parserProvenance, source: chatSource.source, identity: chatSource.identity,
                decoderLimitations: chatSource.limitations,
                facts: chatSource.observations.map(({ readModel, ...fact }) => ({
                    ...fact, key: key("chat-source-observation", observationKey, fact.kind,
                        fact.source.sourceDocument, fact.source.pointer, fact.source.decodedPointer ?? null),
                    ...(readModel ? { decoderReadModel: readModel } : {}),
                })),
            });
        }
        if (!conversation.sourceVerification.includes(scope.account.verification)) conversation.sourceVerification.push(scope.account.verification);
        conversation.observations.push(observation);
        conversation.coverage.push(...record.coverage);
        if (record.fields.message) conversation.messages.push({ observationKey: observation.observationKey, sourceKey, ...record.fields.message, ...retention });
        conversation.messages.push(...parts);
        if (record.outcomes.task) conversation.taskOutcomes.push({ observationKey: observation.observationKey, ...record.outcomes.task });
        const callKeys = identity.callIds.map(callId => key(...scopeParts, "tool-call", callId));
        const callFields = Object.fromEntries(Object.entries(record.fields).filter(([name]) => !messageTimeFields.has(name)));
        if (record.fields.resultReferences) conversation.resultReferences.push({ observationKey: observation.observationKey, callKeys,
            unit: "source-result-reference-entry", ...record.fields.resultReferences });
        if (record.outcomes.nestedApi) conversation.returnedResults.push({ observationKey: observation.observationKey, callKeys, ...record.outcomes.nestedApi });
        if (record.fields.callElapsed) conversation.measurements.push({ observationKey: observation.observationKey, ...record.fields.callElapsed });
        for (const callId of identity.callIds) {
            const callKey = key(...scopeParts, "tool-call", callId);
            if (!conversation.callMap.has(callKey)) {
                const call = { key: callKey, nativeCallId: callId, observations: [] };
                conversation.callMap.set(callKey, call); conversation.calls.push(call);
            }
            const individual = record.callFacts.find(row => row.nativeCallId === callId)?.fields || {};
            const { callFacts, ...sharedObservation } = observation;
            const nativeCall = identity.nativeCalls.find(call => call.nativeCallId === callId);
            conversation.callMap.get(callKey).observations.push({
                ...sharedObservation, nativeCallId: callId,
                nativeToolName: nativeCall.nativeToolName,
                identity: identity.callIds.length > 1 ? { ...identity, callIds: [callId], nativeCalls: [nativeCall],
                    links: identity.links.filter(link => link.kind !== "tool-call" || link.nativeId === callId) } : identity,
                fields: identity.callIds.length > 1 ? individual : { ...callFields, ...individual },
                outcomes: identity.callIds.length > 1 ? {} : record.outcomes,
            });
        }
    }
    return { contractVersion: NATIVE_READ_CONTRACT, admission: nativeWriterAdmission(),
        conversations: [...conversations.values()].map(({ callMap, ...row }) => ({
            ...row, scope: { ...row.scope, account: { ...row.scope.account,
                verification: row.sourceVerification.length === 1 ? row.sourceVerification[0] : "conflicting" } },
            calls: row.calls.map(call => {
                const names = [...new Set(call.observations.flatMap(observation =>
                    observation.nativeToolName === null ? [] : [observation.nativeToolName]))];
                const states = [...new Set(call.observations.flatMap(observation =>
                    observation.outcomes.tool && observation.outcomes.tool.state !== "unknown" ? [observation.outcomes.tool.state] : []))];
                return { ...call, nativeToolNames: names,
                    outcome: { unit: "native-tool", state: states.length === 1 ? states[0] : "unknown",
                        qualification: states.length > 1 ? "conflicting-native-outcomes" : states.length ? "recorded-native-outcome" : "unqualified" },
                    conflicts: [...(names.length > 1 ? ["native-tool-name-conflict"] : []),
                        ...(states.length > 1 ? ["native-tool-outcome-conflict"] : [])] };
            }),
        })),
        definitions: nativeDefinitions({ messageParts: records.some(record => record.messageParts?.length),
            chatSource: records.some(record => record.chatSource) }) };
}

/** Input is already source-qualified and backend-authorized. This is not an access or capture owner. */
export function projectNativeReadModel(envelopes) {
    return projectObservationRecords(sourceObservationRecords(envelopes));
}

export function normalizeNativeSourceObservations(envelopes) {
    const records = sourceObservationRecords(envelopes);
    projectObservationRecords(records);
    screenRetainedValue(records, "$", "normalize-batch");
    return { contractVersion: NATIVE_RETAINED_CONTRACT, records };
}

function retainedFields(values, path, allowed = fieldNames) {
    if (!object(values)) fail("invalid-retained-fields", path);
    const input = {}, evidence = {};
    for (const [name, value] of Object.entries(values)) {
        if (!object(value) || !Object.hasOwn(value, "evidence")) fail("retained-evidence-required", path);
        const { evidence: references, ...field } = value;
        if (messageTimeFields.has(name) || name === "observationTime") {
            const { calendarInstant, ...original } = field;
            const expected = original.availability === "recorded" ? name === "observationTime"
                ? normalizeNativeObservationTime(original.value, original.unit, path) : normalizeNativeMessageTime(original.value, path) : undefined;
            if (Object.hasOwn(field, "calendarInstant") !== (expected !== undefined) || calendarInstant !== expected) {
                fail(name === "observationTime" ? "retained-observation-time-conflict" : "retained-message-time-conflict", path);
            }
            input[name] = original;
        } else input[name] = field;
        evidence[name] = references;
    }
    return qualifiedFields(input, evidence, path, allowed);
}

function retainedIdentity(value, scope, path) {
    shape(value, ["namespace", "id", "observationId", "nativeType", "requestId", "callIds", "links", "nativeCalls"],
        ["taskId", "sessionId", "threadIds"], path);
    member(value.namespace, scope.surface === "chat" ? ["storage-message", "message-observation"] : ["event", "task", "session"], path);
    for (const name of ["id", "observationId", "nativeType"]) text(value[name], `${path}.${name}`);
    if (value.requestId !== null) text(value.requestId, `${path}.requestId`);
    if (!Array.isArray(value.callIds) || value.callIds.length > 100 || new Set(value.callIds).size !== value.callIds.length
        || !Array.isArray(value.nativeCalls) || value.nativeCalls.length !== value.callIds.length) fail("invalid-retained-call-identities", path);
    for (const id of value.callIds) text(id, path);
    if (scope.surface === "cowork" && value.namespace === "event"
        && (value.callIds.length > 1 || value.callIds.length && !["ts", "tx"].includes(value.nativeType))) {
        fail("retained-call-source-conflict", path);
    }
    const names = new Set();
    for (const call of value.nativeCalls) {
        shape(call, ["nativeCallId", "nativeToolName"], [], path);
        if (!value.callIds.includes(call.nativeCallId) || names.has(call.nativeCallId)) fail("invalid-retained-call-identities", path);
        names.add(call.nativeCallId);
        if (call.nativeToolName !== null) text(call.nativeToolName, path, 256);
    }
    if (!Array.isArray(value.links) || value.links.length > 200) fail("invalid-retained-links", path);
    for (const link of value.links) {
        shape(link, ["kind", "nativeId", "field"], ["qualification"], path);
        member(link.kind, ["tool-call", "parent-tool-call", "split-child-storage-reference", "parent-conversation", "message",
            "agent-reference", "approval", "agent-announcement"], path);
        for (const name of ["nativeId", "field"]) text(link[name], path);
        if (link.qualification !== undefined) text(link.qualification, path, 256);
        if (link.kind === "tool-call" && !value.callIds.includes(link.nativeId)
            && !(scope.surface === "cowork" && value.nativeType === "ta")) fail("retained-call-link-conflict", path);
    }
    if (value.callIds.some(id => !value.links.some(link => link.kind === "tool-call" && link.nativeId === id
        && link.field === (scope.surface === "chat" ? "invocation.id" : "tid")))) fail("retained-call-link-conflict", path);
    if (["task", "session"].includes(value.namespace)) {
        if (scope.surface !== "cowork" || value.nativeType !== "task-snapshot" || value.callIds.length
            || !Object.hasOwn(value, "taskId") || !Object.hasOwn(value, "sessionId") || !Array.isArray(value.threadIds)) {
            fail("retained-task-identity-conflict", path);
        }
        text(value.sessionId, path);
        if (value.taskId !== null) text(value.taskId, path);
        if ((value.namespace === "task") !== (value.taskId !== null)) fail("retained-task-identity-conflict", path);
        if (value.id !== (value.taskId ?? value.sessionId) || value.observationId !== value.sessionId) fail("retained-task-identity-conflict", path);
        for (const id of value.threadIds) text(id, path);
    } else if (["taskId", "sessionId", "threadIds"].some(name => Object.hasOwn(value, name))) fail("retained-task-identity-conflict", path);
    if (value.namespace === "message-observation" && value.id !== value.observationId
        || value.namespace === "event" && value.id !== value.observationId) fail("retained-observation-identity-conflict", path);
    return value;
}

function retainedOutcomes(value, identity, scope, path) {
    shape(value, [], ["task", "tool", "nestedApi"], path);
    const output = {};
    for (const name of ["task", "tool"]) if (value[name]) {
        const { evidence, ...item } = value[name];
        if (name === "task" && identity.nativeType !== "task-snapshot"
            || name === "tool" && !identity.callIds.length) fail("retained-outcome-source-conflict", path);
        output[name] = outcome(item, name === "task" ? "native-task" : "native-tool",
            name === "task" ? ["running", "needs_user_input", "pending_activity", "completed", "failed", "cancelled", "unknown"]
                : ["succeeded", "failed", "unknown"], evidence, path);
        if (name === "tool" && item.state !== "unknown" && (scope.surface !== "cowork" || identity.nativeType !== "tx")) {
            fail("retained-outcome-source-conflict", path);
        }
    }
    if (value.nestedApi) {
        const { evidence, ...nested } = value.nestedApi;
        shape(nested, ["unit", "availability", "observed", "declaredRequestCount", "declaredRequestCountIsSuccessDenominator"], [], path);
        if (nested.unit !== "nested-api-result" || nested.declaredRequestCountIsSuccessDenominator !== false) fail("nested-unit-or-denominator-conflict", path);
        member(nested.availability, availability, path);
        if (nested.declaredRequestCount !== null) integer(nested.declaredRequestCount, path);
        if (!Array.isArray(nested.observed) || nested.observed.length > 100) fail("invalid-returned-results", path);
        for (const row of nested.observed) {
            shape(row, ["index", "indexKind", "statusCode", "errorCode", "paginationPresent", "evidenceLevel"], [], path);
            integer(row.index, path);
            if (row.indexKind !== "response-array-position" || row.evidenceLevel !== "intermediary-reported") fail("unsupported-result-evidence", path);
            if (row.statusCode !== null && (!Number.isInteger(row.statusCode) || row.statusCode < 100 || row.statusCode > 599)) fail("invalid-status", path);
            if (row.errorCode !== null && (typeof row.errorCode !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(row.errorCode)
                || textFindings(row.errorCode).some(f => f.mandatory || f.category === "opaque_identifiers"))) fail("unsafe-error-code", path);
            if (row.paginationPresent !== null && row.paginationPresent !== true) fail("unknown-pagination-is-not-false", path);
        }
        output.nestedApi = { ...nested, evidence: refs(evidence, path) };
    }
    return output;
}

function retainedObservation(value, index) {
    const path = `$retained[${index}]`;
    shape(value, ["scope", "capture", "ordering", "identity", "fields", "outcomes", "callFacts", "coverage"],
        ["chatSource", "messageParts", "retention"], path);
    const scope = validateObservationContext(value, path);
    validateObservationCoverage(value.coverage, path);
    const identity = retainedIdentity(value.identity, scope, `${path}.identity`);
    if (identity.namespace === "event" && value.ordering.nativeEventId !== undefined
        && value.ordering.nativeEventId !== identity.id) fail("order-event-identity-conflict", path);
    if (identity.namespace === "event" && /^seq:\d+$/.test(identity.id) && value.ordering.sequence !== undefined
        && value.ordering.sequence !== Number(identity.id.slice(4))) fail("order-sequence-conflict", path);
    const fields = retainedFields(value.fields, path);
    validateNativeResultFields(fields, scope, identity, value.capture, path);
    const outcomes = retainedOutcomes(value.outcomes, identity, scope, `${path}.outcomes`);
    if (identity.callIds.length > 1 && (Object.keys(fields).some(name => !["message", "approval"].includes(name) && !messageTimeFields.has(name)
        && !(name === "model" && ["snapshot", "turn"].includes(fields.model.scope))) || outcomes.tool || outcomes.nestedApi)) {
        fail("ambiguous-call-facts", path);
    }
    if (fields.input && scope.surface === "cowork" && identity.nativeType !== "ts") fail("input-source-record-unqualified", path);
    if (!identity.callIds.length && (fields.toolName?.availability === "recorded"
        || ["recorded", "recorded-empty", "explicit-null"].includes(fields.input?.availability))) {
        fail("retained-call-source-conflict", path);
    }
    if (fields.approval && (scope.surface !== "cowork" || identity.nativeType !== "taa" || fields.approval.availability !== "recorded")) {
        fail("approval-not-established", path);
    }
    const callFacts = [];
    if (!Array.isArray(value.callFacts) || value.callFacts.length > 100) fail("unsupported-call-facts", path);
    const seenCalls = new Set();
    for (const item of value.callFacts) {
        shape(item, ["nativeCallId", "fields"], [], path);
        if (scope.surface !== "chat" || !identity.callIds.includes(item.nativeCallId) || seenCalls.has(item.nativeCallId)) fail("invalid-retained-call-fact", path);
        seenCalls.add(item.nativeCallId);
        const individual = retainedFields(item.fields, path, ["toolName", "input"]);
        if (Object.keys(individual).some(name => fields[name])) fail("duplicate-call-fact-location", path);
        callFacts.push({ nativeCallId: item.nativeCallId, fields: individual });
    }
    for (const call of identity.nativeCalls) {
        const name = callFacts.find(item => item.nativeCallId === call.nativeCallId)?.fields.toolName ?? fields.toolName;
        if (name?.availability === "recorded" && name.value !== call.nativeToolName
            || name && name.availability !== "recorded" && call.nativeToolName !== null) fail("native-tool-name-conflict", path);
    }
    let chatSource;
    if (value.chatSource !== undefined) {
        const originalType = value.chatSource.identity?.messageType;
        const record = { messageId: identity.observationId,
            ...(identity.namespace === "storage-message" ? { storageMessageId: identity.id } : {}),
            ...(identity.requestId !== null ? { requestId: identity.requestId } : {}),
            ...(identity.nativeType !== "ordinary" || originalType?.availability === "recorded"
                ? { messageType: identity.nativeType } : {}) };
        const child = identity.links.find(link => link.kind === "split-child-storage-reference");
        if (child) record.splitChildStorageMessageId = child.nativeId;
        chatSource = validateNativeChatSource(value.chatSource, { scope, record, capture: value.capture, ordering: value.ordering },
            `${path}.chatSource`, fail);
        for (const item of chatSource.observations) if (item.kind === "native-invocation" && identity.nativeCalls.length) {
            const call = identity.nativeCalls[Number(item.source.decodedPointer.slice(1))];
            if (!call || item.fields.nativeCallId.availability !== "recorded" || item.fields.nativeCallId.value !== call.nativeCallId) {
                fail("chat-source-native-call-conflict", path);
            }
        }
    }
    validateMessageTimeReferences(fields, chatSource, identity, path);
    validateObservationTimeReference(fields, scope, identity, path);
    let messageParts;
    if (value.messageParts !== undefined) {
        if (scope.surface !== "cowork" || !["rc", "aq", "aa"].includes(identity.nativeType)
            || !Array.isArray(value.messageParts) || value.messageParts.length > 256 || value.messageParts.length && fields.message) {
            fail("unsupported-message-parts", path);
        }
        const seen = new Set();
        messageParts = value.messageParts.map(item => {
            const { evidence, ...data } = item;
            const message = fact(data, evidence, path);
            validateField("message", message, path);
            if (message.evidence.length !== 1 || message.evidence[0].nativeEventId !== identity.id
                || message.availability === "recorded" && message.value.author !== "unknown") fail("message-part-source-event-conflict", path);
            const reference = message.evidence[0];
            if (/~(?![01])/.test(reference.pointer) || reference.pointer.split("/").includes("*")) fail("message-part-exact-pointer-required", path);
            const id = key(reference.sourceDocument, reference.pointer, message.value?.representation ?? null);
            if (seen.has(id)) fail("duplicate-message-part", path);
            seen.add(id);
            return message;
        });
    }
    if (value.retention !== undefined) {
        shape(value.retention, ["variant", "current", "captureCount"], [], path);
        if (!/^[a-f0-9]{64}$/.test(value.retention.variant) || typeof value.retention.current !== "boolean"
            || !Number.isSafeInteger(value.retention.captureCount) || value.retention.captureCount < 1) fail("invalid-retained-variant", path);
    }
    return { scope, capture: value.capture, ordering: value.ordering, identity, fields, outcomes, callFacts, coverage: value.coverage,
        ...(chatSource ? { chatSource } : {}), ...(messageParts ? { messageParts } : {}),
        ...(value.retention ? { retention: value.retention } : {}) };
}

export function projectNativeRetainedObservations(value) {
    shape(value, ["contractVersion", "records"], ["readback"], "$retained");
    if (value.contractVersion !== NATIVE_RETAINED_CONTRACT) fail("unsupported-retained-contract", "$retained");
    if (!Array.isArray(value.records) || value.records.length > NATIVE_READ_LIMITS.records) fail("native-retained-read-bound", "$retained");
    screenRetainedValue(value, "$retained", "project-retained-read");
    if (value.readback !== undefined) validateNativeReadback(value.readback);
    const records = JSON.parse(JSON.stringify(value.records)).map(retainedObservation);
    return projectQualifiedRetainedRecords(records, value.readback);
}

export function projectNativeRetainedEntries(value) {
    shape(value, ["contractVersion", "entries"], ["readback"], "$selected");
    if (value.contractVersion !== NATIVE_RETAINED_CONTRACT) fail("unsupported-retained-contract", "$selected");
    if (!Array.isArray(value.entries) || value.entries.length > NATIVE_READ_LIMITS.records) fail("native-retained-read-bound", "$selected");
    screenRetainedValue(value, "$selected", "project-retained-read");
    if (value.readback !== undefined) validateNativeReadback(value.readback);
    const seen = new Set();
    for (const entry of value.entries) {
        shape(entry, ["inputOrdinal", "record"], [], "$selected.entries");
        integer(entry.inputOrdinal, "$selected.inputOrdinal");
        if (seen.has(entry.inputOrdinal)) fail("duplicate-input-ordinal", "$selected");
        seen.add(entry.inputOrdinal);
    }
    const entries = value.entries.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal);
    return projectQualifiedRetainedRecords(entries.map((entry, index) => isValidatedNativeRetainedRecord(entry.record)
        ? entry.record : retainedObservation(JSON.parse(JSON.stringify(entry.record)), index)),
        value.readback, entries.map(entry => entry.inputOrdinal));
}

function projectQualifiedRetainedRecords(records, readback, inputOrdinals) {
    if (records.reduce((count, record) => count + (record.fields.message ? 1 : 0) + (record.messageParts?.length ?? 0), 0) > NATIVE_READ_LIMITS.records) {
        fail("native-retained-read-bound", "$retained");
    }

    const model = projectObservationRecords(records, inputOrdinals);
    return { ...model, retainedContract: NATIVE_RETAINED_CONTRACT, ...(readback ? { readback } : {}),
        definitions: { ...model.definitions, retainedObservationPopulation } };
}

export function validateNativeRetainedObservation(value) {
    screenRetainedValue(value, "$retained");
    return retainedObservation(value, 0);
}
