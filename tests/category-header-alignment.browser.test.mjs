import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = async page => {
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

async function setup(t) {
    const records = Array.from({ length: 4 }, (_, index) => {
        const record = fixture("category-alignment-" + index);
        record.capturedAt = new Date(Date.UTC(2026, 9, 18, 12, 4 - index)).toISOString();
        record.userPrompt = { text: index === 1 ? "" : [
            "Continue checking the workshop notes and explain what still needs attention.",
            "",
            "Check the workshop handover across mail, shared files and Teams, then look for the remaining notes.",
            "Check what the retained evidence can tell us about the unfinished workshop request.",
        ][index], status: "full", sourceEventId: "category-prompt-" + index, sourceTimestamp: record.capturedAt,
            authorship: { actor: index === 1 ? "agent" : "user", basis: index === 1 ? "autopilot" : "source-user" },
            ...index === 1 ? { capture: { version: 1, kind: "automatic-continuation", original: "empty",
                hostContext: "not-collected", reason: null } } : {} };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: index === 2 ? 2 : 1 }, (_, call) => ({
            tool: index < 2 || call === 1 ? "workiq-retrieve" : "workiq-fetch",
            toolCallId: `alignment-call-${index}-${call}`, startEventId: `alignment-start-${index}-${call}`,
            startedAt: record.capturedAt, durationMs: 300,
            requestArgs: index < 2 || call === 1 ? { query: "SYNTHETIC_WORKSHOP_LOOKUP" }
                : index === 2 ? { entityUrls: ["/me/messages/example", "/me/drive/items/example", "/teams/example/channels"] } : {},
            toolSucceeded: index === 3 ? null : call === 1,
            reportedOutcome: index === 3 ? "unknown" : call === 1 ? "succeeded" : "failed",
            apiResults: [],
            ...index !== 3 && call === 0 ? { failureEvidence: { version: 1, reason: "error-code-recorded",
                code: "failure", messageStatus: "text-excluded",
                messageSignal: index === 2 ? "access-denial" : "workiq-sign-in-required" } } : {},
        }));
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("No providers in category alignment proof."); },
            readSource() { throw Error("No source-history reads in category alignment proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url + "#analyze");
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime };
}

test("a forced-color reader keeps the selected call, its ordinal and its disclosure usable at 200% text", async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 960 });
    await page.emulateMedia({ forcedColors: "active" });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const origin = page.locator('#activityList [data-view-key="request:category-alignment-2"]').getByRole("link", {name:"1 tool call failed", exact:true});
    await origin.press("Enter"); await settled(page);
    const call = page.locator('[data-tool-call-id="alignment-call-2-0"]');
    await expect(call.locator(".reader-entry-label")).toHaveText("Call #1");
    await expect(call.locator(".reader-tool-name")).toHaveText("workiq-fetch");
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.press("Enter");
    await expect(call.locator(".reader-input-value")).toContainText("/me/messages/example");
    await expect(call).toContainText("Access was denied");
    await toggle.press("Space"); await expect(toggle).toBeFocused(); await expect(toggle).toHaveAttribute("aria-expanded","false");
    assert.ok(await page.locator("#contextSidebarBody").evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    await page.goBack(); await expect(origin).toBeFocused();
});
