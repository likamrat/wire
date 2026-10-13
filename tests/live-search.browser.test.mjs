import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, appendFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords, streamPanel, saveSearchComparison } from "./live-search-fixture.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { chooseTheme, selectActivityOption, openSearchFilters } from "./helpers.mjs";
import { chooseReportScope } from "./report-journey-helpers.mjs";
import { readSavedReportFile, readSavedComparisonFile, readSavedComparison, reportHash } from "../lib/report-artifacts.mjs";
import { mountPeriodComparison } from "../web/period-comparison.mjs";

async function setup(t, options) {
    const app = await searchFixture(t, options);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    t.after(() => browser.close());
    page.setDefaultTimeout(15000);
    const errors = [], requests = [];
    let capability;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        requests.push({ url: request.url(), method: request.method() });
        capability = request.headers()["x-board-capability"] ?? capability;
    });
    await page.goto(app.runtime.url);
    await expect(page.locator('#workspace[aria-busy="false"]')).toBeVisible();
    const api = (route, data = {}) => page.request.post(new URL(route, app.runtime.url).href, {
        headers: { Origin: new URL(app.runtime.url).origin, "X-Board-Capability": capability }, data,
    });
    return { ...app, page, errors, requests, api };
}
async function find(page, query, type = "") {
    await page.locator("#wireSearch").focus();
    await page.locator("#wireSearch").fill(query);
    await selectActivityOption(page, "wireSearchType", type);
    if (await page.locator("#wireSearchOptions").evaluate(node => node.open)) await page.locator("#wireSearchFilterSummary").click();
    await expect(page.locator("#wireSearchStatus")).toHaveText(/(?:\d+ (?:available )?match(?:es)?|No matches\..*)/, { timeout: 30000 });
    return page.locator("#wireSearchResults button");
}

