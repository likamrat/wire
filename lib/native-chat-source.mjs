import { isProxy } from "node:util/types";
import { textFindings } from "./privacy.mjs";
import { NATIVE_READ_CONTRACT, NATIVE_READ_LIMITS, nativeWriterAdmission, projectNativeReadModel } from "./native-read-model.mjs";

export const CHAT_SOURCE_PARSER_VERSION = "m365-chat-source-v0.3-inactive";
export const CHAT_SOURCE_LIMITS = Object.freeze({
    inputBytes: NATIVE_READ_LIMITS.bytes, textBytes: 64 * 1024, outputBytes: 1024 * 1024,
    depth: 24, nodes: 10000, entries: 100, pointerBytes: 1800,
});
const parserProvenance = Object.freeze({
    version: CHAT_SOURCE_PARSER_VERSION,
    applicability: "historical-only-current-unqualified",
    entrySha256: "9b95baa91716119b85238d49363a18e9a83494a84e5a261f1f836b59aaa111ad",
    runtimeSha256: "fcbcc7ad7aae38f42245bd0208ea034441682357031907779b001eeda0ba5bc5",
    configurationModule: 714560,
    configurationSha256: "5f3e50a596d8f5aaf9ae89d913f891d930c2d8213294ec8f08e0974a31b5496c",
    triggerPluginSha256: "77ef3ebd94be0d3343f45cc4952298a8b5eb1db9f5bec3c07da2b19f9740e6c7",
    triggerExtensionSha256: "e30881f0e7ffb8804b7453addaf4878c79bdacecbd499d51f735645af9618103",
    triggerConfirmationSha256: "21563ab28b7bb30c2e09a678282268a85caae1ae6818c849a7c1cb48d3e3e0e2",
});
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = value => Buffer.byteLength(value, "utf8");
function sensitive(value) {
    if (textFindings(JSON.stringify(value)).some(row => row.mandatory)) return true;
    const pending = [value];
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string" && textFindings(item).some(row => row.mandatory)) return true;
        if (item !== null && typeof item === "object") pending.push(...Object.values(item));
    }
    return false;
}
const has = (value, name) => Object.hasOwn(value, name);
const identifier = value => typeof value === "string" && value.trim().length > 0 && bytes(value) <= 1024;

export class ChatSourceDecodeError extends TypeError {
    constructor(code) {
        super(code);
        this.name = "ChatSourceDecodeError";
        this.code = code;
    }
}
const fail = code => { throw new ChatSourceDecodeError(code); };

