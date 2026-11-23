import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, selectActivityOption, chooseTheme, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { scopeRecords } from "./analysis-scope-fixture.mjs";

const proofs = process.env.WIRE_ANALYZE_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const sorted = values => [...values].sort();
async function setup(t, records = scopeRecords()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    let providerCalls = 0, snapshot;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providerCalls++; throw new Error("No provider work in Analyze proof"); },
            readSource: async () => { providerCalls++; throw new Error("No scoring source reads in Analyze proof"); } } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const errors = [], denied = [], requests = [], urls = [];
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
    let allowPreview = false;
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)
            && !(allowPreview && ["/api/preview", "/api/cancel-preview"].includes(url.pathname))) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() === "POST") requests.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => urls.push(request.url()));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    t.after(async () => {
        try {
            const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(providerCalls, 0);
            assert.doesNotMatch(JSON.stringify(requests) + JSON.stringify(urls) + storage, /INVENTED_PARITY_NEEDLE|NO_ANALYZE_MATCH/);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, requests, snapshot: () => snapshot, preview: () => { allowPreview = true; } };
}
async function capture(page, name, selector) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await frames(page);
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    await writeFile(path.join(proofs, name + ".txt"), await page.locator(selector || "body").ariaSnapshot());
}
const rowIds = page => page.locator("#activityList article[data-view-key]").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey.slice(8)));

test("Results pages independent interactions from the same chat and restores the exact second-page link on Back", async t => {
    const records = scopeRecords();
    for (const r of records.slice(1, 3)) { r.sourceSessionId = records[0].sourceSessionId; r.sourceSessionName = records[0].sourceSessionName; }
    const { page } = await setup(t, records);
    await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions · 12 matching tool calls");
    const first = await rowIds(page);
    await expect(page.locator("#activityPager")).toContainText("1-8 of 10");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    const second = await rowIds(page);
    assert.deepEqual(sorted([...first, ...second]), Array.from({ length: 10 }, (_, i) => `parity-request-${i}`));
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const open = page.locator("#activityList .request-card-open").first();
    await open.scrollIntoViewIfNeeded(); await open.focus(); await frames(page);
    const before = await open.boundingBox(), address = page.url();
    await open.press("Enter"); await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:" + second[0]);
    await page.goBack(); await expect(open).toBeFocused();
    assert.equal(page.url(), address); assert.deepEqual(await rowIds(page), second);
    await expect.poll(async () => Math.abs((await open.boundingBox()).y - before.y)).toBeLessThan(3);
    await page.goForward(); await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:" + second[0]);
    await page.locator("#closeContextSidebar").click(); await expect(open).toBeFocused();
});

test("legacy entries preserve their filter scope; the exact call and report retain different populations", async t => {
    const app = await setup(t), { page, runtime } = app;
    for (const alias of ["home", "overview", "activity", "calls"]) {
        await page.goto(runtime.url + `#${alias}?services=Files&includeMissingService=false&authors=user`); await ready(page);
        assert.equal(new URL(page.url()).pathname, "/"); assert.equal(new URL(page.url()).hash, "");
        await expect(page.locator("#activityCount")).toHaveText("5");
        await expect(page.locator("#serviceFocusScope")).toContainText("Files only");
    }
    await page.goto(runtime.url); await ready(page);
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page); await closeAnalyzeFilters(page);
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 1 matching tool call");
    const link = page.getByRole("link", { name: "workiq-ask: open call", exact: true });
    await link.press("Enter");
    await expect(page.locator('[data-tool-call-id="parity-call-0-1"]')).toBeFocused();
    await expect(page.locator(".reader-call-row")).toHaveCount(3);
    await expect(page.locator(".action-context").filter({ hasText: "Outside current view" })).toHaveCount(2);
    await page.goBack(); await expect(link).toBeFocused();
    await navigateMain(page, "reports"); await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    await picker.getByRole("radio", { name: /^Current Analyze view/ }).check();
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    await expect(page.locator("#reportDeskDates")).toContainText(/All (retained )?dates/i);
    app.preview();
    const preparing = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
    const response = await preparing; assert.equal(response.status(), 200);
    const value = await response.json();
    assert.equal(value.snapshot.records.length, 1); assert.equal(value.snapshot.records[0].toolCalls.length, 3);
    assert.deepEqual(response.request().postDataJSON().selection.scenarioIds, ["parity-request-0"]);
});

test("unmatched Analyze filters keep one brief next action and reset restores matching records", async t => {
    const { page } = await setup(t, scopeRecords().slice(1, 3));
    await chooseTheme(page, "dark");
    const matching = await rowIds(page);
    assert.equal(matching.length, 2);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2020-01-01");
    await page.locator("#toFilter").fill("2020-01-02");
    await page.locator("#applyDates").click(); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    const empty = page.locator("#activityList .empty-state");
    await expect(empty.locator("h3")).toHaveText("No matching interactions");
    await empty.scrollIntoViewIfNeeded();
    await capture(page, "no-match-desktop", "#activityView");
    await expect(empty.locator("p")).toHaveText("Try different dates or clear a filter.");
    for (const [width, fontSize] of [[1280, ""], [375, "200%"]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
        await frames(page);
        const bounds = await empty.locator("p").evaluate(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = node.getBoundingClientRect(), lines = [...range.getClientRects()];
            return { lines: lines.length, contained: lines.every(line => line.left >= box.left - 1
                && line.right <= box.right + 1 && line.top >= box.top - 1 && line.bottom <= box.bottom + 1),
                overflow: node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight };
        });
        if (width === 1280) assert.equal(bounds.lines, 1, "Desktop needs only one supporting line");
        else assert.ok(bounds.lines > 1, "Narrow enlarged text wraps normally");
        assert.ok(bounds.contained, "The complete supporting text stays inside its paragraph");
        assert.equal(bounds.overflow, false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await empty.scrollIntoViewIfNeeded();
        await capture(page, `no-match-${width}`, "#activityView");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await openAnalyzeFilters(page);
    await page.locator("#resetView").click(); await ready(page);
    assert.deepEqual(await rowIds(page), matching);
});

test("empty source still exposes Analyze recovery and existing Reports and Settings", { timeout: 15000 }, async t => {
    const { page } = await setup(t, []);
    await expect(page.locator("#activityList")).toContainText("No collected activity yet");
    await expect(page.locator("#analyzeRefresh")).toHaveAccessibleName("Refresh");
    await expect(page.getByRole("link", { name: "Review source in Settings" })).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("0");
    await navigateMain(page, "reports"); await ready(page);
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator("#settingsView")).toBeVisible();
});
