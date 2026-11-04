import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { privateFixture, navigateMain, selectActivityOption, openActivitySessions, revealStoredRefresh } from "./helpers.mjs";
import { chooseReportScope, reportContents, cancelReportPreview } from "./report-journey-helpers.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const sorted = values => [...values].sort();
const ids = indexes => indexes.map(i => `parity-request-${i}`);
const rowId = (i, j = 0) => `call:${JSON.stringify([`parity-chat-${i}`, `parity-call-${i}-${j}`])}`;
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
async function setup(t) {
    const cleanup = [], records = scopeRecords(), traffic = [], errors = [], denied = [], urls = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const dispatches = { provider: 0, scoring: 0 };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { dispatches.provider++; throw new Error("Provider activity is forbidden"); },
            readSource: async () => { dispatches.scoring++; throw new Error("Scoring source reads are forbidden"); } } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"];
    let allowPreview = false, snapshot;
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)
            && !(allowPreview && ["/api/preview", "/api/cancel-preview"].includes(url.pathname))) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() === "POST") traffic.push({ path: url.pathname, body: request.postDataJSON() });
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
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(dispatches, { provider: 0, scoring: 0 });
            assert.doesNotMatch(JSON.stringify(traffic), /INVENTED_PARITY_NEEDLE|NO_PARITY_MATCH|Invented parity chat/);
            assert.doesNotMatch(JSON.stringify(urls) + storage, /INVENTED_PARITY_NEEDLE|NO_PARITY_MATCH|Invented.parity.chat/);
            const after = await loadBoardState(context);
            assert.deepEqual(after.exports, before.exports);
            assert.deepEqual(after.cards, before.cards);
            assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#activity"); await ready(page);
    return { page, context, records, traffic, snapshot: () => snapshot, preview: () => { allowPreview = true; } };
}
async function overviewIds(page, snapshot, expected, home = false) {
    const host = page.locator("#homeInsights");
    await expect(host).not.toHaveAttribute("aria-busy", "true");
    const refs = sorted(snapshot.assessment.catalog.filter(row => expected.includes(row.scenarioId) && row.status === "retained").map(row => row.interactionRef));
    await expect.poll(async () => {
        const key = await host.getAttribute("data-insight-key");
        return key && JSON.parse(key.slice(key.lastIndexOf(":") + 1));
    }).toEqual([...new Set(refs)]);
}
async function homeCount(page, count) {
    await expect(page.locator("#activityCount")).toHaveText(String(count));
    await expect(page.locator("#percentageCharts .percentage-section")).toHaveAttribute("data-total", String(count));
    await expect(page.locator("#meaningMatched")).toHaveText(`${count} Work IQ tool call${count === 1 ? "" : "s"}`);
}

