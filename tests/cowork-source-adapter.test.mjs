import test from "node:test";
import assert from "node:assert/strict";
import { adaptCoworkSourceRecords, adaptCoworkSourceRecordsWithMessageParts, adaptMatchedCoworkSourceRecords,
    prepareCoworkMessageParts, COWORK_MESSAGE_PART_LIMIT, COWORK_SOURCE_ADAPTER_VERSION,
    COWORK_PARTS_ADAPTER_VERSION, COWORK_MATCHED_ADAPTER_VERSION, adaptCoworkSourceRecordsWithResultFacts,
    COWORK_RESULT_ADAPTER_VERSION, COWORK_MATCHED_RESULT_ADAPTER_VERSION } from "../lib/cowork-source-adapter.mjs";
import { projectNativeReadModel, NativeReadModelError, NATIVE_READ_LIMITS,
    normalizeNativeSourceObservations, projectNativeRetainedObservations } from "../lib/native-read-model.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument } from "../lib/native-retention-contract.mjs";
import { coworkSourceContext, sourceObservation, coworkSourceFixture } from "./cowork-source-adapter-fixtures.mjs";
import { chatFixture } from "./native-read-model-fixtures.mjs";

const adapt = rows => adaptCoworkSourceRecords(rows, coworkSourceContext());
const project = rows => projectNativeReadModel(adapt(rows));
const reject = (rows, code, context = coworkSourceContext()) => assert.throws(
    () => adaptCoworkSourceRecords(rows, context),
    error => error instanceof NativeReadModelError && error.code === code);
const start = (data = {}) => sourceObservation({ id: "source-start", event: "ts",
    data: { tid: "call", tn: "mcp__outlook__MoveMessage", ...data } });
const end = (data = {}) => sourceObservation({ id: "source-end", event: "tx",
    data: { tid: "call", tn: "mcp__outlook__MoveMessage", ...data } });
const graphEnd = data => end({ tn: "mcp__graph__CallGraph", ...data });
const resultContext = (parserVersion = COWORK_MATCHED_RESULT_ADAPTER_VERSION) => ({
    ...coworkSourceContext(), capture: { ...coworkSourceContext().capture, parserVersion },
});
const resultEnvelopes = (data, context = resultContext()) => adaptCoworkSourceRecordsWithResultFacts([end(data)], context);

test("native result diagnostics use shared screening without decoding prose or borrowing outcomes", () => {
    const secret = "Authorization: Bearer " + "z".repeat(40);
    for (const [err, status, message] of [
        ["Permission [write] is required for {folder}.", "recorded", "Permission [write] is required for {folder}."],
        ["Access for sam@example.invalid was denied.", "redacted", "Access for [redacted] was denied."],
        [secret, "sensitive-excluded", undefined],
        ["a".repeat(8193), "size-excluded", undefined],
        ['{"message":"Do not deserialize this payload"}', "unsupported-format", undefined],
    ]) {
        const envelopes = resultEnvelopes({ ok: true, err });
        const failure = envelopes[0].qualifiedFields.failure.value;
        assert.equal(failure.messageStatus, status);
        assert.equal(failure.diagnostic.source, "native-tool-error");
        assert.equal(failure.diagnostic.message, message);
        assert.equal(failure.code, null);
        assert.equal(envelopes[0].record.data.err, undefined);
        assert.equal(projectNativeReadModel(envelopes).conversations[0].calls[0].outcome.state, "succeeded");
        assert.doesNotMatch(JSON.stringify(envelopes), /zzzzzz|sam@example/);
    }
    assert.equal(resultEnvelopes({ ok: false })[0].qualifiedFields.failure.availability, "absent-in-response");
    assert.equal(resultEnvelopes({ ok: false, err: null })[0].qualifiedFields.failure.availability, "explicit-null");
    assert.equal(resultEnvelopes({ ok: false, err: { message: "Unsupported object" } })[0]
        .qualifiedFields.failure.availability, "unsupported");
});

