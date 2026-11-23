import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, navigateMain, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function setup(t, { route = "", height = 1000, approved = true } = {}) {
    const records = Array.from({ length: 10 }, (_, index) => {
        const row = fixture(`scope-action-${index}`);
        row.sourceSessionId = `scope-chat-${index % 2}`;
        row.sourceSessionName = "Invented planning chat " + (index % 2 + 1);
        row.projectId = index % 2 ? "project-b" : "project-a";
        row.project = "Invented project " + (index % 2 ? "B" : "A");
        row.userPrompt = { ...row.userPrompt, text: `Invented milestone ${index + 1}`, sourceEventId: `prompt-${index}` };
        row.followUpPrompts = [];
        Object.assign(row.toolCalls[0], { startedAt: row.capturedAt, completedAt: "2026-09-30T12:00:01.000Z",
            durationMs: 1000, completionEventId: `completed-${index}` });
        return row;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const initial = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const requests = [], errors = [], unexpected = [];
    const status = original => ({ ...original, configVersion: "invented-source-configuration",
        config: approved ? { approved: true, enabled: true, windowDays: 30, pollSeconds: 30,
            appDbPath: "C:\\Invented\\source.db", sessionRoot: "C:\\Invented\\history" } : null,
        state: approved ? "watching" : "unconfigured",
        lastCheckedAt: "2026-10-08T12:00:00.000Z",
        discovery: { counts: { sessions: 2 } }, cadence: { pollSeconds: 30, browserPollSeconds: 5 },
        historyCoverage: { eligible: 2, readable: 2, unavailable: 0, limited: 0, pending: 0, affected: 0, excluded: {} },
    });
    let lastStatus;
    await page.route("**/api/**", async route => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        if (request.method() === "POST") requests.push({ endpoint, body: request.postDataJSON() });
        const allowed = ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
            "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
            "/api/preview", "/api/cancel-preview"];
        if (!allowed.includes(endpoint)) { unexpected.push(endpoint); return route.abort(); }
        const response = await route.fetch();
        if (endpoint === "/api/snapshot") {
            const json = await response.json(); json.collection = lastStatus = status(json.collection);
            return route.fulfill({ response, json });
        }
        if (endpoint === "/api/collection/status") {
            lastStatus = status(await response.json()); return route.fulfill({ response, json: lastStatus });
        }
        return route.fulfill({ response });
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const current = await loadBoardState(context);
            assert.deepEqual(current.evidence, initial.evidence);
            assert.deepEqual(current.exports, initial.exports);
            assert.deepEqual(current.personalEvaluation, initial.personalEvaluation);
            assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + route); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    await frames(page);
    return { page, requests, status };
}
for (const superseding of ["none", "user scroll", "meaningful focus", "navigation", "newer read", "failed read"]) {
    test(`Reports stored-read recovery respects ${superseding === "none" ? "its keyboard return" : superseding}`, async t => {
        const { page, status, requests } = await setup(t, { route: "reports", height: superseding === "user scroll" ? 500 : 1000 });
        await expect(page.locator("#refreshBtn")).toBeHidden();
        // Stored reads are a recovery action, not a permanent button in the history section.
        await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented stored-read failure" } }), { times: 1 });
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await retry.focus(); await expect(retry).toBeFocused();
        const release = deferred();
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), json = await response.json(); await release.promise;
            if (superseding === "failed read") await route.fulfill({ status: 503, json: { error: "Invented repeat failure" } });
            else await route.fulfill({ response, json: { ...json, collection: status(json.collection) } });
        }, { times: 1 });
        t.after(() => release.resolve());
        const dispatched = page.waitForRequest(request => request.url().endsWith("/api/snapshot"));
        await retry.press("Enter"); const request = await dispatched;
        const library = page.getByRole("link", { name: "Saved library", exact: true });
        if (superseding === "user scroll") {
            const at = await page.evaluate(() => scrollY);
            await page.mouse.move(1050, 400); await page.mouse.wheel(0, 500);
            await expect.poll(() => page.evaluate(() => scrollY)).not.toBe(at);
            await frames(page);
        } else if (superseding === "meaningful focus") await library.focus();
        else if (superseding === "navigation") await navigateMain(page, "analyze");
        else if (superseding === "newer read") {
            const next = page.waitForResponse(r => r.url().endsWith("/api/snapshot") && r.request() !== request);
            await page.evaluate(() => window.dispatchEvent(new Event("online"))); await next;
        }
        const position = () => page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
        const before = superseding === "user scroll" ? await position() : null;
        release.resolve(); await request.response(); await ready(page); await frames(page);
        const title = page.locator("#pageTitle");
        if (superseding === "none") await expect(title).toBeFocused();
        if (superseding === "meaningful focus") await expect(library).toBeFocused();
        if (superseding === "navigation") await expect(page).toHaveURL(url => url.pathname === "/");
        if (superseding === "user scroll") {
            const after = await position();
            // Successful recovery removes the error panel, shortening the scrollable page.
            assert.ok(Math.abs(after.y - Math.min(before.y, after.max)) <= 1, JSON.stringify({ before, after }));
        }
        if (superseding === "failed read") await expect(retry).toBeEnabled();
        else await expect(retry).toBeHidden();
        if (superseding !== "none" && superseding !== "navigation") await expect(title).not.toBeFocused();
        assert.ok(!requests.some(row => row.endpoint === "/api/collection/now"));
    });
}

