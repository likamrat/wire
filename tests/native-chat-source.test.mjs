import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeChatObservation, CHAT_SOURCE_LIMITS, ChatSourceDecodeError } from "../lib/native-chat-source.mjs";
import { projectNativeReadModel, nativeWriterAdmission } from "../lib/native-read-model.mjs";
import { chatSource, nativeCallsSource } from "./native-chat-source-fixtures.mjs";

const invocationFacts = decoded => decoded.sourceObservations.filter(row =>
    ["native-invocation", "unsupported-native-invocation"].includes(row.kind));

test("source decoder feeds real native call identities and individual inputs into the existing read model", () => {
    const input = nativeCallsSource(), before = structuredClone(input);
    const decoded = decodeNativeChatObservation(input);
    const result = projectNativeReadModel(decoded.envelopes);
    const conversation = result.conversations[0];
    assert.deepEqual(conversation.calls.map(call => call.nativeCallId), ["invented-call-one", "invented-call-two"]);
    assert.deepEqual(conversation.calls[0].observations[0].fields.input.value, { query: "First invented query" });
    assert.equal(conversation.calls[1].observations[0].fields.input.availability, "recorded-empty");
    assert.equal(conversation.calls[0].outcome.state, "unknown");
    assert.equal(conversation.observations[0].identity.requestId, "invented-message-request");
    assert.deepEqual(conversation.observations[0].ordering, input.ordering);
    assert.equal(conversation.calls[0].observations[0].fields.input.evidence[0].pointer,
        "/frames/2/messages/4/invocation");
    assert.equal(decoded.status, "inactive");
    assert.equal(decoded.parserProvenance.applicability, "historical-only-current-unqualified");
    assert.equal(result.admission.blockers.length, 3);
    assert.deepEqual(result.admission, nativeWriterAdmission());
    assert.doesNotMatch(JSON.stringify(decoded), /RAW_METADATA_NOT_RETAINED|RAW_ERROR_PROSE_NOT_RETAINED/);
    assert.deepEqual(input, before);
});

test("Task payload variants retain original coordinates without claiming task results are enterprise outcomes", () => {
    const payload = [
        { type: "task", taskId: "invented-task", conversationId: "invented-chat-conversation",
            status: "Completed", name: "Invented task", result: "RAW_TASK_RESULT_NOT_RETAINED",
            steps: [{ id: "invented-step-one", status: "Running", description: "RAW_STEP_PROSE_NOT_RETAINED" }] },
        { type: "task_step", taskId: "invented-task", conversationId: "invented-chat-conversation",
            id: "invented-step-two", status: "FutureState" },
        { type: "task_steps", taskId: "invented-task", conversationId: "invented-chat-conversation",
            steps: [{ id: "invented-step-three" }] },
        { type: "task_reasoning", taskId: "invented-task", conversationId: "invented-chat-conversation",
            reasoningId: "invented-reasoning", idKey: "invented-distinct-id-key", reasoningEventType: 2,
            content: "RAW_REASONING_PROSE_NOT_RETAINED",
            annotation: { type: "tool", payload: "RAW_OPAQUE_ANNOTATION_NOT_RETAINED" } },
    ];
    const input = chatSource({ messageId: "invented-task-message", messageType: "Task", text: JSON.stringify(payload) });
    const before = structuredClone(input);
    const decoded = decodeNativeChatObservation(input);
    assert.deepEqual(decoded.sourceObservations.map(row => row.kind), ["task", "task_step", "task_steps", "task_reasoning"]);
    assert.deepEqual(decoded.sourceObservations.map(row => row.source.decodedPointer), ["/0", "/1", "/2", "/3"]);
    assert.equal(decoded.sourceObservations[1].historicalProjection, "outside-first-element-projection");
    const task = decoded.sourceObservations[0];
    assert.equal(task.fields.taskId.value, "invented-task");
    assert.equal(task.fields.statusLiteral.value, "Completed");
    assert.equal(task.fields.status.availability, "unqualified");
    assert.equal(task.fields.result.availability, "excluded-by-policy");
    assert.equal(task.fields.steps[0].fields.statusLiteral.value, "Running");
    assert.equal(decoded.sourceObservations[2].fields.steps[0].fields.statusLiteral.availability, "absent-in-response");
    const reasoning = decoded.sourceObservations[3];
    assert.equal(reasoning.fields.reasoningId.value, "invented-reasoning");
    assert.equal(reasoning.fields.idKey.value, "invented-distinct-id-key");
    assert.equal(reasoning.fields.annotationType.value, "tool");
    assert.equal(reasoning.fields.annotation.availability, "unqualified");
    assert.ok(decoded.limitations.some(row => row.code === "opaque-tool-annotation"));
    const model = projectNativeReadModel(decoded.envelopes).conversations[0];
    assert.deepEqual(model.calls, []);
    assert.deepEqual(model.taskOutcomes, []);
    assert.equal(model.observations[0].identity.nativeType, "Task");
    assert.equal(decoded.provenance.identity.messageId.value, "invented-task-message");
    assert.doesNotMatch(JSON.stringify(decoded), /RAW_TASK_RESULT|RAW_STEP_PROSE|RAW_REASONING_PROSE|RAW_OPAQUE_ANNOTATION/);
    assert.deepEqual(input, before);
});

