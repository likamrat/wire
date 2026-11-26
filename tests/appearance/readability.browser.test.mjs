import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { fixture, privateFixture, selectActivityOption } from "../support/helpers.mjs";

test("Analyze distinguishes matching activity with no date from no matching activity", async t => {
    const record = fixture("no-date");
    record.capturedAt = null;
    record.userPrompt.text = "Review the undated Cedar request.";
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    await page.goto(runtime.url);
    await expect(page.locator("#chart")).toContainText("Dates unavailable");
    await expect(page.locator("#activityListSummary")).toContainText("1 matching tool call");
    await expect(page.locator("#activityList article")).toContainText(record.userPrompt.text);
    await selectActivityOption(page, "outcomeFilter", "failure");
    await expect(page.locator("#chart")).toContainText(/No matching (activity|results)/);
    await expect(page.locator("#activityList article")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "First dates", exact: true })).toBeHidden();
});
