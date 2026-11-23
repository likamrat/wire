import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, navigateMain, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { chooseReportScope, reportContents } from "./report-journey-helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WIRE_SCOPE_ACTION_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function setup(t, { route = "#home", width = 1200, scale = 1, theme = "light", approved = true, paused = false } = {}) {
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
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const requests = [], errors = [], unexpected = [], snapshots = [];
    const status = original => ({ ...original, configVersion: "invented-source-configuration",
        config: approved ? { approved: true, enabled: !paused, windowDays: 30, pollSeconds: 30,
            appDbPath: "C:\\Invented\\source.db", sessionRoot: "C:\\Invented\\history" } : null,
        state: paused ? "paused" : approved ? "watching" : "unconfigured",
        lastCheckedAt: "2026-10-08T12:00:00.000Z",
        discovery: { counts: { sessions: 2 } }, cadence: { pollSeconds: 30, browserPollSeconds: 5 },
        historyCoverage: { eligible: 2, readable: 2, unavailable: 0, limited: 0, pending: 0, affected: 0, excluded: {} },
    });
    let lastStatus, checkCount = 0;
    await page.route("**/api/**", async route => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        if (request.method() === "POST") requests.push({ endpoint, body: request.postDataJSON() });
        if (endpoint === "/api/collection/now") {
            checkCount++;
            const check = { schemaVersion: 2, id: `invented-check-${checkCount}`, beforeRevision: initial.revision,
                revision: initial.revision, configVersion: "invented-source-configuration",
                startedAt: "2026-10-08T12:00:00.000Z", completedAt: "2026-10-08T12:00:00.010Z",
                outcome: "complete", changes: { added: 0, updated: 0, items: [] }, sourcesChecked: 2, eligibleSources: 2 };
            return route.fulfill({ json: { ...lastStatus, check } });
        }
        const allowed = ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
            "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
            "/api/preview", "/api/cancel-preview"];
        if (!allowed.includes(endpoint)) { unexpected.push(endpoint); return route.abort(); }
        const response = await route.fetch();
        if (endpoint === "/api/snapshot") {
            const json = await response.json(); json.collection = lastStatus = status(json.collection);
            snapshots.push({ request: request.postDataJSON(), revision: json.revision });
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
    await chooseTheme(page, theme);
    if (scale !== 1) await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
    await frames(page);
    return { page, requests, snapshots, runtime, status };
}
async function proof(page, name, data) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.screenshot({ path: path.join(proofs, name + ".png") });
    await writeFile(path.join(proofs, name + ".json"), JSON.stringify(data, null, 2));
}
async function state(page) {
    return page.evaluate(() => ({
        hash: location.hash, search: document.querySelector("#activitySearch").value,
        theme: document.documentElement.dataset.evidenceTheme,
        values: Object.fromEntries(["dateFilter", "serviceFilter", "projectFilter", "layerFilter", "scopeFilter"].map(id => [id, document.getElementById(id).value])),
        selected: document.querySelector("#previewSelectionSummary").textContent,
        reportPhase: document.querySelector("#reportsView").dataset.reportPhase,
        reportStep: document.querySelector("#reportsView").dataset.reportStep,
        scrollY, focus: document.activeElement.id || document.activeElement.tagName,
    }));
}
async function revealRefresh(page) {
    const refresh = page.locator("#refreshBtn");
    if (!await refresh.isVisible()) {
        if (await page.locator("#freshHelp").isVisible()) await page.locator("#freshHelp > summary").click();
        else if (await page.locator("#bundles").isVisible()) await page.locator("#savedLibraryTitle").click();
    }
    return refresh;
}

test("Reports history stored refresh retains its keyboard initiator and reading position after a successful read", async t => {
    const { page, status } = await setup(t, { route: "#reports" });
    await chooseReportScope(page, "all"); await reportContents(page);
    const refresh = await revealRefresh(page);
    await refresh.evaluate(node => node.scrollIntoView({ block: "center" }));
    await refresh.focus(); await frames(page);
    const sample = () => refresh.evaluate(node => ({ scrollY, top: node.getBoundingClientRect().top, height: document.documentElement.scrollHeight,
        focused: node === document.activeElement, active: document.activeElement.id || document.activeElement.tagName, disabled: node.disabled }));
    const before = await sample(), entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), json = await response.json();
        entered.resolve(); await release.promise; await route.fulfill({ response, json: { ...json, collection: status(json.collection) } });
    }, { times: 1 });
    t.after(() => release.resolve());
    await page.keyboard.press("Enter"); await entered.promise;
    const pending = await sample();
    release.resolve(); await ready(page); await frames(page);
    const after = await sample();
    t.diagnostic(JSON.stringify({ before, pending, after }));
    await proof(page, "reports-refresh-keyboard-focus", { before, pending, after });
    assert.equal(after.scrollY, before.scrollY);
    assert.equal(after.top, before.top);
    assert.equal(after.focused, true, "Disabling the initiating control must not discard its keyboard focus after a successful read.");
});

