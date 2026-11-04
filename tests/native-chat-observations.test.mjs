import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import * as native from "../lib/native-read-model.mjs";
import { chatSource, nativeCallsSource } from "./native-chat-source-fixtures.mjs";

function taskSource() {
    return chatSource({ messageId: "invented-task-observation", storageMessageId: "invented-task-storage",
        messageType: "Task", text: JSON.stringify([
            { type: "task", taskId: "invented-task", conversationId: "invented-chat-conversation",
                status: "Completed", name: "Invented task", result: "RAW_RESULT_EXCLUDED",
                steps: [{ id: "invented-step", status: "Running", description: "RAW_DESCRIPTION_EXCLUDED" }] },
            { type: "task_reasoning", taskId: "invented-task", conversationId: "invented-chat-conversation",
                reasoningEventType: 17, annotation: { type: "tool", operation: "RAW_ANNOTATION_EXCLUDED" } },
        ]) }, 4);
}

test("decoded Chat task source facts cross the actual native envelope seam without becoming calls or outcomes", () => {
    assert.equal(typeof native.retainNativeChatSourceObservations, "function");
    const input = taskSource(), decoded = decodeNativeChatObservation(input), original = structuredClone(decoded);
    const envelopes = native.retainNativeChatSourceObservations(decoded);
    const model = native.projectNativeReadModel(envelopes), conversation = model.conversations[0];
    assert.deepEqual(decoded, original);
    assert.equal(conversation.sourceObservations.length, 1);
    const group = conversation.sourceObservations[0];
    assert.equal(group.observationKey, conversation.observations[0].observationKey);
    assert.equal(group.sourceKey, conversation.observations[0].sourceKey);
    assert.deepEqual(group.parserProvenance, decoded.parserProvenance);
    assert.deepEqual(group.facts.map(row => row.kind), ["task", "task_reasoning"]);
    assert.deepEqual(group.facts.map(row => row.source.decodedPointer), ["/0", "/1"]);
    assert.equal(group.facts[0].fields.statusLiteral.value, "Completed");
    assert.equal(group.facts[0].fields.status.availability, "unqualified");
    assert.equal(group.facts[1].fields.reasoningId.availability, "absent-in-response");
    assert.equal(group.facts[1].fields.annotationType.value, "tool");
    assert.equal(group.facts[1].fields.annotation.availability, "unqualified");
    assert.notEqual(group.facts[0].key, group.facts[1].key);
    assert.deepEqual(conversation.calls, []);
    assert.deepEqual(conversation.taskOutcomes, []);
    assert.deepEqual(conversation.returnedResults, []);
    assert.doesNotMatch(JSON.stringify(model), /RAW_RESULT|RAW_DESCRIPTION|RAW_ANNOTATION/);
    assert.equal(model.admission.admitted, false);
    assert.equal(model.admission.blockers.length, 3);
});

test("invocation source facts remain provenance for existing calls, not additional executions", () => {
    assert.equal(typeof native.retainNativeChatSourceObservations, "function");
    const decoded = decodeNativeChatObservation(nativeCallsSource());
    const conversation = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decoded)).conversations[0];
    assert.equal(conversation.calls.length, 2);
    assert.equal(conversation.sourceObservations[0].facts.length, 2);
    assert.equal(conversation.sourceObservations[0].facts[1].fields.input.availability, "recorded-empty");
    assert.equal(conversation.calls[0].outcome.state, "unknown");
    assert.ok(conversation.calls.every(call => call.observations.every(row => !Object.hasOwn(row, "chatSource"))));
});

