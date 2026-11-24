import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { buildSanitizedBundle, createExportController, writeBundle } from "../lib/export.mjs";
import { installHistoricalFiles, buildComparisonBundle, inspectComparisonPair } from "./historical-comparison-fixture.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { loadSavedReportSource } from "../lib/report-artifacts.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonHtml, renderComparisonMarkdown, reportPresentation } from "../lib/report-presentation.mjs";
import { makeRatio } from "./assessment-contract-fixtures.mjs";
import { startServer } from "../lib/server.mjs";

const timeContext = { timeZone: "UTC", locale: "en-US" };
const hash = value => createHash("sha256").update(value).digest("hex");
const personalRow = comparison => comparison.metrics.find(metric => metric.metric === "accuracy" && metric.comparisonKey?.includes('"user-personal"'));
async function fileHashes(bundle) {
    return Object.fromEntries(await Promise.all(Object.entries(bundle.files).map(async ([name, file]) => [name, hash(await readFile(file))])));
}
// Invented archived artifacts only; no retired writer or legacy generation mode.
async function saveHistoricalReport(context, includeFeedback) {
    const state = await loadBoardState(context);
    const bundle = await buildSanitizedBundle(state.evidence, state.pseudonymKey, { promptMode: "none", formats: ["html", "json"], timeContext });
    const facts = structuredClone(buildReportFacts(state.evidence, state).facts);
    facts.metricProjectionVersion = 3;
    if (includeFeedback) {
        const assessment = { ...state.personalEvaluation.feedback.records[0].assessment, basis: facts.basis,
            assessmentRef: "assessment-" + "5".repeat(32), verdict: "fail" };
        facts.assessments.push(assessment);
        facts.metrics.push({ ...makeRatio(0, 1), metricRef: "metric-" + "5".repeat(32), basis: facts.basis,
            dimension: assessment.dimension, origin: assessment.origin, checkId: assessment.checkId,
            eligibleUnitRefs: [assessment.interactionRef], coveredUnitRefs: [assessment.interactionRef],
            evidenceRefs: [...assessment.evidenceRefs, assessment.assessmentRef] });
    }
    bundle.snapshot.evaluationFacts = freezeEvaluationFacts(facts);
    bundle.snapshot.presentation = reportPresentation;
    bundle.privacy = { ...bundle.privacy, reviewerConfirmed: true, confirmedAt: new Date().toISOString(), reviewChannel: "synthetic-legacy-fixture" };
    bundle.previewHtml = renderHtmlReport(bundle.records, { snapshot: bundle.snapshot });
    bundle.files["product-report.html"] = bundle.previewHtml;
    bundle.files["product-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: reportPresentation, privacyReview: bundle.privacy, evaluationFacts: facts,
        evaluationFactsHash: hash(JSON.stringify(facts)), snapshotHash: hash(JSON.stringify(bundle.snapshot)),
        files: Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
            .map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }])) });
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    let saved;
    await updateBoardState(context, async state => {
        saved = await writeBundle(context, bundle, state);
        state.exports.push(saved);
    });
    return saved;
}
async function seedLegacyComparison(context, baselineId, laterId, side) {
    const state = await loadBoardState(context);
    const pair = await inspectComparisonPair(context, state, baselineId, laterId);
    const sources = await Promise.all([baselineId, laterId].map(id => loadSavedReportSource(context, state, id)));
    const comparison = compareFrozenReportFacts(sources[0].envelope, sources[1].envelope, { metricProjectionVersion: 3 });
    const row = personalRow(comparison);
    assert.equal(row[side].value, 0);
    delete row.baseline;
    delete row.later;
    const bundle = await buildComparisonBundle(pair, { formats: ["html", "json", "markdown"], timeContext });
    // Seed a pre-fix data shape in an isolated test store; this is not a production review.
    comparison.presentation = reportPresentation;
    bundle.comparison = comparison;
    Object.assign(bundle.snapshot, { comparison, presentation: reportPresentation,
        sourceFacts: sources.map(source => ({ report: source.reference, evaluationFacts: source.facts, legacyFacts: null })) });
    bundle.previewHtml = renderComparisonHtml(comparison, bundle.snapshot);
    bundle.files["comparison-report.html"] = bundle.previewHtml;
    bundle.files["comparison-report.md"] = renderComparisonMarkdown(comparison, bundle.snapshot);
    bundle.files["comparison-report.json"] = JSON.stringify(bundle.snapshot, null, 2) + "\n";
    bundle.privacy = { ...bundle.privacy, reviewerConfirmed: true, confirmedAt: new Date().toISOString(), reviewChannel: "synthetic-legacy-fixture" };
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    Object.assign(manifest, { presentation: reportPresentation, privacyReview: bundle.privacy,
        comparison, comparisonHash: hash(JSON.stringify(comparison)), sourceFacts: bundle.snapshot.sourceFacts,
        sourceFactsHash: hash(JSON.stringify(bundle.snapshot.sourceFacts)), snapshotHash: hash(JSON.stringify(bundle.snapshot)),
        files: Object.fromEntries(Object.entries(bundle.files).filter(([name]) => name !== "coverage-and-redaction-manifest.json")
            .map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }])) });
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    let saved;
    await updateBoardState(context, async state => {
        saved = await installHistoricalFiles(context, bundle);
        state.exports.push(saved);
        state.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
        state.artifactDeletion.revision++;
    });
    return saved;
}

