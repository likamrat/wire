import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters, restoreLegacySearch } from "./helpers.mjs";
import { openDatePicker } from "./analytics-date-picker.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";

const timeout = { timeout: 30000 };
const a = ["2026-03-07", "2026-03-07"], b = ["2026-03-08", "2026-03-09"];
const emptyA = ["2025-03-07", "2025-03-07"], emptyB = ["2025-03-08", "2025-03-09"];
const comparePath = "/api/period-comparison";
const ready = page => expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
const pair = page => page.evaluate(() => window.periodComparisonOwner.acceptedPair());
const lastPublication = page => page.evaluate(() => window.periodPairEvents.findLast(event => event.kind === "pair"));
const afterPaint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function setup(t, route = "/", { owner = false, preview = false, records = periodFixture().records, locale = "en-US" } = {}) {
    let removeFixture;
    records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const { context } = await privateFixture({ after: cleanup => { removeFixture = cleanup; } }, records);
    const before = await loadBoardState(context), errors = [], denied = [], reads = [];
    const server = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw new Error("Provider denied in comparison experience proof."); },
            readSource() { throw new Error("Source reads denied in comparison experience proof."); },
        },
    });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { await removeFixture(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce", locale });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (new URL(request.url()).pathname === comparePath) reads.push(request.postDataJSON());
    });
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", comparePath, "/api/search/query", "/api/search/status",
            "/api/search/events", "/api/search/cancel", "/api/session", "/api/session/release",
            ...(preview ? ["/api/preview", "/api/cancel-preview", "/api/report-artifacts/list"] : []),
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (owner && url.pathname === "/" && request.method() === "GET") {
            const response = await route.fetch(), html = await response.text();
            const binding = "const periodComparisonUI = assessmentFactories.periodComparison.mount({";
            assert.ok(html.includes(binding), "Observe the real mounted owner, not a second instance");
            return route.fulfill({ response, body: html.replace(binding, `
                window.periodPairEvents = [];
                const periodComparisonUI = window.periodComparisonOwner = ((options) => assessmentFactories.periodComparison.mount({
                    ...options,
                    onPairChange(pair) {
                        options.onPairChange(pair);
                        window.periodPairEvents.push({ kind: "pair", key: pair?.key ?? null,
                            description: analyzeScope.describePair(pair), datesPainted: Boolean(document.querySelector(".compare-period-key")) });
                    },
                    onAccepted() { options.onAccepted(); window.periodPairEvents.push({ kind: "restore" }); },
                }))({`) });
        }
        return route.continue();
    });
    await page.clock.setFixedTime(new Date("2026-03-10T15:00:00Z"));
    await page.goto(new URL(route, server.url).href);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, reads };
}

async function enter(page, key) {
    const link = page.getByRole("link", { name: "Compare", exact: true });
    if (!await link.isVisible()) {
        const menu = page.locator("#navigationToggle");
        if (!key) await menu.click();
        else {
            await menu.press("Enter");
            for (let n = 0; n < 20 && !await link.evaluate(el => el === document.activeElement); n++)
                await page.keyboard.press("Tab");
            await expect(link).toBeFocused();
        }
    } else if (key) await link.focus();
    if (key) {
        // Compare is a link, not the old form button. Space must not navigate.
        const before = page.url();
        await page.keyboard.press("Space");
        assert.equal(page.url(), before); await expect(link).toBeFocused();
        await page.keyboard.press(key);
    }
    else await link.click();
}
async function draft(page, baseline = a, selected = b) {
    const panel = await openDatePicker(page, "compare", "Custom dates");
    for (const [label, value] of [["Period A from", baseline[0]], ["Period A to", baseline[1]],
        ["Period B from", selected[0]], ["Period B to", selected[1]]])
        await panel.getByLabel(label, { exact: true }).fill(value);
    return panel;
}
async function readAfter(page, gesture) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === comparePath);
    await gesture();
    const result = await response;
    assert.equal(result.status(), 200);
    const value = await result.json();
    await ready(page);
    return value;
}
async function compare(page, baseline = a, selected = b) {
    const panel = await draft(page, baseline, selected);
    return readAfter(page, () => panel.getByRole("button", { name: "Apply dates", exact: true }).press("Enter"));
}
async function start(page) {
    await enter(page); await ready(page);
    return compare(page);
}
async function useAnalyze(page) {
    await page.locator("#openAnalyzeFilters").click();
    const value = await readAfter(page, () => page.getByRole("button", { name: "Use Analyze view", exact: true }).click());
    await closeAnalyzeFilters(page);
    return value;
}
async function holdNext(page, endpoint = comparePath) {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    await page.route("**" + endpoint, async route => {
        const response = await route.fetch();
        entered.resolve(); await gate.promise;
        await route.fulfill({ response });
    }, { times: 1 });
    return { entered: entered.promise, release: gate.resolve };
}
async function showCalls(page, side) {
    await page.locator("#viewComparisonCalls").click();
    await page.locator("#comparisonRecords" + side).click();
    return page.locator("#comparisonExactRecords" + side);
}
async function phone(page) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
}
function exactIds(side, calls) {
    return calls.map(([chat, call]) => `comparison-record-${side}-call:["period-chat-${chat}","period-${call}"]`);
}

