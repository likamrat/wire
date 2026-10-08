import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalytics, normalizeEndpoint, getDrilldown, OUTCOMES } from "../lib/analytics.mjs";
import { renderMarkdownReport, renderHtmlReport } from "../lib/product-report.mjs";

// Every fixture in this file is synthetic test data, never imported into the board.
const call = (id, extras = {}) => ({ tool: "workiq-fetch", toolCallId: id, startEventId: `event-${id}`, toolSucceeded: true, reportedOutcome: "succeeded", requestArgs: { entityUrls: ["/me/messages"] }, apiResults: [], ...extras });
const scenario = (id, calls, extras = {}) => ({ scenarioId: id, sourceSessionId: "test-session", projectId: "test-project", workloadKind: "recorded-history", toolCalls: calls, ...extras });
const projected = (s) => ({ ...s, userPrompt: { exportRepresentation: "technical-summary-not-original", text: "Original withheld. Operation structure: workiq-fetch." } });
const http = (id, extras = {}) => ({ recordId: id, classification: "direct-graph-http", synthetic: false, observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", apiVersion: "v1.0", method: "GET", responsePath: { path: "/$metadata", query: [] }, status: 200, ...extras });
const sum = (row) => OUTCOMES.reduce((n, outcome) => n + row[outcome], 0);
function invariant(a) {
    assert.equal(sum(a.totals), a.totals.count);
    assert.equal(a.rows.length, a.totals.count);
    assert.equal(new Set(a.rows.map((r) => r.id)).size, a.rows.length);
    assert.equal(a.groups.reduce((n, g) => n + g.total, 0), a.totals.count);
    assert.equal(a.visibleGroups.reduce((n, g) => n + g.total, 0) + (a.otherGroup?.total ?? 0), a.totals.count);
    for (const g of a.groups) { assert.equal(sum(g), g.total); assert.equal(getDrilldown(a, g.id).length, g.total); }
    assert.equal(a.totals.successRate.denominator, a.totals.count);
}

test("synthetic: legacy overlap, session+call identity, event fallback and unidentifiable disclosure", () => {
    const records = [
        scenario("legacy", [call("a", { toolSucceeded: false }), call(null, { startEventId: null })], { isLegacy: true }),
        scenario("history", [call("a"), call(null, { startEventId: "event-b" }), call("b", { startEventId: "event-b" }), call(null, { startEventId: "event-c" })]),
        scenario("second-session", [call("a")], { sourceSessionId: "other-test-session" }),
    ];
    const a = buildAnalytics(records, { filters: { scope: "all" } });
    assert.equal(a.totals.count, 4);
    assert.equal(a.totals.success, 4);
    assert.equal(a.exclusions.duplicateRecords, 2);
    assert.equal(a.exclusions.unidentifiable, 1);
    assert.equal(a.exclusions.legacyUnidentifiable, 1);
    assert.equal(a.coverage.sessionCount, 2);
    assert.equal(a.coverage.scenarioCount, 2);
    assert.ok(a.rows.some((r) => r.identityBasis === "source-session-and-start-event"));
    assert.ok(a.warnings.some((w) => w.code === "event-identity-fallback"));
    assert.deepEqual(a.rows.map((r) => r.id), buildAnalytics([...records].reverse().map((s) => ({ ...s, toolCalls: [...s.toolCalls].reverse() })), { filters: { scope: "all" } }).rows.map((r) => r.id));
    invariant(a);
    assert.equal(buildAnalytics(records).exclusions.legacyScenarios, 1);
    assert.equal(buildAnalytics(records, { filters: { scope: "legacy" } }).totals.failure, 1);
});

test("synthetic: multi-target fetch counts once; only returned API units count without invented per-target outcomes", () => {
    const records = [scenario("batch", [call("a", {
        durationMs: 200, requestArgs: { entityUrls: ["/me/messages", "/me/events", "/me/contacts"] },
        requestedApiPath: "/me/messages", apiResults: [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 503 }],
    }), call("b", { toolSucceeded: false, apiResults: [] })])];
    const tools = buildAnalytics(records);
    assert.equal(tools.totals.count, 2);
    assert.equal(tools.groups.find((g) => g.label.includes("Multiple targets")).total, 1);
    const results = buildAnalytics(records, { layer: "reported-api" });
    assert.equal(results.totals.count, 2);
    assert.equal(results.totals.success, 1);
    assert.equal(results.totals.failure, 1);
    assert.equal(results.groups.length, 1);
    assert.equal(results.groups[0].label, "Unattributed reported result (multiple targets)");
    assert.equal(results.totals.duration.sampleCount, 0);
    assert.equal(results.apiCoverage.eligibleToolCalls, 2);
    assert.equal(results.apiCoverage.callsWithNumericStatus, 1);
    assert.equal(results.apiCoverage.callsWithoutNumericStatus, 1);
    invariant(tools); invariant(results);
});

test("synthetic: explicit returned paths and null result metadata are supported, note-only legacy items aren't API units", () => {
    const records = [scenario("a", [call("a", { requestArgs: { entityUrls: ["/me/messages", "/me/events"] }, apiResults: [
        { index: 0, path: "/me/events", statusCode: null },
        { index: 1, statusCode: 202, durationMs: 4 },
        { note: "A tool note is not an API result." },
    ] })])];
    const a = buildAnalytics(records, { layer: "reported-api" });
    assert.equal(a.totals.count, 2);
    assert.equal(a.totals.unknown, 1);
    assert.equal(a.totals.success, 1);
    assert.ok(a.groups.some((g) => g.label === "/me/events"));
    assert.equal(a.totals.duration.sampleCount, 1);
    invariant(a);
});

test("synthetic: assessments/review don't change runtime outcome; unknown completion is retained", () => {
    const records = [scenario("s", [
        call("a"),
        call("b", { toolSucceeded: false, reportedOutcome: "failed" }),
        call("c", { toolSucceeded: null, reportedOutcome: "unknown" }),
        call("d", { toolSucceeded: null, reportedOutcome: "partial" }),
    ], { workflowState: "exported", assessedFinding: "discovery-relevance-mismatch", taskCorrectness: "failed" })];
    const a = buildAnalytics(records);
    assert.deepEqual(OUTCOMES.map((o) => a.totals[o]), [1, 1, 1, 1, 0, 0]);
    assert.equal(a.totals.successRate.percent, 25);
    invariant(a);
});

test("synthetic: HTTP is explicit, unique and separate; 202 success, redirects other, transport no fake status", () => {
    const records = [scenario("h", [call("not-http", { observedGraphHttp: true, apiResults: [{ index: 0, statusCode: 200 }] }), { tool: "owned-graph-http" }], {
        httpRecords: [
            http("a"), http("a"), http("b", { status: 202 }), http("c", { status: 404 }),
            http("d", { status: 503 }), http("e", { status: 302 }),
            http("f", { observedGraphHttp: false, status: null, responseOrigin: null, transportError: "TimeoutError" }),
            http("g", { observedGraphHttp: false, status: null, responseOrigin: null, transportError: null }),
            http("fixture", { classification: "synthetic-http-fixture", synthetic: true }),
            http("import", { classification: "imported-graph-http" }),
            http("unverified", { observedGraphHttp: false }),
        ],
    })];
    const a = buildAnalytics(records, { layer: "http" });
    assert.equal(buildAnalytics(records).totals.count, 1);
    assert.equal(a.totals.count, 7);
    assert.deepEqual(OUTCOMES.map((o) => a.totals[o]), [2, 2, 1, 0, 1, 1]);
    assert.equal(a.exclusions.synthetic, 1);
    assert.equal(a.exclusions.unverifiedHttp, 2);
    assert.equal(a.rows.find((r) => r.recordId === "f").status, null);
    assert.deepEqual(a.httpCoverage, { observedResponseCount: 5, noResponseRecordCount: 2 });
    assert.ok(a.groups[0].label.includes("GET v1.0 /$metadata"));
    assert.equal(a.coverage.sessionCount, 1);
    invariant(a);
    assert.equal(buildAnalytics([scenario("not-http", [call("a", { observedGraphHttp: true })])], { layer: "http" }).totals.count, 0);
});

test("synthetic: endpoint templates withhold IDs/query literals while preserving methods, versions and operations", () => {
    const inputs = [
        "/users/alice@private.example/messages/secret-message-id/attachments/attachment-secret/$value?$filter=subject%20eq%20'PRIVATE'&$select=id,subject",
        "https://graph.microsoft.com/beta/users/01234567-89ab-cdef-0123-456789abcdef/messages?$search=PRIVATE",
        "/users('private-user')/messages('private-message')/microsoft.graph.reply",
        "/me/drive/root:/private/customer/plan.docx:/children",
        "/me/drive/root/search(q='PRIVATE')",
        "/me/messages/delta()?$deltatoken=PRIVATE",
        "/teams/private-team/channels/private-channel/messages/private-message/replies",
        "/me/calendar/getSchedule",
    ];
    const output = inputs.map((v) => normalizeEndpoint(v));
    assert.equal(output[0].path, "/users/{id}/messages/{id}/attachments/{id}/$value");
    assert.deepEqual(output[0].queryShape, ["$filter", "$select"]);
    assert.equal(output[1].apiVersion, "beta");
    assert.equal(output[2].path, "/users/{id}/messages/{id}/microsoft.graph.reply");
    assert.equal(output[3].path, "/me/drive/root/{path}/children");
    assert.equal(output[4].path, "/me/drive/root/search(q={value})");
    assert.equal(output[5].path, "/me/messages/delta()");
    assert.equal(output[6].path, "/teams/{id}/channels/{id}/messages/{id}/replies");
    assert.equal(output[7].path, "/me/calendar/getSchedule");
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE|alice|secret|private|plan\.docx/);
    assert.notEqual(normalizeEndpoint("/me/messages", { method: "GET" }).id, normalizeEndpoint("/me/messages", { method: "POST" }).id);
    assert.notEqual(normalizeEndpoint("/v1.0/me/messages").id, normalizeEndpoint("/beta/me/messages").id);
    assert.equal(normalizeEndpoint("/users/messages/messages").path, "/users/{id}/messages");
    assert.equal(normalizeEndpoint("/me/messages").id, normalizeEndpoint({ path: "/me/messages", query: [{ key: "$top", value: "PRIVATE" }] }).id);
    assert.equal(normalizeEndpoint("https://private.example/secret").path, "[endpoint unavailable]");
    assert.equal(normalizeEndpoint("//private/path").path, "[endpoint unavailable]");
    assert.doesNotMatch(JSON.stringify(normalizeEndpoint("/me/%ZZ?private-key=PRIVATE")), /PRIVATE|private-key/);
});