test("normal entry types real paraphrases and exact anchors, opens all types and restores Back", { timeout: 120000 }, async t => {
    const app = await setup(t, { formats: ["html", "json", "markdown", "pdf"] });
    const { page, bundles, exports, context } = app;
    const preview = await exports.previewComparison("live-proof", bundles[0].bundleId, bundles[1].bundleId, { formats: ["json"] });
    await exports.reviewComparison("live-proof", preview.previewId, true);
    await exports.confirmComparison("live-proof", preview.previewId, true);
    const before = await loadBoardState(context);
    const initialCount = await page.locator("#activityCount").textContent();
    await page.locator("#activityList .request-row input").first().check();
    const query = "A doctor cared for somebody who was hurt.";
    const words = new Set(before.evidence[0].userPrompt.text.toLowerCase().match(/\p{L}+/gu));
    assert.ok(query.toLowerCase().match(/\p{L}+/gu).every(word => !words.has(word)));
    await expect(page.locator('input[type="search"]:visible')).toHaveCount(1);
    const hits = await find(page, query, "interaction");
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText("physician");
    assert.equal((await (await app.api("/api/search/status")).json()).mode, "hybrid");
    assert.equal(await page.locator("#activityCount").textContent(), initialCount);
    await page.locator("#wireSearch").press("ArrowDown");
    await expect(hits.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#pageTitle")).toHaveText("Interaction");
    await expect(page.locator(".request-original .full-text-content")).toHaveText("The physician treated an injured patient in the hospital.");
    await page.goBack();
    await expect(page.locator("#wireSearch")).toHaveValue(query);
    await expect(page.locator("#wireSearchResults button").first()).toBeFocused();
    const cases = [["context", "subsequent medical", "#request"], ["reply", "lab results", "#request"],
        ["action", "GET /me/calendarView 403", "layer=http"], ["tool", "workiq-fet", "tool=workiq-fetch"],
        ["service", "Calendar", "services=Calendar"], ["view", "Recorded timing", "#analyze"],
        ["setting", "Theme", "setting=theme"]];
    for (const [type, query, destination] of cases) {
        const rows = await find(page, query, type);
        await expect(rows.first()).toBeVisible();
        await rows.first().click();
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
        await expect(page).toHaveURL(new RegExp(destination));
        if (type === "action") await expect(page.locator("#selectedCall")).toBeVisible();
        if (type === "setting") await expect(page.locator("#themePreference")).toHaveAttribute("aria-checked", "false");
        await page.goBack();
        await expect(page.locator("#wireSearch")).toHaveValue(query);
    }
    await find(page, "GET /me/calendarView 599", "action");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await find(page, "physician", "report");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(4);
    const priorIndex = (await (await app.api("/api/search/status")).json()).indexId;
    const began = performance.now();
    await page.locator("#wireSearch").fill("Saved");
    await page.locator("#wireSearch").pressSequentially(" report", { delay: 140 });
    await expect(page.locator("#wireSearchStatus")).toHaveText("4 matches");
    const typedStatus = await (await app.api("/api/search/status")).json();
    assert.equal(typedStatus.indexId, priorIndex, "Normal typed PDF path reuses the current index");
    t.diagnostic(JSON.stringify({ typedWallMs: performance.now() - began, gatedMetrics: typedStatus.metrics,
        items: typedStatus.items, chunks: typedStatus.chunks }));
    for (const [index, kind] of ["html", "json", "markdown", "pdf"].entries()) {
        const row = page.locator(`#wireSearchResults button[data-search-bundle="${bundles[index].bundleId}"]`);
        const download = kind === "pdf" ? page.waitForEvent("download") : null;
        await row.click();
        const dialog = page.locator(".wire-search-document");
        await expect(dialog).toBeVisible();
        if (kind === "html") await expect(dialog.locator("iframe")).toHaveCount(1);
        if (kind === "json" || kind === "markdown") await expect(dialog.locator("pre")).toContainText("physician");
        if (download) assert.equal((await download).suggestedFilename(), "product-report.pdf");
        await dialog.getByRole("button", { name: "Back to search" }).click();
        await expect(page.locator("#wireSearchResults button")).toHaveCount(4);
    }
    await find(page, "Saved comparison", "comparison");
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator(".wire-search-document")).toContainText("Saved comparison");
    await page.goBack();
    const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), history.state]));
    assert.doesNotMatch(storage, /doctor cared|physician|lab results|GET \/me|workiq-fet/);
    assert.ok(app.requests.every(request => !request.url.includes("physician") && !request.url.includes("doctor")));
    const readRoutes = ["/api/snapshot", "/api/analytics", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/assessment/consent", "/api/assessment/evidence", "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        "/api/search/events", "/api/search/query", "/api/search/open", "/api/search/status", "/api/session"];
    assert.deepEqual(app.requests.filter(request => request.method !== "GET" && !readRoutes.includes(new URL(request.url).pathname)), []);
    assert.deepEqual(app.errors, []);
    const after = await loadBoardState(context);
    for (const key of ["evidence", "exports", "cards", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
});

test("one explicit reconnect recovers an expired stream and polling failures erase prior hits", { timeout: 60000 }, async t => {
    const { page, api, errors } = await setup(t);
    await find(page, "physician", "interaction");
    assert.equal((await api("/api/session/release")).status(), 200);
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1, { timeout: 30000 });
    await page.route("**/api/collection/status", route => route.abort("connectionrefused"));
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    assert.deepEqual(errors, []);
});

test("missing and corrupt assets are visibly degraded, without downloads during typing", { timeout: 30000 }, async t => {
    for (const kind of ["missing", "corrupt"]) {
        const { page, root, runtime, requests, api } = await setup(t, { search: root => ({ modelDirectory: path.join(root, kind) }) });
        if (kind === "corrupt") {
            await mkdir(path.join(root, kind));
            await writeFile(path.join(root, kind, "config.json"), "{}");
        }
        await find(page, "physician", "interaction");
        await expect(page.locator("#wireSearchCoverage")).toHaveText(/Word search only\./);
        assert.equal((await (await api("/api/search/status")).json()).model.code, `model-${kind}`);
        await expect(page.locator("#wireSearchPanel")).not.toContainText(`model-${kind}`);
        assert.ok(requests.every(request => new URL(request.url).origin === new URL(runtime.url).origin));
    }
});

test("a tampered saved copy refuses opening and leaves an explicit search retry", { timeout: 30000 }, async t => {
    const { page, bundles, errors } = await setup(t, { formats: ["json"] });
    await find(page, "physician", "report");
    await appendFile(bundles[0].files["product-report.json"], "\n");
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator(".wire-search-document")).toHaveCount(0);
    await expect(page.locator("#wireSearchStatus")).toContainText("changed");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    assert.deepEqual(errors, []);
});

