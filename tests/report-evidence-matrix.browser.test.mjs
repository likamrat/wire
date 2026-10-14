import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { reportMatrixCases } from "./report-evidence-matrix-fixtures.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";

test("rendered report matrix preserves numerical truth, chart proportions and missing-state meaning", { timeout: 120000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const externalRequests = [];
        await context.route("**/*", route => { externalRequests.push(route.request().url()); return route.abort(); });
        const page = await context.newPage();
        for (const scenario of reportMatrixCases()) {
            const selected = scenario.canonicalSelection ? buildExportCatalog(scenario.records).records : scenario.records;
            const bundle = await buildSanitizedBundle(selected, "b".repeat(64), { promptMode: "none", formats: ["html"] });
            await page.setContent(bundle.previewHtml);
            await page.evaluate(() => document.fonts.ready);
            const expected = scenario.expected;
            const bars = await page.locator("#breakdowns > .native-breakdowns > section").first().locator(".native-bar").evaluateAll(nodes => nodes.map(node => ({
                count: Number(node.dataset.count), denominator: Number(node.dataset.denominator),
                width: node.getBoundingClientRect().width, track: node.parentElement.getBoundingClientRect().width,
                tone: [...node.classList].find(name => name.startsWith("dimensional-tone-")).replace("dimensional-tone-", ""),
            })));
            assert.equal(bars.reduce((sum, bar) => sum + bar.count, 0), expected.calls, `${scenario.name}: only tool calls enter tool bars`);
            const outcomeCounts = { success: 0, failure: 0, partial: 0, unknown: 0, other: 0, transport: 0 };
            const outcomes = { teal: "success", pink: "failure", orange: "partial", slate: "unknown", violet: "other", cyan: "transport" };
            for (const bar of bars) {
                assert.equal(bar.denominator, expected.calls);
                assert.ok(bar.count > 0 && bar.width > 0);
                assert.ok(Math.abs(bar.width - bar.track * bar.count / bar.denominator) < .02, "Exact shared denominator; no inflated minimum");
                outcomeCounts[outcomes[bar.tone]] += bar.count;
            }
            for (const outcome of ["success", "failure", "partial", "unknown"]) assert.equal(outcomeCounts[outcome], expected[outcome]);
            if (expected.graph) {
                const graph = bundle.snapshot.evaluationFacts.recordedOutcomes.filter(row => row.kind === "graph-request-site");
                assert.equal(graph.length, expected.graph);
                assert.deepEqual(graph.map(row => row.outcome).sort(), ["failure", "success", "unknown"]);
                assert.match(await page.locator("#operations").innerText(), /recorded request|request sites/i);
            }
            assert.equal(await page.locator(".report-tool-score,.report-dimensions,.dimensional-column").count(), 0);
            await page.locator("#quality > summary").click();
            const quality = page.locator("#quality");
            assert.match(await quality.innerText(), /Not checked automatically/);
            for (const [label, checkId] of [["Answer support", "answer-support-validity"], ["Permission for tool use", "action-authorization-compliance"]]) {
                const metric = bundle.snapshot.evaluationFacts.metrics.find(metric => metric.checkId === checkId);
                assert.match(await quality.locator("li,tr").filter({ hasText: label }).innerText(), new RegExp(`0 of ${metric.coverage.eligible} assessed`));
            }
            const timing = page.locator("#timing tbody tr").filter({ hasText: /^Tool calls/ });
            if (expected.timed) {
                assert.match(await timing.innerText(), new RegExp(`${expected.timed} of ${expected.calls} calls? timed`));
                assert.match(await timing.locator("td").first().innerText(), new RegExp(`\\(${expected.median} ms\\)`));
            } else {
                const note = await page.locator("#timing > .reading-note").filter({ hasText: /^Tool calls:/ }).innerText();
                assert.match(note, new RegExp(`0 of ${expected.calls} calls? timed`));
                assert.match(note, /Not measured/);
            }
            for (const theme of ["light", "dark"]) for (const width of [320, 768, 1200]) for (const size of ["100%", "200%"]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(({ theme, size }) => {
                    document.documentElement.dataset.evidenceTheme = theme;
                    document.documentElement.style.fontSize = size;
                }, { theme, size });
                const layout = await page.evaluate(() => ({
                    pageWidth: document.documentElement.scrollWidth,
                    clipped: [...document.querySelectorAll(".native-counts strong,.native-bar-heading strong,#quality td,#quality li,#timing td,#timing>p")]
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