test("native successful returns retain only a qualified description and honest output availability", () => {
    for (const [data, contentStatus] of [
        [{}, "not-supplied"], [{ out: null }, "explicit-null"], [{ out: "" }, "recorded-empty"],
        [{ out: "PRIVATE_OUTPUT_BODY" }, "body-excluded"],
        [{ out: { statusCode: 204, responses: [{ status: 200 }, { status: 404 }] } }, "unsupported-format"],
        [{ results: [{ status: 204 }] }, "unsupported-format"],
        [{ out: '{"isError":true,"content":[{"text":"PRIVATE_OUTPUT_BODY"}]}' }, "body-excluded"],
        [{ out: "x".repeat(NATIVE_READ_LIMITS.textBytes + 1) }, "size-excluded"],
    ]) {
        const envelopes = resultEnvelopes({ ok: true, d: "Saved the selected item.", ...data });
        const result = envelopes[0].qualifiedFields.resultEvidence.value;
        assert.deepEqual(result, { version: 1, source: "native-tool-result", applicationError: null,
            statusCode: null, resultCount: null, contentStatus,
            description: { version: 1, status: "recorded", text: "Saved the selected item." } });
        assert.equal(envelopes[0].record.data.d, undefined);
        assert.equal(envelopes[0].record.data.out, undefined);
        assert.doesNotMatch(JSON.stringify(envelopes), /PRIVATE_OUTPUT_BODY/);
        assert.deepEqual(projectNativeReadModel(envelopes).conversations[0].returnedResults, []);
    }
    for (const [d, status] of [[null, "explicit-null"], ["", "recorded-empty"], [{ message: "Unknown" }, "unsupported-format"],
        ["password=not-for-retention", "sensitive-excluded"], ["a".repeat(8193), "size-excluded"]]) {
        assert.equal(resultEnvelopes({ ok: true, d })[0].qualifiedFields.resultEvidence.value.description.status, status);
    }
    assert.equal(resultEnvelopes({ ok: true })[0].qualifiedFields.resultEvidence.value.description.status, "not-supplied");
    const image = resultEnvelopes({ ok: true, tn: "mcp__image_generation__image_generate", out: "DO_NOT_COPY_OUTPUT",
        wr: [{ u: "https://invented.invalid/reference" }] })[0];
    assert.equal(image.qualifiedFields.resultEvidence.value.description.status, "not-supplied");
    assert.equal(image.qualifiedFields.resultEvidence.value.resultCount, null);
    assert.equal(image.qualifiedFields.resultReferences.value.cardinality, 1);
    assert.doesNotMatch(JSON.stringify(image), /DO_NOT_COPY_OUTPUT/);
    const legacy = resultEnvelopes({ ok: false, err: "A safe recorded failure.", d: "Unqualified legacy description" },
        resultContext(COWORK_RESULT_ADAPTER_VERSION))[0];
    assert.equal(legacy.qualifiedFields.failure.value.diagnostic.message, "A safe recorded failure.");
    assert.equal(legacy.qualifiedFields.resultEvidence.value.description, undefined);
    assert.ok(legacy.coverage.some(row => row.kind === "native-description-contract-unqualified"));
});

test("new native result facts reject wrong origins, forged statuses and unsafe retained text", () => {
    const original = resultEnvelopes({ ok: false, err: "Original failure.", d: "Original description.", out: "" });
    for (const change of [
        row => { row.capture.parserVersion = COWORK_MATCHED_ADAPTER_VERSION; },
        row => { row.qualifiedFields.failure.value.diagnostic.source = "completion-error"; },
        row => { row.evidenceReferences.failure.nativeEventId = "borrowed-event"; },
        row => { row.evidenceReferences.failure.pointer = "/messages/*/data/err"; },
        row => { row.evidenceReferences.resultEvidence = row.evidenceReferences.resultEvidence.slice(0, 1); },
        row => { row.evidenceReferences.resultEvidence[1].sourceDocument = "another-response"; },
        row => { row.qualifiedFields.resultEvidence.value.statusCode = 204; },
        row => { row.qualifiedFields.resultEvidence.value.applicationError = true; },
        row => { row.qualifiedFields.resultEvidence.value.resultCount = 1; },
        row => { row.qualifiedFields.resultEvidence.value.statusConflict = { structured: 200, text: 404 }; },
        row => { row.qualifiedFields.resultEvidence.value.description.status = "sensitive-excluded"; },
    ]) {
        const altered = structuredClone(original);
        change(altered[0]);
        assert.throws(() => projectNativeReadModel(altered), NativeReadModelError);
    }
    const retained = normalizeNativeSourceObservations(original);
    retained.records[0].fields.failure.value.diagnostic.message = '{"payload":"not a quoted native error"}';
    assert.throws(() => projectNativeRetainedObservations(retained), { code: "unqualified-native-diagnostic" });
    const chat = chatFixture()[0];
    chat.qualifiedFields.resultEvidence = structuredClone(original[0].qualifiedFields.resultEvidence);
    chat.evidenceReferences.resultEvidence = structuredClone(original[0].evidenceReferences.resultEvidence);
    assert.throws(() => projectNativeReadModel([chat]), { code: "native-result-source-unqualified" });
});

