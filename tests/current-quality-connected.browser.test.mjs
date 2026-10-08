import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { evaluationFixture, materializeEvaluationSource, assessed } from "./evaluation-fixture.mjs";
import { chooseTheme, navigateMain } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport } from "./report-journey-helpers.mjs";

const dimensions = ["accuracy", "answer-trust", "action-trust"];
const modelMetrics = facts => facts.metrics.filter(metric => metric.origin === "model-assessed");
async function ready(page, selector) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    if (selector) await page.locator(`${selector} .assessment-grid`).waitFor();
}
async function fixture(t, evaluate) {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) }, evaluate);
    f.inputs.forEach((input, i) => { input.events.find(event => event.type === "user.message").data.source = i ? "agent-fixture" : "user"; });
    await materializeEvaluationSource(f);
    const exports = createExportController(f.context);
    const runtime = await startServer(f.context, exports, {
        port: 0, collector: { timers: false }, evaluation: { evaluatorFactory: f.options.evaluatorFactory },
    });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(12000);
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(runtime.url).origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    t.after(async () => {
        try { await browser.close(); await runtime.close(); }
        finally { for (const action of cleanup.reverse()) await action(); }
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
    });
    await runtime.collector.setEnabled(true); await runtime.collector.collectNow();
    return { ...f, exports, runtime, page };
}
async function approve(f) {
    const { page, runtime } = f;
    await page.goto(runtime.url + "#settings?section=collection");
    await page.locator("#automaticScoreSetup").getByRole("button", { name: "Set up automatic scores" }).click();
    const dialog = page.getByRole("dialog", { name: "Automatic scores", exact: true });
    await dialog.locator(".automatic-score-chats").waitFor();
    for (const input of await dialog.locator(".automatic-score-chats input").all()) await input.check();
    await dialog.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await dialog.getByLabel("Total budget (AI credits)", { exact: true }).fill("1");
    await dialog.getByRole("checkbox", { name: /Allow this evidence/ }).check();
    const response = page.waitForResponse(value => value.url().endsWith("/api/evaluation/automatic/approve"));
    await dialog.getByRole("button", { name: "Approve automatic scores", exact: true }).click();
    assert.equal((await response).status(), 200);
    await dialog.waitFor({ state: "hidden" });
}
async function settled(f, count) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const state = await loadBoardState(f.context), runs = state.personalEvaluation?.modelEvaluation?.runs ?? [];
        if (runs.length >= count && runs.every(run => !["queued", "running"].includes(run.phase))) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Controlled fixture did not settle.");
}
async function capture(page, name) {
    if (!process.env.WIRE_QUALITY_PROOFS) return;
    await mkdir(process.env.WIRE_QUALITY_PROOFS, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(process.env.WIRE_QUALITY_PROOFS, name + ".png"), fullPage: true });
}
async function pdfText(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.data, "base64");
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
        const doc = await task.promise, lines = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i), viewport = page.getViewport({ scale: 1 }), content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1);
                lines.push(item.str);
            }
        }
        return lines.join(" ").replace(/\s+/g, " ");
    } finally { await task.destroy(); }
}
async function assertSummary(page, host, metrics) {
    await ready(page, host);
    assert.equal(await page.locator(`${host} .assessment-dimension`).count(), 3);
    assert.equal(await page.locator(`${host} [data-dimension=cost]`).count(), 0);
    for (const metric of metrics) {
        const row = page.locator(`${host} [data-dimension="${metric.dimension}"]`).filter({
            has: page.locator(".assessment-origin").filter({ hasText: /^Model assessment$/ }),
        });
        await row.waitFor();
        assert.equal(await row.locator(".assessment-value").innerText(), metric.value === null ? "Unassessed" : `${metric.value * 100}%`);
        assert.match(await row.locator(".assessment-coverage").innerText(),
            new RegExp(`${metric.coverage.covered} / ${metric.coverage.eligible} assessed`));
    }
}

