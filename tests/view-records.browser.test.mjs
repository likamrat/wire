import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, revealAnalyzeRecords, selectActivityOption } from "./helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { searchFixture } from "./live-search-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function setup(t, { navigate = true } = {}) {
    const records = Array.from({ length: 10 }, (_, index) => {
        const record = fixture(`view-records-${index}`);
        record.project = "Invented community workshop preparation and accessible room arrangements";
        record.capturedAt = `2026-01-${String(28 - index).padStart(2, "0")}T12:00:00Z`;
        record.userPrompt = { text: `Review the invented workshop checklist ${index + 1}.`, status: "full",
            sourceEventId: `prompt-${index}`, sourceTimestamp: record.capturedAt,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = [true, false].map((worked, call) => ({
            ...record.toolCalls[0], toolCallId: `call-${index}-${call}`, startEventId: `start-${index}-${call}`,
            startedAt: record.capturedAt, durationMs: 100,
            toolSucceeded: worked, reportedOutcome: worked ? "succeeded" : "failed",
            apiResults: [], requestArgs: { entityUrls: ["/me/drive/items/invented-workshop"] },
            ...worked ? {} : { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: "access-denial" } },
        }));
        if (index === 9) Object.assign(record.toolCalls[1], { requestArgs: {}, requestedApiPath: null });
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw Error("No provider calls in View records proof."); },
            readSource: async () => { throw Error("No source-history reads in View records proof."); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const denied = [], errors = [];
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
            "/api/search/events", "/api/search/status",
            "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname);
        return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close();
            await runtime.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(denied, []);
            assert.deepEqual(errors, []);
        } finally { for (const action of cleanup) await action(); }
    });
    if (navigate) {
        await page.goto(runtime.url + "#analyze");
        await ready(page);
    }
    return { page, runtime, records };
}

test("Analyze exposes its existing records without a duplicate navigation action", async t => {
    const { page } = await setup(t);
    const origin = page.url();
    await expect(page.locator("#resultsLink")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View records", exact: true })).toHaveCount(0);
    await revealAnalyzeRecords(page);
    await frames(page);
    const summary = page.locator("#activityListSummary");
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("10 interactions with 20 matching Work IQ tool calls");
    await expect(page.locator("#activityListContext #activityListSummary")).toBeVisible();
    await expect(page.locator("#openAnalysisSearch")).toHaveCount(0);
    await expect(page.locator("#activityListScope")).toBeHidden();
    await expect(page.locator("#activityListScope")).toHaveText("");
    assert.equal(page.url(), origin, "The shortcut does not create a records route or change matching scope.");
    const position = await summary.boundingBox(), header = await page.locator(".app-header").boundingBox();
    assert.ok(position.y >= header.y + header.height && position.y + position.height <= 1000);
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toBeFocused();
});

test("an empty accepted view still has a visible entry summary without clearing its dates", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?range=custom&from=2027-01-01&to=2027-01-02");
    await ready(page);
    const origin = page.url();
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await expect(page.locator("#activityListSummary")).toHaveText("0 interactions with 0 matching Work IQ tool calls");
    await expect(page.locator("#activityList")).toContainText("No matching interactions");
    await expect(page.locator("#activityPager")).toBeHidden();
    assert.equal(page.url(), origin);
});

