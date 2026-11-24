import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, restoreLegacySearch } from "./helpers.mjs";

test("a positive outcome drilldown keeps the private parent match and does not admit a sibling in its chat", async t => {
    const records = ["Invented survey match", "Invented other parent"].map((text, i) => {
        const r = fixture(`private-parent-${i}`);
        r.userPrompt.text = text;
        r.toolCalls = Array.from({length: 7}, (_, j) => ({...r.toolCalls[0], toolCallId: `call-${i}-${j}`,
            startEventId: `start-${i}-${j}`, toolSucceeded: j < 6, reportedOutcome: j < 6 ? "succeeded" : "failed"}));
        return r;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const urls = [];
    page.on("request", r => urls.push(r.url()));
    await page.goto(runtime.url); await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, "survey match");
    const completed = page.locator('#outcomeChart [data-category="success"] .percentage-label');
    await expect(completed).toHaveAccessibleName(/6 of 7 Work IQ tool calls/);
    await completed.press("Enter");
    await expect(page.locator("#activityListSummary")).toContainText("6 matching tool calls");
    const population = page.locator("#outcomeChart").getByRole("link", { name: "View all 6 Work IQ tool calls", exact: true });
    await population.click();
    const calls = page.locator("#activityList .widget-record");
    await expect(calls).toHaveCount(6);
    assert.deepEqual((await calls.evaluateAll(nodes => nodes.map(n => n.dataset.actionId))).sort(),
        Array.from({length: 6}, (_, i) => `call:["test-session","call-0-${i}"]`));
    assert.ok(urls.every(url => !decodeURIComponent(url).includes("survey match")));
});