// Charge every alias before copying it; never invoke accessors, proxies or toJSON.
function copyJson(root, maximum = CHAT_SOURCE_LIMITS.inputBytes, nodeLimit = CHAT_SOURCE_LIMITS.nodes, depthLimit = CHAT_SOURCE_LIMITS.depth) {
    let size = 0, nodes = 0;
    const active = new WeakSet();
    const charge = count => { size += count; if (size > maximum) fail("source-byte-bound"); };
    function string(value) {
        if (value.length > maximum) fail("source-byte-bound");
        charge(bytes(JSON.stringify(value)));
    }
    function copy(value, depth) {
        if (++nodes > nodeLimit || depth > depthLimit) fail("source-structure-bound");
        if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
            charge(JSON.stringify(value).length); return value;
        }
        if (typeof value === "string") { string(value); return value; }
        if (typeof value !== "object" || isProxy(value)) fail("non-json-value");
        const proto = Object.getPrototypeOf(value);
        if (![null, Object.prototype, Array.prototype].includes(proto)) fail("non-json-object");
        if (active.has(value)) fail("non-json-cycle");
        const array = Array.isArray(value), result = array ? [] : {};
        if (array && value.length > CHAT_SOURCE_LIMITS.nodes) fail("source-structure-bound");
        active.add(value); charge(2);
        let count = 0;
        for (const name of Reflect.ownKeys(value)) {
            if (array && name === "length") continue;
            if (typeof name !== "string") fail("non-json-value");
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor.get || descriptor.set) fail("non-json-accessor");
            if (!descriptor.enumerable) fail("non-json-hidden-field");
            if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length)) fail("non-json-array-field");
            if (count++) charge(1);
            if (!array) { string(name); charge(1); }
            Object.defineProperty(result, name, { value: copy(descriptor.value, depth + 1),
                enumerable: true, writable: true, configurable: true });
        }
        if (array && count !== value.length) fail("non-json-sparse-array");
        active.delete(value);
        return result;
    }
    return copy(root, 0);
}
function parseJson(text, maximum = CHAT_SOURCE_LIMITS.textBytes) {
    if (typeof text !== "string") fail("expected-json-string");
    if (text.length > maximum || bytes(text) > maximum) fail("encoded-byte-bound");
    let value;
    try { value = JSON.parse(text); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; fail("malformed-json"); }
    return copyJson(value, maximum);
}
function shape(value, required, optional = []) {
    if (!object(value) || required.some(name => !has(value, name))) fail("invalid-source-context");
    if (Object.keys(value).some(name => ![...required, ...optional].includes(name))) fail("unsupported-context-field");
}
function validateContext(input) {
    shape(input, ["scope", "capture", "ordering", "source", "record"], ["responseRequestId"]);
    const { scope, capture, ordering, source } = input;
    shape(scope, ["harness", "surface", "account", "conversationId"]);
    shape(scope.account, ["tenantId", "subjectId", "verification"]);
    if (scope.harness !== "microsoft-365-copilot" || scope.surface !== "chat"
        || !["verified", "unqualified", "conflicting"].includes(scope.account.verification)
        || ![scope.account.tenantId, scope.account.subjectId, scope.conversationId].every(identifier)) fail("invalid-source-scope");
    shape(capture, ["captureId", "capturedAt", "generation", "parserVersion", "sourceSchema", "operation"], ["origin", "bodyDigest"]);
    if (![capture.captureId, capture.parserVersion, capture.sourceSchema, capture.operation].every(identifier)
        || typeof capture.capturedAt !== "string" || !Number.isFinite(Date.parse(capture.capturedAt))
        || !Number.isSafeInteger(capture.generation) || capture.generation < 0) fail("invalid-capture-provenance");
    if (has(capture, "bodyDigest") && (typeof capture.bodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(capture.bodyDigest))) fail("invalid-source-digest");
    if (has(capture, "origin")) {
        let origin;
        try { origin = new URL(capture.origin); } catch { fail("invalid-source-origin"); }
        if (!identifier(capture.origin) || origin.protocol !== "https:" || origin.username || origin.password
            || origin.search || origin.hash || !["", "/"].includes(origin.pathname)) fail("invalid-source-origin");
    }
    shape(ordering, ["pageOrdinal", "recordOrdinal", "completeness"], ["frameOrdinal", "nativeEventId", "sequence", "sequenceScope"]);
    for (const name of ["pageOrdinal", "recordOrdinal", "frameOrdinal", "sequence"]) {
        if (has(ordering, name) && (!Number.isSafeInteger(ordering[name]) || ordering[name] < 0)) fail("invalid-source-coordinate");
    }
    if (!["response-only", "first-page-only", "drained-exposed-history", "gapped-domain-unqualified", "unknown"].includes(ordering.completeness)
        || has(ordering, "nativeEventId") && !identifier(ordering.nativeEventId)
        || has(ordering, "sequenceScope") && !["conversation", "request", "unknown"].includes(ordering.sequenceScope)) fail("invalid-source-ordering");
    shape(source, ["sourceDocument", "pointer"], ["responsePointer"]);
    if (!identifier(source.sourceDocument) || typeof source.pointer !== "string" || !source.pointer.startsWith("/")
        || bytes(source.pointer) > CHAT_SOURCE_LIMITS.pointerBytes) fail("invalid-source-reference");
    if (has(source, "responsePointer") && (typeof source.responsePointer !== "string"
        || !source.responsePointer.startsWith("/") || bytes(source.responsePointer) > CHAT_SOURCE_LIMITS.pointerBytes)) fail("invalid-response-reference");
    if (has(input, "responseRequestId") && !has(source, "responsePointer")) fail("missing-response-reference");
    if (sensitive({ scope, capture, ordering, source })) fail("credential-bearing-context");
}
function location(input, field = "", decodedPointer) {
    return { sourceDocument: input.source.sourceDocument, pointer: input.source.pointer + (field ? `/${field}` : ""),
        ...(decodedPointer === undefined ? {} : { decodedPointer }) };
}
function unavailable(availability, reason, source) { return { availability, reason, source }; }
function valueFact(value, source, present = true) {
    if (!present) return unavailable("absent-in-response", "field-not-present", source);
    if (bytes(JSON.stringify(value)) > CHAT_SOURCE_LIMITS.textBytes) return unavailable("unsupported", "fact-byte-bound", source);
    if (sensitive(value)) return unavailable("credential-excluded", "credential-pattern", source);
    return { availability: value === null ? "explicit-null" : value === "" ? "recorded-empty" : "recorded", value, source };
}
function textFact(container, name, source, maximum = 1024) {
    if (!has(container, name)) return valueFact(null, source, false);
    const value = container[name];
    if (value === null) return valueFact(value, source);
    if (typeof value !== "string" || bytes(value) > maximum) return unavailable("unsupported", "unsupported-text-field", source);
    return valueFact(value, source);
}
const nativeFact = ({ source, ...fact }) => fact;
const evidence = source => ({ sourceDocument: source.sourceDocument, pointer: source.pointer });
function issue(result, code, source) { result.limitations.push({ code, source }); }
function excluded(container, name, source, reason, availability = "excluded-by-policy") {
    if (!has(container, name)) return valueFact(null, source, false);
    if (container[name] === null) return valueFact(null, source);
    return unavailable(sensitive(container[name]) ? "credential-excluded" : availability, reason, source);
}
function statusFields(payload, at, result) {
    const source = at("/status"), literal = textFact(payload, "status", source, 64);
    if (literal.availability === "recorded" && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(literal.value)) {
        issue(result, "unsupported-task-status-literal", source);
        return { statusLiteral: unavailable("unsupported", "unsupported-task-status-literal", source),
            status: unavailable("unqualified", "historical-task-state-enum-unavailable", source) };
    }
    if (has(payload, "status")) issue(result, "task-status-enum-unqualified", source);
    return { statusLiteral: literal, status: has(payload, "status")
        ? unavailable("unqualified", "historical-task-state-enum-unavailable", source) : valueFact(null, source, false) };
}
function taskFields(payload, at, result) {
    const fields = {};
    for (const name of ["taskId", "conversationId", "id", "reasoningId", "idKey", "messageId", "parentStepId", "stepId",
        "stepTitle", "name", "createdTimestamp"]) fields[name] = textFact(payload, name, at(`/${name}`));
    Object.assign(fields, statusFields(payload, at, result));
    for (const name of ["description", "content", "result", "references"]) {
        fields[name] = excluded(payload, name, at(`/${name}`), `${name}-content-not-qualified`);
    }
    if (has(payload, "reasoningEventType")) {
        fields.reasoningEventType = typeof payload.reasoningEventType === "number"
            ? valueFact(payload.reasoningEventType, at("/reasoningEventType"))
            : unavailable("unsupported", "unsupported-reasoning-event-type", at("/reasoningEventType"));
        issue(result, "reasoning-event-enum-unqualified", at("/reasoningEventType"));
    }
    if (has(payload, "annotation")) {
        const annotation = payload.annotation;
        fields.annotationType = object(annotation) && ["tool", "artifact", "skillActivation"].includes(annotation.type)
            ? valueFact(annotation.type, at("/annotation/type"))
            : unavailable("unqualified", "annotation-type-unqualified", at("/annotation"));
        fields.annotation = excluded(payload, "annotation", at("/annotation"), "annotation-schema-unqualified", "unqualified");
        issue(result, "opaque-tool-annotation", at("/annotation"));
    }
    for (const name of ["steps", "reasoningItems"]) {
        if (!has(payload, name)) continue;
        if (!Array.isArray(payload[name]) || payload[name].length > CHAT_SOURCE_LIMITS.entries) {
            fields[name] = unavailable("unsupported", "task-child-array-bound-or-shape", at(`/${name}`));
            issue(result, "task-child-array-bound-or-shape", at(`/${name}`)); continue;
        }
        fields[name] = payload[name].map((child, index) => {
            const source = at(`/${name}/${index}`);
            if (!object(child)) {
                issue(result, "unsupported-task-child", source);
                return { kind: "unsupported-task-child", source, fields: {} };
            }
            const childAt = suffix => at(`/${name}/${index}${suffix}`);
            const selected = {};
            for (const key of ["id", "reasoningId", "idKey", "messageId", "parentStepId", "stepId", "stepTitle"]) {
                selected[key] = textFact(child, key, childAt(`/${key}`));
            }
            Object.assign(selected, statusFields(child, childAt, result));
            selected.description = excluded(child, "description", childAt("/description"), "description-content-not-qualified");
            selected.content = excluded(child, "content", childAt("/content"), "content-not-qualified");
            if (has(child, "annotation")) {
                selected.annotation = excluded(child, "annotation", childAt("/annotation"), "annotation-schema-unqualified", "unqualified");
                issue(result, "opaque-tool-annotation", childAt("/annotation"));
            }
            return { kind: name === "steps" ? "task-step-detail" : "task-reasoning-detail", source, fields: selected };
        });
    }
    if (has(payload, "outputFormatsCapabilityList")) {
        fields.outputFormatsCapabilityList = excluded(payload, "outputFormatsCapabilityList",
            at("/outputFormatsCapabilityList"), "output-capabilities-are-not-execution");
    }
    return fields;
}
function decodeTask(input, record, result) {
    const source = location(input, "text");
    let payload;
    try { payload = parseJson(record.text); }
    catch (error) {
        if (!(error instanceof ChatSourceDecodeError)) throw error;
        issue(result, error.code, source);
        result.sourceObservations.push({ kind: "unsupported-task", source, fields: {} }); return;
    }
    const array = Array.isArray(payload), rows = array ? payload : [payload];
    if (!rows.length || rows.length > CHAT_SOURCE_LIMITS.entries) {
        issue(result, "task-array-bound-or-empty", source);
        result.sourceObservations.push({ kind: "unsupported-task", source, fields: {} }); return;
    }
    for (const [index, row] of rows.entries()) {
        const at = suffix => location(input, "text", `${array ? `/${index}` : ""}${suffix}`);
        if (!object(row) || !["task", "task_step", "task_steps", "task_reasoning"].includes(row.type)) {
            issue(result, "unsupported-task-payload-type", at(""));
            result.sourceObservations.push({ kind: "unsupported-task", source: at(""), fields: {} }); continue;
        }
        const fields = taskFields(row, at, result);
        if (Object.keys(row).some(name => !["type", "taskId", "conversationId", "id", "reasoningId", "idKey", "messageId",
            "parentStepId", "stepId", "stepTitle", "name", "createdTimestamp", "status", "description", "content", "result",
            "references", "reasoningEventType", "annotation", "steps", "reasoningItems", "outputFormatsCapabilityList"].includes(name))) {
            issue(result, "unmapped-task-fields", at(""));
        }
        if (!identifier(row.taskId) || !identifier(row.conversationId)) issue(result, "task-identity-unqualified", at(""));
        if (identifier(row.conversationId) && row.conversationId !== input.scope.conversationId) {
            issue(result, "task-conversation-scope-conflict", at("/conversationId"));
        }
        result.sourceObservations.push({ kind: row.type, source: at(""), fields,
            historicalProjection: !array || index === 0 ? "first-element-candidate" : "outside-first-element-projection",
            readModel: { availability: "unsupported", reason: "native-contract-has-no-chat-task-facts" } });
    }
    issue(result, "native-contract-has-no-chat-task-facts", source);
}
const clarificationActions = ["clarification_ask_user_question", "clarification_request_browser_take_control"];
function triggerInvocation(input, record, result) {
    const source = location(input, "invocation"), entries = [];
    if (!has(record, "invocation")) return { entries, first: null };
    let decoded;
    try { decoded = typeof record.invocation === "string" ? parseJson(record.invocation) : record.invocation; }
    catch (error) {
        if (!(error instanceof ChatSourceDecodeError)) throw error;
        issue(result, error.code, source); return { entries, first: null };
    }
    const array = Array.isArray(decoded), rows = array ? decoded : [decoded];
    if (rows.length > CHAT_SOURCE_LIMITS.entries) {
        issue(result, "trigger-invocation-array-bound", source); return { entries, first: null };
    }
    let first = null;
    for (const [index, row] of rows.entries()) {
        const at = suffix => location(input, "invocation", `${array ? `/${index}` : ""}${suffix}`);
        if (!object(row)) {
            entries.push({ source: at(""), historicalProjection: "unsupported-entry", fields: {} });
            issue(result, "unsupported-trigger-invocation-entry", at("")); continue;
        }
        const fn = object(row.function) ? row.function : {};
        entries.push({ source: at(""), historicalProjection: index ? "outside-first-element-projection" : "first-element-candidate",
            fields: { callId: textFact(row, "callId", at("/callId")), widgetId: textFact(row, "widgetId", at("/widgetId")),
                nativeCallId: row.type === "function" ? textFact(row, "id", at("/id"))
                    : unavailable(has(row, "id") ? "unqualified" : "absent-in-response", "native-function-id-not-qualified", at("/id")),
                functionName: textFact(fn, "name", at("/function/name"), 256) } });
        if (index) { issue(result, "additional-trigger-invocation-not-selected", at("")); continue; }
        let args = fn.arguments;
        if (typeof args === "string") {
            try { args = parseJson(args); }
            catch (error) {
                if (!(error instanceof ChatSourceDecodeError)) throw error;
                issue(result, error.code, at("/function/arguments")); args = null;
            }
        }
        first = { fn, args, at };
    }
    return { entries, first };
}
function questionShape(value, browser) {
    if (!Array.isArray(value) || !value.length || value.length > CHAT_SOURCE_LIMITS.entries || browser && value.length !== 1) return false;
    return value.every(question => {
        if (!browser && typeof question === "string") return true;
        if (!object(question) || typeof question.question !== "string" || !question.question.trim()
            || Object.keys(question).some(name => !["question", "options"].includes(name)) || !Array.isArray(question.options)) return false;
        const valid = option => object(option) && ["action", "abort"].includes(option.role)
            && typeof option.label === "string" && option.label.trim() && typeof option.submitResponse === "string" && option.submitResponse.trim()
            && (!has(option, "description") || typeof option.description === "string")
            && !Object.keys(option).some(name => !["role", "label", "submitResponse", "description"].includes(name));
        return question.options.every(valid) && (!browser || ["action", "abort"].every(role => question.options.some(option => option.role === role)));
    });
}
function decodeClarification(input, record, result) {
    const source = location(input), invocation = triggerInvocation(input, record, result);
    const fields = { actionId: textFact(record, "actionId", location(input, "actionId"), 256),
        sourceRequestId: textFact(record, "sourceRequestId", location(input, "sourceRequestId")),
        responseRequestId: result.provenance.identity.responseRequestId,
        contentOrigin: textFact(record, "contentOrigin", location(input, "contentOrigin"), 256) };
    const known = clarificationActions.includes(record.actionId), browser = record.actionId === clarificationActions[1];
    if (!known) {
        issue(result, "unsupported-clarification-action", location(input, "actionId"));
        fields.actionId = excluded(record, "actionId", location(input, "actionId"), "unsupported-clarification-action", "unqualified");
    } else {
        const structured = object(record.request?.actionInputParameters) ? record.request.actionInputParameters : {};
        let questions = structured.questions, questionSource = location(input, "request/actionInputParameters/questions");
        const fallback = browser ? questions == null : !Array.isArray(questions) || !questions.length;
        if (fallback) {
            const first = invocation.first;
            const names = browser ? ["request_browser_take_control", clarificationActions[1]] : [clarificationActions[0]];
            questions = first && names.includes(first.fn.name) && object(first.args) ? first.args.questions : undefined;
            questionSource = first?.at("/function/arguments/questions") ?? location(input, "invocation");
        }
        if (questions === undefined) {
            fields.questions = unavailable("unqualified", "clarification-questions-not-qualified", questionSource);
            issue(result, "clarification-questions-not-qualified", questionSource);
        } else if (!questionShape(questions, browser)) {
            fields.questions = unavailable("unsupported", "unsupported-question-shape", questionSource);
            issue(result, "unsupported-question-shape", questionSource);
        } else fields.questions = valueFact(questions, questionSource);
        if (!browser) issue(result, "ask-user-question-item-schema-partial", questionSource);
    }
    result.sourceObservations.push({ kind: known ? "clarification" : "unsupported-trigger-extension", source, fields,
        invocations: invocation.entries, readModel: { availability: "unsupported", reason: "native-contract-has-no-chat-trigger-facts" } });
    issue(result, "native-contract-has-no-chat-trigger-facts", source);
    issue(result, "trigger-is-not-execution", source);
}
function decodeConfirmation(input, record, result) {
    const source = location(input), fields = {
        actionId: textFact(record, "actionId", location(input, "actionId"), 256),
        isConsequential: !has(record, "isConsequential") || typeof record.isConsequential === "boolean" || record.isConsequential === null
            ? valueFact(record.isConsequential, location(input, "isConsequential"), has(record, "isConsequential"))
            : unavailable("unsupported", "unsupported-consequential-field", location(input, "isConsequential")),
        confirmationMetadata: excluded(record, "confirmationMetadata", location(input, "confirmationMetadata"), "opaque-confirmation-metadata", "unqualified"),
    }, submitActions = [];
    if (has(record, "widgetData")) issue(result, "widget-data-does-not-supply-original-action-id", location(input, "widgetData"));
    const cards = record.adaptiveCards;
    if (!Array.isArray(cards) || cards.length > CHAT_SOURCE_LIMITS.entries) {
        fields.cardCount = unavailable(has(record, "adaptiveCards") ? "unsupported" : "absent-in-response",
            "confirmation-card-list-unqualified", location(input, "adaptiveCards"));
        issue(result, "confirmation-card-list-unqualified", location(input, "adaptiveCards"));
    } else {
        fields.cardCount = valueFact(cards.length, location(input, "adaptiveCards"));
        for (const [cardIndex, card] of cards.entries()) {
            const cardAt = `adaptiveCards/${cardIndex}`;
            if (!object(card)) { issue(result, "unsupported-confirmation-card", location(input, cardAt)); continue; }
            if (!has(card, "actions")) continue;
            if (!Array.isArray(card.actions) || card.actions.length > CHAT_SOURCE_LIMITS.entries) {
                issue(result, "confirmation-action-array-bound-or-shape", location(input, `${cardAt}/actions`)); continue;
            }
            for (const [actionIndex, action] of card.actions.entries()) {
                if (!object(action) || action.type !== "Action.Submit") continue;
                const at = `${cardAt}/actions/${actionIndex}`, message = object(action.data?.message) ? action.data.message : {};
                submitActions.push({ cardIndex, actionIndex, source: location(input, at), fields: {
                    actionId: textFact(message, "actionId", location(input, `${at}/data/message/actionId`), 256),
                    sourceId: textFact(message, "sourceId", location(input, `${at}/data/message/sourceId`)),
                } });
            }
        }
    }
    result.sourceObservations.push({ kind: "confirmation", source, fields, submitActions,
        readModel: { availability: "unsupported", reason: "native-contract-has-no-chat-trigger-facts" } });
    issue(result, "native-contract-has-no-chat-trigger-facts", source);
    issue(result, "confirmation-is-not-approval-or-execution", source);
}
function decodePlugin(input, record, result) {
    const source = location(input);
    result.sourceObservations.push({ kind: "trigger-plugin", source, fields: {
        actionId: excluded(record, "actionId", location(input, "actionId"), "plugin-operation-schema-unqualified", "unqualified"),
        invocation: excluded(record, "invocation", location(input, "invocation"), "plugin-operation-schema-unqualified", "unqualified"),
        result: excluded(record, "result", location(input, "result"), "trigger-is-not-execution"),
    }, readModel: { availability: "unsupported", reason: "native-contract-has-no-chat-trigger-facts" } });
    issue(result, "plugin-operation-schema-unqualified", source);
    issue(result, "trigger-is-not-execution", source);
}
function decodeCalls(input, record, result) {
    if (!has(record, "invocation")) return null;
    const source = location(input, "invocation");
    let calls;
    const special = ["Task", "TriggerExtension", "TriggerPlugin", "TriggerConfirmation"].includes(record.messageType);
    if (special && typeof record.invocation !== "string") return null;
    try {
        calls = parseJson(record.invocation);
        if (special && (!Array.isArray(calls) || calls.some(row => object(row) && (row.type !== "function" || !has(row, "id"))))) return null;
        if (!Array.isArray(calls) || calls.length > CHAT_SOURCE_LIMITS.entries) fail("unsupported-native-invocation");
    } catch (error) {
        if (!(error instanceof ChatSourceDecodeError)) throw error;
        issue(result, error.code, source); return null;
    }
    let compatible = true;
    const facts = [], ids = new Set();
    for (const [index, encodedCall] of calls.entries()) {
        const at = suffix => location(input, "invocation", `/${index}${suffix}`);
        let call = encodedCall;
        if (typeof call === "string") {
            try { call = parseJson(call); }
            catch (error) {
                if (!(error instanceof ChatSourceDecodeError)) throw error;
                compatible = false; issue(result, error.code, at(""));
                result.sourceObservations.push({ kind: "unsupported-native-invocation", source: at(""), fields: {},
                    readModel: { availability: "unsupported", reason: error.code } });
                continue;
            }
        }
        if (!object(call) || call.type !== "function" || !object(call.function)
            || Object.keys(call).some(name => !["id", "type", "function"].includes(name))
            || Object.keys(call.function).some(name => !["name", "arguments"].includes(name))
            || !identifier(call.id) || !identifier(call.function.name) || bytes(call.function.name) > 256) {
            compatible = false; issue(result, "unsupported-native-call-shape", at(""));
            const row = object(call) ? call : {}, fn = object(row.function) ? row.function : {};
            result.sourceObservations.push({ kind: "unsupported-native-invocation", source: at(""), fields: {
                nativeCallId: row.type === "function" ? textFact(row, "id", at("/id"))
                    : excluded(row, "id", at("/id"), "native-function-id-not-qualified", "unqualified"),
                callId: textFact(row, "callId", at("/callId")),
                toolName: textFact(fn, "name", at("/function/name"), 256),
                input: excluded(fn, "arguments", at("/function/arguments"), "native-call-identity-or-shape-unqualified", "unqualified"),
            }, readModel: { availability: "unsupported", reason: "native-call-identity-or-shape-unqualified" } });
            continue;
        }
        const id = valueFact(call.id, at("/id")), name = valueFact(call.function.name, at("/function/name"));
        let argument = valueFact(call.function.arguments, at("/function/arguments"), has(call.function, "arguments"));
        if (typeof call.function.arguments === "string" && call.function.arguments !== "") {
            try {
                const decoded = parseJson(call.function.arguments);
                if (sensitive(decoded)) argument = unavailable("credential-excluded", "credential-pattern", at("/function/arguments"));
            } catch (error) {
                if (!(error instanceof ChatSourceDecodeError)) throw error;
                if (error.code !== "malformed-json") {
                    compatible = false; argument = unavailable("unsupported", error.code, at("/function/arguments"));
                } else issue(result, "original-argument-string-not-json", at("/function/arguments"));
            }
        }
        if (ids.has(call.id)) { compatible = false; issue(result, "ambiguous-native-call-id", at("/id")); }
        ids.add(call.id);
        if ([id, name, argument].some(fact => ["credential-excluded", "unsupported"].includes(fact.availability))) compatible = false;
        result.sourceObservations.push({ kind: "native-invocation", source: at(""),
            fields: { nativeCallId: id, toolName: name, input: argument } });
        facts.push({ nativeCallId: call.id, qualifiedFields: { toolName: nativeFact(name), input: nativeFact(argument) },
            evidenceReferences: { toolName: evidence(source), input: evidence(source) } });
    }
    if (!compatible) { issue(result, "native-invocation-not-projectable", source); return null; }
    return { invocation: record.invocation, callFacts: facts };
}

