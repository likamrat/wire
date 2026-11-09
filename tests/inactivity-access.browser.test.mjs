import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture } from "./helpers.mjs";

async function setup(t, view = "analyze", initialize) {
    const cleanup = [];
    const { context } = await privateFixture({ after: work => cleanup.push(work) });
    const access = await createCopilotRuntimeAccess(context);
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, access,
    });
    const browser = await chromium.launch({
        ...(process.env.WORKIQ_BROWSER_CHANNEL ? { channel: process.env.WORKIQ_BROWSER_CHANNEL } : {}),
    });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await profile.newPage(), requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith("/api/")) requests.push(pathname);
    });
    t.after(async () => {
        await browser.close(); await runtime.close(); await access.close();
        for (const work of cleanup) await work();
        assert.deepEqual(errors, []);
    });
    if (initialize) await page.addInitScript(initialize);
    await page.goto(runtime.url + "#" + view);
    if (view === "analyze") await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(view === "analyze" ? "#activityView" : "#reportsView")).toBeVisible();
    return { page, profile, requests, url: runtime.url };
}

async function visibility(page, hidden) {
    return page.evaluate(hidden => {
        // Headless pages do not become hidden on tab switches; use the real listener.
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        return new Promise(resolve => requestAnimationFrame(() => resolve({
            workspace: !document.getElementById("workspace").hidden,
            checking: !document.getElementById("accessShell").hidden,
        })));
    }, hidden);
}

async function capture(page, name) {
    if (!process.env.WIRE_INACTIVITY_PROOFS) return;
    await mkdir(process.env.WIRE_INACTIVITY_PROOFS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_INACTIVITY_PROOFS, name + ".png") });
}

for (const view of ["analyze", "reports"]) test(`still-authorized background return keeps ${view} painted without a replacement snapshot`, { timeout: 20000 }, async t => {
    const { page, requests } = await setup(t, view);
    const content = view === "analyze" ? page.locator(".request-card-open").first()
        : page.locator("#reportsView").getByRole("button", { name: /^All activity / });
    const owner = await content.elementHandle();
    const snapshots = requests.filter(value => value === "/api/snapshot").length;
    let navigations = 0;
    page.on("request", request => { if (request.isNavigationRequest()) navigations++; });
    await capture(page, `${view}-01-readable`);
    await visibility(page, true);
    // Longer than the unchanged five-second grant: only continuing real watches can keep it current.
    await page.waitForTimeout(6000);
    const held = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => { await held.promise; await route.continue(); });
    try {
        const firstFrame = await visibility(page, false);
        await capture(page, `${view}-02-return-first-frame`);
        assert.deepEqual(firstFrame, { workspace: true, checking: false },
            "Returning to current authority must not paint the whole-page access-check shell.");
        if (view === "analyze") await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        await expect(content).toBeVisible();
        assert.equal(await owner.evaluate(node => node.isConnected), true, "Keep the accepted view, not a reconstruction.");
        assert.equal(requests.filter(value => value === "/api/snapshot").length, snapshots);
        assert.equal(requests.filter(value => value === "/api/session").length, 0);
        assert.equal(navigations, 0);
        assert.equal(requests.some(value => value === "/api/access/command"), false);
    } finally { held.resolve(); }
});

