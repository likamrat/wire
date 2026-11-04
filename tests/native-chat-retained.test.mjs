import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture as githubRecord } from "./helpers.mjs";
import { nativeConsumerFixture, nativeConsumerCommand } from "./native-consumer-fixture.mjs";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";

function observations(name = "SOURCE_TASK_LITERAL_NOT_CALL") {
    const records = [
        { messageId: "invented-task-source", messageType: "Task", text: JSON.stringify({
            type: "task", taskId: "same-native-id", conversationId: "invented-chat-conversation",
            name, status: "Completed", steps: [], createdTimestamp: "2026-01-01T00:00:00Z",
            annotation: { type: "tool", content: "RAW_ANNOTATION" },
        }) },
        { messageId: "invented-trigger-source", messageType: "TriggerExtension", actionId: "clarification_ask_user_question",
            sourceRequestId: "same-native-id", request: { actionInputParameters: { questions: ["Original supplied question"] } } },
        { messageId: "invented-plain-source", messageType: "Chat", author: "bot", text: "ORIGINAL_MESSAGE_SEARCHABLE" },
    ];
    return records.flatMap((record, index) => retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource(record, index))));
}

test("decoded source observations reach the authorized HTTP snapshot without changing memberships, dates, Search policy or report admission", async t => {
    const envelopes = observations();
    const app = await nativeConsumerFixture(t, { records: [githubRecord()], envelopes });
    const api = await app.start();
    const before = await loadBoardState(app.context);
    const file = path.join(app.context.dataDir, `${before.boardId}.state.json`), bytes = await readFile(file);
    const options = { layer: "tool", bucket: "month", filters: { scope: "all", sources: ["microsoft-365-chat"] } };
    const response = await api("/api/snapshot", options);
    assert.equal(response.status, 200);
    const { scenarios, analytics, nativeRead, requestActivity } = response.body;
    const chat = scenarios.find(record => record.recordKind === "native-conversation");
    const conversation = chat.nativeConversation;
    assert.equal(conversation.sourceObservations.length, 3);
    assert.equal(conversation.sourceObservations[0].facts[0].fields.name.value, "SOURCE_TASK_LITERAL_NOT_CALL");
    assert.equal(conversation.sourceObservations[0].facts[0].fields.status.availability, "unqualified");
    assert.equal(conversation.sourceObservations[0].facts[0].fields.createdTimestamp.value, "2026-01-01T00:00:00Z");
    assert.deepEqual(conversation.calls, []);
    assert.deepEqual(conversation.taskOutcomes, []);
    assert.deepEqual(conversation.returnedResults, []);
    assert.equal(conversation.messages.length, 1);
    assert.equal(analytics.totals.count, 0);
    assert.deepEqual(analytics.population.scenarioIds, [chat.scenarioId]);
    assert.equal(analytics.population.native.noToolConversations, 1);
    assert.equal(analytics.population.native.messageRepresentationObservations, 1);
    assert.equal(requestActivity.tool.filter(row => row.sourceId === "microsoft-365-chat").length, 0);
    assert.equal(requestActivity.tool.filter(row => row.sourceId === "github-copilot").length, 1);
    assert.equal(nativeRead.admission.admitted, false);
    assert.equal(nativeRead.admission.blockers.length, 3);
    const dates = await api("/api/analytics", { ...options, filters: { ...options.filters, from: "2026-01-01", to: "2026-01-01" } });
    assert.equal(dates.status, 200);
    assert.deepEqual(dates.body.population.scenarioIds, []);
    assert.equal(dates.body.measurementEligibility.nativeActivityDates, "unqualified");
    assert.deepEqual((await api("/api/canvas", { action: "get_snapshot", input: options })).body.scenarios, scenarios);
    const preview = await api("/api/preview", { selection: { kind: "selected", revision: response.body.revision, scenarioIds: [chat.scenarioId] } });
    assert.equal(preview.status, 503);
    assert.equal(preview.body.code, "native-report-provenance-unqualified");
    const engine = createSearchRetrieval(app.context, { nativeReader: app.reader,
        source: () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 }), onInvalidate() {} });
    t.after(() => engine.close());
    await engine.build();
    let hits;
    const plain = await engine.search({ query: "ORIGINAL_MESSAGE_SEARCHABLE", requestId: 1 }, value => { hits = value; });
    assert.equal(plain.count, 1);
    assert.equal(hits[0].target.focus, `native-message-${encodeURIComponent(conversation.messages[0].observationKey)}`);
    const facts = await engine.search({ query: "SOURCE_TASK_LITERAL_NOT_CALL", requestId: 2 }, value => { hits = value; });
    assert.equal(facts.count, 1);
    assert.equal(hits[0].type, "context");
    assert.equal(hits[0].target.focus, `native-source-fact-${encodeURIComponent(conversation.sourceObservations[0].facts[0].key)}`);
    assert.equal(hits[0].coverage.completeness, "partial");
    assert.deepEqual(await readFile(file), bytes);
});

test("source-fact changes revise the real retained frame and reject stale or revoked publication without rewriting state", async t => {
    const app = await nativeConsumerFixture(t, { envelopes: observations() }), api = await app.start();
    const old = await app.reader.scan();
    app.setEnvelopes(observations("NEW_ORIGINAL_TASK_LITERAL"));
    const next = await app.reader.scan();
    assert.notEqual(next.revision, old.revision);
    assert.equal(next.records[0].scenarioId, old.records[0].scenarioId);
    assert.equal(next.records[0].nativeConversation.sourceObservations[0].facts[0].key,
        old.records[0].nativeConversation.sourceObservations[0].facts[0].key);
    let published = false;
    await assert.rejects(app.reader.publish(old, () => { published = true; }), { code: "native-read-stale" });
    assert.equal(published, false);
    await nativeConsumerCommand(app.lifecycle, "microsoft-connect", { expectedPartition: "b".repeat(64), replace: true });
    const replacement = await api("/api/state");
    assert.equal(replacement.status, 200);
    assert.equal(JSON.stringify(replacement.body).includes("NEW_ORIGINAL_TASK_LITERAL"), false);
    await assert.rejects(app.reader.publish(next, () => { published = true; }), { code: "wire_access_revoked" });
    await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
    assert.equal((await api("/api/state")).status, 403);
    assert.equal(published, false);
});

test("new Chat facts fail closed on malformed schema and a signout while the original authorized read is pending", async t => {
    const malformed = observations();
    malformed[0].chatSource.observations[0].fields.annotation = {
        availability: "recorded", value: { toolSuccess: true }, source: malformed[0].chatSource.observations[0].fields.annotation.source,
    };
    const app = await nativeConsumerFixture(t, { envelopes: malformed }), api = await app.start();
    const invalid = await api("/api/state");
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.code, "native-read-chat-source-unqualified-value");
    assert.equal(JSON.stringify(invalid.body).includes("toolSuccess"), false);
    const started = Promise.withResolvers(), release = Promise.withResolvers(), envelopes = observations();
    const pending = await nativeConsumerFixture(t, { source: async () => { started.resolve(); await release.promise; return envelopes; } });
    const read = pending.reader.scan();
    await started.promise;
    await nativeConsumerCommand(pending.lifecycle, "wire-sign-out");
    release.resolve();
    await assert.rejects(read, { code: "wire_access_revoked" });
});