for (const superseding of ["user scroll", "meaningful focus", "navigation", "newer read", "failed read"]) {
    test(`Reports refresh does not reclaim its initiator after ${superseding}`, async t => {
        const { page, status } = await setup(t, { route: "#reports" });
        const refresh = await revealRefresh(page);
        await refresh.focus();
        const entered = deferred(), release = deferred();
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), json = await response.json();
            entered.resolve(); await release.promise;
            if (superseding === "failed read") await route.fulfill({ status: 503, json: { error: "Invented refresh failure" } });
            else await route.fulfill({ response, json: { ...json, collection: status(json.collection) } });
        }, { times: 1 });
        t.after(() => release.resolve());
        const returned = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.keyboard.press("Enter"); await entered.promise;
        if (superseding === "user scroll") {
            await page.mouse.move(1100, 650); await page.mouse.wheel(0, -100); await frames(page);
        } else if (superseding === "meaningful focus") {
            await page.locator("#savedReportSearch").focus();
        } else if (superseding === "navigation") {
            await navigateMain(page, "home");
        } else if (superseding === "newer read") {
            await page.evaluate(() => window.dispatchEvent(new Event("online")));
            await ready(page);
        }
        const before = await state(page), top = (await refresh.boundingBox())?.y;
        release.resolve(); await returned; await ready(page); await frames(page);
        const after = await state(page);
        assert.notEqual(after.focus, "refreshBtn", "Only an unsuperseded successful read may restore its initiating control.");
        if (superseding === "meaningful focus") await expect(page.locator("#savedReportSearch")).toBeFocused();
        if (superseding === "navigation") assert.match(after.hash, /^#home/);
        if (superseding === "user scroll") {
            if (before.scrollY === 0) assert.equal(after.scrollY, 0, "At the page start, removing pending feedback cannot preserve a lower element with negative scrolling.");
            else assert.equal((await refresh.boundingBox()).y, top);
        }
        if (superseding === "failed read") await expect(page.locator("#message")).toContainText("Invented refresh failure");
        await proof(page, `refresh-focus-${superseding.replaceAll(" ", "-")}`, { before, after });
    });
}

test("manual stored refresh cannot silently cancel an unsaved report preview", async t => {
    const { page, requests, status } = await setup(t, { route: "#reports" });
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#exportBtn").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    const before = await state(page), start = requests.length;
    const refresh = await revealRefresh(page);
    await expect(refresh).toBeDisabled();
    await expect(page.locator("#storedRefreshHelp")).toContainText("Contents");
    await refresh.scrollIntoViewIfNeeded();
    await proof(page, "prepared-report-refresh-guard", { state: await state(page), requestsSincePreparation: requests.slice(start) });
    assert.equal((await state(page)).reportPhase, before.reportPhase);
    assert.ok(!requests.slice(start).some(row => row.endpoint === "/api/cancel-preview"));
    const gate = deferred();
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), json = await response.json();
        await route.fulfill({ response, json: { ...status(json), revision: 999 } }); gate.resolve();
    }, { times: 1 });
    await gate.promise; await frames(page);
    assert.equal((await state(page)).reportPhase, "ready");
    assert.ok(!requests.slice(start).some(row => row.endpoint === "/api/snapshot" || row.endpoint === "/api/cancel-preview"),
        "A background revision read defers while the actual prepared report remains open.");
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await expect(refresh).toBeDisabled();
    assert.ok(!requests.slice(start).some(row => row.endpoint === "/api/cancel-preview"));
    await page.locator('[name=promptMode][value=masked]').check();
    await expect(refresh).toBeEnabled();
    assert.equal(requests.slice(start).filter(row => row.endpoint === "/api/cancel-preview").length, 1);
    await refresh.click(); await ready(page);
    assert.equal((await state(page)).selected, before.selected);
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

test("a failed or cancelled scan with no prepared report leaves manual read recovery available", async t => {
    const { page } = await setup(t, { route: "#reports" });
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.route("**/api/preview", route => route.fulfill({ status: 503, json: { error: "Invented preview read failed" } }), { times: 1 });
    await page.locator("#exportBtn").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
    await expect(await revealRefresh(page)).toBeEnabled();
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    const entered = deferred(), release = deferred();
    await page.route("**/api/preview", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await page.locator("#exportBtn").click(); await entered.promise;
    await expect(page.locator("#refreshBtn")).toBeDisabled();
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
    await expect(page.locator("#refreshBtn")).toBeEnabled();
    const cancelled = page.waitForResponse(response => response.url().endsWith("/api/cancel-preview"));
    release.resolve(); await cancelled;
    await expect(page.locator("#refreshBtn")).toBeEnabled();
});
