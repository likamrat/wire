import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const params = url => new URLSearchParams(url.split("?")[1]);

async function setup(t) {
    const cleanup = [], { records } = periodFixture();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce",
    });
    const denied = [], errors = [];
    let snapshot;
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#analyze?range=custom&from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true");
    await ready(page); await restoreLegacySearch(page, periodQuery);
    const originalIds = snapshot.analytics.rows.map(row => row.id).sort();
    await page.locator("#comparePeriods").click();
    for (const [id, value] of Object.entries({ comparisonAFrom: "2026-03-07", comparisonATo: "2026-03-07",
        comparisonBFrom: "2026-03-08", comparisonBTo: "2026-03-09" })) await page.locator("#" + id).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    return { page, originalIds, snapshot: () => snapshot };
}

async function analyzeLink(page) {
    const link = page.locator('.primary-navigation [data-nav="analyze"]');
    if (!await link.isVisible()) await page.locator("#navigationToggle").click();
    await expect(link).toBeVisible();
    return link;
}

function ordinaryScope(url) {
    const query = params(url);
    assert.equal(query.get("compare"), null);
    assert.equal(query.get("from"), "2026-03-07");
    assert.equal(query.get("to"), "2026-03-07");
    assert.equal(query.get("services"), "Files");
    assert.equal(query.get("includeMissingService"), "true");
    assert.doesNotMatch(url, new RegExp(periodQuery));
}

for (const activation of ["click", "keyboard"]) test(`Analyze exits comparison through the existing Stop transition (${activation})`, { timeout: 30000 }, async t => {
    const { page, originalIds, snapshot } = await setup(t);
    const comparison = page.url();
    if (activation === "keyboard") {
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    }
    const link = await analyzeLink(page);
    ordinaryScope(await link.getAttribute("href"));
    if (activation === "keyboard") { await link.focus(); await link.press("Enter"); }
    else await link.click();
    await ready(page);
    await expect(page.locator("#periodComparisonSetup")).not.toBeVisible();
    await expect(page.locator("#activityView")).toBeVisible();
    ordinaryScope(page.url());
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id).sort(), originalIds);
    assert.ok(await page.evaluate(() => document.activeElement !== document.body && document.activeElement.checkVisibility()),
        "The native exit keeps a visible keyboard destination");
    await page.goBack(); await ready(page);
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    assert.equal(page.url(), comparison);
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
});

test("modified Analyze activation opens ordinary public scope without exiting the original comparison", { timeout: 30000 }, async t => {
    const { page } = await setup(t), comparison = page.url(), link = await analyzeLink(page);
    ordinaryScope(await link.getAttribute("href"));
    const [opened] = await Promise.all([page.context().waitForEvent("page"), link.click({ modifiers: ["Control"] })]);
    await ready(opened);
    ordinaryScope(opened.url());
    await expect(opened.locator("#periodComparisonSetup")).not.toBeVisible();
    await expect(opened.locator("#activitySearch")).toHaveValue("");
    assert.equal(page.url(), comparison);
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    await opened.close();
});

test("Analyze from a comparison record uses the same ordinary origin rather than the selected side dates", { timeout: 30000 }, async t => {
    const { page, originalIds, snapshot } = await setup(t);
    await page.locator("#comparisonRecordsB").click();
    await page.locator("#comparisonExactRecordsB a.text-link").first().click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    const link = await analyzeLink(page);
    ordinaryScope(await link.getAttribute("href"));
    await link.click(); await ready(page);
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#periodComparisonSetup")).not.toBeVisible();
    ordinaryScope(page.url());
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    assert.deepEqual(snapshot().analytics.rows.map(row => row.id).sort(), originalIds);
    await expect(page.locator("#resultsLink")).toHaveCount(0);
});
