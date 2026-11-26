import { findCredentialFindings } from "./privacy-text.mjs";

const has = (value, name) => Object.hasOwn(value, name);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const ordered = value => Array.isArray(value) ? value.map(ordered)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(name => [name, ordered(value[name])])) : value;
const available = ["recorded", "recorded-empty", "explicit-null"];
const unavailable = ["absent-in-response", "excluded-by-policy", "credential-excluded", "unsupported", "unqualified", "conflicting"];
const taskKinds = ["task", "task_step", "task_steps", "task_reasoning"];
const taskText = ["taskId", "conversationId", "id", "reasoningId", "idKey", "messageId", "parentStepId", "stepId",
    "stepTitle", "name", "createdTimestamp"];
const childText = ["id", "reasoningId", "idKey", "messageId", "parentStepId", "stepId", "stepTitle"];
const provenanceHashes = ["entrySha256", "runtimeSha256", "configurationSha256", "triggerPluginSha256",
    "triggerExtensionSha256", "triggerConfirmationSha256"];

// Called only after the native envelope's JSON preflight/copy and scope checks.
// This validates source-fact semantics; it does not re-decode or certify a source.
export function validateNativeChatSource(value, envelope, path, fail) {
    const reject = (code, at = path) => fail(`chat-source-${code}`, at);
    function shape(row, required, optional = [], at = path) {
        if (!object(row) || required.some(name => !has(row, name))) reject("missing-field", at);
        if (Object.keys(row).some(name => !required.includes(name) && !optional.includes(name))) reject("unsupported-field", at);
    }
    function string(text, at, max = 1024, empty = false) {
        if (typeof text !== "string" || !empty && !text.trim() || Buffer.byteLength(text) > max) reject("invalid-text", at);
        if (findCredentialFindings(text).some(row => row.mandatory)) reject("credential-bearing-fact", at);
    }
    function list(rows, at, max = 100) {
        if (!Array.isArray(rows) || rows.length > max) reject("array-bound", at);
    }
    function location(source, expected, at) {
        shape(source, ["sourceDocument", "pointer"], ["decodedPointer"], at);
        string(source.sourceDocument, at);
        string(source.pointer, at, 4096);
        if (!source.pointer.startsWith("/")) reject("invalid-source-pointer", at);
        if (has(source, "decodedPointer")) {
            string(source.decodedPointer, at, 4096, true);
            if (source.decodedPointer !== "" && !source.decodedPointer.startsWith("/")) reject("invalid-decoded-pointer", at);
        }
        if (source.sourceDocument !== expected.sourceDocument || source.pointer !== expected.pointer
            || source.decodedPointer !== expected.decodedPointer
            || has(source, "decodedPointer") !== has(expected, "decodedPointer")) reject("source-coordinate-conflict", at);
    }
    function field(row, type, source, at) {
        shape(row, ["availability", "source"], ["value", "reason"], at);
        if (![...available, ...unavailable].includes(row.availability)) reject("unsupported-availability", at);
        const carries = available.includes(row.availability);
        if (carries !== has(row, "value") || carries === has(row, "reason")) reject("availability-value-conflict", at);
        location(row.source, source, `${at}.source`);
        if (!carries) {
            string(row.reason, at, 128);
            if (!/^[a-z][a-z0-9-]*$/.test(row.reason)) reject("invalid-reason", at);
            return;
        }
        if (Buffer.byteLength(JSON.stringify(row.value)) > 65536) reject("fact-byte-bound", at);
        if (row.availability === "explicit-null") {
            if (row.value !== null) reject("expected-null", at);
            return;
        }
        if (row.value === null || row.availability === "recorded" && row.value === "") reject("availability-value-conflict", at);
        if (row.availability === "recorded-empty" && (row.value !== "" || !["text", "short-text", "status-literal", "input", "progress-text"].includes(type))) {
            reject("invalid-empty-fact", at);
        }
        if (["excluded", "opaque", "status"].includes(type)) reject("unqualified-value", at);
        if (type === "input") return;
        if (type === "questions") validateQuestions(row.value, at);
        else if (type === "count") {
            if (!Number.isSafeInteger(row.value) || row.value < 0 || row.value > 100) reject("invalid-count", at);
        } else if (type === "boolean") {
            if (typeof row.value !== "boolean") reject("invalid-boolean", at);
        } else if (type === "number") {
            if (typeof row.value !== "number" || !Number.isFinite(row.value)) reject("invalid-number-literal", at);
        } else {
            string(row.value, at, type === "progress-text" ? 65536 : type === "short-text" ? 256 : type === "status-literal" ? 64 : 1024, true);
            if (type === "progress-text" && /^\s*[\[{]/.test(row.value)) reject("structured-progress-text-unqualified", at);
            if (type === "status-literal" && row.value !== "" && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.value)) reject("invalid-status-literal", at);
            if (type === "annotation-type" && !["tool", "artifact", "skillActivation"].includes(row.value)) reject("annotation-schema-unqualified", at);
        }
    }
    function status(fields, atSource, at) {
        field(fields.statusLiteral, "status-literal", atSource("/status"), `${at}.statusLiteral`);
        field(fields.status, "status", atSource("/status"), `${at}.status`);
        if (fields.statusLiteral.availability === "absent-in-response") {
            if (fields.status.availability !== "absent-in-response") reject("status-qualification-conflict", at);
        } else if (fields.status.availability !== "unqualified"
            || fields.status.reason !== "historical-task-state-enum-unavailable") reject("status-enum-unqualified", at);
    }
    function excluded(row, source, at, type = "excluded") {
        field(row, type, source, at);
        const allowed = type === "opaque" ? ["absent-in-response", "explicit-null", "unqualified", "credential-excluded"]
            : ["absent-in-response", "explicit-null", "excluded-by-policy", "credential-excluded"];
        if (!allowed.includes(row.availability)) reject("unqualified-value", at);
    }
    function validateQuestions(questions, at) {
        list(questions, at);
        if (!questions.length) reject("unsupported-question-shape", at);
        for (const question of questions) {
            if (typeof question === "string") { string(question, at, 65536, true); continue; }
            shape(question, ["question", "options"], [], at);
            string(question.question, at, 65536);
            list(question.options, at, 10000);
            for (const option of question.options) {
                shape(option, ["role", "label", "submitResponse"], ["description"], at);
                if (!["action", "abort"].includes(option.role)) reject("unsupported-question-role", at);
                string(option.label, at, 65536); string(option.submitResponse, at, 65536);
                if (has(option, "description")) string(option.description, at, 65536, true);
            }
        }
    }
    function historical(row, at) {
        if (!["first-element-candidate", "outside-first-element-projection", "unsupported-entry"].includes(row)) reject("historical-projection-unqualified", at);
    }
    function decoderReadModel(row, at) {
        shape(row, ["availability", "reason"], [], at);
        if (row.availability !== "unsupported" || typeof row.reason !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(row.reason)) {
            reject("decoder-qualification-conflict", at);
        }
    }
    shape(value, ["schemaVersion", "parserProvenance", "source", "identity", "observations", "limitations"]);
    if (value.schemaVersion !== 1 || envelope.scope.surface !== "chat") reject("unsupported-contract");
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) reject("byte-bound");
    if (findCredentialFindings(JSON.stringify(value)).some(row => row.mandatory)) reject("credential-bearing-fact");
    const pending = [value];
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === "string" && findCredentialFindings(item).some(row => row.mandatory)) reject("credential-bearing-fact");
        if (item && typeof item === "object") pending.push(...Object.values(item));
    }
    const parser = value.parserProvenance;
    shape(parser, ["version", "applicability", "configurationModule", ...provenanceHashes]);
    if (!["m365-chat-source-v0-inactive", "m365-chat-source-v0.1-inactive", "m365-chat-source-v0.2-inactive", "m365-chat-source-v0.3-inactive"].includes(parser.version)
        || parser.applicability !== "historical-only-current-unqualified"
        || parser.configurationModule !== 714560 || provenanceHashes.some(name => typeof parser[name] !== "string" || !/^[a-f0-9]{64}$/.test(parser[name]))) {
        reject("parser-provenance-unqualified");
    }
    shape(value.source, ["sourceDocument", "pointer"], ["responsePointer"]);
    string(value.source.sourceDocument, path);
    for (const name of ["pointer", "responsePointer"]) if (has(value.source, name)) {
        string(value.source[name], path, 1800);
        if (!value.source[name].startsWith("/")) reject("invalid-source-pointer");
    }
    const original = suffix => ({ sourceDocument: value.source.sourceDocument, pointer: value.source.pointer + suffix });
    const decoded = (field, pointer) => ({ ...original(`/${field}`), decodedPointer: pointer });
    const identityFields = ["messageId", "storageMessageId", "requestId", "messageType", "splitChildStorageMessageId"];
    shape(value.identity, [...identityFields, "responseRequestId"]);
    for (const name of identityFields) {
        const fact = value.identity[name];
        field(fact, "text", original(`/${name}`), `${path}.identity.${name}`);
        if (fact.availability === "recorded" && fact.value.trim()) {
            if (envelope.record[name] !== fact.value) reject("carrier-identity-conflict");
        } else if (envelope.record[name] != null && envelope.record[name] !== "") reject("carrier-identity-conflict");
    }
    if (value.identity.messageId.availability !== "recorded") reject("message-identity-required");
    const responseId = value.identity.responseRequestId;
    shape(responseId, ["availability", "source"], ["value", "reason"], `${path}.identity.responseRequestId`);
    const responseSource = responseId.reason === "envelope-request-not-supplied" ? original("")
        : { sourceDocument: value.source.sourceDocument, pointer: `${value.source.responsePointer}/requestId` };
    if (responseId.reason !== "envelope-request-not-supplied" && !has(value.source, "responsePointer")) reject("response-reference-required");
    field(responseId, "text", responseSource, `${path}.identity.responseRequestId`);

    function taskFields(fields, atSource, at, child = false) {
        const names = child ? childText : taskText;
        shape(fields, [...names, "statusLiteral", "status", "description", "content", ...child ? [] : ["result", "references"]],
            child ? ["annotation"] : ["reasoningEventType", "annotationType", "annotation", "steps", "reasoningItems", "outputFormatsCapabilityList"], at);
        for (const name of names) field(fields[name], "text", atSource(`/${name}`), `${at}.${name}`);
        status(fields, atSource, at);
        for (const name of child ? ["description", "content"] : ["description", "content", "result", "references"]) {
            excluded(fields[name], atSource(`/${name}`), `${at}.${name}`);
        }
        if (has(fields, "reasoningEventType")) field(fields.reasoningEventType, "number", atSource("/reasoningEventType"), `${at}.reasoningEventType`);
        if (has(fields, "annotationType")) {
            if (!has(fields, "annotation")) reject("annotation-qualification-required", at);
            const source = fields.annotationType?.availability === "recorded" ? atSource("/annotation/type") : atSource("/annotation");
            field(fields.annotationType, "annotation-type", source, `${at}.annotationType`);
        }
        if (has(fields, "annotation")) excluded(fields.annotation, atSource("/annotation"), `${at}.annotation`, "opaque");
        if (has(fields, "outputFormatsCapabilityList")) excluded(fields.outputFormatsCapabilityList, atSource("/outputFormatsCapabilityList"), at);
        for (const name of ["steps", "reasoningItems"]) if (has(fields, name)) {
            const children = fields[name], childAt = suffix => atSource(`/${name}${suffix}`);
            if (!Array.isArray(children)) {
                field(children, "opaque", childAt(""), `${at}.${name}`);
                if (children.availability !== "unsupported") reject("child-array-unqualified", at);
                continue;
            }
            list(children, `${at}.${name}`);
            for (const [index, child] of children.entries()) {
                shape(child, ["kind", "source", "fields"], [], at);
                location(child.source, childAt(`/${index}`), at);
                if (child.kind === "unsupported-task-child") shape(child.fields, [], [], at);
                else {
                    if (child.kind !== (name === "steps" ? "task-step-detail" : "task-reasoning-detail")) reject("unsupported-child-kind", at);
                    taskFields(child.fields, suffix => childAt(`/${index}${suffix}`), `${at}.${name}[${index}].fields`, true);
                }
            }
        }
    }
    list(value.observations, `${path}.observations`, 200);
    const coordinates = new Set();
    for (const [index, row] of value.observations.entries()) {
        const at = `${path}.observations[${index}]`, kind = row?.kind;
        const task = taskKinds.includes(kind), invocation = ["native-invocation", "unsupported-native-invocation"].includes(kind);
        const required = task ? ["historicalProjection", "readModel"]
            : kind === "clarification" || kind === "unsupported-trigger-extension" ? ["invocations", "readModel"]
                : kind === "confirmation" ? ["submitActions", "readModel"] : ["trigger-plugin", "provider-progress"].includes(kind) ? ["readModel"] : [];
        shape(row, ["kind", "source", "fields", ...required], kind === "unsupported-native-invocation" ? ["readModel"] : [], at);
        if (!task && !invocation && !["unsupported-task", "clarification", "unsupported-trigger-extension", "confirmation", "trigger-plugin", "provider-progress"].includes(kind)) {
            reject("unsupported-observation-kind", at);
        }
        const nativeType = envelope.record.messageType;
        if ((task || kind === "unsupported-task") && nativeType !== "Task"
            || ["clarification", "unsupported-trigger-extension"].includes(kind) && nativeType !== "TriggerExtension"
            || kind === "confirmation" && !["TriggerConfirmation", "ConfirmationCard"].includes(nativeType)
            || kind === "trigger-plugin" && nativeType !== "TriggerPlugin"
            || kind === "provider-progress" && nativeType !== "Progress") reject("carrier-kind-conflict", at);
        if (kind === "provider-progress" && parser.version !== "m365-chat-source-v0.3-inactive") reject("observation-version-unqualified", at);
        const source = row.source;
        shape(source, ["sourceDocument", "pointer"], ["decodedPointer"], at);
        let expected;
        if (task || kind === "unsupported-task") {
            if (has(source, "decodedPointer") && !/^(?:|\/(?:0|[1-9]\d?))$/.test(source.decodedPointer)) reject("invalid-task-coordinate", at);
            if (task && !has(source, "decodedPointer")) reject("decoded-coordinate-required", at);
            expected = has(source, "decodedPointer") ? decoded("text", source.decodedPointer) : original("/text");
        } else if (invocation) {
            if (!/^\/(?:0|[1-9]\d?)$/.test(source.decodedPointer)) reject("invalid-invocation-coordinate", at);
            expected = decoded("invocation", source.decodedPointer);
        } else expected = original("");
        location(source, expected, `${at}.source`);
        const coordinate = JSON.stringify([kind, source.sourceDocument, source.pointer, source.decodedPointer ?? null]);
        if (coordinates.has(coordinate)) reject("duplicate-observation-coordinate", at);
        coordinates.add(coordinate);
        if (has(row, "readModel")) decoderReadModel(row.readModel, at);
        if (task) {
            historical(row.historicalProjection, at);
            const first = source.decodedPointer === "" || source.decodedPointer === "/0";
            if (row.historicalProjection !== (first ? "first-element-candidate" : "outside-first-element-projection")) reject("historical-coordinate-conflict", at);
            taskFields(row.fields, suffix => decoded("text", source.decodedPointer + suffix), `${at}.fields`);
        } else if (kind === "unsupported-task") shape(row.fields, [], [], at);
        else if (invocation) {
            const names = kind === "native-invocation" ? ["nativeCallId", "toolName", "input"] : ["nativeCallId", "callId", "toolName", "input"];
            if (!object(row.fields)) reject("missing-field", at);
            shape(row.fields, Object.keys(row.fields).length ? names : kind === "native-invocation" ? names : [], [], at);
            for (const name of Object.keys(row.fields)) {
                const suffix = { nativeCallId: "/id", callId: "/callId", toolName: "/function/name", input: "/function/arguments" }[name];
                field(row.fields[name], name === "input" ? kind === "native-invocation" ? "input" : "opaque"
                    : name === "toolName" ? "short-text" : "text", decoded("invocation", source.decodedPointer + suffix), `${at}.fields.${name}`);
            }
        } else if (kind === "provider-progress") {
            shape(row.fields, ["text"], [], at);
            field(row.fields.text, "progress-text", original("/text"), `${at}.fields.text`);
        } else if (kind === "trigger-plugin") {
            shape(row.fields, ["actionId", "invocation", "result"], [], at);
            for (const name of ["actionId", "invocation", "result"]) excluded(row.fields[name], original(`/${name}`), at, name === "result" ? "excluded" : "opaque");
        } else if (kind === "confirmation") {
            shape(row.fields, ["actionId", "isConsequential", "confirmationMetadata", "cardCount"], [], at);
            field(row.fields.actionId, "short-text", original("/actionId"), at);
            field(row.fields.isConsequential, "boolean", original("/isConsequential"), at);
            excluded(row.fields.confirmationMetadata, original("/confirmationMetadata"), at, "opaque");
            field(row.fields.cardCount, "count", original("/adaptiveCards"), at);
            list(row.submitActions, `${at}.submitActions`, 10000);
            const seen = new Set();
            for (const action of row.submitActions) {
                shape(action, ["cardIndex", "actionIndex", "source", "fields"], [], at);
                if (![action.cardIndex, action.actionIndex].every(n => Number.isSafeInteger(n) && n >= 0 && n < 100)
                    || row.fields.cardCount.availability !== "recorded" || action.cardIndex >= row.fields.cardCount.value) reject("invalid-submit-coordinate", at);
                const pointer = `/adaptiveCards/${action.cardIndex}/actions/${action.actionIndex}`;
                if (seen.has(pointer)) reject("duplicate-submit-coordinate", at);
                seen.add(pointer);
                location(action.source, original(pointer), at);
                shape(action.fields, ["actionId", "sourceId"], [], at);
                for (const name of ["actionId", "sourceId"]) field(action.fields[name], name === "actionId" ? "short-text" : "text",
                    original(`${pointer}/data/message/${name}`), at);
            }
        } else {
            shape(row.fields, ["actionId", "sourceRequestId", "responseRequestId", "contentOrigin", ...kind === "clarification" ? ["questions"] : []], [], at);
            for (const name of ["actionId", "sourceRequestId", "contentOrigin"]) field(row.fields[name],
                name === "sourceRequestId" ? "text" : "short-text", original(`/${name}`), at);
            field(row.fields.responseRequestId, "text", responseSource, at);
            if (JSON.stringify(ordered(row.fields.responseRequestId)) !== JSON.stringify(ordered(responseId))) reject("response-identity-conflict", at);
            const actionId = row.fields.actionId;
            if (kind === "clarification" && (actionId.availability !== "recorded"
                || !["clarification_ask_user_question", "clarification_request_browser_take_control"].includes(actionId.value))) reject("clarification-action-unqualified", at);
            if (kind === "unsupported-trigger-extension" && available.includes(actionId.availability) && actionId.availability !== "explicit-null") reject("clarification-action-unqualified", at);
            list(row.invocations, at);
            for (const [ordinal, entry] of row.invocations.entries()) {
                shape(entry, ["source", "historicalProjection", "fields"], [], at);
                const pointer = entry.source?.decodedPointer;
                if (pointer !== `/${ordinal}` && !(ordinal === 0 && pointer === "" && row.invocations.length === 1)) reject("invalid-invocation-coordinate", at);
                location(entry.source, decoded("invocation", pointer), at);
                historical(entry.historicalProjection, at);
                if (entry.historicalProjection === "unsupported-entry") shape(entry.fields, [], [], at);
                else {
                    if (entry.historicalProjection !== (ordinal ? "outside-first-element-projection" : "first-element-candidate")) reject("historical-coordinate-conflict", at);
                    shape(entry.fields, ["callId", "widgetId", "nativeCallId", "functionName"], [], at);
                    for (const name of ["callId", "widgetId", "nativeCallId", "functionName"]) field(entry.fields[name],
                        name === "functionName" ? "short-text" : "text",
                        decoded("invocation", pointer + ({ nativeCallId: "/id", functionName: "/function/name" }[name] ?? `/${name}`)), at);
                }
            }
            if (kind === "clarification") {
                const question = row.fields.questions;
                shape(question, ["availability", "source"], ["value", "reason"], at);
                const qSource = question.source;
                shape(qSource, ["sourceDocument", "pointer"], ["decodedPointer"], at);
                const structured = qSource.pointer === original("/request/actionInputParameters/questions").pointer && !has(qSource, "decodedPointer");
                const missing = qSource.pointer === original("/invocation").pointer && !has(qSource, "decodedPointer");
                const first = row.invocations[0];
                const fallback = first && qSource.pointer === original("/invocation").pointer
                    && qSource.decodedPointer === first.source.decodedPointer + "/function/arguments/questions";
                if (!structured && !missing && !fallback) reject("question-source-unqualified", at);
                field(question, "questions", structured ? original("/request/actionInputParameters/questions") : missing ? original("/invocation")
                    : decoded("invocation", first.source.decodedPointer + "/function/arguments/questions"), at);
                if (available.includes(question.availability) && question.availability !== "recorded") reject("question-source-unqualified", at);
                if (question.availability === "recorded" && missing) reject("question-source-unqualified", at);
                if (question.availability === "recorded" && fallback
                    && (first.historicalProjection !== "first-element-candidate"
                        || first.fields.functionName.availability !== "recorded"
                        || ![actionId.value, ...(actionId.value === "clarification_request_browser_take_control" ? ["request_browser_take_control"] : [])]
                            .includes(first.fields.functionName.value))) reject("question-source-unqualified", at);
                if (question.availability === "recorded" && actionId.value === "clarification_request_browser_take_control") {
                    if (question.value.length !== 1 || !object(question.value[0])
                        || !["action", "abort"].every(role => question.value[0].options.some(option => option.role === role))) reject("unsupported-question-shape", at);
                }
            }
        }
    }
    list(value.limitations, `${path}.limitations`, 10000);
    for (const limitation of value.limitations) {
        shape(limitation, ["code", "source"], [], path);
        string(limitation.code, path, 128);
        if (!/^[a-z][A-Za-z0-9-]*$/.test(limitation.code)) reject("invalid-limitation");
        const source = limitation.source;
        location(source, source, path);
        if (source.sourceDocument !== value.source.sourceDocument
            || !(source.pointer === value.source.pointer || source.pointer.startsWith(value.source.pointer + "/")
                || source.pointer === `${value.source.responsePointer}/requestId`)) reject("source-coordinate-conflict");
    }
    return value;
}
