import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { searchWireContract as wire } from "../lib/search-wire-contract.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { assessmentOverview, buildAssessmentModel, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { chooseTheme, closeAnalyzeFilters, restoreLegacySearch, selectActivityOption, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";
import { openDatePicker } from "./analytics-date-picker.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { graphMatrixRecord } from "./report-evidence-matrix-fixtures.mjs";

const pairPath = "/api/period-comparison";
const periods = { baseline: { from: "2026-03-07", to: "2026-03-07" }, later: { from: "2026-03-08", to: "2026-03-09" } };
const interaction = i => `period-request-${i}`;
const call = (i, name = `period-call-${i}`) => `call:${JSON.stringify([`period-chat-${i}`, name])}`;
const entry = (i, index = 0) => `result:${JSON.stringify([call(i), index])}`;
const selectedCalls = [2, 3, 4, 5].map(i => call(i));
const qualifiedCalls = [call(0), call(0, "period-missing"), call(1)];
const ready = page => expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
const pairResponse = page => page.waitForResponse(r => new URL(r.url()).pathname === pairPath && r.ok());

// Script only the Search transport boundary: same two hits, complete or partial coverage.
// The real client qualifies the receipt; the real period producer selects and validates the rows.
function searchFixture() {
    const base = { schemaVersion: wire.schemaVersion, panelId: "00000000-0000-4000-8000-000000000002", epoch: 0 };
    let stream, current;
    function emit(event) { stream.write(JSON.stringify({ ...base, ...event }) + "\n"); }
    return {
        attach(input, res) {
            wire.handshake(input); stream = res; current = null;
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            emit({ event: "connected", heartbeatMs: 1000, idleMs: 120000 });
            const beat = setInterval(() => emit({ event: "heartbeat" }), 1000);
            res.once("close", () => { clearInterval(beat); if (stream === res) current = null; });
        },
        query(input, revision) {
            const { purpose, types, requestId, query } = wire.query(input);
            const text = "Invented twin observation", indexId = "1".repeat(64);
            const receipt = { ...base, revision, requestId, indexId, generation: 1, mode: "text",
                queryPurpose: purpose, queryTypes: types, purpose: "strict-match-population", matchPolicyId: wire.matchPolicyId };
            // An action is not permission to include its parent interaction's other calls.
            const hits = !query || !text.startsWith(query) ? [] : [
                ["action", `#request?${new URLSearchParams({ request: interaction(0), call: call(0), layer: "tool" })}`],
                ["interaction", `#request?request=${interaction(2)}`],
            ].map(([type, href]) => ({ type, id: "hit-" + type, revision: "2".repeat(64), title: text,
                source: { label: "Synthetic collection" }, target: { kind: "route", href }, excerpt: text,
                match: "text", textMatch: { field: "title", start: 0, end: query.length, excerptStart: 0 } }));
            const partial = query === text;
            const corpus = { generation: 1, ...(partial ? { state: "partial", issues: [{ code: "source-unavailable", types: ["reply"] }] } : { state: "ready" }) };
            const result = { ...base, event: "results", purpose, requestId, matches: { receipt, hits, total: hits.length }, status: { mode: "text", indexId, corpus } };
            assert.ok(wire.validResults(result)); current = result; emit(result);
        },
        membership(input, snapshot) {
            assert.ok(current && wire.completeCoverage(current.status.corpus, current.matches.receipt.queryTypes));
            assert.ok(wire.sameReceipt(input.semanticSelection.receipt, current.matches.receipt));
            const { scenarioIds, actionIds, parentScenarioIds } = createSearchMembership(snapshot, input.options,
                input.withinServices, current.matches.hits, current.matches.receipt, wire);
            return { scenarioIds, actionIds, parentScenarioIds };
        },
    };
}