test("private search has one all-page Analyze cohort across summaries, scoped Calls, full detail and current report preview", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, traffic } = app;
    const choose = async (field, value) => { await selectActivityOption(page, field, value); await ready(page); };
    await page.locator("#activitySearch").fill(privateQuery);
    await expect(page.locator("#activityListSummary")).toContainText("9 interactions with 11 matching Work IQ tool calls");
    await overviewIds(page, app.snapshot(), ids([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    await openActivitySessions(page);
    const first = await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey.slice(8)));
    await page.locator('.request-row[data-view-key="request:parity-request-0"] input').check();
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    await openActivitySessions(page);
    const second = await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey.slice(8)));
    assert.deepEqual(sorted([...first, ...second]), ids([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    await overviewIds(page, app.snapshot(), ids([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    const beforeHome = traffic.filter(entry => entry.path === "/api/snapshot").length;
    await navigateMain(page, "home"); await homeCount(page, 11);
    await overviewIds(page, app.snapshot(), ids([0, 1, 2, 3, 4, 5, 6, 7, 8]), true);
    assert.equal(traffic.filter(entry => entry.path === "/api/snapshot").length, beforeHome);
    await page.goBack(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
    await expect(page.locator("#activityPager")).toContainText("9-9 of 9");
    await page.locator("#activityPager").getByRole("button", { name: "Previous", exact: true }).click();
    await openActivitySessions(page);
    await expect(page.locator('.request-row[data-view-key="request:parity-request-0"] input')).toBeChecked();
    await choose("serviceAssociationFilter", "Files");
    await choose("promptAuthorFilter", "user");
    await choose("outcomeFilter", "failure");
    await choose("dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30"); await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("2 interactions with 3 matching Work IQ tool calls");
    await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches; 1 context-only");
    await overviewIds(page, app.snapshot(), ids([0, 6]));
    await expect(page.locator("#homeInsights .assessment-scope")).toContainText("3 Work IQ tool calls matched");
    await expect(page.locator("#homeInsights")).toContainText("4 recorded calls");
    await openActivitySessions(page);
    assert.deepEqual(sorted(await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey.slice(8)))), ids([0, 6]));
    await page.getByRole("link", { name: "Filter to Copilot chat: Invented parity chat 0", exact: true }).click(); await ready(page);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
    assert.deepEqual(sorted(await page.locator(".matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId))), [rowId(0), rowId(0, 1)]);
    await expect(page.locator(".matched-action .service-context-label")).toHaveCount(1);
    await page.locator(".matched-action .request-link").first().click(); await ready(page);
    await expect(page.locator("#requestView")).toContainText("Outside current view");
    await page.goBack(); await ready(page); await page.goBack(); await ready(page); await page.goBack(); await ready(page);
    await navigateMain(page, "home"); await homeCount(page, 3);
    await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches; 1 context-only");
    await overviewIds(page, app.snapshot(), ids([0, 6]), true);
    await expect(page.locator("#outcomeFilter option[value=success]")).toHaveText("Tool completed (2)");
    await expect(page.locator("#outcomeFilter option[value=failure]")).toHaveText("Tool failed (3)");
    await page.locator('[data-chart="workload"]').click(); await ready(page);
    await page.locator("#chart").getByRole("link", { name: /^Files:/ }).click(); await ready(page);
    await openActivitySessions(page);
    assert.deepEqual(await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey.slice(8))), ids([6]));
    await overviewIds(page, app.snapshot(), ids([6]));
    await page.goBack(); await ready(page); await homeCount(page, 3);
    await navigateMain(page, "reports"); await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current")).toHaveText("2 request groups");
    await expect(page.locator("#scopeSummary")).toContainText("4 Work IQ tool calls");
    await expect(page.locator("#reportMatchingContext")).toContainText("3 matching Work IQ tool calls");
    app.preview();
    await reportContents(page);
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const response = await previewResponse, preview = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(preview));
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    const request = traffic.findLast(entry => entry.path === "/api/preview").body;
    assert.deepEqual(sorted(request.selection.scenarioIds), ids([0, 6]));
    assert.equal(request.selection.revision, app.snapshot().revision);
    assert.ok(preview.previewId);
    await cancelReportPreview(page);
    await navigateMain(page, "home");
    await page.getByRole("button", { name: "Remove private search", exact: true }).click(); await homeCount(page, 3);
    await navigateMain(page, "activity");
    await page.locator("#activitySearch").fill("NO_PARITY_MATCH");
    await expect(page.locator("#activityListSummary")).toContainText("0 interactions with 0 matching Work IQ tool calls");
    await navigateMain(page, "home"); await homeCount(page, 0);
    await expect(page.locator("#serviceFocusScope")).toContainText("0 known matches; 0 context-only");
    await overviewIds(page, app.snapshot(), [], true);
    await navigateMain(page, "reports"); await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current")).toHaveText("0 request groups");
    await chooseReportScope(page, "selected");
    await expect(page.locator("#scopeCount-selected")).toHaveText("1 request group");
    await chooseReportScope(page, "all");
    await expect(page.locator("#scopeCount-all")).toHaveText("10 request groups");
    await chooseReportScope(page, "selected");
    await navigateMain(page, "activity");
    await page.locator("#clearActivitySearch").click();
    await page.getByRole("button", { name: "Remove missing-service context", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("2 interactions with 2 matching Work IQ tool calls");
    await choose("outcomeFilter", "all");
    await choose("promptAuthorFilter", "all");
    await choose("serviceAssociationFilter", "all");
    await page.getByRole("button", { name: /^Remove date filter:/ }).click(); await ready(page);
    await navigateMain(page, "home"); await homeCount(page, 12);
    await overviewIds(page, app.snapshot(), ids([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), true);
    assert.doesNotMatch(page.url(), /INVENTED|NO_PARITY_MATCH/);
});

test("late overview and snapshot responses cannot replace a newer private cohort; stale revision keeps the accepted basis", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    const held = deferred(), release = deferred(), delivered = deferred();
    t.after(() => release.resolve());
    let calls = 0;
    await page.route("**/api/assessment/overview", async route => {
        const response = await route.fetch();
        if (++calls === 1) { held.resolve(); await release.promise; }
        await route.fulfill({ response }); delivered.resolve();
    });
    await page.locator("#activitySearch").fill(`${privateQuery} request 0`); await held.promise;
    await page.locator("#activitySearch").fill(`${privateQuery} request 6`);
    await overviewIds(page, app.snapshot(), ids([6]));
    await navigateMain(page, "home"); await homeCount(page, 1);
    const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/overview"));
    release.resolve(); await delivered.promise; await (await oldResponse).finished();
    await overviewIds(page, app.snapshot(), ids([6]), true); await homeCount(page, 1);
    await page.unroute("**/api/assessment/overview");
    await navigateMain(page, "activity");
    const snapshotHeld = deferred(), snapshotRelease = deferred();
    t.after(() => snapshotRelease.resolve());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        snapshotHeld.resolve(); await snapshotRelease.promise; await route.fulfill({ response });
    });
    await selectActivityOption(page, "promptAuthorFilter", "agent"); await snapshotHeld.promise;
    await page.locator("#activitySearch").fill(`${privateQuery} request 1`);
    await expect(page.locator("#periodResult")).toHaveAttribute("aria-busy", "true");
    snapshotRelease.resolve(); await ready(page);
    await overviewIds(page, app.snapshot(), ids([1]));
    await navigateMain(page, "home"); await homeCount(page, 1);
    await page.unroute("**/api/snapshot");
    const acceptedRevision = app.snapshot().revision;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), body = await response.json();
        body.revision = acceptedRevision - 1; body.analytics.revision = body.revision;
        await route.fulfill({ response, json: body });
    });
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(page.locator("#message")).toContainText("older snapshot was rejected");
    await expect(page.locator("#homeView")).toHaveAttribute("data-revision", String(acceptedRevision));
    await expect(page.locator("#periodResult")).toHaveText("Previous results: 1 Work IQ tool call (All dates)");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page); await homeCount(page, 1);
    await navigateMain(page, "activity");
    await page.locator("#activitySearch").fill("NO_PARITY_MATCH");
    await overviewIds(page, app.snapshot(), []);
    await page.reload(); await ready(page);
    await overviewIds(page, app.snapshot(), []);
    await expect(page.locator("#activitySearch")).toHaveValue("NO_PARITY_MATCH");
    await expect(page.locator("#promptAuthorFilter-control")).toContainText("Agent");
});

