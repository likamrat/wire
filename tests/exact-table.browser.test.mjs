import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

async function setup(t) {
    const records = Array.from({ length: 31 }, (_, i) => {
        const row = fixture(`table-day-${i + 1}`);
        row.capturedAt = row.toolCalls[0].startedAt = i < 30 ? `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z` : null;
        return row;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
    const reads = [];
    page.on("request", r => { if (r.url().endsWith("/api/snapshot")) reads.push(r.postDataJSON()); });
    const open = async query => {
        await page.goto(runtime.url + query);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator("#openChartReference").click();
        await page.locator('[data-reference-topic="time"]').click();
        await page.locator("#chartReferenceShowData").click();
        return page.locator("#chartReferenceData");
    };
    return { page, open, reads };
}

test("exact date pages keep the complete dated total and disclose the undated call on each page", async t => {
    const { page, open, reads } = await setup(t);
    const data = await open("?bucket=day");
    const before = reads.length;
    for (const [direction, count] of [[null, 24], ["Next", 6], ["Previous", 24]]) {
        if (direction) await data.getByRole("button", { name: `${direction} chart rows`, exact: true }).press("Enter");
        const table = data.locator(".exact-data-table");
        await expect(table.locator("tbody tr")).toHaveCount(count);
        await expect(table.locator("tfoot td").first()).toHaveText("30");
        await expect(data).toContainText(/1 record without a date|1 undated record/);
        await expect(table.locator("caption")).toContainText("Totals include every page");
    }
    assert.equal(reads.length, before);
    await page.locator("#analyzeResultsSection").click();
    await expect(page.locator("#activityCount")).toHaveText("31");
});

test("the exact partial week opens only the selected civil days and keeps its chat filter", async t => {
    const { page, open } = await setup(t);
    const data = await open("?bucket=week&range=custom&from=2026-09-02&to=2026-09-10&session=test-session");
    const rows = data.locator(".exact-data-table tbody tr");
    await expect(rows).toHaveCount(2);
    const row = rows.first();
    await expect(row.locator("td").nth(1)).toHaveText("5");
    const link = row.getByRole("link").first();
    await expect(link).toContainText("Aug 31");
    const read = page.waitForResponse(r => r.url().endsWith("/api/snapshot") && r.ok());
    await link.press("Enter");
    const response = await read, filters = response.request().postDataJSON().filters;
    assert.deepEqual([filters.from, filters.to, filters.sourceSessionIds], ["2026-09-02", "2026-09-06", ["test-session"]]);
    assert.deepEqual((await response.json()).analytics.rows.map(r => r.toolCallId).sort(), [2, 3, 4, 5, 6].map(i => `test-call-table-day-${i}`));
    await page.goBack(); await expect(link).toBeFocused();
});
