import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";

test("reader shows the recorded processing failure separately from the default unsaved reply", { timeout: 30000 }, async t => {
    const source = [
        { id: "prompt", type: "user.message", timestamp: "2026-10-01T12:00:00Z", data: { content: "Read the invented planning conversation." } },
        { id: "start", type: "tool.execution_start", timestamp: "2026-10-01T12:00:01Z",
            data: { toolCallId: "invented-call", toolName: "workiq-fetch", arguments: { entityUrls: ["/chats/invented-a/messages", "/chats/invented-b/messages"] } } },
        { id: "complete", type: "tool.execution_complete", timestamp: "2026-10-01T12:00:02Z",
            data: { toolCallId: "invented-call", success: false, error: { code: "failure",
                message: "MCP server 'workiq': " + JSON.stringify({ results: [
                    { statusCode: 500, error: { error: { code: "InternalServerError", message: "Error while processing response." } } },
                    { statusCode: 200, data: { body: "PRIVATE_RESULT_BODY" } },
                ] }) } } },
    ];
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const records = extractScenarios(retained, { sessionId: "invented-session" }, source[0].timestamp, source.at(-1).timestamp).scenarios;
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context), errors = [], unexpected = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET"
            || ["/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(".request-card-open").click();
    const reader = page.locator("#requestContent"), call = reader.locator('[data-tool-call-id="invented-call"]');
    await expect(call.locator(".reader-call-summary")).toContainText("1 tool call failed");
    await expect(call.locator(".reader-entry-label")).toHaveText("Call #1");
    const entries = call.locator(".api-result-entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("InternalServerError");
    await expect(entries.first()).toContainText("500");
    await expect(entries.first()).toContainText("Error while processing response.");
    await expect(entries.last()).toContainText("200");
    await expect(entries.last()).not.toContainText("InternalServerError");
    await expect(reader).not.toContainText("WIRE did not save the error details");
    const reply = reader.locator(".reader-response-availability");
    await expect(reply).toContainText("Saving is off by default");
    await expect(reply).toContainText("The original Copilot chat may still have the reply.");
    await expect(reply).not.toContainText("older replies are not restored");
    await expect(reader).not.toContainText("PRIVATE_RESULT_BODY");
    if (await call.locator(".reader-call-toggle").getAttribute("aria-expanded") !== "true") await call.locator(".reader-call-toggle").click();
    await expect(call).not.toContainText(/try again|sign in now/i);
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
});