test("the two clarification actions preserve source inputs and callId without inventing native call or task identity", () => {
    for (const actionId of ["clarification_ask_user_question", "clarification_request_browser_take_control"]) {
        const questions = [{ question: "Invented choice", options: [
            { role: "action", label: "Continue", submitResponse: "invented-continue" },
            { role: "abort", label: "Cancel", submitResponse: "invented-cancel" },
        ] }];
        const input = chatSource({ messageId: "invented-clarification", messageType: "TriggerExtension",
            actionId, sourceRequestId: "invented-source-request",
            invocation: JSON.stringify([{ callId: "invented-call-correlation", widgetId: "invented-widget",
                function: { name: actionId, arguments: JSON.stringify({ questions }) } }]) });
        const decoded = decodeNativeChatObservation(input), row = decoded.sourceObservations[0];
        assert.equal(row.kind, "clarification");
        assert.equal(row.fields.actionId.value, actionId);
        assert.deepEqual(row.fields.questions.value, questions);
        assert.equal(row.fields.sourceRequestId.value, "invented-source-request");
        assert.equal(row.fields.responseRequestId.value, "invented-envelope-request");
        assert.equal(row.fields.responseRequestId.source.pointer, "/frames/2/requestId");
        assert.equal(row.invocations[0].fields.callId.value, "invented-call-correlation");
        assert.equal(row.invocations[0].fields.nativeCallId.availability, "absent-in-response");
        assert.equal(row.invocations[0].source.decodedPointer, "/0");
        assert.ok(!Object.hasOwn(row.fields, "taskId"));
        assert.deepEqual(projectNativeReadModel(decoded.envelopes).conversations[0].calls, []);
        assert.doesNotMatch(JSON.stringify(decoded), /cq-placeholder|browser-take-control-placeholder/);
    }
});

test("confirmation cards remain prospective and retain only original action IDs, not widget or task-map inferences", () => {
    const input = chatSource({ messageId: "invented-confirmation", messageType: "TriggerConfirmation",
        widgetData: { toolName: "MUST_NOT_BECOME_ACTION_ID" }, confirmationMetadata: { prose: "RAW_CONFIRMATION_METADATA" },
        adaptiveCards: [{ body: [{ text: "RAW_CARD_PROSE" }], actions: [
            { type: "Action.Submit", data: { message: { sourceId: "invented-source-correlation" } } },
            { type: "Action.Submit", data: { message: { actionId: "invented-explicit-action" } } },
        ] }] });
    const decoded = decodeNativeChatObservation(input), row = decoded.sourceObservations[0];
    assert.equal(row.kind, "confirmation");
    assert.equal(row.fields.actionId.availability, "absent-in-response");
    assert.equal(row.fields.isConsequential.availability, "absent-in-response");
    assert.equal(row.fields.cardCount.value, 1);
    assert.equal(row.submitActions[0].fields.actionId.availability, "absent-in-response");
    assert.equal(row.submitActions[1].fields.actionId.value, "invented-explicit-action");
    assert.equal(row.submitActions[0].fields.sourceId.value, "invented-source-correlation");
    assert.equal(row.fields.confirmationMetadata.availability, "unqualified");
    const model = projectNativeReadModel(decoded.envelopes).conversations[0];
    assert.deepEqual(model.calls, []);
    assert.deepEqual(model.observations[0].outcomes, {});
    assert.ok(!model.observations[0].fields.approval);
    assert.doesNotMatch(JSON.stringify(decoded), /MUST_NOT_BECOME_ACTION_ID|RAW_CARD_PROSE|RAW_CONFIRMATION_METADATA/);
    const plugin = decodeNativeChatObservation(chatSource({ messageId: "invented-plugin", messageType: "TriggerPlugin",
        actionId: "UNQUALIFIED_PLUGIN_OPERATION", result: "RAW_PLUGIN_RESULT" }));
    assert.equal(plugin.sourceObservations[0].kind, "trigger-plugin");
    assert.ok(plugin.limitations.some(row => row.code === "plugin-operation-schema-unqualified"));
    assert.doesNotMatch(JSON.stringify(plugin), /UNQUALIFIED_PLUGIN_OPERATION|RAW_PLUGIN_RESULT/);
});

