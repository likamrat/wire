import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, revealStoredRefresh } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const calls = page => page.locator('[data-reader-section="activity"] [data-tool-call-id]');
const fact = (owner, label) => owner.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("+ dd");

async function setup(t) {
    const record = fixture("timing");
    record.followUpPrompts = [];
    record.userPrompt.sourceEventId = "timed-prompt";
    record.userPrompt.sourceTimestamp = "2026-11-01T08:29:30Z";
    record.toolCalls = ["2026-11-02T08:00:00Z", "2026-11-01T09:30:00Z", "2026-11-01T08:30:00Z"].map((startedAt, i) =>
        ({ ...record.toolCalls[0], startedAt, toolCallId: `ordered-${i}`, startEventId: `start-${i}`,
            completedAt: i === 0 ? null : startedAt, durationMs: i === 0 ? null : 0 }));
    const cleanups = [];
    const { context } = await privateFixture({ after: fn => cleanups.push(fn) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", locale: "en-US", reducedMotion: "reduce" });
    await page.goto(runtime.url + "#request?request=timing"); await ready(page);
    return page;
}

test("the reader distinguishes two calls at the same local time, an untimed end, and the original message", async t => {
    const page = await setup(t), rows = calls(page);
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)), ["ordered-2", "ordered-1", "ordered-0"]);
    await expect(rows.locator(".reader-call-duration")).toHaveText(["Call duration: 0 ms", "Call duration: 0 ms", "Call duration: Not recorded"]);
    for (const row of await rows.all()) await row.locator(".reader-call-toggle").press("Enter");
    await expect(fact(rows.nth(0), "Recorded start")).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-7");
    await expect(fact(rows.nth(1), "Recorded start")).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-8");
    await expect(fact(rows.nth(0), "Recorded end")).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-7");
    await expect(rows.last().getByText("Recorded end", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Source details" }).press("Space");
    await expect(page.locator(".reader-recorded-at time")).toHaveAttribute("datetime", "2026-11-01T08:29:30Z");
    await expect(page.locator(".reader-recorded-at time")).toHaveText("Nov 1, 2026, 1:29:30 AM GMT-7");
});

test("a pending or failed time-zone change cannot relabel an open call until a fresh snapshot succeeds", async t => {
    const page = await setup(t), call = calls(page).first(), toggle = call.locator(".reader-call-toggle");
    await toggle.click();
    const start = fact(call, "Recorded start");
    await expect(start).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-7");
    const utc = req => req.url().endsWith("/api/snapshot") && req.postDataJSON()?.timeContext?.timeZone === "UTC";
    const pending = page.waitForRequest(utc), gate = Promise.withResolvers();
    const fail = async route => {
        if (!utc(route.request())) return route.continue();
        await gate.promise;
        await route.fulfill({ status: 503, json: { error: "Synthetic failed time change" } });
    };
    await page.route("**/api/snapshot", fail);
    try {
        await page.evaluate(() => {
            localStorage.setItem("workiq-evidence.time-zone", "UTC");
            dispatchEvent(new StorageEvent("storage", { key: "workiq-evidence.time-zone", newValue: "UTC" }));
        });
        await pending;
        await expect(start).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-7");
        const failed = page.waitForResponse(res => utc(res.request()) && res.status() === 503);
        gate.resolve(); await failed; await ready(page);
        await expect(start).toHaveText("Nov 1, 2026, 1:30:00 AM GMT-7");
    } finally {
        gate.resolve(); await page.unroute("**/api/snapshot", fail);
    }
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(start).toHaveText(/^Nov 1, 2026, 8:30:00 AM GMT(?:\+0)?$/);
});