test("clarification and confirmation preserve prospective original facts, never UI task IDs, approvals or executions", () => {
    const questions = [{ question: "Invented choice", options: [
        { role: "action", label: "Continue", submitResponse: "continue" },
        { role: "abort", label: "Stop", submitResponse: "stop" },
    ] }];
    for (const actionId of ["clarification_ask_user_question", "clarification_request_browser_take_control"]) {
        const input = chatSource({ messageId: "invented-clarification", messageType: "TriggerExtension",
            actionId, sourceRequestId: "source-request-not-task-id",
            request: { actionInputParameters: { questions } },
            invocation: [{ callId: "call-correlation-not-native-id", widgetId: "invented-widget",
                function: { name: actionId, arguments: JSON.stringify({ questions: ["Unused fallback"] }) } }] });
        const conversation = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decodeNativeChatObservation(input))).conversations[0];
        const row = conversation.sourceObservations[0].facts[0];
        assert.equal(row.kind, "clarification");
        assert.deepEqual(row.fields.questions.value, questions);
        assert.equal(row.fields.questions.source.pointer, "/frames/2/messages/0/request/actionInputParameters/questions");
        assert.equal(Object.hasOwn(row.fields.questions.source, "decodedPointer"), false);
        assert.equal(row.fields.sourceRequestId.value, "source-request-not-task-id");
        assert.equal(row.fields.responseRequestId.value, "invented-envelope-request");
        assert.equal(row.invocations[0].fields.callId.value, "call-correlation-not-native-id");
        assert.equal(row.invocations[0].fields.nativeCallId.availability, "absent-in-response");
        assert.equal(Object.hasOwn(row.fields, "taskId"), false);
        assert.equal(row.decoderReadModel.availability, "unsupported");
        assert.deepEqual(conversation.calls, []);
    }
    const confirmation = chatSource({ messageId: "invented-confirmation", messageType: "ConfirmationCard",
        widgetData: { toolName: "CLIENT_INFERRED_ACTION" }, isConsequential: true,
        adaptiveCards: [{ actions: [
            { type: "Action.Submit", data: { message: { sourceId: "invented-submit-source" } } },
            { type: "Action.Submit", data: { message: { actionId: "invented-original-action" } } },
        ] }] });
    const model = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decodeNativeChatObservation(confirmation)));
    const fact = model.conversations[0].sourceObservations[0].facts[0];
    assert.equal(fact.fields.actionId.availability, "absent-in-response");
    assert.equal(fact.fields.isConsequential.value, true);
    assert.equal(fact.submitActions[0].fields.actionId.availability, "absent-in-response");
    assert.equal(fact.submitActions[1].source.pointer, "/frames/2/messages/0/adaptiveCards/0/actions/1");
    assert.doesNotMatch(JSON.stringify(model), /CLIENT_INFERRED_ACTION|"approval"|"succeeded"/);
});

test("supported trigger fallback and unsupported task/invocation shapes keep their distinct coordinates and availability", () => {
    const input = chatSource({ messageId: "invented-fallback", messageType: "TriggerExtension",
        actionId: "clarification_ask_user_question",
        invocation: JSON.stringify([{ function: { name: "clarification_ask_user_question", arguments: JSON.stringify({ questions: ["Original fallback"] }) } }]) });
    const group = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decodeNativeChatObservation(input)))
        .conversations[0].sourceObservations[0];
    assert.equal(group.facts[0].fields.questions.source.pointer, "/frames/2/messages/0/invocation");
    assert.equal(group.facts[0].fields.questions.source.decodedPointer, "/0/function/arguments/questions");
    for (const record of [
        { messageId: "invented-unsupported", messageType: "Task", text: "[]" },
        { messageId: "invented-unsupported", messageType: "Task", text: JSON.stringify({ type: "future-task" }) },
        { messageId: "invented-unsupported", messageType: "Task", text: JSON.stringify({
            type: "task_steps", steps: [null, { id: "invented-child" }], reasoningItems: null,
        }) },
        { messageId: "invented-unsupported", messageType: "TriggerPlugin", actionId: "RAW_UNQUALIFIED_OPERATION", invocation: {} },
        { messageId: "invented-unsupported", messageType: "TriggerExtension", actionId: "RAW_UNQUALIFIED_OPERATION" },
        { messageId: "invented-unsupported", messageType: "Progress", invocation: JSON.stringify([{ type: "function",
            callId: "not-native-call-id", function: { name: "invented-tool", arguments: {} } }]) },
        { messageId: "invented-unsupported", messageType: "Progress", invocation: JSON.stringify(["not valid serialized JSON"]) },
    ]) {
        const decoded = decodeNativeChatObservation(chatSource(record));
        const conversation = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decoded)).conversations[0];
        assert.deepEqual(conversation.calls, []);
        assert.ok(conversation.sourceObservations[0].facts.length);
        assert.doesNotMatch(JSON.stringify(conversation), /RAW_UNQUALIFIED_OPERATION/);
    }
    const empty = chatSource({ messageId: "invented-empty", messageType: "Task", text: JSON.stringify({
        type: "task_steps", name: "", status: null, steps: [], reasoningItems: [],
    }) });
    const fact = native.projectNativeReadModel(native.retainNativeChatSourceObservations(decodeNativeChatObservation(empty)))
        .conversations[0].sourceObservations[0].facts[0];
    assert.deepEqual(fact.fields.steps, []);
    assert.deepEqual(fact.fields.reasoningItems, []);
    assert.equal(fact.fields.name.availability, "recorded-empty");
    assert.equal(fact.fields.statusLiteral.availability, "explicit-null");
    assert.equal(fact.fields.status.availability, "unqualified");
    assert.equal(fact.fields.createdTimestamp.availability, "absent-in-response");
});

