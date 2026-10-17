import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption, openSearchFilters } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";

async function setup(t, options) {
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, options);
    const browser = await chromium.launch(), context = await browser.newContext({
        viewport: { width: 1280, height: 900 }, reducedMotion: "reduce",
    });
    const page = await context.newPage(), errors = [], requests = [];
    let capability;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
        capability = request.headers()["x-board-capability"] ?? capability;
    });
    t.after(async () => {
        await browser.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const api = (route, data) => page.request.post(new URL(route, app.runtime.url).href, {
        headers: { Origin: new URL(app.runtime.url).origin, "X-Board-Capability": capability }, data,
    });
    return { ...app, browser, page, requests, api };
}
async function search(page, text, type = "") {
    await page.getByRole("searchbox", { name: "Search", exact: true }).focus();
    await page.locator("#wireSearch").fill(text);
    await selectActivityOption(page, "wireSearchType", type);
}
async function capture(page, name) {
    if (!process.env.WIRE_RELATED_PROOFS) return;
    await mkdir(process.env.WIRE_RELATED_PROOFS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.WIRE_RELATED_PROOFS, name + ".png") });
}

test("related UI: real four-page suggestions use shared visible/browser Back and never steal late focus", { timeout: 60000 }, async t => {
    const records = searchRecords(84).map((row, index) => ({ ...row, sourceSessionName: "Invented same source label",
        userPrompt: { ...row.userPrompt, text: index < 63 ? "The mechanic repaired a broken automobile in the garage."
            : "The meeting agenda listed regional crop moisture logs and soil classifications. ".repeat(6)
                + "The phrase fix my car was copied as a spelling sample." }, followUpPrompts: [] }));
    const { page, requests } = await setup(t, { records });
    const countBefore = await page.locator("#activityCount").textContent();
    await search(page, "fix my car", "interaction");
    await expect(page.locator("#wireSearchRelatedCount")).toContainText("63 suggestions", { timeout: 20000 });
    await expect(page.locator("#wireSearchStatus")).toHaveText("21 matches");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(20);
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(20);
    await expect(page.locator("#wireSearchRelated")).toContainText("These do not change your charts or report selection.");
    await expect(page.locator("#activityCount")).toHaveText(countBefore);
    await expect(page.locator("#wireSearchRelated input[type=checkbox]")).toHaveCount(0);
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    const ids = new Set(await page.locator("#wireSearchRelatedResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId)));
    for (let i = 2; i <= 4; i++) {
        await page.getByRole("button", { name: "Next suggestions", exact: true }).click();
        await expect(page.locator("#wireSearchRelatedPaging")).toContainText(`Page ${i} of 4`);
        for (const id of await page.locator("#wireSearchRelatedResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId))) {
            assert.equal(ids.has(id), false); ids.add(id);
        }
    }
    assert.equal(ids.size, 63);
    const hit = page.locator("#wireSearchRelatedResults button").first(), id = await hit.getAttribute("data-search-id");
    await hit.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("link", { name: "Back to search", exact: true })).toBeVisible();
    await expect(page.locator("#requestContent")).toContainText("The mechanic repaired a broken automobile in the garage.");
    await page.getByRole("link", { name: "Back to search", exact: true }).click();
    await expect(page.locator("#wireSearchRelatedPaging")).toContainText("Page 4 of 4");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(hit).toHaveAttribute("data-search-id", id);
    await expect(hit).toBeFocused();
    await expect(page.locator("#wireSearchType")).toHaveValue("interaction");
    await hit.click();
    await expect(page.getByRole("link", { name: "Back to search", exact: true })).toBeVisible();
    await page.goBack();
    await expect(hit).toBeFocused();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    const strict = page.locator("#wireSearchResults button");
    const strictId = await strict.getAttribute("data-search-id");
    await strict.click();
    await page.getByRole("link", { name: "Back to search", exact: true }).click();
    await expect(strict).toBeFocused();
    await expect(strict).toHaveAttribute("data-search-id", strictId);
    await expect(page.locator("#wireSearchRelatedPaging")).toContainText("Page 4 of 4");
    await capture(page, "related-two-sets-pages");
    await hit.click();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/search/query", async route => { entered.resolve(); await release.promise; await route.continue(); });
    await page.getByRole("link", { name: "Back to search", exact: true }).click();
    await entered.promise;
    await page.locator('nav [data-nav="settings"]').click();
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    const focus = await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent }));
    release.resolve();
    await expect(page.locator("#wireSearchRelatedCount")).toContainText("63 suggestions");
    assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent })), focus);
    assert.equal(await page.locator("#wireSearchRelatedResults").evaluate(node => node.contains(document.activeElement)), false);
    await page.unroute("**/api/search/query");
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify([history.state, { ...localStorage }, { ...sessionStorage }])),
        /fix my car|relatedPolicyId|queryTypes|requestId/);
    assert.ok(requests.filter(request => request.path === "/api/search/query").every(request => request.body.schemaVersion === 2
        && request.body.purpose === "navigation"));
});

test("related UI: switching to analysis uses strict only; forgery cannot enter paired or report scope", { timeout: 40000 }, async t => {
    const { page, requests, api, context } = await setup(t);
    const baseline = await page.locator("#activityCount").textContent();
    await search(page, "fix my car");
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText(baseline);
    await page.locator("#wireSearchRelatedResults button").first().click();
    await expect(page.getByRole("link", { name: "Back to search", exact: true })).toBeVisible();
    const open = requests.find(request => request.path === "/api/search/open").body;
    assert.equal(open.receipt.purpose, "related-navigation");
    const state = await loadBoardState(context);
    const input = { schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", filters: { scope: "all" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-09-30", to: "2026-10-01" } },
        semanticSelection: { receipt: open.receipt }, withinServices: [] };
    assert.equal((await api("/api/period-comparison", input)).status(), 422);
    await page.getByRole("link", { name: "Back to search", exact: true }).click();
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeFocused();
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireSearchRelated")).toBeHidden();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(page.locator("#activityCount")).toHaveText("0");
    assert.equal(requests.filter(request => request.path === "/api/search/query").at(-1).body.purpose, "analysis");
    await page.locator("#wireSearch").fill("physician");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#wireSearchRelated")).toBeHidden();
    await openSearchFilters(page);
    await page.locator("#wireSearchClear").click();
    await expect(page.locator("#activityCount")).toHaveText(baseline);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
});