test("ordinary text remains source-qualified across captures while completion names never supply a call outcome", () => {
    const first = chatSource({ messageId: "invented-text", author: "bot", text: "First original text." });
    const second = structuredClone(first);
    second.capture.captureId = "invented-second-capture";
    second.record.text = "Second original text.";
    const one = decodeNativeChatObservation(first), two = decodeNativeChatObservation(JSON.stringify(second));
    const model = projectNativeReadModel([...one.envelopes, ...two.envelopes]).conversations[0];
    assert.deepEqual(model.messages.map(row => row.value.text), ["First original text.", "Second original text."]);
    assert.notEqual(model.messages[0].observationKey, model.messages[1].observationKey);
    const anotherAccount = structuredClone(first);
    anotherAccount.scope.account.subjectId = "invented-other-account";
    assert.equal(projectNativeReadModel([...one.envelopes, ...decodeNativeChatObservation(anotherAccount).envelopes]).conversations.length, 2);
    for (const messageType of ["CompletePlugin", "CompleteExtension", "ExecuteAction", "InvokeAction"]) {
        const source = nativeCallsSource();
        source.record.messageType = messageType;
        source.record.result = { value: "Success", message: "RAW_RESULT_PROSE" };
        source.record.status = "Completed";
        const decoded = decodeNativeChatObservation(source);
        assert.ok(decoded.limitations.some(row => row.code === "completion-payload-unqualified"));
        assert.ok(projectNativeReadModel(decoded.envelopes).conversations[0].calls.every(call => call.outcome.state === "unknown"));
        assert.doesNotMatch(JSON.stringify(decoded), /RAW_RESULT_PROSE|"succeeded"/);
    }
});

test("callId-only and ambiguous native invocations remain explicit indexed source facts, never aliased or coalesced", () => {
    const input = chatSource({ messageId: "invented-callid-only", messageType: "Progress",
        invocation: JSON.stringify([{ type: "function", callId: "invented-not-native-id",
            function: { name: "invented_lookup", arguments: { query: "Not identity-qualified" } } }]) });
    const decoded = decodeNativeChatObservation(input);
    assert.deepEqual(projectNativeReadModel(decoded.envelopes).conversations[0].calls, []);
    assert.equal(invocationFacts(decoded)[0].kind, "unsupported-native-invocation");
    assert.equal(invocationFacts(decoded)[0].fields.callId.value, "invented-not-native-id");
    assert.equal(invocationFacts(decoded)[0].fields.nativeCallId.availability, "absent-in-response");
    assert.equal(invocationFacts(decoded)[0].source.decodedPointer, "/0");
    const duplicate = nativeCallsSource();
    duplicate.record.invocation = JSON.stringify([
        { id: "invented-duplicate", type: "function", function: { name: "invented_one", arguments: 1 } },
        { id: "invented-duplicate", type: "function", function: { name: "invented_two", arguments: 2 } },
    ]);
    const result = decodeNativeChatObservation(duplicate);
    assert.equal(invocationFacts(result).length, 2);
    assert.deepEqual(invocationFacts(result).map(row => row.fields.input.value), [1, 2]);
    assert.ok(result.limitations.some(row => row.code === "ambiguous-native-call-id"));
    assert.deepEqual(projectNativeReadModel(result.envelopes).conversations[0].calls, []);
    duplicate.record.invocation = JSON.stringify(["RAW_BAD_SERIALIZED_ENTRY",
        { id: "invented-still-observed", type: "function", function: { name: "invented_two", arguments: 2 } }]);
    const partial = decodeNativeChatObservation(duplicate);
    assert.equal(invocationFacts(partial).length, 2);
    assert.equal(invocationFacts(partial)[0].kind, "unsupported-native-invocation");
    assert.equal(invocationFacts(partial)[1].fields.nativeCallId.value, "invented-still-observed");
    assert.deepEqual(projectNativeReadModel(partial.envelopes).conversations[0].calls, []);
    assert.doesNotMatch(JSON.stringify(partial), /RAW_BAD_SERIALIZED_ENTRY/);
});

