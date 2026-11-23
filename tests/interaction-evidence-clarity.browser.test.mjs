import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { createTimingPresentation, createAssessmentWording, renderRecordedTiming, assessmentPresentationStyles } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { screenTokens } from "../web/tokens.mjs";

test("timing widgets keep value and unit adjacent without changing missing or zero measurements", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const timing = createTimingPresentation(undefined, { compact: true });
    const rows = [
        timing.fromSummary({ sampleCount: 2, p50Ms: 325, p95Ms: 11850 }, 3, "tool-start-to-completion"),
        timing.fromSummary({ sampleCount: 1, p50Ms: 90061004, p95Ms: 90061004 }, 1, "recorded-request-to-final-answer"),
        timing.fromSummary({ sampleCount: 1, p50Ms: 0, p95Ms: 0 }, 1, "http-dispatch-to-response-headers"),
        timing.fromSummary({ sampleCount: 0, p50Ms: null, p95Ms: null }, 1, "http-dispatch-to-transport-error"),
    ];
    await page.setContent(`<style>${screenTokens}${assessmentPresentationStyles}body{margin:16px;background:var(--paper);color:var(--ink);font-family:var(--font)}main{max-width:100%}</style><main></main>`);
    await page.addScriptTag({ content: `window.renderTiming = ${renderRecordedTiming.toString()}` });
    await page.evaluate(rows => window.renderTiming(document.querySelector("main"), rows, { compact: true }), rows);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale}%`;
        }, { theme, scale });
        await expect(page.locator('data[value="11850"]')).toHaveText("11,850 ms (11.85 s)");
        await expect(page.locator('data[value="0"]')).toHaveText("0 ms");
        await expect(page.locator("data:not([value])")).toHaveText("Not measured");
        const measures = await page.locator(".duration-primary").evaluateAll(nodes => nodes.map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const rect = node.getBoundingClientRect();
            return { fragments: range.getClientRects().length, right: rect.right, width: innerWidth };
        }));
        assert.ok(measures.every(value => value.fragments === 1 && value.right <= value.width), JSON.stringify({ theme, width, scale, measures }));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});

test("live saved-report and period comparisons keep signed milliseconds and seconds equivalent", { timeout: 30000 }, async t => {
    const cases = [
        [-11850, "\u221211,850 ms (\u221211.85 s)"], [11850, "+11,850 ms (+11.85 s)"],
        [-325, "\u2212325 ms"], [325, "+325 ms"], [0, "Unchanged"],
    ];
    const records = cases.flatMap(([delta], index) => [12000, 12000 + delta].map((durationMs, side) => {
        const record = fixture(`invented-change-${index}-${side}`);
        const startedAt = `2026-01-${10 + index * 2 + side}T12:00:00.000Z`;
        record.userPrompt.sourceEventId = `invented-change-prompt-${index}-${side}`;
        record.userPrompt.sourceTimestamp = startedAt;
        record.followUpPrompts = [];
        Object.assign(record.toolCalls[0], { startedAt, durationMs,
            completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), completionEventId: `invented-change-end-${index}-${side}` });
        return record;
    }));
    const cleanup = [], errors = [], denied = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
    const saved = await browser.newPage();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    saved.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await saved.setContent("<main></main>");
    await saved.addScriptTag({ content: `const wording = (${createAssessmentWording.toString()})();
        const timing = (${createTimingPresentation.toString()})(() => {}, { compact: true });
        window.formatter = (${createReportComparison.toString()})(wording, timing.duration);` });
    for (const [index, [delta, expected]] of cases.entries()) {
        const from = `2026-01-${10 + index * 2}`, to = `2026-01-${11 + index * 2}`;
        await page.goto(runtime.url + `#analyze?compare=periods&aFrom=${from}&aTo=${from}&bFrom=${to}&bTo=${to}`);
        await page.locator("#createPeriodReport:visible").waitFor();
        await page.getByRole("button", { name: "Timing", exact: true }).click();
        await expect(page.locator(".compare-latency tbody tr").first()).toContainText(expected);
        const report = (id, value) => ({
            schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true,
            patternVersion: 1, toolRows: [], patterns: [],
            metrics: [{ metric: "speed", kind: "duration", definitionId: "tool-duration", definitionVersion: 1,
                unit: "ms", basis: "observed", aggregation: "median", boundary: "tool-start-to-completion",
                state: "available", value, coverage: { count: 1, eligible: 1 } }],
            scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic", callTimesAvailable: false, historyComplete: false },
        });
        const model = compareFrozenReportFacts(report("a", 12000), report("b", 12000 + delta));
        await saved.evaluate(model => window.formatter.render(document.querySelector("main"), model), model);
        await expect(saved.locator(".comparison-delta")).toHaveText(expected);
    }
});
