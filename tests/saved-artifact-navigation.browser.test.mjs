import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture } from "./helpers.mjs";

for (const exit of ["route", "pagehide"]) test(`saved-artifact receipt read releases the real shell on ${exit} without replay or late focus`, { timeout: 20000 }, async t => {
    const { context } = await privateFixture(t, [fixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0 });
    const browser = await chromium.launch(), page = await browser.newPage();
    const receipt = { operationId: "00000000-0000-4000-8000-000000000001", receiptToken: "a".repeat(64) };
    let entered, release;
    const reading = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const calls = [], errors = [];
    t.after(async () => { release(); await browser.close(); await runtime.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/api/artifact-deletion/")) calls.push(new URL(request.url()).pathname); });
    await page.addInitScript(receipt => sessionStorage.setItem("wire.saved-artifact-deletion", JSON.stringify(receipt)), receipt);
    await page.route("**/api/artifact-deletion/status", async route => {
        entered(); await held;
        await route.fulfill({ json: { operationId: receipt.operationId, phase: "pending" } });
    });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.getByRole("button", { name: "Check earlier saved-item deletion", exact: true }).click();
    await reading;
    assert.equal(await page.locator(":modal").count(), 1);
    if (exit === "route") {
        await page.evaluate(() => { location.hash = "#activity"; });
        await page.locator("#activityView").waitFor({ state: "visible" });
    } else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal(await page.locator(":modal").count(), 0, "Navigation must release the pending-read modal");
    await page.locator("#pageTitle").evaluate(node => { node.tabIndex = -1; node.focus(); });
    const completed = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/status"));
    release();
    await completed;
    await page.waitForTimeout(150);
    assert.equal(await page.locator(":modal").count(), 0, "A late read cannot reopen the old overlay");
    assert.equal(await page.evaluate(() => document.activeElement.id), "pageTitle", "A late read cannot steal destination focus");
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("wire.saved-artifact-deletion"))), receipt);
    assert.deepEqual(calls, ["/api/artifact-deletion/status"], "Receipt reading never previews, confirms or replays deletion");
});