test("matched Cowork message roles are versioned without relabeling older captures or completing streams", () => {
    const rows = [
        sourceObservation({ id: "original-user-event", event: "u", data: { e: "u", id: "original-user-message", t: "Original user text" } }),
        sourceObservation({ id: "original-assistant-event", event: "a",
            data: { e: "a", id: "original-assistant-message", t: "Original assistant text", s: true } }, 1),
    ];
    const context = version => ({ ...coworkSourceContext(), capture: { ...coworkSourceContext().capture, parserVersion: version } });
    const before = adaptCoworkSourceRecordsWithMessageParts(rows, context(COWORK_PARTS_ADAPTER_VERSION));
    const old = structuredClone(before);
    assert.equal(before[0].qualifiedFields.message.value.author, "unknown");
    assert.equal(before[1].qualifiedFields.message, undefined);
    const next = adaptMatchedCoworkSourceRecords(rows, context(COWORK_MATCHED_ADAPTER_VERSION));
    assert.deepEqual(next.map(row => row.qualifiedFields.message.value.author), ["user", "assistant"]);
    assert.deepEqual(next.map(row => row.ordering.nativeEventId), ["original-user-event", "original-assistant-event"]);
    assert.deepEqual(next.map(row => row.outcomes), [{}, {}]);
    assert.ok(next.every(row => row.qualifiedFields.observationTime === undefined));
    const projected = projectNativeReadModel(next).conversations[0];
    assert.deepEqual(projected.observations[1].identity.links, [{ kind: "message", nativeId: "original-assistant-message", field: "id" }]);
    assert.deepEqual(projected.calls, []);
    assert.deepEqual(before, old);
    const account = { partition: "a".repeat(64), issuer: "https://source.example.invalid",
        tenantId: before[0].scope.account.tenantId, subjectId: before[0].scope.account.subjectId };
    const first = mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, before));
    for (const row of next) row.capture.captureId += "-matched";
    const saved = mergeNativeRetainedCapture(first.document, encodeNativeRetainedCapture(account, next));
    const restored = validateNativeRetainedDocument(JSON.parse(JSON.stringify(saved.document)));
    assert.equal(restored.records.find(row => row.capture.parserVersion === COWORK_PARTS_ADAPTER_VERSION
        && row.identity.nativeType === "u").fields.message.value.author, "unknown");
    assert.equal(restored.records.find(row => row.capture.parserVersion === COWORK_MATCHED_ADAPTER_VERSION
        && row.identity.nativeType === "u").fields.message.value.author, "user");
    assert.throws(() => adaptMatchedCoworkSourceRecords(rows, context(COWORK_PARTS_ADAPTER_VERSION)), { code: "unsupported-cowork-parser" });
    rows[1].record.data.e = "u";
    assert.equal(adaptMatchedCoworkSourceRecords(rows, context(COWORK_MATCHED_ADAPTER_VERSION))[1]
        .qualifiedFields.message.availability, "unqualified");
});

test("invented raw events reach the real projector as two calls with separate native task and tool outcomes", () => {
    const rows = coworkSourceFixture(), original = structuredClone(rows), context = coworkSourceContext();
    const envelopes = adaptCoworkSourceRecords(rows, context);
    const result = projectNativeReadModel(envelopes), conversation = result.conversations[0];
    assert.equal(conversation.calls.length, 2);
    assert.equal(conversation.calls[0].nativeCallId, "invented-batch");
    assert.equal(conversation.calls[0].outcome.state, "succeeded");
    assert.equal(conversation.calls[1].outcome.state, "failed");
    assert.deepEqual(conversation.calls[1].nativeToolNames, ["mcp__outlook__MoveMessage"]);
    assert.equal(conversation.taskOutcomes[0].unit, "native-task");
    assert.equal(conversation.taskOutcomes[0].aggregateToolSuccess, false);
    assert.equal(conversation.taskOutcomes[0].state, "completed");
    assert.equal(conversation.observations[0].fields.model.scope, "snapshot");
    assert.equal(conversation.calls[0].observations[0].fields.model, undefined);
    assert.equal(conversation.measurements[0].value, 12);
    assert.equal(conversation.measurements[0].unit, "ms");
    assert.equal(conversation.measurements[0].basis, "tx.data.dur");
    assert.equal(conversation.measurements[0].comparableToUserResponseLatency, false);
    assert.equal(envelopes[1].record.data.ts, 1700000000);
    assert.equal(envelopes[1].capture.capturedAt, context.capture.capturedAt);
    assert.equal(envelopes[1].ordering.nativeEventId, "seq:3");
    assert.equal(envelopes[1].ordering.sequence, undefined);
    assert.deepEqual(envelopes[1].evidenceReferences.input, {
        sourceDocument: "invented-response", pointer: "/messages/1/data/inp", nativeEventId: "seq:3",
    });
    assert.equal(result.admission.admitted, false);
    assert.equal(result.admission.blockers.length, 3);
    envelopes[1].qualifiedFields.input.value.body.requests[0].id = "changed-copy";
    assert.deepEqual(rows, original);
});

test("missing, empty, null, JSON-encoded and non-JSON input states are not synthesized from approval or neighbors", () => {
    const cases = [
        [{}, "absent-in-response", undefined],
        [{ inp: "" }, "recorded-empty", ""],
        [{ inp: null }, "explicit-null", null],
        [{ inp: {} }, "recorded", {}],
        [{ inp: "null" }, "explicit-null", null],
        [{ inp: '""' }, "recorded-empty", ""],
        [{ inp: '{"query":"invented"}' }, "recorded", { query: "invented" }],
        [{ inp: "<invented-render-ui>" }, "recorded", "<invented-render-ui>"],
        [{ m: { alternateUnqualified: true } }, "absent-in-response", undefined],
    ];
    for (const [data, availability, value] of cases) {
        const row = project([start(data)]).conversations[0].calls[0].observations[0];
        assert.equal(row.fields.input.availability, availability);
        assert.deepEqual(row.fields.input.value, value);
        assert.equal(row.outcome, undefined);
    }
    const missing = project(coworkSourceFixture()).conversations[0].calls[1].observations[0];
    assert.equal(missing.fields.input.reason, "field-absent-from-read-response");
    assert.equal(Object.hasOwn(missing.fields.input, "value"), false);
});

