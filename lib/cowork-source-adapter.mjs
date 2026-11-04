import { NATIVE_READ_CONTRACT, NATIVE_READ_LIMITS, NATIVE_COWORK_MESSAGE_AUTHOR_PARSER,
    NATIVE_COWORK_LEGACY_RESULT_FACTS_PARSER, NATIVE_COWORK_RESULT_FACTS_PARSER, NativeReadModelError, projectNativeReadModel,
    nativeValueHasCredentials } from "./native-read-model.mjs";
import { textFindings } from "./privacy.mjs";
import { errorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence, resultDescription } from "./result-evidence.mjs";

export const COWORK_SOURCE_ADAPTER_VERSION = "cowork-source-v3-review-only";
export const COWORK_PARTS_ADAPTER_VERSION = "cowork-source-v4-message-parts-review-only";
export const COWORK_MATCHED_ADAPTER_VERSION = NATIVE_COWORK_MESSAGE_AUTHOR_PARSER;
export const COWORK_RESULT_ADAPTER_VERSION = NATIVE_COWORK_LEGACY_RESULT_FACTS_PARSER;
export const COWORK_MATCHED_RESULT_ADAPTER_VERSION = NATIVE_COWORK_RESULT_FACTS_PARSER;
export const COWORK_MESSAGE_PART_LIMIT = 256;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code, path) => { throw new NativeReadModelError(code, path); };
const recorded = value => ({ availability: value === null ? "explicit-null" : value === "" ? "recorded-empty" : "recorded", value });
const unavailable = (availability, reason) => ({ availability, reason });
const absent = () => unavailable("absent-in-response", "field-absent-from-read-response");
const byteLength = value => new TextEncoder().encode(value).length;
const sensitive = value => textFindings(value).some(finding => finding.mandatory);
const referenceFields = ["u", "t", "s", "tp", "d", "ic", "fn", "au", "did", "iid", "sl"];
const identityFields = {
    ts: ["tid", "tn", "pid", "aid"], tx: ["tid", "tn", "pid"], ta: ["aid", "tid"], taa: ["aid"],
    u: ["id"], th: ["mid", "aid"], dx: [], fr: ["mid"], aq: [], aa: [], sa: ["tid"], sx: ["tid"],
};
const taskStates = ["running", "needs_user_input", "pending_activity", "completed", "failed", "cancelled", "unknown"];
const messageSources = {
    u: { field: "t", representation: "plain-text", reason: "native-message-text-author-unqualified" },
    th: { field: "c", representation: "plain-text", reason: "native-thinking-fragment-author-unqualified" },
    dx: { field: "t", representation: "reply-fragment", reason: "native-text-delta-author-unqualified" },
    fr: { field: "content", representation: "plain-text", reason: "native-final-content-author-unqualified" },
};
const matchedMessageSources = {
    ...messageSources,
    u: { ...messageSources.u, author: "user", reason: "matched-native-user-message-role" },
    a: { field: "t", representation: "plain-text", author: "assistant", reason: "matched-native-assistant-message-role" },
};

// The read model's JSON preflight is private. Guard source data before accessing
// it; final envelope validation and all identity/outcome projection stay there.
function assertSourceJson(root, path = "$source") {
    const active = new WeakSet();
    let bytes = 0, nodes = 0;
    function charge(count) {
        bytes += count;
        if (bytes > NATIVE_READ_LIMITS.bytes) fail("record-byte-bound", path);
    }
    function string(value) {
        charge(2);
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) charge(2);
            else if (code < 32) charge(6);
            else if (code < 128) charge(1);
            else if (code < 2048) charge(2);
            else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
                charge(4); i++;
            } else charge(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
        }
    }
    function visit(value, depth) {
        if (++nodes > 1000000 || depth > 64) fail("json-structure-bound", path);
        if (value === null) { charge(4); return; }
        if (typeof value === "string") { string(value); return; }
        if (typeof value === "boolean") { charge(value ? 4 : 5); return; }
        if (typeof value === "number" && Number.isFinite(value)) { charge(JSON.stringify(value).length); return; }
        if (typeof value !== "object") fail("non-json-value", path);
        const proto = Object.getPrototypeOf(value), array = Array.isArray(value);
        if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) fail("non-json-object", path);
        if (active.has(value)) fail("non-json-input", path);
        if (array && value.length > 1000000) fail("json-structure-bound", path);
        active.add(value);
        charge(2);
        let entries = 0;
        for (const name of Reflect.ownKeys(value)) {
            if (typeof name !== "string") fail("non-json-value", path);
            if (array && name === "length") continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor.get || descriptor.set) fail("non-json-accessor", path);
            if (!descriptor.enumerable) fail("non-json-value", path);
            if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length)) fail("non-json-array-field", path);
            if (entries++) charge(1);
            if (!array) { string(name); charge(1); }
            visit(descriptor.value, depth + 1);
        }
        if (array && entries !== value.length) fail("non-json-value", path);
        active.delete(value);
    }
    visit(root, 0);
}