function absentPlainCardText(input, record, result) {
    if (!has(record, "adaptiveCards")) return null;
    const source = location(input, "adaptiveCards"), cards = record.adaptiveCards;
    const leaves = [];
    let unsupported = !Array.isArray(cards) || cards.length !== 1 || !object(cards[0]) || !Array.isArray(cards[0].body);
    function visit(node, pointer) {
        if (!object(node)) { unsupported = true; return; }
        if (["TextBlock", "TextRun"].includes(node.type)) {
            if (typeof node.text !== "string") unsupported = true;
            else leaves.push({ type: node.type, text: node.text, source: location(input, `${pointer}/text`) });
        }
        for (const name of ["body", "items", "columns", "inlines", "content"]) {
            if (!has(node, name)) continue;
            if (Array.isArray(node[name])) {
                if (node[name].length > CHAT_SOURCE_LIMITS.entries) { unsupported = true; continue; }
                for (const [index, child] of node[name].entries()) visit(child, `${pointer}/${name}/${index}`);
            } else if (object(node[name])) visit(node[name], `${pointer}/${name}`);
            else unsupported = true;
        }
    }
    if (!unsupported) visit(cards[0], "adaptiveCards/0");
    if (unsupported || leaves.length !== 1 || leaves[0].type !== "TextBlock") {
        issue(result, "card-text-shape-unqualified", source);
        return unavailable("unsupported", "card-text-shape-unqualified", source);
    }
    const field = valueFact({
        author: { user: "user", bot: "assistant", tool: "tool" }[record.author] ?? "unknown",
        representation: "card-text", text: leaves[0].text,
    }, leaves[0].source);
    issue(result, "plain-text-absent-card-representation", location(input, "text"));
    issue(result, "card-nontext-fields-not-projected", source);
    if (field.availability !== "recorded") issue(result, "card-text-not-retained", field.source);
    return field;
}