async function setup(t, { extraLayers = false, returnedError = false, search } = {}) {
    const { state } = periodFixture();
    // A successful execution can still return an error entry.
    if (returnedError) state.evidence[1].toolCalls[0].apiResults[0].statusCode = 403;
    if (extraLayers) for (const i of [0, 2]) {
        const record = state.evidence[i], startedAt = record.toolCalls[0].startedAt;
        const sites = graphMatrixRecord(record.scenarioId).graphActivities.map(site => ({
            ...site, sourceSessionId: record.sourceSessionId, startedAt,
        }));
        record.graphActivities = [...sites, { ...sites[2], activityId: `reference-${i}`, tool: "script-reference",
            evidenceLevel: "code-reference", sourceKind: "source-reference", requestBasis: "graph-url-reference" }];
        record.httpRecords = [{ recordId: `capture-${i}`, classification: "direct-graph-http", synthetic: false,
            observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", status: i ? 503 : 200,
            startedAt, method: "GET", apiVersion: "v1.0", responsePath: { path: "/me/messages", query: [] } }];
    }
    const before = structuredClone(state), model = buildAssessmentModel(state);
    invalidateAssessmentCache();
    const requests = [], errors = [], denied = [];
    const control = {};
    let snapshot;
    let observed = { state: "paused", config: null, revision: state.revision, assessment: { basis: model.basis } };
    const assets = new Map(await Promise.all([
        ...["assessment-contract", "period-comparison-math", "report-outcome-comparison", "report-metric-comparison",
            "wire-report-metric-adapter", "report-result-contract"].map(name => [`/assets/${name}.mjs`, `../lib/${name}.mjs`]),
        ["/web/recorded-results.mjs", "../web/recorded-results.mjs"],
    ].map(async ([url, file]) => [url, await readFile(new URL(file, import.meta.url), "utf8")])));
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "period-proof", UNBOUND_FIXTURE_BOOTSTRAP)); return;
            }
            if (req.method === "GET" && assets.has(req.url)) {
                res.setHeader("Content-Type", "text/javascript"); res.end(assets.get(req.url)); return;
            }
            if (req.url?.split("?")[0] === "/favicon.svg") { res.statusCode = 204; res.end(); return; }
            let body = ""; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body || "{}");
            requests.push({ route: req.url, input: req.url === "/api/search/query" ? { purpose: input.purpose } : input });
            assert.equal(req.method, "POST");
            let data;
            if (req.url === "/api/snapshot") {
                data = await currentStatePayload({}, state, input);
                data.collection = { state: "paused", config: null, revision: state.revision };
                snapshot = data;
                await control.delaySnapshot?.();
            } else if (req.url === pairPath) {
                if (control.fail) {
                    res.statusCode = 409; data = { error: "The stored revision changed. Read the current Analyze view before comparing again." };
                } else {
                    data = buildPeriodComparison(state, input, input.semanticSelection
                        ? { semanticMembership: search.membership(input, snapshot) } : undefined);
                    control.alter?.(data);
                    await control.delay?.(input);
                }
            } else if (req.url === "/api/assessment/overview") data = { schemaVersion: 1, basis: model.basis, data: assessmentOverview(state, model, input.interactionRefs) };
            else if (req.url === "/api/assessment/detail") data = { schemaVersion: 1, basis: model.basis, data: model.details.get(input.interactionRef) };
            else if (req.url === "/api/collection/status") data = observed;
            else if (req.url === "/api/search/events") {
                if (search) { search.attach(input, res); return; }
                res.statusCode = 503; data = { error: "Invented Search is unavailable." };
            } else if (search && req.url === "/api/search/query") { search.query(input, state.revision); data = {}; }
            else { denied.push(req.url); res.statusCode = 403; data = { error: "Only invented retained-data reads are available." }; }
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
        } catch (error) { errors.push(error.stack); res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
        await browser?.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.deepEqual(state, before);
        assert.doesNotMatch(JSON.stringify(requests), new RegExp(periodQuery));
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    await page.clock.setFixedTime(new Date("2026-03-10T12:00:00Z"));
    await page.goto(url + "#analyze?range=custom&from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, control, requests, pairs: () => requests.filter(r => r.route === pairPath),
        changeBasis() { observed = { ...observed, assessment: { basis: { ...model.basis, consentRevision: model.basis.consentRevision + 1 } } }; } };
}

