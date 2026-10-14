import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, navigateMain, selectActivityOption, openSourceEditor } from "./helpers.mjs";
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

test("reset mapping covers secondary scope, private search and chart settings without clearing report selection", async t => {
    const { page, requests } = await setup(t, { route: "#activity?session=scope-chat-0&project=project-a&service=Calendar&scope=all&range=custom&from=2026-09-01&to=2026-10-01&chart=endpoint&bucket=day" });
    if (await page.locator(".session-toggle").getAttribute("aria-expanded") === "false") await page.locator(".session-toggle").click();
    await page.locator("#activityList input[type=checkbox]").first().check();
    await page.locator("#activitySearch").fill("milestone");
    await ready(page); await frames(page);
    const before = await state(page), count = requests.length;
    await page.locator("#resetView").click(); await ready(page); await frames(page);
    const after = await state(page);
    t.diagnostic(JSON.stringify({ before, after, requests: requests.slice(count) }));
    assert.equal(after.hash, "#home"); assert.equal(after.search, "");
    assert.deepEqual(after.values, { dateFilter: "capture", serviceFilter: "all", projectFilter: "all", layerFilter: "tool", scopeFilter: "history" });
    assert.equal(after.selected, before.selected); assert.equal(after.theme, before.theme);
    assert.ok(!requests.slice(count).some(row => row.endpoint === "/api/collection/now"));
    await page.goBack(); await ready(page);
    assert.equal((await state(page)).search, before.search);
});

test("source check and stored refresh are different requests even while automatic collection is paused", async t => {
    const { page, requests } = await setup(t, { paused: true, route: "#home?project=project-a" });
    const before = await state(page), start = requests.length;
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete"); await ready(page);
    const checkRequests = requests.slice(start), next = requests.length;
    await (await revealRefresh(page)).click(); await ready(page);
    const readRequests = requests.slice(next);
    assert.equal(checkRequests.filter(row => row.endpoint === "/api/collection/now").length, 1);
    assert.ok(checkRequests.some(row => row.endpoint === "/api/snapshot"));
    assert.ok(readRequests.some(row => row.endpoint === "/api/snapshot"));
    assert.ok(!readRequests.some(row => row.endpoint === "/api/collection/now"));
    assert.equal((await state(page)).hash, before.hash);
    await expect(page.locator("#collectionStatus")).toHaveText("Collection paused");
    t.diagnostic(JSON.stringify({ checkRequests, readRequests }));
});

test("reset and refresh have distinct local homes instead of ambiguous global controls", async t => {
    const { page } = await setup(t, { route: "#home?project=project-a" });
    const before = await page.evaluate(() => Object.fromEntries(["resetView", "refreshBtn", "filters", "freshHelp"].map(id => {
        const node = document.getElementById(id), box = node.getBoundingClientRect();
        return [id, { text: node.textContent, parent: node.parentElement.id, x: box.x, y: box.y, width: box.width }];
    })));
    await proof(page, "action-locations", before);
    await expect(page.locator("#filters #resetView")).toHaveText("Reset to Home");
    await expect(page.locator(".app-header #refreshBtn")).toHaveCount(0);
    await expect(page.locator("#freshHelp #refreshBtn")).toHaveText("Refresh stored data");
    await expect(page.locator("#checkActivity")).toHaveText("Check for new activity");
});

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

for (const theme of ["light", "dark"]) for (const { width, scale } of [{ width: 1200, scale: 1 }, { width: 375, scale: 1 }, { width: 375, scale: 2 }]) {
    test(`scope/source controls are readable and contextual at ${width}px ${scale * 100}% ${theme}`, async t => {
        const { page } = await setup(t, { theme, width, scale, route: "#home?bucket=day" });
        await expect(page.locator("#resetView")).toBeVisible();
        await expect(page.locator("#resetView")).toHaveAttribute("aria-describedby", "resetScopeHelp");
        await page.locator("#filterTools").scrollIntoViewIfNeeded();
        const reset = page.locator("#resetView"), initial = await reset.boundingBox();
        await proof(page, `scope-${width}-${scale}-${theme}`, { state: await state(page), reset: initial });
        for (const selector of ["#resetView", "#projectFilter-control"]) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const box = await page.locator(selector).boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width + 1, selector + " fits the viewport.");
        }
        await page.locator("#freshHelp > summary").scrollIntoViewIfNeeded();
        const trigger = await page.locator("#freshHelp > summary").boundingBox();
        await page.locator("#freshHelp > summary").click(); await frames(page);
        const after = await page.locator("#freshHelp > summary").boundingBox();
        assert.equal(after.x, trigger.x); assert.equal(after.y, trigger.y);
        await expect(page.locator("#refreshBtn")).toBeVisible();
        await page.locator("#refreshBtn").focus();
        await page.keyboard.press("Escape");
        await proof(page, `source-${width}-${scale}-${theme}`, { trigger, after, state: await state(page) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    });
}

