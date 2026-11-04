import test from "node:test";
import assert from "node:assert/strict";
import { NATIVE_READ_CONTRACT, NATIVE_READ_LIMITS, NativeReadModelError, nativeWriterAdmission, assertNativeWriterAdmission,
    projectNativeReadModel } from "../lib/native-read-model.mjs";
import { recorded, chatFixture, coworkFixture, imageFixture, multiCallChatFixture } from "./native-read-model-fixtures.mjs";

const reject = (rows, code) => assert.throws(() => projectNativeReadModel(rows),
    error => error instanceof NativeReadModelError && error.code === code);

test("one read seam retains no-tool conversations, separate plain/card text and immutable observations", () => {
    const rows = chatFixture(), before = structuredClone(rows);
    const result = projectNativeReadModel(rows);
    assert.equal(result.contractVersion, NATIVE_READ_CONTRACT);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].calls.length, 0);
    assert.equal(result.conversations[0].messages.length, 3);
    assert.equal(result.conversations[0].messages[1].sourceKey, result.conversations[0].messages[2].sourceKey);
    assert.notEqual(result.conversations[0].messages[1].observationKey, result.conversations[0].messages[2].observationKey);
    result.conversations[0].messages[1].value.text = "Changed consumer copy";
    assert.deepEqual(rows, before);
});

test("native calls, approval/agent keys, task outcomes and result references remain distinct", () => {
    const result = projectNativeReadModel(coworkFixture()).conversations[0];
    assert.equal(result.calls.length, 3);
    assert.equal(result.taskOutcomes[0].state, "completed");
    assert.equal(result.returnedResults[0].observed.length, 0);
    assert.equal(result.returnedResults[0].declaredRequestCount, 2);
    assert.equal(result.resultReferences[0].unit, "source-result-reference-entry");
    assert.equal(result.resultReferences[0].value.cardinality, 2);
    const approval = result.observations.find(row => row.identity.nativeType === "taa");
    assert.deepEqual(approval.identity.links.map(link => link.kind), ["approval"]);
    assert.equal(approval.fields.approval.value, true);
    const agent = result.observations.find(row => row.identity.nativeType === "sa");
    assert.deepEqual(agent.identity.links.map(link => [link.kind, link.field]), [["agent-announcement", "tid"]]);
    assert.equal(agent.identity.callIds.length, 0);
    assert.deepEqual(result.observations.find(row => row.identity.nativeType === "invented_future_event").identity.links, []);
    assert.doesNotMatch(JSON.stringify(result), /UNRELATED_RAW_PAYLOAD|RAW_ERROR_PROSE/);
    assert.ok(result.calls.some(call => call.observations.some(row => row.fields.toolName?.value === "mcp__graph__CallGraph")));
});

test("both Chat invocation encodings group native calls without treating generated message IDs as executions", () => {
    const rows = imageFixture();
    const regenerated = structuredClone(rows[1]);
    regenerated.record.messageId = "invented-regenerated-id";
    regenerated.record.contentIndex = 7;
    regenerated.capture.captureId = "invented-next-capture";
    const result = projectNativeReadModel([...rows, regenerated]).conversations[0];
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].nativeCallId, "invented-image-call");
    assert.equal(result.calls[0].observations.length, 4);
    assert.notEqual(result.observations[1].sourceKey, result.observations[3].sourceKey);
    assert.ok(result.calls[0].observations.every(row => row.outcomes.tool.state === "unknown"));
    const falseSuccess = structuredClone(rows);
    falseSuccess[2].outcomes.tool.state = "succeeded";
    reject(falseSuccess, "native-tool-outcome-not-established");
});

