import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "../support/helpers.mjs";
import { metadata174Schema } from "../collection/copilot-metadata-fixture.mjs";
import { graphMatrixRecord } from "../reports/report-evidence-matrix-fixtures.mjs";

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
    return { page, runtime, root };
}

test("chart modes regroup the same calls, including paths behind Other, without changing the date filter", async t => {
    const { page } = await setup(t, records(true));
    const outcome = page.locator("#outcomeChart");
    for (const [key, count] of [["success", 33], ["failure", 4], ["unknown", 0]]) {
        await expect(outcome.locator(`li[data-category="${key}"]`)).toHaveAttribute("data-count", String(count));
        if (count) {
            const slice = outcome.locator(`path[data-category="${key}"]`);
            assert.ok(Math.abs(Number(await slice.getAttribute("data-exact-fraction")) - count / 37) < 1e-14);
        }
    }
    const sum = selector => page.locator(selector).evaluateAll(nodes => nodes.reduce((total, n) => total + Number(n.dataset.total), 0));
    for (const mode of ["workload", "endpoint", "time"]) {
        await openAnalyzeFilters(page);
        const choice = page.locator(`[data-chart="${mode}"]`);
        await choice.press("Enter"); await ready(page);
        await expect(choice).toHaveAttribute("aria-pressed", "true"); await expect(choice).toBeFocused();
        await closeAnalyzeFilters(page);
        const selector = mode === "time" ? ".flat-time-column" : ".flat-comparison-action";
        assert.equal(await sum(selector), 37);
        await expect(page.locator("#activityListSummary")).toHaveText("36 interactions · 37 matching tool calls");
        await expect(page.locator("#dateFilter")).toHaveValue("capture");
        if (mode === "endpoint") {
            const prior = await page.locator(selector).count();
            await page.getByRole("button", { name: "Show all", exact: true }).click();
            await expect.poll(() => page.locator(selector).count()).toBeGreaterThan(prior);
            assert.equal(await sum(selector), 37);
            const link = page.locator(selector).last();
            const key = await link.getAttribute("data-view-key"), total = await link.getAttribute("data-total");
            await link.press("Enter"); await ready(page); await expect(page.locator("#activityCount")).toHaveText(total);
            await page.goBack(); await ready(page);
            await expect(page.locator(`[data-view-key=${JSON.stringify(key)}]`)).toBeFocused();
        }
    }
});

test("daily, weekly and monthly links keep inclusive date membership and the same parent interactions", async t => {
    const { page, runtime } = await setup(t, records());
    const expected = [1, 3, 5, 7, 9, 11, 13].map(i => `request:composition-${i}`).sort();
    for (const bucket of ["day", "week", "month"]) {
        await page.goto(`${runtime.url}?bucket=${bucket}&range=custom&from=2026-10-07&to=2026-10-07`); await ready(page);
        await expect(page.locator("#activityCount")).toHaveText("8");
        assert.deepEqual(await page.locator("#activityList article").evaluateAll(rows => rows.map(r => r.dataset.viewKey).sort()), expected);
        assert.equal(await page.locator(".flat-time-column").evaluateAll(cols => cols.reduce((n,c) => n + Number(c.dataset.total), 0)), 8);
        await expect(page.locator("#dateFilter")).toHaveValue("custom");
    }
});

test("a failed change of chart mode keeps the accepted chart until the next successful read", async t => {
    const { page } = await setup(t, records());
    const gate = Promise.withResolvers();
    await page.route("**/api/snapshot", async r => { await gate.promise; await r.fulfill({ status: 503, json: { error: "Invented chart grouping read failure." } }); }, { times: 1 });
    await openAnalyzeFilters(page);
    try {
        await page.locator('[data-chart="endpoint"]').click();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        await expect(page.locator("#chartTitle")).toHaveText("Activity over time");
        await expect(page.locator('[data-chart="time"]')).toHaveAttribute("aria-pressed", "true");
    } finally { gate.resolve(); }
    await ready(page); await expect(page.locator("#message")).toContainText("Invented chart grouping read failure");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await page.locator('[data-chart="endpoint"]').click(); await ready(page);
    await expect(page.locator("#chartTitle")).toHaveText("Paths and operations");
    await expect(page.locator("#activityCount")).toHaveText("15");
    await expect(page.locator("#periodResult")).not.toContainText("Previous results");
});

test("Analyze keeps loading, read failures and retained stale data explicit", { timeout: 30000 }, async t => {
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
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await capture(page, "after-pending");
    finish();
    await ready(page);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented read failure for composition proof." } }));
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("Stored view not updated.");
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await expect(page.locator("#activityCount")).toHaveText("15");
    await capture(page, "after-stale-error");
    await page.reload();
    await expect(page.locator("#message")).toContainText("Invented read failure");
    await capture(page, "after-initial-error");
});

test("Analyze reads saved activity without treating Pause as a coverage failure", { timeout: 30000 }, async t => {
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
        await expect(page.locator("#analyzeRefresh")).toBeVisible();
        await expect(page.locator("#analyzeScopeError")).toBeHidden();
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
    await closeAnalyzeFilters(page);
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "false");
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await page.unroute("**/api/snapshot");
    await page.locator("#analyzeRefresh").click(); await ready(page);
    await expect(page.locator("#homeView")).toHaveAttribute("data-empty", "true");
    await expect(page.locator(".analyze-dashboard")).toBeHidden();
});