test("synthetic: retrieval/ask no-endpoint groups never invent API path or HTTP method", () => {
    const a = buildAnalytics([scenario("s", [
        call("a", { tool: "workiq-ask", requestedApiPath: null, requestArgs: { question: "PRIVATE_PROMPT" } }),
        call("b", { tool: "workiq-retrieve", requestedApiPath: null, requestArgs: { query: ["PRIVATE_PROMPT"] } }),
        call("c"),
    ])]);
    assert.equal(a.groups.length, 3);
    assert.equal(a.rows.filter((r) => r.endpoint.path === null).length, 2);
    assert.ok(a.rows.every((r) => r.endpoint.method === null));
    assert.doesNotMatch(JSON.stringify(a), /PRIVATE_PROMPT/);
    invariant(a);
});

test("synthetic: bounded groups preserve Other counts, stable drilldown IDs and percentages", () => {
    const records = [scenario("s", [
        call("a"), call("b"), call("c", { requestArgs: { entityUrls: ["/me/events"] } }),
        call("d", { requestArgs: { entityUrls: ["/me/contacts"] }, toolSucceeded: false }),
    ])];
    const a = buildAnalytics(records, { limit: 1 });
    assert.equal(a.visibleGroups[0].total, 2);
    assert.equal(a.otherGroup.total, 2);
    assert.equal(a.otherGroup.groupCount, 2);
    assert.equal(getDrilldown(a, "group:other").length, 2);
    assert.equal(a.visibleGroups[0].sharePercent, 50);
    assert.deepEqual(buildAnalytics([...records].reverse()).rows.map((r) => r.id), a.rows.map((r) => r.id));
    assert.throws(() => getDrilldown(a, "unknown"), RangeError);
    invariant(a);
});

