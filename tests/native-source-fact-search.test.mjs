import test from "node:test";
import assert from "node:assert/strict";
import { chatSource } from "./native-chat-source-fixtures.mjs";
import { nativeConsumerFixture, nativeConsumerCommand } from "./native-consumer-fixture.mjs";
import { decodeNativeChatObservation } from "../lib/native-chat-source.mjs";
import { retainNativeChatSourceObservations } from "../lib/native-read-model.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { createAnalysisSlice } from "../web/client.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { time } from "../lib/time.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { createSearchCorpus } from "../lib/search-corpus.mjs";

function sourceFacts(name = "Original Oriole task", extra = {}) {
    return retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource({
        messageId: "invented-fact-message", messageType: "Task", text: JSON.stringify({
            type: "task", taskId: "TECHNICAL_TASK_ID_NOT_TEXT", conversationId: "invented-chat-conversation",
            name, status: "FutureState", steps: [{ id: "TECHNICAL_STEP_ID_NOT_TEXT", stepTitle: "Original Finch step" }],
            ...extra,
        }),
    })));
}

async function live(t, envelopes) {
    const app = await nativeConsumerFixture(t, { envelopes });
    const api = await app.start(), stream = await api.stream();
    t.after(() => stream.close());
    await stream.next(event => event.event === "connected");
    let requestId = 0;
    const query = async (text, purpose = "navigation") => {
        const id = ++requestId;
        assert.equal((await api("/api/search/query", { schemaVersion: 3, purpose, query: text, requestId: id })).status, 200);
        return stream.next(event => event.event === "results" && event.requestId === id);
    };
    return { app, api, stream, query };
}

test("real local fact Search returns existing context kind and exact source-fact focus without a call or author", async t => {
    const { app, api, stream, query } = await live(t, sourceFacts());
    const result = await query("original oriole");
    assert.equal(searchWireContract.validResults(result), true);
    assert.equal(result.matches.hits.length, 1);
    const hit = result.matches.hits[0];
    assert.equal(hit.type, "context");
    assert.equal(hit.coverage.unit, "chat-source-observation");
    assert.equal(Object.hasOwn(hit.coverage, "author"), false);
    assert.equal(Object.hasOwn(hit.coverage, "layer"), false);
    const snapshot = await api("/api/state");
    const record = snapshot.body.scenarios[0], group = record.nativeConversation.sourceObservations[0], fact = group.facts[0];
    assert.equal(hit.coverage.factKey, fact.key);
    assert.equal(hit.coverage.observationKey, group.observationKey);
    assert.deepEqual(hit.coverage.factSource, fact.source);
    assert.deepEqual(hit.coverage.textSources.find(item => item.field === "fields.steps[0].fields.stepTitle").source,
        fact.fields.steps[0].fields.stepTitle.source);
    assert.equal(hit.target.focus, `native-source-fact-${encodeURIComponent(fact.key)}`);
    assert.equal(new URLSearchParams(hit.target.href.split("?")[1]).get("request"), record.scenarioId);
    assert.equal(new URLSearchParams(hit.target.href.split("?")[1]).has("call"), false);
    const opening = api("/api/search/open", { id: hit.id, receipt: result.matches.receipt, openId: 1 });
    const opened = await stream.next(event => event.event === "opened");
    assert.deepEqual(opened.document, { kind: "route", href: hit.target.href, focus: hit.target.focus });
    assert.equal((await opening).status, 200);
    assert.equal(snapshot.body.analytics.totals.count, 0);
    assert.equal(snapshot.body.analytics.population.native.noToolConversations, 1);
    assert.deepEqual(record.nativeConversation.calls, []);
    assert.equal((await query("Original Finch")).matches.hits.length, 1);
    assert.equal((await query("TECHNICAL_TASK_ID_NOT_TEXT")).matches.hits.length, 0);
    assert.equal((await query("TECHNICAL_STEP_ID_NOT_TEXT")).matches.hits.length, 0);
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    assert.equal((await query("FutureState")).matches.hits.length, 1);
});

