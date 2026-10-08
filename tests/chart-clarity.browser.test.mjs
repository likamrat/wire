import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
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
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await chooseTheme(page, "dark");
    assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), counts.map(n => `${n} calls`));
    assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), false);
    await page.locator("#tableDisclosure>summary").click();
    assert.deepEqual(await page.locator("#countTable tbody tr").nth(3).locator("td").allTextContents(), ["Sep 21, 2026", "121", "105", "15", "1"]);
    assert.equal(await page.locator("#chartReadingNotes").isVisible(), false, "Detailed reading help stays closed, not above the exact numbers");
    assert.equal(await page.locator("#coverageNotice").isVisible(), false);
    assert.equal(await page.locator("#coverage #coverageNotice").count(), 1, "General caveats live only in existing About");
    await page.locator("#coverage>summary").click();
    assert.match(await page.locator("#coverageNotice").innerText(), /retained evidence.*history may leave gaps.*hosted Work IQ.*not visible/);
    await page.locator("#coverage>summary").click();
    for (const [category, count] of [["success", 193], ["failure", 25], ["unknown", 1]]) {
        assert.equal(await page.locator(`[data-percentage-card=outcomes] [data-category=${category}].percentage-legend-row`).getAttribute("data-count"), String(count));
    }
    const proof = process.env.WORKIQ_CLARITY_PROOFS;
    if (proof) {
        await mkdir(proof, { recursive: true });
        for (const [name, selector] of [["columns", ".chart-panel"], ["percentages", ".percentage-section"], ["navigation", "#sidebar"]]) {
            await page.locator(selector).screenshot({ path: path.join(proof, `${name}.png`) });
        }
    }
    assert.equal(await page.locator("#sidebarExport,#mobileExportSlot").count(), 0, "Reports navigation replaces the redundant global export");
    assert.equal(await page.locator("#chart .ux-help,.dimensional-small-results,.percentage-associations,.percentage-locator").count(), 0);
    for (const selector of [".dimensional-cap-clear", ".dimensional-side", ".dimensional-glint", ".percentage-ring"]) {
        assert.ok(await page.locator(selector).count() > 0, `Approved glass presentation includes ${selector}`);
    }
    assert.equal(await page.locator(".dimensional-reflection,.percentage-ground").count(), 0);
    assert.equal(await page.locator("#chart :is(.time-column,.dimensional-count)[data-ux-tooltip],.percentage-legend [data-ux-tooltip]").count(), 0);
    assert.ok(await page.locator("#chart [data-segment][data-ux-tooltip]").count() > 0, "Actual outcome surfaces retain user-requested inspection");
    const tiny = page.locator(".dimensional-count").last();
    assert.ok((await tiny.boundingBox()).height >= 44, "The visible two-call control is an honest, usable target");
    await tiny.tap();
    await page.locator("#activityView").waitFor({ state: "visible" });
    assert.match(new URL(page.url()).hash, /from=2026-10-05/);
    await page.goBack();
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await navigateMain(page, "reports");
    await page.locator("#reportsView").waitFor({ state: "visible" });
    assert.equal(await page.locator('[name=reportScope][value=selected]').isChecked(), true);
    assert.equal(await page.locator("#exportBtn").isDisabled(), true);
    assert.equal(await page.locator("#coverageNotice").isVisible(), false);
});
