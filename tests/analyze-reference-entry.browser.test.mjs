import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { selectActivityOption, closeAnalyzeFilters, restoreLegacySearch, chooseTheme } from "./helpers.mjs";

async function captureState(page, name) {
    const proof = process.env.WIRE_CHART_GUIDE_PROOFS;
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proof, name + ".png") });
}

async function setup(t, { textSearch = false } = {}) {
    const cleanups = [];
    const app = textSearch ? await searchFixture({ after: action => cleanups.push(action) })
        : await authorFilterFixture(t);
    const before = textSearch ? await loadBoardState(app.context) : null;
    const browser = await chromium.launch();
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await browserContext.newPage();
    const errors = [], denied = [], requests = [];
    let snapshots = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.context().on("page", other => other.on("pageerror", error => errors.push(error.message)));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list", "/api/period-comparison",
            ...(textSearch ? ["/api/search/events", "/api/search/status", "/api/search/query", "/api/search/cancel", "/api/search/close"] : [])];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot") snapshots++;
        requests.push({ page: request.isNavigationRequest() ? null : request.frame().page(), path: url.pathname });
        return route.continue();
    });
    const close = async () => {
        await browser.close();
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        if (before) {
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        }
    };
    if (textSearch) t.after(async () => { try { await close(); } finally { for (const cleanup of cleanups) await cleanup(); } });
    else app.closeClient(close);
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { app, page, requests, snapshots: () => snapshots };
}

test("the single reference entry opens the native guide without a read and preserves applicability", { timeout: 30000 }, async t => {
    const { page, snapshots } = await setup(t);
    await expect(page.locator("#openChartReference")).toHaveCount(1);
    await expect(page.locator("#openChartReference")).toHaveText("Chart guide");
    await expect(page.locator("#openChartReference")).toHaveAccessibleName("Chart guide: How to read these charts");
    assert.equal(await page.locator("#analyzeReference").evaluate(node => node.tagName), "SECTION");
    const reads = snapshots();
    await page.locator("#openChartReference").focus();
    await page.locator("#openChartReference").press("Enter");
    await expect(page.locator("#meaning")).toHaveAttribute("open", "");
    assert.equal(await page.locator("#meaning").evaluate(node => node.tagName), "DIALOG");
    await expect(page.locator("#chartReferenceTitle")).toBeFocused();
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData table")).toBeVisible();
    assert.equal(snapshots(), reads);
    await page.locator("#closeChartReference").click();
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#openChartReference")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#openChartReference").click();
        await expect(page.locator("#chartReferenceNotice")).toContainText("Comparison records are not available");
        await expect(page.locator("#chartReferenceShowData")).toBeDisabled();
        await captureState(page, `${theme}-comparison-unavailable`);
        await page.locator("#closeChartReference").click();
    }
    await page.locator('.primary-navigation [data-nav="analyze"]').click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#openChartReference")).toBeVisible();
    await page.locator('nav [data-nav="reports"]').click();
    await expect(page.locator("#reportsView")).toBeVisible();
    await expect(page.locator("#openChartReference")).not.toBeVisible();
});

test("native exact outcome links preserve the accepted cohort and return to the same guide", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    const worked = page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ });
    const href = await worked.getAttribute("href");
    assert.match(href, /result=success/);
    await worked.click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#meaning")).not.toBeVisible();
    assert.match(page.url(), /result=success/);
    await expect(page.locator("#activityListSummary")).toContainText("6 matching Work IQ tool calls");
    await page.goBack();
    await expect(page.locator("#meaning")).toHaveAttribute("open", "");
    await expect(page.locator("#meaning")).toHaveAttribute("data-reference-view", "data");
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("8");
    await expect(page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ })).toBeFocused();
});

test("native guide links retain modified-click behavior without replacing the current view", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    const popupReady = page.context().waitForEvent("page");
    await page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    const popup = await popupReady;
    await expect(popup.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(popup.locator("#activityListSummary")).toContainText("6 matching Work IQ tool calls");
    await expect(page.locator("#meaning")).toBeVisible();
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("8");
    await popup.close();
});