test("only validated source display text is indexed; unavailable bodies and unknown schemas keep context coverage incomplete", async t => {
    const records = [
        { messageId: "invented-clarification-search", messageType: "TriggerExtension",
            actionId: "clarification_ask_user_question", sourceRequestId: "REQUEST_ID_NOT_SEARCHABLE",
            request: { actionInputParameters: { questions: [{ question: "Original Sparrow question", options: [
                { role: "action", label: "Original Wren label", submitResponse: "Original Osprey submission", description: "Original Kestrel description" },
            ] }] } } },
        { messageId: "invented-confirmation-search", messageType: "TriggerConfirmation",
            widgetData: { toolName: "GENERATED_WIDGET_NAME_NOT_SEARCHABLE" },
            confirmationMetadata: { text: "OPAQUE_CONFIRMATION_NOT_SEARCHABLE" },
            adaptiveCards: [{ body: [{ text: "RAW_CARD_BODY_NOT_SEARCHABLE" }], actions: [
                { type: "Action.Submit", data: { message: { actionId: "OriginalHeronAction", sourceId: "SUBMIT_ID_NOT_SEARCHABLE" } } },
            ] }] },
        { messageId: "invented-unsupported-search", messageType: "Task", text: JSON.stringify({
            type: "future-task-schema", content: "UNKNOWN_SCHEMA_NOT_SEARCHABLE",
        }) },
    ];
    const envelopes = [...sourceFacts("Original Swift task", {
        description: "RAW_DESCRIPTION_NOT_SEARCHABLE", result: "RAW_RESULT_NOT_SEARCHABLE",
        annotation: { type: "tool", payload: "OPAQUE_ANNOTATION_NOT_SEARCHABLE" },
    }), ...records.flatMap((record, index) =>
        retainNativeChatSourceObservations(decodeNativeChatObservation(chatSource(record, index + 1))))];
    const { api, query } = await live(t, envelopes);
    for (const text of ["Original Sparrow", "Original Wren", "Original Osprey", "Original Kestrel", "OriginalHeronAction"]) {
        const result = await query(text);
        assert.equal(result.matches.hits.length, 1, text);
        assert.equal(result.matches.hits[0].type, "context");
        assert.equal(result.matches.hits[0].coverage.completeness, "partial");
    }
    const forbidden = await query("NOT_SEARCHABLE");
    assert.equal(forbidden.matches.hits.length, 0);
    const partial = await query("Original Swift", "analysis");
    assert.equal(partial.matches.hits.length, 1);
    assert.equal(partial.status.corpus.state, "partial");
    assert.ok(partial.status.corpus.issues.some(issue => issue.types.includes("context")));
    assert.equal(searchWireContract.completeCoverage(partial.status.corpus, partial.matches.receipt.queryTypes), false);
    const comparison = await api("/api/period-comparison", comparisonInput(partial.matches.receipt));
    assert.equal(comparison.status, 428);
    assert.equal(comparison.body.code, "search-membership-unavailable");
});

function comparisonInput(receipt, filters = {}) {
    return { schemaVersion: 1, expectedRevision: receipt.revision,
        options: { layer: "tool", bucket: "month", filters },
        periods: { baseline: { from: "2026-01-01", to: "2026-01-01" }, later: { from: "2026-01-02", to: "2026-01-02" } },
        semanticSelection: { receipt }, withinServices: [] };
}

test("complete fact receipts select a no-call conversation but cannot restore it through excluded source, date or service scopes", async t => {
    const { api, query } = await live(t, sourceFacts());
    const result = await query("Original Oriole", "analysis");
    assert.equal(result.matches.hits.length, 1);
    assert.equal(searchWireContract.completeCoverage(result.status.corpus, result.matches.receipt.queryTypes), true);
    const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
    const slice = createAnalysisSlice({ phrase() { throw new Error("No lexical fallback is allowed."); } }, projection);
    const options = { layer: "tool", groupBy: "workload", limit: 10, bucket: "month",
        filters: { scope: "all", sources: ["microsoft-365-chat"] } };
    const snapshot = (await api("/api/snapshot", options)).body;
    const membership = createSearchMembership(snapshot, options, [], result.matches.hits, result.matches.receipt, searchWireContract);
    assert.equal(membership.scenarioIds.length, 1);
    assert.deepEqual(membership.actionIds, []);
    const accepted = slice(snapshot, options, "", [], membership);
    assert.deepEqual(accepted.scenarioIds, snapshot.analytics.population.scenarioIds);
    assert.equal(accepted.scenarioIds.length, 1);
    assert.deepEqual(accepted.rowIds, []);
    assert.deepEqual(accepted.analytics.unitPopulations, []);
    for (const filters of [
        { sources: ["github-copilot"] },
        { sources: ["microsoft-365-chat"], from: "2026-01-01", to: "2026-01-01" },
        { sources: ["microsoft-365-chat"], services: ["Mail"] },
        { sources: ["microsoft-365-chat"], outcomes: ["success"] },
    ]) {
        const selected = { ...options, filters }, current = (await api("/api/snapshot", selected)).body;
        const receiptMembership = createSearchMembership(current, selected, [], result.matches.hits, result.matches.receipt, searchWireContract);
        assert.deepEqual(current.analytics.population.scenarioIds, []);
        assert.deepEqual(slice(current, selected, "", [], receiptMembership).scenarioIds, []);
    }
    for (const filters of [{ sources: ["microsoft-365-chat"] }, { sources: ["github-copilot"] }]) {
        const comparison = await api("/api/period-comparison", comparisonInput(result.matches.receipt, filters));
        assert.equal(comparison.status, 200, JSON.stringify(comparison.body));
        assert.deepEqual(comparison.body.selection.semanticMembership.actionIds, []);
        assert.deepEqual(comparison.body.periods.baseline.scenarioIds, []);
        assert.deepEqual(comparison.body.periods.later.rowIds, []);
    }
});

