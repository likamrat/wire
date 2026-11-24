import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, navigateMain, revealStoredRefresh } from "./helpers.mjs";

test("freshness groups source help with the action and explains check-wide gaps", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw new Error("Freshness proof cannot run a model."); },
            readSource: async () => { denied.push("source"); throw new Error("Freshness proof cannot read evaluation sources."); },
        },
    });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined,
        ignoreDefaultArgs: ["--hide-scrollbars"] });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1644, height: 1050 }, reducedMotion: "reduce", timezoneId: "America/Los_Angeles" });
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST" && !["/api/snapshot", "/api/collection/status", "/api/session", "/api/session/release", "/api/collection/now", "/api/evaluation/automatic/summary"].includes(new URL(request.url()).pathname)) mutations.push(new URL(request.url()).pathname);
    });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(runtime.url).origin) return route.continue();
        denied.push("external request");
        return route.abort("blockedbyclient");
    });
    const coverage = { eligible: 7, readable: 3, unavailable: 4, limited: 1, pending: 1, affected: 5,
        groups: { missing: 4, context: 1 }, excluded: { archived: 2 } };
    const check = { schemaVersion: 2, id: "synthetic-check", configVersion: "synthetic-config", revision: before.revision,
        beforeRevision: before.revision, startedAt: "2026-10-08T16:47:54Z", completedAt: "2026-10-08T16:47:55Z",
        outcome: "partial", changes: { added: 0, updated: 0, items: [] }, coverage,
        eligibleSources: 7, sourcesChecked: 7, pendingSources: 1, partialSources: 0, skippedSources: 0 };
    const status = () => ({ state: "paused", configVersion: check.configVersion, revision: before.revision,
        config: { approved: true, enabled: false, windowDays: 30, pollSeconds: 5 }, connected: true,
        discovery: { counts: { sessions: 9, eligible: 7, skippedByLimit: 0 } },
        historyCoverage: coverage, metrics: {}, cadence: { pollSeconds: 5 },
        lastCheckedAt: check.completedAt, lastNewDataAt: null });
    let detailedReads = 0, checks = 0;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: status() } });
    });
    await page.route("**/api/collection/status", async route => {
        const detailed = route.request().postDataJSON().details === true;
        if (detailed) detailedReads++;
        await route.fulfill({ json: { ...status(), ...(detailed ? { historyIssues: [
            { sessionId: "invented-missing", name: "Invented missing chat", reasons: ["missing"], unavailable: true, hasPriorEvidence: false },
        ] } : {}) } });
    });
    await page.route("**/api/collection/now", async route => {
        checks++;
        await route.fulfill({ json: { ...status(), check } });
    });
    await page.goto(runtime.url);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.evaluate(() => document.fonts.ready);
    await revealStoredRefresh(page);
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "partial");
    await expect(page.locator("#freshCoverageAnnouncement")).toContainText("4 Copilot chats unavailable");
    assert.equal(detailedReads, 0, "Summary disclosure does not read personal chat inventory");
    await navigateMain(page, "collection-status");
    const reason = page.locator(".history-reason").first();
    await reason.locator(":scope > summary").click();
    await reason.locator(".history-issue > summary").first().click();
    await expect(reason).toContainText("Refresh cannot restore a missing file");
    assert.ok(detailedReads > 0);
    assert.equal(checks, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(mutations, []);
    assert.deepEqual(denied, []);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.exports, before.exports);
});
