import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { renderHtmlReport, renderMarkdownReport } from "../lib/product-report.mjs";
import { hasCurrentReportPresentation } from "../lib/report-presentation.mjs";
import { readSavedReportFile, reportHash } from "../lib/report-artifacts.mjs";
import { buildComparisonBundle, inspectComparisonPair } from "../lib/comparison-export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { renderPeriodReportHtml, renderPeriodReportMarkdown } from "../lib/period-report-output.mjs";

const key = "a".repeat(64);
function record(id = "invented-timing-report") {
    const value = fixture(id);
    Object.assign(value.toolCalls[0], { durationMs: 11850, startedAt: "2026-10-01T12:00:00.000Z",
        completedAt: "2026-10-01T12:00:11.850Z", completionEventId: "invented-report-completion" });
    return value;
}
test("new output stamps presentation v3 with ms-first timing, leaving envelope and metric definitions unchanged", async () => {
    const bundle = await buildSanitizedBundle([record()], key, { promptMode: "none", formats: ["html", "markdown", "json", "pdf"] });
    assert.equal(bundle.snapshot.schemaVersion, 3);
    assert.deepEqual(bundle.snapshot.presentation, { schemaVersion: 3, originExplanationVersion: 1 });
    assert.deepEqual(JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]).presentation, bundle.snapshot.presentation);
    assert.equal(bundle.snapshot.evaluationFacts.metricProjectionVersion, 4);
    const metric = bundle.snapshot.evaluationFacts.metrics.find(item => item.definitionId === "tool-duration");
    assert.equal(metric.value, 11850);
    assert.equal(metric.boundary, "tool-start-to-completion");
    assert.equal(metric.unit, "ms");
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"]]) assert.match(content, /11,850 ms \(11\.85 s\)/);
    const task = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: false });
    try {
        const pdf = await task.promise, text = [];
        for (let n = 1; n <= pdf.numPages; n++) text.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str).join(" "));
        assert.match(text.join(" "), /11,850 ms \(11\.85 s\)/);
    } finally { await task.destroy(); }
    const older = { ...bundle.snapshot, presentation: { schemaVersion: 2 } };
    for (const content of [renderHtmlReport(older.records, { snapshot: older }), renderMarkdownReport(older.records, { snapshot: older })]) {
        assert.match(content, /11\.85 s \(11850 ms\)/);
        assert.doesNotMatch(content, /11,850 ms \(11\.85 s\)/);
    }
    assert.equal(hasCurrentReportPresentation(older), false);
    assert.equal(hasCurrentReportPresentation(bundle.snapshot), true);
});

test("saved v2 formats stay byte-identical and a v2 prepared comparison cannot become a v3 save", async t => {
    const { context } = await privateFixture(t, [record()]);
    const bundle = await buildSanitizedBundle([record()], key, { promptMode: "none", formats: ["html", "markdown", "json"] });
    bundle.snapshot.presentation = { schemaVersion: 2 };
    bundle.privacy.reviewerConfirmed = true;
    bundle.files["product-report.html"] = renderHtmlReport(bundle.records, { snapshot: bundle.snapshot });
    bundle.files["product-report.md"] = renderMarkdownReport(bundle.records, { snapshot: bundle.snapshot });
    bundle.files["product-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: bundle.snapshot.presentation, privacyReview: bundle.privacy,
        snapshotHash: reportHash(JSON.stringify(bundle.snapshot)) });
    manifest.files = Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
        .map(([name, content]) => [name, { bytes: Buffer.byteLength(content), sha256: reportHash(content) }]));
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    const saved = await writeBundle(context, bundle, await loadBoardState(context));
    await updateBoardState(context, state => state.exports.push(saved));
    const bytes = await Promise.all(Object.values(saved.files).map(async file => [file, await readFile(file)]));
    const controller = createExportController(context);
    const preview = await controller.preview("timing-v3", undefined, { promptMode: "none", formats: ["html", "json"] },
        { kind: "all", revision: (await loadBoardState(context)).revision });
    await controller.review("timing-v3", preview.previewId, true);
    const current = (await controller.confirm("timing-v3", preview.previewId, true)).bundle;
    const state = await loadBoardState(context);
    for (const [format, name] of [["html", "product-report.html"], ["markdown", "product-report.md"], ["json", "product-report.json"]]) {
        assert.equal((await readSavedReportFile(context, state, saved.bundleId, format)).bytes.toString(), bundle.files[name]);
    }
    const pair = await inspectComparisonPair(context, state, saved.bundleId, current.bundleId);
    const comparison = await buildComparisonBundle(pair, { formats: ["html", "markdown"] });
    assert.equal(comparison.snapshot.presentation.schemaVersion, 3);
    assert.match(comparison.files["comparison-report.html"], /11,850 ms \(11\.85 s\)/);
    assert.match(comparison.files["comparison-report.md"], /11,850 ms \(11\.85 s\)/);
    pair.comparison.presentation = { schemaVersion: 2 };
    await assert.rejects(buildComparisonBundle(pair, { formats: ["html"] }), /current presentation/);
    for (const [file, original] of bytes) assert.deepEqual(await readFile(file), original);
    assert.equal((await loadBoardState(context)).exports.length, 2);
});

test("period timing, exact matching rows and whole-interaction timing use the selected presentation without changing facts", () => {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), "2026-03-11T12:00:00.000Z").frozen;
    const records = [...new Set(Object.values(frozen.periods).flatMap(side => side.scenarioRefs))]
        .map(scenarioId => ({ scenarioId, toolCalls: [], graphActivities: [], httpRecords: [], prompts: [] }));
    const snapshot = { periodComparison: frozen, records, preparedAtDisplay: "Mar 11, 2026", promptMode: "none", presentation: { schemaVersion: 3 } };
    const before = JSON.stringify(snapshot);
    for (const content of [renderPeriodReportHtml(snapshot), renderPeriodReportMarkdown(snapshot)]) {
        assert.match(content, /1,000 ms \(1 s\)/);
        assert.match(content, /3,000 ms \(3 s\)/);
    }
    assert.equal(JSON.stringify(snapshot), before);
    const older = { ...snapshot, presentation: { schemaVersion: 2 } };
    assert.doesNotMatch(renderPeriodReportHtml(older), /1,000 ms \(1 s\)/);
});
