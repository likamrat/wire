import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption, restoreLegacySearch } from "./helpers.mjs";
import { modelRecords, modelNames } from "./model-widget-fixture.mjs";

const proof = process.env.WIRE_MODEL_PROOFS;
test("normal Analyze entry keeps Model counts, coverage and layout within the shared analytical scope", { timeout: 90000 }, async t => {
    const cleanup = [], records = modelRecords(), original = structuredClone(records);
    const { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context), errors = [], denied = [], evidence = [];
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, search: { modelDirectory: path.join(root, "not-provisioned"), heartbeatMs: 60000 },
        evaluation: { evaluatorFactory: () => { throw Error("No evaluator in Model visualization proof"); } },
    });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || reads.includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        const after = await loadBoardState(context);
        for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        for (const fn of cleanup) await fn();
        assert.deepEqual(records, original);
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    });
    await page.clock.setFixedTime(new Date("2026-10-14T18:00:00Z"));
    await page.goto(runtime.url);
    const ready = async () => {
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    };
    await ready();
    const widget = page.locator('[data-percentage-card="models"]');
    const exact = async (name, total, counts, calls) => {
        await ready();
        await expect(widget).toHaveAttribute("data-total", String(total));
        await expect(page.locator("#activityCount")).toHaveText(String(calls));
        const rows = await widget.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            model: node.dataset.category, count: Number(node.dataset.count),
            fraction: Number(node.querySelector(".percentage-bar").dataset.fraction),
        })));
        assert.deepEqual(Object.fromEntries(rows.map(row => [row.model, row.count])), counts);
        for (const row of rows) assert.equal(row.fraction, row.count / total);
        const chartCalls = await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.dataset.total), 0));
        assert.equal(chartCalls, calls);
        evidence.push({ name, total, calls, rows, coverage: await widget.locator(".percentage-model-coverage").allTextContents() });
    };
    const allCounts = { [modelNames[1]]: 2, [modelNames[0]]: 2, [modelNames[2]]: 1, [modelNames[3]]: 1 };
    await expect(widget.locator("h3")).toHaveText("Model");
    await exact("all", 9, allCounts, 11);
    await expect(widget.locator(".percentage-model-coverage")).toHaveText("1 partial / 2 not recorded / 2 not verified / 1 conflicting");
    assert.equal(await widget.locator("a,button,svg").count(), 0, "No inexact drilldown or overlapping pie");
    assert.equal(await page.locator("#dateFilter").count(), 1);
    for (const [value, total, counts, calls] of [
        ["day", 4, { [modelNames[0]]: 2, [modelNames[1]]: 1 }, 6],
        ["week", 7, allCounts, 9],
        ["month", 8, allCounts, 10],
    ]) {
        await selectActivityOption(page, "dateFilter", value);
        await exact(value, total, counts, calls);
    }
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-10-12");
    await page.locator("#toFilter").fill("2026-10-12");
    await page.locator("#applyDates").click();
    await exact("custom", 1, { [modelNames[2]]: 1 }, 1);
    await page.locator("#fromFilter").fill("2026-09-30");
    await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click();
    await exact("historical absence is coverage", 1, {}, 1);
    await expect(widget.locator(".percentage-model-coverage")).toHaveText("1 not recorded");
    await page.locator("#resetView").click();
    await exact("reset dates", 9, allCounts, 11);
    await selectActivityOption(page, "outcomeFilter", "failure");
    await selectActivityOption(page, "serviceAssociationFilter", "Mail");
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await exact("filter intersection", 1, { [modelNames[0]]: 1 }, 1);
    await page.locator("#resetView").click();
    await restoreLegacySearch(page, "Invented model instruction 1");
    await exact("one multi-model interaction", 1, { [modelNames[1]]: 1, [modelNames[0]]: 1 }, 1);
    await restoreLegacySearch(page, "no-invented-model-match");
    await ready();
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await expect(widget).toBeHidden();
    await expect(widget).toHaveAttribute("data-total", "0");
    await page.locator("#resetView").click();
    await exact("reset no-match", 9, allCounts, 11);
    await page.locator("#meaning>summary").click();
    const data = page.locator('[data-view-key="percentage:models:exact"]');
    await expect(data.locator("tbody tr")).toHaveCount(4);
    assert.deepEqual(await data.locator("tbody th").allTextContents(), Object.keys(allCounts));
    await expect(data.locator("caption")).toContainText("model counts can overlap");
    await page.locator("#meaning>summary").click();
    let release;
    await page.route("**/api/snapshot", async route => {
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented Model snapshot failure" }) });
    });
    await selectActivityOption(page, "dateFilter", "day");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(widget).toHaveAttribute("data-total", "9");
    await expect.poll(() => typeof release).toBe("function");
    release();
    await ready();
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await expect(widget).toHaveAttribute("data-total", "9");
    await page.unroute("**/api/snapshot");
    await selectActivityOption(page, "dateFilter", "day");
    await exact("retry scope change", 4, { [modelNames[0]]: 2, [modelNames[1]]: 1 }, 6);
    await page.locator("#resetView").click();
    await exact("reset failed scope change", 9, allCounts, 11);
    for (const [width, textSize, theme] of [[1600, "", "dark"], [1600, "", "light"], [1100, "", "dark"], [390, "", "dark"], [390, "200%", "light"]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; scrollTo(0, 0); }, textSize);
        await ready();
        const geometry = await page.evaluate(() => {
            const box = selector => {
                const rect = document.querySelector(selector).getBoundingClientRect();
                return { x: rect.x, y: rect.y + scrollY, width: rect.width, bottom: rect.bottom + scrollY };
            };
            return { tools: box('[data-breakdown="tools"]'), services: box('[data-breakdown="services"]'),
                models: box('[data-breakdown="models"]'), outcome: box(".analyze-outcome-summary"), chart: box(".analyze-chart-main"),
                overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        assert.equal(geometry.overflow, false);
        if (width === 1600) {
            assert.ok(Math.abs(geometry.models.y - geometry.tools.y) < 2);
            assert.ok(Math.abs(geometry.models.width - geometry.services.width) < 2);
        } else if (width === 1100) assert.ok(geometry.models.y >= Math.max(geometry.tools.bottom, geometry.services.bottom));
        else assert.ok(geometry.models.y >= geometry.services.bottom);
        const clipped = await widget.locator(".percentage-label,.percentage-value,.percentage-denominator").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
        assert.deepEqual(clipped, [], "Exact model labels and counts wrap without clipping");
        evidence.push({ name: `${width}-${textSize || "normal"}-${theme}`, geometry });
        if (proof) {
            await mkdir(proof, { recursive: true });
            const name = `${width}-${textSize || "normal"}-${theme}`;
            await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
            await page.locator(".analyze-dashboard").screenshot({ path: path.join(proof, `${name}-widgets.png`) });
            await writeFile(path.join(proof, `${name}.txt`), await page.locator("body").ariaSnapshot());
        }
    }
    if (proof) await writeFile(path.join(proof, "numerical-and-layout.json"), JSON.stringify(evidence, null, 2));
});
