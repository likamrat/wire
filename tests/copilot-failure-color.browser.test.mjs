import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { retainEvent } from "../lib/collector.mjs";
import { completeWorkIqCall } from "../lib/history.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

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

test("normal cards and reader color compact status units, not explanatory prose, without changing unknowns or Copy geometry", { timeout: 60000 }, async t => {
    const records = [record("failed", false), record("completed", true), record("unknown", null), record("partial", null), record("transport", false)];
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const app = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], unexpected = [], observations = [];
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
    const proof = process.env.WIRE_FAILURE_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const ready = () => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
        for (const [id, outcome] of [["completed", "success"], ["failed", "failure"], ["unknown", "unknown"], ["partial", "partial"], ["transport", "failure"]]) {
            const card = page.locator(".request-card-open").filter({ hasText: `invented ${id} operation` });
            const summary = card.locator(".request-card-problem");
            await expect(summary).toHaveAttribute("data-outcome", outcome);
            const cardStatus = summary.locator(".result-status").first();
            const cardPaint = await cardStatus.evaluate(measureControlSurface);
            if (["success", "failure"].includes(outcome)) {
                const colors = await cardStatus.evaluate(node => [node, ...node.querySelectorAll("span,svg")].map(part => getComputedStyle(part).color));
                assert.ok(colors.every(color => color === colors[0]), `${theme} ${id} card: ${colors}`);
                assert.ok(contrast(cardPaint.ink, cardPaint.face) >= 4.5, JSON.stringify(cardPaint));
                const prose = await summary.locator(".request-card-reason-text").first().evaluate(measureControlSurface);
                assert.notEqual(prose.ink, cardPaint.ink);
                assert.ok(contrast(prose.ink, prose.face) >= 4.5, JSON.stringify(prose));
            }
            if (id === "failed") {
                await expect(summary).toContainText("Returned entry 1: The requested operation is not available for this item.");
                await expect(summary).toContainText("UnsupportedItem; status 403");
                await expect(summary).not.toContainText(/too long|did not save|unsupported format/i);
                if (proof && width === 1440) {
                    await card.scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(proof, `${theme}-primary-card.png`) });
                }
            }
            if (id === "transport") {
                await expect(summary).toContainText("HTTP 503 Service Unavailable: upstream connection timeout");
                await expect(summary).not.toContainText("InventedTransport");
                await expect(summary).toContainText("Transport ... error: HTTP 503");
                const summaryText = await summary.textContent();
                assert.ok(summaryText.length < 300, summaryText);
                if (proof) {
                    await card.scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-transport-card.png`) });
                }
            }
            await card.click(); await ready();
            const call = page.locator(`[data-tool-call-id="${id}"]`);
            const line = call.locator(".reader-call-summary .recorded-result");
            await expect(line).toHaveAttribute("data-outcome", outcome);
            await expect(line.locator(".reader-entry-label")).toHaveText("Call #1");
            const status = await line.locator(".result-status").count() ? line.locator(".result-status") : line;
            const colors = await status.evaluate(node => [node, ...node.querySelectorAll("span,svg")].map(part => getComputedStyle(part).color));
            if (["success", "failure"].includes(outcome)) assert.ok(colors.every(color => color === colors[0]), `${theme} ${id} reader: ${colors}`);
            const paint = await status.evaluate(measureControlSurface);
            assert.ok(contrast(paint.ink, paint.face) >= 4.5, JSON.stringify(paint));
            if (await line.locator(".result-cause:visible").count()) {
                const prose = await line.locator(".result-cause").evaluate(measureControlSurface);
                assert.ok(contrast(prose.ink, prose.face) >= 4.5, JSON.stringify(prose));
                if (["success", "failure"].includes(outcome)) assert.notEqual(prose.ink, paint.ink);
            }
            if (id === "failed") {
                const toggle = call.locator(".reader-call-toggle");
                if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
                await expect(call).toContainText(message);
                await expect(call).toContainText("This operation requires an editable item.");
                await expect(call.locator(".returned-coverage")).toContainText("The full total is unknown.");
                await expect(call.locator(".returned-api-entries .list-pager")).toContainText("retained entries");
                await expect(call).toContainText("Not attributed to a target in this batch");
                await expect(call).not.toContainText("EXCLUDED_BODY");
                const copy = call.getByRole("button", { name: "Copy recorded arguments", exact: true });
                await copy.scrollIntoViewIfNeeded();
                const before = await call.boundingBox();
                await copy.click();
                const after = await call.boundingBox();
                assert.equal(after.height, before.height, "Copy feedback must not add a row.");
                assert.equal((await page.evaluate(() => window.copies)).at(-1), JSON.stringify(records[0].toolCalls[0].requestArgs, null, 2));
                await toggle.focus(); await page.keyboard.press("Enter");
                await expect(toggle).toBeFocused(); await expect(call.locator(".technical-detail")).toBeHidden();
                await page.keyboard.press("Enter"); await expect(toggle).toBeFocused();
                if (proof) {
                    await call.locator(".reader-call-summary").scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-failure-screen.png`) });
                    if (width === 1440) {
                        await call.locator(".api-result-entry").scrollIntoViewIfNeeded();
                        await page.screenshot({ path: path.join(proof, `${theme}-returned-error.png`) });
                    }
                }
            }
            if (id === "transport") {
                const toggle = call.locator(".reader-call-toggle");
                if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
                await expect(call.locator(".reader-error-message")).toHaveText(transportMessage);
            }
            const overflow = await page.locator("#contextSidebarBody").evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth,
                overflowing: [...node.querySelectorAll("*")].filter(part => part.scrollWidth > part.clientWidth + 1 && part.clientWidth > 0)
                    .map(part => ({ tag: part.tagName, class: part.className, width: part.clientWidth, scroll: part.scrollWidth })).slice(0, 12) }));
            assert.ok(overflow.scroll <= overflow.client + 1, JSON.stringify({ theme, width, scale, id, overflow }));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            observations.push({ theme, width, scale, id, colors, contrast: contrast(paint.ink, paint.face) });
            await page.locator("#closeContextSidebar").click(); await ready();
        }
    }
    if (proof) await writeFile(path.join(proof, "status-line-paint.json"), JSON.stringify(observations, null, 2));
});
