import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedComparisonFile } from "../lib/report-artifacts.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";
import { contrast, hue, measureChartPaint } from "./color-measurements.mjs";

test("registered mixed-origin comparison preserves overlap, per-side coverage, exact output, and supported light/print presentation", { timeout: 60000 }, async t => {
    const seed = qualityDisplayFixture({ requests: 3, calls: 7, timed: 6, judgments: ["pass", "fail", "unassessed"] }).state;
    const { context } = await privateFixture(t, seed.evidence);
    await updateBoardState(context, state => {
        state.pseudonymKey = seed.pseudonymKey;
        state.personalEvaluation = seed.personalEvaluation;
    });
    const controller = createExportController(context), sources = [];
    for (const [index, scenarioIds] of [[0, ["quality-request-0", "quality-request-1"]], [1, ["quality-request-1", "quality-request-2"]]]) {
        await updateBoardState(context, state => {
            for (const grant of state.personalEvaluation.modelEvaluation.grants) grant.model = `frozen-model-${index}`;
            for (const record of state.personalEvaluation.modelEvaluation.records) for (const assessment of record.assessments) {
                assessment.evaluator.model = `frozen-model-${index}`;
                assessment.evaluator.rubricVersion = index + 1;
            }
        });
        const state = await loadBoardState(context);
        const preview = await controller.preview("fixture", undefined, { promptMode: "none", formats: ["html"] },
            { kind: "selected", revision: state.revision, scenarioIds });
        await controller.review("fixture", preview.previewId, true);
        sources.push((await controller.confirm("fixture", preview.previewId, true)).bundle);
    }
    const preview = await controller.previewComparison("fixture", sources[0].bundleId, sources[1].bundleId,
        { formats: ["html", "pdf", "json", "markdown"] });
    const comparison = preview.comparison;
    assert.equal(comparison.toolComparison.overlap.sharedCount, 2);
    const accuracy = comparison.metrics.filter(metric => metric.metric === "accuracy" && (metric.baseline?.basis === "model-assessment" || metric.later?.basis === "model-assessment"));
    assert.equal(accuracy.length, 2, "Different frozen model origins keep separate lanes rather than fabricating counterparts");
    assert.ok(accuracy.every(metric => metric.status === "unavailable" && metric.delta === null));
    assert.deepEqual(accuracy.find(metric => metric.baseline)?.baseline.coverage, { count: 2, eligible: 2, missing: 0 });
    assert.deepEqual(accuracy.find(metric => metric.later)?.later.coverage, { count: 1, eligible: 2, missing: 1 });
    await controller.reviewComparison("fixture", preview.previewId, true);
    const saved = (await controller.confirmComparison("fixture", preview.previewId, true)).bundle;
    const state = await loadBoardState(context), files = {};
    for (const format of ["html", "pdf", "json", "markdown", "manifest"]) {
        const document = await readSavedComparisonFile(context, state, saved.bundleId, format);
        files[document.name] = document.bytes;
        assert.deepEqual(document.bytes, await readFile(saved.files[document.name]));
    }
    assert.deepEqual(JSON.parse(files["comparison-report.json"]).comparison, comparison);
    const extracted = await pdfDocumentText(files["comparison-report.pdf"]);
    const pdf = getDocument({ data: new Uint8Array(files["comparison-report.pdf"]), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
    const fonts = new Map(), pageBounds = [];
    try {
        const document = await pdf.promise;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 });
            const operators = await page.getOperatorList();
            for (const id of new Set(operators.fnArray.flatMap((op, index) => op === OPS.setFont ? [operators.argsArray[index][0]] : []))) {
                const font = page.commonObjs.get(id);
                assert.equal(font.missingFile, false);
                assert.ok(font.data?.byteLength > 0, "Every PDF font has an embedded font program");
                fonts.set(id, { name: font.name, bytes: font.data.byteLength });
            }
            const text = await page.getTextContent();
            const items = text.items.filter(item => item.str?.trim());
            assert.ok(items.every(item => item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2));
            assert.ok(items.every(item => item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1));
            pageBounds.push({ page: number, width: viewport.width, height: viewport.height, textItems: items.length });
        }
    } finally { await pdf.destroy(); }
    for (const text of [files["comparison-report.html"].toString(), files["comparison-report.md"].toString(), extracted.content]) {
        const compact = text.replace(/\s+/g, "");
        for (const model of ["frozen-model-0", "frozen-model-1"]) assert.ok(compact.includes(model));
        for (const version of [1, 2]) assert.ok(compact.includes(`rubricwire-recorded-interaction-reviewv${version}`));
        const readable = text.replace(/\s+/g, " ");
        assert.match(readable, /2 of 2 assessed/);
        assert.match(readable, /1 of 2 assessed/);
        assert.match(readable, /2 calls occur in both snapshots/);
        assert.match(readable, /Matched-pattern coverage:/);
    }
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ colorScheme: "dark", javaScriptEnabled: false, serviceWorkers: "block" });
    const outbound = [];
    await page.route("**/*", route => { outbound.push(route.request().url()); return route.abort(); });
    const directory = process.env.WIRE_SAVED_COMPARISON_PROOFS, layouts = [];
    if (directory) {
        await mkdir(directory, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes);
    }
    for (const [width, scale, media] of [[1200, 100, "screen"], [375, 200, "screen"], [1200, 100, "print"]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ media });
        await page.setContent(files["comparison-report.html"].toString());
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator("html").getAttribute("data-evidence-theme"), "light", "Generated files keep their explicit light theme even on a dark OS");
        const layout = await page.evaluate(() => ({
            width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
            foreground: getComputedStyle(document.querySelector(".report-comparison")).color,
            background: getComputedStyle(document.body).backgroundColor,
        }));
        assert.ok(layout.scrollWidth <= width + 1, `${media}/${width}/${scale}: horizontal overflow`);
        assert.ok(contrast(layout.foreground, layout.background) >= 4.5);
        assert.equal(await page.locator(".comparison-unavailable table").isVisible(), media === "print", "Browser print includes unopened unavailable/coverage details");
        const paint = await page.evaluate(measureChartPaint, ".comparison-outcome-failure");
        assert.ok(paint.length);
        for (const mark of paint) {
            assert.equal(mark.gradient, true);
            for (const color of mark.colors) {
                assert.ok(contrast(color, mark.background) >= 3);
                assert.ok(hue(color) >= 20 && hue(color) <= 32);
            }
        }
        layouts.push({ width, scale, media, ...layout, paint });
        if (directory) await page.screenshot({ path: path.join(directory, `frozen-${media}-${width}-${scale}.png`), fullPage: media === "screen" });
    }
    assert.deepEqual(outbound, []);
    if (directory) await writeFile(path.join(directory, "output-proof.json"), JSON.stringify({
        comparison: { overlap: comparison.toolComparison.overlap, accuracy },
        pdf: { pages: extracted.pages, fonts: [...fonts.values()], pageBounds },
        layouts, supportedTheme: "New frozen comparison HTML is explicitly light. App comparison light/dark uses shared tokens; no forced-dark saved-file mode was added.",
    }, null, 2));
});
