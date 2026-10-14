import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, restoreLegacySearch, setLegacyTimeBucket } from "./helpers.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { graphMatrixRecord } from "./report-evidence-matrix-fixtures.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settle = page => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const proofDir = process.env.WIRE_COMPOSITION_PROOFS;
function records(dense = false) {
    return Array.from({ length: dense ? 36 : 14 }, (_, index) => {
        const record = fixture(`composition-${index}`);
        record.title = `Prepare ${index % 2 ? "meeting notes" : "project update"}`;
        record.userPrompt.text = `Find the ${index % 2 ? "meeting notes" : "project update"} for the invented lighthouse project.`;
        record.sourceSessionId = `composition-chat-${index % 2}`;
        record.sourceSessionName = index % 2 ? "Meeting preparation" : "Project updates";
        if (dense) record.project = "Invented cross-functional lighthouse operations and recurring planning project";
        record.capturedAt = `2026-10-${String(dense ? index % 28 + 1 : 6 + index % 2).padStart(2, "0")}T12:00:00.000Z`;
        const call = record.toolCalls[0];
        const endpoint = ["/me/messages", "/me/drive/root/children", "/me/calendarView"][index % 3];
        call.requestArgs = { entityUrls: [endpoint] };
        call.requestedApiPath = endpoint;
        call.toolSucceeded = index >= 4;
        call.reportedOutcome = index < 4 ? "failed" : "succeeded";
        call.tool = "workiq-fetch";
        call.completionEventId = `composition-complete-${index}`;
        call.startedAt = record.capturedAt;
        call.completedAt = record.capturedAt.replace(".000Z", ".050Z");
        call.durationMs = 50;
        if (dense) {
            call.requestedApiPath = endpoint + "/children/invented-folder".repeat(index % 5 + 1);
            call.requestArgs = { entityUrls: [call.requestedApiPath] };
        }
        if (index === 13) record.toolCalls.push({ ...call, toolCallId: "composition-extra", startEventId: "composition-extra-start", tool: "workiq-get_schema" });
        return record;
    });
}
async function capture(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await settle(page);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proofDir, `${name}-viewport.png`) });
    await page.screenshot({ path: path.join(proofDir, `${name}-full.png`), fullPage: true });
    await writeFile(path.join(proofDir, `${name}.txt`), await page.locator("body").ariaSnapshot());
}
async function setup(t, input) {
    const cleanup = [];
    const { root, context } = await privateFixture({ after: action => cleanup.push(action) }, input);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" &&
            !["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
                "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
                "/api/deletion/preview", "/api/deletion/cancel", "/api/period-comparison"].includes(url.pathname)) {
            denied.push(url.pathname);
            return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        assert.deepEqual(errors, []);
        assert.deepEqual(denied, []);
        const after = await loadBoardState(context);
        for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        for (const action of cleanup) await action();
    });
    await page.goto(runtime.url);
    await ready(page);
    await expect(page.locator("#homeInsights")).not.toHaveAttribute("aria-busy", "true");
    return { page, runtime, root };
}

