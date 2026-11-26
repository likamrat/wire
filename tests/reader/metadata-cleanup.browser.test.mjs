import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture } from "../support/helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settle = async page => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .every(animation => animation.playState !== "running"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

function records() {
    return [
        ["ask", "workiq-ask", { question: "Find the invented workshop planning notes." }],
        ["known", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop"] }],
        ["mixed", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop", "/unrecognized/target"] }],
        ["multiple", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop", "/me/messages/workshop", "/teams/workshop/channels"] }],
        ["unknown", "workiq-fetch", {}],
        ["discovery", "workiq-search_paths", { query: "workshop" }],
        ["search", "workiq-retrieve", { query: "workshop" }],
    ].map(([id, tool, requestArgs], index) => {
        const record = fixture("metadata-cleanup-" + id);
        record.capturedAt = new Date(Date.UTC(2026, 9, 18, 12, 7 - index)).toISOString();
        record.userPrompt = { text: id === "ask" ? "Find the notes for the invented community workshop."
            : `Check the invented ${id} workshop record and explain what the saved evidence shows.`,
        status: "full", sourceEventId: `prompt-${id}`, sourceTimestamp: record.capturedAt,
        authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = [{ tool, requestArgs, toolCallId: `call-${id}`, startEventId: `start-${id}`,
            startedAt: record.capturedAt, durationMs: 73000, toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [] }];
        return record;
    });
}

async function setup(t) {
    const cleanup = [], data = records();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, data);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No providers in metadata cleanup proof."); },
            readSource() { throw Error("No source reads in metadata cleanup proof."); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.context().addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        async writeText(text) { window.syntheticCopiedText = text; },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#analyze"); await ready(page); await settle(page);
    return { page, data, runtime };
}

test("the report picker preserves interaction and service identity when opening the complete retained prompt", async t => {
    const { page, data } = await setup(t);
    await page.clock.setFixedTime(new Date("2026-10-19T12:00:00Z"));
    await page.getByRole("link", {name:"Reports",exact:true}).click();
    await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", {name:"Choose activity"});
    await picker.getByRole("radio", {name:/^Selected interactions/}).check();
    const row = picker.locator('[data-view-key="report:metadata-cleanup-ask"]');
    await row.getByRole("checkbox").check();
    await expect(row).toContainText("workiq-ask");
    const link = row.locator(".request-card-open");
    await link.press("Enter");
    const call = page.locator('[data-tool-call-id="call-ask"]');
    await expect(call.locator(".reader-tool-name")).toHaveText("workiq-ask");
    await expect(call).not.toContainText(/Target\s*Mail|Target\s*Files/);
    await page.getByRole("button",{name:"Copy prompt",exact:true}).click();
    assert.equal(await page.evaluate(() => window.syntheticCopiedText), data[0].userPrompt.text);
    await page.goBack();
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(link).toBeFocused();
});
