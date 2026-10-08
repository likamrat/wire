import test from "node:test";
import assert from "node:assert/strict";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { createReportScope } from "../web/report-scope.mjs";

test("result selections canonicalize OR unions without silently broadening invalid input", () => {
    const results = createRecordedResults();
    assert.deepEqual(results.selection("unknown,success,unknown"), ["success", "unknown"]);
    assert.equal(results.filterValue("unknown,success,unknown"), "success,unknown");
    assert.equal(results.filterValue("failure"), "failure");
    assert.equal(results.filterValue("all"), undefined);
    assert.equal(results.filterValue(["success", "failure", "unknown", "partial", "other", "transport"]), undefined);
    assert.equal(results.filterValue("failure,not-a-result"), "failure,not-a-result");
    assert.equal(results.filterValue(","), ",");
});
test("a mixed request describes matching canonical actions without a request-level verdict", () => {
    const results = createRecordedResults();
    const rows = [
        { id: "call:1", outcome: "success" },
        { id: "call:2", outcome: "failure" },
        { id: "call:3", outcome: "unknown" },
    ];
    const summary = results.summarize([rows[1], rows[1]]);
    assert.deepEqual(summary, { count: 1, success: 0, failure: 1, unknown: 0, partial: 0, other: 0, transport: 0 });
    assert.equal(results.countLabel("tool", summary.count, results.summarize(rows).count), "1 of 3 Work IQ tool calls matches this view");
    assert.deepEqual(results.entries("tool", summary), [{ key: "failure", label: "Tool failed", count: 1, icon: "result-failure" }]);
});

test("pure, unknown, code-only and unavailable results never invent request success", () => {
    const results = createRecordedResults();
    for (const outcome of ["success", "failure", "unknown", "partial", "other", "transport"]) {
        const summary = results.summarize([{ id: "one", outcome }]);
        assert.equal(summary.count, 1);
        assert.equal(results.entries("tool", summary)[0].count, 1);
        assert.equal(results.entries("tool", summary)[0].label, results.labels("tool")[outcome]);
    }
    assert.equal(results.summarize(undefined), null);
    assert.equal(results.summarize([{ id: "missing" }]), null);
    assert.equal(results.entries("tool", { count: 0 }), null);
    assert.match(results.countLabel("tool", 2, null), /full-request count unavailable/);
    assert.deepEqual(results.entries("code-reference", results.summarize([{ id: "ref", outcome: "unknown" }])), [{ key: "unknown", count: 1, label: "Execution not observed", icon: "unobserved" }]);
    assert.equal(results.summarize([{ id: "same", outcome: "success" }, { id: "same", outcome: "failure" }]), null);
    assert.deepEqual(results.entries("tool", results.summarize([])), []);
    for (const layer of results.layers) for (const outcome of ["success", "failure", "transport", "unknown", "partial", "other"]) {
        assert.equal(results.canInspect(layer, outcome), layer !== "code-reference" && ["success", "failure", "transport"].includes(outcome));
    }
    assert.equal(results.canInspect("unavailable", "success"), false);
});

test("report all/current/selected retain full-group results and disclose missing counts", () => {
    const source = fixture("report-mixed"), other = fixture("report-other");
    source.toolCalls.push({ ...structuredClone(source.toolCalls[0]), toolCallId: "failure", startEventId: "failure-start", toolSucceeded: false, apiResults: [] });
    const catalog = buildExportCatalog([source, other]);
    const scopes = createReportScope();
    for (const kind of ["all", "current", "selected"]) {
        const selection = scopes.resolve(catalog, kind, ["report-mixed"], ["report-mixed"]);
        assert.equal(selection.counts.workIqActions, kind === "all" ? 3 : 2);
        const full = selection.requests.find(r => r.scenarioId === "report-mixed").results.tool;
        assert.equal(full.success, 1);
        assert.equal(full.failure, 1);
    }
    delete catalog.requests[0].counts.workIqActions;
    const broken = scopes.resolve(catalog, "all", [], []);
    assert.equal(broken.available, false);
    assert.equal(broken.counts.workIqActions, null);
    assert.match(scopes.summary(broken), /unavailable.*not zero/);
});

test("full-request context uses canonical identities and keeps batched API units separate", () => {
    const source = fixture("mixed");
    const call = source.toolCalls[0];
    source.toolCalls.push({ ...structuredClone(call), toolCallId: "failed", startEventId: "failed-start", toolSucceeded: false, apiResults: [] });
    call.apiResults.push({ index: 1, statusCode: 429 }, { index: 2 });
    const legacy = { ...structuredClone(source), scenarioId: "alias", isLegacy: true };
    const records = [legacy, source];
    const context = buildRequestActivity(records);
    const filtered = buildActivityAnalytics(records, { filters: { scope: "all", outcomes: ["failure"] } });
    assert.equal(filtered.totals.count, 1);
    assert.equal(context.tool.length, 2);
    assert.equal(context["reported-api"].length, 3);
    assert.equal(context.tool[0].scenarioId, "mixed");
    assert.ok(context.tool.every(row => row.scenarioIds.includes("alias")));
    assert.deepEqual(createRecordedResults().summarize(context["reported-api"]), { count: 3, success: 1, failure: 1, unknown: 1, partial: 0, other: 0, transport: 0 });
});

test("literal API paths preserve all retained characters and missing targets without normalization", () => {
    const results = createRecordedResults();
    const path = "/Users/{User-ID}/messages?$filter=subject%20eq%20'\u65e5\u672c\u8a9e'&Case=Keep+This";
    const call = Object.freeze({ requestedApiPath: "/wrong-shortcut", requestArgs: Object.freeze({ entityUrls: Object.freeze([path, { path: "/me/drive/root:/A B:/children?x=<tag>" }, null]) }) });
    assert.deepEqual(results.callPaths(call), [path, "/me/drive/root:/A B:/children?x=<tag>", null]);
    assert.deepEqual(results.callPaths({ requestArgs: { functionUrl: "/me/getSchedule(Time='A')" } }), ["/me/getSchedule(Time='A')"]);
    assert.deepEqual(results.callPaths({}), [null]);
    assert.equal(results.pathText({ label: "/not-a-retained-path" }), null);
    assert.equal(results.pathText("//Keep//Slashes?x=%2F#Fragment"), "//Keep//Slashes?x=%2F#Fragment");
});

test("returned paths follow canonical parent and filtered offset, never source index or first batch target", () => {
    const results = createRecordedResults();
    const record = fixture("returned-paths");
    const call = record.toolCalls[0];
    call.requestArgs.entityUrls = ["/me/messages", "/me/calendar/events"];
    call.apiResults = [null, { unrelated: true }, { index: 99, statusCode: 200, path: "/me/messages?Case=A" }, { index: 99, statusCode: 429, requestedApiPath: "/me/calendar/events?Case=B" }, { index: 0 }];
    const rows = buildRequestActivity([record])["reported-api"];
    assert.deepEqual(rows.map(row => results.returnedPath(call, row)), [
        { path: "/me/messages?Case=A", source: "returned" }, { path: "/me/calendar/events?Case=B", source: "returned" },
        { path: null, source: "unattributed" },
    ]);
    call.requestArgs.entityUrls = ["/me/messages?Exact=%2F"];
    assert.deepEqual(results.returnedPath(call, rows[2]), { path: "/me/messages?Exact=%2F", source: "call" });
    call.requestArgs = {};
    call.requestedApiPath = null;
    assert.deepEqual(results.returnedPath(call, rows[2]), { path: null, source: "missing" });
});