test("chart modes regroup the same records without relocating the overview or its controls", { timeout: 60000 }, async t => {
    const { page } = await setup(t, records());
    const geometry = () => page.evaluate(() => {
        const box = selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height, bottom: rect.bottom + scrollY };
        };
        return {
            modes: box(".analyze-chart-main .view-switch"), outcome: box(".analyze-outcome-summary"),
            chart: box(".analyze-chart-main"), summaries: box("#percentageCharts"),
            tools: box('[data-percentage-card="tools"]'), services: box('[data-percentage-card="services"]'),
            reset: box("#resetView"), more: box("#moreFiltersToggle"), scroll: scrollY,
        };
    });
    for (const [width, textSize, theme] of [[1600, "", "light"], [1600, "", "dark"], [390, "", "dark"], [390, "200%", "light"]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, textSize);
        await page.locator('[data-chart="time"]').click(); await ready(page); await settle(page);
        const initial = await geometry();
        await expect(page.locator("#resetView")).toBeDisabled();
        assert.ok(initial.reset.height >= 44 && initial.more.height >= 44);
        assert.ok(initial.reset.x >= initial.more.x + initial.more.width || initial.reset.y >= initial.more.bottom,
            "The existing utility actions sit beside each other or wrap without overlap");
        const brokenWords = await page.locator("[data-chart]").evaluateAll(buttons => buttons.flatMap(button => {
            const text = button.firstChild, words = [...text.textContent.matchAll(/\S+/g)];
            return words.filter(word => {
                const range = document.createRange();
                range.setStart(text, word.index); range.setEnd(text, word.index + word[0].length);
                return range.getClientRects().length !== 1;
            }).map(word => word[0]);
        }));
        assert.deepEqual(brokenWords, [], "Mode labels wrap between words, not into narrow letter columns");
        for (const mode of ["workload", "endpoint", "time", "endpoint", "workload", "time"]) {
            const control = page.locator(`[data-chart="${mode}"]`);
            await control.focus();
            await page.keyboard.press("Enter"); await ready(page); await settle(page);
            await expect(control).toBeFocused();
            await expect(control).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator('[data-chart][aria-pressed="true"]')).toHaveCount(1);
            await expect(page.locator("#activityCount")).toHaveText("15");
            if (mode === "time") await expect(page.locator("#resetView")).toBeDisabled();
            else await expect(page.locator("#resetView")).toBeEnabled();
            const current = await geometry();
            for (const key of ["x", "y", "width"]) {
                assert.ok(Math.abs(current.modes[key] - initial.modes[key]) < 2, `${mode}: control ${key} stays anchored at ${width}/${textSize || "100%"}`);
                assert.ok(Math.abs(current.outcome[key] - initial.outcome[key]) < 2, `${mode}: outcomes ${key} stays anchored`);
                assert.ok(Math.abs(current.reset[key] - initial.reset[key]) < 2, `${mode}: existing reset ${key} stays anchored`);
            }
            assert.ok(Math.abs(current.summaries.width - initial.summaries.width) < 2, "Unchanged summaries keep the same columns");
            if (mode === "time") {
                await expect(page.locator("#bucketControl")).toHaveCount(0);
                await expect(page.locator("#chartTitle")).toHaveText("Activity over time");
                assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.dataset.total), 0)), 15);
            } else {
                await expect(page.locator("#bucketControl")).toHaveCount(0);
                await expect(page.locator("#chartTitle")).toHaveText(mode === "workload" ? "Activity categories" : "Paths and operations");
                assert.equal(await page.locator(".flat-comparison-action").evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.dataset.total), 0)), 15);
            }
            assert.ok(current.summaries.y >= current.chart.bottom, "Tool and service summaries consistently follow the chosen chart");
            if (width === 1600) {
                assert.ok(Math.abs(current.tools.y - current.services.y) < 2, "Tools and Services stay side by side");
                assert.ok(Math.abs(current.scroll - initial.scroll) < 2, "Switching modes does not move the reading position");
            }
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        }
        await capture(page, `mode-controls-${width}-${textSize || "normal"}-${theme}`);
    }
});

