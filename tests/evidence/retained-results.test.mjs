import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../../lib/collector.mjs";
import { completeWorkIqCall, extractScenarios, qualifiedResultPaths } from "../../lib/history.mjs";
import { createRecordedResults } from "../../web/recorded-results.mjs";
import { buildActivityAnalytics } from "../../lib/activity-analytics.mjs";
import { fixture, privateFixture } from "../support/helpers.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../../lib/store.mjs";
import { buildSanitizedRecord } from "../../lib/export.mjs";
import { projectReportResults } from "../../lib/report-result-projection.mjs";

function retainedCall(result, success = true) {
    const raw = { id: "completion", type: "tool.execution_complete", timestamp: "2026-10-29T12:00:01.000Z",
        data: { toolCallId: "result-call", success, result } };
    const retained = retainEvent(raw, { credentialExclusions: 0 });
    const call = completeWorkIqCall({ ...fixture().toolCalls[0], toolCallId: "result-call", startedAt: "2026-10-29T12:00:00.000Z" },
        JSON.parse(JSON.stringify(retained)));
    return { call, retained };
}

test("documented Ask answers have no service trace; a qualified returned member keeps only its own path", async t => {
    const events = [];
    const add = (type, data) => { const e = { id: `event-${events.length}`, type, data,
        timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, events.length)).toISOString() }; events.push(e); return e; };
    add("user.message", { content: "Invented workshop question." });
    add("tool.execution_start", { toolCallId: "ask", toolName: "workiq-ask", arguments: { question: "Which meeting?",
        capabilities: [{ name: "Meetings" }], fileUrls: ["https://example.invalid/input"], resources: [{ message: { id: "reference" } }] } });
    add("tool.execution_complete", { toolCallId: "ask", success: true, result: { content: [{ type: "text", text: "Mail and Teams" }],
        structuredContent: { answer: "EXCLUDED_ANSWER: see mail citation", conversationId: "EXCLUDED_CONVERSATION" } } });
    const start = add("tool.execution_start", { toolCallId: "read", toolName: "workiq-fetch",
        arguments: { entityUrls: ["/me/messages", "/me/events"] } });
    const end = add("tool.execution_complete", { toolCallId: "read", success: true, result: { structuredContent: { results: [
        { statusCode: 200, path: "/me/events/PRIVATE-EVENT?$filter=PRIVATE-VALUE", body: "EXCLUDED_BODY" },
        { statusCode: 403, body: { path: "/me/messages" } },
    ] } } });
    const resultPaths = qualifiedResultPaths([end], [start]);
    assert.ok(resultPaths.has(end));
    for (const prior of [[], [start, start], [{ ...start, data: { ...start.data, toolName: "unrelated" } }]])
        assert.equal(qualifiedResultPaths([end], prior).size, 0);
    const compact = events.map(e => retainEvent(e, { credentialExclusions: 0 }, { resultPaths }));
    assert.doesNotMatch(JSON.stringify(compact), /PRIVATE-EVENT|PRIVATE-VALUE|EXCLUDED_(ANSWER|BODY|CONVERSATION)/);
    const records = extractScenarios(compact, { sessionId: "fixture-session" }, "2026-10-01", "2026-10-02").scenarios;
    const { context } = await privateFixture(t, records);
    const saved = mergeEvidenceWithState(await loadBoardState(context));
    const [ask, fetch] = buildActivityAnalytics(saved).rows;
    assert.deepEqual(ask.serviceAssociation.services, []);
    assert.equal(ask.serviceAssociation.gaps[0].reason, "hosted-routing");
    assert.deepEqual(fetch.serviceAssociation.services, ["Mail", "Calendar"]);
    const results = buildActivityAnalytics(saved, { layer: "reported-api" }).rows;
    assert.deepEqual(results.map(r => [r.toolCallId, r.status, r.endpoint.path, r.serviceAssociation.services]), [
        ["read", 200, "/me/events/{id}", ["Calendar"]], ["read", 403, null, []],
    ]);
    assert.equal(results[1].serviceAssociation.gaps[0].reason, "unattributed-result");
    for (const result of [
        { content: JSON.stringify({ results: [{ statusCode: 200, path: "/me/messages" }] }) },
        { structuredContent: { answer: "Example", results: [{ statusCode: 200, path: "/me/messages" }] } },
        { structuredContent: { results: [{ path: "/me/messages" }] } },
    ]) {
        const event = { ...end, data: { ...end.data, result } };
        const retained = retainEvent(event, {}, { resultPaths: qualifiedResultPaths([event], [start]) });
        assert.ok(retained.data.result.structuredContent.results.every(r => !Object.hasOwn(r, "path")),
            "Text, answer context and members without a returned status do not supply an attributed path.");
    }
});