test("service context, full interactions and timed calls keep their own populations across views", timeout, async t => {
    const { page } = await setup(t, "/?services=Files&includeMissingService=true");
    await start(page);
    const value = await useAnalyze(page);
    assert.deepEqual(Object.values(value.periods).map(side => side.rowIds.length), [4, 4]);
    assert.equal(value.periods.later.dateRange.to, "2026-03-10T04:00:00.000Z");
    assert.equal(value.periods.later.dateRange.toExclusive, true);
    await expect(page.locator(".compare-date-qualification")).toHaveText(["1 day", "2 days"]);
    await expect(page.locator(".compare-length-note")).toHaveText("Totals are not adjusted for the different lengths.");
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    const options = await page.locator(".select-popup:visible [data-value]").evaluateAll(nodes =>
        nodes.map(n => [n.dataset.value, n.querySelector(".select-option-count")?.textContent]));
    assert.ok(options.length >= 3);
    for (const [key, counts] of options) assert.equal(counts,
        `A: ${value.periods.baseline.analytics.resultFacet.totals[key]}; B: ${value.periods.later.analytics.resultFacet.totals[key]}`);
    await page.keyboard.press("Escape"); await expect(page.locator("#outcomeFilter-control")).toBeFocused();
    await closeAnalyzeFilters(page);
    await showCalls(page, "A");
    for (const [key, id] of [["baseline", "A"], ["later", "B"]]) {
        await page.locator("#comparisonRecords" + id).click();
        const side = value.periods[key], panel = page.locator("#comparisonExactRecords" + id);
        const selection = side.analytics.serviceInvolvement.selection;
        await expect(panel.locator(".compare-service-coverage")).toHaveText(
            `Known service matches: ${selection.knownMatchIds.length} Missing-service context: ${selection.contextOnlyIds.length} ${selection.contextOnlyIds.length === 1 ? "record" : "records"}`);
        await expect(panel.locator("tbody tr")).toHaveCount(side.rowIds.length);
    }
    await page.getByRole("button", { name: "Back to comparison" }).click();
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    await expect(page.locator(".compare-interaction-counts > span")).toHaveText(["Baseline: 3 interactions", "Selected: 4 interactions"]);
    await expect(page.locator(".compare-population-note")).toHaveText("Includes other calls in those interactions, even outside these dates or filters.");
    await expect(page.locator(".compare-observation").locator("..")).toHaveText(/8,000 ms.*\(one timing\)/);
    const coverage = page.locator(".compare-timing-coverage");
    assert.ok(await coverage.count() > 0);
    for (const line of await coverage.all()) {
        await expect(line.locator("> span")).toHaveText("Timing recorded:");
        await expect(line.locator(".compare-peer-facts > span")).toHaveCount(2);
    }
});

