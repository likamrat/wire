import test from "node:test";
import assert from "node:assert/strict";
import { extractScenarios } from "../lib/history.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { chatCopy } from "../lib/chat-copy.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createPeriodFlow } from "../web/period-flow.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { time } from "../lib/time.mjs";
import { fixture } from "./helpers.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const results = createRecordedResults();
const context = time.normalize({ timeZone: "UTC", locale: "en-US" });
const describe = analytics => createPeriodFlow(time)({
    rows: analytics.rows, layer: analytics.layer, unit: results.unit(analytics.layer, analytics.rows.length),
    filters: {}, coverage: {}, timeContext: context,
});
export function countedRecords() {
    const records = [];
    for (const [source, sizes] of [["single", [3]], ["six", [3, 3, 2, 2, 2, 2]]]) for (const [index, size] of sizes.entries()) {
        const record = fixture(`${source}-${index}`);
        record.sourceSessionId = source;
        record.sourceSessionName = source === "single" ? "Original Session example" : "Original six-group example";
        record.userPrompt.text = `Invented request ${source} ${index}`;
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: size }, (_, i) => ({
            ...structuredClone(record.toolCalls[0]), toolCallId: `${source}-${index}-${i}`, startEventId: `start-${source}-${index}-${i}`,
            startedAt: "2026-09-30T12:00:00Z",
            toolSucceeded: !(source === "six" && index === 5), reportedOutcome: source === "six" && index === 5 ? "failed" : "succeeded",
        }));
        records.push(record);
    }
    return records;
}

test("canonical one-to-many examples keep exact owners, calls and call results", () => {
    const records = countedRecords(), before = structuredClone(records);
    for (const [id, groups, calls, success, failure] of [["single", 1, 3, 3, 0], ["six", 6, 14, 12, 2]]) {
        const a = buildActivityAnalytics(records, { filters: { sourceSessionIds: [id] } });
        assert.equal(a.coverage.scenarioCount, groups);
        assert.equal(a.totals.count, calls);
        assert.equal(a.totals.success, success);
        assert.equal(a.totals.failure, failure);
        const text = chatCopy.relationship(groups, calls, results.unit("tool", calls));
        assert.equal(text, `${groups} request group${groups === 1 ? "" : "s"} with ${calls} Work IQ tool calls`);
        assert.ok(describe(a).summary.includes(text));
        assert.deepEqual(results.entries("tool", a.totals).map(({ key, count }) => [key, count]), failure ? [["success", success], ["failure", failure]] : [["success", success]]);
    }
    assert.deepEqual(records, before, "Presentation does not rewrite source names, prompts or evidence");
});

test("zero/one/many counts, missing sources and unavailable counts remain distinct", () => {
    for (const n of [0, 1, 6]) {
        assert.equal(chatCopy.count(n), `${n} Copilot chat${n === 1 ? "" : "s"}`);
        assert.equal(chatCopy.relationship(n, n, results.unit("tool", n)), `${n} request group${n === 1 ? "" : "s"} with ${n} Work IQ tool call${n === 1 ? "" : "s"}`);
        assert.equal(results.countLabel("tool", n, 6), `${n} of 6 Work IQ tool calls ${n === 1 ? "matches" : "match"} this view`);
    }
    assert.match(chatCopy.relationship(undefined, 1, "Work IQ tool call"), /unavailable/);
    const missing = describe({ layer: "tool", rows: [{ id: "one", scenarioId: "unknown", sourceSessionId: null }] });
    assert.match(missing.summary, /0 Copilot chats/);
    assert.match(missing.summary, /1 record has no source identity/);
});

test("nearest-message groups retain follow-up context without counting it twice; missing origin remains unverified", () => {
    const stamp = "2026-09-30T12:00:00Z";
    const message = id => ({ type: "user.message", id, timestamp: stamp, data: { content: `Original ${id} Session text` } });
    const call = id => ({ type: "tool.execution_start", id: `start-${id}`, timestamp: stamp, data: { toolName: "workiq-fetch", toolCallId: id, arguments: { entityUrls: ["/me/calendar", "/me/messages", "/me/drive"] } } });
    const events = [call("orphan"), message("origin"), call("first"), call("second"), message("followup"), call("third"), message("context-only")];
    const before = structuredClone(events);
    const { scenarios } = extractScenarios(events, { sessionId: "source", name: "Original Session name" }, stamp, stamp);
    assert.equal(scenarios.length, 3);
    assert.equal(scenarios[0].userPrompt.status, "unavailable");
    assert.match(scenarios[0].scenarioId, /start-orphan$/);
    assert.equal(scenarios[1].toolCalls.length, 2);
    assert.equal(scenarios[1].followUpPrompts[0].sourceEventId, "followup");
    assert.equal(scenarios[2].followUpPrompts[0].sourceEventId, "context-only");
    const a = buildActivityAnalytics(scenarios);
    assert.equal(a.totals.count, 4, "Each multi-target invocation counts once");
    assert.ok(a.rows.every(row => row.targetCount === 3 && row.workload === "Multiple workloads"));
    assert.equal(describe(a).requests, 3);
    assert.deepEqual(events, before);
});

