import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { navigateMain, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "../support/helpers.mjs";
import { prepareReportPreview } from "../reports/report-journey-helpers.mjs";
import { searchFixture } from "../search/live-search-fixture.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function setup(t, { preview = false, records = scopeRecords() } = {}) {
    const cleanup = [];
    const { runtime, context } = await searchFixture({ after: fn => cleanup.push(fn) }, { records });
    const before = await loadBoardState(context);
    const browser = await chromium.launch(), page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    const errors = [], denied = [], nonSearchTraffic = [], urls = [];
    const reads = new Set(["/api/snapshot", "/api/collection/status", "/api/search/events", "/api/search/query",
        "/api/search/cancel", "/api/search/status", "/api/search/close", "/api/search/membership",
        ...(preview ? ["/api/report-artifacts/list", "/api/preview", "/api/cancel-preview"] : [])]);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => {
        urls.push(req.url());
        if (req.method() === "POST" && new URL(req.url()).pathname !== "/api/search/query") nonSearchTraffic.push(req.postData());
    });
    await page.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === new URL(runtime.url).origin && (req.method() === "GET" || reads.has(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            const storage = await page.evaluate(() => JSON.stringify([history.state, { ...sessionStorage }, { ...localStorage }]));
            assert.doesNotMatch(JSON.stringify([storage, urls, nonSearchTraffic]), /INVENTED_PARITY_NEEDLE|Invented(?:%20| )parity(?:%20| )chat/);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["exports", "cards", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally {
            await browser.close();
            for (const fn of cleanup) await fn();
        }
    });
    await page.goto(runtime.url); await ready(page);
    return { page, context, records, revision: before.revision };
}

async function search(page, query) {
    const field = page.locator("#wireSearch");
    await field.fill(query); await selectActivityOption(page, "wireSearchScope", "analysis"); await field.focus();
}
async function cohort(page, interactions, count) {
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Search applied/i);
    await expect(page.locator("#activityCount")).toHaveText(String(count));
    await expect.poll(() => page.locator("#activityList article").evaluateAll(rows => rows.map(r => r.dataset.viewKey).sort()))
        .toEqual(interactions.map(i => `request:parity-request-${i}`).sort());
}
async function choose(page, id, value) {
    await selectActivityOption(page, id, value); await ready(page); await closeAnalyzeFilters(page);
}

test("Current Analyze view prepares the complete parents of calls matching private Search and filters", async t => {
    const records = scopeRecords();
    records[9].userPrompt.authorship = { actor: "user", basis: "source-user" };
    const { page, revision } = await setup(t, { records, preview: true });
    await choose(page, "serviceAssociationFilter", "Files"); await choose(page, "promptAuthorFilter", "user");
    await choose(page, "outcomeFilter", "failure");
    await expect(page.locator('[data-view-key="request:parity-request-9"]')).toBeVisible();
    await search(page, privateQuery); await cohort(page, [0, 6], 3);
    await page.locator("#wireSearch").press("Escape");
    await openAnalyzeFilters(page);
    await page.getByRole("button", { name: "Reset filters", exact: true }).click(); await ready(page);
    await expect(page.locator("#wireSearch")).toHaveValue("");
    await closeAnalyzeFilters(page);
    await page.goBack(); await ready(page);
    await cohort(page, [0, 6], 3);
    await navigateMain(page, "reports"); await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    await picker.getByRole("radio", { name: /^Current Analyze view/ }).check();
    await picker.getByRole("button", { name: "Use activity", exact: true }).click();
    const preparing = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await prepareReportPreview(page);
    const response = await preparing, result = await response.json(), input = response.request().postDataJSON();
    assert.equal(response.status(), 200, result.error);
    assert.equal(input.selection.revision, revision);
    assert.deepEqual(input.selection.scenarioIds.toSorted(), ["parity-request-0", "parity-request-6"]);
    assert.equal(input.reportView.semanticSelection.receipt.queryPurpose, "analysis");
    const calls = result.snapshot.records.map(r => r.toolCalls.map(c => [c.durationMs, c.toolSucceeded])
        .sort((a, b) => a[0] - b[0])).sort((a, b) => a[0][0] - b[0][0]);
    assert.deepEqual(calls, [[[100, false], [300, false], [900, true]], [[6000, false]]]);
    assert.doesNotMatch(JSON.stringify(result.snapshot.records), /parity-call-/);
});