test("source identities partition accounts and surfaces but never act as runtime authorization", () => {
    const one = chatFixture()[0], otherTenant = structuredClone(one), unknown = structuredClone(one);
    otherTenant.scope.account.tenantId = "invented-other-tenant";
    unknown.scope.account.verification = "unqualified";
    unknown.capture.captureId = "invented-unqualified-observation";
    const result = projectNativeReadModel([one, otherTenant, unknown]);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.conversations[0].scope.account.verification, "conflicting");
    assert.deepEqual(result.conversations[0].sourceVerification, ["verified", "unqualified"]);
    assert.equal(result.admission.admitted, false);
    assert.match(result.definitions.authorization, /never a current authorization lease/);
    const forged = structuredClone(one);
    forged.capture.authorizationLease = { allowed: true };
    reject([forged], "unsupported-field");
    const missing = structuredClone(one); delete missing.scope.account;
    reject([missing], "missing-field");
});

test("capture generation is historical provenance and cannot clear any production blocker", () => {
    const row = chatFixture()[0]; row.capture.generation = 999999;
    assert.equal(projectNativeReadModel([row]).admission.admitted, false);
    const result = nativeWriterAdmission({ blockers: [], sourceComplete: true, synthetic: false });
    assert.deepEqual(result.blockers, [
        "cowork-missing-input-or-no-input-provenance", "cowork-original-nested-batch-outcomes", "chat-enterprise-execution-result-coverage",
    ]);
    result.blockers.length = 0;
    assert.equal(nativeWriterAdmission().blockers.length, 3);
    assert.throws(() => assertNativeWriterAdmission(), error => error.code === "native-writer-admission-withheld");
});

test("missing source input cannot become an empty object or a neighboring call's arguments", () => {
    const rows = coworkFixture();
    const missing = rows.find(row => row.record.id === "seq:12");
    missing.qualifiedFields.input = recorded({});
    reject(rows, "input-not-recorded-by-source");
    const changed = coworkFixture();
    changed[2].qualifiedFields.input.value = { invented: "different input" };
    reject(changed, "input-source-conflict");
    const noValue = coworkFixture();
    noValue[2].qualifiedFields.input = { availability: "recorded" };
    reject(noValue, "availability-value-conflict");
    const borrowed = coworkFixture();
    borrowed[5].qualifiedFields.input = recorded({ borrowed: true });
    borrowed[5].evidenceReferences.input = { sourceDocument: "invented-source", pointer: "/other/input" };
    reject(borrowed, "input-source-record-unqualified");
});

test("returned statuses can disagree with outer tool success without raw payloads or positional request attribution", () => {
    const rows = coworkFixture(), end = rows[5];
    end.outcomes.nestedApi.availability = "recorded";
    end.outcomes.nestedApi.observed = [{ index: 0, indexKind: "response-array-position", statusCode: 403,
        errorCode: "AccessDenied", paginationPresent: null, evidenceLevel: "intermediary-reported" }];
    const result = projectNativeReadModel(rows).conversations[0];
    assert.equal(result.returnedResults[0].observed[0].statusCode, 403);
    assert.equal(result.calls[0].observations[1].outcomes.tool.state, "succeeded");
    assert.equal(result.returnedResults[0].declaredRequestCountIsSuccessDenominator, false);
    end.outcomes.nestedApi.declaredRequestCountIsSuccessDenominator = true;
    reject(rows, "nested-unit-or-denominator-conflict");
});

test("approval, native names and unlike result units cannot be promoted by supplied facts", () => {
    const rows = coworkFixture();
    rows[4].outcomes.tool = { unit: "native-tool", state: "succeeded", basis: "taa.approved" };
    rows[4].evidenceReferences.toolOutcome = { sourceDocument: "invented-source", pointer: "/data/approved" };
    reject(rows, "native-tool-outcome-not-established");
    const renamed = coworkFixture();
    renamed[2].qualifiedFields.toolName.value = "workiq-fetch";
    reject(renamed, "native-tool-name-conflict");
    const referenceStatus = coworkFixture();
    referenceStatus[6].qualifiedFields.resultReferences.value.statusCode = 200;
    reject(referenceStatus, "unsupported-field");
});

