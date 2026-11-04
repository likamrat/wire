import test from "node:test";
import assert from "node:assert/strict";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { nativeWriterAdmission } from "../lib/native-read-model.mjs";
import { nativeConsumerFixture, nativeConsumerCommand } from "./native-consumer-fixture.mjs";
import { fixture as githubRecord } from "./helpers.mjs";

const A = "a".repeat(64), B = "b".repeat(64);
const selection = { layer: "tool", bucket: "month", filters: { scope: "all" } };
const chatSelection = { ...selection, filters: { sources: ["microsoft-365-chat"] } };
const callIds = ["invented-runtime-call-one", "invented-runtime-call-two"];

// This mapping belongs only to the existing synthetic lifecycle fixture.
function accountFor(lease) {
    assert.equal(lease.kind, "microsoft-retained");
    assert.ok(Object.isFrozen(lease));
    assert.ok(Number.isSafeInteger(lease.generation));
    assert.ok([A, B].includes(lease.partition));
    return lease.partition === A ? { subjectId: "invented-runtime-a", marker: "alpha" }
        : { subjectId: "invented-runtime-b", marker: "beta" };
}
function originalMessages(marker) {
    return [
        { messageId: "invented-runtime-user", requestId: "invented-message-request", author: "user",
            text: "An invented runtime question." },
        { messageId: "invented-runtime-reply", storageMessageId: "invented-runtime-reply-store",
            requestId: "invented-message-request", author: "bot", text: `Runtime cobalt memo ${marker}.` },
        { messageId: "invented-runtime-invocation", storageMessageId: "invented-runtime-invocation-store",
            requestId: "invented-message-request", author: "bot", messageType: "CompletePlugin",
            invocation: JSON.stringify([
                JSON.stringify({ id: callIds[0], type: "function",
                    function: { name: "invented_lookup", arguments: { query: `Runtime quartz input ${marker}`, limit: 2 } } }),
                { id: callIds[1], type: "function",
                    function: { name: "invented_second", arguments: JSON.stringify({ query: `Runtime amber input ${marker}`, limit: 1 }) } },
            ]),
            result: { value: "Success", message: "RAW_COMPLETION_PROSE_NOT_RETAINED" },
            metadata: { private: "RAW_SOURCE_METADATA_NOT_RETAINED" } },
    ];
}
function decodeSource(lease, messages = originalMessages(accountFor(lease).marker)) {
    const account = accountFor(lease);
    return messages.map((record, index) => decodeNativeChatObservation({
        scope: { harness: "microsoft-365-copilot", surface: "chat",
            account: { tenantId: "invented-runtime-tenant", subjectId: account.subjectId, verification: "verified" },
            conversationId: "invented-runtime-conversation" },
        capture: { captureId: `invented-runtime-capture-${account.marker}`, capturedAt: "2026-01-03T00:00:00.000Z",
            generation: 97, parserVersion: "invented-runtime-original-source", sourceSchema: "invented-chat-source",
            operation: "history-read", bodyDigest: "c".repeat(64) },
        ordering: { pageOrdinal: 3, frameOrdinal: 2, recordOrdinal: index, completeness: "response-only" },
        source: { sourceDocument: "invented-runtime-response", pointer: `/frames/2/messages/${index}`, responsePointer: "/frames/2" },
        responseRequestId: "invented-envelope-request", record,
    }));
}
const compatible = decoded => decoded.flatMap(row => row.envelopes);

