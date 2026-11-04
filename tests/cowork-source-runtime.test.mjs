import test from "node:test";
import assert from "node:assert/strict";
import { adaptCoworkSourceRecords } from "../lib/cowork-source-adapter.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { nativeConsumerFixture, nativeConsumerCommand } from "./native-consumer-fixture.mjs";
import { coworkSourceContext, coworkSourceFixture, sourceObservation } from "./cowork-source-adapter-fixtures.mjs";

const A = "a".repeat(64), B = "b".repeat(64);
const needles = { [A]: "Cowork synthetic alpha input", [B]: "Cowork synthetic beta input" };
const credential = "Bearer " + "z".repeat(40);
const selection = { layer: "tool", bucket: "month", filters: { scope: "all", sources: ["microsoft-365-cowork"] } };

// The partition mapping is invented test input, not a production account resolver.
function sourceRecords(lease) {
    assert.equal(lease.kind, "microsoft-retained");
    assert.ok([A, B].includes(lease.partition));
    assert.ok(Number.isSafeInteger(lease.generation));
    const observations = coworkSourceFixture(), context = coworkSourceContext();
    const input = JSON.parse(observations[1].record.data.inp);
    input.purpose = needles[lease.partition];
    observations[1].record.data.inp = JSON.stringify(input);
    observations.push(
        sourceObservation({ id: "seq:20", event: "ts", data: { tid: "invented-protected",
            tn: "mcp__outlook__ReadMessage", inp: { authorization: credential } } }, 9),
        sourceObservation({ id: "seq:21", event: "tx", data: { tid: "invented-protected",
            tn: "mcp__outlook__ReadMessage", ok: false, err: credential } }, 10),
    );
    if (lease.partition === B) {
        context.scope.account.subjectId = "invented-replacement";
        context.capture.captureId = "invented-replacement-capture";
    }
    return { observations, context };
}

function decode(lease) {
    const { observations, context } = sourceRecords(lease);
    return adaptCoworkSourceRecords(observations, context);
}

function noPrivatePayload(value) {
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ERROR_PROSE|PRIVATE_REFERENCE|PRIVATE_TEXT|UNKNOWN_PRIVATE_PAYLOAD|Bearer|zzzzzz/);
}

test("raw Cowork source callback reaches real retained-reader HTTP snapshot and analytics without writer admission", { timeout: 20000 }, async t => {
    const leases = [];
    const app = await nativeConsumerFixture(t, { source: lease => { leases.push(lease); return decode(lease); } });
    const api = await app.start();
    assert.equal(new URL(app.url).hostname, "127.0.0.1");
    const snapshot = await api("/api/snapshot", selection);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.scenarios.length, 1);
    const record = snapshot.body.scenarios[0], conversation = record.nativeConversation;
    assert.equal(record.sourceId, "microsoft-365-cowork");
    assert.equal(conversation.scope.account.verification, "unqualified");
    assert.equal(conversation.calls.length, 3);
    const batch = conversation.calls.find(call => call.nativeCallId === "invented-batch");
    const start = batch.observations.find(row => row.identity.nativeType === "ts");
    const end = batch.observations.find(row => row.identity.nativeType === "tx");
    assert.equal(start.fields.input.value.purpose, needles[A]);
    assert.equal(start.fields.input.value.body.requests.length, 20);
    assert.deepEqual(start.fields.input.evidence, [{
        sourceDocument: "invented-response", pointer: "/messages/1/data/inp", nativeEventId: "seq:3",
    }]);
    assert.equal(end.outcomes.tool.state, "succeeded");
    assert.equal(end.outcomes.tool.unit, "native-tool");
    assert.deepEqual(end.outcomes.tool.evidence, [{
        sourceDocument: "invented-response", pointer: "/messages/4/data/ok", nativeEventId: "seq:8",
    }]);
    assert.equal(end.fields.callElapsed.value, 12);
    assert.equal(end.fields.callElapsed.unit, "ms");
    assert.equal(end.fields.callElapsed.comparableToUserResponseLatency, false);
    assert.equal(end.capture.capturedAt, coworkSourceContext().capture.capturedAt);
    const missing = conversation.calls.find(call => call.nativeCallId === "invented-move");
    assert.equal(missing.observations[0].fields.input.availability, "absent-in-response");
    assert.equal(missing.outcome.state, "failed");
    assert.equal(missing.observations[1].fields.failure.value.messageStatus, "text-excluded");
    const protectedCall = conversation.calls.find(call => call.nativeCallId === "invented-protected");
    assert.equal(protectedCall.observations[0].fields.input.availability, "credential-excluded");
    assert.equal(protectedCall.observations[1].fields.failure.value.messageStatus, "sensitive-excluded");
    assert.equal(conversation.taskOutcomes[0].state, "completed");
    assert.equal(conversation.taskOutcomes[0].aggregateToolSuccess, false);
    assert.equal(conversation.returnedResults.find(row => row.declaredRequestCount === 20).availability, "unqualified");
    assert.ok(conversation.returnedResults.every(row => row.observed.length === 0 && row.declaredRequestCountIsSuccessDenominator === false));
    assert.equal(end.outcomes.nestedApi.availability, "absent-in-response");
    assert.equal(conversation.resultReferences[0].unit, "source-result-reference-entry");
    assert.equal(conversation.resultReferences[0].value.cardinality, 2);
    assert.equal(snapshot.body.nativeRead.admission.admitted, false);
    assert.deepEqual(snapshot.body.nativeRead.admission.blockers, [
        "cowork-missing-input-or-no-input-provenance", "cowork-original-nested-batch-outcomes", "chat-enterprise-execution-result-coverage",
    ]);
    const tools = await api("/api/analytics", selection);
    assert.equal(tools.status, 200);
    assert.deepEqual(tools.body.rows.map(row => [row.toolCallId, row.outcome]), [
        ["invented-batch", "success"], ["invented-move", "failure"], ["invented-protected", "failure"],
    ]);
    assert.ok(tools.body.rows.every(row => row.countUnit === "native-tool-call" && row.startedAt === null && row.durationMs === null));
    const results = await api("/api/analytics", { ...selection, layer: "reported-api" });
    assert.equal(results.status, 200);
    assert.deepEqual(results.body.rows, []);
    assert.equal(results.body.apiCoverage.returnedResultUnits, 0);
    const blocked = await api("/api/import", {});
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "wire_access_writer_integration_pending");
    const state = await loadBoardState(app.context);
    assert.deepEqual(state.evidence, []);
    assert.deepEqual(state.exports, []);
    noPrivatePayload([snapshot.body, tools.body, results.body, state]);
    assert.ok(leases.length > 0);
    assert.ok(leases.every(lease => lease.partition === A));
});