test("order and variant observations are preserved; exact replay deduplicates without resetting earlier text", () => {
    const rows = chatFixture();
    rows[0].ordering.sequence = 30;
    rows[1].ordering.sequence = 10;
    const newer = structuredClone(rows[1]); newer.capture.captureId = "invented-next";
    newer.qualifiedFields.message.value.text = "A later recorded variant.";
    const result = projectNativeReadModel([...rows, rows[0], newer]).conversations[0];
    assert.equal(result.observations.length, 4);
    assert.deepEqual(result.observations.slice(0, 2).map(row => row.ordering.sequence), [30, 10]);
    assert.equal(result.messages[1].value.text, "First invented reply.");
    assert.equal(result.messages[3].value.text, "A later recorded variant.");
    const conflict = structuredClone(rows[0]); conflict.qualifiedFields.message.value.text = "Same capture conflict";
    reject([rows[0], conflict], "conflicting-observation-identity");
    assert.equal(projectNativeReadModel([...rows].reverse()).conversations[0].messages[0].observationKey,
        projectNativeReadModel(rows).conversations[0].messages[2].observationKey);
});

test("duration, sequence gaps and model qualifications never become broader measurement claims", () => {
    const rows = coworkFixture();
    const result = projectNativeReadModel(rows).conversations[0];
    assert.equal(result.measurements[0].boundary, "provider-tool-duration");
    assert.equal(result.measurements[0].comparableToUserResponseLatency, false);
    assert.equal(result.coverage[0].inferredLostEvents, null);
    rows[5].qualifiedFields.callElapsed.comparableToUserResponseLatency = true;
    reject(rows, "unqualified-timing-comparison");
    const falseLoss = coworkFixture(); falseLoss[2].coverage[0].inferredLostEvents = 1;
    reject(falseLoss, "sequence-loss-not-established");
});

test("malformed/sensitive facts fail explicitly and private checkpoints never enter the read model", () => {
    const row = chatFixture()[0];
    row.qualifiedFields.message.value.text = "Bearer " + "a".repeat(40);
    reject([row], "credential-bearing-fact");
    const checkpoint = chatFixture()[0];
    checkpoint.checkpoint = { status: "pending", operation: "history-read", selector: { sessionId: "invented" },
        direction: "older", privateContinuationRef: "PRIVATE_HANDLE", generation: 7, committedCursor: null };
    assert.doesNotMatch(JSON.stringify(projectNativeReadModel([checkpoint])), /PRIVATE_HANDLE/);
    checkpoint.checkpoint.committedCursor = "PRIVATE_CURSOR";
    reject([checkpoint], "cursor-not-reader-data");
    const invalid = chatFixture()[0]; invalid.capture.generation = Number.NaN;
    reject([invalid], "non-json-value");
    const missingRef = chatFixture()[0]; delete missingRef.evidenceReferences.message;
    reject([missingRef], "expected-object");
    reject(Array.from({ length: 10001 }, () => ({})), "invalid-record-batch");
    const malformed = imageFixture(); malformed[0].record.invocation = "[";
    reject(malformed, "malformed-invocation");
});

test("native metadata cannot smuggle unqualified authority, arbitrary signals or mutable identifier objects", () => {
    const badRequest = chatFixture()[0]; badRequest.record.requestId = { private: "payload" };
    reject([badRequest], "invalid-text");
    const badCoverage = coworkFixture(); badCoverage[2].coverage[0].subject = { private: "payload" };
    reject(badCoverage, "invalid-text");
    const badFailure = coworkFixture(); badFailure[10].qualifiedFields.failure.value.messageSignal = "invented-success-cause";
    reject(badFailure, "unsupported-value");
    const excludedSignal = coworkFixture();
    excludedSignal[10].qualifiedFields.failure.value = { code: null, messageStatus: "sensitive-excluded", messageSignal: "access-denial" };
    reject(excludedSignal, "failure-signal-exclusion-conflict");
    const badState = coworkFixture(); badState[0].outcomes.task.state = "failed";
    reject(badState, "native-task-state-conflict");
    const badRef = coworkFixture(); badRef[6].qualifiedFields.resultReferences.comparableToUserResponseLatency = true;
    reject(badRef, "field-qualification-conflict");
    const filtered = coworkFixture();
    filtered[6].record.data.wr = [{ u: "https://invented.invalid/reference" }];
    filtered[6].qualifiedFields.resultReferences.value = { nativeField: "wr", cardinality: 0, itemFieldTypes: {} };
    reject(filtered, "reference-source-cardinality-conflict");
    const wrongApproval = coworkFixture();
    wrongApproval[4].qualifiedFields.approval.value = false;
    reject(wrongApproval, "approval-not-established");
    const wrongAuthor = chatFixture();
    wrongAuthor[0].qualifiedFields.message.value.author = "assistant";
    reject(wrongAuthor, "native-message-author-conflict");
});

