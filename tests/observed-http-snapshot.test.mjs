import test from "node:test";
import assert from "node:assert/strict";
import { GRAPH_ORIGIN } from "../lib/graph.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

function recordedFixture() {
    const record = fixture("observed-http-snapshot");
    record.toolCalls[0].startedAt = "2026-10-01T12:00:00.000Z";
    // Invented stored evidence, not a network transport or a live capture.
    record.httpRecords = [200, 429].map((status, index) => ({
        recordId: `invented-owned-record-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: true, responseOrigin: GRAPH_ORIGIN, requestedOrigin: GRAPH_ORIGIN,
        responsePath: { path: "/shares/{withheld}/driveItem", query: [{ key: "$select", value: "[withheld literal]" }] },
        requestedPath: { path: "/shares/{withheld}/driveItem", query: [] },
        apiVersion: "v1.0", method: "GET", status, startedAt: "2026-10-01T12:00:00.000Z",
        durationMs: 125 + index, durationBoundary: "request dispatch to response headers",
        correlation: { sessionId: record.sourceSessionId, toolCallId: null },
    }));
    return record;
}
function assertHttp(rows) {
    assert.deepEqual(rows.map(row => [row.recordId, row.status, row.outcome, row.observedGraphHttp]),
        [["invented-owned-record-0", 200, "success", true], ["invented-owned-record-1", 429, "failure", true]]);
    assert.ok(rows.every(row => row.endpoint.path === "/shares/{id}/driveItem" && row.endpoint.apiVersion === "v1.0" && row.workload === "Files"));
    assert.deepEqual(rows.map(row => row.durationMs), [125, 126]);
    assert.ok(rows.every(row => row.startedAt === "2026-10-01T12:00:00.000Z"));
}

test("invented non-synthetic observed HTTP reaches owned analytics without losing targets, statuses or isolation", () => {
    const record = recordedFixture(), before = structuredClone(record);
    const http = buildActivityAnalytics([record], { layer: "http" });
    assert.equal(http.totals.count, 2);
    assertHttp(http.rows);
    assert.deepEqual(http.httpCoverage, { observedResponseCount: 2, noResponseRecordCount: 0 });
    assert.equal(buildActivityAnalytics([record], { layer: "tool" }).totals.count, 1);
    assert.equal(buildActivityAnalytics([record], { layer: "reported-api" }).totals.count, 1);
    assert.deepEqual(record, before);
});

test("ordinary export-catalog construction visits observed HTTP even for a tool-first request group", () => {
    const record = recordedFixture(), before = structuredClone(record);
    const catalog = buildExportCatalog([record]);
    assert.equal(catalog.requests.length, 1);
    assert.deepEqual(catalog.requests[0].counts, {
        workIqActions: 1, returnedApiResults: 1, graphRequestSites: 0, graphVisibleStatuses: 0,
        ownedHttpRecords: 2, graphCodeReferences: 0,
    });
    assert.deepEqual(catalog.records[0].httpRecords, record.httpRecords);
    assert.deepEqual(record, before);
});

test("normal tool-view snapshot includes owned evidence with source readers and providers denied", { timeout: 15000 }, async t => {
    const cleanups = [], record = recordedFixture();
    const { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) }, [record]);
    const invoked = [];
    const denied = name => () => { invoked.push(name); throw Error(`Forbidden test seam: ${name}`); };
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: { readSource: denied("source-reader"), discover: denied("source-discovery"), evaluatorFactory: denied("model-provider") },
    });
    t.after(async () => { await runtime.close(); for (const cleanup of cleanups.reverse()) await cleanup(); assert.deepEqual(invoked, []); });
    const origin = new URL(runtime.url).origin;
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (input, options) => {
        if (new URL(typeof input === "string" ? input : input.url).origin !== origin) throw Error("Only this test's loopback snapshot endpoint is allowed.");
        return nativeFetch(input, options);
    });
    const connect = await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" });
    assert.equal(connect.status, 200);
    headers["X-Board-Capability"] = (await connect.json()).capability;
    const response = await fetch(origin + "/api/snapshot", { method: "POST", headers, body: JSON.stringify({
        layer: "tool", groupBy: "workload", bucket: "month", filters: { scope: "history" },
    }) });
    const snapshot = await response.json();
    assert.equal(response.status, 200, JSON.stringify(snapshot));
    assert.equal(snapshot.analytics.layer, "tool");
    assert.equal(snapshot.analytics.totals.count, 1);
    assert.equal(snapshot.requestActivity.tool.length, 1);
    assert.equal(snapshot.requestActivity["reported-api"].length, 1);
    assert.equal(snapshot.requestActivity.http.length, 2);
    assert.deepEqual(snapshot.requestActivity.http.map(row => [row.status, row.outcome, row.endpoint.path]),
        [[200, "success", "/shares/{id}/driveItem"], [429, "failure", "/shares/{id}/driveItem"]]);
    assert.equal(snapshot.exportCatalog.requests[0].counts.ownedHttpRecords, 2);
    assert.equal(snapshot.exportCatalog.requests[0].counts.workIqActions, 1);
    assert.equal(snapshot.exportCatalog.requests[0].counts.returnedApiResults, 1);
    assert.deepEqual(snapshot.scenarios[0].httpRecords.map(row => [row.recordId, row.status, row.startedAt, row.durationMs]),
        record.httpRecords.map(row => [row.recordId, row.status, row.startedAt, row.durationMs]));
    assert.deepEqual(snapshot.exports, []);
    assert.deepEqual(invoked, []);
});