function shape(value, required, optional, path) {
    if (!object(value)) fail("expected-object", path);
    for (const name of required) if (!Object.hasOwn(value, name)) fail("missing-field", `${path}.${name}`);
    if (Object.keys(value).some(name => ![...required, ...optional].includes(name))) fail("unsupported-field", path);
}
const pick = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => [name, value[name]]));
function screened(value, path) {
    const text = JSON.stringify(value);
    if (byteLength(text) > NATIVE_READ_LIMITS.textBytes) fail("fact-byte-bound", path);
    return nativeValueHasCredentials(value, path) ? unavailable("credential-excluded", "credential-bearing-source-field") : recorded(value);
}
function screenedMessage(value, representation, reason, path, author = "unknown") {
    if (value === null) return recorded(null);
    if (typeof value !== "string") return unavailable("unsupported", "native-message-text-not-a-string");
    const message = screened({ author, representation, text: value }, path);
    if (message.availability === "recorded" && sensitive(value)) {
        return unavailable("credential-excluded", "credential-bearing-source-field");
    }
    if (message.availability === "recorded") message.reason = reason;
    return message;
}
function inputFact(data, path) {
    if (!Object.hasOwn(data, "inp")) return absent();
    let value = data.inp;
    if (typeof value === "string") {
        try { value = JSON.parse(value); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    assertSourceJson(value, `${path}.input.decoded`);
    const fact = screened(value, path);
    if (fact.availability !== "credential-excluded" && nativeValueHasCredentials(data.inp, `${path}.input.source`)) {
        return unavailable("credential-excluded", "credential-bearing-source-field");
    }
    return fact;
}
function failureFact(data, withResults = false) {
    if (!Object.hasOwn(data, "err")) return absent();
    if (data.err === null) return recorded(null);
    if (typeof data.err !== "string") return unavailable("unsupported", "unqualified-native-error-format");
    if (withResults) {
        const diagnostic = errorDiagnostic(data.err, "native-tool-error");
        if (!diagnostic) fail("unsupported-native-diagnostic", "$source.failure");
        return recorded({ code: null, messageStatus: diagnostic.status, messageSignal: null,
            reason: ["recorded", "redacted"].includes(diagnostic.status) ? "error-details-recorded" : "error-details-excluded",
            diagnostic });
    }
    const messageStatus = byteLength(data.err) > 8192 ? "size-excluded"
        : sensitive(data.err) ? "sensitive-excluded" : "text-excluded";
    return recorded({ code: null, messageStatus, messageSignal: null, reason: "error-details-excluded" });
}
function resultFact(data, matchedMessages) {
    const contentStatus = !Object.hasOwn(data, "out")
        ? ["responses", "results"].some(name => Object.hasOwn(data, name)) ? "unsupported-format" : "not-supplied"
        : data.out === null ? "explicit-null" : data.out === "" ? "recorded-empty"
            : typeof data.out !== "string" ? "unsupported-format"
                : byteLength(data.out) > NATIVE_READ_LIMITS.textBytes ? "size-excluded" : "body-excluded";
    const value = normalizeResultEvidence({ version: 1, source: "native-tool-result",
        applicationError: null, statusCode: null, resultCount: null, contentStatus,
        ...(matchedMessages ? { description: resultDescription(data.d) } : {}) });
    if (!value) fail("unsupported-native-result-evidence", "$source.resultEvidence");
    return recorded(value);
}
function referencesFact(value) {
    if (value === null) return recorded(null);
    if (!Array.isArray(value)) return unavailable("unsupported", "native-wr-is-not-an-array");
    const itemFieldTypes = {};
    for (const item of value) {
        if (!object(item)) continue;
        for (const field of referenceFields) {
            if (!Object.hasOwn(item, field)) continue;
            const data = item[field], type = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
            const counts = itemFieldTypes[field] ??= {};
            counts[type] = (counts[type] ?? 0) + 1;
        }
    }
    return recorded({ nativeField: "wr", cardinality: value.length, itemFieldTypes });
}

/** Pure source parts; the v4 entrypoint binds them to the read carrier, never a writer/access grant. */
export function prepareCoworkMessageParts(record, source) {
    assertSourceJson({ record, source });
    ({ record, source } = JSON.parse(JSON.stringify({ record, source })));
    shape(source, ["sourceDocument", "pointer"], [], "$source.source");
    if (!object(record) || !object(record.data)) fail("expected-object", "$source.record");
    if (!["rc", "aq", "aa"].includes(record.event)) fail("unsupported-message-part-source", "$source.record.event");
    function metadata(value, path, limit) {
        if (typeof value !== "string" || !value.trim() || byteLength(value) > limit) fail("invalid-text", path);
        if (sensitive(value)) fail("credential-bearing-metadata", path);
    }
    metadata(record.id, "$source.record.id", 1024);
    metadata(source.sourceDocument, "$source.source.sourceDocument", 1024);
    metadata(source.pointer, "$source.source.pointer", 2048);
    if (!source.pointer.startsWith("/") || /~(?![01])/.test(source.pointer)) fail("invalid-source-pointer", "$source.source.pointer");
    const messageParts = [], coverage = [];
    const note = (kind, meaning, suffix) => {
        if (coverage.length >= 100) fail("invalid-coverage", "$source.coverage");
        const pointer = source.pointer + suffix;
        metadata(pointer, "$source.coverage.path", 2048);
        coverage.push({ kind, meaning, subject: source.sourceDocument, path: pointer });
    };
    function part(value, suffix, representation, reason, present = true) {
        if (messageParts.length >= COWORK_MESSAGE_PART_LIMIT) fail("native-message-part-bound", "$source.messageParts");
        const pointer = source.pointer + suffix;
        metadata(pointer, "$source.messageParts.evidence.pointer", 2048);
        messageParts.push({
            message: present ? screenedMessage(value, representation, reason, "$source.messageParts.message") : absent(),
            evidence: { sourceDocument: source.sourceDocument, pointer, nativeEventId: record.id },
        });
    }
    const data = record.data;
    if (Object.hasOwn(data, "e") && data.e !== record.event || Object.hasOwn(data, "type")) {
        note("native-message-discriminant-unqualified", "No text parts are derived from an incompatible discriminant.", "/data");
    } else if (record.event === "rc") {
        const children = { AdaptiveCard: "body", Container: "items", ColumnSet: "columns", Column: "items",
            Table: "rows", TableRow: "cells", TableCell: "items" };
        const knownTypes = new Set([...Object.keys(children), "TextBlock", "ActionSet", "Action.ShowCard",
            "Action.Submit", "Action.Execute", "Action.OpenUrl", "Action.ToggleVisibility"]);
        const hostFields = new Set(["transformedcontent", "hostcontent", "hostcontext", "hostinstructions",
            "systemprompt", "systeminstructions", "developerinstructions"]);
        const credentialFields = new Set(["authentication", "authorization", "credentials", "headers", "cookie", "cookies",
            "password", "passwd", "secret", "clientsecret", "token", "accesstoken", "refreshtoken", "apikey",
            "accountkey", "sharedaccesskey", "sharedaccesssignature", "sig", "privatekey"]);
        const typeCounts = {}, exclusions = { host: 0, credentialContainer: 0, credentialKey: 0, actionPayload: 0 };
        let nonStringTextBlocks = 0, unknownContextParts = 0;
        const escaped = key => key.replaceAll("~", "~0").replaceAll("/", "~1");
        function card(node, pointer, unknownAncestor = false) {
            if (Array.isArray(node)) {
                node.forEach((child, index) => card(child, `${pointer}/${index}`, unknownAncestor));
                return;
            }
            if (!object(node)) return;
            const hasType = Object.hasOwn(node, "type"), nodeType = hasType ? node.type : undefined;
            const knownType = typeof nodeType === "string" && knownTypes.has(nodeType);
            const category = knownType ? nodeType : !hasType ? "absent-type"
                : typeof nodeType === "string" ? "unqualified-recorded-type" : "unsupported-type-shape";
            typeCounts[category] = (typeCounts[category] ?? 0) + 1;
            const unknownContext = unknownAncestor || !knownType;
            const structuralChild = typeof nodeType === "string" && Object.hasOwn(children, nodeType) ? children[nodeType] : null;
            if (hasType && nodeType === "TextBlock") {
                if (Object.hasOwn(node, "text") && typeof node.text === "string") {
                    part(node.text, pointer + "/text", "card-text", unknownAncestor
                        ? "native-card-text-recorded-unknown-ancestor-context" : "native-card-text-recorded-rendering-unqualified");
                    if (unknownAncestor) unknownContextParts++;
                } else nonStringTextBlocks++;
            }
            for (const [field, value] of Object.entries(node)) {
                if (field === "type" || nodeType === "TextBlock" && field === "text") continue;
                if (sensitive(field)) { exclusions.credentialKey++; continue; }
                const normalized = field.replaceAll("_", "").replaceAll("-", "").toLowerCase();
                if (hostFields.has(normalized)) { exclusions.host++; continue; }
                if (credentialFields.has(normalized)) { exclusions.credentialContainer++; continue; }
                if (field === "data" && ["Action.Submit", "Action.Execute"].includes(nodeType)) {
                    exclusions.actionPayload++; continue;
                }
                if (value !== null && typeof value === "object") {
                    const childPointer = pointer + "/" + escaped(field);
                    metadata(source.pointer + childPointer, "$source.card.pointer", 2048);
                    card(value, childPointer, unknownContext || structuralChild !== field);
                }
            }
        }
        if (data.ri === true) note("native-runtime-injected-card-excluded", "Runtime-injected card content is excluded by policy.", "/data/ri");
        else if (Object.hasOwn(data, "ri") && typeof data.ri !== "boolean") {
            note("native-card-injection-flag-unqualified", "The source runtime-injection flag is unqualified; no card text is retained.", "/data/ri");
        } else if (!Object.hasOwn(data, "card")) note("native-card-absent", "The card subtree is absent from this source record.", "/data/card");
        else {
            card(data.card, "/data/card");
            note("native-card-parent-type-summary",
                `Object type observations: ${Object.entries(typeCounts).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}. Unqualified discriminator values are not retained.`,
                "/data/card");
            note("native-card-text-rendering-unqualified",
                `${messageParts.length} literal TextBlock string parts; ${unknownContextParts} have unqualified ancestor context. These are recorded fields, not native-visible/completed replies or interpreted controls; structural enumeration is not render or turn order.`,
                "/data/card");
            if (nonStringTextBlocks) note("native-card-non-string-text-uncollected",
                `${nonStringTextBlocks} TextBlock nodes lacked an own string text field; no text was fabricated or JSON-decoded.`, "/data/card");
            if (Object.values(exclusions).some(count => count)) note("native-card-policy-branches-excluded",
                `Excluded branches: host=${exclusions.host}, credential-container=${exclusions.credentialContainer}, credential-bearing-key=${exclusions.credentialKey}, action-payload=${exclusions.actionPayload}. No branch contents were converted into messages.`,
                "/data/card");
        }
    } else if (record.event === "aq") {
        if (!Array.isArray(data.q)) note("native-questions-unqualified", "No qualified question array was supplied.", "/data/q");
        else if (!data.q.length) note("native-questions-recorded-empty", "The recorded question array is empty.", "/data/q");
        else data.q.forEach((question, index) => {
            const pointer = `/data/q/${index}`;
            if (!object(question)) {
                note("native-question-unqualified", "Non-object question content is not converted to text.", pointer);
                return;
            }
            part(question.question, pointer + "/question", "plain-text", "native-question-text-author-unqualified", Object.hasOwn(question, "question"));
            if (Object.hasOwn(question, "header")) part(question.header, pointer + "/header", "plain-text", "native-question-header-author-unqualified");
            if (Object.hasOwn(question, "options") && !Array.isArray(question.options)) {
                note("native-question-options-unqualified", "The option collection is not a qualified array.", pointer + "/options");
            } else (question.options ?? []).forEach((option, optionIndex) => {
                const optionPointer = `${pointer}/options/${optionIndex}`;
                if (typeof option === "string") part(option, optionPointer, "plain-text", "native-question-option-label-author-unqualified");
                else if (object(option)) {
                    part(option.label, optionPointer + "/label", "plain-text", "native-question-option-label-author-unqualified", Object.hasOwn(option, "label"));
                    if (Object.hasOwn(option, "description")) part(option.description, optionPointer + "/description",
                        "plain-text", "native-question-option-description-author-unqualified");
                } else note("native-question-option-unqualified", "This option has no qualified label field.", optionPointer);
            });
        });
    } else if (!object(data.answers)) note("native-answers-unqualified", "No qualified answer object was supplied.", "/data/answers");
    else if (!Object.keys(data.answers).length) note("native-answers-recorded-empty", "The recorded answer object is empty.", "/data/answers");
    else for (const [index, answer] of Object.entries(data.answers)) {
        if (!/^(0|[1-9]\d*)$/.test(index)) {
            note("native-answer-index-unqualified", "An answer key is not a qualified source question index.", "/data/answers");
            continue;
        }
        part(answer, "/data/answers/" + index, "plain-text", "native-acknowledged-answer-author-unqualified");
    }
    note("native-message-parts-await-shared-contract",
        "These source-pointer parts are preparation only; do not publish them as invented native frames or concatenated replies.", "/data");
    const prepared = { messageParts, coverage };
    assertSourceJson(prepared, "$source.messageParts");
    return prepared;
}

function adaptObservation(observation, context, index, matchedMessages = false, withResults = false) {
    const path = `$source.observations[${index}]`;
    shape(observation, ["record", "source", "ordering"], [], path);
    shape(observation.source, ["sourceDocument", "pointer"], [], `${path}.source`);
    const { record: raw, source, ordering } = observation;
    if (!object(raw)) fail("expected-object", `${path}.record`);
    if (typeof source.pointer !== "string" || !source.pointer.startsWith("/") || /~(?![01])/.test(source.pointer)) {
        fail("invalid-source-pointer", `${path}.source.pointer`);
    }
    const envelope = {
        contractVersion: NATIVE_READ_CONTRACT, ...context, record: {}, ordering: { ...ordering },
        qualifiedFields: {}, evidenceReferences: {}, outcomes: {}, coverage: [],
    };
    const reference = suffix => ({ sourceDocument: source.sourceDocument, pointer: source.pointer + suffix,
        ...(Object.hasOwn(raw, "id") ? { nativeEventId: raw.id } : {}) });
    const coverage = (kind, meaning, suffix = "") => envelope.coverage.push({
        kind, meaning, subject: source.sourceDocument, path: source.pointer + suffix,
    });
    const fact = (name, value, suffix) => {
        envelope.qualifiedFields[name] = value;
        envelope.evidenceReferences[name] = reference(suffix);
    };
    const outcome = (name, value, evidenceName, suffix) => {
        envelope.outcomes[name] = value;
        envelope.evidenceReferences[evidenceName] = reference(suffix);
    };
    coverage("source-observation", "Only supplied source records are represented; this is not current access or producer completeness.");

    if (Object.hasOwn(raw, "task")) {
        if (Object.hasOwn(raw, "event") || Object.hasOwn(raw, "data")) fail("ambiguous-cowork-record", path);
        if (!object(raw.task)) fail("expected-object", `${path}.record.task`);
        if (raw.snapshot != null && !object(raw.snapshot)) fail("expected-object", `${path}.record.snapshot`);
        envelope.record.task = pick(raw.task, ["sessionId", "taskId", "ic3ThreadId", "parentConversationId"]);
        const state = raw.task.state;
        if (state == null || state === "" || taskStates.includes(state)) {
            if (Object.hasOwn(raw.task, "state")) envelope.record.task.state = state;
            outcome("task", { unit: "native-task", state: state || "unknown", basis: "task.state", aggregateToolSuccess: false },
                "taskOutcome", "/task/state");
        } else {
            if (typeof state === "string" && !sensitive(state)) envelope.record.task.state = state;
            coverage("unqualified-task-state", "The supplied task state has no qualified mapping; no completion is inferred.", "/task/state");
        }
        envelope.record.snapshot = pick(raw.snapshot ?? {}, ["ic3ThreadId"]);
        if (raw.snapshot && Object.hasOwn(raw.snapshot, "activeModel")) {
            const model = raw.snapshot.activeModel;
            const value = model === null ? recorded(null) : typeof model === "string" && model.trim()
                ? screened(model, path) : unavailable("unsupported", "unqualified-snapshot-model");
            fact("model", { ...value, ...(value.availability === "recorded" ? { scope: "snapshot" } : {}) }, "/snapshot/activeModel");
        }
        coverage("snapshot-not-call-outcome", "Task state and snapshot model do not establish any tool outcome or per-call model.");
        if (Object.keys(raw).some(field => !["task", "snapshot"].includes(field))
            || Object.keys(raw.task).some(field => !["sessionId", "taskId", "ic3ThreadId", "parentConversationId", "state"].includes(field))
            || Object.keys(raw.snapshot ?? {}).some(field => !["ic3ThreadId", "activeModel"].includes(field))) {
            coverage("unmapped-source-fields", "Additional source fields are not interpreted or copied.");
        }
        return envelope;
    }

    for (const field of ["id", "event", "data"]) if (!Object.hasOwn(raw, field)) fail("missing-field", `${path}.record.${field}`);
    if (!object(raw.data)) fail("expected-object", `${path}.record.data`);
    const data = raw.data, type = raw.event;
    if (typeof type !== "string") fail("invalid-text", `${path}.record.event`);
    const known = Object.hasOwn(identityFields, type) || matchedMessages && type === "a";
    const kept = known ? pick(data, type === "a" ? ["id"] : identityFields[type]) : {};
    envelope.record = { id: raw.id, event: type, data: kept };
    if (!Object.hasOwn(envelope.ordering, "nativeEventId")) envelope.ordering.nativeEventId = raw.id;
    if (!known) {
        coverage("unsupported-event-type", "Native identity/type retained without payload interpretation or inferred relationships.");
        if (type === "rc" && object(data.card)) coverage("native-card-text-unprojected",
            "The recorded card can contain multiple text leaves; separate source-part representations are required instead of a synthetic joined reply.", "/data/card");
        if (type === "ar" && data.r === "") coverage("native-response-recorded-empty",
            "The response string is recorded-empty, not a missing or additional acknowledged answer.", "/data/r");
        if (type === "ci") coverage("native-citation-not-operation-result",
            "Citation text and references are not a reply, tool input or returned API outcome.");
        if (type === "fc" || type === "fu") coverage("native-file-metadata-not-operation-result",
            "File-change or enrichment metadata is not conversational text or proof of a tool/API execution.");
        return envelope;
    }
    const mapped = new Set(type === "a" ? ["id"] : identityFields[type]);
    const sources = matchedMessages ? matchedMessageSources : messageSources;
    if (Object.hasOwn(sources, type)) {
        const source = sources[type], present = Object.hasOwn(data, source.field), at = `/data/${source.field}`;
        mapped.add(source.field);
        let message;
        if (Object.hasOwn(data, "e") && data.e !== type || Object.hasOwn(data, "type")) {
            message = unavailable("unqualified", "native-message-discriminant-unqualified");
        } else if (!present && (type === "th" || type === "fr")) {
            coverage("native-text-marker-without-content",
                "This observation has no recorded text field; identity or terminal markers do not supply an empty message.", at);
        } else if (!present) message = absent();
        else if (type === "fr" && data.ri === true) {
            message = unavailable("excluded-by-policy", "native-runtime-injected-content-excluded");
        } else if (type === "fr" && Object.hasOwn(data, "ri") && typeof data.ri !== "boolean") {
            message = unavailable("unqualified", "native-runtime-injection-flag-unqualified");
        } else message = screenedMessage(data[source.field], source.representation, source.reason, path, source.author);
        if (message) fact("message", message, at);
        if (type === "fr") mapped.add("ri");
        coverage(type === "th" ? "native-thinking-fragment" : type === "dx" ? "native-text-delta" : "native-message-observation",
            source.author ? "Author is the matched native event's message role, not inferred human intent or reply completion."
                : type === "th" ? "Thinking-stream observations are not completed replies; text fragments are not concatenated."
                : "Text remains an individual source observation with unqualified authorship; no turn, stream ID or completed reply is synthesized.", at);
    }
    if (type === "aq" || type === "aa") {
        const field = type === "aq" ? "q" : "answers";
        mapped.add(field);
        let message, at = `/data/${field}`;
        if (Object.hasOwn(data, "e") && data.e !== type || Object.hasOwn(data, "type")) {
            message = unavailable("unqualified", "native-message-discriminant-unqualified");
        } else if (type === "aq") {
            if (!Array.isArray(data.q)) message = unavailable("unsupported", "native-question-collection-not-an-array");
            else if (data.q.length !== 1) message = unavailable("unqualified", "native-question-cardinality-not-one");
            else if (!object(data.q[0])) message = unavailable("unsupported", "native-question-not-an-object");
            else {
                at += "/0/question";
                message = Object.hasOwn(data.q[0], "question")
                    ? screenedMessage(data.q[0].question, "plain-text", "native-question-text-author-unqualified", path) : absent();
            }
            coverage("native-question-text-only", "Question wording only; headers, choices and question/answer associations are not projected.", at);
        } else if (!object(data.answers)) message = unavailable("unsupported", "native-answer-collection-not-an-object");
        else {
            const entries = Object.entries(data.answers);
            if (entries.length !== 1) message = unavailable("unqualified", "native-answer-cardinality-not-one");
            else if (!/^(0|[1-9]\d*)$/.test(entries[0][0])) message = unavailable("unqualified", "native-answer-index-unqualified");
            else {
                at += "/" + entries[0][0];
                message = screenedMessage(entries[0][1], "plain-text", "native-acknowledged-answer-author-unqualified", path);
            }
        }
        fact("message", message, at);
        coverage("native-question-answer-observation",
            "Question or acknowledged-answer text is not an executed action or a new inferred turn; source correlation remains unprojected.");
    }
    if (Object.hasOwn(data, "ts")) {
        mapped.add("ts");
        if (data.ts === null || typeof data.ts === "number" || typeof data.ts === "string" && byteLength(data.ts) <= 256 && !sensitive(data.ts)) kept.ts = data.ts;
        else coverage("source-time-excluded", "Unsupported or credential-bearing source timestamp excluded.", "/data/ts");
        coverage("source-time-not-projected", "Source ts is not capture time; no timestamp unit or event chronology is inferred.", "/data/ts");
    }
    if (type === "ts" || type === "tx") {
        let name = !Object.hasOwn(data, "tn") ? absent() : data.tn === null ? recorded(null)
            : typeof data.tn === "string" && data.tn.trim() ? screened(data.tn, path)
                : unavailable("unsupported", "unqualified-native-tool-name");
        if ((typeof data.tid !== "string" || !data.tid.trim()) && name.availability === "recorded") {
            name = unavailable("unqualified", "tool-name-call-association-unavailable");
        }
        fact("toolName", name, "/data/tn");
        if (name.availability !== "recorded") delete kept.tn;
        if (typeof data.tid !== "string" || !data.tid.trim()) {
            coverage("missing-native-call-id", "No native call identity is established; no tool outcome is attributed.", "/data/tid");
        }
    }
    if (type === "ts") {
        mapped.add("inp");
        let input = inputFact(data, path);
        if ((typeof data.tid !== "string" || !data.tid.trim()) && ["recorded", "recorded-empty", "explicit-null"].includes(input.availability)) {
            input = unavailable("unqualified", "input-call-association-unavailable");
        }
        fact("input", input, "/data/inp");
        if (["recorded", "recorded-empty", "explicit-null"].includes(input.availability)) kept.inp = data.inp;
        const value = input.value;
        if (data.tn === "mcp__graph__CallGraph" && object(value) && value.method === "POST"
            && object(value.body) && Array.isArray(value.body.requests)) {
            outcome("nestedApi", { unit: "nested-api-result", availability: "unqualified", observed: [],
                declaredRequestCount: value.body.requests.length, declaredRequestCountIsSuccessDenominator: false },
            "returnedResults", "/data/inp");
            coverage("declared-requests-only", "body.requests counts declared entries, not dispatches, unique members or returned results.", "/data/inp");
        }
    }
    if (type === "tx") {
        for (const field of ["ok", "dur", "err", "wr", "out"]) mapped.add(field);
        if (Object.hasOwn(data, "ok") && (data.ok === null || typeof data.ok === "boolean")) kept.ok = data.ok;
        if (typeof data.tid === "string" && data.tid.trim()) {
            outcome("tool", { unit: "native-tool", state: data.ok === true ? "succeeded" : data.ok === false ? "failed" : "unknown",
                basis: "tx.data.ok" }, "toolOutcome", "/data/ok");
        }
        if (typeof data.ok !== "boolean") coverage("unqualified-native-tool-outcome", "No explicit native completion boolean is supplied.", "/data/ok");
        const duration = !Object.hasOwn(data, "dur") ? absent() : data.dur === null ? recorded(null)
            : typeof data.dur === "number" && data.dur >= 0
                ? { ...recorded(data.dur), unit: "ms", basis: "tx.data.dur",
                    boundary: "provider-tool-duration", comparableToUserResponseLatency: false }
                : unavailable("unsupported", "unqualified-native-duration");
        fact("callElapsed", duration, "/data/dur");
        if (duration.availability === "recorded") kept.dur = data.dur;
        if (data.ok === false || Object.hasOwn(data, "err")) fact("failure", failureFact(data, withResults), "/data/err");
        if (withResults) {
            fact("resultEvidence", resultFact(data, matchedMessages), "/data");
            envelope.evidenceReferences.resultEvidence = ["out", ...(matchedMessages ? ["d"] : [])]
                .filter(name => Object.hasOwn(data, name)).map(name => reference("/data/" + name));
            if (!envelope.evidenceReferences.resultEvidence.length) envelope.evidenceReferences.resultEvidence = reference("/data");
            if (matchedMessages) mapped.add("d");
            else if (Object.hasOwn(data, "d")) coverage("native-description-contract-unqualified",
                "This older producer has no qualified description mapping; no source text or fallback is retained.", "/data/d");
            coverage("native-result-body-not-interpreted",
                "Output availability and a qualified literal description are not API statuses, member counts, application success or task completion.", "/data");
        }
        if (Object.hasOwn(data, "wr")) fact("resultReferences", referencesFact(data.wr), "/data/wr");
        if (data.tn === "mcp__graph__CallGraph") {
            const otherResults = ["responses", "results"].some(field => Object.hasOwn(data, field));
            const resultAvailability = otherResults ? "unqualified" : !Object.hasOwn(data, "out") ? "absent-in-response"
                : data.out === null ? "explicit-null" : "unqualified";
            outcome("nestedApi", { unit: "nested-api-result", availability: resultAvailability, observed: [],
                declaredRequestCount: null, declaredRequestCountIsSuccessDenominator: false }, "returnedResults", "/data");
            coverage("returned-member-outcomes-unavailable",
                "No qualified member-result facts are supplied. Absent out is a source-field absence, not an empty successful batch.", "/data/out");
        }
        coverage("native-tool-not-http-outcome", "Native completion and references do not establish HTTP exchanges or API outcomes.");
    }
    if (type === "taa") {
        mapped.add("approved");
        if (typeof data.approved === "boolean") {
            kept.approved = data.approved;
            fact("approval", recorded(data.approved), "/data/approved");
        } else coverage("unqualified-approval", "Only an explicit approval boolean is mapped; approval is not execution.", "/data/approved");
    }
    if (Object.keys(data).some(field => !mapped.has(field)) || Object.keys(raw).some(field => !["id", "event", "data"].includes(field))) {
        coverage("unmapped-source-fields", "Additional source fields are not interpreted or copied.");
    }
    return envelope;
}

function adaptSourceRecords(observations, context, withMessageParts, matchedMessages = false, withResults = false) {
    if (!Array.isArray(observations) || observations.length === 0 || observations.length > NATIVE_READ_LIMITS.records) {
        fail("invalid-record-batch", "$source.observations");
    }
    assertSourceJson({ observations, context });
    const supplied = JSON.parse(JSON.stringify({ observations, context }));
    shape(supplied.context, ["scope", "capture"], [], "$source.context");
    if (!object(supplied.context.scope) || supplied.context.scope.surface !== "cowork") fail("unsupported-cowork-surface", "$source.context.scope");
    const parserVersion = withResults ? matchedMessages ? COWORK_MATCHED_RESULT_ADAPTER_VERSION : COWORK_RESULT_ADAPTER_VERSION
        : matchedMessages ? COWORK_MATCHED_ADAPTER_VERSION
        : withMessageParts ? COWORK_PARTS_ADAPTER_VERSION : COWORK_SOURCE_ADAPTER_VERSION;
    if (!object(supplied.context.capture) || supplied.context.capture.parserVersion !== parserVersion) {
        fail("unsupported-cowork-parser", "$source.context.capture");
    }
    const envelopes = supplied.observations.map((row, index) => {
        const envelope = adaptObservation(row, supplied.context, index, matchedMessages, withResults);
        if (!withMessageParts || !["rc", "aq", "aa"].includes(row.record.event)) return envelope;
        const prepared = prepareCoworkMessageParts(row.record, row.source);
        delete envelope.qualifiedFields.message;
        delete envelope.evidenceReferences.message;
        envelope.messageParts = prepared.messageParts;
        envelope.coverage = [
            ...envelope.coverage.filter(item => !["unsupported-event-type", "native-card-text-unprojected", "native-question-text-only"].includes(item.kind)),
            ...prepared.coverage.filter(item => item.kind !== "native-message-parts-await-shared-contract"),
            { kind: "native-message-parts-read-carrier", subject: row.source.sourceDocument, path: row.source.pointer,
                meaning: "Source text uses the bounded multipart read carrier. Parts preserve parent identity and coordinates; they are not extra turns, calls, completed replies or writer admission." },
        ];
        return envelope;
    });
    projectNativeReadModel(envelopes);
    return envelopes;
}

/** Existing v3 source behavior; no multipart admission is inferred from input data. */
export function adaptCoworkSourceRecords(observations, context) {
    return adaptSourceRecords(observations, context, false);
}

/** Explicit v4 producer for the admitted multipart read carrier, not a writer grant. */
export function adaptCoworkSourceRecordsWithMessageParts(observations, context) {
    return adaptSourceRecords(observations, context, true);
}

export function adaptMatchedCoworkSourceRecords(observations, context) {
    return adaptSourceRecords(observations, context, true, true);
}

export function adaptCoworkSourceRecordsWithResultFacts(observations, context) {
    return adaptSourceRecords(observations, context, true,
        context?.capture?.parserVersion === COWORK_MATCHED_RESULT_ADAPTER_VERSION, true);
}