test("default Home hides Reset, while chart-only and unapplied date scope expose its real destination", async t => {
    const { page, requests } = await setup(t);
    await expect(page.locator("#resetView")).toBeHidden();
    await page.locator('[data-chart=endpoint]').click(); await ready(page);
    await expect(page.locator("#resetView")).toBeVisible();
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-11");
    await page.locator("#toFilter").fill("2026-09-13");
    const count = requests.filter(row => row.endpoint === "/api/snapshot").length;
    await (await revealRefresh(page)).click(); await ready(page);
    assert.equal(await page.locator("#fromFilter").inputValue(), "2026-09-11");
    assert.equal(await page.locator("#toFilter").inputValue(), "2026-09-13");
    assert.equal(requests.filter(row => row.endpoint === "/api/snapshot").length, count + 1);
    const last = requests.filter(row => row.endpoint === "/api/snapshot").at(-1).body;
    assert.equal(last.filters.from, undefined, "Unapplied date drafts do not silently become read filters.");
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#resetView")).toBeHidden();
    assert.equal(await page.locator("#fromFilter").inputValue(), "");
});

test("stored-refresh pending/error/retry preserves scoped reading and newer user focus without a source check", async t => {
    const { page, requests } = await setup(t, { route: "#activity?project=project-a" });
    const refresh = await revealRefresh(page), before = await state(page);
    const entered = deferred(), release = deferred();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release.resolve());
    await refresh.click(); await entered.promise;
    await expect(refresh).toBeDisabled();
    const search = page.locator("#activitySearch");
    await search.click(); await page.mouse.wheel(0, 80); await frames(page);
    const wanted = await search.boundingBox();
    release.resolve(); await ready(page); await frames(page);
    await expect(search).toBeFocused();
    assert.ok(Math.abs((await search.boundingBox()).y - wanted.y) <= 1);
    assert.equal((await state(page)).hash, before.hash);
    await proof(page, "stored-refresh-user-position", { before, userAnchor: wanted,
        afterAnchor: await search.boundingBox(), after: await state(page) });
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented stored-read failure" } }), { times: 1 });
    await refresh.click(); await ready(page);
    await expect(page.locator("#message")).toContainText("Invented stored-read failure");
    await page.getByRole("button", { name: "Try again", exact: true }).click(); await ready(page);
    await expect(page.locator("#message")).toBeHidden();
    assert.equal((await state(page)).hash, before.hash);
    assert.ok(!requests.some(row => row.endpoint === "/api/collection/now"));
});

test("failed source check followed by stored refresh remains explicitly unconfirmed", async t => {
    const { page } = await setup(t);
    await page.route("**/api/collection/now", route => route.fulfill({ status: 503, json: { error: "Invented source unavailable" } }), { times: 1 });
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "error");
    await (await revealRefresh(page)).click(); await ready(page);
    await expect(page.locator("#freshStatus")).toHaveText("Stored data refreshed; check still unconfirmed.");
    await expect(page.locator("#freshContextMessage")).toContainText("Only stored evidence was read");
});

test("unconnected source offers setup rather than implying stored refresh reads a source", async t => {
    const { page, requests } = await setup(t, { approved: false });
    await expect(page.locator("#checkActivity")).toHaveText("Review source & connect");
    await (await revealRefresh(page)).click(); await ready(page);
    await expect(page.locator("#checkActivity")).toHaveText("Review source & connect");
    assert.ok(!requests.some(row => row.endpoint === "/api/collection/now"));
});

test("primary filters and hidden selections survive stored refresh, then reset fully with report options intact", async t => {
    const { page, requests } = await setup(t, { route: "#activity" });
    await page.locator(".session-toggle").first().click();
    await page.locator("#activityList input[type=checkbox]").first().check();
    await navigateMain(page, "reports"); await ready(page); await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await navigateMain(page, "activity"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await selectActivityOption(page, "promptAuthorFilter", "agent"); await ready(page);
    const before = await state(page);
    await (await revealRefresh(page)).click(); await ready(page);
    assert.equal((await state(page)).selected, before.selected);
    const read = requests.filter(row => row.endpoint === "/api/snapshot").at(-1).body;
    assert.deepEqual(read.filters.outcomes, ["failure"]);
    assert.deepEqual(read.filters.promptAuthors, ["agent"]);
    await page.locator("#resetView").click(); await ready(page);
    assert.equal((await state(page)).selected, before.selected);
    const reset = requests.filter(row => row.endpoint === "/api/snapshot").at(-1).body;
    assert.equal(reset.filters.outcomes, undefined);
    assert.equal(reset.filters.promptAuthors, undefined);
    await navigateMain(page, "reports"); await ready(page); await reportContents(page);
    await expect(page.locator('[name=promptMode][value=none]')).toBeChecked();
    await proof(page, "report-contextual-actions", { state: await state(page) });
});

test("Settings drafts disable manual reads and source checks until existing cancellation", async t => {
    const { page, requests } = await setup(t);
    await navigateMain(page, "settings"); await ready(page);
    await openSourceEditor(page);
    await page.locator("#sourceDatabase").fill("C:\\Invented\\different.db");
    const before = requests.length;
    await expect(page.locator("#refreshBtn")).toBeDisabled();
    await navigateMain(page, "home"); await ready(page);
    await expect(page.locator("#checkActivity")).toBeDisabled();
    await (await revealRefresh(page)).focus();
    await expect(page.locator("#refreshBtn")).toBeDisabled();
    assert.ok(!requests.slice(before).some(row => /configure|enabled|collection\/now/.test(row.endpoint)));
    await navigateMain(page, "settings"); await ready(page);
    await page.locator("#cancelSource").click();
    await expect(page.locator("#refreshBtn")).toBeEnabled();
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
