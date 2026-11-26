import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { retainEvent } from "../../lib/collector.mjs";
import { completeWorkIqCall } from "../../lib/history.mjs";
import { fixture, privateFixture, chooseTheme } from "../support/helpers.mjs";
import { contrast, measureControlSurface } from "../support/color-measurements.mjs";

const message = "The requested operation is not available for this item. " + "Choose a supported item. ".repeat(8);
const transportMessage = "MCP request failed: Transport " + "InventedTransportLayer<".repeat(15)
    + " error: HTTP 503 Service Unavailable: upstream connection timeout";
function record(id, success) {
    const value = fixture(id);
    value.userPrompt = { text: `Inspect the invented ${id} operation.`, status: "full",
        sourceEventId: id + "-prompt", sourceTimestamp: "2026-11-01T12:00:00Z",
        authorship: { actor: "user", basis: "source-user" } };
    value.followUpPrompts = [];
    const event = retainEvent({ id: id + "-end", type: "tool.execution_complete", timestamp: "2026-11-01T12:00:01Z",
        data: { toolCallId: id, success, ...(success === false ? { error: { code: "failure",
            message: id === "transport" ? transportMessage : `MCP server 'workiq': {"results":[${JSON.stringify({ statusCode: 403,
                error: { error: { code: "UnsupportedItem", message, details: [{ message: "This operation requires an editable item." }] } } })},{"data":{"text":"${"EXCLUDED_BODY".repeat(1000)}"]}}` } } : {}) } },
    { credentialExclusions: 0 });
    value.toolCalls = [completeWorkIqCall({ ...value.toolCalls[0], toolCallId: id, startedAt: "2026-11-01T12:00:00Z",
        requestArgs: { entityUrls: ["/planner/tasks/invented-task", "/planner/tasks/invented-second"], headers: { "If-Match": "invented-version" } } }, event)];
    if (id === "partial") value.toolCalls[0].reportedOutcome = "partial";
    return value;
}

test("a failed call keeps a readable outcome, its partial returned error and stable Copy action", { timeout: 60000 }, async t => {
    const records = [record("failed", false), record("completed", true), record("unknown", null), record("partial", null), record("transport", false)];
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const app = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], unexpected = [];
    t.after(async () => {
        try { await browser.close(); await app.close(); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); }
        finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(app.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname); return route.abort();
    });
    await page.addInitScript(() => {
        window.copies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.copies.push(text) } });
    });
    await page.goto(app.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const card = page.locator('#activityList [data-view-key="request:failed"]');
        const badge = card.locator(".card-outcome-face");
        const status = await badge.evaluate(measureControlSurface);
        const prompt = await card.locator(".request-card-prompt").evaluate(measureControlSurface);
        assert.ok(contrast(status.ink, status.face) >= 4.5 && contrast(prompt.ink, prompt.face) >= 4.5);
        assert.notEqual(status.ink, prompt.ink);
        const open = card.locator(".request-card-open"); await open.press("Enter");
        const call = page.locator('[data-tool-call-id="failed"]'), returned = call.locator(".api-result-entry");
        await expect(returned).toHaveCount(1);
        await expect(returned).toContainText("UnsupportedItem"); await expect(returned).toContainText("403");
        await expect(returned).toContainText("This operation requires an editable item.");
        await expect(call.locator(".returned-coverage")).toContainText("The full total is unknown.");
        await expect(call).not.toContainText("EXCLUDED_BODY");
        const toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        const copy = call.getByRole("button",{name:"Copy recorded arguments",exact:true});
        const height = (await call.boundingBox()).height;
        await copy.click();
        assert.equal((await call.boundingBox()).height, height);
        assert.deepEqual(JSON.parse(await page.evaluate(() => window.copies.at(-1))), records[0].toolCalls[0].requestArgs);
        await page.goBack(); await expect(open).toBeFocused();
    }
});
