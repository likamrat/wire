import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { privateFixture, restoreLegacySearch, selectActivityOption } from "./helpers.mjs";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import path from "node:path";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";

function harborRecords() {
    const at = second => new Date(Date.UTC(2026, 9, 10, 9, 0, second)).toISOString();
    const events = (prefix, text, source = "user", second = 0, success = true) => [
        { id: prefix, timestamp: at(second), type: "user.message", data: { content: text, ...(source ? { source } : {}) } },
        { id: prefix + "-start", timestamp: at(second + 1), type: "tool.execution_start",
            data: { toolName: "workiq-fetch", toolCallId: prefix + "-call", arguments: { entityUrl: "/me/drive/root/children" } } },
        { id: prefix + "-end", timestamp: at(second + 2), type: "tool.execution_complete",
            data: { toolCallId: prefix + "-call", success, ...(!success ? { error: { code: "failure",
                message: "Re-authentication required for MCP server 'workiq'. Run /mcp auth workiq." } } : {}) } },
    ];
    const chat = { sessionId: "harbor-documents", name: "Sample: Harbor launch documents", projectId: "harbor", project: "Sample workspace: Harbor launch" };
    const main = extractScenarios([
        ...events("five", "Find the five latest Harbor launch planning documents.", "user", 0, false),
        ...events("three", "Three documents are enough. I have signed in; please try again.", "user", 4),
    ], chat, at(0), at(59)).scenarios;
    const other = [
        ["handover", "Find the support handover email for the Harbor launch.", "user"],
        ["calendar", "Check the launch review time without creating an event.", "agent-scheduling-helper"],
        ["archive", "Find the previous launch checklist.", null],
    ].flatMap(([id, text, source]) => extractScenarios(events(id, text, source, 10),
        { ...chat, sessionId: id, name: `Sample: ${id}` }, at(0), at(59)).scenarios);
    return [...main, ...other];
}

async function setup(t, { pages = false } = {}) {
    const records = harborRecords();
    if (pages) for (let i = 0; i < 9; i++) {
        const record = structuredClone(records[2]);
        record.scenarioId += "-" + i;
        record.userPrompt.sourceTimestamp = `2026-10-11T09:00:${String(i).padStart(2, "0")}Z`;
        record.toolCalls[0].toolCallId += "-" + i;
        record.toolCalls[0].startEventId += "-" + i;
        records.push(record);
    }
    const cleanup = [], fixture = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const server = await startServer(fixture.context, createExportController(fixture.context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], forbidden = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), target = new URL(request.url());
        if (target.origin !== new URL(server.url).origin || /\/api\/(?:collection\/(?:now|configure|enabled)|evaluation\/|deletion\/|confirm|assessment\/(?:consent|feedback))/.test(target.pathname)
            && !target.pathname.endsWith("/automatic/summary")) {
            forbidden.push(target.pathname); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); await server.close();
        for (const fn of cleanup) await fn();
        assert.deepEqual(errors, []);
        assert.deepEqual(forbidden, []);
    });
    return { page, browser, url: server.url, records, context: fixture.context };
}
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const rowFor = (page, text) => page.getByRole("article").filter({ has: page.locator(".full-text-preview").filter({ hasText: text }) });

test("source links visibly filter, and Back stays with orientation rather than report controls", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#analyze"); await ready(page);
    const row = rowFor(page, "Three documents are enough.");
    const source = row.getByRole("link", { name: "Filter to chat: Sample: Harbor launch documents", exact: true });
    await expect(source).toHaveText("Sample: Harbor launch documents");
    await source.focus(); await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#pageProject")).toContainText("Filtered to chat: Sample: Harbor launch documents");
    const back = page.getByRole("link", { name: "Back to results", exact: true });
    await expect(back).toBeVisible();
    assert.equal(await back.evaluate(node => node.closest("#pagePrimaryActions") !== null), true);
    await expect(page.locator(".request-row")).toHaveCount(2);
    await expect(page.locator("#requestView")).toBeHidden();
    await rowFor(page, "Three documents are enough.").getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    await expect(page.locator("#pageTitle")).toHaveText("Interaction");
    await expect(page.locator(".request-original .full-text-content")).toHaveText("Three documents are enough. I have signed in; please try again.");
    await expect(page.locator(".request-source")).toContainText("From Copilot chat");
    await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
    await expect(page.locator(".request-row")).toHaveCount(2);
    await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#analyze");
    await expect(source).toBeFocused();
    await rowFor(page, "Find the previous launch checklist.").getByRole("checkbox").check();
    await source.click(); await ready(page);
    await expect(page.locator("#activitySelectionCompact")).toHaveText("1 in report");
    await expect(page.locator(".request-row input:checked")).toHaveCount(0);
    await page.getByRole("button", { name: "Remove copilot chat filter: Sample: Harbor launch documents", exact: true }).click(); await ready(page);
    await expect(rowFor(page, "Find the previous launch checklist.").getByRole("checkbox")).toBeChecked();
});

