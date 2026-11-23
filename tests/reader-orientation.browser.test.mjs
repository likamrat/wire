import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { selectActivityOption } from "./helpers.mjs";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
test("missing and conflicting host senders remain distinct without hiding either record", async t => {
    const app = await authorFilterFixture(t);
    const browser = await chromium.launch();
    app.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(app.runtime.url + "#analyze"); await ready(page);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    for (const [name, gap] of [["unverified", "Who sent this was not recorded"], ["conflicting", "Origin details could not be reconciled"]]) {
        const record = app.cases[name];
        const row = page.locator(`#activityList [data-view-key="request:${record.scenarioId}"]`);
        await expect(row.locator("[data-prompt-actor]")).toHaveAttribute("data-prompt-actor", "unknown");
        await row.locator(".request-card-open").click(); await ready(page);
        await expect(page.locator(".request-original")).toContainText(gap);
        await expect(page.locator(".request-original .full-text-content")).toHaveText(record.content);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.locator("#closeContextSidebar").click(); await ready(page);
        await expect(row).toBeVisible();
    }
    for (const name of ["unverified", "conflicting"]) await expect(page.locator(`#activityList [data-view-key="request:${app.cases[name].scenarioId}"]`)).toBeVisible();
});

test("chat filters opened from Source or an unavailable chat preserve the remaining author scope", async t => {
    const records = searchRecords(3);
    records[0].userPrompt.authorship = { actor: "user", basis: "source-user" };
    records[0].sourceSessionName = "Invented reader source";
    records[0].sourceSessionId = "reader-source";
    records[1].userPrompt.authorship = { actor: "user", basis: "source-user" };
    const app = await searchFixture(t, { records, reply: false });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(app.runtime.url + "#analyze?authors=user"); await ready(page);
    const primary = page.locator(`#activityList [data-view-key="request:${records[0].scenarioId}"] .request-card-open`);
    await primary.click();
    await page.getByRole("button", { name: "Source details" }).click();
    await page.getByRole("link", { name: "Filter to chat: Invented reader source" }).press("Enter");
    await ready(page);
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await expect(primary).toBeVisible();
    await expect(page.locator("#pageProject")).toContainText("Filtered to chat: Invented reader source");
    await page.goBack(); await ready(page);
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key", `request:${records[0].scenarioId}`);
    await page.goto(app.runtime.url + "#analyze?session=missing-chat&authors=user"); await ready(page);
    await expect(page.locator("#pageProject")).toContainText("This source is not in the retained collection.");
    const eligible = records.filter(row => row.userPrompt.authorship?.actor === "user");
    assert.ok(eligible.length);
    await page.getByRole("link", { name: "Clear chat filter", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityList .request-row")).toHaveCount(eligible.length);
    assert.equal(new URL(page.url()).searchParams.get("authors"), "user");
});

test("cross-layer verified Search action restores the tool Analyze controls, counts and records on Close", { timeout: 30000 }, async t => {
    const records = searchRecords(3);
    records[0].toolCalls[0].apiResults.push({ ...records[0].toolCalls[0].apiResults[0], index: 1, statusCode: 429 });
    const app = await searchFixture(t, { records, reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], layers = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.url().endsWith("/api/snapshot")) layers.push(request.postDataJSON().layer);
    });
    await page.goto(app.runtime.url + "#analyze"); await ready(page);
    const origin = { route: page.url(), count: await page.locator("#activityCount").textContent(),
        unit: await page.locator("#activityUnit").textContent(),
        records: await page.locator("#activityList .request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)) };
    await page.locator("#wireSearch").fill("429");
    await selectActivityOption(page, "wireSearchType", "action");
    const hit = page.locator("#wireSearchResults button").filter({ hasText: "429" });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/layer=reported-api/);
    await expect(page.locator("#selectedCall")).toContainText("429");
    await expect(page.locator("#layerFilter")).toHaveValue("reported-api");
    await expect(page.locator("#activityCount")).toHaveText("4");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await ready(page);
    assert.equal(page.url(), origin.route);
    await expect(page.locator("#layerFilter")).toHaveValue("tool");
    await expect(page.locator("#activityCount")).toHaveText(origin.count);
    await expect(page.locator("#activityUnit")).toHaveText(origin.unit);
    assert.deepEqual(await page.locator("#activityList .request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)), origin.records);
    assert.deepEqual(layers, ["tool", "reported-api", "tool"], "Close must verify the restored layer instead of reusing reported-API analytics");
    assert.deepEqual(errors, []);
});

for (const mode of ["auto", "manual"]) test(`Back before a cross-layer Search snapshot mounts restores ${mode} history ownership`, { timeout: 20000 }, async t => {
    const records = searchRecords(3);
    records[0].toolCalls[0].apiResults.push({ ...records[0].toolCalls[0].apiResults[0], index: 1, statusCode: 429 });
    const app = await searchFixture(t, { records, reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.runtime.url + "#analyze"); await ready(page);
    await page.evaluate(mode => history.scrollRestoration = mode, mode);
    const origin = { route: page.url(), count: await page.locator("#activityCount").textContent(),
        records: await page.locator("#activityList .request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)) };
    await page.locator("#wireSearch").fill("429");
    await selectActivityOption(page, "wireSearchType", "action");
    const hit = page.locator("#wireSearchResults button").filter({ hasText: "429" });
    await expect(hit).toBeVisible();
    const hitId = await hit.getAttribute("data-search-id");
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/snapshot", route => {
        if (route.request().postDataJSON().layer !== "reported-api") return route.continue();
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await hit.click(); await pending;
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.evaluate(() => history.scrollRestoration), "manual", "Owned entry claimed restoration before the delayed snapshot");
        await page.goBack(); await ready(page);
        assert.equal(page.url(), origin.route);
        await expect(page.locator("#layerFilter")).toHaveValue("tool");
        await expect(page.locator("#activityCount")).toHaveText(origin.count);
        assert.deepEqual(await page.locator("#activityList .request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)), origin.records);
        const restoredHit = page.locator(`.wire-search-hit[data-search-id="${hitId}"]`);
        await expect(restoredHit).toBeFocused();
        await expect(page.locator("#wireSearch")).toHaveValue("429");
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode, "A no-host close releases the caller's history mode");
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(page.url(), origin.route);
        await expect(restoredHit).toBeFocused();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await expect(page.locator("#selectedCall")).toHaveCount(0);
        await expect(page.locator("#activityCount")).toHaveText(origin.count);
        assert.deepEqual(errors, []);
    } finally { release(); await Promise.all(deliveries); }
});

test("sidebar Close reuses the current search query, category, page and focused result", { timeout: 40000 }, async t => {
    const records = searchRecords(24);
    records.forEach((record, index) => {
        record.userPrompt.text = `Harbor launch checklist item ${index + 1}.`;
        record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    });
    const app = await searchFixture(t, { records, reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(app.runtime.url); await ready(page);
    await page.getByRole("searchbox", { name: "Search", exact: true }).focus();
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("Harbor launch checklist");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await expect(page.locator("#wireSearchStatus")).toHaveText(/24 (?:available )?matches/);
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    const hit = page.locator("#wireSearchResults button").first();
    const id = await hit.getAttribute("data-search-id"), label = (await hit.innerText()).match(/Harbor launch checklist item \d+\./)[0];
    await hit.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#contextSidebarTitle")).toHaveText("Interaction");
    await expect(page.locator(".request-original .full-text-content")).toHaveText(label);
    await page.locator("#closeContextSidebar").click(); await ready(page);
    await expect(page.locator("#wireSearch")).toHaveValue("Harbor launch checklist");
    await expect(page.locator("#wireSearchType")).toHaveValue("interaction");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(page.locator("#wireSearchResults button").first()).toHaveAttribute("data-search-id", id);
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify([history.state, { ...localStorage }, { ...sessionStorage }])),
        /Harbor launch checklist|receipt|capability/);
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator("#closeContextSidebar")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator("#closeContextSidebar")).toBeVisible();
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const queried = new Promise(resolve => { reached = resolve; });
    await page.route("**/api/search/query", async route => { reached(); await held; await route.continue(); });
    await page.locator("#closeContextSidebar").click();
    await queried;
    await page.locator('nav [data-nav="settings"]').click(); await ready(page);
    const focus = await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent }));
    release();
    await expect(page.locator("#wireSearchStatus")).toHaveText(/24 (?:available )?matches/);
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent })), focus);
    assert.equal(await page.locator("#wireSearchResults").evaluate(node => node.contains(document.activeElement)), false);
});