for (const theme of ["light", "dark"]) for (const fail of [false, true]) test(`native guide keeps accepted values and labels during a ${fail ? "failed" : "pending"} scope change (${theme})`, { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await chooseTheme(page, theme);
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { arrived = resolve; });
    await page.route("**/api/snapshot", async route => {
        arrived(); await gate;
        if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented unavailable scope" }) });
        return route.continue();
    });
    try {
        await selectActivityOption(page, "serviceAssociationFilter", "Files");
        await started;
        await closeAnalyzeFilters(page);
        await page.locator("#openChartReference").click();
        await expect(page.locator(".chart-reference-group-heading")).toContainText("8 Work IQ tool calls");
        await expect(page.locator("#chartReferenceExplanation")).not.toContainText("Files");
        await expect(page.locator("#chartReferenceShowData")).toBeDisabled();
        await expect(page.locator("#chartReferenceNotice")).toBeVisible();
        if (!fail) await captureState(page, `${theme}-pending-scope`);
    } finally { release(); }
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".chart-reference-group-heading")).toContainText(fail ? "8 Work IQ tool calls" : "1 Work IQ tool call");
    if (fail) {
        await expect(page.locator("#chartReferenceExplanation")).not.toContainText("Files");
        await expect(page.locator("#chartReferenceShowData")).toBeDisabled();
        await expect(page.locator("#chartReferenceNotice")).toBeVisible();
        await captureState(page, `${theme}-failed-scope`);
    } else {
        await expect(page.locator("#chartReferenceExplanation")).toContainText("Files");
        await expect(page.locator("#chartReferenceShowData")).toBeEnabled();
    }
});

test("native guide keeps a private narrowed cohort without repeating its search words", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const phrase = "Invented delegated calendar request.";
    await restoreLegacySearch(page, phrase);
    await page.locator("#openChartReference").click();
    await expect(page.locator(".chart-reference-group-heading")).toContainText("1 Work IQ tool call");
    await expect(page.locator("#meaning")).toContainText("Search applied");
    await expect(page.locator("#meaning")).not.toContainText(phrase);
    await page.locator("#chartReferenceShowData").click();
    const target = page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ });
    assert.ok(!(await target.getAttribute("href")).includes("Invented"));
    await target.click();
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await expect(page.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
    await page.goBack();
    await expect(page.locator("#meaning")).toBeVisible();
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("1");
});

