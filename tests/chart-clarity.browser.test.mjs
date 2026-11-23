import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";

const counts = [9, 28, 9, 121, 50, 2];
const dates = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"];
const failures = [0, 3, 1, 15, 6, 0];
const records = counts.map((total, week) => {
    const record = fixture(`clarity-${week}`);
    record.capturedAt = `${dates[week]}T12:00:00Z`;
    record.userPrompt.text = "Synthetic chart readability fixture";
    record.toolCalls = Array.from({ length: total }, (_, index) => ({
        ...record.toolCalls[0],
        toolCallId: `clarity-${week}-${index}`, startEventId: `clarity-start-${week}-${index}`,
        startedAt: record.capturedAt,
        toolSucceeded: index < failures[week] ? false : week === 3 && index === 120 ? null : true,
        reportedOutcome: index < failures[week] ? "failed" : week === 3 && index === 120 ? "unknown" : "succeeded",
        apiResults: [],
    }));
    return record;
});

test("small counts are directly readable and reports are route-first without duplicate chart help", { timeout: 90000 }, async t => {
    const before = structuredClone(records);
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0 });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(records, before); assert.deepEqual(errors, []); });
    await page.goto(runtime.url + "?bucket=week");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await chooseTheme(page, "dark");
    assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), counts.map(n => `${n} calls`));
    await page.locator("#openChartReference").click();
    await page.getByRole("button", { name: "When calls happened" }).click();
    await page.getByRole("button", { name: "See exact numbers" }).click();
    const exact = page.locator("#chartReferenceExact table tbody tr");
    await expect(exact).toHaveCount(6);
    await expect(exact.nth(3).locator("td")).toHaveText(["Sep 21, 2026", "121", "105", "15", "1"]);
    await expect(exact.first().locator("td").last().getByRole("link")).toHaveCount(0);
    await page.locator("#analyzeResultsSection").click();
    for (const [category, count] of [["success", 193], ["failure", 25], ["unknown", 1]]) {
        assert.equal(await page.locator(`[data-percentage-card=outcomes] [data-category=${category}].percentage-legend-row`).getAttribute("data-count"), String(count));
    }
    const proof = process.env.WORKIQ_CLARITY_PROOFS;
    if (proof) {
        await mkdir(proof, { recursive: true });
        for (const [name, selector] of [["columns", ".time-chart"], ["percentages", "[data-percentage-card=outcomes]"], ["navigation", "#sidebar"]]) {
            await page.locator(selector).screenshot({ path: path.join(proof, `${name}.png`) });
        }
    }
    assert.equal(await page.locator("#sidebarExport,#mobileExportSlot").count(), 0, "Reports navigation replaces the redundant global export");
    assert.equal(await page.locator("#chart .ux-help,.dimensional-small-results,.percentage-associations,.percentage-locator").count(), 0);
    await expect(page.locator(".time-column").last()).toHaveAccessibleName(/2 tool completed \(100%\).*0 tool failed \(0%\)/);
    const tiny = page.locator(".dimensional-count").last();
    assert.ok((await tiny.boundingBox()).height >= 44, "The visible two-call control is an honest, usable target");
    await tiny.tap();
    await page.locator("#activityView").waitFor({ state: "visible" });
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 2 matching tool calls");
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-10-05");
    assert.equal(new URL(page.url()).searchParams.get("to"), "2026-10-11");
    await page.goBack();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await navigateMain(page, "reports");
    await page.locator("#reportsView").waitFor({ state: "visible" });
    await expect(page.getByRole("button", { name: "Prepare preview", exact: true })).toBeVisible();
    await expect(page.locator("#reportPreviewDrawer")).toBeHidden();
});