test("validation is bounded JSON-only data processing, not execution of getters or serializers", () => {
    let invoked = false;
    const row = chatFixture()[0];
    Object.defineProperty(row, "unexpected", { enumerable: true, get() { invoked = true; return "not read"; } });
    reject([row], "non-json-accessor");
    assert.equal(invoked, false);
    const serializer = chatFixture()[0];
    serializer.toJSON = () => { invoked = true; return {}; };
    reject([serializer], "non-json-value");
    assert.equal(invoked, false);
    let deep = {};
    for (let i = 0; i < 65; i++) deep = { child: deep };
    reject([deep], "json-structure-bound");
    const cyclic = {}; cyclic.self = cyclic;
    reject([cyclic], "non-json-input");
});

test("conflicting recorded completions stay unknown without deleting either native observation", () => {
    const rows = coworkFixture(), later = structuredClone(rows[5]);
    later.capture.captureId = "invented-conflicting-observation";
    later.record.data.ok = false;
    later.outcomes.tool.state = "failed";
    const call = projectNativeReadModel([...rows, later]).conversations[0].calls[0];
    assert.equal(call.observations.length, 3);
    assert.equal(call.outcome.state, "unknown");
    assert.equal(call.outcome.qualification, "conflicting-native-outcomes");
    assert.deepEqual(call.conflicts, ["native-tool-outcome-conflict"]);
});

test("recorded-fact byte boundary is inclusive and total batch bytes are bounded before projection", () => {
    const row = coworkFixture()[2];
    const exact = ".".repeat(NATIVE_READ_LIMITS.textBytes - 2);
    row.record.data.inp = exact;
    row.qualifiedFields.input = recorded(exact);
    assert.equal(projectNativeReadModel([row]).conversations[0].calls.length, 1);
    row.record.data.inp += ".";
    row.qualifiedFields.input.value += ".";
    reject([row], "fact-byte-bound");
    const tooLarge = chatFixture()[0];
    tooLarge.record.unprojectedPayload = ".".repeat(NATIVE_READ_LIMITS.bytes);
    reject([tooLarge], "record-byte-bound");
});

test("aliased oversized batch is rejected before whole-batch serialization is attempted", () => {
    const row = chatFixture()[0];
    row.record.unprojectedPayload = ".".repeat(64 * 1024);
    const rows = Array(10000).fill(row);
    const stringify = JSON.stringify;
    let attemptedWholeBatch = false, failure;
    try {
        JSON.stringify = function (value, ...args) {
            if (value === rows) {
                attemptedWholeBatch = true;
                throw new Error("GUARDED_ROOT_SERIALIZATION_WOULD_EXCEED_BOUND");
            }
            return Reflect.apply(stringify, this, [value, ...args]);
        };
        try { projectNativeReadModel(rows); } catch (error) { failure = error; }
    } finally { JSON.stringify = stringify; }
    assert.ok(failure instanceof NativeReadModelError);
    assert.equal(failure.code, "record-byte-bound");
    assert.equal(attemptedWholeBatch, false);
});

test("a multi-call Chat invocation preserves each literal native name without shared qualified facts", () => {
    const row = imageFixture()[0];
    const first = JSON.parse(JSON.parse(row.record.invocation)[0]);
    const second = { ...first, id: "invented-second-call",
        function: { name: "invented_native_lookup", arguments: { query: "Second invented input" } } };
    row.record.invocation = JSON.stringify([JSON.stringify(first), second]);
    row.qualifiedFields = {};
    row.evidenceReferences = {};
    row.outcomes = {};
    const result = projectNativeReadModel([row]).conversations[0];
    assert.deepEqual(result.calls.map(call => [call.nativeCallId, call.nativeToolNames]), [
        [first.id, ["image_gen"]], [second.id, ["invented_native_lookup"]],
    ]);
    assert.equal(result.observations.length, 1);
    assert.ok(result.calls.every(call => call.observations[0].fields.input === undefined));
});