test("outcome shares, linear counts and timing changes distinguish the two denominators", timeout, async t => {
    const { records } = periodFixture(), faster = records[2].toolCalls[0];
    records[1].title = "Recorded fetch scenario";
    faster.durationMs = 50; faster.completedAt = new Date(Date.parse(faster.startedAt) + 50).toISOString();
    const { page } = await setup(t, "/", { records });
    const value = await start(page);
    await expect(page.getByRole("button", { name: "Baseline, Tool failed: 20.00% (1 of 5 calls)" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Selected, Tool failed: 25.00% (1 of 4 calls)" })).toBeVisible();
    for (const [i, side] of Object.values(value.periods).entries()) {
        const bars = page.locator(".compare-outcome-bar").nth(i).locator("[data-outcome]");
        const segments = await bars.evaluateAll(nodes => nodes.map(n => [n.dataset.outcome, parseFloat(n.style.width)]));
        assert.deepEqual(segments.map(([key]) => key).sort(), [...new Set(side.analytics.rows.map(row => row.outcome))].sort());
        for (const [key, width] of segments) assert.equal(width, side.analytics.totals[key] * 100 / 5);
    }
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const latency = page.locator(".compare-latency tbody tr");
    await expect(latency).toHaveCount(3);
    await expect(latency.nth(0)).toContainText("−50 ms faster");
    await expect(latency.nth(1)).toContainText("+4,000 ms (+4 s) slower");
    await expect(latency.nth(2).locator(".compare-number")).toHaveText(["4 of 5", "2 of 4"]);
    const panel = await showCalls(page, "A");
    const generic = panel.getByRole("row").filter({ has: page.getByRole("link", { name: /workiq-fetch, Recorded fetch scenario,/ }) });
    await expect(generic).toHaveCount(1); await expect(generic.locator(".compare-record-context")).toHaveCount(0);
    await expect(panel.locator(".compare-record-context").first()).toHaveText("Synthetic calendar request");
});

test("latency keeps a measured zero and withholds single-sample tails", timeout, async t => {
    const { page } = await setup(t, "/?result=failure");
    await start(page); await useAnalyze(page);
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    await expect(page.locator(".compare-latency tbody tr").first().locator(".compare-number")).toHaveText(["0 ms", "3,000 ms (3 s)"]);
    const tail = page.locator(".compare-latency tbody tr").nth(1);
    await expect(tail.locator(".compare-number")).toHaveText(["Not shown (one timing)", "Not shown (one timing)"]);
    await expect(tail.locator(".compare-better,.compare-worse")).toHaveCount(0);
    await expect(tail).toContainText("Cannot compare");
});

test("accepted restrictions publish before reading restoration; unapplied dates are private drafts", timeout, async t => {
    const { page, reads } = await setup(t, "/?result=failure&services=Files&includeMissingService=true", { owner: true });
    await start(page);
    const value = await useAnalyze(page), accepted = await pair(page);
    assert.deepEqual(accepted.comparison, value);
    assert.deepEqual(Object.values(value.periods).map(side => [side.analytics.totals.count, side.analytics.totals.failure]), [[1, 1], [1, 1]]);
    const events = await page.evaluate(() => window.periodPairEvents.slice(-2));
    assert.deepEqual(events.map(e => e.kind), ["pair", "restore"]);
    assert.equal(events[0].datesPainted, true); assert.equal(events[0].key, accepted.key);
    assert.deepEqual(events[0].description.restrictions, ["Service: Files", "Missing-service context allowed", "Outcome: Tool failed"]);
    const caption = page.locator("#comparisonAcceptedScope");
    await expect(caption).toHaveText(events[0].description.restrictionText);
    const count = reads.length, address = page.url();
    const editor = await draft(page, emptyA, emptyB);
    assert.equal((await pair(page)).key, accepted.key);
    assert.equal(reads.length, count); assert.equal(page.url(), address);
    await expect(caption).toHaveAttribute("data-pair-key", accepted.key);
    await readAfter(page, () => editor.getByRole("button", { name: "Apply dates" }).click());
    await expect(page.locator("#periodComparisonResults")).toContainText("No calls match either period");
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    assert.notEqual((await pair(page)).key, accepted.key);
    assert.deepEqual((await lastPublication(page)).description, events[0].description);
});

test("older, failed and invalidated reads cannot publish newer paired authority", timeout, async t => {
    const { page, reads } = await setup(t, "/?result=failure", { owner: true });
    await start(page); await useAnalyze(page);
    const hold = await holdNext(page);
    const older = page.waitForResponse(r => r.url().endsWith(comparePath) && r.request().postDataJSON().periods.baseline.from === emptyA[0]);
    try {
        await (await draft(page, emptyA)).getByRole("button", { name: "Apply dates" }).click();
        await hold.entered;
        assert.equal(await pair(page), null); assert.equal((await lastPublication(page)).description, null);
        await expect(page.locator("#createPeriodReport")).toBeDisabled();
        await compare(page);
        const accepted = await pair(page), count = await page.evaluate(() => window.periodPairEvents.length);
        assert.equal((await lastPublication(page)).description.restrictionText, "Outcome: Tool failed");
        hold.release(); await (await older).finished(); await afterPaint(page);
        assert.equal((await pair(page)).key, accepted.key);
        assert.equal(await page.evaluate(() => window.periodPairEvents.length), count);
    } finally { hold.release(); }
    await page.route("**" + comparePath, route => route.fulfill({ status: 409, json: { error: "Scope fixture read failed." } }), { times: 1 });
    await (await draft(page)).getByRole("button", { name: "Apply dates" }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Scope fixture read failed.");
    assert.equal(await pair(page), null); assert.equal((await lastPublication(page)).description, null);
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await readAfter(page, () => page.getByRole("button", { name: "Retry comparison read" }).click());
    assert.equal((await lastPublication(page)).description.restrictionText, "Outcome: Tool failed");
    const count = reads.length;
    await page.evaluate(() => {
        const owner = window.periodComparisonOwner, basis = owner.acceptedPair().comparison.assessmentBasis;
        owner.observe({ basis: { ...basis, consentRevision: basis.consentRevision + 1 } });
    });
    assert.equal(await pair(page), null); assert.equal((await lastPublication(page)).description, null);
    await expect(page.locator("#comparisonAcceptedScope")).toBeHidden(); assert.equal(reads.length, count);
});

for (const state of ["partial", "unavailable"]) test(`${state} analytical Search cannot publish or dispatch a pair; global Search is independent`, timeout, async t => {
    const { page, reads } = await setup(t, "/", { owner: true });
    await start(page);
    const accepted = await pair(page), count = reads.length;
    if (state === "unavailable") await page.route("**/api/search/query", route => route.fulfill({ status: 503, json: { error: "Local search unavailable." } }));
    const search = page.locator("#wireSearch");
    await search.fill(periodQuery);
    if (state === "unavailable") await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    assert.equal((await pair(page)).key, accepted.key); assert.equal(accepted.scope.hasSearch, false);
    await selectActivityOption(page, "wireSearchScope", "analysis");
    if (state === "partial") await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Some saved text could not be searched");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status");
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    assert.equal(await pair(page), null); assert.equal((await lastPublication(page)).description, null);
    assert.equal(reads.length, count); await expect(search).toHaveValue(periodQuery);
});

test("owner resolves only the accepted pair and selected roster without focus, scroll or a read", timeout, async t => {
    const { page, reads } = await setup(t, "/?range=custom&from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true", { owner: true });
    assert.equal(await pair(page), null);
    await restoreLegacySearch(page, periodQuery);
    await start(page);
    const compared = await useAnalyze(page);
    const entry = await page.evaluate(() => {
        const value = window.periodComparisonOwner.acceptedPair();
        value.comparison.periods.baseline.rowIds.length = 0;
        return { key: value.key, revision: value.revision };
    });
    const accepted = await pair(page);
    assert.deepEqual(accepted.comparison, compared); assert.equal(entry.revision, compared.revision);
    assert.match(entry.key, /^period:\d+$/); assert.equal(accepted.scope.hasSearch, true);
    assert.ok(!JSON.stringify(accepted.scope).includes(periodQuery)); assert.ok(!page.url().includes(periodQuery));
    const resolveTarget = entry => page.evaluate(entry => {
        const position = () => [document.activeElement.id, scrollY];
        const before = position(), result = window.periodComparisonOwner.recordsTarget(entry);
        return { before, after: position(), target: result && [result.tab.id, result.region.id] };
    }, entry);
    const count = reads.length;
    assert.equal((await resolveTarget(entry)).target[0], "viewComparisonCalls");
    await showCalls(page, "B");
    const result = await resolveTarget(entry);
    assert.deepEqual(result.before, result.after); assert.deepEqual(result.target, ["comparisonRecordsB", "comparison-record-scroll-B"]);
    for (const wrong of [{ ...entry, key: "stale" }, { ...entry, revision: -1 }]) assert.equal((await resolveTarget(wrong)).target, null);
    assert.equal(reads.length, count);
    await page.getByRole("button", { name: "Back to comparison" }).click();
    await compare(page, emptyA);
    assert.equal((await resolveTarget(entry)).target, null);
    await showCalls(page, "A");
    await expect(page.locator("#comparisonExactRecordsA")).toContainText("No matching activity");
    assert.deepEqual((await resolveTarget(await pair(page))).target, ["comparisonRecordsA", "comparisonExactRecordsA"]);
    await page.getByRole("button", { name: "Back to comparison" }).click();
    await compare(page, emptyA, emptyB);
    assert.equal((await resolveTarget(await pair(page))).target, null);
    await page.locator('nav [data-nav="analyze"]:visible').press("Enter");
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    assert.equal(await pair(page), null);
    const params = new URL(page.url()).searchParams;
    assert.deepEqual(["from", "to", "services", "includeMissingService"].map(k => params.get(k)), [...a, "Files", "true"]);
    assert.ok(reads.every(r => !("from" in r.options.filters) && !("to" in r.options.filters)));
});

test("complete-day choices commit immediately; invalid and cancelled custom windows never replace either cohort", timeout, async t => {
    const { page, reads } = await setup(t, "/?from=2026-03-07&to=2026-03-07", { owner: true });
    await enter(page); await ready(page);
    const ranges = value => Object.values(value.periods).map(side => side.range);
    assert.deepEqual(ranges((await pair(page)).comparison), [
        { from: "2026-02-24", to: "2026-03-02" }, { from: "2026-03-03", to: "2026-03-09" },
    ]);
    const preset = await readAfter(page, () => openDatePicker(page, "compare", "Last 14 days"));
    assert.deepEqual(ranges(preset), [{ from: "2026-02-10", to: "2026-02-23" }, { from: "2026-02-24", to: "2026-03-09" }]);
    const address = page.url(), count = reads.length, accepted = await pair(page);
    const panel = await openDatePicker(page, "compare", "Custom dates");
    const from = panel.getByLabel("Period A from", { exact: true }), to = panel.getByLabel("Period A to", { exact: true });
    const apply = panel.getByRole("button", { name: "Apply dates" });
    await from.fill("");
    await expect(apply).toBeDisabled(); await expect(panel.locator("#comparisonAStatus")).toHaveText("Choose a start date.");
    await from.fill("2026-03-07"); await to.fill("2026-03-06");
    await expect(apply).toBeDisabled(); await expect(from).toHaveAttribute("aria-invalid", "true");
    await expect(panel.locator("#comparisonAStatus")).toHaveText("End date must be on or after the start.");
    await expect(panel.locator("#comparisonBFrom")).toHaveAttribute("aria-invalid", "false");
    await to.fill("2026-03-11");
    await expect(apply).toBeDisabled(); await expect(panel.locator("#comparisonAStatus")).toHaveText("Choose today or an earlier date.");
    await page.keyboard.press("Escape");
    await expect(page.locator("#comparisonDates")).toBeFocused();
    assert.equal(page.url(), address); assert.equal(reads.length, count); assert.equal((await pair(page)).key, accepted.key);
    await page.clock.setFixedTime(new Date("2026-03-11T15:00:00Z"));
    assert.deepEqual(ranges((await pair(page)).comparison), ranges(preset));
    const next = await readAfter(page, () => openDatePicker(page, "compare", "Last 14 days"));
    assert.deepEqual(ranges(next), [{ from: "2026-02-11", to: "2026-02-24" }, { from: "2026-02-25", to: "2026-03-10" }]);
    const custom = await compare(page);
    const reloaded = await readAfter(page, () => page.reload());
    assert.deepEqual(ranges(reloaded), ranges(custom));
    await expect(page.locator("#comparisonDates")).toHaveAccessibleName("Dates: Custom dates");
});

test("localized period headings and their editable dates fit in both themes; keyboard selection edits only its own side", timeout, async t => {
    const { page, reads } = await setup(t, "/", { locale: "ca-ES" });
    await start(page);
    const trigger = page.locator('[data-edit-period="b"]');
    for (const [width, scale] of [[1440, 100], [768, 100], [390, 200]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        for (const theme of ["dark", "light"]) {
            await chooseTheme(page, theme);
            const periods = page.locator(".compare-period-key [data-edit-period]");
            await expect(periods).toHaveCount(2);
            for (const button of await periods.all()) {
                const box = await button.boundingBox();
                assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 44, JSON.stringify(box));
                assert.ok(await button.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
            }
            await trigger.press("Space");
            const editor = page.locator("#comparisonCustomDates");
            await expect(editor.getByRole("heading", { name: /març.*2026/ })).toBeVisible();
            await expect(editor.getByLabel("Period B from", { exact: true })).toBeFocused();
            await expect(editor.getByLabel("Period A from", { exact: true })).toBeHidden();
            assert.ok(await editor.evaluate(n => n.scrollWidth <= n.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1));
            await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
        }
    }
    const count = reads.length;
    await trigger.press("Enter");
    const editor = page.locator("#comparisonCustomDates");
    await page.keyboard.press("Alt+ArrowDown"); await page.keyboard.press("ArrowLeft");
    await expect(editor.locator('[data-day="2026-03-07"]:visible')).toBeFocused();
    await page.keyboard.press("Space");
    await expect(editor.getByRole("button", { name: "Apply dates" })).toBeDisabled();
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    assert.equal(reads.length, count);
    const value = await readAfter(page, () => editor.getByRole("button", { name: "Apply dates" }).press("Enter"));
    assert.deepEqual(value.periods.baseline.range, { from: a[0], to: a[1] });
    assert.deepEqual(value.periods.later.range, { from: "2026-03-07", to: "2026-03-08" });
    await expect(trigger).toBeFocused();
});

function reading(page, side) {
    return page.evaluate(side => ({
        y: scrollY, id: document.activeElement.id,
        inner: document.getElementById("comparison-record-scroll-" + side)?.scrollTop,
    }), side);
}
test("comparison record Close and browser Back restore the exact filtered target and reading position", timeout, async t => {
    const { page } = await setup(t, "/?services=Files&includeMissingService=true");
    await start(page); await useAnalyze(page);
    const panel = await showCalls(page, "A");
    const expected = exactIds("A", [[0, "call-0"], [0, "missing"], [1, "call-1"], [9, "call-9"]]);
    assert.deepEqual((await panel.locator("tbody a").evaluateAll(nodes => nodes.map(n => n.id))).sort(), expected);
    const target = panel.locator(`[id=${JSON.stringify(expected[2])}]`);
    await target.scrollIntoViewIfNeeded(); await target.focus();
    const origin = await reading(page, "A"), address = page.url();
    for (const exit of ["Close", "Back"]) {
        await target.click();
        await expect(page.locator('#contextSidebar [data-tool-call-id="period-call-1"]').first()).toBeVisible();
        if (exit === "Close") await page.locator("#closeContextSidebar").click(); else await page.goBack();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await expect(page.locator("#comparisonRecordsA")).toHaveAttribute("aria-selected", "true");
        await expect(target).toBeFocused(); await expect.poll(() => reading(page, "A")).toEqual(origin);
        assert.equal(page.url(), address);
    }
    await page.getByRole("button", { name: "Back to comparison" }).click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
});

test("late records with long titles remain readable at 200%; Close and Back restore the native roster scroll", timeout, async t => {
    const { records } = periodFixture(), title = "Recorded interaction with extended project context ".repeat(8).trim();
    for (const record of records) record.title = title;
    const { page } = await setup(t, "/", { records });
    await phone(page); await enter(page); await ready(page);
    const value = await compare(page, emptyA, a);
    assert.equal(value.periods.baseline.rowIds.length, 0);
    await expect(page.locator('[data-edit-period="a"]')).toContainText("2025");
    await expect(page.locator('[data-edit-period="b"]')).toContainText("2026");
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const positions = await page.locator(".compare-latency tbody tr").evaluateAll(rows => rows.map(row =>
        [...row.querySelectorAll("td .compare-number")].map(n => n.getBoundingClientRect().top)));
    assert.equal(positions.length, 3);
    assert.ok(positions.every(row => row.length === 2 && Math.abs(row[0] - row[1]) < 1), JSON.stringify(positions));
    const panel = await showCalls(page, "B"), target = panel.locator("tbody a").last();
    const context = panel.locator(".compare-record-context").last();
    await expect(context).toHaveText(title);
    assert.ok(await context.evaluate(n => n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const exit of ["Close", "Back"]) {
        await target.scrollIntoViewIfNeeded(); await target.focus(); await afterPaint(page);
        const origin = await reading(page, "B");
        assert.ok(origin.inner > 0, "Target is below the initial roster viewport");
        await target.press("Enter");
        await expect(page.locator("#contextSidebar")).toBeVisible();
        if (exit === "Close") await page.locator("#closeContextSidebar").click(); else await page.goBack();
        await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
        await expect(target).toBeFocused(); await expect.poll(() => reading(page, "B")).toEqual(origin);
    }
});

test("newer reading input cancels a held exact-record return", timeout, async t => {
    const { page } = await setup(t);
    await phone(page); await start(page);
    const panel = await showCalls(page, "A"), link = panel.locator("tbody a").last();
    await link.scrollIntoViewIfNeeded(); await link.press("Enter");
    await expect(page.locator("#contextSidebar")).toBeVisible();
    const hold = await holdNext(page);
    try {
        await page.locator("#closeContextSidebar").click(); await hold.entered;
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Reading both periods...");
        await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
        await afterPaint(page);
        const initial = await reading(page);
        assert.ok(initial.y > 0, "The pending return page can scroll");
        await page.mouse.move(350, 700); await page.mouse.wheel(0, -initial.y);
        // mouse.wheel returns before Chromium finishes scrolling.
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        const before = await reading(page);
        hold.release(); await ready(page);
        await expect(page.locator("#comparisonRecordsA")).toHaveAttribute("aria-selected", "true");
        assert.notEqual(before.id, await link.getAttribute("id"));
        await expect.poll(() => reading(page)).toEqual(before);
    } finally { hold.release(); }
});

test("pending Apply never takes focus from a newer date draft or an automatic filter refinement", timeout, async t => {
    const { page, reads } = await setup(t);
    await start(page);
    const hold = await holdNext(page);
    try {
        await (await draft(page)).getByRole("button", { name: "Apply dates" }).press("Enter");
        await hold.entered;
        const panel = await draft(page, ["2026-03-05", "2026-03-06"]);
        const count = reads.length, before = await reading(page);
        hold.release(); await ready(page); await afterPaint(page);
        await expect(panel.getByLabel("Period B to", { exact: true })).toBeFocused();
        await expect(panel.getByLabel("Period A from", { exact: true })).toHaveValue("2026-03-05");
        assert.equal(reads.length, count); assert.deepEqual(await reading(page), before);
        await page.keyboard.press("Escape");
    } finally { hold.release(); }
    await page.locator("#openAnalyzeFilters").click();
    const next = await holdNext(page);
    try {
        await page.locator("#promptAuthorFilter-control").click();
        await page.locator('.select-popup:visible [data-value="agent"]').click();
        await next.entered;
        const before = await reading(page);
        next.release(); await ready(page);
        await expect(page.locator("#promptAuthorFilter-control")).toBeFocused();
        assert.deepEqual(await reading(page), before);
        await closeAnalyzeFilters(page);
        await showCalls(page, "B");
        await expect(page.locator("#comparisonExactRecordsB tbody tr")).toHaveCount(2);
    } finally { next.release(); }
});

for (const action of ["wheel", "PageDown"]) test(`pending date Apply preserves a newer ${action} reading position`, timeout, async t => {
    const { page } = await setup(t);
    await phone(page); await start(page);
    await page.locator('[data-edit-period="b"]').press("Enter");
    const hold = await holdNext(page);
    try {
        await page.locator("#applyPeriodComparison").press("Enter"); await hold.entered;
        await expect(page.locator("#periodComparisonResults")).toHaveAttribute("aria-busy", "true");
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await afterPaint(page);
        const settled = page.evaluate(() => new Promise(resolve => document.addEventListener("scrollend", resolve, { once: true })));
        if (action === "wheel") { await page.mouse.move(350, 700); await page.mouse.wheel(0, 80); }
        else await page.keyboard.press("PageDown");
        await settled;
        const before = await reading(page);
        assert.ok(before.y > 0, "The reader moved on the pending page");
        hold.release(); await ready(page); await afterPaint(page);
        assert.deepEqual(await reading(page), before);
        await expect(page.locator('[data-edit-period="b"]')).not.toBeFocused();
    } finally { hold.release(); }
});

test("Create report hands the accepted filtered cohorts to the read-only preview and Back returns to Compare", timeout, async t => {
    const { page } = await setup(t, "/?services=Files&includeMissingService=true", { preview: true });
    await start(page);
    const value = await useAnalyze(page);
    const action = page.locator("#createPeriodReport");
    await action.scrollIntoViewIfNeeded(); await action.focus();
    const before = await reading(page), address = page.url(), response = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await action.press("Enter");
    const result = await response;
    assert.equal(result.status(), 200);
    const preview = await result.json();
    const frozen = preview.snapshot.periodComparison;
    assert.deepEqual(frozen.comparison, value.comparison);
    for (const key of ["baseline", "later"]) {
        assert.deepEqual(frozen.periods[key].range, value.periods[key].range);
        // The reviewed report uses opaque row references; compare the actual call facts.
        const facts = rows => rows.map(({ tool, outcome, durationMs, promptAuthor }) => [tool, outcome, durationMs, promptAuthor]);
        assert.deepEqual(facts(frozen.periods[key].rows), facts(value.periods[key].analytics.rows));
    }
    await expect(page.locator("#reportStage3")).toBeVisible();
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    const pdf = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.locator("#formatOptions input[value=pdf]").check();
    const file = (await (await pdf).json()).files["product-report.pdf"];
    const task = getDocument({ data: new Uint8Array(Buffer.from(file.data, "base64")), useSystemFonts: false, disableFontFace: true });
    try {
        const document = await task.promise;
        const last = (await (await document.getPage(document.numPages)).getTextContent()).items.map(item => item.str ?? "").join(" ");
        assert.ok(!last.includes("Interpretation") || last.includes("Timing method") || last.includes("Record "),
            "Do not strand Interpretation and its footer in the short-group PDF");
    } finally { await task.destroy(); }
    await page.keyboard.press("Escape"); await page.goBack(); await ready(page);
    assert.equal(page.url(), address);
    await expect(page.locator("#comparisonAcceptedScope")).toContainText("Files");
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await expect.poll(() => reading(page)).toEqual(before);
});

for (const width of [1440, 390]) for (const motion of ["reduce", "no-preference"]) {
    test(`comparison entry and keyboard date menu: ${width}px, ${motion}`, timeout, async t => {
        const { page, reads } = await setup(t);
        if (width === 390) await phone(page);
        await page.emulateMedia({ reducedMotion: motion });
        await enter(page, "Enter"); await ready(page);
        await expect(page).toHaveURL(/\/compare(?:\?|$)/);
        const dates = page.locator("#comparisonDates");
        await expect(page.getByRole("heading", { name: "Compare", level: 1 })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(dates).toBeFocused();
        assert.equal(reads.length, 1);
        await page.keyboard.press("Space");
        const editor = page.locator("#comparisonCustomDates");
        await expect(editor.getByRole("button", { name: "Last 7 days" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(editor.getByRole("button", { name: "Last 14 days" })).toBeFocused();
        await readAfter(page, () => page.keyboard.press("Space"));
        await expect(dates).toHaveAccessibleName("Dates: Last 14 days");
        await expect(dates).toBeFocused();
    });
}

for (const action of ["none", "focus", "wheel", "PageDown", "focus away and back", "navigation"]) {
    test(`pending entry respects newer ${action}`, timeout, async t => {
        const { page, reads } = await setup(t, "/?range=custom&from=2026-03-07&to=2026-03-07");
        await phone(page);
        // Make the ordinary snapshot stale, then hold the separate Compare entry snapshot.
        const first = await holdNext(page, "/api/snapshot");
        try {
            await selectActivityOption(page, "dateFilter", "capture"); await first.entered;
            await closeAnalyzeFilters(page);
            const entry = await holdNext(page, "/api/snapshot");
            try {
                await enter(page); await entry.entered;
                await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
                const origin = await page.evaluate(() => document.activeElement.id);
                const focus = page.locator("#" + origin);
                if (action === "focus") await page.locator("#wireSearch").click();
                if (action === "focus away and back") {
                    await page.keyboard.press("Tab"); await expect(focus).not.toBeFocused();
                    await page.keyboard.press("Shift+Tab"); await expect(focus).toBeFocused();
                }
                if (action === "wheel" || action === "PageDown") {
                    const event = action === "wheel" ? "wheel" : "keydown";
                    await page.evaluate(type => {
                        window.entryInput = new Promise(resolve => document.addEventListener(type,
                            e => resolve({ trusted: e.isTrusted, key: e.key, delta: e.deltaY }), { capture: true, once: true }));
                    }, event);
                    if (action === "wheel") { await page.mouse.move(220, 740); await page.mouse.wheel(0, 350); }
                    else await page.keyboard.press("PageDown");
                    const input = await page.evaluate(() => window.entryInput);
                    assert.equal(input.trusted, true);
                    if (action === "wheel") assert.ok(input.delta > 0); else assert.equal(input.key, "PageDown");
                }
                if (action === "navigation") {
                    await page.locator("#navigationToggle").click();
                    await page.locator('nav [data-nav="settings"]:visible').click();
                    await expect(page).toHaveURL(/\/settings\b/);
                }
                first.release(); entry.release();
                await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
                if (action === "navigation") {
                    await expect(page.locator("#periodComparisonSetup")).toBeHidden(); assert.equal(reads.length, 0);
                } else {
                    await ready(page);
                    await expect(action === "none" ? page.getByRole("heading", { name: "Compare", level: 1 }) : action === "focus" ? page.locator("#wireSearch") : focus).toBeFocused();
                    assert.equal(reads.length, 1);
                }
            } finally { entry.release(); }
        } finally { first.release(); }
    });
}
