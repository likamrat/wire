import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { retainEvent } from "../../lib/collector.mjs";
import { extractScenarios } from "../../lib/history.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { privateFixture } from "../support/helpers.mjs";
import { recollectionFixture } from "../collection/recollection-fixture.mjs";

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

test("expanded fetch retains a separate completion detail without attributing it to either path or the next discovery", { timeout: 30000 }, async t => {
    const app = await recollectionFixture(t, { collectInitially: false });
    const prompt = "Inspect the two invented folders.", reason = "The folder version has changed.";
    const calls = Array.from({ length: 7 }, (_, i) => {
        const toolCallId = `folder-call-${i + 1}`, fetch = i === 5;
        return [
            ["tool.execution_start", { toolCallId, toolName: fetch ? "workiq-fetch" : "workiq-search_paths",
                arguments: fetch ? { entityUrls: ["/me/drive/root:/example-a", "/me/drive/root:/example-b"] } : { query: "folders" } }],
            ["tool.execution_complete", { toolCallId, success: !fetch, ...(fetch ? { error: {
                code: "failure", message: `MCP server 'workiq': {"unknown":"EXCLUDED_RAW"}`, statusCode: 409,
                details: [{ code: "VersionMismatch", message: reason }],
            } } : {}) }],
        ];
    }).flat();
    const now = Date.now() - 30000;
    const source = [["session.start", { sessionId: app.sourceId, version: 1 }],
        ["user.message", { content: prompt }], ...calls].map(([type, data], i) => ({
        id: `event-${i}`, timestamp: new Date(now + 100 * i).toISOString(), type, data,
    }));
    await writeFile(app.files[0], source.map(event => JSON.stringify(event) + "\n").join(""));
    await app.collector.collectNow();
    await app.restart();
    const state = await loadBoardState(app.context);
    const record = state.evidence.find(row => row.userPrompt.text === prompt);
    assert.deepEqual(record.toolCalls.slice(5).map(call => [call.order, call.tool, call.reportedOutcome, call.apiResults.length]),
        [[6, "workiq-fetch", "failed", 0], [7, "workiq-search_paths", "succeeded", 0]]);
    assert.doesNotMatch(JSON.stringify(record), /EXCLUDED_RAW/);

    const browser = await chromium.launch();
    app.closeClient(() => browser.close());
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(app.runtime.url).origin
        ? route.continue() : route.abort());
    await page.goto(app.runtime.url);
    await page.locator(".activity-card").filter({ hasText: prompt }).locator(".request-card-open").click();
    const call = page.locator('[data-reader-section=activity] [data-tool-call-id="folder-call-6"]');
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(call.locator(".reader-entry-label")).toHaveText("Call #6");
    const detail = call.locator(".technical-detail");
    for (const text of [reason, "VersionMismatch", "409", "could not extract all error details",
        "/me/drive/root:/example-a", "/me/drive/root:/example-b"]) await expect(detail).toContainText(text);
    await expect(call.locator(".api-result-entry")).toHaveCount(0);
    const discovery = page.locator('[data-reader-section=activity] [data-tool-call-id="folder-call-7"]');
    await expect(discovery.locator(".reader-entry-label")).toHaveText("Call #7");
    await expect(discovery).toContainText("workiq-search_paths");
    await expect(discovery).toContainText("1 tool call completed");
    await expect(discovery).not.toContainText(reason);
    if (process.env.WIRE_FAILURE_PROOFS) {
        await mkdir(process.env.WIRE_FAILURE_PROOFS, { recursive: true });
        await detail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, "expanded-fetch.png") });
    }
});