for (const entry of ["native plot", "chart guide"]) test(`private modified-click keeps the exact cohort from the ${entry}`, { timeout: 30000 }, async t => {
    const { page, app } = await setup(t);
    const phrase = "Invented delegated calendar request.";
    await restoreLegacySearch(page, phrase);
    await expect(page.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
    if (entry === "chart guide") {
        await page.locator("#openChartReference").click();
        await page.locator("#chartReferenceShowData").click();
        await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("1");
    }
    const target = page.locator(entry === "chart guide" ? "#chartReferenceData" : "#outcomeChart")
        .getByRole("link", { name: /^Worked:/ });
    assert.ok(!(await target.getAttribute("href")).includes("Invented"));
    assert.match(await target.getAttribute("href"), /privateView=required/);
    const opened = page.context().waitForEvent("page");
    await target.click({ modifiers: ["Control"] });
    const other = await opened;
    await expect(other.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    assert.ok(!other.url().includes("Invented"));
    assert.ok(!other.url().includes("privateView"), "The one-use marker is removed before the view becomes available");
    assert.equal(await other.evaluate(() => window.opener), null);
    await expect(other.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
    assert.deepEqual(await other.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request"))), [app.cases.agentCalendar.scenarioId]);
    await other.close();
});

test("a copied private chart URL without its handoff cannot silently broaden the selection", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await restoreLegacySearch(page, "Invented delegated calendar request.");
    const href = await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).getAttribute("href");
    const copied = await page.context().newPage();
    await copied.goto(new URL(href, page.url()).href);
    await expect(copied.locator("#message")).toContainText("The private selection could not be restored");
    await expect(copied.locator("#activityListSummary")).toBeHidden();
    await copied.close();
});

for (const gesture of [{ name: "middle click", button: "middle" }, { name: "Shift-click", modifiers: ["Shift"] },
    { name: "Meta-click", modifiers: ["Meta"] }]) {
    test(`private navigation preserves ${gesture.name}`, { timeout: 30000 }, async t => {
        const { page } = await setup(t);
        await restoreLegacySearch(page, "Invented delegated calendar request.");
        const opened = page.context().waitForEvent("page");
        const { name, ...click } = gesture;
        await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click(click);
        const other = await opened;
        await expect(other.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(other.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
        await other.close();
    });
}

test("a new tab rebinds private Search with its existing owner and never displays a broader pending cohort", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, { textSearch: true });
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction with 1 matching Work IQ tool call");
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { requested = resolve; });
    const hold = async route => {
        if (route.request().frame().page() === page) return route.fallback();
        requested(); await gate; return route.fallback();
    };
    await page.context().route("**/api/search/query", hold);
    t.after(() => release());
    const opened = page.context().waitForEvent("page");
    await page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    const other = await opened;
    await other.bringToFront();
    try {
        await arrived;
        await expect(other.locator("#homeView")).toBeHidden();
        await expect(other.locator("#activityListSummary")).toBeHidden();
        await expect(other.locator("#openChartReference")).toBeHidden();
        const pendingUrl = other.url();
        await expect(other.locator("#resultsLink")).toHaveCount(0);
        await expect(other.locator("#activityListSummary")).toBeHidden();
        assert.equal(other.url(), pendingUrl, "Persistent navigation must not broaden an unresolved private selection");
        assert.ok(!(await other.evaluate(() => JSON.stringify({
            url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage },
        }))).includes("physician"), "Search words stay out of copied URLs, storage and transferred history");
    } finally { release(); }
    await expect(other.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(other.locator("#activityListSummary")).toHaveText("1 interaction with 1 matching Work IQ tool call");
    assert.ok(!(await other.evaluate(() => JSON.stringify(history.state))).includes("physician"));
    assert.deepEqual(await other.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request"))), ["search-0"]);
    assert.ok(requests.some(request => request.page === other && request.path === "/api/search/query"),
        "The recipient obtains its own local receipt instead of accepting copied membership");
    await other.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(other.locator("#activityListSummary")).toHaveText("3 interactions with 3 matching Work IQ tool calls");
    assert.equal(await other.evaluate(() => Object.hasOwn(history.state, "wirePrivateNavigation")), false);
    await other.close();
});

test("private handoff preparation cannot overwrite newer Search input in the recipient", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { textSearch: true });
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await page.locator("#wireSearch").press("Escape");
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { requested = resolve; });
    await page.context().route("**/api/snapshot", async route => {
        if (route.request().frame().page() === page) return route.fallback();
        requested(); await gate; return route.fallback();
    });
    t.after(() => release());
    const opened = page.context().waitForEvent("page");
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    const other = await opened;
    await other.bringToFront();
    try { await arrived; await other.locator("#wireSearch").fill("mechanic"); }
    finally { release(); }
    await expect(other.locator("#message")).toContainText("Search changed while the private view was opening");
    await expect(other.locator("#wireSearch")).toHaveValue("mechanic");
    await expect(other.locator("#activityListSummary")).toBeHidden();
    await other.close();
});

for (const returning of [false, true]) test(`a private Search guide ${returning ? "restores on Back" : "reveals records"} after fresh membership arrives`, { timeout: 30000 }, async t => {
    const { page } = await setup(t, { textSearch: true });
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ }).click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityListSummary")).toBeVisible();
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction with 1 matching Work IQ tool call");
    if (returning) {
        await page.goBack();
        await expect(page.locator("#meaning")).toBeVisible();
        await expect(page.locator("#meaning")).toHaveAttribute("data-reference-view", "data");
        await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("1");
        await expect(page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ })).toBeFocused();
    } else await expect(page.locator("#activityListSummary")).toBeFocused();
});