test("chart switching and drilldown Back keep private search, page, selection and applied mode", { timeout: 30000 }, async t => {
    const { page } = await setup(t, records());
    await page.locator("#activityList .request-row input").first().check();
    await restoreLegacySearch(page, "invented lighthouse");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    const resultIds = () => page.locator("#activityList .request-link").evaluateAll(nodes => nodes.map(node => new URLSearchParams(node.getAttribute("href").split("?")[1]).get("request")));
    const originalRows = await resultIds();
    for (const mode of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
        assert.deepEqual(await resultIds(), originalRows);
        await expect(page.locator("#activitySearch")).toHaveValue("invented lighthouse");
        await expect(page.locator("#activityPager")).toContainText("9-14");
        const action = page.locator(mode === "time" ? ".time-column" : ".flat-comparison-action").first();
        await action.focus();
        const key = await action.getAttribute("data-view-key");
        assert.ok(key, "The exact chart action has a stable restoration identity");
        const beforeScroll = await page.evaluate(() => scrollY);
        await page.keyboard.press("Enter"); await ready(page);
        if (mode === "time") assert.match(page.url(), /range=custom/);
        else assert.match(page.url(), mode === "workload" ? /service=/ : /endpoint=/);
        await page.goBack(); await ready(page); await settle(page);
        assert.deepEqual(await resultIds(), originalRows);
        await expect(page.locator("#activitySearch")).toHaveValue("invented lighthouse");
        await expect(page.locator(`[data-chart="${mode}"]`)).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#activityPager")).toContainText("9-14");
        await expect(page.locator("#activityClearSelection")).toBeEnabled();
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-view-key")), key);
        assert.ok(Math.abs(await page.evaluate(() => scrollY) - beforeScroll) < 2, "Drilldown Back restores the chart reading position");
    }
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator('[data-chart="time"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#activitySearch")).toHaveValue("");
    await expect(page.locator("#activityList .request-row input:checked")).toHaveCount(1);
    await expect(page.locator("#resetView")).toBeDisabled();
});

test("pending and failed mode reads never relabel the previous chart", { timeout: 30000 }, async t => {
    const { page } = await setup(t, records());
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        await gate;
        await route.fulfill({ status: 503, json: { error: "Invented chart grouping read failure." } });
    });
    await page.locator('[data-chart="endpoint"]').click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#chartTitle")).toHaveText("Activity over time");
    await expect(page.locator('[data-chart="time"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#chartGrouping")).toHaveCount(0);
    await capture(page, "mode-pending-retains-time");
    release(); await ready(page);
    await expect(page.locator("#message")).toContainText("Invented chart grouping read failure");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await expect(page.locator("#chartTitle")).toHaveText("Activity over time");
    await expect(page.locator("#activityCount")).toHaveText("15");
    await capture(page, "mode-error-retains-time");
    await page.unroute("**/api/snapshot");
    await page.locator('[data-chart="endpoint"]').click(); await ready(page);
    await expect(page.locator("#chartTitle")).toHaveText("Paths and operations");
    await expect(page.locator("#chartGrouping")).toHaveCount(0);
    await expect(page.locator("#periodResult")).not.toContainText("Previous results");
});

test("legacy bucket routes retain their grouping without becoming another date authority", { timeout: 30000 }, async t => {
    const { page } = await setup(t, records());
    let snapshot, input;
    await page.route("**/api/snapshot", async route => {
        input = route.request().postDataJSON();
        const response = await route.fetch();
        snapshot = await response.json();
        await route.fulfill({ response });
    });
    await page.reload(); await ready(page);
    const ids = () => snapshot.analytics.rows.map(row => row.id).sort();
    const widgetState = () => page.evaluate(() => ({
        outcomes: [...document.querySelectorAll("#outcomeChart [data-count]")].map(node => [node.dataset.category, node.dataset.count]),
        breakdowns: [...document.querySelectorAll("#percentageCharts [data-count]")].map(node => [node.dataset.category, node.dataset.count]),
        timing: [...document.querySelectorAll("#activityList .response-timing")].map(node => node.innerText),
        records: [...document.querySelectorAll("#activityList .request-link")].map(node => new URLSearchParams(node.hash.split("?")[1]).get("request")),
        summary: document.querySelector("#activityListSummary").innerText,
        currentReportScope: document.querySelector("#scopeCount-current").textContent,
    }));
    const allIds = ids(), allWidgets = await widgetState();
    await page.locator("#activityList .request-row input").first().check();
    await expect(page.locator("#dateFilter")).toHaveCount(1);
    const dateAuthority = await page.locator("#dateFilter").evaluate(node => node.closest("#analyzePopulation") !== null);
    assert.equal(dateAuthority, true, "The sole Dates authority stays above all widgets");
    const assertWidgetCounts = async () => {
        const total = snapshot.analytics.totals.count;
        await expect(page.locator("#activityCount")).toHaveText(String(total));
        await expect(page.locator("#outcomeChart .percentage-denominator")).toContainText(String(total));
        await expect(page.locator("#recordedTiming")).toHaveCount(0);
        await expect(page.locator("#activityList .response-timing")).toHaveCount(await page.locator("#activityList .request-row").count());
        const sum = await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((value, node) => value + Number(node.dataset.total), 0));
        assert.equal(sum, total - snapshot.analytics.timeSeries.undatedCount);
        assert.deepEqual(snapshot.analytics.timeSeries.points.flatMap(point => point.drilldownIds).sort(), ids());
        await page.locator("#meaning > summary").click();
        await expect(page.locator("#countTable tfoot td").first()).toHaveText(String(total));
        await expect(page.locator("#percentageData .percentage-table tfoot td:first-of-type")).toHaveText([String(total), String(total), String(total)]);
        await page.locator("#meaning > summary").click();
    };
    for (const bucket of ["day", "week", "month", "day"]) {
        await setLegacyTimeBucket(page, bucket); await ready(page);
        assert.deepEqual(ids(), allIds);
        assert.deepEqual(input.filters, { scope: "history", includeMetadata: false });
        assert.deepEqual(await widgetState(), allWidgets, "Grouping changes only the time widget");
        await expect(page.locator("#filterChips")).toBeEmpty();
        await expect(page.locator("#resetView")).toBeDisabled();
        await assertWidgetCounts();
    }
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-10-07"); await page.locator("#toFilter").fill("2026-10-07");
    await page.locator("#applyDates").click(); await ready(page);
    const scopedIds = ids(), scopedWidgets = await widgetState();
    assert.equal(scopedIds.length, 8);
    assert.match(scopedWidgets.currentReportScope, /^7 /, "Current-view report scope uses the shared range, not the time grouping");
    assert.ok(scopedIds.every(id => allIds.includes(id)));
    await expect(page.locator("#filterChips button")).toHaveCount(1);
    await expect(page.locator("#filterChips button")).toHaveAttribute("aria-label", /^Remove date filter:/);
    await assertWidgetCounts();
    for (const bucket of ["week", "day"]) {
        await setLegacyTimeBucket(page, bucket); await ready(page);
        assert.deepEqual(ids(), scopedIds);
        assert.deepEqual(await widgetState(), scopedWidgets);
        assert.equal(input.filters.from, "2026-10-07"); assert.equal(input.filters.to, "2026-10-07");
        await expect(page.locator("#filterChips button")).toHaveCount(1);
        await assertWidgetCounts();
    }
    for (const mode of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
        assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
        await expect(page.locator("#filterChips button")).toHaveCount(1);
        assert.deepEqual(ids(), scopedIds);
    }
    await page.locator("#pageAction").click(); await ready(page);
    await page.locator('[name="reportScope"][value="current"]').check();
    await expect(page.locator("#scopeCount-current")).toHaveText(scopedWidgets.currentReportScope);
    await page.goBack(); await ready(page);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    assert.deepEqual(ids(), scopedIds);
    const beforeReset = page.url();
    await page.locator("#resetView").click(); await ready(page);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    await expect(page.locator("#dateFilter")).toHaveValue("capture");
    await expect(page.locator("#resetView")).toBeDisabled();
    await expect(page.locator("#filterChips")).toBeEmpty();
    await expect(page.locator("#activityList .request-row input:checked")).toHaveCount(1);
    assert.deepEqual(ids(), allIds);
    await page.goBack(); await ready(page); await settle(page);
    assert.equal(page.url(), beforeReset);
    assert.deepEqual(ids(), scopedIds);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    await expect(page.locator("#filterChips button")).toHaveCount(1);
    await expect(page.locator("#resetView")).toBeEnabled();
    await page.goForward(); await ready(page); await settle(page);
    assert.deepEqual(ids(), allIds);
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    await expect(page.locator("#resetView")).toBeDisabled();
    const column = page.locator(".time-column").first();
    await column.focus();
    const before = await page.evaluate(() => ({ key: document.activeElement.dataset.viewKey, scroll: scrollY }));
    const members = snapshot.analytics.timeSeries.points[0].drilldownIds.slice().sort();
    await page.keyboard.press("Enter"); await ready(page);
    assert.deepEqual(ids(), members, "Clicking a dated column applies a real shared date filter");
    await expect(page.locator("#filterChips button")).toHaveCount(1);
    await expect(page.locator("#filterChips button")).toHaveAttribute("aria-label", /^Remove date filter:/);
    await assertWidgetCounts();
    await page.goBack(); await ready(page); await settle(page);
    assert.deepEqual(ids(), allIds);
    await expect(page.locator("#filterChips")).toBeEmpty();
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), before.key);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - before.scroll) < 2);
    await page.keyboard.press("Enter"); await ready(page);
    await page.locator("#filterChips button").click(); await ready(page);
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("bucket"), "day");
    await expect(page.locator("#filterChips")).toBeEmpty();
    await expect(page.locator("#resetView")).toBeDisabled();
    assert.deepEqual(ids(), allIds, "Clearing the global date chip retains local grouping and restores membership");
    await capture(page, "widget-grouping-independent");
});