test("decoded original Chat records cross the actual HTTP snapshot, analytics and request-reader carrier", async t => {
    const github = githubRecord();
    github.toolCalls[0].toolCallId = callIds[0];
    const leases = [];
    const app = await nativeConsumerFixture(t, { records: [github], source: lease => {
        leases.push(lease);
        return compatible(decodeSource(lease));
    } });
    const api = await app.start();
    const snapshot = await api("/api/snapshot", selection);
    assert.equal(snapshot.status, 200);
    assert.ok(leases.length >= 2, "Snapshot publication must re-read through the genuine retained lease");
    const record = snapshot.body.scenarios.find(row => row.sourceId === "microsoft-365-chat");
    const conversation = record.nativeConversation;
    assert.equal(conversation.scope.surface, "chat");
    assert.equal(conversation.scope.account.subjectId, "invented-runtime-a");
    assert.deepEqual(conversation.messages.map(row => row.value.text),
        ["An invented runtime question.", "Runtime cobalt memo alpha."]);
    assert.deepEqual(conversation.calls.map(row => row.nativeCallId), callIds);
    const nativeRows = snapshot.body.requestActivity.tool.filter(row => row.sourceId === "microsoft-365-chat");
    assert.equal(nativeRows.length, 2);
    for (const row of nativeRows) {
        const reader = snapshot.body.scenarios.find(item => item.scenarioId === row.scenarioId).nativeConversation;
        const call = reader.calls.find(item => item.key === row.id);
        assert.equal(call.nativeCallId, row.toolCallId);
        assert.equal(call.outcome.state, "unknown");
        assert.equal(row.outcome, "unknown");
        assert.equal(call.observations[0].identity.requestId, "invented-message-request");
        assert.deepEqual(call.observations[0].ordering,
            { pageOrdinal: 3, frameOrdinal: 2, recordOrdinal: 2, completeness: "response-only" });
        assert.equal(call.observations[0].fields.input.evidence[0].pointer, "/frames/2/messages/2/invocation");
    }
    assert.deepEqual(conversation.calls[0].observations[0].fields.input.value,
        { query: "Runtime quartz input alpha", limit: 2 });
    assert.equal(conversation.calls[1].observations[0].fields.input.value,
        '{"query":"Runtime amber input alpha","limit":1}');
    const githubCollision = snapshot.body.requestActivity.tool.find(row =>
        row.sourceId === "github-copilot" && row.toolCallId === callIds[0]);
    assert.ok(githubCollision);
    assert.notEqual(githubCollision.id, nativeRows[0].id);
    const analytics = await api("/api/analytics", chatSelection);
    assert.equal(analytics.status, 200);
    assert.deepEqual(analytics.body.rows.map(row => row.id), nativeRows.map(row => row.id));
    assert.ok(analytics.body.rows.every(row => row.sourceScope.surface === "chat" && row.outcome === "unknown"));
    const narrowed = await api("/api/analytics", { ...chatSelection, filters: {
        ...chatSelection.filters, tools: ["invented_second"],
    } });
    assert.equal(narrowed.body.rows.length, 1);
    assert.equal(narrowed.body.rows[0].toolCallId, callIds[1]);
    assert.deepEqual((await api("/api/analytics", { ...selection, filters: { sources: ["microsoft-365-cowork"] } })).body.rows, []);
    assert.deepEqual((await api("/api/analytics", { ...chatSelection, layer: "reported-api" })).body.rows, []);
    assert.deepEqual(snapshot.body.nativeRead.admission, nativeWriterAdmission());
    assert.equal(snapshot.body.nativeRead.admission.blockers.length, 3);
    const report = await api("/api/preview", { selection: { kind: "selected",
        revision: snapshot.body.revision, scenarioIds: [record.scenarioId] } });
    assert.equal(report.status, 503);
    assert.equal(report.body.code, "native-report-provenance-unqualified");
    assert.doesNotMatch(JSON.stringify(snapshot.body), /RAW_COMPLETION_PROSE|RAW_SOURCE_METADATA/);
});