test("a still-fresh watch after a renderer stall keeps Reports painted without rereading", { timeout: 20000 }, async t => {
    const { page, requests } = await setup(t, "reports", () => {
        const nativeFetch = fetch.bind(window), nativeJSON = Response.prototype.json;
        const starts = new WeakMap();
        window.watchStall = { count: 0, armed: false };
        window.fetch = async (...args) => {
            const start = performance.now(), response = await nativeFetch(...args);
            if (response.url.endsWith("/api/access/watch")) starts.set(response, start);
            return response;
        };
        Response.prototype.json = async function () {
            const value = await nativeJSON.call(this);
            if (!starts.has(this)) return value;
            const start = starts.get(this), previousDeadline = window.watchStall.deadline;
            window.watchStall.count++;
            if (window.watchStall.armed) {
                window.watchStall.armed = false;
                const end = performance.now() + 3500;
                while (performance.now() < end) { /* Model queued work during a suspended renderer's return. */ }
                window.watchStall.returned = { at: performance.now(), previousDeadline, deadline: start + 5000 };
                const nextHeartbeats = window.watchStall.count + 2;
                window.watchStall.frames = [];
                const sample = () => {
                    window.watchStall.frames.push({
                        workspace: !document.getElementById("workspace").hidden,
                        checking: !document.getElementById("accessShell").hidden,
                    });
                    if (window.watchStall.count < nextHeartbeats) requestAnimationFrame(sample);
                    else window.watchStall.complete = true;
                };
                requestAnimationFrame(sample);
            }
            window.watchStall.deadline = start + 5000;
            return value;
        };
    });
    await page.waitForFunction(() => window.watchStall.count >= 2);
    const content = page.locator("#reportsView").getByRole("button", { name: /^All activity / });
    const owner = await content.elementHandle(), snapshots = requests.filter(path => path === "/api/snapshot").length;
    const release = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => { await release.promise; await route.continue(); });
    try {
        await page.evaluate(() => { window.watchStall.armed = true; });
        await page.waitForFunction(() => window.watchStall.complete);
        const { returned, frames } = await page.evaluate(() => window.watchStall);
        t.diagnostic(JSON.stringify({ returned, firstVisibleFrame: frames[0],
            blankFrames: frames.filter(frame => !frame.workspace || frame.checking).length }));
        assert.ok(returned.at >= returned.previousDeadline, "The predecessor deadline was crossed.");
        assert.ok(returned.at < returned.deadline, "The incoming watch itself remains fresh.");
        await capture(page, "reports-stall-first-frame");
        assert.ok(frames.every(frame => frame.workspace && !frame.checking),
            "Keep the first return frame and the following two watch deliveries painted.");
        assert.equal(await owner.evaluate(node => node.isConnected), true);
        assert.equal(requests.filter(path => path === "/api/snapshot").length, snapshots);
        assert.equal(requests.filter(path => path === "/api/session").length, 0);
    } finally { release.resolve(); }
});

test("background logout still clears the accepted view and return never signs in", { timeout: 15000 }, async t => {
    const { page, profile, requests, url } = await setup(t);
    const oldText = await page.locator(".request-card-open p").last().evaluateHandle(node =>
        document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode());
    assert.match(await oldText.evaluate(node => node.data), /SYNTHETIC_PRIVATE_PROMPT/);
    const controller = await profile.newPage();
    await controller.goto(url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await visibility(page, true);
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(controller.locator("#message")).toContainText("signed out");
    await expect(page.locator("#message")).toContainText("signed out");
    assert.equal(await oldText.evaluate(node => node.data), "");
    await visibility(page, false);
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#message")).toContainText("signed out");
    assert.doesNotMatch(await page.content(), /SYNTHETIC_PRIVATE_PROMPT/);
    assert.equal(requests.some(value => value === "/api/access/command"), false);
});

test("a stale background watch still hides activity until fresh access is confirmed", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    let held = false;
    const release = Promise.withResolvers();
    await page.route("**/api/access/watch", async route => {
        held = true;
        await release.promise;
        await route.continue();
    });
    try {
        await visibility(page, true);
        await expect.poll(() => held).toBe(true);
        await expect(page.locator("#workspace")).toBeHidden({ timeout: 7000 });
        assert.doesNotMatch(await page.content(), /SYNTHETIC_PRIVATE_PROMPT/);
        const firstFrame = await visibility(page, false);
        assert.deepEqual(firstFrame, { workspace: false, checking: true },
            "Visibility is not authority when the existing freshness bound was lost.");
        release.resolve();
        await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        await expect(page.locator("#workspace")).toBeVisible();
    } finally { release.resolve(); }
});

test("page departure still retires private content and cached-page return needs fresh authority", { timeout: 15000 }, async t => {
    const { page, requests } = await setup(t);
    const card = await page.locator(".request-card-open").first().elementHandle();
    const snapshots = requests.filter(value => value === "/api/snapshot").length;
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("#workspace")).toBeHidden();
    assert.doesNotMatch(await page.content(), /SYNTHETIC_PRIVATE_PROMPT/);
    const release = Promise.withResolvers();
    let held = false;
    await page.route("**/api/access/watch", async route => {
        held = true; await release.promise; await route.continue();
    });
    try {
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await expect.poll(() => held).toBe(true);
        await expect(page.locator("#workspace")).toBeHidden();
        release.resolve();
        await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
        assert.equal(await card.evaluate(node => node.isConnected), false);
        assert.equal(requests.filter(value => value === "/api/snapshot").length, snapshots + 1);
        assert.equal(requests.some(value => value === "/api/access/command"), false);
    } finally { release.resolve(); }
});