test("explicit nativeCallId associations preserve individual multi-call facts at the original source coordinates", () => {
    const row = multiCallChatFixture(), original = structuredClone(row);
    const result = projectNativeReadModel([row, row]).conversations[0];
    assert.equal(result.observations.length, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(result.observations[0].callFacts.length, 2);
    assert.equal(result.calls.length, 2);
    for (const [index, call] of result.calls.entries()) {
        const observation = call.observations[0];
        assert.equal(observation.nativeCallId, row.callFacts[index].nativeCallId);
        assert.deepEqual(observation.ordering, row.ordering);
        assert.equal(observation.identity.observationId, row.record.messageId);
        assert.equal(observation.sourceKey, result.observations[0].sourceKey);
        assert.equal(observation.observationKey, result.observations[0].observationKey);
        assert.deepEqual(observation.identity.callIds, [row.callFacts[index].nativeCallId]);
        assert.equal(observation.identity.nativeCalls.length, 1);
        assert.deepEqual(observation.fields.input.value, row.callFacts[index].qualifiedFields.input.value);
        assert.equal(observation.fields.message, undefined, "Do not duplicate conversation-level messages as per-call facts");
        assert.equal(observation.callFacts, undefined, "Do not leak another call's associated facts into this call view");
        assert.equal(call.outcome.state, "unknown");
    }
    assert.deepEqual(row, original, "The source message and invocation strings are never rewritten to split calls");
    assert.equal(result.calls[0].observations[0].fields.input.value.query, undefined);
    assert.equal(result.calls[1].observations[0].fields.input.value.prompt, undefined);
});

test("multi-call facts reject unknown/duplicate associations, borrowed input, relabeling and unqualified call outcomes", () => {
    const unknown = multiCallChatFixture();
    unknown.callFacts[0].nativeCallId = "invented-unknown-call";
    reject([unknown], "call-facts-identity-not-in-source");
    const duplicate = multiCallChatFixture();
    duplicate.callFacts.push(structuredClone(duplicate.callFacts[0]));
    reject([duplicate], "duplicate-call-facts");
    const borrowed = multiCallChatFixture();
    borrowed.callFacts[0].qualifiedFields.input.value = borrowed.callFacts[1].qualifiedFields.input.value;
    reject([borrowed], "input-source-conflict");
    const renamed = multiCallChatFixture();
    renamed.callFacts[0].qualifiedFields.toolName.value = "workiq-fetch";
    reject([renamed], "native-tool-name-conflict");
    const unsupported = multiCallChatFixture();
    unsupported.callFacts[0].outcomes = { tool: { unit: "native-tool", state: "succeeded", basis: "invented" } };
    reject([unsupported], "unsupported-field");
    const timing = multiCallChatFixture();
    timing.callFacts[0].qualifiedFields.callElapsed = recorded(1);
    reject([timing], "unsupported-value");
    const unscoped = multiCallChatFixture();
    unscoped.qualifiedFields.input = recorded({ prompt: "First invented input." });
    unscoped.evidenceReferences.input = unscoped.callFacts[0].evidenceReferences.input;
    reject([unscoped], "ambiguous-call-facts");
    const ambiguousSource = multiCallChatFixture();
    const calls = JSON.parse(ambiguousSource.record.invocation);
    const first = JSON.parse(calls[0]);
    calls[1].id = first.id;
    ambiguousSource.record.invocation = JSON.stringify(calls);
    reject([ambiguousSource], "ambiguous-native-call-id");
    const single = imageFixture()[0];
    single.callFacts = [{
        nativeCallId: "invented-image-call", qualifiedFields: { input: single.qualifiedFields.input },
        evidenceReferences: { input: single.evidenceReferences.input },
    }];
    reject([single], "duplicate-call-fact-location");
    const noReference = multiCallChatFixture(); delete noReference.callFacts[0].evidenceReferences.input;
    reject([noReference], "expected-object");
});

test("partial multi-call fact coverage never invents input for an unqualified sibling", () => {
    const row = multiCallChatFixture();
    row.callFacts = row.callFacts.slice(1);
    const result = projectNativeReadModel([row]).conversations[0];
    assert.deepEqual(result.calls.map(call => call.nativeToolNames), [["image_gen"], ["invented_native_lookup"]]);
    assert.equal(result.calls[0].observations[0].fields.input, undefined);
    assert.equal(result.calls[1].observations[0].fields.input.value.query, "Second invented input.");
    assert.equal(result.calls[0].outcome.state, "unknown");
});

test("explicit per-call exclusions remain unavailable without leaking the sibling input or withheld name", () => {
    const row = multiCallChatFixture();
    row.callFacts[0].qualifiedFields.input = { availability: "excluded-by-policy", reason: "input-excluded-by-source-policy" };
    row.callFacts[0].qualifiedFields.toolName = { availability: "excluded-by-policy", reason: "name-withheld" };
    const result = projectNativeReadModel([row]).conversations[0];
    const first = result.calls[0];
    assert.deepEqual(first.nativeToolNames, []);
    assert.equal(first.observations[0].fields.input.availability, "excluded-by-policy");
    assert.equal(first.observations[0].fields.input.value, undefined);
    assert.doesNotMatch(JSON.stringify(result), /image_gen|First invented input/);
    assert.equal(result.calls[1].observations[0].fields.input.value.query, "Second invented input.");
});

function guardedBatchSerialization(rows) {
    const stringify = JSON.stringify;
    let attempted = false, failure;
    try {
        JSON.stringify = function (value, ...args) {
            if (value === rows) { attempted = true; throw new Error("GUARDED_BATCH_SERIALIZATION"); }
            return Reflect.apply(stringify, this, [value, ...args]);
        };
        try { projectNativeReadModel(rows); } catch (error) { failure = error; }
    } finally { JSON.stringify = stringify; }
    return { attempted, failure };
}

test("preflight counts exact escaped UTF-8 bytes at the batch limit including aliased structures", () => {
    const row = chatFixture()[0];
    row.record.raw = ('"\\\b\f\n\r\t\u0000\u001f\u007f\u0080\u07ff\u0800\u2028\ud83d\ude80\ud800X\udc00').repeat(100);
    row.record['escaped-key-"\\\u0000\ud800\u0800'] = [-0, 1e-7, 1e21, 0.125, true, false, null];
    Object.defineProperty(row.record, "omittedFromJson", { value: "checked-but-nonenumerable", enumerable: false });
    const paddingRow = chatFixture()[1];
    paddingRow.record.padding = "";
    const aliases = 1500;
    const baseBytes = Buffer.byteLength(JSON.stringify(row)) * aliases
        + Buffer.byteLength(JSON.stringify(paddingRow)) + aliases + 2;
    assert.ok(baseBytes < NATIVE_READ_LIMITS.bytes);
    paddingRow.record.padding = ".".repeat(NATIVE_READ_LIMITS.bytes - baseBytes);
    const rows = [...Array(aliases).fill(row), paddingRow];
    const exact = guardedBatchSerialization(rows);
    assert.equal(exact.attempted, true, "Exact limit is admitted to serialization, which the test safely intercepts");
    assert.equal(exact.failure.code, "non-json-input");
    paddingRow.record.padding += ".";
    const over = guardedBatchSerialization(rows);
    assert.equal(over.attempted, false);
    assert.equal(over.failure.code, "record-byte-bound");
});

test("nested alias expansion, cycles and deep cached subtrees reject before serialization", () => {
    const row = chatFixture()[0];
    let shared = { value: ".".repeat(4096) };
    for (let index = 0; index < 14; index++) shared = { first: shared, second: shared };
    row.record.raw = shared;
    const expanded = guardedBatchSerialization([row]);
    assert.equal(expanded.attempted, false);
    assert.equal(expanded.failure.code, "record-byte-bound");
    const cycle = chatFixture()[0]; cycle.record.self = cycle;
    const cyclic = guardedBatchSerialization([cycle]);
    assert.equal(cyclic.attempted, false);
    assert.equal(cyclic.failure.code, "non-json-input");
    const deep = chatFixture()[0];
    let subtree = { leaf: true };
    for (let index = 0; index < 20; index++) subtree = { child: subtree };
    deep.record.firstShallowAlias = subtree;
    let wrapper = subtree;
    for (let index = 0; index < 45; index++) wrapper = { child: wrapper };
    deep.record.laterDeepAlias = wrapper;
    const depth = guardedBatchSerialization([deep]);
    assert.equal(depth.attempted, false);
    assert.equal(depth.failure.code, "json-structure-bound");
    const nodeLimited = chatFixture()[0];
    let many = [0];
    for (let index = 0; index < 20; index++) many = [many, many];
    nodeLimited.record.raw = many;
    const nodes = guardedBatchSerialization([nodeLimited]);
    assert.equal(nodes.attempted, false);
    assert.equal(nodes.failure.code, "json-structure-bound");
});

test("small aliases retain normal exact-replay behavior without getter or serializer invocation", () => {
    const row = chatFixture()[0];
    assert.equal(projectNativeReadModel([row, row]).conversations[0].observations.length, 1);
    let invoked = false;
    const accessor = chatFixture()[0];
    Object.defineProperty(accessor.record, "unprojected", { get() { invoked = true; return "not allowed"; } });
    const getters = guardedBatchSerialization([accessor, accessor]);
    assert.equal(getters.attempted, false);
    assert.equal(getters.failure.code, "non-json-accessor");
    const serializer = chatFixture()[0]; serializer.record.toJSON = () => { invoked = true; return {}; };
    const serializers = guardedBatchSerialization([serializer, serializer]);
    assert.equal(serializers.attempted, false);
    assert.equal(serializers.failure.code, "non-json-value");
    assert.equal(invoked, false);
});

test("deep decoded Chat argument JSON rejects explicitly in both invocation encodings and fact locations", () => {
    const encodedArguments = "[".repeat(10000) + "0" + "]".repeat(10000);
    assert.equal(Buffer.byteLength(encodedArguments), 20001);
    for (const nestedInvocation of [false, true]) for (const individual of [false, true]) {
        const row = imageFixture()[0];
        const call = JSON.parse(JSON.parse(row.record.invocation)[0]);
        call.function.arguments = encodedArguments;
        row.record.invocation = JSON.stringify([nestedInvocation ? JSON.stringify(call) : call]);
        row.qualifiedFields.input = recorded({});
        if (individual) {
            row.callFacts = [{
                nativeCallId: call.id, qualifiedFields: { input: row.qualifiedFields.input },
                evidenceReferences: { input: row.evidenceReferences.input },
            }];
            delete row.qualifiedFields.input;
            delete row.evidenceReferences.input;
        }
        reject([row], "json-structure-bound");
    }
});

test("decoded invocation objects are bounded before inspection even when no qualified call fact is supplied", () => {
    const deepArguments = "[".repeat(10000) + "0" + "]".repeat(10000);
    const callJson = '{"id":"invented-image-call","type":"function","function":{"name":"image_gen","arguments":'
        + deepArguments + "}}";
    for (const nestedInvocation of [false, true]) {
        const row = imageFixture()[0];
        row.record.invocation = nestedInvocation ? JSON.stringify([callJson]) : `[${callJson}]`;
        row.qualifiedFields = {};
        row.evidenceReferences = {};
        row.outcomes = {};
        assert.throws(() => projectNativeReadModel([row]), error => error instanceof NativeReadModelError
            && error.code === "json-structure-bound"
            && error.path === `$[0].record.invocation.${nestedInvocation ? "calls" : "decoded"}`);
    }
});

test("individual facts on a real multi-call carrier and Cowork serialized inputs use the same decoded bounds", () => {
    const deepArguments = "[".repeat(10000) + "0" + "]".repeat(10000);
    for (const selected of [0, 1]) for (const nestedInvocation of [false, true]) {
        const row = multiCallChatFixture();
        const calls = JSON.parse(row.record.invocation).map(call => typeof call === "string" ? JSON.parse(call) : call);
        calls[selected].function.arguments = deepArguments;
        row.record.invocation = JSON.stringify(calls.map(call => nestedInvocation ? JSON.stringify(call) : call));
        row.callFacts[selected].qualifiedFields.input = recorded({});
        const before = row.record.invocation;
        assert.throws(() => projectNativeReadModel([row]), error => error instanceof NativeReadModelError
            && error.code === "json-structure-bound"
            && error.path === `$[0].callFacts[${selected}].qualifiedFields.input.decoded`);
        assert.equal(row.record.invocation, before);
    }
    const cowork = coworkFixture()[2];
    cowork.record.data.inp = deepArguments;
    cowork.qualifiedFields.input = recorded({});
    reject([cowork], "json-structure-bound");
});

test("decoded JSON depth boundary is inclusive and retains original strings, identities and coordinates", () => {
    for (const nestedInvocation of [false, true]) for (const individual of [false, true]) {
        const row = imageFixture()[0];
        const call = JSON.parse(JSON.parse(row.record.invocation)[0]);
        const encoded = "[".repeat(64) + "0" + "]".repeat(64);
        call.function.arguments = encoded;
        row.record.invocation = JSON.stringify([nestedInvocation ? JSON.stringify(call) : call]);
        row.qualifiedFields.input = recorded(encoded);
        if (individual) {
            row.callFacts = [{
                nativeCallId: call.id, qualifiedFields: { input: row.qualifiedFields.input },
                evidenceReferences: { input: row.evidenceReferences.input },
            }];
            delete row.qualifiedFields.input;
            delete row.evidenceReferences.input;
        }
        const original = structuredClone(row);
        const view = projectNativeReadModel([row]).conversations[0].calls[0];
        assert.equal(view.nativeCallId, call.id);
        assert.equal(view.observations[0].fields.input.value, encoded);
        assert.deepEqual(view.observations[0].ordering, row.ordering);
        assert.deepEqual(row, original);
        call.function.arguments = "[" + encoded + "]";
        row.record.invocation = JSON.stringify([nestedInvocation ? JSON.stringify(call) : call]);
        if (individual) row.callFacts[0].qualifiedFields.input.value = call.function.arguments;
        else row.qualifiedFields.input.value = call.function.arguments;
        reject([row], "json-structure-bound");
    }
});

test("decoded nonfinite numbers reject as non-JSON values, not null fallbacks or successful inputs", () => {
    for (const rawJson of ["1e999", '{"invented":1e999}']) {
        const row = imageFixture()[0];
        const call = JSON.parse(JSON.parse(row.record.invocation)[0]);
        call.function.arguments = rawJson;
        row.record.invocation = JSON.stringify([call]);
        row.qualifiedFields.input = recorded(rawJson);
        reject([row], "non-json-value");
    }
    for (const nestedInvocation of [false, true]) {
        const row = imageFixture()[0];
        const serialized = '{"id":"invented-image-call","type":"function","function":{"name":"image_gen","arguments":{"n":1e999}}}';
        row.record.invocation = nestedInvocation ? JSON.stringify([serialized]) : `[${serialized}]`;
        reject([row], "non-json-value");
    }
});

test("ordinary serialized arguments and non-JSON native input strings retain their existing meaning", () => {
    for (const input of ['{"query":"Invented input","count":2}', "An invented plain input.", ""]) {
        const row = imageFixture()[0];
        const call = JSON.parse(JSON.parse(row.record.invocation)[0]);
        call.function.arguments = input;
        row.record.invocation = JSON.stringify([call]);
        row.qualifiedFields.input = input === "" ? { availability: "recorded-empty", value: "" } : recorded(input);
        const result = projectNativeReadModel([row]);
        assert.equal(result.conversations[0].calls[0].observations[0].fields.input.value, input);
        row.qualifiedFields.input = recorded({});
        reject([row], "input-source-conflict");
    }
});
