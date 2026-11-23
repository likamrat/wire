import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

test("overlapping interactions list a shared call once and keep the other parent's full context", async t => {
    const owner = fixture("a-owner"), other = fixture("b-overlap");
    other.toolCalls.unshift(structuredClone(owner.toolCalls[0]));
    other.userPrompt.text = "Invented overlapping request";
    const { context } = await privateFixture(t, [owner, other]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(runtime.url); await expect(page.locator("#activityCount")).toHaveText("2");
    const card = page.locator('#activityList article[data-view-key="request:b-overlap"]');
    await expect(card).toContainText("1 of 2 Work IQ tool calls matches this view");
    await card.getByRole("link", { name: /^workiq-fetch: open call$/ }).press("Enter");
    const rows = page.locator("#requestContent .reader-call-row");
    await expect(rows).toHaveCount(2);
    assert.deepEqual((await rows.evaluateAll(nodes => nodes.map(n => n.dataset.toolCallId))).sort(),
        ["test-call-a-owner", "test-call-b-overlap"]);
    await expect(rows.filter({ hasText: "Outside current view" })).toHaveAttribute("data-tool-call-id", "test-call-a-owner");
});
