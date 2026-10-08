import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { classifyWorkload } from "../lib/graph-history.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { adaptEvaluationReport, freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { discoveryFixture } from "./discovery-fixtures.mjs";

test("collection to category distinguishes path discovery from unavailable service evidence without retaining catalog bodies", () => {
    const events = [
        { id: "p", type: "user.message", timestamp: "2026-10-01T00:00:00.000Z", data: { content: "Invented path discovery." } },
        { id: "s", type: "tool.execution_start", timestamp: "2026-10-01T00:00:01.000Z",
            data: { toolCallId: "invented-discovery", toolName: "workiq-search_paths", mcpToolName: "search_paths", mcpServerName: "workiq", arguments: { query: "example" } } },
        { id: "e", type: "tool.execution_complete", timestamp: "2026-10-01T00:00:02.000Z",
            data: { toolCallId: "invented-discovery", success: true, result: { structuredContent: { paths: [{ path: "/me/messages", operations: ["fetch"] }] } } } },
    ];
    const retained = events.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const { scenarios } = extractScenarios(retained, { sessionId: "11111111-1111-4111-8111-111111111111" }, events[0].timestamp, events[2].timestamp);
    const model = buildActivityAnalytics(scenarios);
    assert.equal(model.rows[0].workload, "Discovery");
    assert.equal(model.rows[0].toolCallId, "invented-discovery");
    assert.equal(model.rows[0].outcome, "success");
    assert.equal(model.totals.count, 1);
    assert.deepEqual(scenarios[0].toolCalls[0].apiResults, []);
    assert.equal(scenarios[0].toolCalls[0].requestedApiPath, null);
    assert.equal(JSON.stringify(scenarios).includes("operations"), false);
});

test("discovery is included and tool-only; filters preserve exact counts and honest unknown/mixed categories", () => {
    const record = discoveryFixture();
    const model = buildActivityAnalytics([record]);
    assert.equal(model.totals.count, 8);
    assert.deepEqual(model.rows.map(row => row.workload), ["Discovery", "Discovery", "Discovery", "Unknown", "Search", "Mail", "Unknown", "Multiple workloads"]);
    assert.deepEqual(model.rows.map(row => row.toolCallId), record.toolCalls.map(call => call.toolCallId));
    assert.deepEqual([model.totals.success, model.totals.failure, model.totals.unknown], [5, 2, 1]);
    assert.equal(model.exclusions.metadataExcluded, 0);
    const selected = buildActivityAnalytics([record], { filters: { services: ["Discovery"] } });
    assert.equal(selected.totals.count, 3);
    assert.deepEqual([selected.totals.success, selected.totals.failure, selected.totals.unknown], [1, 1, 1]);
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Unknown"] } }).totals.count, 2);
    assert.equal(buildActivityAnalytics([record], { filters: { services: ["Discovery"], outcomes: ["partial"] } }).totals.count, 0);
    assert.throws(() => buildActivityAnalytics([record], { layer: "reported-api", filters: { services: ["Discovery"] } }), /only to Work IQ tool calls/);
    assert.equal(classifyWorkload("/me/messages", "workiq-get_schema"), "Mail", "target-only classification does not reinterpret API evidence");
    assert.equal(classifyWorkload("/$metadata"), "Platform metadata");
    assert.equal(classifyWorkload("/$batch"), "Platform metadata");
    assert.equal(classifyWorkload(null, "unrecognized-search_paths"), "Unknown");
    const schema = model.rows.find(row => row.tool === "workiq-get_schema");
    assert.match(schema.endpoint.label, /Schema lookup.*Schema path/);
    assert.equal(buildActivityAnalytics([record], { filters: { endpoints: [schema.endpoint.id] } }).totals.count, 1);
    assert.equal(buildActivityAnalytics([record], { filters: { endpoints: [schema.endpoint.id.slice("schema:".length)] } }).totals.count, 2, "previous normalized-path aliases still include schema and data calls");
});

test("schema arguments do not become returned API targets; explicit returned paths remain separate evidence", () => {
    const record = discoveryFixture();
    record.toolCalls[1].apiResults = [{ index: 0, statusCode: 400 }];
    record.toolCalls[5].apiResults = [{ index: 0, statusCode: 200 }];
    const model = buildActivityAnalytics([record], { layer: "reported-api" });
    assert.equal(model.totals.count, 2);
    assert.equal(model.rows.find(row => row.tool === "workiq-get_schema").workload, "Unknown");
    assert.equal(model.rows.find(row => row.tool === "workiq-get_schema").endpoint.path, null);
    assert.equal(model.rows.find(row => row.tool === "workiq-fetch").workload, "Mail");
    record.toolCalls[1].apiResults[0].path = "/me/events";
    assert.equal(buildActivityAnalytics([record], { layer: "reported-api" }).rows.find(row => row.tool === "workiq-get_schema").workload, "Calendar");
    const calendar = buildActivityAnalytics([record], { layer: "reported-api", filters: { services: ["Calendar"] } });
    assert.equal(calendar.totals.count, 1);
    assert.equal(calendar.apiCoverage.callsWithNumericStatus, 1);
    assert.ok(calendar.apiCoverage.eligibleToolCalls >= calendar.apiCoverage.callsWithNumericStatus);
});

