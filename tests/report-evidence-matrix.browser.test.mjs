import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { reportMatrixCases } from "./report-evidence-matrix-fixtures.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";

test("rendered report matrix preserves numerical truth, chart proportions and missing-state meaning", { timeout: 120000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const externalRequests = [];
        await context.route("**/*", route => { externalRequests.push(route.request().url()); return route.abort(); });
        const page = await context.newPage(), format = createReportComparison();
        for (const scenario of reportMatrixCases()) {
            const selected = scenario.canonicalSelection ? buildExportCatalog(scenario.records).records : scenario.records;
            const bundle = await buildSanitizedBundle(selected, "b".repeat(64), { promptMode: "none", formats: ["html"] });
            await page.setContent(bundle.previewHtml);
            await page.evaluate(() => document.fonts.ready);
            const expected = scenario.expected;
            const plotted = expected.graph
                ? { count: expected.graph, success: 1, failure: 1, partial: 0, unknown: 1 }
                : { ...expected, count: expected.calls };
            const charts = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(node => ({
                total: Number(node.dataset.total), maximum: Number(node.dataset.maximum), height: Number(node.dataset.frontHeight),
                segments: [...node.querySelectorAll(".dimensional-front")].map(segment => ({
                    count: Number(segment.dataset.count), height: Number(segment.getAttribute("height")),
                    outcome: ["success", "failure", "partial", "unknown", "other", "transport"].find(name => segment.classList.contains(name)),
                })),
            })));
            assert.equal(charts.reduce((sum, chart) => sum + chart.total, 0), plotted.count, `${scenario.name}: all chart columns total their explicitly named evidence units`);
            if (expected.graph) assert.match(await page.locator(".dimensional-report").first().innerText(), /request sites|recorded-request-site/);
            const outcomeCounts = { success: 0, failure: 0, partial: 0, unknown: 0, other: 0, transport: 0 };
            for (const chart of charts) {
                assert.equal(chart.segments.reduce((sum, segment) => sum + segment.count, 0), chart.total);
                assert.ok(Math.abs(chart.segments.reduce((sum, segment) => sum + segment.height, 0) - chart.height) < 1e-6);
                for (const segment of chart.segments) {
                    assert.ok(segment.count > 0 && segment.height > 0);
                    assert.ok(Math.abs(segment.height / chart.height - segment.count / chart.total) < 1e-9, "Painted segment height represents its actual count share");
                    outcomeCounts[segment.outcome] += segment.count;
                }
            }
            for (const outcome of ["success", "failure", "partial", "unknown"]) assert.equal(outcomeCounts[outcome], plotted[outcome]);
            if (expected.calls && expected.success + expected.failure) {
                assert.equal(await page.locator(".report-tool-score strong").innerText(), format.formatValue(expected.success / expected.calls * 100, "percent"));
            } else {
                assert.equal(await page.locator(".report-tool-score").count(), 0);
            }
            const dimensions = page.locator(".report-dimension");
            assert.deepEqual(await dimensions.locator(":scope > h2").allTextContents(), ["Accuracy", "Speed", "Trust"]);
            assert.match(await dimensions.nth(0).innerText(), /Not assessed/);
            assert.equal((await dimensions.nth(2).innerText()).match(/Not assessed/g)?.length, 2, "Answer and action trust both remain explicitly unassessed");
            const speed = await dimensions.nth(1).locator(".comparison-metric-value").first().innerText();
            assert.equal(speed, expected.median === null ? "Not measured" : format.formatValue(expected.median, "ms"));
            for (const theme of ["light", "dark"]) for (const width of [320, 768, 1200]) for (const size of ["100%", "200%"]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(({ theme, size }) => {
                    document.documentElement.dataset.evidenceTheme = theme;
                    document.documentElement.style.fontSize = size;
                }, { theme, size });
                const layout = await page.evaluate(() => ({
                    pageWidth: document.documentElement.scrollWidth,
                    clipped: [...document.querySelectorAll(".report-dimension .comparison-metric-value,.report-tool-score strong")]
                        .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
                }));
                assert.ok(layout.pageWidth <= width + 1, `${scenario.name}/${theme}/${width}/${size}: page overflow ${layout.pageWidth}`);
                assert.deepEqual(layout.clipped, [], `${scenario.name}: metric is not clipped`);
            }
            if (process.env.WIRE_REPORT_PROOFS && ["mixed-parallel-batches", "high-volume-twelve-interactions", "graph-only-visible-and-missing-status"].includes(scenario.name)) {
                await page.setViewportSize({ width: 1200, height: 1000 });
                await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; document.documentElement.dataset.evidenceTheme = "light"; });
                await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `matrix-${scenario.name}.png`), fullPage: true });
            }
        }
        assert.deepEqual(externalRequests, []);
    } finally { await browser.close(); }
});