test("partial searchable coverage blocks only current-view reports, preserving hidden Selected and All", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { reply: false });
    await page.locator("#activityList .request-row input").nth(1).check();
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill("A doctor cared for somebody who was hurt.");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Partial searchable coverage");
    await expect(page.locator("#homeView")).toBeHidden();
    await expect(page.locator("#activityView")).toBeHidden();
    await page.locator('nav [data-nav="reports"]').click();
    await chooseReportScope(page, "current");
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await expect(page.locator("#scopeCount-current")).toHaveText("Count unavailable");
    await expect(page.locator("#reportPromptAuthorSummary")).toContainText("counts are unavailable");
    await chooseReportScope(page, "selected");
    await expect(page.locator("#exportBtn")).toBeEnabled();
    await expect(page.locator("#previewSelectionSummary")).toContainText("1 request group");
    await expect(page.locator("#reportMatchingContext")).toBeHidden();
    await chooseReportScope(page, "all");
    await expect(page.locator("#exportBtn")).toBeEnabled();
    await expect(page.locator("#previewSelectionSummary")).toContainText("3 request groups");
});

for (const [name, query, hits] of [["nonempty", "physician", 1], ["empty", "NONEXISTENT_MATCH_77319", 0]]) {
    test(`correction: partial ${name} matches never display analytical populations`, { timeout: 30000 }, async t => {
        const { page } = await setup(t, { reply: false });
        await page.locator("#openAnalysisSearch").click();
        await page.locator("#wireSearch").fill(query);
        await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Partial searchable coverage");
        await expect(page.locator("#wireSearchResults button")).toHaveCount(hits);
        for (const id of ["homeView", "activityView", "periodFeedback", "sessionAnalysis"]) {
            await expect(page.locator("#" + id)).toBeHidden();
        }
        await selectActivityOption(page, "dateFilter", "custom");
        await expect(page.locator("#homeView")).toBeHidden();
        await expect(page.locator("#activityView")).toBeHidden();
        await expect(page.locator("#outcomeFilter")).toHaveAttribute("data-all-label", "All results (counts unavailable)");
        await expect(page.locator("#scopeCount-current")).toHaveText("Count unavailable");
    });
}

test("correction: legacy phrase intersects semantic membership and survives removal and Back", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const sentBodies = [];
    page.on("request", request => { if (request.method() === "POST") sentBodies.push(request.postData()); });
    await page.evaluate(() => {
        history.replaceState({ ...history.state, evidenceView: { ...history.state.evidenceView, search: "physician" } }, "");
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await expect(page.locator("#activityCount")).toHaveText("1");
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill("mechanic");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await page.getByRole("button", { name: "Remove private search", exact: true }).click();
    await expect(page.locator("#activityCount")).toHaveText("1");
    await page.goBack();
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.getByRole("button", { name: "Remove private search", exact: true })).toBeVisible();
    await expect(page.locator("#wireSearch")).toHaveValue("mechanic");
    const stored = await page.evaluate(() => history.state.evidenceView.search);
    assert.equal(stored, "physician");
    assert.doesNotMatch(JSON.stringify(sentBodies), /physician/);
});

test("correction: page-two cross-layer action Back retains result page and focus through delayed scope read", { timeout: 60000 }, async t => {
    const records = searchRecords(24);
    for (const record of records) record.httpRecords[0].status = 403;
    const { page } = await setup(t, { records });
    let delaySnapshot = false;
    await page.route("**/api/snapshot", async route => {
        if (!delaySnapshot) return route.continue();
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 400));
        await route.fulfill({ response });
    });
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill("GET /me/calendarView 403");
    await expect(page.locator("#wireSearchStatus")).toHaveText("24 matches", { timeout: 30000 });
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    const hit = page.locator("#wireSearchResults button").first(), id = await hit.getAttribute("data-search-id");
    await hit.click();
    await expect(page.locator("#selectedCall")).toBeVisible();
    await expect(page).toHaveURL(/layer=http/);
    await page.waitForTimeout(250);
    delaySnapshot = true;
    await page.goBack();
    await expect(page.locator('#workspace[aria-busy="false"]')).toBeVisible();
    await expect(page.locator("#layerFilter")).toHaveValue("tool");
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(page.locator(`#wireSearchResults button[data-search-id="${id}"]`)).toBeFocused();
});