test("newer reading input cancels a guide Back restoration awaiting private Search membership", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { textSearch: true });
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ }).click();
    await expect(page.locator("#activityListSummary")).toBeFocused();
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { requested = resolve; });
    await page.route("**/api/search/query", async route => { requested(); await gate; return route.fallback(); });
    t.after(() => release());
    await page.goBack();
    try {
        await arrived;
        await page.locator("#wireSearch").click();
    } finally { release(); }
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(page.locator("#meaning")).not.toBeVisible();
    await expect(page.locator("#wireSearch")).toBeFocused();
});

test("changed or unavailable private handoffs fail visibly instead of displaying the ordinary cohort", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await restoreLegacySearch(page, "Invented delegated calendar request.");
    await page.context().route("**/api/snapshot", async route => {
        if (route.request().frame().page() === page) return route.fallback();
        const response = await route.fetch(), value = await response.json();
        value.revision++;
        value.analytics.revision = value.revision;
        return route.fulfill({ response, json: value });
    });
    const opened = page.context().waitForEvent("page");
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    const other = await opened;
    await expect(other.locator("#message")).toContainText("The selected records changed");
    await expect(other.locator("#activityListSummary")).toBeHidden();
    await page.context().unroute("**/api/snapshot");
    const historyLength = await other.evaluate(() => history.length);
    await other.getByRole("button", { name: "Open this view without the private selection", exact: true }).click();
    await expect(other.locator("#activityListSummary")).toContainText("6 matching Work IQ tool calls");
    assert.match(other.url(), /result=success/);
    assert.equal(await other.evaluate(() => history.length), historyLength);
    await other.close();
    const unavailable = await page.context().newPage();
    await unavailable.goto(page.url().split("#")[0] + "#analyze?privateView=expired");
    await expect(unavailable.locator("#message")).toContainText("The private selection could not be restored");
    await expect(unavailable.locator("#activityListSummary")).toBeHidden();
    await expect(unavailable.locator("#storedViewRetry")).toHaveCount(0);
    await unavailable.setViewportSize({ width: 390, height: 844 });
    await unavailable.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const recovery = unavailable.getByRole("button", { name: "Open this view without the private selection", exact: true });
    await recovery.focus();
    assert.equal(await recovery.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return rect.width <= innerWidth && rect.height >= 44 && document.documentElement.scrollWidth <= innerWidth + 1;
    }), true, "Private-scope recovery must stay readable and reachable at enlarged phone text");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(unavailable, theme);
        await recovery.focus();
        await captureState(unavailable, `${theme}-private-navigation-unavailable`);
    }
    await recovery.click();
    await expect(unavailable.locator("#activityListSummary")).toContainText("8 matching Work IQ tool calls");
    await unavailable.close();
});

