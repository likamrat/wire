import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { fixture, privateFixture, openActivitySessions, navigateMain } from "./helpers.mjs";
import { scanReport } from "./report-journey-helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";

test("changed selected evidence cannot approve the otherwise frozen report preview", { timeout: 30000 }, async t => {
    const selected = fixture("selected-report-source"), outside = fixture("outside-report-source"), cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [selected, outside]);
    let runtime, browser;
    const errors = [], calls = [];
    t.after(async () => {
        try { await browser?.close(); assert.deepEqual(errors, []); }
        finally { try { await runtime?.close(); } finally { for (const action of cleanup) await action(); } }
    });
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") calls.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url + "#activity");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await openActivitySessions(page);
    await page.locator('.request-row[data-view-key="request:selected-report-source"] input[type=checkbox]').check();
    await navigateMain(page, "reports");
    const preview = await scanReport(page);
    assert.equal(preview.records.length, 1);
    const originalPreviewText = await page.locator(".report-frame").getAttribute("srcdoc");
    selected.toolCalls[0].toolSucceeded = false;
    selected.toolCalls[0].reportedOutcome = "failed";
    await replaceEvidence(context, () => ({ records: [selected, outside], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    await page.locator(".attestation input[data-review-control]").check();
    const review = page.waitForResponse(response => response.url().endsWith("/api/privacy-review"));
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    const response = await review;
    assert.equal(response.status(), 409, await response.text());
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(await page.locator(".report-frame").getAttribute("srcdoc"), originalPreviewText, "The rejected frozen preview is not silently rebuilt from changed evidence.");
    assert.equal(await page.getByRole("button", { name: "3. Save locally", exact: true }).isEnabled(), false);
    assert.equal(calls.includes("/api/export"), false);
    assert.ok(calls.every(path => [
        "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
        "/api/preview", "/api/privacy-review", "/api/cancel-preview",
    ].includes(path)), "Only isolated selected-report reads, preparation and the rejected explicit review were attempted.");
});