test("related UI: partial, degraded and reconnect protocol states remain distinct and both lists clear", { timeout: 45000 }, async t => {
    const { page, runtime, api } = await setup(t, { reply: false });
    await search(page, "fix my car", "interaction");
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeVisible();
    await expect(page.locator("#wireSearchCoverage")).toContainText("Some saved content is unavailable");
    await expect(page.locator("#wireSearchRelatedCount")).toHaveText(/^\d+ suggestions?$/);
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Partial searchable coverage");
    await expect(page.locator("#homeView")).toBeHidden();
    await expect(page.locator("#wireSearchRelated")).toBeHidden();
    await selectActivityOption(page, "wireSearchScope", "everywhere");
    await page.locator("#wireSearch").fill("fix my car");
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeVisible();
    await page.locator("#wireSearch").fill("An ancient violin concerto in a distant galaxy.");
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches. Try different words.");
    await page.locator("#wireSearch").fill("fix my car");
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeVisible();
    assert.equal((await api("/api/session/release", {})).status(), 200);
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#wireSearchRelatedResults button").first()).toBeVisible({ timeout: 15000 });
    await runtime.collector.close();
    await expect(page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);

    const degraded = await setup(t, { search: { modelDirectory: "missing-local-model" } });
    await search(degraded.page, "mechanic", "interaction");
    await expect(degraded.page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(degraded.page.locator("#wireSearchCoverage")).toContainText("Word search only.");
    await expect(degraded.page.locator("#wireSearchRelated")).toBeHidden();
    await expect(degraded.page.locator("#wireSearchPanel")).not.toContainText("npm run");
    await degraded.page.getByRole("link", { name: "Search troubleshooting", exact: true }).click();
    await expect(degraded.page).toHaveURL(/setting=settings-search/);
    await expect(degraded.page.locator("#settingsSearchDetails")).toContainText("npm run search:model:provision");
    const changed = await setup(t);
    await changed.page.route("**/api/search/events", route => route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "search-protocol-changed", error: "Search protocol changed. Reload this panel." }) }));
    await search(changed.page, "fix my car");
    await expect(changed.page.locator("#wireSearchStatus")).toContainText("Reload this panel");
    await expect(changed.page.locator("#wireSearchRelatedResults button")).toHaveCount(0);
    await expect(changed.page.locator("#wireSearchResults button")).toHaveCount(0);
});

test("related UI: approved compact grouping preserves centered Search, focus and narrow enlarged-text reading", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await search(page, "fix my car", "interaction");
    await expect(page.locator("#wireSearchRelated")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: 950 });
            await page.evaluate(width => { document.documentElement.style.fontSize = width === 375 ? "200%" : ""; }, width);
            await page.locator("#wireSearch").focus();
            await page.locator("#wireSearch").press("ArrowDown");
            await expect(page.locator("#wireSearchRelatedResults button").first()).toBeFocused();
            await page.locator("#wireSearchRelated").scrollIntoViewIfNeeded();
            const metrics = await page.locator("#wireSearchRelatedResults button").first().evaluate(node => {
                const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
                return { width: innerWidth, document: document.documentElement.scrollWidth,
                    height: rect.height, outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
            });
            assert.ok(metrics.height >= 44);
            assert.equal(metrics.outline, "solid"); assert.ok(metrics.outlineWidth >= 2);
            assert.ok(metrics.document <= metrics.width);
            await expect(page.locator(".app-header nav")).toHaveCount(0);
            await capture(page, `related-${theme}-${width}`);
        }
    }
});

test("related UI: ordinary rows stay human and applied analytical state does not precede unrelated page titles", { timeout: 40000 }, async t => {
    const { page, requests } = await setup(t);
    await search(page, "GET /me/calendarView 403", "action");
    const action = page.locator("#wireSearchResults button").first();
    await expect(action).toBeVisible();
    await expect(action).toHaveAccessibleName(/^Open recorded call:/);
    await expect(action).not.toContainText("#request");
    await expect(action).not.toContainText("call%3A");
    await expect(action).not.toContainText("/me/calendarView");
    await expect(action.locator(".wire-search-excerpt"), "No machine-only action dump is passed off as prose").toHaveCount(0);
    await search(page, "physician", "interaction");
    await expect(page.locator("#wireSearchResults button strong").first()).toHaveText("The physician treated an injured patient in the hospital.");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await page.setViewportSize({ width: 375, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await openSearchFilters(page);
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#navigationToggle").click();
    await page.locator('nav [data-nav="reports"]:visible').click();
    await expect(page.locator("#pageTitle")).toHaveText("Reports");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current")).toContainText("1");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await capture(page, "related-scope-reports-375");
    await page.locator("#navigationToggle").click();
    await page.locator('nav [data-nav="settings"]:visible').click();
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await expect(page.locator("#wireSearch")).toHaveValue("physician");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await capture(page, "related-scope-settings-375");
    await page.locator("#navigationToggle").click();
    await page.locator('nav [data-nav="analyze"]:visible').click();
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeVisible();
    assert.equal(requests.filter(request => request.path === "/api/search/query").at(-1).body.purpose, "analysis");
});