test("scope is explicit, selection is retained, themes and narrow text remain usable", { timeout: 60000 }, async t => {
    const { page, errors } = await setup(t);
    await page.locator("#activityList .request-row input").first().check();
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill("A doctor cared for somebody who was hurt.");
    await expect(page.locator("#homeView")).toBeHidden();
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await expect(page.locator("#activityList .request-row input").first()).toBeChecked();
    const changedScope = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await selectActivityOption(page, "scopeFilter", "all");
    await changedScope;
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches");
    await openSearchFilters(page);
    await page.locator("#wireSearchClear").click();
    await expect(page.locator("#activityCount")).toHaveText("3");
    await expect(page.locator("#activityList .request-row input").first()).toBeChecked();
    await page.locator("#wireSearch").fill("Theme");
    await selectActivityOption(page, "wireSearchScope", "everywhere");
    await find(page, "Theme", "setting");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#wireSearch").focus();
        if (process.env.WIRE_SEARCH_PROOFS) {
            await mkdir(process.env.WIRE_SEARCH_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_PROOFS, `search-${theme}.png`) });
        }
        await page.setViewportSize({ width: 375, height: 812 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await expect(page.locator("#wireSearch")).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(await page.locator(".wire-search-filters label").first().evaluate(node => node.getBoundingClientRect().height < 80),
            "Enhanced select labels must not inherit horizontal flex basis as vertical blank space");
        if (process.env.WIRE_SEARCH_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_PROOFS, `search-${theme}-375-text200.png`) });
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await page.setViewportSize({ width: 1280, height: 900 });
    }
    assert.deepEqual(errors, []);
});

test("two visible panels clear on revocation, artifact deletion and source replacement; reconnect never resurrects hits", { timeout: 120000 }, async t => {
    const { page, runtime, context, root, bundles, config, errors } = await setup(t, { formats: ["json"] });
    const otherContext = await page.context().browser().newContext();
    const other = await otherContext.newPage();
    await other.goto(runtime.url);
    await expect(other.locator('#workspace[aria-busy="false"]')).toBeVisible();
    await find(page, "lab results", "reply");
    await find(other, "lab results", "reply");
    assert.equal(runtime.search.status().panels, 2);
    await page.locator("#wireSearchResults button").first().click();
    await expect(page.locator("#requestContent")).toContainText("The lab results show a steady recovery.");
    const actor = await streamPanel(runtime);
    assert.equal(actor.response.status, 429);
    const state = await loadBoardState(context), source = runtime.collector.assessmentSource(state);
    const revoked = await actor.api("/api/assessment/consent/set", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: state.personalEvaluation.consent.revision,
        policyVersion: 1, enabled: false, categories: [], sourceConfigRef: source.sourceConfigRef,
        sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    });
    assert.equal(revoked.code, 200);
    await expect(page.locator("#requestContent")).toContainText("search destination is no longer current");
    await expect(page.locator("#requestContent")).not.toContainText("The lab results");
    for (const current of [page, other]) {
        await expect(current.locator("#wireSearchResults button")).toHaveCount(0);
        await expect(current.locator("#wireSearchStatus")).toHaveText("Saved content changed. Search again.");
        await find(current, "lab results", "reply");
        await expect(current.locator("#wireSearchResults button")).toHaveCount(0);
        await expect(current.locator("#wireSearchCoverage")).toContainText("Some saved content is unavailable");
        await find(current, "physician", "report");
        await expect(current.locator("#wireSearchResults button")).toHaveCount(1);
    }
    const removal = await actor.api("/api/artifact-deletion/preview", { artifactKind: "report", artifactId: bundles[0].bundleId });
    assert.equal(removal.code, 200);
    const removed = await actor.api("/api/artifact-deletion/confirm", { operationId: removal.body.operationId, confirmed: true });
    assert.equal(removed.code, 200);
    for (const current of [page, other]) {
        await expect(current.locator("#wireSearchResults button")).toHaveCount(0);
        await find(current, "physician", "report");
        await expect(current.locator("#wireSearchResults button")).toHaveCount(0);
        await find(current, "physician", "interaction");
    }
    await mkdir(path.join(root, "replacement"));
    const database = path.join(root, "replacement", "data.db"), db = new DatabaseSync(database);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.close();
    const changed = await actor.api("/api/collection/configure", { appDbPath: database, sessionRoot: config.sessionRoot,
        approved: true, enabled: false, windowDays: 30, pollSeconds: 60 });
    assert.equal(changed.code, 200, changed.body.error);
    for (const current of [page, other]) await expect(current.locator("#wireSearchResults button")).toHaveCount(0);
    await runtime.search.close();
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    actor.close();
    assert.deepEqual(errors, []);
});