test("real local Search query/Open and account replacement use decoded Cowork source facts and fresh account keys", { timeout: 20000 }, async t => {
    const leases = [];
    const app = await nativeConsumerFixture(t, { source: lease => { leases.push(lease); return decode(lease); } });
    const api = await app.start(), stream = await api.stream();
    t.after(() => stream.close());
    await stream.next(event => event.event === "connected");
    const original = await app.reader.scan(), originalRecord = original.records[0];
    const originalCall = originalRecord.nativeConversation.calls.find(call => call.nativeCallId === "invented-batch");
    assert.equal((await api("/api/search/query", {
        schemaVersion: 3, purpose: "navigation", query: needles[A].toUpperCase(), requestId: 1,
    })).status, 200);
    const matches = (await stream.next(event => event.event === "results")).matches;
    assert.equal(matches.hits.length, 1);
    const hit = matches.hits[0];
    assert.equal(hit.coverage.sourceId, "microsoft-365-cowork");
    assert.equal(hit.coverage.unit, "native-tool-call");
    assert.equal(hit.coverage.outcome, "success");
    assert.equal(hit.coverage.scope.account.subjectId, "invented-subject");
    const opening = api("/api/search/open", { id: hit.id, receipt: matches.receipt, openId: 1 });
    const opened = await stream.next(event => event.event === "opened");
    assert.equal((await opening).status, 200);
    assert.equal(opened.document.kind, "route");
    const target = new URLSearchParams(opened.document.href.split("?")[1]);
    assert.equal(target.get("request"), originalRecord.scenarioId);
    assert.equal(target.get("call"), originalCall.key);
    assert.equal(target.get("layer"), "tool");
    for (const [index, query] of ["PRIVATE_ERROR_PROSE", "zzzzzzzz", "PRIVATE_REFERENCE"].entries()) {
        assert.equal((await api("/api/search/query", { schemaVersion: 3, purpose: "navigation", query, requestId: index + 2 })).status, 200);
        assert.deepEqual((await stream.next(event => event.event === "results")).matches.hits, []);
    }
    noPrivatePayload([matches, opened]);

    await nativeConsumerCommand(app.lifecycle, "microsoft-connect", { expectedPartition: B, replace: true });
    let published = false;
    await assert.rejects(app.reader.publish(original, () => { published = true; }), { code: "wire_access_revoked" });
    assert.equal(published, false);
    const replacement = await api("/api/snapshot", selection);
    assert.equal(replacement.status, 200);
    const record = replacement.body.scenarios[0], conversation = record.nativeConversation;
    assert.equal(record.sourceId, "microsoft-365-cowork");
    assert.equal(conversation.scope.account.subjectId, "invented-replacement");
    assert.notEqual(record.scenarioId, originalRecord.scenarioId);
    const replacementCall = conversation.calls.find(call => call.nativeCallId === "invented-batch");
    assert.notEqual(replacementCall.key, originalCall.key);
    assert.equal(replacementCall.observations[0].fields.input.value.purpose, needles[B]);
    assert.equal(JSON.stringify(replacement.body).includes(needles[A]), false);
    assert.equal(conversation.calls.length, originalRecord.nativeConversation.calls.length);
    const replacementStream = await api.stream();
    t.after(() => replacementStream.close());
    await replacementStream.next(event => event.event === "connected");
    assert.equal((await api("/api/search/query", {
        schemaVersion: 3, purpose: "navigation", query: needles[B], requestId: 1,
    })).status, 200);
    const replacementMatches = (await replacementStream.next(event => event.event === "results")).matches;
    assert.equal(replacementMatches.hits.length, 1);
    assert.equal(replacementMatches.hits[0].coverage.scope.account.subjectId, "invented-replacement");
    assert.notEqual(replacementMatches.hits[0].id, hit.id);
    const stale = await api("/api/search/open", { id: hit.id, receipt: matches.receipt, openId: 2 });
    assert.equal(stale.status, 409);
    assert.equal(JSON.stringify(stale.body).includes(needles[A]), false);
    assert.equal((await api("/api/search/query", {
        schemaVersion: 3, purpose: "navigation", query: needles[A], requestId: 2,
    })).status, 200);
    assert.deepEqual((await replacementStream.next(event => event.event === "results")).matches.hits, []);

    await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
    const readsBeforeDenied = leases.length;
    for (const [route, input] of [
        ["/api/snapshot", selection], ["/api/analytics", selection],
        ["/api/search/query", { schemaVersion: 3, purpose: "navigation", query: needles[B], requestId: 3 }],
        ["/api/search/open", { id: replacementMatches.hits[0].id, receipt: replacementMatches.receipt, openId: 3 }],
    ]) {
        const denied = await api(route, input);
        assert.equal(denied.status, 403);
        assert.equal(JSON.stringify(denied.body).includes(needles[B]), false);
    }
    assert.equal(leases.length, readsBeforeDenied);
    await assert.rejects(app.reader.scan(), { code: "wire_access_revoked" });
    await nativeConsumerCommand(app.lifecycle, "wire-sign-in");
    await nativeConsumerCommand(app.lifecycle, "microsoft-connect", { expectedPartition: B, replace: false });
    const recovered = await api("/api/snapshot", selection);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.scenarios[0].scenarioId, record.scenarioId);
    assert.equal(JSON.stringify(recovered.body).includes(needles[A]), false);
    assert.equal(recovered.body.nativeRead.admission.admitted, false);
    noPrivatePayload([replacement.body, replacementMatches, recovered.body]);
    assert.ok(leases.some(lease => lease.partition === A));
    assert.ok(leases.some(lease => lease.partition === B));
});