test("source-qualified keys retain captures, native scopes, array variants and exact replay without merging task IDs", () => {
    const first = native.retainNativeChatSourceObservations(decodeNativeChatObservation(taskSource()))[0];
    const replay = native.projectNativeReadModel([first, structuredClone(first)]).conversations[0];
    assert.equal(replay.sourceObservations.length, 1);
    const next = structuredClone(first);
    next.capture.captureId = "invented-second-capture";
    const account = structuredClone(first);
    account.scope.account.subjectId = "invented-other-subject";
    const model = native.projectNativeReadModel([next, first, account]);
    assert.equal(model.conversations.length, 2);
    assert.equal(model.conversations[0].sourceObservations.length, 2);
    assert.equal(new Set(model.conversations.flatMap(conversation => conversation.sourceObservations.flatMap(group => group.facts.map(fact => fact.key)))).size, 6);
    const reordered = native.projectNativeReadModel([account, first, next]);
    assert.deepEqual(model.conversations.flatMap(c => c.sourceObservations.flatMap(g => g.facts.map(f => f.key))).sort(),
        reordered.conversations.flatMap(c => c.sourceObservations.flatMap(g => g.facts.map(f => f.key))).sort());
    const conflict = structuredClone(first);
    conflict.chatSource.observations[0].fields.name.value = "Changed same observation";
    assert.throws(() => native.projectNativeReadModel([first, conflict]), { code: "conflicting-observation-identity" });
});

