import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence } from "../lib/store.mjs";
import { createRuntimeClient } from "../lib/runtime-client.mjs";
import { selectActivityOption, openActivitySessions, navigateMain } from "./helpers.mjs";

const { chromium } = await import(process.env.WORKIQ_PLAYWRIGHT_MODULE || "@playwright/test");
test("visibility return revalidates without reload; timed controls, history, and runtime restart", { timeout: 120000 }, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workiq-visibility-fixture-"));
    const context = { dataDir, sessionId: "synthetic-visibility-test" };
    const records = Array.from({ length: 24 }, (_, index) => ({
        scenarioId: `synthetic-${index}`, title: "Synthetic reliability evidence",
        sourceSessionId: "synthetic-session", projectId: "synthetic-project", project: "Synthetic fixture",
        capturedAt: new Date().toISOString(), workloadKind: "recorded-history", sample: false,
        userPrompt: { text: "Synthetic reliability prompt", status: "full", provenance: "human-authored" },
        followUpPrompts: [], evidenceLayer: "workiq-intermediary", sourceEligibility: { archivedAt: null },
        toolCalls: [{
            tool: "workiq-fetch", toolCallId: `synthetic-call-${index}`, startEventId: `synthetic-event-${index}`,
            requestArgs: { entityUrls: [`/fixture${index}`] }, requestedApiPath: `/fixture${index}`,
            toolSucceeded: index % 3 !== 0, reportedOutcome: index % 3 !== 0 ? "succeeded" : "failed",
            apiResults: [], observedGraphHttp: false,
        }],
    }));
    const runtimeOptions = {
        collector: { timers: false },
        recorderDiagnostics: { testTransport: async () => { throw new Error("Visibility fixture must never dispatch a diagnostic."); } },
    };
    let runtime, browser;
    try {
        await replaceEvidence(context, () => ({ records, importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
        runtime = await startServer(context, createExportController(context), { ...runtimeOptions, port: 0 });
        browser = await chromium.launch({ headless: true, ...(process.env.WORKIQ_BROWSER_CHANNEL ? { channel: process.env.WORKIQ_BROWSER_CHANNEL } : {}) });
        const page = await browser.newPage();
        const errors = [];
        const requests = [];
        page.on("pageerror", error => errors.push(error.name));
        page.on("request", request => {
            if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(new URL(request.url()).pathname);
        });
        await page.goto(runtime.url);
        const maintained = await page.locator("#activitySearch").count() > 0;
        assert.equal(maintained, true, "This regression must exercise the maintained Home/Activity/Reports interface.");
        if (maintained) await page.locator('[data-chart="endpoint"]').click();
        await page.locator(".chart-row").first().waitFor();
        let navigations = 0;
        page.on("request", request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
        const cycles = Number(process.env.WORKIQ_ENDURANCE_CYCLES || 3);
        const idleMs = Number(process.env.WORKIQ_ENDURANCE_IDLE_MS || 2000);
        for (let cycle = 0; cycle < cycles; cycle++) {
            await page.waitForTimeout(idleMs);
            // Headless tab switches do not hide documents: inject the real handler event,
            // never claim this proves Copilot's native surface lifecycle.
            const readsBefore = requests.filter(route => route === "/api/snapshot").length;
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await page.locator(".chart-row").first().click({ timeout: 3000 });
            if (maintained) {
                await page.locator(".session-toggle").waitFor();
                await openActivitySessions(page);
                await page.locator("#activityList .request-link").first().click();
                assert.match(new URL(page.url()).hash, /^#request/);
                await page.goBack();
                await page.locator("#activitySearch").fill("no-match-reliability");
                await page.getByText("No requests match", { exact: true }).waitFor();
                await page.locator("#activitySearch").fill("");
                await navigateMain(page, "collection-status");
                if (await page.locator("#recorderDiagnostics").getAttribute("open") === null) await page.locator("#recorderDiagnostics > summary").click();
                await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
                await page.locator("#recordBtn").click();
            } else {
                assert.equal(new URL(page.url()).hash, "#calls");
                await page.locator("#callsTable button").first().click();
            }
            assert.equal(await page.locator("#overlay").evaluate(node => node.open), true);
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            if (maintained) {
                assert.equal(await page.getByRole("button", { name: "Send public request", exact: true }).isDisabled(), true);
            }
            if (maintained && cycle % 2 === 0) {
                await page.goBack();
                await page.locator("#overlay").waitFor({ state: "hidden", timeout: 2000 });
            } else await page.keyboard.press("Escape");
            assert.equal(await page.locator("#overlay").evaluate(node => node.open), false);
            if (maintained) {
                await navigateMain(page, "home");
            } else await page.getByRole("link", { name: "Overview", exact: true }).click();
            await selectActivityOption(page, "outcomeFilter", maintained ? "success" : "succeeded");
            await page.waitForTimeout(100);
            await selectActivityOption(page, "outcomeFilter", "all");
            await page.waitForTimeout(500);
            assert.ok(requests.filter(route => route === "/api/snapshot").length > readsBefore, "Visibility return must issue revalidation");
        }
        let delayedReads = 0;
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            if (++delayedReads === 1) await new Promise(resolve => setTimeout(resolve, 1000));
            await route.fulfill({ response });
        });
        await selectActivityOption(page, "outcomeFilter", maintained ? "failure" : "failed");
        await page.waitForTimeout(100);
        await selectActivityOption(page, "outcomeFilter", maintained ? "success" : "succeeded");
        await page.waitForTimeout(1400);
        assert.equal(await page.locator("#outcomeFilter").inputValue(), maintained ? "success" : "succeeded");
        assert.equal(await page.locator(maintained ? "#activityCount" : "#stats dd").first().innerText(), "16", "Latest success response wins over the delayed failure response (8)");
        assert.equal(await page.locator("#refreshBtn").isEnabled(), true);
        await page.unroute("**/api/snapshot");
        const adapter = createRuntimeClient(runtime.url.slice(0, -1));
        await adapter.open("synthetic-canvas");
        await adapter.close("synthetic-canvas");
        const port = runtime.server.address().port;
        await runtime.close();
        runtime = await startServer(context, createExportController(context), { ...runtimeOptions, port });
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
        await page.locator(".chart-row").first().click({ timeout: 3000 });
        assert.equal(requests.filter(route => route === "/api/session").length, 1, "Actual server restart renews the capability once");
        assert.deepEqual(requests.filter(route => ["/api/import", "/api/record", "/api/move", "/api/privacy-review", "/api/export"].includes(route)), [], "Never submit mutations or disclosure attestation");
        assert.equal(navigations, 0, "No document reload is permitted");
        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        if (runtime) await new Promise(resolve => runtime.server.close(resolve));
        await rm(dataDir, { recursive: true });
    }
});