test("historical one-sided facts stay readable in both directions", { timeout: 120000 }, async t => {
    const cleanup = [];
    const { context } = await retirementFixture({ after: action => cleanup.push(action) });
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); await runtime?.close(); }
        finally { for (const action of cleanup) await action(); }
    });
    const controller = createExportController(context);
    const withoutFeedback = await saveHistoricalReport(context, false);
    const withFeedback = await saveHistoricalReport(context, true);
    const sourceHashes = await Promise.all([withoutFeedback, withFeedback].map(fileHashes));
    const directions = [
        { side: "baseline", baseline: withFeedback, later: withoutFeedback },
        { side: "later", baseline: withoutFeedback, later: withFeedback },
    ];
    for (const direction of directions) {
        direction.legacy = await seedLegacyComparison(context, direction.baseline.bundleId, direction.later.bundleId, direction.side);
        direction.legacyHashes = await fileHashes(direction.legacy);
    }
    const historicalStore = structuredClone((await loadBoardState(context)).personalEvaluation);
    assert.equal(historicalStore.feedback.records[0].assessment.verdict, "pass",
        "Retained history disagrees with the frozen fail fact; old reads must use their exact saved source.");
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
    page.setDefaultTimeout(10000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            external.push(route.request().url());
            return route.abort();
        }
        return route.continue();
    });
    async function showReports() {
        // Start from a fresh public location, not a reload of private search/inspector history.
        await page.goto(runtime.url);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await page.locator('nav [data-nav="reports"]').click();
        await page.locator("#viewAllSavedReports").click();
    }
    const item = id => page.locator(`#bundleList [data-bundle-id="${id}"]`);
    for (const direction of directions) {
        await showReports();
        await item(direction.legacy.bundleId).locator(".saved-report-files").click();
        const beforeOpen = await loadBoardState(context);
        const opening = page.waitForResponse(result => result.url().endsWith("/api/artifact-file"));
        await item(direction.legacy.bundleId).getByRole("button", { name: "Web page (HTML)", exact: true }).click();
        const openResponse = await opening;
        assert.equal(openResponse.status(), 200, await openResponse.text());
        const document = await openResponse.json();
        assert.equal(document.format, "html");
        assert.equal(Buffer.from(document.data, "base64").toString(), await readFile(direction.legacy.files["comparison-report.html"], "utf8"));
        const opened = await controller.openComparison("legacy-compatibility", direction.legacy.bundleId);
        const restored = personalRow(opened.comparison), missing = direction.side === "baseline" ? "later" : "baseline";
        assert.equal(restored[direction.side].value, 0);
        assert.equal(restored[missing], null);
        assert.equal(restored.delta, null);
        assert.equal(restored.reason, `${missing}-metric-not-saved`);
        assert.equal(opened.displayCompatibility.restoredMetricCount, 1);
        assert.equal(opened.displayCompatibility.savedFilesUnchanged, true);
        const manifest = JSON.parse(await readFile(direction.legacy.files["coverage-and-redaction-manifest.json"], "utf8"));
        assert.equal(opened.displayCompatibility.storedComparisonHash, manifest.comparisonHash);
        assert.equal(hash(JSON.stringify(manifest.comparison)), manifest.comparisonHash);
        assert.notEqual(hash(JSON.stringify(opened.comparison)), manifest.comparisonHash, "Enriched display is not claimed to be the stored model");
        assert.equal(Object.hasOwn(personalRow(manifest.comparison), direction.side), false, "Stored old model is untouched");
        const afterOpen = await loadBoardState(context);
        assert.deepEqual(afterOpen.exports, beforeOpen.exports, "Compatibility display never rewrites the saved index");
        assert.equal(afterOpen.revision, beforeOpen.revision);
        const frame = page.frameLocator("#savedReportReader iframe");
        await frame.locator(".comparison-unavailable > summary").click();
        assert.match(await frame.locator(".report-comparison").innerText(), /Not preserved/);
        assert.match(await frame.locator(".report-comparison").innerText(), /No value has been reconstructed/);
        await page.getByRole("button", { name: "Back to saved reports", exact: true }).click();
        assert.deepEqual(await fileHashes(direction.legacy), direction.legacyHashes);
    }
    assert.deepEqual(await Promise.all([withoutFeedback, withFeedback].map(fileHashes)), sourceHashes);
    // Remove only an isolated source bundle: legacy display must still use its embedded copies.
    await showReports();
    await item(withFeedback.bundleId).getByRole("button", { name: "Inspect details" }).click();
    const deletionPreview = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true }).click();
    assert.equal((await deletionPreview).status(), 200);
    const dialog = page.locator(".deletion-dialog");
    const deletion = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/confirm"));
    await dialog.getByRole("button", { name: "Delete report", exact: true }).click();
    assert.equal((await deletion).status(), 200);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await assert.rejects(readFile(withFeedback.files["product-report.json"]), { code: "ENOENT" });
    for (const direction of directions) {
        const opened = await controller.openComparison("after-source-deletion", direction.legacy.bundleId);
        assert.equal(personalRow(opened.comparison)[direction.side].value, 0);
        assert.ok(opened.sources.some(source => source.bundleId === withFeedback.bundleId && source.available === false));
        assert.deepEqual(await fileHashes(direction.legacy), direction.legacyHashes);
    }
    await showReports();
    await item(directions[0].legacy.bundleId).locator(".saved-report-files").click();
    const reopened = page.waitForResponse(response => response.url().endsWith("/api/artifact-file"));
    await item(directions[0].legacy.bundleId).getByRole("button", { name: "Web page (HTML)", exact: true }).click();
    assert.equal((await reopened).status(), 200);
    const frozen = page.frameLocator("#savedReportReader iframe");
    await frozen.locator(".comparison-unavailable > summary").click();
    assert.match(await frozen.locator(".report-comparison").innerText(), /Not preserved/);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, historicalStore);
});