test("purpose definitions distinguish not-applicable discovery from hosted routing and missing paths", () => {
    assert.equal(serviceCategories.describe("Discovery").label, "Discovery");
    assert.equal(serviceCategories.operation("workiq-search_paths").label, "API discovery");
    assert.equal(serviceCategories.operation("workiq-get_schema").pathLabel, "Schema path");
    assert.equal(serviceCategories.operation("workiq-list_agents").label, "Agent discovery");
    assert.equal(serviceCategories.operation("workiq-ask").category, null);
    assert.match(serviceCategories.operation("workiq-ask").description, /not exposed/);
    assert.equal(serviceCategories.operation("unrecognized-search_paths"), null);
});

test("new frozen formats carry discovery semantics and definition version without changing tool outcomes", { timeout: 30000 }, async () => {
    const record = discoveryFixture(), original = structuredClone(record);
    const bundle = await buildSanitizedBundle([record], "b".repeat(64), { formats: ["json", "html", "markdown", "pdf"], promptMode: "none" });
    assert.deepEqual(record, original);
    assert.equal(bundle.snapshot.categoryDefinition.version, 3);
    assert.ok(bundle.snapshot.serviceCategories.some(category => category.id === "Discovery"));
    assert.equal(bundle.snapshot.evaluationFacts.patterns.filter(entry => entry.pattern.display.workload === "Discovery").length, 3);
    assert.equal(JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]).categoryDefinition.version, 3);
    assert.equal(bundle.snapshot.evaluationFacts.patterns.every(entry => entry.pattern.version === 3), true);
    const pdf = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    const document = await pdf.promise;
    let pdfText = "";
    try {
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 });
            for (const item of (await page.getTextContent()).items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, "PDF text fits horizontally");
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, "PDF text fits vertically");
                pdfText += item.str + " ";
            }
        }
    } finally { await pdf.destroy(); }
    for (const text of [bundle.files["product-report.html"], bundle.files["product-report.md"], pdfText]) {
        assert.match(text, /Activity categories/);
        assert.match(text, /API discovery/);
        assert.match(text, /Schema lookup/);
        assert.match(text, /Schema path/);
        assert.match(text, /regrouping, not a change in recorded outcomes/);
    }
    const current = adaptEvaluationReport(bundle.snapshot.evaluationFacts, {
        bundleId: "export-new", snapshotHash: "a".repeat(64), disclosureReviewed: true,
    });
    const oldFacts = structuredClone(bundle.snapshot.evaluationFacts);
    for (const entry of oldFacts.patterns) {
        const pattern = entry.pattern;
        if (pattern.display.workload === "Discovery") {
            pattern.display.workload = pattern.display.tool === "workiq-get_schema" ? "Mail" : "Unknown";
            pattern.display.attribution = pattern.display.endpoints.length ? "requested-single-target" : "unavailable";
        }
        pattern.version = 1; pattern.normalizer = "wire-safe-technical-pattern-v1";
        const { version, normalizer, key, ...structural } = pattern;
        pattern.key = createHash("sha256").update(JSON.stringify(structural)).digest("hex");
    }
    const older = adaptEvaluationReport(freezeEvaluationFacts(oldFacts), {
        bundleId: "export-old", snapshotHash: "b".repeat(64), disclosureReviewed: true,
    });
    const olderBytes = JSON.stringify(older);
    const comparison = compareFrozenReportFacts(older, current);
    assert.equal(comparison.reason, "pattern-definition-changed");
    assert.equal(comparison.toolComparison, null);
    assert.match(comparison.narrative.detail, /categor|regroup/i);
    assert.equal(JSON.stringify(older), olderBytes);
    assert.deepEqual(older.toolRows.map(row => [row.id, row.outcome]), current.toolRows.map(row => [row.id, row.outcome]));
    if (process.env.WIRE_DISCOVERY_PROOFS) {
        await mkdir(process.env.WIRE_DISCOVERY_PROOFS, { recursive: true });
        for (const extension of ["html", "pdf", "json", "md"]) await writeFile(path.join(process.env.WIRE_DISCOVERY_PROOFS, `invented-discovery-report.${extension}`), bundle.files[`product-report.${extension}`]);
    }
});