test("synthetic: duration samples exclude missing/negative; nearest-rank quantiles are explicit", () => {
    const a = buildAnalytics([scenario("s", [call("a", { durationMs: 10 }), call("b", { durationMs: 50 }), call("c", { durationMs: null }), call("d", { durationMs: -1 }), call("e", { durationMs: 100 })])]);
    assert.equal(a.totals.duration.sampleCount, 3);
    assert.equal(a.totals.duration.p50Ms, 50);
    assert.equal(a.totals.duration.p95Ms, 100);
});

test("synthetic: source/project/date/endpoint/outcome/tool/scope filters retain exact denominators", () => {
    const records = [
        scenario("s1", [call("a", { startedAt: "2026-09-01T00:00:00Z" }), call("b", { startedAt: "2026-09-02T00:00:00Z", toolSucceeded: false })]),
        scenario("s2", [call("c"), call("d", { startedAt: "2026-09-03T00:00:00Z" })], { sourceSessionId: "s2", projectId: null }),
        scenario("s3", [call("legacy")], { isLegacy: true }),
    ];
    for (const filters of [
        { from: "2026-09-02", to: "2026-09-03" },
        { sourceSessionIds: ["test-session"], outcomes: ["failure"] },
        { projectIds: [null] },
        { tools: ["workiq-fetch"], endpoints: [normalizeEndpoint("/me/messages").id] },
        { scope: "legacy" },
    ]) invariant(buildAnalytics(records, { filters }));
    const a = buildAnalytics(records, { filters: { from: "2026-09-02", to: "2026-09-03" } });
    assert.equal(a.totals.count, 2);
    assert.equal(a.exclusions.missingFilterDate, 1);
    assert.equal(a.coverage.sessionCount, 2);
    assert.ok(a.warnings.some((w) => w.code === "dates-unavailable"));
    assert.equal(buildAnalytics(records).totals.count, 4);
    assert.equal(buildAnalytics(records, { filters: { scope: "all" } }).totals.count, 5);
});

