import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController, writeBundle } from "../lib/export.mjs";
import { buildComparisonBundle, inspectComparisonPair } from "../lib/comparison-export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { startServer } from "../lib/server.mjs";

const timeContext = { timeZone: "UTC", locale: "en-US" };
const hash = value => createHash("sha256").update(value).digest("hex");
const personalRow = comparison => comparison.metrics.find(metric => metric.metric === "accuracy" && metric.comparisonKey?.includes('"user-personal"'));
async function fileHashes(bundle) {
    return Object.fromEntries(await Promise.all(Object.entries(bundle.files).map(async ([name, file]) => [name, hash(await readFile(file))])));
}
async function seedLegacyComparison(context, baselineId, laterId, side) {
    const pair = await inspectComparisonPair(context, await loadBoardState(context), baselineId, laterId);
    const row = personalRow(pair.comparison);
    assert.equal(row[side].value, 0);
    delete row.baseline;
    delete row.later;
    const bundle = await buildComparisonBundle(pair, { formats: ["html", "json", "markdown"], timeContext });
    // Seed a pre-fix data shape in an isolated test store; this is not a production review.
    bundle.privacy = { ...bundle.privacy, reviewerConfirmed: true, confirmedAt: new Date().toISOString(), reviewChannel: "synthetic-legacy-fixture" };
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    manifest.privacyReview = bundle.privacy;
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    let saved;
    await updateBoardState(context, async state => {
        saved = await writeBundle(context, bundle, state);
        state.exports.push(saved);
        state.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
        state.artifactDeletion.revision++;
    });
    return saved;
}