test("held raw source response cannot publish an HTTP snapshot after real signout revokes its lease", { timeout: 20000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let hold = false, decodedAfterRelease = 0;
    const app = await nativeConsumerFixture(t, { source: async lease => {
        const { observations, context } = sourceRecords(lease);
        if (hold) {
            hold = false;
            entered.resolve(lease);
            await release.promise;
            decodedAfterRelease++;
        }
        return adaptCoworkSourceRecords(observations, context);
    } });
    const api = await app.start();
    hold = true;
    const pending = api("/api/snapshot", selection);
    try {
        const heldLease = await entered.promise;
        assert.equal(heldLease.partition, A);
        await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
    } finally { release.resolve(); }
    const response = await pending;
    assert.equal(decodedAfterRelease, 1);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "wire_access_revoked");
    assert.equal(Object.hasOwn(response.body, "scenarios"), false);
    assert.equal(JSON.stringify(response.body).includes(needles[A]), false);
    noPrivatePayload(response.body);
    assert.equal((await api("/api/snapshot", selection)).status, 403);
    assert.deepEqual((await loadBoardState(app.context)).evidence, []);
});

test("held publication freshness read cannot disclose the previous account after replacement", { timeout: 20000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    let hold = false, published = false, decodedAfterRelease = 0;
    const app = await nativeConsumerFixture(t, { source: async lease => {
        const { observations, context } = sourceRecords(lease);
        if (hold) {
            hold = false;
            entered.resolve(lease);
            await release.promise;
            decodedAfterRelease++;
        }
        return adaptCoworkSourceRecords(observations, context);
    } });
    const api = await app.start(), frame = await app.reader.scan();
    hold = true;
    const publishing = app.reader.publish(frame, () => { published = true; });
    try {
        assert.equal((await entered.promise).partition, A);
        await nativeConsumerCommand(app.lifecycle, "microsoft-connect", { expectedPartition: B, replace: true });
    } finally { release.resolve(); }
    await assert.rejects(publishing, { code: "wire_access_revoked" });
    assert.equal(decodedAfterRelease, 1);
    assert.equal(published, false);
    const fresh = await api("/api/snapshot", selection);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.scenarios[0].nativeConversation.scope.account.subjectId, "invented-replacement");
    assert.equal(JSON.stringify(fresh.body).includes(needles[A]), false);
    assert.equal(JSON.stringify(fresh.body).includes(needles[B]), true);
    assert.equal(fresh.body.nativeRead.admission.admitted, false);
    noPrivatePayload(fresh.body);
});