test("approvals and agents with colliding identifiers do not become tool outcomes or calls", () => {
    const conversation = project(coworkSourceFixture()).conversations[0];
    const byType = type => conversation.observations.find(row => row.identity.nativeType === type);
    assert.deepEqual(byType("ts").identity.links.map(link => link.kind), ["tool-call", "agent-reference"]);
    assert.deepEqual(byType("ta").identity.links.map(link => link.kind), ["approval", "tool-call"]);
    assert.deepEqual(byType("taa").identity.links.map(link => link.kind), ["approval"]);
    assert.equal(byType("taa").fields.approval.value, true);
    assert.deepEqual(byType("taa").outcomes, {});
    assert.deepEqual(byType("sa").identity.links.map(link => link.kind), ["agent-announcement"]);
    assert.equal(conversation.calls.some(call => call.nativeCallId === "invented-collision"), false);
    assert.equal(byType("ta").fields.input, undefined);
    for (const approved of [null, "true", 1]) {
        const row = sourceObservation({ id: "approval", event: "taa", data: { aid: "a", approved } });
        assert.equal(project([row]).conversations[0].observations[0].fields.approval, undefined);
        assert.ok(adapt([row])[0].coverage.some(item => item.kind === "unqualified-approval"));
    }
});

test("twenty declared request entries, absent result fields and wr references never create API results", () => {
    const envelopes = adapt(coworkSourceFixture());
    const result = projectNativeReadModel(envelopes).conversations[0];
    const declared = result.returnedResults.find(row => row.declaredRequestCount === 20);
    assert.equal(declared.availability, "unqualified");
    assert.equal(declared.declaredRequestCountIsSuccessDenominator, false);
    const completion = envelopes[4].outcomes.nestedApi;
    assert.equal(completion.availability, "absent-in-response");
    assert.equal(completion.declaredRequestCount, null);
    assert.ok(result.returnedResults.every(row => row.observed.length === 0));
    assert.equal(result.resultReferences[0].unit, "source-result-reference-entry");
    assert.deepEqual(result.resultReferences[0].value, {
        nativeField: "wr", cardinality: 2, itemFieldTypes: { u: { string: 1, null: 1 }, t: { string: 1 }, tp: { number: 1 }, s: { string: 1 } },
    });
    assert.ok(envelopes[4].coverage.some(row => row.kind === "returned-member-outcomes-unavailable"));
    const unqualified = adapt([graphEnd({ ok: true, out: '{"responses":[{"id":"member-1","status":200}]}' })])[0];
    assert.equal(unqualified.outcomes.nestedApi.availability, "unqualified");
    assert.deepEqual(unqualified.outcomes.nestedApi.observed, []);
    assert.equal(unqualified.record.data.out, undefined);
    assert.equal(adapt([graphEnd({ out: null })])[0].outcomes.nestedApi.availability, "explicit-null");
    assert.equal(adapt([graphEnd({ responses: [{ status: 200 }] })])[0].outcomes.nestedApi.availability, "unqualified");
    assert.equal(envelopes[6].outcomes.nestedApi, undefined);
});

test("wr records structural field types only, including empty and unsupported representations", () => {
    const value = project([end({ wr: [{ u: "secret=example", d: {}, t: [], tp: false, extra: "IGNORED" }, null, 3] })])
        .conversations[0].resultReferences[0].value;
    assert.deepEqual(value, { nativeField: "wr", cardinality: 3,
        itemFieldTypes: { u: { string: 1 }, t: { array: 1 }, tp: { boolean: 1 }, d: { object: 1 } } });
    assert.equal(adapt([end({ wr: [] })])[0].qualifiedFields.resultReferences.value.cardinality, 0);
    assert.equal(adapt([end({ wr: null })])[0].qualifiedFields.resultReferences.availability, "explicit-null");
    assert.equal(adapt([end({ wr: "[]" })])[0].qualifiedFields.resultReferences.availability, "unsupported");
});

test("credential-bearing inputs are excluded without retaining their original native payload", () => {
    const credential = "Bearer " + "z".repeat(40);
    for (const inp of [{ authorization: credential }, JSON.stringify({ authorization: credential }),
        '{"authorization":"\\u0042earer ' + "z".repeat(40) + '"}']) {
        const envelopes = adapt([start({ inp }), end({ ok: false, err: credential })]);
        const result = projectNativeReadModel(envelopes).conversations[0];
        assert.equal(result.calls[0].observations[0].fields.input.availability, "credential-excluded");
        assert.equal(envelopes[0].record.data.inp, undefined);
        assert.equal(result.calls[0].observations[1].fields.failure.value.messageStatus, "sensitive-excluded");
        assert.doesNotMatch(JSON.stringify(envelopes), /Bearer|authorization|zzzzzz/);
        assert.equal(result.calls[0].outcome.state, "failed");
    }
    const hiddenName = adapt([start({ tn: credential })])[0];
    assert.equal(hiddenName.qualifiedFields.toolName.availability, "credential-excluded");
    assert.equal(hiddenName.record.data.tn, undefined);
    assert.deepEqual(projectNativeReadModel([hiddenName]).conversations[0].calls[0].nativeToolNames, []);
    reject([start({ tid: credential })], "credential-bearing-metadata");
});