test("filters narrow both group and call counts while full request and report scopes stay larger", () => {
    const records = countedRecords(), before = structuredClone(records);
    records[0].toolCalls[0].requestArgs = { entityUrls: ["/me/calendar", "/me/messages"] };
    const mixed = buildActivityAnalytics(records, { filters: { sourceSessionIds: ["single"] } });
    assert.equal(mixed.totals.count, 3);
    const failed = buildActivityAnalytics(records, { filters: { sourceSessionIds: ["six"], outcomes: ["failure"] } });
    assert.equal(describe(failed).requests, 1);
    assert.match(describe(failed).summary, /1 request group with 2 Work IQ tool calls/);
    const calendar = buildActivityAnalytics(records, { filters: { sourceSessionIds: ["single"], workloads: ["Calendar"] } });
    assert.equal(calendar.coverage.scenarioCount, 1);
    assert.equal(calendar.totals.count, 2);
    const full = buildRequestActivity(records);
    assert.equal(full.tool.filter(row => row.scenarioId === "single-0").length, 3);
    const scope = createReportScope(), catalog = buildExportCatalog(records);
    const selected = scope.resolve(catalog, "current", ["single-0"], []);
    assert.match(scope.summary(selected), /^1 request group: 3 Work IQ tool calls/);
    assert.equal(selected.requests.length, 1);
    assert.equal(before[0].sourceSessionName, records[0].sourceSessionName);
});

test("API-result, Graph-site, visible-status, code-reference and recorder units are not tool calls", () => {
    const row = fixture("units");
    row.toolCalls[0].apiResults = [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 403 }, { index: 2 }];
    const reported = buildActivityAnalytics([row], { layer: "reported-api" });
    assert.equal(reported.totals.count, 3);
    assert.match(describe(reported).summary, /1 request group with 3 tool-returned API results/);
    assert.equal(buildActivityAnalytics([row]).totals.count, 1);
    const events = [
        { id: "prompt", type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "Invented Graph-only group" } },
        { id: "start", type: "tool.execution_start", timestamp: "2026-09-30T12:00:01Z", data: { toolName: "powershell", toolCallId: "graph-call", arguments: { command: 'curl https://graph.microsoft.com/v1.0/me/messages' } } },
        { id: "end", type: "tool.execution_complete", timestamp: "2026-09-30T12:00:02Z", data: { toolCallId: "graph-call", result: { content: "HTTP/1.1 200" } } },
    ];
    const graph = extractGraphActivities(events, { sessionId: "graph-source" }).scenarios;
    for (const [layer, unit] of [["direct-request", "recorded Graph request site"], ["recorded-http", "Graph request site with visible status"]]) {
        const a = buildActivityAnalytics(graph, { layer });
        assert.equal(a.totals.count, 1);
        assert.ok(describe(a).summary.includes(`1 request group with 1 ${unit}`));
    }
    assert.equal(results.unit("code-reference", 0), "Graph code references");
    const recorder = describe({ layer: "http", rows: [{ id: "http", scenarioId: "diagnostic", sourceSessionId: "owned-recorder" }] });
    assert.match(recorder.summary, /1 recorder source identity \/ 1 record group with 1 owned HTTP record/);
    assert.doesNotMatch(recorder.summary, /Copilot chat|Work IQ|API request/);
});

test("new human reports and JSON summary share frozen six-group/fourteen-call truth without changing technical fields", { timeout: 60000 }, async () => {
    const records = countedRecords().filter(row => row.sourceSessionId === "six"), before = structuredClone(records);
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), {
        promptMode: "none", formats: ["html", "pdf", "markdown", "json"], timeContext: context,
    });
    const snapshot = JSON.parse(bundle.files["product-report.json"]);
    assert.equal(snapshot.schemaVersion, 3);
    assert.equal(snapshot.summary.metrics.find(row => row.layer === "tool").count, 14);
    assert.equal(snapshot.summary.metrics.find(row => row.layer === "tool").outcomes.success, 12);
    assert.equal(snapshot.summary.metrics.find(row => row.layer === "tool").outcomes.failure, 2);
    assert.equal(snapshot.coverage.distinctSourceSessions, 1);
    assert.ok(snapshot.records.every(row => row.sourceSessionId && row.scenarioId && !Object.hasOwn(row, "sourceChatId")));
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const pdf = await task.promise, pages = [];
    try {
        for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map(item => item.str || "").join(" "));
    } finally { await task.destroy(); }
    for (const text of [bundle.files["product-report.html"], bundle.files["product-report.md"], snapshot.summary.takeaways.join(" "), pages.join(" ").replace(/\s+/g, " ")]) {
        assert.match(text, /6 request groups with 14 Work IQ tool calls/);
        assert.match(text, /12 of 14 Work IQ calls succeeded; 2 failed/);
        assert.doesNotMatch(text, /14 (?:Graph API requests|Work IQ MCP requests)/);
    }
    assert.deepEqual(records, before);
    if (process.env.WORKIQ_COUNT_PROOFS) {
        const dir = path.join(process.env.WORKIQ_COUNT_PROOFS, "reports");
        await mkdir(dir, { recursive: true });
        for (const [name, bytes] of Object.entries(bundle.files)) await writeFile(path.join(dir, name), bytes);
    }
});
