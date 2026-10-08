import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, revealStoredRefresh } from "./helpers.mjs";

async function screenshot(page, name) {
    const proof = process.env.WIRE_RECOVERY_PROOF_DIR;
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, name + ".png") });
}
async function setup(t) {
    const record = fixture("connection-recovery");
    record.userPrompt.sourceEventId = "invented-prompt";
    record.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    record.toolCalls[0].completedAt = "2026-09-30T12:00:01Z";
    record.toolCalls[0].durationMs = 1000;
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [record]);
    let runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const url = runtime.url;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(request); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => [
            "/api/snapshot", "/api/collection/status", "/api/session", "/api/assessment/overview", "/api/evaluation/automatic/summary",
        ].includes(new URL(request.url()).pathname)), "Recovery never collects, configures, exports or mutates.");
    });
    return {
        page, requests, url,
        stop: () => runtime.close(),
        restart: async () => { runtime = await startServer(context, createExportController(context), { port: Number(new URL(url).port), collector: { timers: false } }); },
    };
}

test("renewed polling capability revalidates the accepted snapshot even at the same revision", { timeout: 25000 }, async t => {
    const { page, requests, url } = await setup(t);
    await page.goto(url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#homeInsights .assessment-grid")).toBeVisible();
    const capability = requests.find(request => request.url().endsWith("/api/snapshot")).headers()["x-board-capability"];
    const release = await page.request.post(url + "api/session/release", {
        headers: { Origin: new URL(url).origin, "X-Board-Capability": capability }, data: {},
    });
    assert.equal(release.status(), 200);
    await expect.poll(() => requests.filter(request => request.url().endsWith("/api/session")).length, { timeout: 8000 }).toBe(1);
    await expect.poll(() => requests.filter(request => request.url().endsWith("/api/snapshot")).length).toBeGreaterThan(1);
    await expect(page.locator("#homeInsights .assessment-grid")).toBeVisible();
    await page.locator("#pageAction").click();
    await expect(page.locator("#activityView")).toBeVisible();
});

test("stopped runtime keeps only the accepted view and returns through read-only retry", { timeout: 25000 }, async t => {
    const { page, url, stop, restart } = await setup(t);
    await page.goto(url + "#activity");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const initial = await page.locator("#periodResult").innerText();
    await stop();
    await (await revealStoredRefresh(page)).click();
    await expect(page.locator("#message")).toContainText("last recorded snapshot");
    await expect(page.locator("#periodResult")).toHaveText("Previous results: " + initial);
    await expect(page.locator("#collectionNoticeText")).toContainText("Local runtime unavailable");
    await expect(page.locator("#collectionNotice")).toBeHidden();
    await expect(page.locator("#message")).toContainText("Local runtime unavailable");
    await screenshot(page, "runtime-offline-retained");
    await restart();
    await page.locator("#message").getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).toBeHidden();
    await expect(page.locator("#activityInsights .assessment-grid")).toBeVisible();
    await expect(page.locator("#collectionNoticeText")).not.toContainText("unavailable");
    await screenshot(page, "runtime-recovered");
});

test("no accepted snapshot means no claim of retained evidence; retry loads the actual view", { timeout: 15000 }, async t => {
    const { page, url } = await setup(t);
    await page.route("**/api/snapshot", route => route.abort("connectionrefused"));
    await page.goto(url);
    await expect(page.locator("#message")).toContainText("activity could not load");
    await expect(page.locator("#workspace")).toBeHidden();
    assert.doesNotMatch(await page.locator("#message").innerText(), /retained evidence.*available|last recorded snapshot/i);
    await screenshot(page, "initial-read-error");
    await page.unroute("**/api/snapshot");
    await page.locator("#message").getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#homeInsights .assessment-grid")).toBeVisible();
});

test("snapshot loading stays pending and a collector read failure does not claim the runtime is stopped", { timeout: 20000 }, async t => {
    const { page, url } = await setup(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => { await gate; await route.continue(); });
    await page.goto(url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#refreshBtn")).toBeDisabled();
    await expect(page.locator("#loading")).toBeVisible();
    await screenshot(page, "initial-read-loading");
    release();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.route("**/api/collection/status", route => route.fulfill({ status: 503, json: { error: "Synthetic collection status failure." } }));
    await expect(page.locator("#collectionNoticeText")).toContainText("Collection status unavailable", { timeout: 8000 });
    await expect(page.locator("#collectionNoticeText")).not.toContainText("Local runtime unavailable");
    await expect(page.locator("#homeInsights .assessment-grid")).toBeVisible();
    await screenshot(page, "collector-status-error");
    await page.unroute("**/api/collection/status");
    await page.locator("#collectionRetry").click();
    await expect(page.locator("#collectionNoticeText")).not.toContainText("unavailable");
});