test("source completion, partial capture, mixed API statuses and HTTP 206 keep separate outcome meanings", () => {
    const partialError = { id: "partial-content-end", type: "tool.execution_complete", timestamp: "2026-10-29T12:00:01.000Z",
        data: { toolCallId: "result-call", success: false, error: {
            code: "failure", message: `MCP server 'workiq': {"results":[{"statusCode":403,"error":{"code":"AccessDenied"}},`,
        } } };
    const prefix = completeWorkIqCall({ ...fixture().toolCalls[0], toolCallId: "result-call", startedAt: "2026-10-29T12:00:00.000Z" },
        JSON.parse(JSON.stringify(retainEvent(partialError, { credentialExclusions: 0 }))));
    assert.equal(prefix.resultEvidence.contentStatus, "partial");
    const cases = [
        [retainedCall({ structuredContent: { statusCode: 206 } }).call, "success", "succeeded"],
        [retainedCall({ structuredContent: { results: [{ statusCode: 200 }, { statusCode: 403 }] } }).call, "success", "succeeded"],
        [prefix, "failure", "failed"],
        [retainedCall({ isError: true, content: "Recorded application error." }, null).call, "unknown", "unknown"],
        [retainedCall({ structuredContent: { statusCode: 200 }, content: '{"statusCode":403}' }).call, "success", "succeeded"],
        [completeWorkIqCall({ ...fixture().toolCalls[0], startedAt: "2026-10-29T12:00:00.000Z" }, undefined), "unknown", "unknown"],
        [{ ...fixture().toolCalls[0], toolSucceeded: null, reportedOutcome: "partial" }, "partial", "partial"],
    ];
    for (const [call, outcome, completion] of cases) {
        const record = fixture(); record.toolCalls = [call];
        const before = JSON.stringify(record), analytics = buildActivityAnalytics([record]);
        assert.equal(analytics.rows[0].outcome, outcome);
        assert.equal(buildActivityAnalytics([record], { filters: { outcomes: [outcome] } }).rows.length, 1);
        assert.equal(analytics.totals.partial, outcome === "partial" ? 1 : 0);
        assert.equal(projectReportResults([record], "a".repeat(64)).facts.calls[0].completion, completion);
        assert.equal(JSON.stringify(record), before);
    }
    const suppliedPartial = retainedCall({ structuredContent: { results: [{ statusCode: 206 }] } }).call;
    const returned = buildActivityAnalytics([{ ...fixture(), toolCalls: [suppliedPartial] }], { layer: "reported-api" });
    assert.equal(returned.totals.success, 1);
    assert.equal(returned.totals.partial, 0, "HTTP Partial Content is a 2xx returned status, not partial tool execution");
});

test("single successful status survives without inventing returned entries or task success", async t => {
    const { call } = retainedCall({ structuredContent: { statusCode: 204, data: null } });
    assert.equal(call.resultEvidence?.statusCode, 204);
    assert.equal(call.resultEvidence.contentStatus, "explicit-null");
    assert.equal(call.resultEvidence.applicationError, null);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.toolSucceeded, true);
    const record = fixture(); record.toolCalls = [call];
    const { context } = await privateFixture(t, [record]);
    assert.deepEqual(mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0].resultEvidence, call.resultEvidence);
    assert.match(JSON.stringify(createRecordedResults().resultDetails(call.resultEvidence)), /204/);
    assert.equal(Object.hasOwn(buildSanitizedRecord(record, "a".repeat(64)).toolCalls[0], "resultEvidence"), false);
});

test("MCP application error remains visible alongside a successful SDK completion", () => {
    const message = "Required scope [Tasks.ReadWrite] is missing.";
    const { call, retained } = retainedCall({ isError: true, content: [{ type: "text", text: message }] });
    assert.equal(call.toolSucceeded, true);
    assert.equal(call.reportedOutcome, "succeeded");
    assert.equal(call.failureEvidence, undefined);
    assert.equal(call.resultEvidence?.applicationError, true);
    assert.equal(call.resultEvidence.diagnostic.message, message);
    assert.match(JSON.stringify(retained), /Tasks.ReadWrite/);
    const record = fixture(); record.toolCalls = [call];
    const analytics = buildActivityAnalytics([record], { filters: { scope: "all", outcomes: ["success"] } });
    assert.equal(analytics.rows.length, 1, "The existing SDK-completion filter denominator must not be reclassified");
    const summary = createRecordedResults({ screen: true }).activitySummary("tool", analytics.rows, () => call);
    assert.match(summary.reasons[0].reason, /application error/);
});