async function accept(page, action) {
    const response = pairResponse(page);
    await action();
    const value = await (await response).json();
    await ready(page);
    return value;
}
async function enter(page) {
    const pair = await accept(page, () => page.getByRole("link", { name: "Compare", exact: true }).click());
    await expect(page).toHaveURL(/\/compare(?:\?|$)/);
    return pair;
}
async function dateDraft(page, { baseline, later } = periods) {
    const panel = await openDatePicker(page, "compare", "Custom dates");
    for (const [side, range] of [["A", baseline], ["B", later]]) {
        for (const end of ["from", "to"]) await panel.getByLabel(`Period ${side} ${end}`, { exact: true }).fill(range[end]);
    }
    return panel.getByRole("button", { name: "Apply dates", exact: true });
}
async function applyDates(page, ranges) {
    const apply = await dateDraft(page, ranges);
    return accept(page, () => apply.click());
}
async function importAnalyze(page) {
    await page.locator("#openAnalyzeFilters").click();
    const value = await accept(page, () => page.getByRole("button", { name: "Use Analyze view", exact: true }).click());
    await closeAnalyzeFilters(page);
    return value;
}
async function qualified(page) {
    await restoreLegacySearch(page, periodQuery);
    await enter(page); await applyDates(page);
    return importAnalyze(page);
}
async function roster(page, side, ids) {
    await page.locator("#comparisonRecords" + side).click();
    const panel = page.locator("#comparisonExactRecords" + side);
    await expect(panel).toBeVisible();
    const prefix = `comparison-record-${side}-`;
    assert.deepEqual((await panel.locator("tbody a").evaluateAll(links => links.map(a => a.id))).sort(),
        ids.map(id => prefix + id).sort());
    return panel;
}
async function withheld(page) {
    await expect(page.locator("#periodComparisonResults .compare-outcomes, #periodComparisonResults table")).toHaveCount(0);
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
}
async function toggle(page, id, value) {
    await page.locator(`#${id}-control`).click();
    await page.locator(`.select-popup:visible [data-value=${JSON.stringify(value)}]`).click();
}
const back = page => page.getByRole("button", { name: "Back to comparison", exact: true }).click();