test("synthetic: empty state and invalid options", () => {
    for (const layer of ["tool", "reported-api", "http"]) {
        const a = buildAnalytics([], { layer });
        invariant(a);
        assert.equal(a.totals.successRate.percent, null);
        assert.equal(a.totals.duration.p50Ms, null);
        assert.equal(a.coverage.sessionCount, 0);
        assert.equal(a.otherGroup, null);
    }
    for (const options of [{ layer: "graph" }, { groupBy: "secret" }, { limit: 0 }, { filters: { from: "bad" } }, { filters: { outcomes: ["reviewed"] } }]) assert.throws(() => buildAnalytics([], options), TypeError);
});

test("synthetic: sample fixtures are excluded from real totals", () => {
    const a = buildAnalytics([scenario("fixture", [call("a")], { sample: true }), scenario("current", [call("b")])]);
    assert.equal(a.totals.count, 1);
    assert.equal(a.exclusions.synthetic, 1);
});

test("synthetic: projected path objects preserve aggregate parity with canonical string paths", () => {
    const raw = scenario("s", [call("a", { requestArgs: { entityUrls: ["/me/messages?$top=12&$filter=PRIVATE"] }, apiResults: [{ index: 0, statusCode: 200 }] })]);
    const safe = projected(scenario("s", [call("a", { requestArgs: { entityUrls: [{ path: "/me/messages", query: [{ key: "$top" }, { key: "$filter" }] }] }, apiResults: [{ index: 0, statusCode: 200 }] })]));
    for (const layer of ["tool", "reported-api"]) {
        const a = buildAnalytics([raw], { layer });
        const b = buildAnalytics([safe], { layer });
        assert.deepEqual(a.totals, b.totals);
        assert.deepEqual(a.groups, b.groups);
    }
});