test("mixed members retain their own diagnostics and bounded cardinality, never a parent verdict", () => {
    const { call, retained } = retainedCall({ structuredContent: { results: [
        { statusCode: 200, body: { message: "EXCLUDED_BODY" } },
        { statusCode: 403, error: { code: "Denied", message: "This returned member was denied." } },
    ] } });
    assert.equal(call.toolSucceeded, true);
    assert.equal(call.resultEvidence?.resultCount, 2);
    assert.equal(call.resultEvidence.applicationError, null);
    assert.deepEqual(call.apiResults.map(value => value.statusCode), [200, 403]);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_BODY/);
    const bounded = retainedCall({ structuredContent: { results: Array.from({ length: 102 }, () => ({ statusCode: 200 })) } }).call;
    assert.equal(bounded.resultEvidence.resultCount, 102);
    assert.equal(bounded.apiResults.length, 100);
    assert.match(JSON.stringify(createRecordedResults().resultDetails(bounded.resultEvidence, { retainedResultCount: 100 })), /102 supplied; 100 retained/);
});

test("empty or sentinel-only diagnostics produce truthful details, never a blank replacement", () => {
    const results = createRecordedResults();
    for (const diagnostic of [
        { version: 1, source: "completion-error", status: "not-supplied" },
        { version: 1, source: "completion-error", status: "recorded", code: "failure" },
    ]) assert.match(JSON.stringify(results.diagnosticDetails(diagnostic)), /did not supply|generic failure marker/);
});

test("successful collection-body metadata does not turn envelope entries into business-item counts", () => {
    const { call, retained } = retainedCall({ structuredContent: { results: [{ statusCode: 200, body: {
        value: [{ name: "EXCLUDED_FIRST_ITEM" }, { name: "EXCLUDED_SECOND_ITEM" }],
        "@odata.count": 91, "@odata.nextLink": "https://example.invalid/EXCLUDED_NEXT_PAGE",
    } }] } });
    assert.equal(call.resultEvidence.statusCode, null, "A member status is not promoted to its parent");
    assert.equal(call.apiResults[0].statusCode, 200);
    assert.equal(call.apiResults[0].paginationPresent, true);
    assert.equal(call.resultEvidence.resultCount, 1, "This counts one returned response envelope, not two business items or a reported total");
    assert.equal(call.resultEvidence.contentStatus, "body-excluded");
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_|odata.count|itemCount|totalCount/);
});

test("conflicting structured/text statuses and opposite completion flags remain independent", () => {
    const { call } = retainedCall({ structuredContent: { statusCode: 200 }, content: '{"statusCode":403,"body":"EXCLUDED_BODY"}' });
    assert.equal(call.resultEvidence.statusCode, null);
    assert.deepEqual(call.resultEvidence.statusConflict, { structured: 200, text: 403 });
    assert.match(JSON.stringify(createRecordedResults().resultDetails(call.resultEvidence)), /200.*403/);
    assert.equal(call.toolSucceeded, true);
    assert.deepEqual(call.apiResults, []);
    const opposite = retainedCall({ isError: false, content: "" }, false).call;
    assert.equal(opposite.toolSucceeded, false);
    assert.equal(opposite.resultEvidence.applicationError, false);
    assert.equal(opposite.resultEvidence.contentStatus, "recorded-empty");
    const unqualified = completeWorkIqCall({ startedAt: "2026-10-29T12:00:00.000Z" },
        { id: "legacy", timestamp: "2026-10-29T12:00:01.000Z", data: { success: true } });
    assert.equal(Object.hasOwn(unqualified, "resultEvidence"), false, "Legacy compaction is not a source-absence attestation");
    const changed = completeWorkIqCall(call, { id: "different-completion", timestamp: "2026-10-29T12:00:02.000Z",
        data: { success: true, wireFailureEvidence: null, wireResultEvidence: { version: 2 } } });
    assert.equal(changed.resultEvidence, null, "A new unsupported completion cannot silently borrow the previous completion's result facts");
    const unknown = retainedCall({ isError: true, content: "The result reports an error without a completion flag." }, null).call;
    const record = fixture(); record.toolCalls = [unknown];
    const rows = buildActivityAnalytics([record], { filters: { scope: "all", outcomes: ["unknown"] } }).rows;
    assert.equal(rows.length, 1);
    const summary = createRecordedResults({ screen: true }).activitySummary("tool", rows, () => unknown);
    assert.match(summary.reasons[0].reason, /^Completion not recorded;.*application error/);
    assert.equal(summary.outcome, "failure", "Visual attention does not change the canonical unknown completion count");
});