test("closed source-fact validation rejects authority, generated/default fields, semantic promotion and crossed coordinates", () => {
    const initial = native.retainNativeChatSourceObservations(decodeNativeChatObservation(taskSource()))[0];
    const changes = [
        value => { value.chatSource.parserProvenance.applicability = "current-qualified"; },
        value => { value.chatSource.observations[0].kind = "task_completed"; },
        value => { value.chatSource.observations[0].fields.clientTaskId = value.chatSource.observations[0].fields.taskId; },
        value => { value.chatSource.observations[0].fields.status = { availability: "recorded", value: "succeeded",
            source: value.chatSource.observations[0].fields.status.source }; },
        value => { value.chatSource.observations[1].fields.annotationType.value = "enterprise-execution"; },
        value => { value.chatSource.observations[1].fields.annotation = { availability: "recorded", value: { type: "tool", success: true },
            source: value.chatSource.observations[1].fields.annotation.source }; },
        value => { value.chatSource.observations[0].fields.taskId.source.decodedPointer = "/1/taskId"; },
        value => { value.chatSource.observations[0].source.pointer = "/different/source"; },
        value => { value.chatSource.observations[0].historicalProjection = "outside-first-element-projection"; },
        value => { value.chatSource.observations.push(structuredClone(value.chatSource.observations[0])); },
        value => { value.chatSource.observations[0].fields.name.value = "Bearer " + "a".repeat(40); },
        value => { value.chatSource.observations[0].fields.name.availability = "unqualified"; },
        value => { value.chatSource.identity.responseRequestId = null; },
        value => { value.chatSource.observations[1].fields.annotationType = null; },
        value => { value.chatSource.limitations[0].source.pointer = null; },
    ];
    for (const change of changes) {
        const value = structuredClone(initial);
        change(value);
        assert.throws(() => native.projectNativeReadModel([value]), error => error instanceof native.NativeReadModelError
            && error.code.startsWith("chat-source-") && !error.message.includes("Bearer"));
    }
    const decoder = decodeNativeChatObservation(taskSource());
    decoder.provenance.scope.account.subjectId = "invented-wrong-account";
    assert.throws(() => native.retainNativeChatSourceObservations(decoder), { code: "chat-source-provenance-conflict" });
    const orphan = decodeNativeChatObservation(chatSource({ messageType: "Task", text: JSON.stringify({ type: "task" }) }));
    assert.throws(() => native.retainNativeChatSourceObservations(orphan), { code: "chat-source-carrier-required" });
    const calls = native.retainNativeChatSourceObservations(decodeNativeChatObservation(nativeCallsSource()));
    calls[0].chatSource.observations[0].fields.input.value = { query: "Another call input" };
    assert.throws(() => native.projectNativeReadModel(calls), { code: "input-source-conflict" });
    const duplicate = structuredClone(initial);
    const duplicateFact = structuredClone(duplicate.chatSource.observations[0]);
    duplicateFact.source = Object.fromEntries(Object.entries(duplicateFact.source).reverse());
    duplicate.chatSource.observations.push(duplicateFact);
    assert.throws(() => native.projectNativeReadModel([duplicate]), { code: "chat-source-duplicate-observation-coordinate" });
    let getterRan = false;
    Object.defineProperty(initial.chatSource, "hidden", { get() { getterRan = true; return "never"; }, enumerable: true });
    assert.throws(() => native.projectNativeReadModel([initial]), { code: "non-json-accessor" });
    assert.equal(getterRan, false);
    const clarification = native.retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource({
        messageId: "invented-null-field", messageType: "TriggerExtension", actionId: "clarification_ask_user_question",
        request: { actionInputParameters: { questions: ["Original question"] } },
    })))[0];
    for (const invalid of [null, {}, { availability: "recorded", value: [], source: null }]) {
        const value = structuredClone(clarification);
        value.chatSource.observations[0].fields.questions = invalid;
        assert.throws(() => native.projectNativeReadModel([value]), error =>
            error instanceof native.NativeReadModelError && error.code.startsWith("chat-source-"));
    }
});

test("unknown semantic enums remain unavailable while observation, field and expanded JSON bounds reject explicitly", () => {
    const source = chatSource({ messageId: "invented-future-literal", messageType: "Task",
        text: JSON.stringify({ type: "task_reasoning", status: "FutureState", reasoningEventType: 999,
            annotation: { type: "unknown-tool-schema", input: "NEVER_RETAIN_UNKNOWN_SCHEMA" } }) });
    const envelope = native.retainNativeChatSourceObservations(decodeNativeChatObservation(source))[0];
    const fact = native.projectNativeReadModel([envelope]).conversations[0].sourceObservations[0].facts[0];
    assert.equal(fact.fields.statusLiteral.value, "FutureState");
    assert.equal(fact.fields.status.availability, "unqualified");
    assert.equal(fact.fields.reasoningEventType.value, 999);
    assert.equal(fact.fields.annotationType.availability, "unqualified");
    assert.equal(fact.fields.annotation.availability, "unqualified");
    assert.doesNotMatch(JSON.stringify(fact), /NEVER_RETAIN|unknown-tool-schema/);
    const tooMany = structuredClone(envelope);
    tooMany.chatSource.observations = Array(201).fill(envelope.chatSource.observations[0]);
    assert.throws(() => native.projectNativeReadModel([tooMany]), { code: "chat-source-array-bound" });
    const oversized = structuredClone(envelope);
    oversized.chatSource.observations[0].fields.name = { availability: "recorded", value: "x".repeat(1024 * 1024),
        source: { ...oversized.chatSource.observations[0].source, decodedPointer: "/name" } };
    assert.throws(() => native.projectNativeReadModel([oversized]), { code: "chat-source-byte-bound" });
    const deep = structuredClone(envelope);
    let value = "end";
    for (let index = 0; index < 65; index++) value = { value };
    deep.chatSource.observations[0].fields.extra = value;
    assert.throws(() => native.projectNativeReadModel([deep]), { code: "json-structure-bound" });
});