test("native inputs keep explicit null, empty, absent and original serialized-string distinctions", () => {
    for (const [fn, availability, expected] of [
        [{ name: "invented_lookup" }, "absent-in-response", undefined],
        [{ name: "invented_lookup", arguments: null }, "explicit-null", null],
        [{ name: "invented_lookup", arguments: "" }, "recorded-empty", ""],
        [{ name: "invented_lookup", arguments: "{}" }, "recorded", "{}"],
        [{ name: "invented_lookup", arguments: "original non-JSON input" }, "recorded", "original non-JSON input"],
    ]) {
        const decoded = decodeNativeChatObservation(chatSource({ messageId: "invented-input", messageType: "Progress",
            invocation: JSON.stringify([{ type: "function", id: "invented-input-call", function: fn }]) }));
        const field = projectNativeReadModel(decoded.envelopes).conversations[0].calls[0].observations[0].fields.input;
        assert.equal(field.availability, availability);
        assert.equal(field.value, expected);
        if (availability === "absent-in-response") assert.ok(!Object.hasOwn(field, "value"));
    }
});

test("credentials are excluded from source facts and never retained in native identity carriers", () => {
    const credential = "Bearer " + "z".repeat(40);
    const source = nativeCallsSource();
    source.record.invocation = JSON.stringify([{ id: "invented-safe-id", type: "function",
        function: { name: "invented_safe_name", arguments: JSON.stringify({ authorization: credential }) } }]);
    const decoded = decodeNativeChatObservation(source);
    assert.equal(invocationFacts(decoded)[0].fields.input.availability, "credential-excluded");
    assert.ok(!Object.hasOwn(decoded.envelopes[0].record, "invocation"));
    assert.doesNotMatch(JSON.stringify(decoded), /Bearer|z{40}/);
    source.record.invocation = JSON.stringify([{ id: "invented-encoded-secret", type: "function",
        function: { name: "invented_safe_name", arguments: JSON.stringify(JSON.stringify({ password: "invented-encoded-password" })) } }]);
    const encodedSecret = decodeNativeChatObservation(source);
    assert.equal(invocationFacts(encodedSecret)[0].fields.input.availability, "credential-excluded");
    assert.doesNotMatch(JSON.stringify(encodedSecret), /invented-encoded-password/);
    const chat = decodeNativeChatObservation(chatSource({ messageId: "invented-safe-message", author: "bot", text: credential }));
    assert.equal(chat.envelopes[0].qualifiedFields.message.availability, "credential-excluded");
    assert.doesNotMatch(JSON.stringify(chat), /Bearer|z{40}/);
    const task = decodeNativeChatObservation(chatSource({ messageId: credential, messageType: "Task", text: JSON.stringify({
        type: "task_reasoning", taskId: "invented-task", conversationId: "invented-chat-conversation",
        annotation: { type: "tool", arguments: { password: "invented-password" } },
    }) }));
    assert.deepEqual(task.envelopes, []);
    assert.equal(task.sourceObservations[0].fields.annotation.availability, "credential-excluded");
    assert.doesNotMatch(JSON.stringify(task), /Bearer|z{40}|invented-password/);
    const metadata = chatSource({});
    metadata.scope.account.subjectId = credential;
    assert.throws(() => decodeNativeChatObservation(metadata), error =>
        error instanceof ChatSourceDecodeError && error.code === "credential-bearing-context" && !error.message.includes(credential));
});

