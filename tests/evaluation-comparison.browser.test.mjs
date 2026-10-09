import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const hashes = bundle => Promise.all(Object.values(bundle.files).map(async file => digest(await readFile(file))));
async function selectReport(page, label, bundleId) {
    await page.locator("#comparisonWorkspace").getByRole("combobox", { name: label, exact: true }).click();
    await page.locator(`.select-popup .select-option[data-value="${bundleId}"]`).click();
}

test("controlled model assessments survive the explicit two-report browser journey with frozen origin, exact deltas and four formats", { timeout: 45000 }, async t => {
    const cleanup = [];
    const f = await evaluationFixture({ after: action => cleanup.push(action) });
    await materializeEvaluationSource(f);
    const exports = createExportController(f.context);
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); }
        finally {
            try { await runtime?.close(); }
            finally { for (const action of cleanup.reverse()) await action(); }
        }
    });
    runtime = await startServer(f.context, exports, { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("Only the controlled fixture controller may evaluate."); } } });
    async function saveReport() {
        const state = await loadBoardState(f.context);
        const preview = await exports.preview("synthetic-report-owner", undefined, { promptMode: "none", formats: ["html", "json", "markdown", "pdf"] },
            { kind: "selected", revision: state.revision, scenarioIds: f.input.scenarioIds });
        await exports.review("synthetic-report-owner", preview.previewId, true);
        return (await exports.confirm("synthetic-report-owner", preview.previewId, true)).bundle;
    }
    const setup = await f.controller.setup({ scenarioIds: f.input.scenarioIds });
    await f.controller.start("synthetic-model-owner", { ...f.input, expectedSourceRevision: setup.basis.sourceRevision });
    await f.controller.settle();
    const baseline = await saveReport();
    await f.controller.start("synthetic-model-owner", { ...f.input, expectedSourceRevision: setup.basis.sourceRevision,
        mutationRef: "mutation-" + randomBytes(16).toString("hex"), receiptToken: randomBytes(32).toString("hex") });
    await f.controller.settle();
    const later = await saveReport(), originalHashes = await Promise.all([hashes(baseline), hashes(later)]);
    assert.equal(f.calls.length, 4);

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") mutations.push(new URL(request.url()).pathname);
    });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (!await page.locator("#bundles").evaluate(node => node.open)) await page.locator("#bundles>summary").click();
    const item = page.locator(`#bundleList details[data-disclosure-key="bundle:${baseline.bundleId}"]`);
    await item.locator(":scope>summary").click();
    await item.getByRole("button", { name: "Compare saved reports", exact: true }).click();
    const workspace = page.locator("#comparisonWorkspace");
    await workspace.locator("select").first().locator("option").nth(1).waitFor({ state: "attached" });
    assert.deepEqual(await workspace.locator(".comparison-selectors select").evaluateAll(nodes => nodes.map(node => node.value)), ["", ""]);
    await selectReport(page, "Baseline report", baseline.bundleId);
    await selectReport(page, "Later report", later.bundleId);
    const inspected = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/inspect"));
    await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
    const response = await inspected;
    assert.equal(response.status(), 200);
    const comparison = (await response.json()).comparison;
    const accuracy = comparison.metrics.find(metric => metric.metric === "accuracy" && metric.baseline?.basis === "model-assessment");
    assert.equal(accuracy.status, "comparable");
    assert.deepEqual([accuracy.baseline.value, accuracy.later.value, accuracy.delta.value], [50, 100, 50]);
    assert.equal(accuracy.delta.unit, "percentage-points");
    assert.deepEqual(accuracy.baseline.coverage, { count: 2, eligible: 2, missing: 0 });
    assert.equal(accuracy.baseline.qualifiers.evaluatorModel, "gpt-6-astra");
    assert.equal(accuracy.baseline.qualifiers.rubricId, "wire-recorded-interaction-review");
    assert.equal(comparison.metrics.some(metric => metric.metric === "cost"), false);
    const accuracyRow = workspace.locator(".comparison-metrics tbody tr").filter({ hasText: "Accuracy" })
        .filter({ has: page.locator(".comparison-meta").filter({ hasText: /^Model assessment/ }) });
    assert.deepEqual(await accuracyRow.locator(".comparison-metric-value").allTextContents(), ["50%", "100%"]);
    for (const name of ["HTML", "PDF", "JSON", "Markdown"]) await workspace.getByRole("checkbox", { name, exact: true }).check();
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    assert.equal((await prepared).status(), 200);
    assert.equal(await workspace.getByRole("button", { name: "Save comparison", exact: true }).isEnabled(), false);
    assert.equal((await loadBoardState(f.context)).exports.length, 2);
    await workspace.getByRole("checkbox", { name: "I reviewed this frozen comparison for disclosure.", exact: true }).check();
    const reviewed = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/review"));
    await workspace.getByRole("button", { name: "Confirm disclosure", exact: true }).click();
    assert.equal((await reviewed).status(), 200);
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/save"));
    await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
    const saved = await savedResponse;
    assert.equal(saved.status(), 200);
    const bundle = (await saved.json()).bundle, frozenComparison = await hashes(bundle);
    const json = JSON.parse(await readFile(bundle.files["comparison-report.json"], "utf8"));
    assert.deepEqual(json.comparison, comparison);
    for (const name of ["comparison-report.html", "comparison-report.md"]) {
        const text = await readFile(bundle.files[name], "utf8");
        assert.match(text, /Model assessment/);
        assert.match(text, /50%/);
        assert.match(text, /100%/);
        assert.doesNotMatch(text, /How many synthetic|Three synthetic|Two synthetic/);
    }
    const pdf = getDocument({ data: new Uint8Array(await readFile(bundle.files["comparison-report.pdf"])), useSystemFonts: true });
    try {
        const document = await pdf.promise, text = [];
        for (let i = 1; i <= document.numPages; i++) text.push((await (await document.getPage(i)).getTextContent()).items.map(item => item.str ?? "").join(" "));
        assert.match(text.join(" "), /Model assessment/);
        assert.match(text.join(" "), /50%/);
        assert.match(text.join(" "), /100%/);
    } finally { await pdf.destroy(); }
    await f.controller.revoke();
    const unassessed = await saveReport();
    const oneSided = await exports.inspectComparison("synthetic-report-owner", baseline.bundleId, unassessed.bundleId);
    const missing = oneSided.comparison.metrics.find(metric => metric.metric === "accuracy" && metric.baseline?.basis === "model-assessment");
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.baseline.value, 50);
    assert.equal(missing.later?.value ?? null, null);
    assert.equal(missing.delta, null);
    assert.deepEqual((await exports.openComparison("synthetic-report-owner", bundle.bundleId)).comparison, comparison);
    assert.deepEqual(await Promise.all([hashes(baseline), hashes(later)]), originalHashes);
    assert.deepEqual(await hashes(bundle), frozenComparison);
    assert.equal(f.calls.length, 4);
    assert.equal(mutations.filter(route => route === "/api/report-comparison/save").length, 1);
    assert.equal(mutations.some(route => /evaluation\/start|collection\/refresh|collect_now|recollection\/confirm/.test(route)), false);
    assert.deepEqual(errors, []);
});
