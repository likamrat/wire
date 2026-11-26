import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { privateFixture } from "../support/helpers.mjs";

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t, empty = false) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, empty ? [] : undefined);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(15000);
    const errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    const current = {
        state: "collecting-on-interval", revision: before.revision, configVersion: "synthetic-unchanged",
        config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
        connected: true, lastCheckedAt: new Date().toISOString(), lastNewDataAt: "2026-10-04T23:00:00Z",
        discovery: { counts: { sessions: 12, dispositions: { eligible: 10, archived: 2 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 10, readable: 8, unavailable: 2, limited: 3, affected: 5, pending: 0 }, historyIssues: [],
        cadence: { pollSeconds: 5 }, metrics: {},
    };
    let override = {}, statusError = false;
    const status = () => ({ ...current, ...override });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: status() } });
    });
    await page.route("**/api/collection/status", async route => {
        if (statusError) return route.fulfill({ status: 503, json: { error: "Synthetic status connection interrupted." } });
        await route.fulfill({ json: status() });
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status"].includes(url)), "Entry inspection never authorizes mutations");
        } finally { for (const action of cleanup) await action(); }
    });
    return { page, runtime, current, set: next => { override = next; }, failStatus: value => { statusError = value; } };
}

for (const empty of [true, false]) test(`source notices on Analyze with ${empty ? "no activity" : "retained activity"} open the relevant settings`, async t => {
    const { page, runtime, current, set } = await setup(t, empty);
    const notice = page.locator("#collectionNotice"), action = page.locator("#collectionNoticeAction");
    for (const [status, message, destination] of [
        [{}, null],
        [{ state: "paused", config: { ...current.config, enabled: false } }, null],
        [{ state: "disconnected", config: null }, empty ? /Connect local Copilot chats/ : /Retained evidence is available/, "/settings?section=connection&setting=source"],
        [{ state: "error", error: "Synthetic private source failure" }, /cannot check history/, "/collection-status"],
        [{ historyCoverage: { ...current.historyCoverage, unavailable: 10, readable: 0 } }, /History unavailable/, "/collection-status?setting=issues"],
        [{ state: "stopped" }, /Collection stopped/, "/collection-status"],
    ]) {
        set(status);
        await page.goto(runtime.url); await ready(page);
        await expect(page.locator("#activityList article")).toHaveCount(empty ? 0 : 1);
        if (!message) { await expect(notice).toBeHidden(); continue; }
        await expect(notice).toContainText(message);
        await expect(notice).not.toContainText("Synthetic private source failure");
        await expect(action).toBeVisible();
        await action.press("Enter");
        await expect(page).toHaveURL(new URL(destination, runtime.url).href);
        await page.goBack();
        await expect(notice).toBeVisible();
        await expect(page.locator("#activityList article")).toHaveCount(empty ? 0 : 1);
    }
});

test("a failed status poll keeps the last accepted interaction and recovers without a write", async t => {
    const { page, runtime, failStatus } = await setup(t);
    await page.goto(runtime.url); await ready(page);
    const link = page.locator("#activityList .request-card-open");
    const target = await link.getAttribute("href");
    await link.focus();
    const poll = async status => {
        const read = page.waitForResponse(r => r.url().endsWith("/api/collection/status") && r.status() === status);
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await read;
    };
    failStatus(true); await poll(503);
    await expect(page.locator("#collectionNotice")).toContainText(/status unavailable.*last accepted view/i);
    await expect(link).toHaveAttribute("href", target);
    await expect(link).toBeFocused();
    failStatus(false); await poll(200);
    await expect(page.locator("#collectionNotice")).toBeHidden();
    await expect(link).toHaveAttribute("href", target);
    await expect(link).toBeFocused();
});