test("malformed and unknown source payloads remain explicit without raw error content or synthetic identities", () => {
    for (const [record, code] of [
        [{ messageId: "invented-bad", messageType: "Task", text: "RAW_MALFORMED_JSON" }, "malformed-json"],
        [{ messageId: "invented-bad", messageType: "Task", text: JSON.stringify({ type: "future-task-type" }) }, "unsupported-task-payload-type"],
        [{ messageId: "invented-bad", messageType: "Task", text: "[]" }, "task-array-bound-or-empty"],
        [{ messageId: "invented-bad", invocation: "[RAW_MALFORMED_JSON" }, "malformed-json"],
        [{ messageId: "invented-bad", messageType: "TriggerExtension", actionId: "unqualified-enterprise-operation" }, "unsupported-clarification-action"],
        [{ messageId: "invented-bad", messageType: "FutureMessageType", text: "RAW_FUTURE_BODY" }, "message-type-semantics-unqualified"],
    ]) {
        const result = decodeNativeChatObservation(chatSource(record));
        assert.ok(result.limitations.some(row => row.code === code), code);
        assert.doesNotMatch(JSON.stringify(result), /RAW_MALFORMED_JSON|RAW_FUTURE_BODY|unqualified-enterprise-operation/);
        assert.equal(projectNativeReadModel(result.envelopes).admission.blockers.length, 3);
    }
    const missing = decodeNativeChatObservation(chatSource({ messageType: "Task", text: JSON.stringify({
        type: "task_reasoning", taskId: "invented-task", conversationId: "invented-chat-conversation", content: "RAW_REASONING",
    }) }));
    assert.deepEqual(missing.envelopes, []);
    assert.equal(missing.sourceObservations[0].fields.reasoningId.availability, "absent-in-response");
    assert.equal(missing.provenance.identity.messageId.availability, "absent-in-response");
    assert.ok(missing.limitations.some(row => row.code === "original-message-id-required-for-read-model"));
    assert.doesNotMatch(JSON.stringify(missing), /placeholder|RAW_REASONING/);
});

test("each encoded layer and exact byte/depth/array boundary is bounded before projection", () => {
    const exact = chatSource({ messageId: "invented-bound", messageType: "Progress", ignored: "" });
    exact.record.ignored = ".".repeat(CHAT_SOURCE_LIMITS.inputBytes - Buffer.byteLength(JSON.stringify(exact)));
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), CHAT_SOURCE_LIMITS.inputBytes);
    assert.equal(decodeNativeChatObservation(exact).envelopes.length, 1);
    assert.equal(decodeNativeChatObservation(JSON.stringify(exact)).envelopes.length, 1);
    exact.record.ignored += ".";
    assert.throws(() => decodeNativeChatObservation(exact), error => error.code === "source-byte-bound");
    assert.throws(() => decodeNativeChatObservation(JSON.stringify(exact)), error => error.code === "encoded-byte-bound");
    const task = { type: "task", taskId: "invented-task", conversationId: "invented-chat-conversation", padding: "" };
    task.padding = ".".repeat(CHAT_SOURCE_LIMITS.textBytes - Buffer.byteLength(JSON.stringify(task)));
    const input = chatSource({ messageId: "invented-task-bound", messageType: "Task", text: JSON.stringify(task) });
    assert.equal(Buffer.byteLength(input.record.text), CHAT_SOURCE_LIMITS.textBytes);
    assert.equal(decodeNativeChatObservation(input).sourceObservations[0].kind, "task");
    task.padding += ".";
    input.record.text = JSON.stringify(task);
    assert.ok(decodeNativeChatObservation(input).limitations.some(row => row.code === "encoded-byte-bound"));
    const nested = chatSource({ messageId: "invented-depth", messageType: "Progress" });
    let atLimit = 0;
    for (let index = 0; index < CHAT_SOURCE_LIMITS.depth - 2; index++) atLimit = [atLimit];
    nested.record.ignored = atLimit;
    assert.equal(decodeNativeChatObservation(nested).envelopes.length, 1);
    nested.record.ignored = [atLimit];
    assert.throws(() => decodeNativeChatObservation(nested), error => error.code === "source-structure-bound");
    const list = Array.from({ length: CHAT_SOURCE_LIMITS.entries }, (_, index) => ({
        type: "task_step", taskId: `invented-task-${index}`, conversationId: "invented-chat-conversation", id: `invented-step-${index}`,
    }));
    const many = chatSource({ messageId: "invented-array", messageType: "Task", text: JSON.stringify(list) });
    assert.equal(decodeNativeChatObservation(many).sourceObservations.length, CHAT_SOURCE_LIMITS.entries);
    list.push(list[0]); many.record.text = JSON.stringify(list);
    assert.ok(decodeNativeChatObservation(many).limitations.some(row => row.code === "task-array-bound-or-empty"));
    let deepArgument = {};
    for (let index = 0; index < CHAT_SOURCE_LIMITS.depth + 1; index++) deepArgument = { child: deepArgument };
    const encoded = nativeCallsSource();
    encoded.record.invocation = JSON.stringify([{ id: "invented-deep", type: "function",
        function: { name: "invented_lookup", arguments: JSON.stringify(deepArgument) } }]);
    const refused = decodeNativeChatObservation(encoded);
    assert.equal(invocationFacts(refused)[0].fields.input.availability, "unsupported");
    assert.ok(!Object.hasOwn(refused.envelopes[0].record, "invocation"));
});

