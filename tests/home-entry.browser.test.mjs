import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { privateFixture, navigateMain, selectActivityOption, chooseTheme } from "./helpers.mjs";

const proofs = process.env.WORKIQ_ENTRY_PROOFS;
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
    return { page, runtime, current, set: next => { override = next; }, failStatus: value => { statusError = value; }, posts };
}

test("initial shell keeps routine health in hidden Settings and technical copy in one closed disclosure", () => {
    const shell = renderHtmlShell("synthetic", "entry-proof");
    assert.ok(shell.indexOf('id="pageTitle"') < shell.indexOf('id="pageIntro"'));
    assert.ok(shell.indexOf('id="settingsView"') < shell.indexOf('id="collectionStrip"'));
    assert.ok(shell.indexOf('id="filters"') < shell.indexOf('id="evidenceExplanation"'));
    const intro = /id="pageIntro">([^<]+)/.exec(shell)[1];
    assert.equal(intro.split(/\s+/).length, 7);
    assert.doesNotMatch(shell, /id="homePurpose"|class="collector-panel|id="collectionIssueLink"/);
    assert.match(shell, /id="coverage"[^>]*><summary>About this evidence/);
});

test("task-first entry fits both themes and 100/200% text before opening retained help", { timeout: 120000 }, async t => {
    const { page, runtime } = await setup(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1466]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ theme, scale }) => {
            localStorage.setItem("workiq-evidence.theme", theme);
            document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
        }, { theme, scale });
        await page.goto(runtime.url); await ready(page);
        assert.equal(await page.locator("#collectionStrip").isVisible(), false);
        assert.equal(await page.locator("#collectionNotice").isVisible(), false);
        assert.equal(await page.locator("#coverage").evaluate(node => node.open), false);
        assert.equal(await page.locator("#evidenceExplanation").isVisible(), false);
        assert.doesNotMatch(await page.locator("#main").ariaSnapshot(), /Copilot project context, not necessarily a GitHub repository/);
        const metrics = await page.evaluate(() => {
            const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
            const title = document.querySelector("#pageTitle"), intro = document.querySelector("#pageIntro"), filters = document.querySelector("#filters"), action = document.querySelector("#pageAction");
            return { title: rect("#pageTitle"), intro: rect("#pageIntro"), filters: rect("#filters"), action: rect("#pageAction"), freshAction: rect("#checkActivity"),
                introWords: intro.innerText.trim().split(/\s+/).length, scrollY,
                domOrder: [title, intro, filters, action, document.querySelector("#homeView")].every((node, i, all) => !i || Boolean(all[i - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
                overflow: document.documentElement.scrollWidth - innerWidth,
                mainStartsWithTask: document.querySelector("main").innerText.startsWith("Work IQ in your Copilot chats"),
                beforeTaskHealth: [...document.querySelectorAll("#collectionStrip,#collectionNotice")].some(node => node.checkVisibility() && node.getBoundingClientRect().top < title.getBoundingClientRect().top),
            };
        });
        assert.equal(metrics.introWords, 7);
        assert.equal(metrics.domOrder, true);
        assert.equal(metrics.mainStartsWithTask, true);
        assert.equal(metrics.beforeTaskHealth, false);
        assert.equal(metrics.scrollY, 0);
        assert.ok(metrics.overflow <= 1);
        if (scale === 1) assert.ok(metrics.freshAction.bottom < 800, `Fresh-data primary action in ordinary laptop-height viewport: ${width}`);
        assert.ok(metrics.title.bottom <= metrics.intro.top && metrics.intro.bottom <= metrics.filters.top);
        if (proofs) await page.screenshot({ path: path.join(proofs, `entry-${theme}-${width}-${scale * 100}.png`) });
        await page.locator("#main").focus();
        const tabOrder = [];
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press("Tab");
            tabOrder.push(await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent, settings: document.activeElement.matches("[data-settings-link]") })));
            if (tabOrder.at(-1).id === "pageAction") break;
        }
        assert.ok(tabOrder.some(node => node.id === "dateFilter-control"));
        assert.equal(tabOrder[0].id, "checkActivity", "Fresh data is the first Home action");
        assert.equal(tabOrder.at(-1).id, "pageAction");
        assert.equal(tabOrder.filter(node => node.settings).length, 0, "Source settings stay in the contextual disclosure, not the default reading path");
        await page.locator("#freshHelp > summary").click();
        assert.equal(await page.locator(".fresh-links a:visible").count(), 2, "Source settings remain explicitly available");
        for (const id of ["meaning", "serviceDefinitions", "coverage"]) {
            await page.locator(`#${id}>summary`).focus(); await page.keyboard.press("Enter");
        }
        const copy = await page.locator("#evidenceExplanation").innerText();
        assert.match(copy, /Work IQ activity shows tool calls and recorded results/);
        assert.match(copy, /does not confirm that the whole task was completed correctly/);
        assert.match(await page.locator("#collectionEvidenceDetails").textContent(), /API metadata returned by a tool.*separate.*direct Graph request sites/);
        const clipping = await page.locator("#pageIntro,#evidenceExplanation,.result-definitions dd,#serviceDefinitions dd,.header-inner button,.primary-navigation a").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).flatMap(node => {
            const r = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].filter(box => box.width && (box.left < r.left - 1 || box.right > r.right + 1 || box.bottom > r.bottom + 1)).map(() => node.className || node.id);
        }));
        assert.deepEqual(clipping, [], `Full text wraps at ${theme}/${width}/${scale}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        measurements.push({ theme, width, scale, ...metrics, tabOrder });
    }
    if (proofs) await writeFile(path.join(proofs, "entry-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("unapproved Home has one setup action without hiding retained evidence or other views' guidance", { timeout: 60000 }, async t => {
    for (const empty of [false, true]) {
        const { page, runtime, set, failStatus } = await setup(t, empty);
        set({ state: "disconnected", config: null });
        await page.goto(runtime.url); await ready(page);
        assert.equal(await page.locator("#checkActivity").innerText(), "Review source & connect");
        assert.equal(await page.locator("#checkActivity").isVisible(), true);
        assert.equal(await page.locator("#collectionNoticeAction").isVisible(), false, "Home already supplies the source-review action");
        assert.equal(await page.locator("#collectionNotice").isVisible(), !empty);
        if (!empty) assert.equal(await page.locator("#collectionNoticeText").innerText(), "Retained evidence is still available.");
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            for (const theme of ["light", "dark"]) {
                await chooseTheme(page, theme);
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                await page.screenshot({ path: path.join(proofs, `home-setup-${theme}-${empty ? "empty" : "retained"}.png`) });
            }
        }
        for (const view of ["activity", "reports"]) {
            await navigateMain(page, view); await ready(page);
            assert.equal(await page.locator("#freshActivity").isVisible(), false);
            assert.equal(await page.locator("#collectionNoticeAction").isVisible(), true, `${view} still needs its connection action`);
            assert.equal(await page.locator("#collectionNoticeAction").innerText(), "Review source in Settings");
        }
        await navigateMain(page, "home"); await ready(page);
        assert.equal(await page.locator("#collectionNoticeAction").isVisible(), false);
        failStatus(true);
        const polled = page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await polled;
        await page.waitForFunction(() => document.querySelector("#collectionNotice").dataset.severity === "error");
        assert.equal(await page.locator("#collectionNoticeAction").isVisible(), true, "A status-read failure is not suppressed as duplicate setup");
        assert.match(await page.locator("#collectionNoticeText").innerText(), /status unavailable.*Retry the connection/);
    }
});

test("setup, paused, loading, blocked source and retained data states have truthful contextual actions", { timeout: 90000 }, async t => {
    const matrix = [];
    for (const empty of [false, true]) {
        const { page, runtime, current, set } = await setup(t, empty);
        const states = [
            ["healthy", {}, null],
            ["healthy-no-gaps", { historyCoverage: { ...current.historyCoverage, unavailable: 0, limited: 0, affected: 0 } }, null],
            ["paused", { state: "paused", config: { ...current.config, enabled: false } }, /Collection is paused/],
            ["unapproved", { state: "disconnected", config: null }, empty ? null : /Retained evidence is still available/],
            ["initial-import", { discovery: null, lastCheckedAt: null }, empty ? /Reading approved Copilot chat history/ : null],
            ["routine-check", { state: "collecting" }, null],
            ["blocked-source", { state: "error", error: "Synthetic source failure; exact diagnostic remains in Settings." }, /cannot check history/],
            ["all-history-unavailable", { historyCoverage: { ...current.historyCoverage, unavailable: 10, readable: 0 } }, /History unavailable/],
            ["stopped", { state: "stopped" }, /Collection stopped/],
        ];
        for (const [name, status, expected] of states) {
            set(status);
            await page.goto(runtime.url); await ready(page);
            const notice = page.locator("#collectionNotice");
            assert.equal(await notice.isVisible(), Boolean(expected), `${name} empty=${empty}`);
            if (expected) {
                const text = await notice.innerText();
                assert.match(text, expected);
                if (!empty && ["paused", "blocked-source", "all-history-unavailable", "stopped"].includes(name)) assert.match(text, /Retained evidence is still available/);
                assert.ok(await notice.evaluate(node => document.querySelector("#pageTitle").getBoundingClientRect().bottom < node.getBoundingClientRect().top));
                if (name === "unapproved") {
                    assert.equal(await page.locator("#collectionNoticeAction").isVisible(), false);
                } else {
                    await page.locator("#collectionNoticeAction").focus(); await page.keyboard.press("Enter");
                    const operational = ["blocked-source", "all-history-unavailable", "stopped", "initial-import"].includes(name);
                    assert.match(page.url(), operational ? /#collection-status/ : /#settings/);
                    assert.equal(await page.locator("[data-settings-section]:visible").count(), operational ? 0 : 1);
                    if (name === "all-history-unavailable") assert.match(page.url(), /#collection-status.*setting=issues/);
                    if (name === "blocked-source") assert.match(await page.locator("#settingsDiagnosticError").innerText(), /Synthetic source failure/);
                    await page.goBack(); await ready(page);
                    assert.equal(await notice.isVisible(), true);
                }
            }
            matrix.push({ name, empty, notice: expected ? await notice.innerText() : null });
        }
    }
    if (proofs) await writeFile(path.join(proofs, "entry-state-matrix.json"), JSON.stringify(matrix, null, 2));
});

test("polling preserves filters, report membership, focus, scroll and help; status loss is recoverable without writes", { timeout: 60000 }, async t => {
    const { page, runtime, current, set, failStatus } = await setup(t);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => { await held; await route.fallback(); });
    await page.goto(runtime.url);
    assert.equal(await page.locator("#loading").isVisible(), true);
    assert.equal(await page.locator("#collectionStrip").isVisible(), false, "No old card flashes during first read");
    release(); await ready(page);
    await page.unroute("**/api/snapshot", undefined);
    // Reinstall the snapshot overlay after removing the held-first-read handler.
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: current } });
    });
    await navigateMain(page, "activity"); await ready(page);
    await page.locator(".session-toggle").first().click();
    await page.locator('[id^="select-request-"]').first().check();
    await navigateMain(page, "home"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await page.locator("#moreFilters>summary").click();
    await page.locator("#coverage>summary").focus(); await page.keyboard.press("Enter");
    const prior = await page.evaluate(() => {
        window.entryFocus = document.activeElement;
        window.entryAnnouncements = [];
        new MutationObserver(() => window.entryAnnouncements.push(document.querySelector("#collectionNoticeText").textContent))
            .observe(document.querySelector("#collectionNoticeText"), { subtree: true, childList: true, characterData: true });
        return { scroll: scrollY, top: document.querySelector("#pageTitle").getBoundingClientRect().top + scrollY, membership: document.querySelector("#activitySelectionSummary").textContent };
    });
    set({ state: "collecting", lastCheckedAt: new Date(Date.now() + 60000).toISOString() });
    await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
    await page.waitForFunction(() => document.querySelector("#collectionStatus").textContent === "Checking history");
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement === window.entryFocus && window.entryFocus.isConnected), true);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - prior.scroll) < 2);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), prior.membership);
    assert.match(prior.membership, /1 request/);
    assert.equal(await page.locator("#coverage").evaluate(node => node.open), true);
    assert.equal(await page.locator("#moreFilters").evaluate(node => node.open), false);
    assert.deepEqual(await page.evaluate(() => window.entryAnnouncements), []);
    assert.equal(await page.locator("#collectionChecked").evaluate(node => Boolean(node.closest('[aria-live], [role="status"]'))), false);
    await page.locator("#coverage [data-settings-link]").click();
    assert.match(page.url(), /#collection-status/);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#coverage").evaluate(node => node.open), true);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Calendar");
    failStatus(true);
    await page.waitForFunction(() => document.querySelector("#collectionNotice").checkVisibility());
    assert.match(await page.locator("#collectionNoticeText").innerText(), /status unavailable.*Retry the connection.*last accepted view/);
    assert.equal(await page.locator("#homeView").isVisible(), true);
    failStatus(false); set({});
    await page.waitForFunction(() => !document.querySelector("#collectionNotice").checkVisibility());
    assert.equal(await page.locator("#coverage").evaluate(node => node.open), true);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), prior.membership);
});
