import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, selectActivityOption, revealStoredRefresh, chooseTheme, restoreLegacySearch, revealAnalyzeRecords } from "./helpers.mjs";
import { chooseReportScope, reportContents, cancelReportPreview } from "./report-journey-helpers.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";

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
async function rowIds(page, calls = false) {
    return page.locator(calls ? "#activityList .matched-action" : "#activityList .request-row")
        .evaluateAll((nodes, calls) => nodes.map(node => calls ? node.dataset.actionId : node.dataset.viewKey.slice(8)), calls);
}

test("normal Analyze entry directly opens exact interactions and restores query, pages, selection, focus and reports", { timeout: 60000 }, async t => {
    const records = scopeRecords();
    // Several interactions in one chat must still occupy independent outer rows.
    for (const record of records.filter(record => ["parity-request-1", "parity-request-2"].includes(record.scenarioId))) {
        record.sourceSessionId = "parity-chat-0"; record.sourceSessionName = "Invented parity chat 0";
    }
    const app = await setup(t, records), { page } = app;
    await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    await expect(page.locator(".primary-navigation a")).toHaveText(["Analyze", "Reports", "Settings"]);
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(page.locator(".session-toggle")).toHaveCount(0);
    await expect(page.locator("#activityList .request-row")).toHaveCount(8);
    await expect(page.locator("#activityCount")).toHaveText("12");
    await expect(page.locator("#homeInsights .assessment-scope")).toContainText("all their recorded calls");
    await capture(page, "analyze-desktop-overview");
    await page.locator("#percentageCharts").scrollIntoViewIfNeeded();
    await capture(page, "analyze-desktop-chart-summaries", "#homeView");
    await page.locator("#analyzeReviewDetails > summary").click();
    await page.locator("#homeInsights").scrollIntoViewIfNeeded();
    await capture(page, "analyze-desktop-interaction-insights", "#homeInsights");
    await page.locator("#analyzeReviewDetails > summary").click();
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityTitle")).toBeFocused();
    assert.match(page.url(), /#analyze$/);
    await restoreLegacySearch(page, privateQuery);
    await expect(page.locator("#activityCount")).toHaveText("11");
    await expect(page.locator("#activityListSummary")).toContainText("9 interactions with 11 matching Work IQ tool calls");
    const first = await rowIds(page);
    const chosen = page.locator('.request-row[data-view-key="request:parity-request-0"]');
    await chosen.locator("input").check();
    await expect(chosen).toContainText("Invented parity chat 0");
    await expect(chosen).toContainText("workiq-fetch");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#activityPager")).toContainText("9-9 of 9 interactions");
    const second = await rowIds(page);
    assert.deepEqual(sorted([...first, ...second]), Array.from({ length: 9 }, (_, i) => `parity-request-${i}`));
    const open = page.locator("#activityList .request-link").first();
    await open.focus(); await frames(page);
    const before = await open.boundingBox(), beforeURL = page.url(), target = second[0];
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:" + target);
    await expect(page.locator("#requestView")).toBeVisible();
    await page.goBack(); await ready(page); await frames(page);
    assert.equal(page.url(), beforeURL);
    await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
    await expect(page.locator("#activityList .request-link").first()).toBeFocused();
    assert.ok(Math.abs((await page.locator("#activityList .request-link").first().boundingBox()).y - before.y) < 3);
    await page.goForward(); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:" + target);
    await page.locator("#contextBack").click(); await ready(page);
    await expect(page.locator("#activityPager")).toContainText("9-9 of 9 interactions");
    await page.locator("#activityPager").getByRole("button", { name: "Previous", exact: true }).click();
    await expect(chosen.locator("input")).toBeChecked();
    await capture(page, "analyze-desktop-results", "#activityView");

    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await selectActivityOption(page, "promptAuthorFilter", "user"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches; 1 context-only");
    assert.deepEqual(sorted(await rowIds(page)), ["parity-request-0", "parity-request-6"]);
    const snapshotReads = app.requests.filter(request => request.path === "/api/snapshot").length;
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    assert.deepEqual(sorted(await rowIds(page, true)), sorted(app.snapshot().analytics.rows.map(row => row.id)));
    assert.equal(app.requests.filter(request => request.path === "/api/snapshot").length, snapshotReads);
    await expect(page.locator(".service-context-label")).toHaveCount(1);
    await page.locator("#activityList .matched-action").filter({ hasText: "Invented parity chat 0" }).first().locator(".request-link").click(); await ready(page);
    await expect(page.locator("#requestView")).toContainText("Outside current view");
    await page.goBack(); await ready(page);
    await expect(page.locator('[data-analyze-mode="calls"]')).toHaveAttribute("aria-current", "true");

    await navigateMain(page, "reports"); await ready(page);
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await page.locator("#reportCreateLink").click();
    await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current")).toHaveText("2 request groups");
    await expect(page.locator("#scopeSummary")).toContainText("4 Work IQ tool calls");
    await expect(page.locator("#reportMatchingContext")).toContainText("3 matching Work IQ tool calls");
    app.preview();
    await reportContents(page);
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    assert.equal((await previewResponse).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.deepEqual(sorted(app.requests.findLast(request => request.path === "/api/preview").body.selection.scenarioIds),
        ["parity-request-0", "parity-request-6"]);
    await cancelReportPreview(page);
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator("#settingsView")).toBeVisible();
    await navigateMain(page, "reports");
    await expect(page.locator("#reportCreateLink")).toHaveText("Continue draft");
    await page.locator("#reportCreateLink").click();
    await expect(page.locator("#scopeCount-current")).toHaveText("2 request groups");
    await navigateMain(page, "analyze"); await ready(page);
    await page.locator('[data-analyze-mode="interactions"]').click();
    await restoreLegacySearch(page, "NO_ANALYZE_MATCH");
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityList")).toContainText("No matching interactions");
    await navigateMain(page, "reports"); await page.locator("#reportCreateLink").click();
    await chooseReportScope(page, "selected");
    await expect(page.locator("#scopeCount-selected")).toHaveText("1 request group");
    await navigateMain(page, "analyze"); await ready(page);
    await page.reload(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue("NO_ANALYZE_MATCH");
    assert.doesNotMatch(page.url(), /NO_ANALYZE_MATCH|INVENTED_PARITY_NEEDLE/);
});

test("legacy scopes, Calls paging, retained stale results and narrow keyboard entry remain usable", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, runtime } = app;
    for (const alias of ["home", "overview", "activity", "calls"]) {
        await page.goto(runtime.url + `#${alias}?services=Files&includeMissingService=false&authors=user&page=0`);
        await ready(page);
        await expect(page.locator("#pageTitle")).toHaveText("Analyze");
        assert.match(page.url(), /#analyze\?/);
        await expect(page.locator("#serviceFocusScope")).toContainText("Files only");
        await expect(page.locator("#activityCount")).toHaveText("5");
        await expect(page.locator(`[data-analyze-mode="${alias === "calls" ? "calls" : "interactions"}"]`)).toHaveAttribute("aria-current", "true");
    }
    await page.goto(runtime.url + "#activity?session=parity-chat-0&result=failure"); await ready(page);
    await expect(page.locator('[data-analyze-mode="calls"]')).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#activityList .matched-action")).toHaveCount(2);
    await page.goto(runtime.url + "#calls"); await ready(page);
    const first = await rowIds(page, true);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    assert.deepEqual(sorted([...first, ...await rowIds(page, true)]), sorted(app.snapshot().analytics.rows.map(row => row.id)));
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityPager")).toContainText("1-8 of 12");
    const revision = app.snapshot().revision, ids = await rowIds(page, true);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), body = await response.json();
        body.revision = revision - 1; body.analytics.revision = body.revision;
        await route.fulfill({ response, json: body });
    });
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#message")).toContainText("older snapshot was rejected");
    assert.deepEqual(await rowIds(page, true), ids);
    await expect(page.locator("#homeView")).toHaveAttribute("data-revision", String(revision));
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await page.goto(runtime.url); await ready(page);
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "analyze-narrow-dark-overview");
    await revealAnalyzeRecords(page);
    await capture(page, "analyze-narrow-dark-results", "#activityView");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await frames(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const node of await page.locator("#navigationToggle").all()) {
        assert.ok((await node.boundingBox()).height >= 44);
        await expect(node).toBeVisible();
    }
    await page.locator(".skip-link").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toBeFocused();
    await capture(page, "analyze-narrow-dark-200-overview");
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await expect(page.locator("#analyzeModes")).toBeInViewport();
    await page.locator("#activityList .request-link").first().focus();
    const target = (await rowIds(page))[0];
    const touch = await page.locator(".interaction-select").first().boundingBox();
    assert.ok(touch.width >= 44 && touch.height >= 44);
    await capture(page, "analyze-narrow-dark-200-results", "#activityView");
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", "request:" + target);
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityList .request-link").first()).toBeFocused();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator("#settingsView")).toBeVisible();
    await navigateMain(page, "reports"); await ready(page);
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
});