test("JSON preflight never executes getters, serializers or proxies and never admits forged authority", () => {
    let executed = 0;
    const accessor = chatSource({ messageId: "invented-getter" });
    Object.defineProperty(accessor.record, "hidden", { enumerable: true, get() { executed++; return "unsafe"; } });
    assert.throws(() => decodeNativeChatObservation(accessor), error => error.code === "non-json-accessor");
    const serializer = chatSource({ messageId: "invented-serializer", toJSON() { executed++; return {}; } });
    assert.throws(() => decodeNativeChatObservation(serializer), error => error.code === "non-json-value");
    const proxy = new Proxy({}, { getPrototypeOf() { executed++; return Object.prototype; } });
    assert.throws(() => decodeNativeChatObservation(chatSource(proxy)), error => error.code === "non-json-value");
    assert.equal(executed, 0);
    const cyclic = chatSource({ messageId: "invented-cycle" });
    cyclic.record.loop = cyclic;
    assert.throws(() => decodeNativeChatObservation(cyclic), error => error.code === "non-json-cycle");
    const sparse = chatSource({ messageId: "invented-sparse", unknown: new Array(2) });
    assert.throws(() => decodeNativeChatObservation(sparse), error => error.code === "non-json-sparse-array");
    const nonFinite = chatSource({ messageId: "invented-number", unknown: Infinity });
    assert.throws(() => decodeNativeChatObservation(nonFinite), error => error.code === "non-json-value");
    const forged = chatSource({ messageId: "invented-forged" });
    forged.admission = { admitted: true, blockers: [] };
    assert.throws(() => decodeNativeChatObservation(forged), error => error.code === "unsupported-context-field");
    assert.equal(nativeWriterAdmission().blockers.length, 3);
});

test("clarification source precedence and additional invocation coordinates are explicit", () => {
    const valid = [{ question: "Invented", options: [
        { role: "action", label: "Continue", submitResponse: "invented-action" },
        { role: "abort", label: "Cancel", submitResponse: "invented-abort" },
    ] }];
    const input = chatSource({ messageId: "invented-precedence", messageType: "TriggerExtension",
        actionId: "clarification_request_browser_take_control", request: { actionInputParameters: { questions: [] } },
        invocation: [{ callId: "invented-first", function: { name: "request_browser_take_control", arguments: { questions: valid } } },
            { callId: "invented-second", function: { name: "request_browser_take_control", arguments: { questions: valid } } }] });
    const browser = decodeNativeChatObservation(input).sourceObservations[0];
    assert.equal(browser.fields.questions.availability, "unsupported");
    assert.deepEqual(browser.invocations.map(row => row.fields.callId.value), ["invented-first", "invented-second"]);
    assert.equal(browser.invocations[1].historicalProjection, "outside-first-element-projection");
    input.record.actionId = "clarification_ask_user_question";
    input.record.invocation[0].function.name = "clarification_ask_user_question";
    const ask = decodeNativeChatObservation(input).sourceObservations[0];
    assert.deepEqual(ask.fields.questions.value, valid);
    const before = structuredClone(input);
    const output = decodeNativeChatObservation(input);
    output.sourceObservations[0].fields.questions.value[0].question = "Consumer changed copy";
    assert.deepEqual(input, before);
});