test("native failures exclude prose and do not borrow GitHub error-code or timeout interpretations", () => {
    for (const err of ["MCP error -32002: pending call dropped before response", '{"code":"AccessDenied","message":"forbidden"}']) {
        const failure = adapt([end({ ok: false, err })])[0].qualifiedFields.failure.value;
        assert.equal(failure.code, null);
        assert.equal(failure.messageSignal, null);
        assert.equal(failure.messageStatus, "text-excluded");
    }
    assert.equal(adapt([end({ ok: false, err: "x".repeat(8193) })])[0].qualifiedFields.failure.value.messageStatus, "size-excluded");
    assert.equal(adapt([end({ ok: false })])[0].qualifiedFields.failure.availability, "absent-in-response");
    assert.equal(adapt([end({ ok: false, err: null })])[0].qualifiedFields.failure.availability, "explicit-null");
    assert.equal(adapt([end({ ok: false, err: { code: "AccessDenied" } })])[0].qualifiedFields.failure.availability, "unsupported");
    for (const ok of [null, "true", 1]) assert.equal(project([end({ ok })]).conversations[0].calls[0].outcome.state, "unknown");
    assert.equal(project([start(), end()]).conversations[0].calls[0].outcome.state, "unknown");
});

test("unknown fields/types preserve observation identity and coverage, not arbitrary payload or guessed links", () => {
    const rows = coworkSourceFixture(), envelopes = adapt(rows), result = projectNativeReadModel(envelopes);
    const unknown = result.conversations[0].observations.at(-1);
    assert.equal(unknown.identity.id, "seq:12");
    assert.equal(unknown.identity.nativeType, "future-event");
    assert.deepEqual(unknown.identity.links, []);
    assert.ok(unknown.coverage.some(row => row.kind === "unsupported-event-type"));
    assert.ok(unknown.coverage.some(row => row.path === "/messages/8" && row.subject === "invented-response"));
    assert.doesNotMatch(JSON.stringify(envelopes), /PRIVATE_|UNKNOWN_|not-a-call|not-an-agent|not-a-tool-link|neverBorrow/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|UNKNOWN_/);
    const known = adapt([start({ extra: "SECRET_UNMAPPED_VALUE" })])[0];
    assert.ok(known.coverage.some(row => row.kind === "unmapped-source-fields"));
    assert.doesNotMatch(JSON.stringify(known), /SECRET_UNMAPPED_VALUE/);
});

test("caller ordering and source IDs survive pages, reordering, exact duplicates and conflicts", () => {
    const rows = [start({ inp: "{}" }), end({ ok: true })];
    rows[0].record.id = "seq:31";
    rows[0].ordering = { pageOrdinal: 3, frameOrdinal: 1, recordOrdinal: 7,
        sequence: 31, sequenceScope: "unknown", nativeEventId: "seq:31", completeness: "gapped-domain-unqualified" };
    rows[1].ordering.pageOrdinal = 1;
    const result = project([rows[1], rows[0], rows[0]]).conversations[0];
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].observations.length, 2);
    assert.deepEqual(result.observations[1].ordering, rows[0].ordering);
    assert.equal(project([...rows].reverse()).conversations[0].observations[0].observationKey,
        project(rows).conversations[0].observations[1].observationKey);
    const conflict = structuredClone(rows[0]); conflict.record.data.inp = '{"different":true}';
    reject([rows[0], conflict], "conflicting-observation-identity");
    const wrong = structuredClone(rows[0]); wrong.ordering.nativeEventId = "different";
    reject([wrong], "order-event-identity-conflict");
    const badSequence = structuredClone(rows[0]); badSequence.ordering.sequence = 30;
    reject([badSequence], "order-sequence-conflict");
    const later = structuredClone(rows[0]); later.ordering.pageOrdinal = 4;
    assert.equal(project([rows[0], later]).conversations[0].observations.length, 2);
});

test("explicit supplied source/account/capture context is required and remains historical, not an access lease", () => {
    const context = coworkSourceContext();
    for (const [section, field] of [["scope", "account"], ["capture", "capturedAt"], ["capture", "generation"]]) {
        const changed = structuredClone(context); delete changed[section][field];
        reject([start()], "missing-field", changed);
    }
    const other = coworkSourceContext(); other.scope.surface = "chat";
    reject([start()], "unsupported-cowork-surface", other);
    const authority = coworkSourceContext(); authority.capture.authorizationLease = true;
    reject([start()], "unsupported-field", authority);
    const version = coworkSourceContext(); version.capture.parserVersion = "unknown-parser";
    reject([start()], "unsupported-cowork-parser", version);
    assert.equal(context.capture.parserVersion, COWORK_SOURCE_ADAPTER_VERSION);
    const badSource = start(); badSource.source.pointer = "not-a-pointer";
    reject([badSource], "invalid-source-pointer");
    const escaped = start(); escaped.source.pointer = "/messages/~1/0";
    assert.equal(adapt([escaped])[0].evidenceReferences.input.pointer, "/messages/~1/0/data/inp");
    const malformedPointer = start(); malformedPointer.source.pointer = "/bad~2pointer";
    reject([malformedPointer], "invalid-source-pointer");
    reject([], "invalid-record-batch");
});