test("Compare starts independently; Use Analyze view qualifies both date windows before opening exact calls", async t => {
    const { page, pairs } = await setup(t);
    await restoreLegacySearch(page, periodQuery);
    const origin = page.locator(".request-card-open").filter({ hasText: `${periodQuery} request 0` });
    await origin.click();
    const reader = page.locator("#contextSidebar");
    await expect(reader).toContainText("This historical error does not establish the account's current sign-in state");
    await reader.getByRole("button", { name: "Add to report", exact: true }).click();
    await expect(reader.getByRole("button", { name: "Remove from report" })).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    const fresh = await enter(page);
    assert.deepEqual(fresh.periods.baseline.range, { from: "2026-02-24", to: "2026-03-02" });
    assert.deepEqual(fresh.periods.later.range, { from: "2026-03-03", to: "2026-03-09" });
    assert.equal(fresh.options.filters.services, undefined);
    const prior = pairs().length, apply = await dateDraft(page);
    assert.equal(pairs().length, prior, "Editing both dates is not Apply");
    const unfiltered = await accept(page, () => apply.click());
    assert.deepEqual(unfiltered.periods.baseline.rowIds, [call(0, "period-calendar"), call(0), call(0, "period-missing"), call(1), call(9)]);
    assert.deepEqual(unfiltered.periods.later.rowIds, selectedCalls);
    const pair = await importAnalyze(page);
    assert.deepEqual(pair.selection.scenarioIds, Array.from({ length: 9 }, (_, i) => interaction(i)));
    assert.deepEqual(pair.options.filters.services, ["Files"]);
    assert.equal(pair.options.filters.includeMissingService, true);
    assert.equal(pair.options.filters.from, undefined); assert.equal(pair.options.filters.to, undefined);
    assert.deepEqual(pairs().at(-1).input.periods, periods);
    assert.equal((Date.parse(pair.periods.later.dateRange.to) - Date.parse(pair.periods.later.dateRange.from)) / 3600000, 47);
    for (const [key, ids, origins] of [["baseline", qualifiedCalls, [0, 1]], ["later", selectedCalls, [2, 3, 4, 5]]]) {
        assert.deepEqual(pair.periods[key].rowIds, ids);
        assert.deepEqual(pair.periods[key].scenarioIds, origins.map(interaction));
    }
    await expect(page.locator("#comparisonAcceptedScope")).toContainText("Files");
    assert.ok(!page.url().includes(periodQuery));
    const reads = pairs().length;
    for (const [view, title, expected] of [
        ["Timeline", "Exact timeline values", [
            ["Baseline", "2026-03-07 to 2026-03-07", "3", "3"], ["Selected", "2026-03-08 to 2026-03-08", "2", "4"],
            ["Selected", "2026-03-09 to 2026-03-09", "2", "4"],
        ]],
        ["By tool", "Exact breakdown values", [
            ["Baseline", "workiq-fetch", "2", "3"], ["Baseline", "workiq-ask", "1", "3"], ["Selected", "workiq-fetch", "4", "4"],
        ]],
    ]) {
        await page.getByRole("button", { name: view, exact: true }).click();
        await page.getByRole("button", { name: "View numbers", exact: true }).click();
        const table = page.getByRole("table", { name: title });
        assert.deepEqual(await table.locator("tbody tr").evaluateAll(rows =>
            rows.map(row => [...row.cells].slice(0, 4).map(cell => cell.textContent))), expected);
        await back(page);
    }
    assert.equal(pairs().length, reads);
    await page.locator("#viewComparisonCalls").click();
    await roster(page, "B", selectedCalls);
    const panel = await roster(page, "A", qualifiedCalls);
    await expect(panel).toContainText("Missing-service context: 1 record");
    const target = panel.locator(`[id=${JSON.stringify("comparison-record-A-" + call(1))}]`);
    await target.click();
    await expect(page.locator('#contextSidebar [data-tool-call-id="period-call-1"]').first()).toBeVisible();
    await page.goBack(); await ready(page); await expect(target).toBeFocused();
    await back(page);
    await page.locator('nav [data-nav="analyze"]').click();
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-03-07");
    await origin.click();
    await expect(reader.getByRole("button", { name: "Remove from report" })).toBeVisible();
});