test("a new accepted source revision and evidence layer replace all local projections without reusing old facts", { timeout: 30000 }, async t => {
    const app = await setup(t), { page } = app;
    await page.locator("#activitySearch").fill(`${privateQuery} request 0`);
    await overviewIds(page, app.snapshot(), ids([0]));
    const revision = app.snapshot().revision, records = structuredClone(app.records);
    records[0].toolCalls[0].durationMs = 600;
    records[0].toolCalls[3].durationMs = 600;
    records[0].toolCalls[0].completedAt = "2026-09-30T12:00:00.600Z";
    records[0].toolCalls[3].completedAt = "2026-09-30T12:00:00.600Z";
    await replaceEvidence(app.context, () => ({ records, importCoverage: { counts: {}, roster: [] } }));
    await (await revealStoredRefresh(page)).click(); await ready(page);
    assert.ok(app.snapshot().revision > revision);
    await overviewIds(page, app.snapshot(), ids([0]));
    await expect(page.locator("#homeInsights")).toContainText("0.6 s");
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("1 interaction with 4 matching tool-returned API results");
    await navigateMain(page, "home");
    await expect(page.locator("#activityCount")).toHaveText("4");
    await expect(page.locator("#percentageCharts .percentage-section")).toHaveAttribute("data-total", "4");
    await expect(page.locator("#takeaway")).toContainText("3 of 3 Work IQ tool calls retained an API status");
    await overviewIds(page, app.snapshot(), ids([0]), true);
    await selectActivityOption(page, "layerFilter", "direct-request"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await overviewIds(page, app.snapshot(), [], true);
    await selectActivityOption(page, "layerFilter", "tool"); await ready(page); await homeCount(page, 3);
    await overviewIds(page, app.snapshot(), ids([0]), true);
});