test("native modified links have no private return state and missing records retain a safe Back", async t => {
    const { page, url, context } = await setup(t);
    await page.goto(url + "#analyze?authors=user"); await ready(page);
    await restoreLegacySearch(page, "documents");
    const open = rowFor(page, "Three documents are enough.").getByRole("link", { name: "View interaction", exact: true });
    assert.doesNotMatch(await open.getAttribute("href"), /documents(?:&|$)|search=|returnTo/);
    const popupReady = page.context().waitForEvent("page");
    await open.click({ modifiers: ["Control"] });
    const popup = await popupReady; await popup.waitForLoadState(); await ready(popup);
    await expect(popup.getByRole("link", { name: "Back to Analyze", exact: true })).toBeVisible();
    await expect(page.locator("#activityView")).toBeVisible();
    await popup.close();
    await open.click(); await ready(page);
    const existing = await loadBoardState(context);
    await replaceEvidence(context, () => ({ records: [], importCoverage: existing.importCoverage }));
    await page.reload(); await ready(page);
    await expect(page.getByRole("heading", { name: "This interaction is not available", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
    await expect(page.locator("#activityList").getByRole("heading", { name: "No collected activity yet", exact: true })).toBeVisible();
    await expect(page.locator("#activitySearch")).toHaveValue("documents");
});

test("missing and conflicting host senders remain distinct without hiding either record", async t => {
    const app = await authorFilterFixture(t);
    const browser = await chromium.launch();
    app.closeClient(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(app.runtime.url + "#analyze"); await ready(page);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    for (const [name, gap] of [["unverified", "Who sent this was not recorded"], ["conflicting", "Recorded sender details disagree"]]) {
        const record = app.cases[name];
        const row = rowFor(page, record.content);
        await expect(row.locator("[data-prompt-actor]")).toHaveAttribute("data-prompt-actor", "unknown");
        await expect(row).toContainText(gap);
        await row.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
        await expect(page.locator(".request-original")).toContainText(gap);
        await expect(page.locator(".request-original .full-text-content")).toHaveText(record.content);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
        await expect(row).toBeVisible();
    }
    assert.equal(await page.locator(".request-row").count(), Object.keys(app.cases).length);
});

test("filter then reader then Back restores exact calls, query, page, focus and hidden selection", async t => {
    const { page, url } = await setup(t, { pages: true });
    await page.goto(url + "#analyze?mode=calls&tool=workiq-fetch&authors=user&callSort=slowest"); await ready(page);
    await restoreLegacySearch(page, "launch");
    await page.getByRole("navigation", { name: "Analyze result pages" }).getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    const first = page.locator(".matched-action").first(), source = first.getByRole("link", { name: /Filter to chat:/ });
    await source.focus();
    const original = page.url(), position = await source.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await page.getByRole("link", { name: "Open exact call in context", exact: true }).first().click(); await ready(page);
    await page.getByRole("button", { name: "Add to report", exact: true }).click();
    await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
    await page.getByRole("link", { name: "Back to results", exact: true }).click(); await ready(page);
    assert.equal(page.url(), original);
    await expect(page.locator("#activitySearch")).toHaveValue("launch");
    await expect(source).toBeFocused();
    assert.ok(Math.abs((await source.boundingBox()).y - position.y) < 3);
    await expect(page.locator("#activitySelectionCompact")).toHaveText("1 in report");
});

test("direct reader links have an honest local fallback and precise missing-sender explanation", async t => {
    const { page, url, records } = await setup(t);
    const archive = records.find(record => record.sourceSessionId === "archive");
    await page.goto(url + "#request?request=" + archive.scenarioId); await ready(page);
    const back = page.getByRole("link", { name: "Back to Analyze", exact: true });
    await expect(back).toBeVisible();
    await expect(page.locator("#requestContent")).toContainText("Who sent this was not recorded");
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /\/ author unverified/);
    await page.goto(url + "#request?request=" + records[1].scenarioId); await ready(page);
    for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.evaluate(() => scrollTo(0, 0));
        const box = await back.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 1000, "Back is entirely in the first viewport, before a long wrapped heading");
        await back.focus();
        await expect(back).toBeFocused();
    }
    await page.keyboard.press("Enter"); await ready(page);
    assert.equal(new URL(page.url()).hash, "#analyze");
    await page.goto(url + "#analyze?session=no-longer-retained&authors=user"); await ready(page);
    await expect(page.locator("#pageProject")).toContainText("This source is not in the retained collection.");
    await page.getByRole("link", { name: "Clear chat filter", exact: true }).click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#analyze?authors=user");
    await expect(page.locator(".request-row")).toHaveCount(3);
});

test("visible Back to search reuses the current search query, category, page and focused result", { timeout: 40000 }, async t => {
    const records = searchRecords(24);
    records.forEach((record, index) => {
        record.userPrompt.text = `Harbor launch checklist item ${index + 1}.`;
        record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    });
    const app = await searchFixture(t, { records, reply: false, search: root => ({ modelDirectory: path.join(root, "no-model-needed-for-exact-query") }) });
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
    await expect(page.locator("#pageTitle")).toHaveText("Interaction");
    await expect(page.locator(".request-original .full-text-content")).toHaveText(label);
    await page.getByRole("link", { name: "Back to search", exact: true }).click(); await ready(page);
    await expect(page.locator("#wireSearch")).toHaveValue("Harbor launch checklist");
    await expect(page.locator("#wireSearchType")).toHaveValue("interaction");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(page.locator("#wireSearchResults button").first()).toHaveAttribute("data-search-id", id);
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify([history.state, { ...localStorage }, { ...sessionStorage }])),
        /Harbor launch checklist|receipt|capability/);
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.getByRole("link", { name: "Back to search", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.getByRole("link", { name: "Back to search", exact: true })).toBeVisible();
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const queried = new Promise(resolve => { reached = resolve; });
    await page.route("**/api/search/query", async route => { reached(); await held; await route.continue(); });
    await page.getByRole("link", { name: "Back to search", exact: true }).click();
    await queried;
    await page.locator('nav [data-nav="settings"]').click(); await ready(page);
    const focus = await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent }));
    release();
    await expect(page.locator("#wireSearchStatus")).toHaveText(/24 (?:available )?matches/);
    await expect(page.locator("#pageTitle")).toHaveText("Settings");
    assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement.id, text: document.activeElement.textContent })), focus);
    assert.equal(await page.locator("#wireSearchResults").evaluate(node => node.contains(document.activeElement)), false);
});