test("Reports preparation defers background activity changes without cancelling or replacing the frozen copy", async t => {
    const { page, requests, status } = await setup(t, { route: "reports" });
    await page.locator("#reportDeskActivity").click();
    await page.locator('[name=reportScope][value=selected]').check();
    await page.locator('[data-report-request="scope-action-0"]').check();
    await page.getByRole("button", { name: "Use activity", exact: true }).click();
    const reading = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.locator("#prepareReportPreview").click(); const response = await reading, preview = await response.json();
    assert.equal(response.status(), 200, preview.error);
    assert.deepEqual(response.request().postDataJSON().selection.scenarioIds, ["scope-action-0"]);
    const frame = page.frameLocator(".report-contained-frame");
    await expect(frame.locator("h1")).toHaveText(preview.title);
    const start = requests.length, gate = deferred();
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), json = await response.json();
        await route.fulfill({ response, json: { ...status(json), revision: json.revision + 1 } }); gate.resolve();
    }, { times: 1 });
    await gate.promise; await frames(page);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#prepareReportPreview")).toHaveAccessibleName("Resume preview");
    await page.locator("#prepareReportPreview").click();
    await expect(frame.locator("h1")).toHaveText(preview.title);
    assert.equal(preview.records.length, 1);
    assert.ok(!requests.slice(start).some(r => ["/api/preview", "/api/export", "/api/cancel-preview"].includes(r.endpoint)));
});

test("reading saved activity and resetting filters preserve the chosen interaction and report text policy", async t => {
    const { page, requests } = await setup(t, { approved: false });
    await navigateMain(page, "reports");
    const activity = page.getByRole("button", { name: /^Activity source:/ });
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    const selected = picker.locator('input[data-report-request="scope-action-0"]');
    const textPolicy = page.getByRole("radio", { name: /Leave out prompts and replies/ });
    await activity.click();
    await picker.getByRole("radio", { name: /^Selected interactions/ }).check();
    await selected.check();
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    await textPolicy.check();
    await navigateMain(page, "analyze");
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await selectActivityOption(page, "promptAuthorFilter", "agent"); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityList article")).toHaveCount(0);
    const [readRequest] = await Promise.all([page.waitForRequest("**/api/snapshot"), page.locator("#analyzeRefresh").click()]);
    const read = readRequest.postDataJSON();
    assert.deepEqual(read.filters.outcomes, ["failure"]);
    assert.deepEqual(read.filters.promptAuthors, ["agent"]);
    await ready(page); await openAnalyzeFilters(page);
    await page.getByRole("button", { name: "Reset filters", exact: true }).click(); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityListSummary")).toContainText("10 matching tool calls");
    await navigateMain(page, "reports");
    await expect(textPolicy).toBeChecked();
    await activity.click();
    await expect(selected).toBeChecked();
    await expect(picker.locator("input[data-report-request]:checked")).toHaveCount(1);
    assert.ok(!requests.some(row => row.endpoint === "/api/collection/now"));
});
