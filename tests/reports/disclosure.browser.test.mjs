import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture, revealSavedDataRead } from "../support/helpers.mjs";

async function setup(t, records) {
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    return { context, runtime, page };
}

test("a new stored read updates the total without displacing the reader's focused interaction", async t => {
    const records = Array.from({ length: 12 }, (_, index) => {
        const record = fixture(`disclosure-${index}`);
        record.capturedAt = new Date(Date.UTC(2026, 8, 30 - index, 12)).toISOString();
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    const { context, runtime, page } = await setup(t, records);
    await page.goto(runtime.url);
    const pager = page.locator("#activityPager");
    await pager.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pager).toContainText("9-12 of 12 interactions");
    const row = page.locator('#activityList [data-view-key="request:disclosure-9"] .request-card-open').first();
    await row.focus();
    const before = await row.boundingBox();
    const incoming = fixture("disclosure-later-read");
    incoming.capturedAt = "2026-08-01T12:00:00Z";
    incoming.toolCalls[0].startedAt = incoming.capturedAt;
    await replaceEvidence(context, () => ({ records: [...records, incoming] }));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(pager).toContainText("9-13 of 13 interactions");
    await expect(row).toBeFocused();
    assert.ok(Math.abs((await row.boundingBox()).y - before.y) <= 2, "Newly read activity does not shift the focused card");
});

test("collection status pages the complete list of scan notes", async t => {
    const { runtime, page } = await setup(t, [fixture("scan-notes")]);
    const notes = Array.from({ length: 7 }, (_, i) => `Invented scan note ${i + 1}`);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.coverage.notes = notes;
        await route.fulfill({ response, json: snapshot });
    });
    await page.goto(runtime.url + "collection-status");
    await revealSavedDataRead(page);
    const list = page.locator(".evidence-notes li");
    await expect(list).toHaveCount(6);
    const shown = await list.allTextContents();
    await page.getByRole("button", { name: "Next scan notes", exact: true }).click();
    shown.push(...await list.allTextContents());
    assert.deepEqual(shown.filter(note => note.startsWith("Invented scan note ")), notes);
});