test("local HTTP Search query/Open resolves decoded text and the correct native call, then rejects revoked receipts",
    { timeout: 15000 }, async t => {
        const app = await nativeConsumerFixture(t, { source: lease => compatible(decodeSource(lease)) });
        const api = await app.start(), stream = await api.stream();
        t.after(() => stream.close());
        await stream.next(event => event.event === "connected");
        const snapshot = await api("/api/snapshot", chatSelection);
        const record = snapshot.body.scenarios[0], conversation = record.nativeConversation;
        const textQuery = await api("/api/search/query",
            { schemaVersion: 3, purpose: "navigation", query: "cobalt memo alpha", requestId: 1 });
        assert.equal(textQuery.status, 200);
        const textResult = await stream.next(event => event.event === "results");
        assert.equal(textResult.matches.hits.length, 1);
        const textHit = textResult.matches.hits[0];
        assert.equal(textHit.coverage.sourceId, "microsoft-365-chat");
        assert.equal(textHit.coverage.scope.account.subjectId, "invented-runtime-a");
        assert.equal(textHit.coverage.unit, "message-representation-observation");
        const openingText = api("/api/search/open", { id: textHit.id, receipt: textResult.matches.receipt, openId: 1 });
        const textOpened = await stream.next(event => event.event === "opened");
        assert.equal((await openingText).status, 200);
        assert.equal(textOpened.document.kind, "route");
        assert.equal(new URLSearchParams(textOpened.document.href.split("?")[1]).get("request"), record.scenarioId);
        assert.equal(textOpened.document.focus, `native-message-${encodeURIComponent(textHit.coverage.observationKey)}`);
        assert.ok(conversation.messages.some(row => row.observationKey === textHit.coverage.observationKey));
        const inputQuery = await api("/api/search/query",
            { schemaVersion: 3, purpose: "navigation", query: "amber input alpha", requestId: 2 });
        assert.equal(inputQuery.status, 200);
        const inputResult = await stream.next(event => event.event === "results");
        assert.equal(inputResult.matches.hits.length, 1);
        const inputHit = inputResult.matches.hits[0];
        assert.equal(inputHit.coverage.unit, "native-tool-call");
        assert.equal(inputHit.coverage.outcome, "unknown");
        const openingCall = api("/api/search/open", { id: inputHit.id, receipt: inputResult.matches.receipt, openId: 2 });
        const callOpened = await stream.next(event => event.event === "opened");
        assert.equal((await openingCall).status, 200);
        const target = new URLSearchParams(callOpened.document.href.split("?")[1]);
        assert.equal(target.get("request"), record.scenarioId);
        assert.equal(target.get("layer"), "tool");
        assert.equal(target.get("call"), conversation.calls[1].key);
        assert.equal(conversation.calls[1].nativeCallId, callIds[1]);
        assert.equal(conversation.calls[1].observations[0].fields.input.evidence[0].pointer, "/frames/2/messages/2/invocation");
        await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
        assert.equal((await api("/api/snapshot", chatSelection)).status, 403);
        assert.equal((await api("/api/search/open", { id: inputHit.id, receipt: inputResult.matches.receipt, openId: 3 })).status, 403);
        await nativeConsumerCommand(app.lifecycle, "wire-sign-in");
        assert.equal((await api("/api/search/open", { id: inputHit.id, receipt: inputResult.matches.receipt, openId: 4 })).status, 428);
    });

for (const action of ["sign-out", "replacement"]) {
    test(`a held original Chat source cannot publish through HTTP after ${action}`, { timeout: 15000 }, async t => {
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        t.after(() => release.resolve());
        let hold = false;
        const app = await nativeConsumerFixture(t, { source: async lease => {
            const raw = originalMessages(accountFor(lease).marker);
            if (hold && lease.partition === A) {
                entered.resolve(lease);
                await release.promise;
            }

            return compatible(decodeSource(lease, raw));
        } });
        const api = await app.start(), previous = await app.reader.scan();
        assert.notEqual(previous.generation, previous.records[0].nativeConversation.observations[0].capture.generation);
        hold = true;
        const pending = api("/api/snapshot", chatSelection);
        try {
            const lease = await entered.promise;
            assert.equal(lease.partition, A);
            if (action === "replacement") await nativeConsumerCommand(app.lifecycle, "microsoft-connect",
                { expectedPartition: B, replace: true });
            else await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
        } finally {
            release.resolve();
        }
        const stale = await pending;
        assert.equal(stale.status, 403);
        assert.equal(stale.body.code, "wire_access_revoked");
        assert.doesNotMatch(JSON.stringify(stale.body), /Runtime cobalt|Runtime quartz|invented-runtime-a/);
        let published = false;
        await assert.rejects(app.reader.publish(previous, () => { published = true; }), { code: "wire_access_revoked" });
        assert.equal(published, false);
        hold = false;
        if (action === "sign-out") {
            assert.equal((await api("/api/snapshot", chatSelection)).status, 403);
            await nativeConsumerCommand(app.lifecycle, "wire-sign-in");
        }
        const fresh = await api("/api/snapshot", chatSelection);
        assert.equal(fresh.status, 200);
        const conversation = fresh.body.scenarios[0].nativeConversation;
        assert.equal(conversation.scope.account.subjectId, action === "replacement" ? "invented-runtime-b" : "invented-runtime-a");
        assert.equal(conversation.messages[1].value.text,
            `Runtime cobalt memo ${action === "replacement" ? "beta" : "alpha"}.`);
        assert.deepEqual(conversation.calls.map(row => row.nativeCallId), callIds);
        if (action === "replacement") {
            assert.notEqual(conversation.key, previous.records[0].nativeConversation.key);
            assert.notEqual(conversation.calls[0].key, previous.records[0].nativeConversation.calls[0].key);
            assert.doesNotMatch(JSON.stringify(fresh.body.scenarios), /invented-runtime-a|cobalt memo alpha|quartz input alpha/);
        }
        await assert.rejects(app.reader.publish(previous, () => { published = true; }), { code: "wire_access_revoked" });
        assert.equal(published, false);
        assert.equal(fresh.body.nativeRead.admission.blockers.length, 3);
    });
}