test("task, timing and incomplete lifecycle observations stay qualified without source defaults", () => {
    const unknownTask = sourceObservation({ task: { sessionId: "s", state: "new-state" } });
    assert.deepEqual(adapt([unknownTask])[0].outcomes, {});
    assert.ok(adapt([unknownTask])[0].coverage.some(row => row.kind === "unqualified-task-state"));
    assert.equal(adapt([sourceObservation({ task: { sessionId: "s" } })])[0].outcomes.task.state, "unknown");
    for (const dur of ["12", -1, {}]) assert.equal(adapt([end({ dur })])[0].qualifiedFields.callElapsed.availability, "unsupported");
    assert.equal(adapt([end({ dur: null })])[0].qualifiedFields.callElapsed.availability, "explicit-null");
    const orphan = sourceObservation({ id: "orphan", event: "tx", data: { ok: true } });
    assert.equal(project([orphan]).conversations[0].calls.length, 0);
    assert.equal(adapt([orphan])[0].outcomes.tool, undefined);
    assert.ok(adapt([orphan])[0].coverage.some(row => row.kind === "missing-native-call-id"));
    const orphanStart = start({ tid: null, inp: { recordedButUnattributed: true } });
    assert.equal(adapt([orphanStart])[0].qualifiedFields.input.availability, "unqualified");
    assert.equal(adapt([orphanStart])[0].qualifiedFields.input.reason, "input-call-association-unavailable");
    assert.equal(project([orphanStart]).conversations[0].calls.length, 0);
});

test("JSON guards reject accessors, serializers, cycles, sparse arrays and deep decoded input without executing them", () => {
    let invoked = false;
    const getter = start();
    Object.defineProperty(getter.record.data, "inp", { enumerable: true, get() { invoked = true; return {}; } });
    reject([getter], "non-json-accessor");
    const serializer = start(); serializer.record.toJSON = () => { invoked = true; return {}; };
    reject([serializer], "non-json-value");
    assert.equal(invoked, false);
    const cycle = start(); cycle.record.data.inp = cycle;
    reject([cycle], "non-json-input");
    const sparse = start(); sparse.record.data.inp = Array(2);
    reject([sparse], "non-json-value");
    reject([start({ inp: NaN })], "non-json-value");
    const deep = "[".repeat(65) + "0" + "]".repeat(65);
    reject([start({ inp: deep })], "json-structure-bound");
    let alias = { text: ".".repeat(1024) };
    for (let n = 0; n < 20; n++) alias = [alias, alias];
    const rows = [start({ inp: alias })], stringify = JSON.stringify;
    let serializedRoot = false;
    try {
        JSON.stringify = function (value, ...args) {
            if (value?.observations === rows) serializedRoot = true;
            return stringify(value, ...args);
        };
        reject(rows, "record-byte-bound");
    } finally { JSON.stringify = stringify; }
    assert.equal(serializedRoot, false);
});

test("UTF-8 and escaped JSON fact bounds are enforced without truncation or success-shaped fallback", () => {
    const exact = "\u00e9".repeat((NATIVE_READ_LIMITS.textBytes - 2) / 2);
    assert.equal(adapt([start({ inp: exact })])[0].qualifiedFields.input.availability, "recorded");
    reject([start({ inp: exact + "\u00e9" })], "fact-byte-bound");
    const escaped = "\n".repeat((NATIVE_READ_LIMITS.textBytes - 2) / 2);
    assert.equal(adapt([start({ inp: escaped })])[0].qualifiedFields.input.value, escaped);
    reject([start({ inp: escaped + "\n" })], "fact-byte-bound");
    reject([start({ ignored: ".".repeat(NATIVE_READ_LIMITS.bytes) })], "record-byte-bound");
    reject(Array(10001).fill(start()), "invalid-record-batch");
});

test("source JSON byte boundary includes wrappers and escapes, while input's original serialization is preserved", () => {
    const context = coworkSourceContext();
    const rows = [sourceObservation({ id: "boundary", event: "future-event", data: { ignored: "" } })];
    const overhead = Buffer.byteLength(JSON.stringify({ observations: rows, context }));
    rows[0].record.data.ignored = ".".repeat(NATIVE_READ_LIMITS.bytes - overhead);
    assert.equal(adaptCoworkSourceRecords(rows, context).length, 1);
    rows[0].record.data.ignored += ".";
    reject(rows, "record-byte-bound", context);
    const inp = '{"query": "\\u0069nvented"}';
    const envelope = adapt([start({ inp })])[0];
    assert.equal(envelope.record.data.inp, inp);
    assert.deepEqual(envelope.qualifiedFields.input.value, { query: "invented" });
    const loneSurrogates = "\ud800".repeat(Math.floor((NATIVE_READ_LIMITS.textBytes - 2) / 6));
    assert.equal(adapt([start({ inp: loneSurrogates })])[0].qualifiedFields.input.value, loneSurrogates);
    reject([start({ inp: loneSurrogates + "\ud800" })], "fact-byte-bound");
});