test("complete semantic analytical membership is independent of navigation paging", { timeout: 60000 }, async t => {
    const { page } = await setup(t, { records: searchRecords(63) });
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill("A doctor cared for somebody who was hurt.");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches", { timeout: 30000 });
    await expect(page.locator("#wireSearchResults button")).toHaveCount(20);
    await expect(page.locator("#activityCount")).toHaveText("21");
    await page.getByRole("button", { name: "Next results", exact: true }).click();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await expect(page.locator("#activityCount")).toHaveText("21");
    const id = await page.locator("#wireSearchResults button").getAttribute("data-search-id");
    await page.locator("#wireSearchResults button").click();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#wireSearchPaging")).toContainText("Page 2 of 2");
    await expect(page.locator(`#wireSearchResults button[data-search-id="${id}"]`)).toBeFocused();
});

function jointRecords() {
    return searchRecords(6).map((record, index) => {
        const date = index < 3 ? "2026-09-30" : "2026-10-01";
        record.capturedAt = `${date}T12:00:00.000Z`;
        record.sourceSessionId = `joint-session-${index}`;
        record.sourceSessionName = `${[0, 3].includes(index) ? "cedar" : "maple"} cohort ${index}`;
        record.userPrompt.text = [0, 1, 3, 4].includes(index)
            ? "The physician treated an injured patient in the hospital."
            : "The mechanic repaired a broken automobile in the garage.";
        record.userPrompt.sourceEventId = `joint-prompt-${index}`;
        record.userPrompt.sourceTimestamp = record.capturedAt;
        record.followUpPrompts = [];
        record.httpRecords = [];
        const original = record.toolCalls[0];
        record.toolCalls = [0, 1].map(offset => ({
            ...structuredClone(original),
            toolCallId: `joint-call-${index}-${offset}`, startEventId: `joint-start-${index}-${offset}`,
            completionEventId: `joint-end-${index}-${offset}`,
            startedAt: record.capturedAt, completedAt: `${date}T12:00:01.000Z`, durationMs: 1000,
            requestArgs: { entityUrls: [offset ? "/me/messages" : "/me/calendarView"] },
            toolSucceeded: offset === 1, reportedOutcome: offset ? "succeeded" : "failed",
            apiResults: offset ? [{ index: 0, path: "/me/messages", statusCode: 200 }]
                : [{ index: 0, path: "/me/calendarView", statusCode: 403 }, { index: 1, path: "/me/calendarView", statusCode: 200 }],
        }));
        return record;
    });
}
async function jointSearch(page, query, layer = "tool") {
    await page.evaluate(layer => {
        const hash = `#analyze?layer=${layer}&range=custom&from=2026-09-30&to=2026-09-30`;
        history.replaceState({ ...history.state, evidenceView: { url: hash, search: "cedar cohort" } }, "", hash);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, layer);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#openAnalysisSearch").click();
    await page.locator("#wireSearch").fill(query);
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Current search matches", { timeout: 30000 });
}
async function compareJointPeriods(page) {
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [
        ["Period A from", "2026-09-30"], ["Period A to", "2026-09-30"],
        ["Period B from", "2026-10-01"], ["Period B to", "2026-10-01"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    const response = page.waitForResponse(value => value.url().endsWith("/api/period-comparison"));
    await page.locator("#applyPeriodComparison").click();
    const result = await response, value = await result.json();
    assert.equal(result.status(), 200, value.error);
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    return { value, input: result.request().postDataJSON() };
}

test("joint: real meaning and legacy scope span both periods through Review Save and verified frozen search reopen", { timeout: 90000 }, async t => {
    const app = await setup(t, { records: jointRecords() }), { page, runtime, context } = app;
    const sent = [];
    page.on("request", request => { if (request.method() === "POST") sent.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    let admissions = 0;
    const membership = runtime.search.membership;
    runtime.search.membership = (...args) => { admissions++; return membership(...args); };
    const query = "A doctor cared for somebody who was hurt.";
    await jointSearch(page, query);
    await expect(page.locator("#activityCount")).toHaveText("2");
    assert.equal((await (await app.api("/api/search/status")).json()).mode, "hybrid");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const { value, input } = await compareJointPeriods(page);
    assert.equal(input.semanticSelection.receipt.mode, "hybrid");
    assert.deepEqual(input.semanticSelection.withinScenarioIds, ["search-0", "search-3"]);
    assert.equal(input.scenarioIds, undefined);
    assert.equal(input.options.filters.from, undefined);
    assert.equal(input.options.filters.to, undefined);
    assert.deepEqual(value.periods.baseline.scenarioIds, ["search-0"]);
    assert.deepEqual(value.periods.later.scenarioIds, ["search-3"]);
    assert.equal(value.periods.baseline.rowIds.length, 2);
    assert.equal(value.periods.later.rowIds.length, 2);
    assert.equal(admissions, 1);
    await expect(page.locator("#comparisonSearch")).toBeHidden();
    await expect(page.locator('input[type=search]:visible')).toHaveCount(1);
    await page.getByRole("button", { name: "Search this comparison", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.getByLabel("Period A from", { exact: true })).toHaveValue("2026-09-30");
    await expect(page.getByLabel("Period B to", { exact: true })).toHaveValue("2026-10-01");
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    assert.equal(admissions, 1);
    if (process.env.WIRE_SEARCH_PROOFS) {
        await openSearchFilters(page);
        await page.locator("#wireSearch").press("Escape");
        await page.locator("#periodComparisonTitle").evaluate(node => node.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_PROOFS, "joint-periods.png") });
    }
    await page.locator("#createPeriodReport").click();
    await expect(page.locator("#periodReportScope")).toContainText("Period B");
    await page.locator("#formatOptions input[value=json]").check();
    await page.locator('[name=promptMode][value=none]').check();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await preparing).json();
    assert.equal(preview.error, undefined, preview.error);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
    assert.equal(preview.snapshot.periodComparison.selection.withinScenarioRefs.length, 2);
    assert.doesNotMatch(JSON.stringify(preview.snapshot.periodComparison), /cedar cohort|A doctor cared|panelId|requestId|indexId/);
    assert.equal(admissions, 2);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.locator("#wireSearch").focus();
    const clear = page.waitForResponse(response => response.url().endsWith("/api/search/query") && response.request().postDataJSON().query === "");
    await openSearchFilters(page);
    await page.locator("#wireSearchClear").click();
    await clear;
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const saving = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    const saved = await (await saving).json();
    assert.equal(saved.error, undefined, saved.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal(admissions, 2, "A legitimate frozen preview must not re-resolve the cleared live receipt at Review/Save");
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 1);
    const artifact = state.exports[0];
    assert.equal(artifact.reportType, "period-comparison");
    const bytes = new Map(await Promise.all(Object.entries(artifact.files).map(async ([name, file]) => [name, await readFile(file)])));
    const json = await readSavedReportFile(context, state, artifact.bundleId, "json");
    assert.deepEqual(json.snapshot.periodComparison.comparison, value.comparison);
    await page.locator("#wireSearch").fill("Period A");
    await selectActivityOption(page, "wireSearchScope", "everywhere");
    await find(page, "Period A", "report");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1);
    await page.locator("#wireSearchResults button").click();
    await expect(page.locator(".wire-search-document")).toBeVisible();
    await expect(page.frameLocator(".wire-search-document iframe").getByRole("heading", { name: /Retained-period comparison report/ })).toBeVisible();
    if (process.env.WIRE_SEARCH_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_PROOFS, "joint-frozen.png") });
    await page.getByRole("button", { name: "Back to search", exact: true }).click();
    await expect(page.locator("#wireSearch")).toHaveValue("Period A");
    await expect(page.locator("#wireSearchResults button")).toBeFocused();
    for (const [name, file] of Object.entries(artifact.files)) assert.deepEqual(await readFile(file), bytes.get(name));
    assert.equal(sent.filter(request => request.path === "/api/export").length, 1);
    assert.doesNotMatch(JSON.stringify(sent), /cedar cohort/);
    assert.deepEqual(app.errors, []);
});