test("the accepted native contract does not yet consume decoded Task/trigger details as reader, tool or Search facts",
    { timeout: 15000 }, async t => {
        let latestDecoded = [];
        const app = await nativeConsumerFixture(t, { source: lease => {
            const messages = originalMessages(accountFor(lease).marker);
            messages.push(
                { messageId: "invented-runtime-task-message", messageType: "Task", text: JSON.stringify({
                    type: "task", taskId: "invented-not-a-native-call", conversationId: "invented-runtime-conversation",
                    status: "Completed", name: "Unsupported violet task", result: "RAW_UNQUALIFIED_TASK_RESULT",
                }) },
                { messageId: "invented-runtime-trigger-message", messageType: "TriggerExtension",
                    actionId: "clarification_ask_user_question", sourceRequestId: "invented-original-source-request",
                    invocation: { callId: "invented-trigger-correlation", widgetId: "invented-runtime-widget",
                        function: { name: "clarification_ask_user_question",
                            arguments: { questions: ["Unsupported bronze clarification"] } } } },
            );
            latestDecoded = decodeSource(lease, messages);
            return compatible(latestDecoded);
        } });
        const api = await app.start();
        const snapshot = await api("/api/snapshot", chatSelection);
        assert.equal(snapshot.status, 200);
        const task = latestDecoded[3].sourceObservations[0], trigger = latestDecoded[4].sourceObservations[0];
        assert.equal(task.kind, "task");
        assert.equal(task.fields.name.value, "Unsupported violet task");
        assert.equal(task.fields.status.availability, "unqualified");
        assert.equal(task.readModel.availability, "unsupported");
        assert.equal(trigger.kind, "clarification");
        assert.deepEqual(trigger.fields.questions.value, ["Unsupported bronze clarification"]);
        assert.equal(trigger.fields.sourceRequestId.value, "invented-original-source-request");
        assert.equal(trigger.invocations[0].fields.callId.value, "invented-trigger-correlation");
        assert.equal(trigger.readModel.availability, "unsupported");
        const conversation = snapshot.body.scenarios[0].nativeConversation;
        assert.equal(conversation.observations.length, 5);
        assert.deepEqual(conversation.observations.slice(3).map(row => row.identity.nativeType), ["Task", "TriggerExtension"]);
        assert.equal(conversation.messages.length, 2);
        assert.deepEqual(conversation.calls.map(row => row.nativeCallId), callIds);
        assert.deepEqual(conversation.taskOutcomes, []);
        assert.equal(Object.hasOwn(conversation, "sourceObservations"), false);
        assert.equal(snapshot.body.requestActivity.tool.length, 2);
        assert.equal(snapshot.body.analytics.population.native.taskOutcomeObservations, 0);
        assert.ok(conversation.coverage.some(row => row.meaning === "native-contract-has-no-chat-task-facts"));
        assert.ok(conversation.coverage.some(row => row.meaning === "native-contract-has-no-chat-trigger-facts"));
        assert.doesNotMatch(JSON.stringify(snapshot.body),
            /Unsupported violet task|Unsupported bronze clarification|invented-trigger-correlation|RAW_UNQUALIFIED_TASK_RESULT/);
        const stream = await api.stream();
        t.after(() => stream.close());
        await stream.next(event => event.event === "connected");
        for (const [index, [query, expected]] of [
            ["cobalt memo alpha", 1], ["unsupported violet task", 0], ["unsupported bronze clarification", 0],
        ].entries()) {
            assert.equal((await api("/api/search/query",
                { schemaVersion: 3, purpose: "navigation", query, requestId: index + 10 })).status, 200);
            const event = await stream.next(value => value.event === "results");
            assert.equal(event.matches.hits.length, expected);
        }
        assert.equal(snapshot.body.nativeRead.admission.blockers.length, 3);
    });