test("list population summaries stay concise without changing paging, filtered boundaries or native entry", async t => {
    const app = await setup(t), { page } = app;
    page.screenshot = () => { throw new Error("No captures in the list entry and Back proof."); };
    const summary = page.locator("#activityListSummary");
    await expect(summary).toHaveText("10 interactions with 12 matching Work IQ tool calls");
    await expect(page.locator("#activityPager")).toContainText("1-8 of 10 interactions");
    const first = await rowIds(page);
    await page.locator('#activityList [data-view-key="request:parity-request-1"] input').check();
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    assert.deepEqual(sorted([...first, ...await rowIds(page)]), Array.from({ length: 10 }, (_, i) => `parity-request-${i}`));
    await expect(summary).toHaveText("10 interactions with 12 matching Work IQ tool calls");
    await restoreLegacySearch(page, privateQuery);
    await expect(summary).toHaveText("9 interactions with 11 matching Work IQ tool calls");
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(summary).toHaveText("3 interactions with 4 matching Work IQ tool calls");
    assert.deepEqual(sorted(await rowIds(page)), ["parity-request-0", "parity-request-3", "parity-request-6"]);
    await selectActivityOption(page, "toolFilter", "workiq-ask"); await ready(page);
    await expect(summary).toHaveText("1 interaction with 1 matching Work IQ tool call");
    await expect(page.locator(".card-result-scope")).toHaveText("1 of 3 Work IQ tool calls in this view");
    await expect(page.locator("#activitySelectionCompact")).toContainText("1 in report");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(summary).toHaveText("1 Work IQ tool call from 1 interaction.");
    assert.deepEqual(await rowIds(page, true), ['call:["parity-chat-0","parity-call-0-1"]']);
    const open = page.locator(".matched-action .request-link");
    await open.focus(); await frames(page);
    const position = await open.boundingBox(), origin = page.url();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "parity-call-0-1");
    await expect(page.locator("#requestContent")).toContainText("Outside current view");
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin); await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
    const revision = app.snapshot().revision;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), body = await response.json();
        body.revision = revision - 1; body.analytics.revision = body.revision;
        await route.fulfill({ response, json: body });
    });
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#freshContextMessage")).toContainText("older snapshot was rejected");
    await expect(page.locator("#periodResult")).toHaveText("Previous results: 1 Work IQ tool call (All dates)");
    await expect(summary).toHaveText("1 Work IQ tool call from 1 interaction.");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await restoreLegacySearch(page, "NO_ANALYZE_MATCH");
    await expect(summary).toBeHidden();
    await expect(page.locator("#activityList")).toContainText("No matching Work IQ tool calls");
    await expect(page.locator("#activitySelectionCompact")).toContainText("1 in report");
    await restoreLegacySearch(page, "");
    await selectActivityOption(page, "toolFilter", "all"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await expect(summary).toHaveText("12 Work IQ tool calls from 10 interactions.");
    assert.equal(app.snapshot().analytics.rows.length, 12);
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
    await expect(page.locator("#activityCount")).toHaveText("0");
    const empty = page.locator("#activityList .empty-state");
    await expect(empty.locator("h3")).toHaveText("No matching interactions");
    await empty.scrollIntoViewIfNeeded();
    await capture(page, "no-match-desktop", "#activityView");
    await expect(empty.locator("p")).toHaveText("Change filters or reset Analyze.");
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
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(empty.locator("h3")).toHaveText("No matching Work IQ tool calls");
    await expect(empty.locator("p")).toHaveText("Change filters or reset Analyze.");
    await expect(page.locator("#activityCount")).toHaveText("0");
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#resetView")).toBeDisabled();
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    assert.deepEqual(await rowIds(page), matching);
    await expect(empty).toHaveCount(0);
    await capture(page, "matching-after-reset", "#activityView");
    await restoreLegacySearch(page, "NO_ANALYZE_MATCH");
    await expect(empty.locator("p")).toHaveText("Try another phrase or clear Search.");
    await restoreLegacySearch(page, "");
    assert.deepEqual(await rowIds(page), matching);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented no-match proof read failure." } }));
    await page.reload();
    await expect(page.locator("#message")).toContainText("Invented no-match proof read failure");
    await expect(page.locator("#activityList .empty-state")).not.toBeVisible();
});

test("static list context preserves the first card without default reading instructions", { skip: !proofs }, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 1000 }); await chooseTheme(page, "light");
    for (const mode of ["interactions", "calls"]) {
        await page.locator(`[data-analyze-mode="${mode}"]`).click(); await ready(page);
        await page.locator("#activityView").evaluate(node => scrollBy(0, node.getBoundingClientRect().top
            - document.querySelector(".app-header").getBoundingClientRect().height - 12));
        await capture(page, `list-context-${mode}-light-390`, "#activityView");
    }
});

test("empty source still exposes Analyze recovery and existing Reports and Settings", { timeout: 15000 }, async t => {
    const { page } = await setup(t, []);
    await expect(page.locator("#activityList")).toContainText("No collected activity yet");
    await expect(page.locator("#checkActivity")).toHaveText("Refresh");
    await expect(page.locator("#freshSourceSetup")).not.toBeVisible();
    await page.locator("#freshHelp > summary").click();
    await expect(page.locator("#freshSourceSetup")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("0");
    await page.locator('[data-analyze-mode="calls"]').click();
    await expect(page.locator("#activityList")).toContainText("No collected activity yet");
    await navigateMain(page, "reports"); await ready(page);
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator("#settingsView")).toBeVisible();
});
