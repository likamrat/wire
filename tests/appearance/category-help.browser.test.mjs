import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture } from "../support/helpers.mjs";

test("touching the service Guide reads its definition without applying the service filter", async t => {
    const rows = ["calendarView", "messages"].map(path => {
        const row = fixture(`category-help-${path}`);
        row.toolCalls[0].requestedApiPath = `/me/${path}`;
        row.toolCalls[0].requestArgs = { entityUrls: [`/me/${path}`] };
        return row;
    });
    const { context } = await privateFixture(t, rows);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, reducedMotion: "reduce" });
    let snapshots = 0;
    page.on("request", r => { if (r.url().endsWith("/api/snapshot")) snapshots++; });
    await page.goto(runtime.url); await expect(page.locator("#activityCount")).toHaveText("2");
    const before = snapshots;
    await page.locator("#openChartReference").tap();
    await page.locator('[data-reference-topic="services"]').tap();
    await expect(page.locator("#chartReferenceExplanation")).toContainText("Recorded path not recognized");
    assert.equal(snapshots, before);
    await page.locator("#analyzeResultsSection").tap();
    await page.locator('[data-percentage-card=services] [data-category=Calendar] .percentage-label').tap();
    await expect(page.locator("#activityListSummary")).toContainText("1 matching tool call");
    await expect(page.locator("#activityList article")).toHaveAttribute("data-view-key", "request:category-help-calendarView");
});