test("Analyze composes exact sparse outcomes with time and keeps filter and record journeys", { timeout: 90000 }, async t => {
    const { page } = await setup(t, records());
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await capture(page, `${process.env.WIRE_LAYOUT_BASELINE ? "before" : "after"}-sparse-${theme}`);
        await page.setViewportSize({ width: 2000, height: 1220 });
        await capture(page, `${process.env.WIRE_LAYOUT_BASELINE ? "before" : "after"}-wide-${theme}`);
        await page.setViewportSize({ width: 1600, height: 1000 });
    }
    if (process.env.WIRE_LAYOUT_BASELINE) return;
    await expect(page.locator("#activityCount")).toHaveText("15");
    const outcome = page.locator('[data-percentage-card="outcomes"]');
    await expect(outcome.locator('li[data-category="success"]')).toHaveAttribute("data-count", "11");
    await expect(outcome.locator('li[data-category="failure"]')).toHaveAttribute("data-count", "4");
    await expect(outcome.locator('li[data-category="unknown"]')).toHaveAttribute("data-count", "0");
    const geometry = await page.evaluate(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { outcome: box("#outcomeChart"), time: box(".analyze-chart-main"), legend: box('[data-breakdown="outcomes"] .percentage-legend'), ring: box(".percentage-visual") };
    });
    assert.ok(Math.abs(geometry.outcome.y - geometry.time.y) < 2);
    assert.ok(geometry.legend.x - geometry.ring.right < 30, "Labels remain beside the donut");
    assert.ok(geometry.outcome.width < geometry.time.width, "Time view gets the wider column");
    for (const slice of await outcome.locator(".percentage-slice").all()) {
        const data = await slice.evaluate(node => ({ start: +node.dataset.start, end: +node.dataset.end, count: +node.dataset.count }));
        assert.ok(Math.abs(data.end - data.start - data.count / 15) < 1e-14);
    }
    await setLegacyTimeBucket(page, "day");
    await capture(page, "after-two-days-light");
    await expect(page.locator(".time-column")).toHaveCount(2);
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(page.locator("#homeInsights .assessment-summary")).toBeVisible();
    const definitions = page.locator("#homeInsights [data-insight-details]");
    await definitions.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Insight details", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "Insight details", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(definitions).toBeFocused();
    await capture(page, "after-expanded-review");
    await page.locator("#analyzeReviewDetails > summary").click();
    const sourceHelp = page.locator("#freshHelp > summary");
    await sourceHelp.scrollIntoViewIfNeeded();
    const sourceHelpBefore = await sourceHelp.boundingBox();
    await sourceHelp.click();
    const sourceHelpAfter = await sourceHelp.boundingBox();
    assert.ok(Math.abs(sourceHelpBefore.y - sourceHelpAfter.y) < 2, "Source disclosure stays anchored");
    await expect(page.locator("#activityDeleteShortcut")).toBeVisible();
    await capture(page, "after-source-help");
    await page.locator("#activityDeleteShortcut").click();
    await expect(page.locator("#deleteCancel")).toBeFocused();
    await page.locator("#deleteAll").check();
    await page.locator("#deletePreview").click();
    await expect(page.locator("#deleteConfirmation")).toBeVisible();
    await expect(page.locator("#deleteConfirm")).toHaveText("Delete 15 records");
    await page.keyboard.press("Escape");
    await expect(page.locator("#activityDeleteShortcut")).toBeFocused();
    await page.locator("#freshHelp > summary").click();
    const trigger = page.locator('[data-select-id="outcomeFilter"]');
    await trigger.click();
    await page.locator('.select-option[data-value="success"]').click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#activityCount")).toHaveText("15");
    await selectActivityOption(page, "outcomeFilter", "failure");
    await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("4");
    await page.locator("#resetView").click();
    await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("15");
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparison")).toBeVisible();
    await page.locator("#periodComparison").getByRole("button", { name: "Stop comparing", exact: true }).click();
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#comparePeriods")).toBeFocused();
    await page.locator("#resultsLink").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#activityTitle")).toBeFocused();
    await page.locator("#activityList .request-link").first().click();
    await ready(page);
    await expect(page.locator("#requestView")).toBeVisible();
    await page.locator("#contextBack").click();
    await ready(page);
    await expect(page.locator("#homeView")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 900 });
        await capture(page, `after-narrow-${theme}`);
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await capture(page, `after-narrow-200-${theme}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
});

test("Analyze dense and empty populations keep their own counts and readable bounds", { timeout: 60000 }, async t => {
    if (process.env.WIRE_LAYOUT_BASELINE) return;
    const { page } = await setup(t, records(true));
    await expect(page.locator("#activityCount")).toHaveText("37");
    await setLegacyTimeBucket(page, "day");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(page, `after-dense-${theme}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.locator('[data-chart="endpoint"]').click();
    await ready(page);
    await expect(page.locator(".flat-comparison-action").first()).toBeVisible();
    const pathCount = await page.locator(".flat-comparison-action").count();
    const total = () => page.locator(".flat-comparison-action").evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.dataset.total), 0));
    assert.equal(await total(), 37);
    const outcomes = await page.locator(".analyze-outcome-summary").boundingBox();
    const paths = await page.locator(".analyze-chart-main").boundingBox();
    const breakdowns = await page.locator("#percentageCharts").boundingBox();
    assert.ok(Math.abs(outcomes.height - paths.height) < 2, "The paired widgets share row edges even when path content grows");
    assert.ok(breakdowns.y >= paths.y + paths.height, "Tools and Services remain below the chart row in every mode");
    assert.ok(breakdowns.y - (paths.y + paths.height) < 24, "The following row uses normal spacing, not reserved chart filler");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(page, `after-long-paths-${theme}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    const tabTop = await page.locator('[data-chart="endpoint"]').evaluate(node => node.getBoundingClientRect().top + scrollY);
    await page.locator("#chartFooter").getByRole("button", { name: "Show all", exact: true }).click();
    await ready(page);
    await capture(page, "after-all-paths");
    await expect.poll(() => page.locator(".flat-comparison-action").count()).toBeGreaterThan(pathCount);
    assert.equal(await total(), 37);
    assert.ok(Math.abs(await page.locator('[data-chart="endpoint"]').evaluate(node => node.getBoundingClientRect().top + scrollY) - tabTop) < 2);
    const chartScroll = page.locator(".flat-comparison");
    assert.ok(await chartScroll.evaluate(node => node.scrollHeight > node.clientHeight));
    await page.locator(".flat-comparison-action").last().focus();
    assert.ok(await chartScroll.evaluate(node => {
        const root = node.getBoundingClientRect(), target = document.activeElement.getBoundingClientRect();
        return target.top >= root.top && target.bottom <= root.bottom + 1;
    }));
    await page.locator(".flat-comparison-action").last().locator(".flat-comparison-segment").hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(page.getByRole("tooltip")).toContainText("1 of 1");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("37");
    await page.locator("#activityList .request-row input").first().check();
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2020-01-01");
    await page.locator("#toFilter").fill("2020-01-02");
    await page.locator("#applyDates").click();
    await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityList")).toContainText("No matching interactions");
    await expect(page.locator("#activityList .empty-state p")).toHaveText("Change filters or reset Analyze.");
    await expect(page.locator("#homeView .analyze-chart-grid")).toBeHidden();
    await expect(page.locator("#percentageCharts")).toBeHidden();
    await expect(page.locator("#homeView .analyze-review")).toBeHidden();
    await expect(page.locator("#periodCoverage")).toBeVisible();
    await expect(page.locator("#activityListSummary")).toBeHidden();
    await expect(page.locator("#activityClearSelection")).toBeEnabled();
    await expect(page.locator("#pageAction")).toBeVisible();
    await expect(page.locator("#resetView")).toBeVisible();
    await expect(page.locator("#meaning > summary")).toBeVisible();
    await page.locator("#meaning > summary").click();
    await expect(page.locator("#percentageData .percentage-table tfoot td:first-of-type")).toHaveText(["0", "0", "0"]);
    await page.locator("#meaning > summary").click();
    assert.equal(await page.locator("#workspace .empty-state").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).length), 1);
    await capture(page, "after-empty");
    for (const theme of ["light", "dark"]) for (const width of [1600, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(width => { document.documentElement.style.fontSize = width === 375 ? "200%" : ""; }, width);
        await capture(page, `after-empty-${theme}-${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("37");
    await expect(page.locator("#homeView .analyze-chart-grid")).toBeVisible();
    await expect(page.locator("#percentageCharts")).toBeVisible();
    await expect(page.locator("#homeView .analyze-review")).toBeVisible();
    await expect(page.locator("#activityList .request-row input:checked")).toHaveCount(1);
});