test("observed Cowork text shapes retain individual text and thinking fragments, not content-free terminal markers", () => {
    // Non-private literals exercise field shapes established by the bounded real-source pass.
    const rows = [
        sourceObservation({ id: "text-event", event: "u", data: { id: "message", t: "  text\n" } }, 0),
        sourceObservation({ id: "thinking-event", event: "th", data: { c: " thought ", aid: "agent" } }, 1),
        sourceObservation({ id: "thinking-marker", event: "th", data: { mid: "thinking-message" } }, 2),
        sourceObservation({ id: "delta-event", event: "dx", data: { t: " partial " } }, 3),
        sourceObservation({ id: "terminal-event", event: "fr", data: { mid: "response-message", stop: "end_turn" } }, 4),
    ];
    const envelopes = adapt(rows), conversation = projectNativeReadModel(envelopes).conversations[0];
    assert.deepEqual(conversation.messages.map(row => row.value.text), ["  text\n", " thought ", " partial "]);
    assert.deepEqual(conversation.messages.map(row => row.value.representation), ["plain-text", "plain-text", "reply-fragment"]);
    assert.ok(conversation.messages.every(row => row.value.author === "unknown"));
    assert.equal(conversation.messages[1].reason, "native-thinking-fragment-author-unqualified");
    assert.equal(conversation.messages[2].reason, "native-text-delta-author-unqualified");
    assert.deepEqual(conversation.messages.map(row => row.evidence[0].pointer), [
        "/messages/0/data/t", "/messages/1/data/c", "/messages/3/data/t",
    ]);
    assert.equal(conversation.calls.length, 0);
    assert.equal(envelopes[2].qualifiedFields.message, undefined);
    assert.equal(envelopes[4].qualifiedFields.message, undefined);
    assert.ok(envelopes[2].coverage.some(row => row.kind === "native-text-marker-without-content"));
    assert.ok(envelopes[4].coverage.some(row => row.kind === "native-text-marker-without-content"));
    assert.deepEqual(conversation.observations[2].identity.links.map(row => [row.kind, row.nativeId]), [["message", "thinking-message"]]);
    assert.deepEqual(conversation.observations[4].identity.links.map(row => [row.kind, row.nativeId]), [["message", "response-message"]]);
    assert.deepEqual(conversation.observations[3].identity.links, []);
    assert.equal(envelopes[0].record.data.t, undefined);
    assert.equal(envelopes[1].record.data.c, undefined);
    assert.equal(conversation.taskOutcomes.length, 0);
    const replay = project([...rows, rows[3]]).conversations[0];
    assert.equal(replay.messages.length, 3);
    assert.deepEqual(project([...rows].reverse()).conversations[0].messages.map(row => row.value.text), [" partial ", " thought ", "  text\n"]);
});

test("conversation text exclusions and source qualifiers do not become fabricated authors or replies", () => {
    const message = (event, data, index = 0) => sourceObservation({ id: `message-${index}`, event, data }, index);
    const rows = [
        message("u", { t: "Bearer " + "z".repeat(40) }, 0),
        message("th", { c: "" }, 1),
        message("dx", { t: null }, 2),
        message("u", { t: { text: "not-a-qualified-text-field" } }, 3),
        message("fr", { content: "runtime-injected-private-text", ri: true }, 4),
        message("dx", { t: "wrong-kind-private-text", e: "u" }, 5),
        message("fr", { content: "not-joined-to-any-delta", ri: false }, 6),
        message("rc", { card: { body: [{ text: "unqualified-card-private-text" }] } }, 7),
    ];
    const envelopes = adapt(rows), model = projectNativeReadModel(envelopes);
    assert.equal(envelopes[0].qualifiedFields.message.availability, "credential-excluded");
    assert.equal(envelopes[1].qualifiedFields.message.value.text, "");
    assert.equal(envelopes[2].qualifiedFields.message.availability, "explicit-null");
    assert.equal(envelopes[3].qualifiedFields.message.availability, "unsupported");
    assert.equal(envelopes[4].qualifiedFields.message.availability, "excluded-by-policy");
    assert.equal(envelopes[5].qualifiedFields.message.availability, "unqualified");
    assert.equal(envelopes[6].qualifiedFields.message.value.text, "not-joined-to-any-delta");
    assert.equal(envelopes[6].qualifiedFields.message.value.author, "unknown");
    assert.equal(envelopes[7].qualifiedFields.message, undefined);
    assert.ok(envelopes[7].coverage.some(row => row.kind === "unsupported-event-type"));
    assert.doesNotMatch(JSON.stringify(envelopes), /Bearer|zzzzzz|runtime-injected-private-text|wrong-kind-private-text|unqualified-card-private-text/);
    assert.equal(model.admission.admitted, false);
});