test("actual saved pairs retain one-sided feedback in both directions, exports, and read-only legacy views", { timeout: 120000 }, async t => {
    const cleanup = [];
    const source = fixture("one-sided");
    source.userPrompt.sourceEventId = "one-sided-prompt";
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [source]);
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); await runtime?.close(); }
        finally { for (const action of cleanup) await action(); }
    });
    const controller = createExportController(context);
    async function saveReport() {
        const state = await loadBoardState(context);
        const preview = await controller.preview("seed", undefined, { promptMode: "none", formats: ["html", "json"], timeContext },
            { kind: "selected", revision: state.revision, scenarioIds: [source.scenarioId] });
        await controller.review("seed", preview.previewId, true, timeContext);
        return (await controller.confirm("seed", preview.previewId, true, timeContext)).bundle;
    }
    async function feedback(verdict) {
        const state = await loadBoardState(context), model = buildAssessmentModel(state);
        await executeAssessmentAction(context, "seed", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`,
            interactionRef: model.overview.interactionRefs[0], expectedBasis: model.basis,
            checkId: "semantic-answer-correctness", verdict, withdraw: false,
        });
    }
    const withoutFeedback = await saveReport();
    await feedback("fail");
    const withFeedback = await saveReport();
    const sourceHashes = await Promise.all([withoutFeedback, withFeedback].map(fileHashes));
    const directions = [
        { side: "baseline", baseline: withFeedback, later: withoutFeedback },
        { side: "later", baseline: withoutFeedback, later: withFeedback },
    ];
    for (const direction of directions) {
        direction.legacy = await seedLegacyComparison(context, direction.baseline.bundleId, direction.later.bundleId, direction.side);
        direction.legacyHashes = await fileHashes(direction.legacy);
    }
    await feedback("pass"); // Opening saved results must not use this newer live verdict.
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
    async function showReports(bundleId) {
        if (page.url().startsWith(runtime.url)) await page.reload();
        else await page.goto(runtime.url + "#reports");
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles>summary").click();
        await page.locator("#savedReportSearch").fill(bundleId);
    }
    const item = id => page.locator("#bundleList summary").filter({ hasText: id }).locator("..");
    async function select(label, id) {
        await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup .select-option[data-value="${id}"]`).click();
    }
    async function assertView(side) {
        const rows = page.locator("#comparisonWorkspace .comparison-metrics tbody tr");
        const personal = rows.filter({ hasText: "Your feedback" });
        assert.equal(await personal.count(), 1);
        assert.match(await personal.locator("th").innerText(), /Accuracy[\s\S]*Your feedback/);
        const values = await personal.locator(".comparison-metric-value").allTextContents();
        assert.deepEqual(values, side === "baseline" ? ["0%", "Not saved"] : ["Not saved", "0%"]);
        assert.match(await personal.locator("td").last().innerText(), /Not comparable/);
        assert.equal(await personal.locator(".comparison-delta").count(), 0);
        const automatic = rows.filter({ hasText: "Automatic checks" }).filter({ hasText: "Accuracy" });
        assert.deepEqual(await automatic.locator(".comparison-metric-value").allTextContents(), ["Not assessed", "Not assessed"]);
    }
    for (const direction of directions) {
        await showReports(direction.baseline.bundleId);
        await item(direction.baseline.bundleId).locator(":scope>summary").click();
        await item(direction.baseline.bundleId).getByRole("button", { name: "Compare saved reports", exact: true }).click();
        await select("Baseline report", direction.baseline.bundleId);
        await select("Later report", direction.later.bundleId);
        const inspecting = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
        await page.locator("#comparisonWorkspace").getByRole("button", { name: "Compare reports", exact: true }).click();
        const response = await inspecting;
        assert.equal(response.status(), 200, await response.text());
        const compared = (await response.json()).comparison, row = personalRow(compared);
        assert.equal(row[direction.side].value, 0);
        assert.equal(row[direction.side === "baseline" ? "later" : "baseline"], null);
        assert.equal(row.delta, null);
        await page.locator("#comparisonWorkspace .comparison-metrics").first().waitFor();
        await assertView(direction.side);

        const preview = await controller.previewComparison("new-copy", direction.baseline.bundleId, direction.later.bundleId,
            { formats: ["html", "pdf", "json", "markdown"], timeContext });
        await controller.reviewComparison("new-copy", preview.previewId, true, timeContext);
        const saved = (await controller.confirmComparison("new-copy", preview.previewId, true, timeContext)).bundle;
        const newHashes = await fileHashes(saved);
        for (const name of ["comparison-report.html", "comparison-report.md"]) {
            const text = await readFile(saved.files[name], "utf8");
            assert.match(text, /Your feedback/);
            assert.match(text, /Not saved/);
            assert.match(text, /0%/);
        }
        const pdf = getDocument({ data: new Uint8Array(await readFile(saved.files["comparison-report.pdf"])), useSystemFonts: true });
        try {
            const doc = await pdf.promise, text = [];
            for (let n = 1; n <= doc.numPages; n++) text.push((await (await doc.getPage(n)).getTextContent()).items.map(part => part.str ?? "").join(""));
            assert.match(text.join(""), /Your feedback/);
            assert.match(text.join(""), /Not saved/);
        } finally { await pdf.destroy(); }
        const openedNew = await controller.openComparison("new-copy", saved.bundleId);
        assert.equal(personalRow(openedNew.comparison)[direction.side].value, 0);
        assert.equal(openedNew.displayCompatibility, undefined);
        assert.deepEqual(await fileHashes(saved), newHashes);

        await showReports(direction.legacy.bundleId);
        await item(direction.legacy.bundleId).locator(":scope>summary").click();
        const beforeOpen = await loadBoardState(context);
        const opening = page.waitForResponse(result => result.url().endsWith("/api/report-comparison/open"));
        await item(direction.legacy.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
        const openResponse = await opening;
        assert.equal(openResponse.status(), 200, await openResponse.text());
        const opened = await openResponse.json();
        assert.equal(personalRow(opened.comparison)[direction.side].value, 0);
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
        await assertView(direction.side);
        assert.match(await page.locator("#comparisonWorkspace .comparison-notice").innerText(), /frozen source facts.*Saved comparison files are unchanged/);
        assert.deepEqual(await fileHashes(direction.legacy), direction.legacyHashes);
    }
    assert.deepEqual(await Promise.all([withoutFeedback, withFeedback].map(fileHashes)), sourceHashes);
    // Remove only an isolated source bundle: legacy display must still use its embedded copies.
    await showReports(withFeedback.bundleId);
    await item(withFeedback.bundleId).locator(":scope>summary").click();
    const deletionPreview = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/preview"));
    await item(withFeedback.bundleId).getByRole("button", { name: "Delete report", exact: true }).click();
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
    await showReports(directions[0].legacy.bundleId);
    await item(directions[0].legacy.bundleId).locator(":scope>summary").click();
    const reopened = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/open"));
    await item(directions[0].legacy.bundleId).locator("..").getByRole("button", { name: "Open saved comparison", exact: true }).click();
    assert.equal((await reopened).status(), 200);
    await assertView("baseline");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
});