test("joint: exact action receipt keeps broad API parents and a stale fence blocks the paired consumer", { timeout: 60000 }, async t => {
    const { page, api, context, errors } = await setup(t, { records: jointRecords() });
    await jointSearch(page, "/me/calendarView 403", "reported-api");
    const { value } = await compareJointPeriods(page);
    assert.deepEqual(value.selection.semanticMembership.scenarioIds, []);
    for (const [side, id] of [["baseline", "search-0"], ["later", "search-3"]]) {
        assert.deepEqual(value.periods[side].scenarioIds, [id]);
        assert.equal(value.periods[side].rowIds.length, 1);
        assert.equal(value.periods[side].analytics.resultFacet.rows.length, 1);
        assert.equal(value.periods[side].analytics.apiCoverage.eligibleToolCalls, 2);
        assert.equal(value.periods[side].analytics.apiCoverage.returnedResultUnits, 3);
    }
    const exact = page.locator('[data-period-side="later"] details').filter({ has: page.getByText("Exact matching records (1)", { exact: true }) });
    await exact.locator("summary").click();
    await exact.locator("a").click();
    await expect(page.locator("#selectedCall")).toBeVisible();
    const backRead = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
    await page.goBack();
    const restored = await (await backRead).json();
    assert.deepEqual(restored.periods.baseline.rowIds, value.periods.baseline.rowIds);
    assert.deepEqual(restored.selection.withinScenarioIds, ["search-0", "search-3"]);
    await expect(page.getByLabel("Period B to", { exact: true })).toHaveValue("2026-10-01");
    await expect(page.locator("#wireSearch")).toHaveValue("/me/calendarView 403");
    await expect(exact).toHaveAttribute("open", "");
    await expect(exact.locator("a")).toBeFocused();
    await page.locator("#periodComparisonTitle").focus();
    assert.equal((await api("/api/move", { scenarioId: "search-5", toState: "reviewing" })).status(), 200);
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await expect(page.locator("#wireSearch")).toHaveValue("/me/calendarView 403");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.locator("#wireSearch").focus();
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled({ timeout: 15000 });
    await page.locator("#createPeriodReport").click();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await preparing).json();
    assert.equal(preview.error, undefined, preview.error);
    assert.equal(preview.snapshot.periodComparison.periods.baseline.rows.length, 1);
    assert.equal(preview.snapshot.periodComparison.periods.baseline.apiCoverage.calls.length, 2);
    assert.deepEqual(errors, []);
});