test("private handoffs are recipient-bound and one-use, and blocked popups do not navigate broadly", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await restoreLegacySearch(page, "Invented delegated calendar request.");
    await page.evaluate(() => {
        const open = window.open;
        window.open = function (url, ...rest) { window.privateTargetForTest = url; return open.call(this, url, ...rest); };
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const hold = async route => { await gate; return route.fallback(); };
    await page.context().route("**/", hold);
    t.after(() => release());
    const opened = page.context().waitForEvent("page");
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    try {
        assert.equal(await page.evaluate(() => {
            const target = new URL(window.privateTargetForTest), [view, query] = target.hash.split("?");
            const params = new URLSearchParams(query), key = params.get("privateView");
            params.delete("privateView");
            return window.__wireTakePrivateNavigation(key, window, view + "?" + params);
        }), null, "Another window cannot consume the intended recipient's selection");
    } finally { release(); }
    const other = await opened;
    await expect(other.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
    await page.context().unroute("**/", hold);
    const replayed = page.context().waitForEvent("page");
    await page.evaluate(() => window.open(window.privateTargetForTest, "_blank"));
    const replay = await replayed;
    await expect(replay.locator("#message")).toContainText("The private selection could not be restored");
    await expect(replay.locator("#activityListSummary")).toBeHidden();
    await replay.close(); await other.close();
    await page.bringToFront();
    const before = page.url();
    await page.evaluate(() => { window.open = () => null; });
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    await expect(page.locator("#message")).toContainText("The new tab was blocked");
    assert.equal(page.url(), before);
    await expect(page.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
    await page.locator("#openChartReference").click();
    await page.locator("#chartReferenceShowData").click();
    await page.locator("#chartReferenceData").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    await expect(page.locator("#chartReferenceNotice")).toContainText("The new tab was blocked");
    await expect(page.locator("#meaning")).toBeVisible();
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("1");
});

test("an expired private preparation cannot become an ordinary result", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await restoreLegacySearch(page, "Invented delegated calendar request.");
    await page.evaluate(() => {
        const schedule = window.setTimeout;
        window.setTimeout = (action, delay, ...args) => delay === 30000 ? schedule(() => {
            action(...args); window.privatePreparationExpiredForTest = delay;
        }, 0) : schedule(action, delay, ...args);
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.context().route("**/", async route => { await gate; return route.fallback(); });
    t.after(() => release());
    const opened = page.context().waitForEvent("page");
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    try { await page.waitForFunction(() => window.privatePreparationExpiredForTest === 30000); }
    finally { release(); }
    const other = await opened;
    await expect(other.locator("#message")).toContainText("The private selection could not be restored");
    await expect(other.locator("#activityListSummary")).toBeHidden();
    await other.close();
});

for (const elapsed of [29999, 30000, 30001]) test(`private handoff checks its deadline at ${elapsed}ms while cleanup is delayed`, { timeout: 30000 }, async t => {
    const { page, app, requests } = await setup(t);
    await restoreLegacySearch(page, "Invented delegated calendar request.");
    await page.evaluate(() => {
        const schedule = window.setTimeout;
        window.privateClockForTest = performance.now();
        Object.defineProperty(performance, "now", { configurable: true, value: () => window.privateClockForTest });
        window.privateCleanupHeldForTest = 0;
        window.privateCleanupDeliveredForTest = false;
        window.setTimeout = (action, delay, ...args) => {
            if (delay !== 30000) return schedule(action, delay, ...args);
            window.privateCleanupHeldForTest++;
            window.deliverPrivateCleanupForTest = () => {
                window.privateCleanupDeliveredForTest = true;
                action(...args);
            };
            return schedule(() => {}, 0);
        };
    });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.context().route("**/", async route => { await gate; return route.fallback(); });
    t.after(() => release());
    const opened = page.context().waitForEvent("page");
    await page.locator("#outcomeChart").getByRole("link", { name: /^Worked:/ }).click({ modifiers: ["Control"] });
    try {
        assert.equal(await page.evaluate(() => window.privateCleanupHeldForTest), 1);
        await page.evaluate(elapsed => { window.privateClockForTest += elapsed; }, elapsed);
    } finally { release(); }
    const other = await opened;
    if (elapsed < 30000) {
        await expect(other.locator("#activityListSummary")).toContainText("1 matching Work IQ tool call");
        assert.deepEqual(await other.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
            new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request"))), [app.cases.agentCalendar.scenarioId]);
    } else {
        await expect(other.locator("#message")).toContainText("The private selection could not be restored");
        await expect(other.locator("#activityListSummary")).toBeHidden();
        await expect(other.locator("#openChartReference")).toBeHidden();
        assert.equal(await other.evaluate(() => history.state?.evidenceView?.search || ""), "");
        assert.equal(requests.some(request => request.page === other && request.path === "/api/snapshot"), false);
    }
    assert.equal(await page.evaluate(() => window.privateCleanupDeliveredForTest), false,
        "Admission must not depend on the cleanup callback running");
    await other.close();
});
