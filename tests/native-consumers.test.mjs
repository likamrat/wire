import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture as githubRecord, privateFixture } from "./helpers.mjs";
import { chatFixture, coworkFixture, multiCallChatFixture, recorded } from "./native-read-model-fixtures.mjs";
import { nativeWriterAdmission, assertNativeWriterAdmission } from "../lib/native-read-model.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";
import { createSearchRetrieval } from "../lib/search-retrieval.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { readSavedReportFile } from "../lib/report-artifacts.mjs";
import { nativeConsumerFixture as setup, nativeConsumerCommand as act, nativeConsumerEnvelopes as nativeData } from "./native-consumer-fixture.mjs";

const B = "b".repeat(64);
const unavailable = () => ({ available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
const selection = { layer: "tool", bucket: "month", filters: { scope: "all" } };

test("population rows bind exact parent and unit arrays for narrowed Search consumers", () => {
    const native = projectRetainedNativeRecords(coworkFixture()).records;
    for (const scenarios of [[githubRecord()], [githubRecord(), ...native]]) {
        for (const layer of ["tool", "reported-api", "http"]) {
            const analytics = buildActivityAnalytics(scenarios, { ...selection, layer });
            assert.deepEqual(analytics.population.rowIds, analytics.rows.map(row => row.id));
            assert.deepEqual(analytics.population.rowScenarioIds, analytics.rows.map(row => row.scenarioId ?? null));
            assert.deepEqual(analytics.population.rowUnits,
                analytics.rows.map(row => row.countUnit ?? (layer === "tool" ? "github-tool-call" : layer)));
        }
    }
});

test("shared population retains native identity, variants, no-tool conversations and separate measured units", () => {
    const noTools = chatFixture().map(row => ({ ...row, scope: { ...row.scope, conversationId: "invented-no-tools" } }));
    const account = multiCallChatFixture();
    account.scope.account.subjectId = "invented-second-subject";
    const { records } = projectRetainedNativeRecords([...nativeData(), ...noTools, account]);
    const github = githubRecord();
    github.toolCalls[0].toolCallId = "invented-image-call";
    const unknown = githubRecord("unknown-origin");
    unknown.sourceSessionId = "unknown-origin";
    delete unknown.sourceHost;
    const scenarios = [github, unknown, ...records];
    const analytics = buildActivityAnalytics(scenarios, selection);
    assert.equal(analytics.totals.count, 9);
    assert.equal(analytics.population.scenarioIds.length, 6);
    assert.equal(analytics.population.native.noToolConversations, 1);
    assert.equal(analytics.population.native.messageRepresentationObservations, 9);
    assert.deepEqual(analytics.population.coverage.unknownSourceScenarioIds, ["unknown-origin"]);
    assert.equal(new Set(analytics.rows.map(row => row.id)).size, 9);
    assert.equal(analytics.label, "Recorded tool calls");
    assert.equal(analytics.totals.successRate.percent, null);
    assert.equal(analytics.totals.successRate.unavailable, "different-source-unit-definitions");
    assert.deepEqual(analytics.unitPopulations.map(group => [group.unit, group.totals.count]).sort(),
        [["native-tool-call", 7], ["workiq-tool-call", 2]]);
    assert.equal(analytics.totals.duration.sampleCount, 0);
    for (const record of records) {
        assert.equal(record.scenarioId, record.nativeConversation.key);
        assert.equal(Object.hasOwn(record, "toolCalls"), false);
        assert.equal(Object.hasOwn(record, "userPrompt"), false);
    }
    const call = records.find(record => record.sourceId === "microsoft-365-chat"
        && record.nativeConversation.scope.account.subjectId === "invented-subject").nativeConversation.calls[0];
    assert.equal(call.observations[0].fields.input.value.prompt, "First invented input.");
    assert.equal(analytics.population.native.taskOutcomeObservations, 1);
    assert.equal(analytics.population.native.resultReferenceObservations, 1);
    assert.equal(analytics.rows.some(row => row.tool === "workiq-mcp__graph__CallGraph"), false);
    assert.deepEqual(buildRequestActivity(scenarios).tool.map(row => row.id), analytics.rows.map(row => row.id));
});

test("one source/date/tool/service/outcome predicate drives native membership without capture-time or service guesses", () => {
    const { records } = projectRetainedNativeRecords([...chatFixture(), ...coworkFixture()]);
    const chat = buildActivityAnalytics(records, { ...selection, filters: { sources: ["microsoft-365-chat"] } });
    assert.equal(chat.rows.length, 0);
    assert.deepEqual(chat.population.scenarioIds, [records[0].scenarioId]);
    for (const filters of [
        { sources: ["microsoft-365-chat"], tools: ["image_gen"] },
        { sources: ["microsoft-365-chat"], outcomes: ["unknown"] },
        { sources: ["microsoft-365-chat"], services: ["Mail"] },
        { from: "2026-01-01", to: "2026-01-01" },
    ]) assert.deepEqual(buildActivityAnalytics(records, { ...selection, filters }).population.scenarioIds, []);
    const failed = buildActivityAnalytics(records, { ...selection, filters: {
        sources: ["microsoft-365-cowork"], tools: ["mcp__outlook__MoveMessage"], outcomes: ["failure"],
    } });
    assert.equal(failed.rows.length, 1);
    assert.equal(failed.rows[0].sourceScope.surface, "cowork");
    assert.equal(failed.rows[0].startedAt, null);
    assert.equal(failed.rows[0].durationMs, null);
    assert.deepEqual(failed.rows[0].serviceAssociation.services, []);
    assert.equal(failed.rows[0].serviceAssociation.gaps[0].reason, "native-target-unqualified");
    assert.equal(failed.population.coverage.nativeActivityDates, "unqualified");
    for (const sources of [["microsoft"], ["github-copilot", "github-copilot"], "github-copilot", null]) {
        assert.throws(() => validateAnalyticsInput({ filters: { sources } }));
    }
    assert.doesNotThrow(() => validateAnalyticsInput({ filters: { sources: [] } }));
});

test("native outcomes/results and missing/conflicting facts remain distinct through the actual analytics adapter", () => {
    const envelopes = coworkFixture();
    const complete = envelopes.find(row => row.record.id === "seq:8");
    complete.outcomes.nestedApi = { unit: "nested-api-result", availability: "recorded", declaredRequestCount: 20,
        declaredRequestCountIsSuccessDenominator: false, observed: [
            { index: 0, indexKind: "response-array-position", statusCode: 200, errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported" },
            { index: 1, indexKind: "response-array-position", statusCode: 403, errorCode: "Denied", paginationPresent: true, evidenceLevel: "intermediary-reported" },
        ] };
    const { records } = projectRetainedNativeRecords(envelopes);
    const tools = buildActivityAnalytics(records, selection);
    const results = buildActivityAnalytics(records, { ...selection, layer: "reported-api" });
    assert.equal(tools.rows.length, 3);
    assert.equal(tools.rows.find(row => row.toolCallId === "invented-batch").outcome, "success");
    assert.deepEqual(results.rows.map(row => row.outcome), ["success", "failure"]);
    assert.equal(results.apiCoverage.returnedResultUnits, 2);
    assert.equal(results.rows.every(row => row.endpoint.path === null && row.durationMs === null), true);
    const conflict = structuredClone(complete);
    conflict.capture.captureId = "invented-conflicting-capture";
    conflict.record.data.ok = false;
    conflict.outcomes.tool.state = "failed";
    const conflicting = buildActivityAnalytics(projectRetainedNativeRecords([...envelopes, conflict]).records, selection);
    const row = conflicting.rows.find(row => row.toolCallId === "invented-batch");
    assert.equal(row.outcome, "unknown");
    assert.deepEqual(row.nativeConflicts, ["native-tool-outcome-conflict"]);
    const absent = envelopes.find(row => row.record.id === "seq:12");
    absent.qualifiedFields.input = recorded({});
    assert.throws(() => projectRetainedNativeRecords(envelopes), { code: "input-not-recorded-by-source" });
    const missing = chatFixture();
    delete missing[0].scope.account.tenantId;
    assert.throws(() => projectRetainedNativeRecords(missing), { code: "missing-field" });
    assert.equal(nativeWriterAdmission().blockers.length, 3);
    assert.throws(assertNativeWriterAdmission, { code: "native-writer-admission-withheld" });
});

test("snapshot and existing HTTP/canvas routes consume the shared carrier while native report admission stays closed", async t => {
    const app = await setup(t, { records: [githubRecord()] }), api = await app.start();
    const snapshot = await api("/api/snapshot", selection);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.scenarios.length, 3);
    assert.equal(snapshot.body.analytics.population.scenarioIds.length, 3);
    assert.equal(snapshot.body.nativeRead.admission.admitted, false);
    assert.equal(snapshot.body.nativeRead.reportSelection.code, "native-report-provenance-unqualified");
    const chatKey = snapshot.body.scenarios.find(record => record.sourceId === "microsoft-365-chat").scenarioId;
    const onlyChat = await api("/api/canvas", { action: "get_snapshot", input: { ...selection, filters: { sources: ["microsoft-365-chat"] } } });
    assert.equal(onlyChat.status, 200);
    assert.deepEqual(onlyChat.body.analytics.population.scenarioIds, [chatKey]);
    const rows = await api("/api/analytics", { ...selection, filters: { sources: ["microsoft-365-cowork"] } });
    assert.equal(rows.status, 200);
    assert.equal(rows.body.rows.length, 3);
    const blocked = await api("/api/preview", { selection: { kind: "selected", revision: snapshot.body.revision, scenarioIds: [chatKey] } });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "native-report-provenance-unqualified");
    assert.equal(snapshot.body.exportCatalog.blockedRequests.length, 2);
    assert.equal(snapshot.body.exportCatalog.excluded.nativeProvenanceUnqualifiedRequestGroups, 2);
    const compare = { schemaVersion: 1, expectedRevision: snapshot.body.revision, options: { ...selection, filters: { sources: ["microsoft-365-chat"] } },
        periods: { baseline: { from: "2026-01-01", to: "2026-01-01" }, later: { from: "2026-01-02", to: "2026-01-02" } },
        scenarioIds: [chatKey], withinServices: [] };
    const comparison = await api("/api/period-comparison", compare);
    assert.equal(comparison.status, 200);
    assert.deepEqual(comparison.body.periods.baseline.rowIds, []);
    assert.equal(comparison.body.periods.baseline.analytics.measurementEligibility.nativeActivityDates, "unqualified");
    const state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.exports.length, 0);
    assert.equal((await api("/api/state")).body.scenarios.length, 3);
    const preview = await api("/api/preview", { selection: { kind: "selected", revision: state.revision, scenarioIds: ["test-scenario"] },
        options: { formats: ["json"], promptMode: "none" } });
    assert.equal(preview.status, 200);
    assert.equal((await api("/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true })).status, 200);
    const saved = await api("/api/export", { previewId: preview.body.previewId, confirmed: true });
    assert.equal(saved.status, 200);
    const document = await readSavedReportFile(app.context, await loadBoardState(app.context), saved.body.bundle.bundleId);
    const bytes = await readFile(saved.body.bundle.files["product-report.json"]);
    await api("/api/state");
    assert.deepEqual(await readFile(saved.body.bundle.files["product-report.json"]), bytes);
    assert.equal(JSON.stringify(document.snapshot).includes("nativeConversation"), false);
    const githubComparison = await api("/api/period-comparison", {
        ...compare, expectedRevision: (await loadBoardState(app.context)).revision,
        options: { ...selection, filters: { sources: ["github-copilot"] } }, scenarioIds: ["test-scenario"],
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-10-01", to: "2026-10-01" } },
    });
    assert.equal(githubComparison.status, 200);
    const pairedPreview = await api("/api/preview", { periodComparison: githubComparison.body,
        options: { formats: ["json"], promptMode: "none", timeContext: githubComparison.body.timeContext } });
    assert.equal(pairedPreview.status, 200, JSON.stringify(pairedPreview.body));
    await act(app.lifecycle, "wire-sign-out");
    assert.equal((await api("/api/state")).status, 403);
});

test("real local Search query/Open shares source-qualified destinations and rejects a revoked original receipt", async t => {
    const app = await setup(t), api = await app.start(), stream = await api.stream();
    t.after(() => stream.close());
    await stream.next(event => event.event === "connected");
    const query = await api("/api/search/query", { schemaVersion: 3, purpose: "navigation", query: "First invented input.", requestId: 1 });
    assert.equal(query.status, 200);
    const event = await stream.next(value => value.event === "results");
    assert.equal(event.matches.hits.length, 1);
    const hit = event.matches.hits[0], receipt = event.matches.receipt;
    assert.equal(hit.coverage.sourceId, "microsoft-365-chat");
    const opening = api("/api/search/open", { id: hit.id, receipt, openId: 1 });
    const opened = await stream.next(value => value.event === "opened");
    assert.equal(opened.document.kind, "route");
    const target = new URLSearchParams(opened.document.href.split("?")[1]);
    assert.equal(target.get("call"), (await app.reader.scan()).records[0].nativeConversation.calls[0].key);
    assert.equal((await opening).status, 200);
    app.setEnvelopes(chatFixture());
    const stale = await api("/api/search/open", { id: hit.id, receipt, openId: 2 });
    assert.equal(stale.status, 409);
    assert.ok(["native-read-stale", "stale-search-target"].includes(stale.body.code));
    await act(app.lifecycle, "wire-sign-out");
    await act(app.lifecycle, "wire-sign-in");
    assert.equal((await api("/api/search/open", { id: hit.id, receipt, openId: 3 })).status, 428);
});

test("local literal Search indexes native representation observations without GitHub reply consent or storage writes", async t => {
    const app = await setup(t);
    const state = await loadBoardState(app.context);
    const stateFile = path.join(app.context.dataDir, `${state.boardId}.state.json`);
    const before = await readFile(stateFile);
    const engine = createSearchRetrieval(app.context, { source: unavailable, nativeReader: app.reader, onInvalidate() {} });
    t.after(() => engine.close());
    assert.equal((await engine.build()).state, "ready");
    let hits;
    assert.equal((await engine.search({ query: "FIRST INVENTED REPLY", requestId: 1 }, value => { hits = value; })).count, 1);
    const request = new URLSearchParams(hits[0].target.href.split("?")[1]).get("request");
    assert.equal(request, (await app.reader.scan()).records.find(row => row.sourceId === "microsoft-365-chat").scenarioId);
    assert.equal(hits[0].coverage.unit, "message-representation-observation");
    assert.equal(hits[0].target.focus, `native-message-${encodeURIComponent(hits[0].coverage.observationKey)}`);
    assert.equal((await engine.search({ query: "invented card", requestId: 2 }, value => { hits = value; })).count, 1);
    assert.equal(hits[0].coverage.representation, "card-text");
    assert.equal(hits[0].target.focus, `native-message-${encodeURIComponent(hits[0].coverage.observationKey)}`);
    const changed = chatFixture();
    changed[1].qualifiedFields.message.value.text = "Replacement text.";
    app.setEnvelopes(changed);
    let published = false;
    const stale = await engine.search({ query: "First invented reply", requestId: 3 }, () => { published = true; });
    assert.equal(published, false);
    assert.equal(stale.state, "stale");
    assert.deepEqual(await readFile(stateFile), before);
});

test("genuine Microsoft retained leases fence stale completion, signout and account replacement; expiry and Pause preserve retained reads", async t => {
    const app = await setup(t);
    const old = await app.reader.scan();
    assert.notEqual(old.generation, old.records[0].nativeConversation.observations[0].capture.generation);
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    assert.equal(await app.reader.publish(old, () => "paused-retained"), "paused-retained");
    await app.lifecycle.updateCollection({ paused: false, windowDays: 30 });
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    assert.ok((await app.reader.scan()).records.length);
    await act(app.lifecycle, "microsoft-connect", { expectedPartition: B, replace: true });
    let disclosed = false;
    await assert.rejects(app.reader.publish(old, () => { disclosed = true; }), { code: "wire_access_revoked" });
    assert.equal(disclosed, false);
    const replacement = await app.reader.scan();
    assert.equal(replacement.records.length, 1);
    assert.equal(replacement.records[0].nativeConversation.scope.account.subjectId, "invented-replacement");
    assert.equal(replacement.records.some(record => old.records.some(prior => prior.scenarioId === record.scenarioId)), false);
    await assert.rejects(app.reader.publish(structuredClone(replacement), () => {}), { code: "native-read-frame-invalid" });
    await act(app.lifecycle, "wire-sign-out");
    await assert.rejects(app.reader.scan(), { code: "wire_access_revoked" });
    const delayed = Promise.withResolvers(), started = Promise.withResolvers();
    const pending = await setup(t, { source: async () => { started.resolve(); return delayed.promise; } });
    const reading = pending.reader.scan();
    await started.promise;
    await act(pending.lifecycle, "wire-sign-out");
    delayed.resolve(chatFixture());
    await assert.rejects(reading, { code: "wire_access_revoked" });
});

test("publication rechecks a pending read and malformed native observations fail with bounded existing errors", async t => {
    let blocked = false;
    const ready = Promise.withResolvers(), release = Promise.withResolvers();
    const app = await setup(t, { source: async () => {
        if (blocked) { ready.resolve(); await release.promise; }
        return chatFixture();
    } });
    const frame = await app.reader.scan();
    blocked = true;
    let disclosed = false;
    const publishing = app.reader.publish(frame, () => { disclosed = true; });
    await ready.promise;
    await act(app.lifecycle, "wire-sign-out");
    release.resolve();
    await assert.rejects(publishing, { code: "wire_access_revoked" });
    assert.equal(disclosed, false);
    const invalid = await setup(t);
    const bad = chatFixture();
    delete bad[0].scope.harness;
    invalid.setEnvelopes(bad);
    await assert.rejects(invalid.reader.scan(), error =>
        error.code === "native-read-missing-field" && error.status === 422 && !error.message.includes("invented"));
});

test("unbound legacy snapshot stays GitHub-compatible and native data cannot be enabled with request-shaped input", async t => {
    const { context } = await privateFixture(t, [githubRecord()]);
    const data = await currentStatePayload(context);
    assert.equal(data.scenarios.length, 1);
    assert.equal(Object.hasOwn(data, "nativeRead"), false);
    assert.equal(data.analytics.rows[0].sourceId, "github-copilot");
    assert.equal(data.analytics.label, "Work IQ activity");
    assert.throws(() => validateAnalyticsInput({ nativeSource: chatFixture() }));
    assert.throws(() => buildActivityAnalytics([{ ...data.scenarios[0], recordKind: "native-conversation" }]), { code: "untrusted-native-consumer-record" });
});