function decodeProgress(input, record, result) {
    const source = location(input), textSource = location(input, "text");
    let text = textFact(record, "text", textSource, CHAT_SOURCE_LIMITS.textBytes);
    if (text.availability === "recorded" && /^\s*[\[{]/.test(text.value)) {
        text = unavailable("unqualified", "structured-progress-text-not-qualified", textSource);
        issue(result, "structured-progress-text-not-qualified", textSource);
    }
    result.sourceObservations.push({
        kind: "provider-progress", source, fields: { text },
        readModel: { availability: "unsupported", reason: "native-contract-has-no-chat-progress-facts" },
    });
    issue(result, "provider-progress-not-final-reply-or-tool-outcome", source);
    issue(result, "native-contract-has-no-chat-progress-facts", source);
}

/**
 * Decode one original observation, never an execution or authorization claim.
 * sourceObservations are inactive discriminated source facts, not new envelope slots.
 */
export function decodeNativeChatObservation(value) {
    const input = typeof value === "string" ? parseJson(value, CHAT_SOURCE_LIMITS.inputBytes) : copyJson(value);
    validateContext(input);
    const result = { status: "inactive", parserProvenance: { ...parserProvenance },
        admission: nativeWriterAdmission(), provenance: { scope: input.scope, capture: input.capture,
            ordering: input.ordering, source: input.source },
        envelopes: [], sourceObservations: [], limitations: [] };
    let record;
    try {
        record = typeof input.record === "string" ? parseJson(input.record, CHAT_SOURCE_LIMITS.inputBytes) : input.record;
        if (!object(record)) fail("unsupported-source-record");
    } catch (error) {
        if (!(error instanceof ChatSourceDecodeError)) throw error;
        issue(result, error.code, location(input)); return result;
    }
    const carrier = {};
    result.provenance.identity = {};
    for (const name of ["messageId", "storageMessageId", "requestId", "messageType", "splitChildStorageMessageId"]) {
        const fact = textFact(record, name, location(input, name));
        result.provenance.identity[name] = fact;
        if (fact.availability === "recorded" && identifier(fact.value)) carrier[name] = fact.value;
        else if (has(record, name)) issue(result, `unqualified-${name}`, fact.source);
    }
    result.provenance.identity.responseRequestId = has(input, "responseRequestId")
        ? textFact(input, "responseRequestId", { sourceDocument: input.source.sourceDocument, pointer: `${input.source.responsePointer}/requestId` })
        : unavailable("unqualified", "envelope-request-not-supplied", location(input));
    if (["user", "bot", "tool"].includes(record.author)) carrier.author = record.author;
    if (record.messageType === "Progress") decodeProgress(input, record, result);
    if (record.messageType === "Task") decodeTask(input, record, result);
    if (record.messageType === "TriggerExtension") decodeClarification(input, record, result);
    if (["TriggerConfirmation", "ConfirmationCard"].includes(record.messageType)) decodeConfirmation(input, record, result);
    if (record.messageType === "TriggerPlugin") decodePlugin(input, record, result);
    if (["CompletePlugin", "CompleteExtension", "ExecuteAction", "InvokeAction"].includes(record.messageType)) {
        issue(result, "completion-payload-unqualified", location(input));
    } else if (has(record, "messageType") && !["Chat", "Task", "Progress", "InternalContentDescription", "ImageGenerationComplete",
        "TriggerExtension", "TriggerPlugin", "TriggerConfirmation", "ConfirmationCard"].includes(record.messageType)) {
        issue(result, "message-type-semantics-unqualified", location(input, "messageType"));
    }
    const invocation = decodeCalls(input, record, result);
    if (invocation) carrier.invocation = invocation.invocation;
    const envelope = { contractVersion: NATIVE_READ_CONTRACT, scope: input.scope, capture: input.capture,
        ordering: input.ordering, record: carrier, qualifiedFields: {}, evidenceReferences: {}, coverage: [
            { kind: "historical-chat-decoder", subject: parserProvenance.version,
                meaning: `Historical configuration ${parserProvenance.configurationSha256}; current applicability, complete capture and enterprise outcomes are unqualified.` },
        ], ...(invocation ? { callFacts: invocation.callFacts } : {}) };
    if (!has(record, "messageType") || record.messageType === "Chat") {
        const at = location(input, "text");
        const card = !has(record, "text") ? absentPlainCardText(input, record, result) : null;
        const field = card ?? (!has(record, "text") || record.text === null ? valueFact(record.text, at, has(record, "text"))
            : typeof record.text === "string" ? valueFact({
                author: { user: "user", bot: "assistant", tool: "tool" }[carrier.author] ?? "unknown",
                representation: "plain-text", text: record.text,
            }, at) : unavailable("unsupported", "unsupported-message-text", at));
        envelope.qualifiedFields.message = nativeFact(field);
        envelope.evidenceReferences.message = evidence(field.source);
    }
    if (carrier.messageId) {
        for (const code of new Set(result.limitations.map(row => row.code))) envelope.coverage.push({ kind: "chat-source-limitation",
            meaning: code, path: input.source.pointer });
        projectNativeReadModel([envelope]);
        result.envelopes.push(envelope);
    } else issue(result, "original-message-id-required-for-read-model", location(input, "messageId"));
    return copyJson(result, CHAT_SOURCE_LIMITS.outputBytes, 40000, 64);
}