test("fact hit receipt and exact target are retired by source revisions, account replacement and signout", async t => {
    const { app, api, query } = await live(t, sourceFacts());
    const result = await query("Original Oriole", "analysis");
    const hit = result.matches.hits[0], receipt = result.matches.receipt;
    assert.ok(hit);
    app.setEnvelopes(sourceFacts("Changed Pipit task"));
    const stale = await api("/api/search/open", { id: hit.id, receipt, openId: 1 });
    assert.equal(stale.status, 409);
    assert.ok(["native-read-stale", "stale-search-target"].includes(stale.body.code));
    const staleMembership = await api("/api/period-comparison", comparisonInput(receipt));
    assert.equal(staleMembership.status, 409);
    assert.equal(staleMembership.body.code, "stale-search-membership");
    await nativeConsumerCommand(app.lifecycle, "microsoft-connect", { expectedPartition: "b".repeat(64), replace: true });
    assert.equal((await api("/api/search/open", { id: hit.id, receipt, openId: 2 })).status, 428);
    const replaced = await api("/api/state");
    assert.equal(JSON.stringify(replaced.body).includes("Changed Pipit"), false);
    await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
    assert.equal((await api("/api/search/open", { id: hit.id, receipt, openId: 3 })).status, 403);
    await nativeConsumerCommand(app.lifecycle, "wire-sign-in");
    assert.equal((await api("/api/search/open", { id: hit.id, receipt, openId: 4 })).status, 428);
});

test("provider expiry still permits a fresh retained fact query without accepting an old partition or capture generation as authority", async t => {
    const app = await nativeConsumerFixture(t, { envelopes: sourceFacts() });
    const prior = await app.reader.scan();
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    const api = await app.start(), stream = await api.stream();
    t.after(() => stream.close());
    await stream.next(event => event.event === "connected");
    const response = await api("/api/search/query", { schemaVersion: 3, purpose: "navigation", query: "Original Oriole", requestId: 1 });
    assert.equal(response.status, 200);
    const result = await stream.next(event => event.event === "results");
    assert.equal(result.matches.hits.length, 1);
    assert.equal(result.matches.hits[0].coverage.scope.account.subjectId, "invented-subject");
    assert.notEqual(prior.generation, prior.records[0].nativeConversation.observations[0].capture.generation);
});

test("a queued local fact index cannot publish its retained text after signout", async t => {
    const app = await nativeConsumerFixture(t, { envelopes: sourceFacts() });
    const corpus = createSearchCorpus(app.context, { nativeReader: app.reader,
        source: () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 }), onInvalidate() {} });
    t.after(() => corpus.close());
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let published = false;
    const building = corpus.index(async entries => {
        assert.equal(entries.filter(entry => entry.coverage.unit === "chat-source-observation").length, 1);
        entered.resolve();
        await release.promise;
        return entries;
    }, () => { published = true; });
    await entered.promise;
    await nativeConsumerCommand(app.lifecycle, "wire-sign-out");
    release.resolve();
    const result = await building;
    assert.equal(published, false);
    assert.equal(result.state, "unavailable");
    assert.ok(result.issues.some(issue => issue.code === "wire_access_revoked"));
});
