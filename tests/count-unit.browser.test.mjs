import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

test("filtering a chart by chat and then failure keeps the exact parent and failed calls", async t => {
    const records = [["one", [3]], ["six", [3, 3, 2, 2, 2, 2]], ["unknown", [1]]].flatMap(([chat, sizes]) =>
        sizes.map((size, i) => {
            const record = fixture(`${chat}-${i}`);
            record.sourceSessionId = chat;
            record.sourceSessionName = chat === "unknown" ? null : `Invented chat ${chat}`;
            record.toolCalls = Array.from({ length: size }, (_, j) => ({
                ...record.toolCalls[0], toolCallId: `${chat}-${i}-${j}`, startEventId: `start-${chat}-${i}-${j}`,
                toolSucceeded: chat === "unknown" ? null : i !== 5,
                reportedOutcome: chat === "unknown" ? "unknown" : i === 5 ? "failed" : "succeeded",
            }));
            return record;
        }));
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const summary = page.locator("#activityListSummary");
    for (const [chat, text] of [["one", "1 interaction · 3 matching tool calls"], ["unknown", "1 interaction · 1 matching tool call"],
        ["six", "6 interactions · 14 matching tool calls"]]) {
        await page.goto(`${runtime.url}?session=${chat}`);
        await expect(summary).toHaveText(text);
        if (chat === "unknown") await expect(page.locator('#outcomeChart [data-category="unknown"] .percentage-value')).toHaveText("100% (1)");
    }
    const failed = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
    await expect(failed).toHaveAccessibleName(/2 of 14 Work IQ tool calls/);
    const read = page.waitForResponse(r => r.url().endsWith("/api/snapshot") && r.ok());
    await failed.press("Enter");
    assert.deepEqual((await (await read).json()).analytics.rows.map(r => r.toolCallId).sort(), ["six-5-0", "six-5-1"]);
    await expect(summary).toHaveText("1 interaction · 2 matching tool calls");
    const card = page.locator("#activityList article");
    await expect(card).toHaveAttribute("data-view-key", "request:six-5");
    await card.getByRole("link", { name: "2 tool calls failed", exact: true }).click();
    assert.deepEqual(await page.locator("#requestContent .reader-call-row").evaluateAll(nodes => nodes.map(n => n.dataset.toolCallId)),
        ["six-5-0", "six-5-1"]);
});
