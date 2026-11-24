import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";
import { privateFixture, restoreLegacySearch, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";

test("a day link keeps private Search, outcome, author and missing-service membership together", async t => {
    const records = scopeRecords();
    for (const row of records) for (const call of row.toolCalls)
        call.startedAt = row.scenarioId === "parity-request-6" ? "2026-03-09T07:00:00Z" : "2026-03-08T10:00:00Z";
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    await page.goto(runtime.url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, privateQuery);
    for (const [field, value] of [["serviceAssociationFilter", "Files"], ["promptAuthorFilter", "user"], ["outcomeFilter", "failure"]]) {
        await selectActivityOption(page, field, value);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    }
    await closeAnalyzeFilters(page);
    await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches; 1 context-only");
    await expect(page.locator("#activityCount")).toHaveText("3");
    const before = page.url();
    await page.locator(".time-column").first().press("Enter");
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#activitySearch")).toHaveValue(privateQuery);
    assert.ok(!decodeURIComponent(page.url()).includes(privateQuery));
    await page.locator("#outcomeChart").getByRole("link", { name: "View all 2 Work IQ tool calls" }).click();
    const rows = page.locator("#activityList .widget-record");
    await expect(rows).toHaveCount(2);
    const ids = await rows.evaluateAll(nodes => nodes.map(n => n.dataset.actionId));
    assert.deepEqual(ids.sort(), ['call:["parity-chat-0","parity-call-0-0"]', 'call:["parity-chat-0","parity-call-0-1"]']);
    await page.goBack(); await page.goBack();
    await expect(page).toHaveURL(before); await expect(page.locator("#activityCount")).toHaveText("3");
});