test("late Search and snapshot reads cannot replace a newer private cohort", { timeout: 30000 }, async t => {
    const { page, revision } = await setup(t);
    const field = page.locator("#wireSearch"), old = `${privateQuery} request 0`;
    await search(page, `${privateQuery} request 2`); await cohort(page, [2], 1);
    const held = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/search/query", async route => {
        if (route.request().postDataJSON().query !== old) return route.continue();
        held.resolve(); await release.promise; await route.continue();
    });
    try {
        await field.fill(old); await held.promise;
        await field.fill(`${privateQuery} request 6`); await cohort(page, [6], 1);
        const late = page.waitForResponse(r => r.url().endsWith("/api/search/query") && r.request().postDataJSON().query === old);
        release.resolve(); await (await late).finished(); await cohort(page, [6], 1);
    } finally { release.resolve(); }
    await field.press("Escape");
    const started = Promise.withResolvers(), allow = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(); started.resolve(); await allow.promise; await route.fulfill({ response });
    }, { times: 1 });
    try {
        await selectActivityOption(page, "promptAuthorFilter", "agent"); await started.promise; await closeAnalyzeFilters(page);
        await field.fill(`${privateQuery} request 1`);
        allow.resolve(); await ready(page); await cohort(page, [1], 1);
    } finally { allow.resolve(); }
    await field.press("Escape");
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), body = await response.json();
        body.revision = body.analytics.revision = revision - 1;
        await route.fulfill({ response, json: body });
    }, { times: 1 });
    await choose(page, "promptAuthorFilter", "user");
    await expect(page.locator("#message")).toContainText("older snapshot was rejected");
    await expect(page.locator("#periodResult")).toHaveAttribute("data-revision", String(revision));
    await expect(page.locator("#promptAuthorFilter")).toHaveValue("agent");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Search is unavailable");
    await expect(page.locator("#activityListSummary")).toBeHidden();
    await expect(page.locator("#activityList article")).toHaveCount(0);
    await expect(field).toHaveValue(`${privateQuery} request 1`);
    await page.locator("#message").getByRole("button", { name: "Retry" }).click(); await ready(page);
    await field.fill(""); await field.fill(`${privateQuery} request 1`); await cohort(page, [1], 1);
});

test("the same Search words follow the new source revision and keep returned entries separate from calls", { timeout: 30000 }, async t => {
    const { page, context, records, revision } = await setup(t);
    const words = `${privateQuery} request 6`;
    await search(page, words); await cohort(page, [6], 1); await page.locator("#wireSearch").press("Escape");
    for (const row of records.filter(r => r.sourceSessionId === "parity-chat-0")) row.userPrompt.text = words;
    records[6].userPrompt.text = "Outside the revised cohort.";
    const newer = page.waitForResponse(async r => r.url().endsWith("/api/snapshot") && r.ok() && (await r.json()).revision > revision);
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster: [] } }));
    await choose(page, "promptAuthorFilter", "user");
    await (await newer).finished(); await ready(page);
    await cohort(page, [0], 3);
    await choose(page, "layerFilter", "reported-api"); await cohort(page, [0], 4);
    await expect(page.locator("#activityUnit")).toHaveText("tool-returned API results");
    await choose(page, "layerFilter", "direct-request"); await cohort(page, [], 0);
    await expect(page.locator("#activityUnit")).toHaveText("recorded Graph request sites");
    await choose(page, "layerFilter", "tool"); await cohort(page, [0], 3);
    await expect(page.locator("#activityUnit")).toHaveText("Work IQ tool calls");
});