test("Timing separates exact timed calls, zero, missing samples and the full interactions in both themes", async t => {
    const { page, pairs } = await setup(t);
    const pair = await qualified(page), reads = pairs().length;
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const region = page.locator(".compare-latency"), rows = region.locator("tbody tr");
    await expect(region.locator("tbody th")).toHaveText(["Typical call (median)", "95% finished within", "Calls with timing"]);
    for (const [theme, width, scale] of [["light", 1365, 1], ["dark", 1365, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width: 1365, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await expect(rows.nth(0).locator(".compare-number")).toHaveText(["0 ms", "3,000 ms (3 s)"]);
        await expect(rows.nth(1).locator(".compare-number")).toHaveText(["1,000 ms (1 s)", "5,000 ms (5 s)"]);
        await expect(rows.nth(2).locator(".compare-number")).toHaveText(["2 of 3", "2 of 4"]);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await expect(page.locator(".compare-full-timing")).toContainText("3 of 4 calls");
    await expect(page.locator(".compare-full-timing")).toContainText("8,000 ms");
    assert.equal(pair.comparison.matchingCallTiming.median.delta.value, 3000);
    // F13's review cards, review coverage and verdict disclosures were retired, not lost timing.
    // See ai-review-retirement.test.mjs (current facts) and all-interface-retirement.browser.test.mjs.
    assert.ok(pair.comparison.metrics.length > 0);
    assert.ok(pair.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    await expect(page.locator("#periodComparisonResults")).not.toContainText(/saved reviews?|personal feedback|tool use vs\. request/i);
    await rows.first().getByRole("button").first().click();
    const timed = await roster(page, "A", [call(0), call(1)]);
    await expect(timed.locator("thead")).toContainText("Latency");
    assert.equal(pairs().length, reads);
});

test("returned-entry failures and tool failures have separate units, IDs, parent coverage and timing", async t => {
    const { page } = await setup(t, { returnedError: true });
    const tools = await qualified(page);
    assert.deepEqual(tools.periods.baseline.changeSummary.issueRowIds, [call(0), call(1)]);
    await expect(page.locator(".compare-changes tr").filter({ hasText: "Failed tool calls" }).locator("td").first()).toHaveText("1");
    await expect(page.locator(".compare-outcome-row").first()).toContainText("2 calls returned errors");
    await page.locator("#viewComparisonCalls").click();
    const selected = await roster(page, "B", selectedCalls);
    await selected.locator(`[id=${JSON.stringify("comparison-record-B-" + call(2))}]`).click();
    await expect(page.locator("#contextSidebar")).toContainText("No failure reason was saved");
    await expect(page.locator("#contextSidebar")).toContainText("HTTP 503 alone does not identify the cause");
    await page.locator("#closeContextSidebar").click(); await ready(page); await back(page);
    await page.locator("#openAnalyzeFilters").click();
    const api = await accept(page, () => selectActivityOption(page, "layerFilter", "reported-api"));
    await closeAnalyzeFilters(page);
    assert.equal(api.definitions.layer, "reported-api");
    assert.deepEqual(api.periods.baseline.rowIds, [entry(0), entry(1)]);
    assert.deepEqual(api.periods.later.rowIds, [2, 3, 4, 5].map(i => entry(i)));
    await page.locator("#viewComparisonCalls").click();
    const panel = await roster(page, "A", [entry(0), entry(1)]);
    await expect(panel).toContainText("2 matching returned entries; 3 parent calls before outcome/path filters");
    assert.deepEqual(api.periods.baseline.analytics.rows.map(r => [r.id, r.status]), [[entry(0), 503], [entry(1), 403]]);
    await roster(page, "B", [2, 3, 4, 5].map(i => entry(i)));
    await back(page);
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    await expect(page.locator(".compare-latency")).toContainText("Unavailable for this evidence layer");
    assert.equal(api.comparison.matchingCallTiming, null);
});

test("a paired read failure retires results and facet counts; retry keeps the author refinement", async t => {
    const { page, control } = await setup(t); await qualified(page);
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator('#outcomeFilter option[value="failure"]')).toContainText("A: 1; B: 1");
    control.fail = true;
    await toggle(page, "promptAuthorFilter", "agent");
    await expect(page.locator("#periodComparisonStatus")).toContainText("stored revision changed");
    await withheld(page);
    await expect(page.locator("#outcomeFilter")).not.toContainText("A:");
    control.fail = false;
    await closeAnalyzeFilters(page);
    const pair = await accept(page, () => page.getByRole("button", { name: "Retry comparison read" }).click());
    assert.deepEqual(pair.options.filters.promptAuthors, ["user", "unknown"]);
    assert.deepEqual(pair.periods.baseline.rowIds, [call(0), call(0, "period-missing")]);
    assert.deepEqual(pair.periods.later.rowIds, [call(2), call(4)]);
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator('#outcomeFilter option[value="unknown"]')).toContainText("A: 0; B: 0");
});

test("recorded sites, sites with status, code references and HTTP captures keep their own exact IDs", async t => {
    const { page } = await setup(t, { extraLayers: true }); await enter(page); await applyDates(page);
    const site = (i, id) => `graph-activity:${JSON.stringify([`period-chat-${i}`, id])}`;
    for (const [layer, expected] of [
        ["direct-request", i => [0, 1, 2].map(n => site(i, `${interaction(i)}-activity-${n}`))],
        ["recorded-http", i => [0, 1].map(n => site(i, `${interaction(i)}-activity-${n}`))],
        ["code-reference", i => [site(i, `reference-${i}`)]],
        ["http", i => [`http:${JSON.stringify([`capture-${i}`])}`]],
    ]) {
        await page.locator("#openAnalyzeFilters").click();
        const pair = await accept(page, () => selectActivityOption(page, "layerFilter", layer));
        assert.equal(pair.definitions.layer, layer);
        for (const [key, i] of [["baseline", 0], ["later", 2]]) assert.deepEqual(pair.periods[key].rowIds, expected(i));
        await closeAnalyzeFilters(page);
        await page.locator("#viewComparisonCalls").click();
        await roster(page, "A", expected(0)); await roster(page, "B", expected(2));
        await back(page);
    }
});

test("a late paired read cannot restore older dates, labels, or facet counts over an open choice", async t => {
    const { page, control } = await setup(t); await qualified(page);
    const { promise: gate, resolve: release } = Promise.withResolvers();
    t.after(release);
    control.delay = input => input.periods.later.from === "2026-03-07" ? gate : undefined;
    const aOnly = { baseline: periods.baseline, later: periods.baseline };
    const pending = page.waitForRequest(r => new URL(r.url()).pathname === pairPath);
    await (await dateDraft(page, aOnly)).click(); await pending;
    await withheld(page);
    await applyDates(page);
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    const unknown = page.locator('.select-popup:visible [data-value="unknown"]');
    await expect(unknown).toContainText("A: 0; B: 1");
    const late = pairResponse(page);
    release(); await (await late).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(unknown).toBeVisible(); await expect(unknown).toContainText("A: 0; B: 1");
    await page.keyboard.press("Escape"); await closeAnalyzeFilters(page);
    await expect(page.locator('[data-edit-period="b"]')).toHaveAccessibleName(/Mar 8.*9/);
    await page.locator("#viewComparisonCalls").click(); await roster(page, "B", selectedCalls);
});

test("an unchanged snapshot reread invalidates the in-flight pair until a fresh read", async t => {
    const { page, control } = await setup(t); await qualified(page);
    const old = Promise.withResolvers(), snapshot = Promise.withResolvers();
    t.after(() => { old.resolve(); snapshot.resolve(); });
    control.delay = () => old.promise;
    const requested = page.waitForRequest(r => new URL(r.url()).pathname === pairPath);
    await (await dateDraft(page)).click(); await requested;
    control.delaySnapshot = () => snapshot.promise;
    const reread = page.waitForRequest(r => r.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await reread;
    await expect(page.locator("#periodComparisonStatus")).toContainText("updating or stale");
    const late = pairResponse(page); old.resolve(); await (await late).finished();
    await withheld(page);
    delete control.delay; delete control.delaySnapshot;
    const recovered = await accept(page, () => snapshot.resolve());
    assert.deepEqual(recovered.periods.baseline.rowIds, qualifiedCalls);
    await page.locator("#viewComparisonCalls").click(); await roster(page, "A", qualifiedCalls);
});

test("a changed permission basis withdraws the pair while the focused snapshot stays deferred", async t => {
    const { page, requests, changeBasis } = await setup(t); await qualified(page);
    const snapshots = () => requests.filter(r => r.route === "/api/snapshot").length;
    await page.locator("#comparisonDates").focus();
    const n = snapshots(); changeBasis();
    await expect(page.locator("#periodComparisonStatus")).toContainText("permission changed", { timeout: 15000 });
    await withheld(page); assert.equal(snapshots(), n);
});

test("inconsistent derived facts and impossible facet totals are separately refused before retry", async t => {
    const { page, control } = await setup(t); await qualified(page);
    const retry = page.getByRole("button", { name: "Retry comparison read" });
    control.alter = value => { value.comparison.outcomes.change.success = 1; };
    await (await dateDraft(page)).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparison facts do not match");
    await withheld(page);
    control.alter = value => { value.periods.baseline.analytics.resultFacet.totals.count = -1; };
    const corrupt = pairResponse(page);
    await retry.click(); assert.equal((await (await corrupt).json()).periods.baseline.analytics.resultFacet.totals.count, -1);
    await expect(page.locator("#periodComparisonStatus")).toContainText("Comparison facts do not match");
    await withheld(page); await expect(page.locator("#outcomeFilter")).not.toContainText(/A:|-1/);
    delete control.alter;
    await accept(page, () => retry.click());
    await page.locator("#viewComparisonCalls").click();
    await roster(page, "A", qualifiedCalls); await roster(page, "B", selectedCalls);
});

test("known empty dates and unavailable analytical Search never borrow another population", async t => {
    const { page, pairs } = await setup(t); await qualified(page);
    const empty = { from: "2025-03-08", to: "2025-03-09" };
    const one = await applyDates(page, { baseline: empty, later: periods.later });
    assert.deepEqual(one.periods.baseline.rowIds, []); assert.deepEqual(one.periods.later.rowIds, selectedCalls);
    await expect(page.locator(".compare-changes")).toContainText("No baseline percentage to compare");
    const both = await applyDates(page, { baseline: empty, later: empty });
    assert.deepEqual(both.periods.later.rowIds, []); assert.deepEqual(both.periods.baseline.rowIds, []);
    await expect(page.locator("#periodComparisonResults")).toContainText("No calls match either period");
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await applyDates(page);
    const reads = pairs().length;
    await page.locator("#wireSearch").fill("invented lookup");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status");
    await withheld(page); assert.equal(pairs().length, reads);
});

test("only a complete analytical Search qualifies an exact action and interaction across the pair", async t => {
    const { page, pairs } = await setup(t, { search: searchFixture() });
    await enter(page); await applyDates(page);
    const reads = pairs().length, field = page.locator("#wireSearch");
    const nav = page.waitForResponse(r => r.url().endsWith("/api/search/query") && r.request().postDataJSON().purpose === "navigation");
    await field.fill("Invented twin"); await nav;
    assert.equal(pairs().length, reads, "Navigation hits do not narrow Compare");
    const pair = await accept(page, () => selectActivityOption(page, "wireSearchScope", "analysis"));
    assert.deepEqual(pair.selection.semanticMembership, {
        scenarioIds: [interaction(2)], actionIds: [call(0)], parentScenarioIds: [interaction(0), interaction(2)],
    });
    assert.deepEqual(pair.periods.baseline.rowIds, [call(0)]);
    assert.deepEqual(pair.periods.later.rowIds, [call(2)]);
    const input = pairs().at(-1).input;
    assert.ok(wire.analysisReceipt(input.semanticSelection.receipt));
    assert.equal(input.scenarioIds, undefined);
    assert.doesNotMatch(JSON.stringify(input) + page.url() + await page.evaluate(() => JSON.stringify(history.state)), /Invented twin/i);
    await field.press("Escape");
    await expect(page.locator("#comparisonAcceptedScope")).toContainText("Search applied");
    await page.locator("#viewComparisonCalls").click();
    await roster(page, "A", [call(0)]); await roster(page, "B", [call(2)]); await back(page);
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const rows = page.locator(".compare-latency tbody tr");
    await expect(rows.nth(0).locator(".compare-number")).toHaveText(["0 ms", "3,000 ms (3 s)"]);
    await expect(rows.nth(1).locator(".compare-number")).toHaveText(["Not shown (one timing)", "Not shown (one timing)"]);
    await expect(rows.nth(1)).toContainText("Cannot compare");
    const acceptedReads = pairs().length;
    await field.fill("Invented twin observation");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Some saved text could not be searched");
    await withheld(page); assert.equal(pairs().length, acceptedReads, "Partial coverage is neither empty nor all activity");
});