test("list context uses widget title typography and full-width accepted restrictions at enlarged text", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?project=test-project&services=Files&includeMissingService=true");
    await ready(page);
    const proof = process.env.WIRE_VIEW_RECORDS_PROOFS, measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1024, 1], [820, 2], [390, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await revealAnalyzeRecords(page);
        await frames(page);
        const measured = await page.evaluate(() => {
            const summary = document.querySelector("#activityListSummary").getBoundingClientRect();
            const title = getComputedStyle(document.querySelector("#activityListSummary"));
            const widget = getComputedStyle(document.querySelector("#outcomeChart h3"));
            const scope = document.querySelector("#activityListScope").getBoundingClientRect();
            const context = document.querySelector("#activityListContext").getBoundingClientRect();
            const header = document.querySelector(".app-header").getBoundingClientRect();
            return { overflow: document.documentElement.scrollWidth - innerWidth,
                title: [title.fontFamily, title.fontSize], widget: [widget.fontFamily, widget.fontSize],
                summary: summary.toJSON(), scope: scope.toJSON(), context: context.toJSON(), header: header.toJSON() };
        });
        measurements.push({ theme, width, scale, ...measured });
        assert.ok(measured.overflow <= 1, JSON.stringify(measurements.at(-1)));
        assert.deepEqual(measured.title, measured.widget);
        assert.ok(measured.summary.right <= measured.context.right + 1);
        if (width <= 820) assert.ok(Math.abs(measured.scope.right - measured.context.right) <= 1,
            "Long accepted restrictions use the full narrow row without an empty control column.");
        assert.ok(measured.summary.top >= measured.header.bottom, "Entry focus is not underneath the sticky header.");
        if (proof) await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-list.png`) });
    }
    if (proof) await writeFile(path.join(proof, "list-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("the visible entry preserves page two and the card position through reader Close and browser Back", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?page=1&result=failure");
    await ready(page);
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityPager")).toContainText("9-10 of 10 interactions");
    const card = page.locator(".request-card-open").first();
    await card.focus();
    const origin = { url: page.url(), y: (await card.boundingBox()).y };
    for (const close of ["button", "history"]) {
        await page.keyboard.press("Enter");
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
        await expect(page.locator("#requestContent .action-context").filter({ hasText: "Outside current view" })).toHaveCount(1);
        if (close === "button") await page.locator("#closeContextSidebar").click();
        else await page.goBack();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
        await frames(page);
        await expect(card).toBeFocused();
        await expect(page.locator("#activityPager")).toContainText("9-10 of 10 interactions");
        assert.equal(page.url(), origin.url);
        const returned = await card.boundingBox();
        assert.ok(Math.abs(returned.y - origin.y) < 2,
            `${close} moved the originating card from ${origin.y}px to ${returned.y}px.`);
    }
});

test("Analyze remains the only ordinary navigation entry out of period comparison", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?compare=periods&aFrom=2026-01-19&aTo=2026-01-23&bFrom=2026-01-24&bTo=2026-01-28");
    await ready(page);
    const exit = page.locator('.primary-navigation [data-nav="analyze"]');
    await expect(exit).toBeVisible();
    await expect(page.locator("#activityView")).toBeHidden();
    await expect(page.locator("#resultsLink")).toHaveCount(0);
    await exit.focus();
    await page.keyboard.press("Enter");
    await frames(page);
    await expect(page.locator("#activityView")).toBeVisible();
    assert.equal(new URL(page.url()).hash.includes("compare=periods"), false);
});

test("native chart selection and modified links lead to the same matching records and full reader", async t => {
    const { page } = await setup(t);
    const failure = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
    await expect(failure).toHaveAttribute("href", /result=failure/);
    const originalUrl = page.url();
    const popupPromise = page.context().waitForEvent("page");
    await failure.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    await ready(popup);
    await expect(popup.locator("#activityListSummary")).toHaveText("10 interactions with 10 matching Work IQ tool calls");
    assert.equal(page.url(), originalUrl, "Modified chart navigation leaves the originating view intact.");
    await popup.close();

    await failure.focus();
    const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.keyboard.press("Enter");
    const accepted = await (await response).json();
    await ready(page);
    assert.equal(accepted.analytics.rows.length, 10);
    assert.ok(accepted.analytics.rows.every(row => row.outcome === "failure"));
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    const ownersOnPage = () => page.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request")));
    const displayedOwners = await ownersOnPage();
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    displayedOwners.push(...await ownersOnPage());
    assert.deepEqual(displayedOwners.sort(), [...new Set(accepted.analytics.rows.map(row => row.scenarioId))].sort());
    await expect(page.locator("#activityPager")).toContainText("9-10 of 10 interactions");
    const card = page.locator("#activityList .request-card-open").first();
    await card.focus();
    const origin = { url: page.url(), y: (await card.boundingBox()).y };
    await page.keyboard.press("Enter");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
    await expect(page.locator("#requestContent .action-context").filter({ hasText: "Outside current view" })).toHaveCount(1);
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    await frames(page);
    await expect(card).toBeFocused();
    assert.equal(page.url(), origin.url);
    assert.ok(Math.abs((await card.boundingBox()).y - origin.y) < 2);
});

test("a native time column keeps its exact accepted date window when its records are read", async t => {
    const { page } = await setup(t);
    const column = page.locator('#chart a[href*="from="]').first();
    const target = new URLSearchParams((await column.getAttribute("href")).split("?")[1]);
    const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await column.click();
    const accepted = await (await response).json();
    await ready(page);
    assert.equal(accepted.analytics.rows.length, 14);
    await revealAnalyzeRecords(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await expect(page.locator("#activityListSummary")).toHaveText("7 interactions with 14 matching Work IQ tool calls");
    const current = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    assert.equal(current.get("from"), target.get("from"));
    assert.equal(current.get("to"), target.get("to"));
    const owners = await page.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request")));
    assert.deepEqual(owners.sort(), [...new Set(accepted.analytics.rows.map(row => row.scenarioId))].sort());
});

for (const [width, scale] of [[1440, 1], [390, 2]]) test(`exact and missing call entries return to visible page-two context at ${width}/${scale}x`, async t => {
    const { page, runtime } = await setup(t);
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
    const exact = `call:${JSON.stringify(["test-session", "call-0-0"])}`;
    const returnedFocus = [];
    for (const target of [exact, "unavailable-recorded-call"]) {
        const params = new URLSearchParams({ request: "view-records-0", call: target, layer: "tool", result: "failure", page: "1" });
        await page.goto(runtime.url + "#request?" + params);
        await ready(page);
        if (target === exact) {
            await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "call-0-0");
            await expect(page.locator("#selectedCall")).toBeFocused();
            await expect(page.locator("#selectedCall>.action-context")).toHaveText("Outside current view");
            await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
        } else {
            await expect(page.locator("#unavailableCall")).toBeFocused();
            await expect(page.locator("#selectedCall")).toHaveCount(0);
        }
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
        await frames(page);
        await expect(page.locator("#activityPager")).toContainText("9-10 of 10 interactions");
        returnedFocus.push(await page.evaluate(() => {
            const summary = document.querySelector("#activityListSummary").getBoundingClientRect();
            const header = document.querySelector(".app-header").getBoundingClientRect();
            return { id: document.activeElement.id, summaryTop: summary.top, summaryBottom: summary.bottom, headerBottom: header.bottom,
                inViewport: summary.top >= header.bottom && summary.bottom <= innerHeight };
        }));
        assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("result"), "failure");
    }
    t.diagnostic(JSON.stringify(returnedFocus));
    assert.ok(returnedFocus.every(value => value.id === "activityListSummary" && value.inViewport),
        "When no originating card is on the restored page, the fallback must be a visible list entry, not its hidden heading.");
});

test("the list caption stays on accepted scope while a chart filter is pending or fails", async t => {
    const { page } = await setup(t);
    const caption = page.locator("#activityListScope");
    await expect(caption).toBeHidden();
    await expect(caption).toHaveText("");
    await expect(caption).toHaveAttribute("data-revision", await page.locator("#activityView").getAttribute("data-revision"));
    const acceptedRevision = await caption.getAttribute("data-revision");
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { requested = resolve; });
    const hold = async route => {
        if (!route.request().postDataJSON().filters.outcomes?.includes("failure")) return route.continue();
        requested();
        await gate;
        await route.fulfill({ status: 503, json: { error: "Invented stored-read failure." } });
    };
    t.after(() => release());
    await page.route("**/api/snapshot", hold);
    await page.locator('#outcomeChart [data-category="failure"] .percentage-label').click();
    await pending;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(caption).toHaveText("");
    await expect(caption).toBeHidden();
    await expect(caption).toHaveAttribute("data-revision", acceptedRevision);
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 20 matching Work IQ tool calls");
    release();
    await ready(page);
    await expect(caption).toHaveText("");
    await expect(caption).toBeHidden();
    await expect(caption).toHaveAttribute("data-revision", acceptedRevision);
    await expect(caption).not.toContainText("Outcome: Tool failed");
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 20 matching Work IQ tool calls");
    await page.unroute("**/api/snapshot", hold);
    await page.locator('#outcomeChart [data-category="failure"] .percentage-label').click();
    await ready(page);
    await expect(caption).toContainText("Outcome: Tool failed");
    await expect(caption).toHaveAttribute("data-revision", await page.locator("#activityView").getAttribute("data-revision"));
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 10 matching Work IQ tool calls");
});

test("accepted service captions distinguish known matches from retained missing-service context", async t => {
    const { page, runtime } = await setup(t);
    const withContext = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.goto(runtime.url + "#analyze?services=Files&includeMissingService=true");
    const contextSnapshot = await (await withContext).json();
    await ready(page);
    assert.equal(contextSnapshot.analytics.serviceInvolvement.selection.knownMatchIds.length, 19);
    assert.equal(contextSnapshot.analytics.serviceInvolvement.selection.contextOnlyIds.length, 1);
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 20 matching Work IQ tool calls");
    const contextCaption = await page.locator("#activityListScope").textContent();
    const strict = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.goto(runtime.url + "#analyze?services=Files&includeMissingService=false");
    const strictSnapshot = await (await strict).json();
    await ready(page);
    assert.equal(strictSnapshot.analytics.serviceInvolvement.selection.knownMatchIds.length, 19);
    assert.equal(strictSnapshot.analytics.serviceInvolvement.selection.contextOnlyIds.length, 0);
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 19 matching Work IQ tool calls");
    assert.match(contextCaption, /Service: Files/);
    assert.match(contextCaption, /19 known matches; 1 context-only/);
    await expect(page.locator("#activityListScope")).toContainText("Files only (19 known matches)");
    await expect(page.locator("#activityListScope")).not.toContainText("context-only");
});

test("initial loading and a failed first read never expose a zero-match or accepted-scope claim", async t => {
    const { page, runtime } = await setup(t, { navigate: false });
    let release, requested;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { requested = resolve; });
    const hold = async route => {
        requested();
        await gate;
        await route.fulfill({ status: 503, json: { error: "Invented first-read failure." } });
    };
    t.after(() => release());
    await page.route("**/api/snapshot", hold);
    await page.goto(runtime.url + "#analyze");
    await pending;
    await expect(page.locator("#activityListSummary")).toBeHidden();
    await expect(page.locator("#activityListScope")).toBeHidden();
    await expect(page.locator("#activityListSummary")).toHaveText("");
    release();
    await expect(page.locator("#message")).toContainText("Your activity could not load");
    await expect(page.locator("#activityListSummary")).toBeHidden();
    await expect(page.locator("#activityListScope")).toBeHidden();
    await page.unroute("**/api/snapshot", hold);
    await page.locator("#storedViewRetry").click();
    await ready(page);
    await expect(page.locator("#activityListSummary")).toHaveText("10 interactions with 20 matching Work IQ tool calls");
    await expect(page.locator("#activityListScope")).toBeHidden();
    await expect(page.locator("#activityListScope")).toHaveText("");
});

for (const complete of [true, false]) for (const match of [true, false]) test(
    `native scoped Search ${complete ? "binds" : "withholds"} ${match ? "matching" : "empty"} analytical membership`, async t => {
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, { reply: complete });
    const before = await loadBoardState(app.context);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], denied = [];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(app.runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
            "/api/search/events", "/api/search/status", "/api/search/query", "/api/search/membership", "/api/search/cancel",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname);
        return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close();
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(denied, []);
            assert.deepEqual(errors, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(app.runtime.url + "#analyze");
    await ready(page);
    const filterEntry = page.locator("#openAnalyzeFilters");
    const initialSummary = await page.locator("#activityListSummary").textContent();
    await expect(filterEntry).toHaveAccessibleDescription(/Saved collection/);
    const query = match ? "physician" : "UNMATCHED_VIEW_RECORDS_PHRASE";
    await page.locator("#wireSearch").fill(query);
    await selectActivityOption(page, "wireSearchScope", "analysis");
    if (complete) {
        await expect(page.locator("#activityListScope")).toContainText("Search applied");
        await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
        await expect(page.locator("#wireAnalysisSearchNotice")).toHaveText("");
        await expect(page.locator("#activityListSummary")).toHaveText(match
            ? "1 interaction with 1 matching Work IQ tool call" : "0 interactions with 0 matching Work IQ tool calls");
        await expect(page.locator("#activityCount")).toHaveText(match ? "1" : "0");
        const ids = await page.locator("#activityList .request-card-open").evaluateAll(nodes => nodes.map(node =>
            new URLSearchParams(new URL(node.href).hash.split("?")[1]).get("request")));
        assert.deepEqual(ids, match ? ["search-0"] : []);
        if (!match) {
            await expect(page.locator("#activityPager")).toBeHidden();
            await expect(page.locator("#activityList")).toContainText("No matching interactions");
        }
        await expect(page.locator("#activityListScope")).toContainText("Search applied");
        await expect(page.locator("#activityListScope")).not.toContainText(query);
        await expect(filterEntry).toHaveAccessibleDescription(/Search applied/);
        await expect(filterEntry).not.toHaveAccessibleDescription(new RegExp(query));
        await expect(page.locator("#activityListScope")).toHaveAttribute("data-revision", await page.locator("#activityView").getAttribute("data-revision"));
        await page.locator("#wireSearch").press("Escape");
        const route = page.url();
        await revealAnalyzeRecords(page);
        await expect(page.locator("#activityListSummary")).toBeFocused();
        assert.equal(page.url(), route);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        t.after(() => release());
        const nextQuery = match ? "UNMATCHED_REBOUND_RECORDS_PHRASE" : "physician";
        const hold = async route => {
            if (route.request().postDataJSON().query !== nextQuery) return route.continue();
            await gate;
            await route.continue();
        };
        await page.route("**/api/search/query", hold);
        await page.locator("#wireSearch").focus();
        const pending = page.waitForRequest(request => request.url().endsWith("/api/search/query") && request.postDataJSON().query === nextQuery);
        await page.locator("#wireSearch").fill(nextQuery);
        try {
            await pending;
            await expect(page.locator("#activityView")).toBeHidden();
            await expect(filterEntry).not.toHaveAccessibleDescription(/Saved collection|Search applied/);
            await expect(filterEntry).toHaveAccessibleName("Filters and view");
            await expect(page.locator("#analyzeFilterCount")).toBeHidden();
        } finally { release(); }
        await expect(page.locator("#activityListSummary")).toHaveText(match
            ? "0 interactions with 0 matching Work IQ tool calls" : "1 interaction with 1 matching Work IQ tool call");
        await expect(filterEntry).toHaveAccessibleDescription(/Search applied/);
        await expect(filterEntry).not.toHaveAccessibleDescription(new RegExp(nextQuery));
        await expect(filterEntry).toHaveAccessibleName("Filters and view, 1 active filter");
        await expect(page.locator("#analyzeFilterCount")).toBeVisible();
        await page.unroute("**/api/search/query", hold);
    } else {
        await expect(page.locator("#wireAnalysisSearchNotice")).toHaveText("Some saved text could not be searched. Counts and Current reports are unavailable.");
        await expect(page.locator("#activityView")).toBeHidden();
        await expect(page.locator("#activityListSummary")).toBeHidden();
        await expect(page.locator("#activityListScope")).toHaveAttribute("hidden", "");
        await expect(page.locator("#activityListScope")).toHaveText("");
        await expect(page.locator("#activityListScope")).not.toHaveAttribute("data-revision", /.+/);
        await expect(page.locator("#resultsLink")).toBeHidden();
        await expect(page.locator("#homeView")).toBeHidden();
        const filters = page.locator("#openAnalyzeFilters");
        if (await filters.count()) {
            await expect(filters).not.toHaveAccessibleDescription(/Saved collection|Search applied/);
        }
        await expect(filterEntry).toHaveAccessibleName("Filters and view");
        await expect(page.locator("#analyzeFilterCount")).toBeHidden();
    }
    await page.locator("#wireSearch").fill("");
    await expect(page.locator("#activityListSummary")).toHaveText(initialSummary);
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(filterEntry).toHaveAccessibleDescription(/Saved collection/);
    await expect(filterEntry).not.toHaveAccessibleDescription(/Search applied/);
    await expect(filterEntry).toHaveAccessibleName("Filters and view");
    await expect(page.locator("#analyzeFilterCount")).toBeHidden();
    assert.ok(!page.url().includes(query));
});