test("synthetic: reports use sanitized projection only, escape markup and never serialize side fields", () => {
    const unsafe = scenario("s", [call("a")], { userPrompt: { text: "PRIVATE" } });
    assert.throws(() => renderMarkdownReport([unsafe]), /sanitized projection/);
    const safe = projected(scenario("scenario-safe", [call("a")], { title: "PRIVATE_SIDE_TITLE", coverageNote: "PRIVATE_SIDE_NOTE", sideNotes: "PRIVATE_SIDE_NOTE", followUpPrompts: [{ text: "PRIVATE_FOLLOWUP" }] }));
    safe.userPrompt.text = `Original withheld. Operation structure: <img src=x onerror="alert(1)"> **bold** [link](javascript:alert(1)).`;
    const html = renderHtmlReport([safe]);
    const md = renderMarkdownReport([safe]);
    assert.doesNotMatch(html, /<img|<script|PRIVATE_SIDE|PRIVATE_FOLLOWUP/);
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(md.includes("\\*\\*bold\\*\\*"));
    assert.doesNotMatch(md, /PRIVATE_SIDE|PRIVATE_FOLLOWUP|```json|toolCallId|requestArgs/);
    assert.ok(md.includes("1 Work IQ tool call"));
    assert.ok(html.includes("1 Work IQ tool call"));
    assert.ok(html.includes('scope="col"'));
    assert.ok(html.includes('role="img"'));
    assert.ok(html.includes("Content-Security-Policy"));
    assert.doesNotMatch(html, /src=["']https:|@import|<script/);
});

test("synthetic: report inventory includes selected legacy and uses all-scope metric exclusions", () => {
    const records = [
        projected(scenario("current", [call("a")])),
        projected(scenario("legacy", [call("a"), call(null, { startEventId: null })], { isLegacy: true })),
    ];
    const md = renderMarkdownReport(records);
    assert.ok(md.includes("Selected export inventory: 2 scenario records, including 1 legacy records"));
    assert.ok(md.includes("1 Work IQ tool call"));
    assert.ok(md.includes("Records without source chat"));
    assert.ok(md.includes("Overlapping call records"));
});

test("synthetic: report charts use absolute front heights, not per-category normalization", () => {
    const records = [projected(scenario("s", [call("a"), call("b"), call("c", { requestArgs: { entityUrls: ["/me/events"] } })]))];
    const html = renderHtmlReport(records);
    const columns = [...html.matchAll(/data-total="(\d+)" data-maximum="(\d+)" data-front-height="([\d.]+)"/g)]
        .map(([, total, maximum, height]) => ({ total: Number(total), maximum: Number(maximum), height: Number(height) }));
    assert.ok(columns.some(column => column.total === 2 && column.maximum === 2 && column.height === 200));
    assert.ok(columns.some(column => column.total === 1 && column.maximum === 2 && column.height === 100));
    for (const column of columns) assert.equal(column.height, column.total / column.maximum * 200);
    assert.ok(renderMarkdownReport([]).includes("No qualifying records in this layer."));
});

test("synthetic: privacy summary uses category counts only, never category names or arbitrary audit strings", () => {
    const options = { privacy: { categories: { PRIVATE_CATEGORY: 2, other: 3 }, reviewerConfirmed: false, inputFingerprint: "PRIVATE_FINGERPRINT", note: "PRIVATE_NOTE" } };
    const md = renderMarkdownReport([], options);
    assert.ok(md.includes("5 category matches across 2 categories"));
    assert.ok(md.includes("required before writing"));
    assert.doesNotMatch(md, /PRIVATE_/);
    assert.throws(() => renderHtmlReport([], { privacy: { categories: { bad: "PRIVATE_VALUE" } } }), TypeError);
});