test("persisted model results stay connected through Home, Activity, interaction and four frozen report formats", { timeout: 120000 }, async t => {
    const f = await fixture(t, (request, reservation, count) => {
        const result = assessed(request, request.input.packet.answer.text.startsWith("Two"));
        if (count === 2) result.rawResult.actions.forEach(action => { action.verdict = "not-met"; action.reason = "outside-request"; });
        return result;
    });
    const { page, runtime } = f;
    await page.goto(runtime.url + "#home"); await ready(page, "#homeInsights");
    assert.equal(modelMetrics(buildAssessmentModel(await loadBoardState(f.context)).overview).length, 0);
    assert.doesNotMatch(await page.locator("#homeInsights").innerText(), /No automatic correctness check is available|Cost/);
    await capture(page, "home-missing-light");
    await approve(f);
    let state = await settled(f, 1), model = buildAssessmentModel(state);
    const partial = modelMetrics(model.overview);
    assert.equal(partial.length, 3);
    assert.ok(partial.every(metric => metric.coverage.covered === 1 && metric.coverage.eligible === 2));
    await navigateMain(page, "home"); await assertSummary(page, "#homeInsights", partial);
    await capture(page, "home-partial-light");
    await runtime.collector.collectNow(); state = await settled(f, 2); model = buildAssessmentModel(state);
    const metrics = modelMetrics(model.overview);
    assert.equal(metrics.length, 3);
    assert.ok(metrics.every(metric => metric.value === 0.5 && metric.denominator === 2 && metric.coverage.eligible === 2));
    await page.reload(); await assertSummary(page, "#homeInsights", metrics);
    for (const [theme, width] of [["light", 1200], ["dark", 1200], ["dark", 375]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await capture(page, `home-measured-${theme}-${width}`);
    }
    await page.setViewportSize({ width: 1200, height: 1000 }); await chooseTheme(page, "light");
    for (const author of ["user", "agent"]) {
        await page.goto(runtime.url + "#activity?authors=" + author); await ready(page, "#activityInsights");
        const view = [...model.details.values()].find(view => model.internals.get(view.interaction.interactionRef).record.userPrompt.authorship.actor === author);
        const subset = assessmentOverview(state, model, [view.interaction.interactionRef]);
        await assertSummary(page, "#activityInsights", modelMetrics(subset));
        const preview = await f.exports.preview("quality-author", undefined, { promptMode: "none", formats: ["json"] },
            { kind: "all", revision: state.revision, promptAuthors: [author] });
        assert.deepEqual(modelMetrics(preview.snapshot.evaluationFacts).map(metric => [metric.dimension, metric.numerator, metric.denominator, metric.coverage]),
            modelMetrics(subset).map(metric => [metric.dimension, metric.numerator, metric.denominator, metric.coverage]));
        const scenarioId = model.internals.get(view.interaction.interactionRef).record.scenarioId;
        await page.goto(runtime.url + "#request?request=" + encodeURIComponent(scenarioId));
        await assertSummary(page, ".interaction-insights", modelMetrics(view));
        await capture(page, `interaction-${author}-light`);
    }
    await page.goto(runtime.url + "#activity"); await assertSummary(page, "#activityInsights", metrics);
    await capture(page, "activity-measured-light");
    await page.goto(runtime.url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator("[name=promptMode][value=none]").check();
    for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    const preview = await scanReport(page), facts = preview.snapshot.evaluationFacts;
    assert.equal(facts.metricProjectionVersion, 2);
    assert.deepEqual(modelMetrics(facts).map(metric => [metric.dimension, metric.numerator, metric.denominator, metric.coverage]),
        metrics.map(metric => [metric.dimension, metric.numerator, metric.denominator, metric.coverage]));
    assert.equal(facts.metrics.some(metric => metric.dimension === "cost"), false);
    const json = JSON.parse(preview.files["product-report.json"]);
    assert.deepEqual(json.evaluationFacts, facts);
    const pdf = await pdfText(preview.files["product-report.pdf"]);
    for (const text of [preview.previewHtml, preview.files["product-report.md"], pdf]) {
        assert.match(text, /Model assessment/);
        assert.match(text, /1 of 2 passed/);
        assert.match(text, /2 of 2 assessed/);
        assert.match(text, /intent alignment/i);
        assert.doesNotMatch(text, />Cost<|\| Cost \||\bCost\b/);
    }
    assert.match(preview.files["product-report.md"], /Median tool-call duration/);
    assert.match(preview.files["product-report.md"], /Time to recorded final response/);
    await capture(page, "report-review-light");
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    const exported = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    assert.equal((await exported).status(), 200);
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const saved = (await loadBoardState(f.context)).exports.at(-1);
    for (const file of Object.values(saved.files)) assert.ok((await readFile(file)).length);
    if (process.env.WIRE_QUALITY_PROOFS) {
        await writeFile(path.join(process.env.WIRE_QUALITY_PROOFS, "frozen-quality-contract.json"), JSON.stringify({
            fixtureOnly: true, realAcceptance: false, sourceCalls: f.calls.length, metrics, frozen: facts,
            formats: preview.formats, pdfText: pdf,
        }, null, 2));
    }
    assert.equal(f.calls.length, 2, "Reading and reporting never trigger a model call");
});

test("a failed evaluator pauses truthfully without a false score or a replay on view reads", { timeout: 45000 }, async t => {
    const f = await fixture(t, async () => { throw new Error("Synthetic controlled evaluator failure"); });
    await approve(f); const state = await settled(f, 1);
    assert.equal(modelMetrics(buildAssessmentModel(state).overview).length, 0);
    await navigateMain(f.page, "home"); await ready(f.page, "#homeInsights");
    await f.page.waitForFunction(() => document.querySelector("#homeInsights .assessment-scoring-status")?.textContent.includes("Paused"));
    const text = await f.page.locator("#homeInsights").innerText();
    assert.match(text, /unknown|review|could not finish/i);
    assert.doesNotMatch(text, /No automatic correctness check is available|Cost/);
    await capture(f.page, "home-paused-error-light");
    assert.equal(f.calls.length, 1);
    await f.page.reload(); await ready(f.page, "#homeInsights");
    assert.equal(f.calls.length, 1);
});

test("persisted insufficient evidence stays unassessed in the view and all four report formats", { timeout: 45000 }, async t => {
    const f = await fixture(t, request => {
        const result = assessed(request, false);
        for (const item of [...result.rawResult.requirements, ...result.rawResult.answerSegments]) {
            item.verdict = "insufficient"; item.reason = "missing-evidence";
        }
        return result;
    });
    await approve(f); const state = await settled(f, 1), model = buildAssessmentModel(state);
    const metrics = modelMetrics(model.overview);
    assert.equal(metrics.length, 3);
    for (const dimension of ["accuracy", "answer-trust"]) {
        const metric = metrics.find(metric => metric.dimension === dimension);
        assert.equal(metric.value, null); assert.equal(metric.denominator, 0);
        assert.deepEqual(metric.coverage, { covered: 0, eligible: 2 });
    }
    await navigateMain(f.page, "home"); await assertSummary(f.page, "#homeInsights", metrics);
    await capture(f.page, "home-insufficient-light");
    const preview = await f.exports.preview("insufficient-quality", undefined,
        { promptMode: "none", formats: ["html", "json", "markdown", "pdf"] }, { kind: "all", revision: state.revision });
    const facts = JSON.parse(preview.files["product-report.json"]).evaluationFacts;
    assert.ok(modelMetrics(facts).filter(metric => ["accuracy", "answer-trust"].includes(metric.dimension))
        .every(metric => metric.value === null && metric.denominator === 0 && metric.coverage.eligible === 2));
    for (const text of [preview.previewHtml, preview.files["product-report.md"], await pdfText(preview.files["product-report.pdf"])]) {
        assert.match(text, /Model assessment/); assert.match(text, /0 of 2 assessed/);
        assert.doesNotMatch(text, />Cost<|\| Cost \|/);
    }
    assert.equal(f.calls.length, 1);
});