test("Analyze keeps loading, read failures and retained stale data explicit", { timeout: 30000 }, async t => {
    if (process.env.WIRE_LAYOUT_BASELINE) return;
    const { page } = await setup(t, records());
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => { await gate; await route.continue(); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#loading")).toBeVisible();
    await capture(page, "after-loading");
    release();
    await ready(page);
    await page.unroute("**/api/snapshot");
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    await page.route("**/api/snapshot", async route => { await pending; await route.continue(); });
    await page.locator("#checkActivity").click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await capture(page, "after-pending");
    finish();
    await ready(page);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented read failure for composition proof." } }));
    await page.locator("#checkActivity").click();
    await expect(page.locator("#message")).toContainText("Invented read failure");
    await expect(page.locator("#activityCount")).toHaveText("15");
    await capture(page, "after-stale-error");
    await page.reload();
    await expect(page.locator("#message")).toContainText("Invented read failure");
    await capture(page, "after-initial-error");
});

test("Analyze keeps paused and enabled collection status visible without collecting", { timeout: 30000 }, async t => {
    if (process.env.WIRE_LAYOUT_BASELINE) return;
    const { page, runtime, root } = await setup(t, records());
    const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    await mkdir(sessionRoot);
    const db = new DatabaseSync(appDbPath);
    db.exec(metadata174Schema);
    db.close();
    const config = { appDbPath, sessionRoot, approved: true, enabled: false, pollSeconds: 5, windowDays: 30 };
    await runtime.collector.configure(config);
    for (const enabled of [false, true]) {
        await runtime.collector.setEnabled(enabled);
        await page.reload(); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("15");
        await expect(page.locator("#checkActivity")).toBeVisible();
        if (!enabled) await expect(page.locator("#collectionNotice")).toContainText("paused");
        await capture(page, enabled ? "after-collection-enabled" : "after-collection-paused");
    }
});

test("zero tool calls do not hide other evidence units or mislabel stale results as current", { timeout: 30000 }, async t => {
    const { page } = await setup(t, [graphMatrixRecord("empty-tool-nonempty-graph")]);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await selectActivityOption(page, "layerFilter", "direct-request"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "false");
    await expect(page.locator(".analyze-dashboard")).toBeVisible();
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await capture(page, "after-nonempty-graph");
    await selectActivityOption(page, "layerFilter", "tool"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented empty-state read failure." } }));
    await page.locator("#checkActivity").click();
    await expect(page.locator("#message")).toContainText("Invented empty-state read failure");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "false");
    await expect(page.locator("#periodHint")).toBeVisible();
    await page.unroute("**/api/snapshot");
    await page.locator("#checkActivity").click(); await ready(page);
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await expect(page.locator(".analyze-dashboard")).toBeHidden();
});