test("source-qualified question wording and acknowledged answer stay separate from choices, correlations and executions", () => {
    const question = sourceObservation({ id: "question-event", event: "aq", data: {
        iid: "question-invocation", rid: "question-request",
        q: [{ question: "Question wording", header: "Unprojected heading", options: [{ label: "Unprojected choice" }] }],
    } }, 0);
    const answer = sourceObservation({ id: "answer-event", event: "aa", data: {
        iid: "question-invocation", answers: { "0": "Acknowledged answer" },
    } }, 1);
    const envelopes = adapt([question, answer]), model = projectNativeReadModel(envelopes);
    const conversation = model.conversations[0];
    assert.deepEqual(conversation.messages.map(row => row.value), [
        { author: "unknown", representation: "plain-text", text: "Question wording" },
        { author: "unknown", representation: "plain-text", text: "Acknowledged answer" },
    ]);
    assert.deepEqual(conversation.messages.map(row => row.evidence[0].pointer), ["/messages/0/data/q/0/question", "/messages/1/data/answers/0"]);
    assert.equal(conversation.messages[1].reason, "native-acknowledged-answer-author-unqualified");
    assert.equal(conversation.calls.length, 0);
    assert.deepEqual(conversation.observations.map(row => row.identity.links), [[], []]);
    assert.doesNotMatch(JSON.stringify(envelopes), /Unprojected heading|Unprojected choice|question-invocation|question-request/);
    assert.ok(envelopes[0].coverage.some(row => row.kind === "native-question-text-only"));
    assert.equal(model.admission.admitted, false);
    for (const row of [
        { ...question, record: { ...question.record, data: { q: [{ question: "first" }, { question: "second" }] } } },
        { ...answer, record: { ...answer.record, data: { answers: { "0": "first", "1": "second" } } } },
        { ...answer, record: { ...answer.record, data: { answers: { "not-a-source-index": "value" } } } },
    ]) assert.equal(adapt([row])[0].qualifiedFields.message.availability, "unqualified");
    const excluded = structuredClone(answer);
    excluded.record.data.answers["0"] = "Bearer " + "z".repeat(40);
    const safe = adapt([excluded])[0];
    assert.equal(safe.qualifiedFields.message.availability, "credential-excluded");
    assert.doesNotMatch(JSON.stringify(safe), /Bearer|zzzzzz/);
});

test("candidate multipart preparation preserves source leaf pointers and covers the measured 108-leaf card without synthetic frames", () => {
    const source = { sourceDocument: "structural-regression", pointer: "/events/0" };
    const card = { id: "card-event", event: "rc", data: { card: { type: "AdaptiveCard", body: [
        { type: "TextBlock", text: "Heading" },
        { type: "Table", rows: [{ type: "TableRow", cells: [{ type: "TableCell", items: [{ type: "TextBlock", text: "Cell" }] }] }] },
    ] } } };
    const prepared = prepareCoworkMessageParts(card, source);
    assert.deepEqual(prepared.messageParts.map(part => part.message.value.text), ["Heading", "Cell"]);
    assert.deepEqual(prepared.messageParts.map(part => part.evidence.pointer), [
        "/events/0/data/card/body/0/text", "/events/0/data/card/body/1/rows/0/cells/0/items/0/text",
    ]);
    assert.ok(prepared.messageParts.every(part => part.evidence.nativeEventId === "card-event"
        && part.message.value.author === "unknown" && part.message.value.representation === "card-text"));
    assert.equal(Object.hasOwn(prepared, "record"), false);
    assert.equal(Object.hasOwn(prepared, "ordering"), false);
    const many = structuredClone(card);
    many.data.card.body = Array.from({ length: 108 }, () => ({ type: "TextBlock", text: "" }));
    assert.equal(prepareCoworkMessageParts(many, source).messageParts.length, 108);
    many.data.card.body = Array.from({ length: COWORK_MESSAGE_PART_LIMIT + 1 }, () => ({ type: "TextBlock", text: "" }));
    assert.throws(() => prepareCoworkMessageParts(many, source), { code: "native-message-part-bound" });
    const question = { id: "question-event", event: "aq", data: { q: [{
        question: "Wording", header: "", options: [{ label: "Choice", description: "Detail" }],
    }] } };
    assert.deepEqual(prepareCoworkMessageParts(question, source).messageParts.map(part => part.evidence.pointer), [
        "/events/0/data/q/0/question", "/events/0/data/q/0/header",
        "/events/0/data/q/0/options/0/label", "/events/0/data/q/0/options/0/description",
    ]);
    const answer = { id: "answer-event", event: "aa", data: { answers: { "0": "Bearer " + "z".repeat(40) } } };
    const excluded = prepareCoworkMessageParts(answer, source);
    assert.equal(excluded.messageParts[0].message.availability, "credential-excluded");
    assert.doesNotMatch(JSON.stringify(excluded), /Bearer|zzzzzz/);
});