test("joint: partial search cannot dispatch a complete paired population or enable its report", { timeout: 30000 }, async t => {
    const { page, context, requests } = await setup(t, { records: jointRecords(), reply: false });
    await page.locator("#comparePeriods").click();
    await page.locator("#wireSearch").focus();
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Partial searchable coverage");
    for (const [label, value] of [
        ["Period A from", "2026-09-30"], ["Period A to", "2026-09-30"],
        ["Period B from", "2026-10-01"], ["Period B to", "2026-10-01"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Search cannot provide a complete current selection");
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    assert.equal(requests.some(request => new URL(request.url).pathname === "/api/period-comparison"), false);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("joint: absent openSearch callback preserves the standalone legacy field", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent("<select id='outcomeFilter'><option value='success'>Worked</option></select><button id='toggle'>Compare</button><section id='comparison'></section>");
    await page.evaluate(async source => {
        const mount = (0, eval)("(" + source + ")");
        const context = { route: { view: "analyze", compare: "periods" }, search: "legacy phrase",
            options: { layer: "tool", filters: {}, timeContext: { timeZone: "UTC", locale: "en-US" } },
            snapshot: { revision: 1, scenarios: [] }, isLoading: false, isStale: false };
        const component = mount({
            root: document.getElementById("comparison"), toggle: document.getElementById("toggle"),
            getContext: () => context, time: { label: () => "UTC" }, results: { labels: () => ({ success: "Worked" }) },
            onSearch: value => { window.legacySearchValue = value; },
            api: () => { throw new Error("No request expected without periods."); }, navigate: () => {},
            syncFilters: () => {}, bindDetails: value => value,
        });

        await component.update();
    }, mountPeriodComparison.toString());
    await expect(page.locator("#comparisonSearch")).toBeVisible();
    await expect(page.locator("#comparisonSearch")).toHaveValue("legacy phrase");
    await page.locator("#comparisonSearch").fill("edited legacy phrase");
    assert.equal(await page.evaluate(() => window.legacySearchValue), "edited legacy phrase");
    await expect(page.getByRole("button", { name: "Search this comparison", exact: true })).toHaveCount(0);
});

test("frozen-reader: search opens actual historical comparison HTML and JSON-only bytes without corruption fallback", { timeout: 60000 }, async t => {
    const app = await setup(t, { formats: ["json", "json"] }), { page, context, api, errors } = app;
    const html = await saveSearchComparison(app, ["html", "json"]), json = await saveSearchComparison(app, ["json"]);
    const marker = "Invented frozen layout note, absent from the current comparison renderer.";
    const htmlPath = html.files["comparison-report.html"], manifestPath = html.files["coverage-and-redaction-manifest.json"];
    const original = await readFile(htmlPath, "utf8");
    const frozen = original.replace("</body>", `<p id="frozen-layout-proof">${marker}</p></body>`);
    assert.notEqual(frozen, original);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["comparison-report.html"] = { sha256: reportHash(frozen), bytes: Buffer.byteLength(frozen) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(htmlPath, frozen);
    await writeFile(manifestPath, manifestBytes);
    await updateBoardState(context, state => { state.exports.find(entry => entry.bundleId === html.bundleId).manifestHash = reportHash(manifestBytes); });
    const structured = await readSavedComparison(context, await loadBoardState(context), html.bundleId);
    assert.equal(JSON.stringify(structured.comparison).includes(marker), false, "Current structured rendering cannot recreate this frozen note");
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await find(page, "Saved comparison", "comparison");
    const beforeRead = await (await api("/api/search/status")).json();
    const response = await api("/api/artifact-file", { kind: "comparison", bundleId: html.bundleId, format: "html" });
    assert.equal(response.status(), 200);
    const file = await response.json();
    assert.equal(Buffer.from(file.data, "base64").toString("utf8"), frozen);
    assert.equal(file.sha256, reportHash(frozen));
    assert.equal((await (await api("/api/search/status")).json()).indexId, beforeRead.indexId, "A verified file read is not a mutation fence");
    await page.locator(`#wireSearchResults button[data-search-bundle="${html.bundleId}"]`).click();
    await expect(page.getByRole("dialog", { name: "Saved comparison", exact: true })).toBeVisible();
    await expect(page.frameLocator(".wire-search-document iframe").locator("#frozen-layout-proof")).toHaveText(marker);
    assert.equal(await readFile(htmlPath, "utf8"), frozen);
    if (process.env.WIRE_SEARCH_PROOFS) {
        await page.frameLocator(".wire-search-document iframe").locator("#frozen-layout-proof").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.WIRE_SEARCH_PROOFS, "frozen-comparison-html.png") });
    }
    await page.getByRole("button", { name: "Back to search", exact: true }).click();
    await expect(page.locator(`#wireSearchResults button[data-search-bundle="${html.bundleId}"]`)).toBeFocused();
    await page.locator(`#wireSearchResults button[data-search-bundle="${json.bundleId}"]`).click();
    const jsonBytes = await readFile(json.files["comparison-report.json"], "utf8");
    await expect(page.locator(".wire-search-document pre")).toHaveText(jsonBytes);
    assert.equal(await page.locator(".wire-search-document pre").textContent(), jsonBytes);
    await expect(page.locator(".wire-search-document iframe")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to search", exact: true }).click();
    await expect(page.locator(`#wireSearchResults button[data-search-bundle="${json.bundleId}"]`)).toBeFocused();
    await appendFile(htmlPath, "\nUnreviewed change");
    assert.equal((await readSavedComparisonFile(context, await loadBoardState(context), html.bundleId, "json")).format, "json");
    await page.locator(`#wireSearchResults button[data-search-bundle="${html.bundleId}"]`).click();
    await expect(page.locator("#wireSearchStatus")).toContainText("file changed");
    await expect(page.locator(".wire-search-document")).toHaveCount(0);
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await unlink(htmlPath);
    await page.locator("#wireSearchRetry").click();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(2);
    await page.locator(`#wireSearchResults button[data-search-bundle="${html.bundleId}"]`).click();
    await expect(page.locator("#wireSearchStatus")).toContainText("no longer available");
    await expect(page.locator(".wire-search-document")).toHaveCount(0);
    assert.deepEqual(errors, []);
});
