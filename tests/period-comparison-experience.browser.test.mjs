import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

const proof = process.env.WIRE_COMPARISON_EXPERIENCE_PROOFS;
async function setup(t, hash = "#analyze", { ownerApi = false, pairChanges = false, records = periodFixture().records, locale = "en-US" } = {}) {
    let removeFixture;
    records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const { context } = await privateFixture({ after: cleanup => { removeFixture = cleanup; } }, records);
    const before = await loadBoardState(context), errors = [], denied = [], requests = [];
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
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
            "/api/search/query", "/api/search/status", "/api/search/events", "/api/session",
            "/api/preview", "/api/cancel-preview",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        requests.push({ path: url.pathname, input: request.method() === "POST" ? request.postDataJSON() : undefined });
        if ((ownerApi || pairChanges) && url.pathname === "/" && request.method() === "GET") {
            const response = await route.fetch(), html = await response.text();
            const binding = "const periodComparisonUI = assessmentFactories.periodComparison.mount({";
            assert.ok(html.includes(binding), "Expose only the real mounted owner for this contract test");
            let mount = "assessmentFactories.periodComparison.mount";
            if (pairChanges) {
                mount = `((options) => {
                    const { onPairChange, onAccepted } = options;
                    return assessmentFactories.periodComparison.mount({
                        ...options,
                        onPairChange(...args) {
                            const result = onPairChange?.apply(this, args);
                            const [pair] = args;
                            window.periodPairEvents.push({
                                kind: "pair", pair, description: analyzeScope.describePair(pair),
                                datesPainted: Boolean(document.querySelector(".compare-period-key")),
                            });
                            return result;
                        },
                        onAccepted(...args) {
                            const result = onAccepted?.apply(this, args);
                            window.periodPairEvents.push({ kind: "restore", publishedFirst: window.periodPairEvents.at(-1)?.kind === "pair" });
                            return result;
                        },
                    });
                })`;
            }
            const body = html.replace(binding,
                `window.periodPairEvents = []; const periodComparisonUI = window.periodComparisonOwner = ${mount}({`);
            return route.fulfill({ response, body });
        }
        return route.continue();
    });
    await page.goto(server.url + hash);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, requests };
}

async function fillPeriods(page, a = ["2026-03-07", "2026-03-07"], b = ["2026-03-08", "2026-03-09"]) {
    for (const [label, value] of [
        ["Period A from", a[0]], ["Period A to", a[1]], ["Period B from", b[0]], ["Period B to", b[1]],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
}
async function enterComparison(page, activation = "mouse") {
    await settleLayout(page);
    const launcher = page.locator("#comparePeriods");
    if (await page.locator("#navigationDrawer #comparePeriods").count()) {
        if (activation === "mouse") await page.locator("#navigationToggle").click();
        else {
            await page.locator("#navigationToggle").focus(); await page.keyboard.press("Enter");
            for (let tabs = 0; tabs < 20 && await page.evaluate(() => document.activeElement.id !== "comparePeriods"); tabs++)
                await page.keyboard.press("Tab");
            await expect(launcher).toBeFocused();
        }
        await expect(page.locator("#navigationDrawer")).toBeVisible();
    } else if (activation !== "mouse") await launcher.focus();
    if (activation === "mouse") await launcher.click();
    else await page.keyboard.press(activation);
}
async function compare(page) {
    const response = page.waitForResponse(response => response.url().endsWith("/api/period-comparison") && response.ok());
    await page.locator("#applyPeriodComparison").focus(); await page.keyboard.press("Enter");
    const value = await (await response).json();
    await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
    return value;
}
async function settleLayout(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
        .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, name) {
    if (!proof) return;
    await settleLayout(page);
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
    await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
}

test("comparison metadata groups dates, peer facts and observation qualifiers without changing their populations", { timeout: 30000 }, async t => {
    const { page } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await enterComparison(page); await fillPeriods(page);
    const value = await compare(page);
    await expect(page.locator(".compare-date-qualification")).toHaveText([
        "Mar 7, 2026 (1 day)", "Mar 8, 2026 – Mar 9, 2026 (2 days)",
    ]);
    const names = ["Mar 7", "Mar 8 – Mar 9"];
    for (const [index, key] of ["baseline", "later"].entries()) {
        const side = value.periods[key], selection = side.analytics.serviceInvolvement.selection;
        const panel = page.locator(`[data-period-side="${key}"]`);
        await expect(panel.locator(".compare-service-coverage")).toHaveText(
            `Known service matches: ${selection.knownMatchIds.length} Missing-service context: ${selection.contextOnlyIds.length} ${selection.contextOnlyIds.length === 1 ? "record" : "records"}`);
        await expect(page.locator(".compare-interaction-counts > span").nth(index)).toHaveText(
            `${names[index]}: ${side.interactionRefs.length} interactions`);
    }
    await expect(page.locator(".compare-full-timing > .compare-population-note")).toHaveText(
        "Includes other calls in those interactions, even outside these dates or filters.");
    await expect(page.locator(".compare-observation")).toHaveText("(one timing)");
    await expect(page.locator(".compare-observation").locator("..")).toHaveText("8,000 ms (one timing)");
    for (const coverage of await page.locator(".compare-timing-coverage").all()) {
        await expect(coverage.locator("> span").first()).toHaveText("Timing recorded:");
        await expect(coverage.locator("> .compare-peer-facts > span")).toHaveCount(2);
    }
    await expect(page.locator(".compare-length-note")).toHaveText("Totals are not adjusted for the different lengths.");
    for (const selector of [".compare-period-key", ".compare-service-coverage", ".compare-interaction-counts",
        ".compare-timing-coverage", ".compare-length-note", ".compare-observation"])
        assert.ok((await page.locator(selector).allTextContents()).every(text => !text.includes("·")), selector);
    const qualifier = await page.locator(".compare-observation").evaluate(node => ({
        color: getComputedStyle(node).color, primary: getComputedStyle(node.previousElementSibling).color,
        size: getComputedStyle(node).fontSize, primarySize: getComputedStyle(node.previousElementSibling).fontSize,
    }));
    assert.notEqual(qualifier.color, qualifier.primary);
    assert.equal(qualifier.size, qualifier.primarySize);
});

test("accepted paired restrictions qualify filtered results before reading restoration and clear on drafts", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze?result=failure&services=Files&includeMissingService=true", { pairChanges: true });
    await enterComparison(page);
    await fillPeriods(page);
    const value = await compare(page);
    assert.ok(Object.values(value.periods).every(side => side.analytics.totals.count > 0
        && side.analytics.totals.failure === side.analytics.totals.count));
    const events = await page.evaluate(() => window.periodPairEvents), accepted = events.at(-2);
    assert.equal(accepted.kind, "pair");
    assert.equal(accepted.datesPainted, true);
    assert.deepEqual(accepted.pair.comparison, value);
    assert.equal(accepted.description.text, "Service: Files; Missing-service context allowed; Outcome: Tool failed");
    assert.deepEqual(accepted.description.parts, ["Service: Files", "Missing-service context allowed", "Outcome: Tool failed"]);
    assert.equal(accepted.description.activeCount, 3);
    assert.deepEqual(events.at(-1), { kind: "restore", publishedFirst: true });
    const reads = requests.filter(request => request.path === "/api/period-comparison").length;
    await page.locator("#comparisonAFrom").fill("2026-03-06");
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    assert.deepEqual(await page.evaluate(() => ({
        pair: window.periodPairEvents.at(-1).pair, description: window.periodPairEvents.at(-1).description,
    })), { pair: null, description: null });
    await expect(page.locator("#periodComparisonResultsTitle")).toBeHidden();
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, reads);
    await fillPeriods(page, ["2025-03-07", "2025-03-07"], ["2025-03-08", "2025-03-09"]);
    await compare(page);
    const empty = await page.evaluate(() => window.periodPairEvents.filter(event => event.kind === "pair").at(-1));
    assert.ok(empty.pair);
    assert.equal(empty.datesPainted, true);
    assert.equal(empty.description.text, accepted.description.text);
    await expect(page.locator("#periodComparison")).toContainText("No activity was found in either period");
});

test("paired scope publication follows accepted filters and fences pending, failed and invalidated results", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze?result=failure", { pairChanges: true });
    await enterComparison(page); await fillPeriods(page); await compare(page);
    const readScope = () => page.evaluate(() => window.periodPairEvents.filter(event => event.kind === "pair").at(-1));
    const readPair = () => page.evaluate(() => window.periodComparisonOwner.acceptedPair());
    assert.equal((await readScope()).description.text, "Outcome: Tool failed");
    let release, entered;
    const held = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch(); entered(); await waiting; await route.fulfill({ response });
    }, { times: 1 });
    const olderResponse = page.waitForResponse(response => response.url().endsWith("/api/period-comparison")
        && response.request().postDataJSON().options.filters.outcomes?.includes("failure"));
    await page.locator("#applyPeriodComparison").click(); await held;
    assert.equal(await readPair(), null);
    assert.equal((await readScope()).description, null);
    const newerResponse = page.waitForResponse(response => response.url().endsWith("/api/period-comparison")
        && response.request().postDataJSON().options.filters.outcomes?.includes("success"));
    await selectActivityOption(page, "outcomeFilter", "success");
    if (await page.locator("#analyzeFilterDialog[open]").count()) await page.locator("#closeAnalyzeFilters").click();
    await newerResponse;
    await expect.poll(async () => (await readScope()).description?.text).toBe("Outcome: Worked");
    const accepted = await readPair(), eventCount = await page.evaluate(() => window.periodPairEvents.length);
    assert.deepEqual(accepted.comparison.options.filters.outcomes, ["success"]);
    release(); await (await olderResponse).finished(); await settleLayout(page);
    assert.equal((await readPair()).key, accepted.key);
    assert.equal(await page.evaluate(() => window.periodPairEvents.length), eventCount);
    await page.route("**/api/period-comparison", route => route.fulfill({
        status: 409, contentType: "application/json", body: JSON.stringify({ error: "Scope fixture read failed." }),
    }), { times: 1 });
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Scope fixture read failed");
    assert.equal(await readPair(), null);
    assert.equal((await readScope()).description, null);
    await page.getByRole("button", { name: "Retry comparison read", exact: true }).click();
    await expect.poll(async () => (await readScope()).description?.text).toBe("Outcome: Worked");
    const reads = requests.filter(request => request.path === "/api/period-comparison").length;
    await page.evaluate(() => {
        const value = window.periodComparisonOwner.acceptedPair().comparison;
        window.periodComparisonOwner.observe({ basis: { ...value.assessmentBasis, consentRevision: value.assessmentBasis.consentRevision + 1 } });
    });
    assert.equal(await readPair(), null);
    assert.equal((await readScope()).description, null);
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, reads);
    await page.locator('nav [data-nav="analyze"]:visible').click();
    assert.equal(await readPair(), null);
    assert.equal((await readScope()).description, null);
    assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("compare")), null);
});

test("partial Search cannot publish a paired scope or dispatch comparison facts", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze", { pairChanges: true });
    await enterComparison(page); await fillPeriods(page); await compare(page);
    const reads = requests.filter(request => request.path === "/api/period-comparison").length;
    await page.locator("#wireSearch").fill("request");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Partial searchable coverage");
    await page.keyboard.press("Escape");
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status");
    const published = await page.evaluate(() => window.periodPairEvents.filter(event => event.kind === "pair").at(-1));
    assert.equal(published.pair, null);
    assert.equal(published.description, null);
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, reads);
});

test("comparison owner exposes only the current accepted pair and selected roster target", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze?range=custom&from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true", { ownerApi: true });
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    await restoreLegacySearch(page, periodQuery);
    await page.locator("#comparePeriods").click(); await fillPeriods(page);
    const compared = await compare(page);
    const reads = () => requests.filter(request => request.path === "/api/period-comparison").length;
    const readCount = reads();
    const pair = await page.evaluate(() => {
        const value = window.periodComparisonOwner.acceptedPair();
        window.savedPeriodEntry = { key: value.key, revision: value.revision };
        value.comparison.periods.baseline.rowIds.length = 0;
        return window.periodComparisonOwner.acceptedPair();
    });
    assert.match(pair.key, /^period:\d+$/);
    assert.doesNotMatch(pair.key, new RegExp(periodQuery));
    assert.equal(pair.revision, compared.revision);
    assert.deepEqual(pair.comparison, compared);
    assert.equal(pair.scope.hasSearch, true);
    assert.doesNotMatch(JSON.stringify(pair.scope), new RegExp(periodQuery));
    await page.locator("#comparisonRecordsB").click();
    const target = await page.evaluate(() => {
        const before = { focus: document.activeElement.id, y: scrollY };
        const owner = window.periodComparisonOwner, entry = window.savedPeriodEntry;
        const result = owner.recordsTarget(entry);
        return { before, after: { focus: document.activeElement.id, y: scrollY },
            tab: result.tab.id, region: result.region.id, key: owner.acceptedPair().key,
            wrongKey: owner.recordsTarget({ ...entry, key: "stale" }), wrongRevision: owner.recordsTarget({ ...entry, revision: -1 }) };
    });
    assert.deepEqual(target.before, target.after, "Read-only resolution must not scroll or move focus");
    assert.equal(target.tab, "comparisonRecordsB"); assert.equal(target.region, "comparison-record-scroll-B");
    assert.equal(target.key, pair.key); assert.equal(target.wrongKey, null); assert.equal(target.wrongRevision, null);
    assert.equal(reads(), readCount, "The guide handoff must not issue another query");
    await page.locator("#comparisonATo").fill("2026-03-08");
    assert.deepEqual(await page.evaluate(() => ({
        pair: window.periodComparisonOwner.acceptedPair(),
        target: window.periodComparisonOwner.recordsTarget(window.savedPeriodEntry),
    })), { pair: null, target: null });
    await fillPeriods(page); await compare(page);
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.recordsTarget(window.savedPeriodEntry)), null);
    assert.notEqual((await page.evaluate(() => window.periodComparisonOwner.acceptedPair())).key, pair.key);
    await page.evaluate(() => window.periodComparisonOwner.stop());
    await expect(page.locator("#periodComparisonSetup")).toBeHidden();
    const restored = await page.evaluate(() => {
        const params = new URLSearchParams(location.hash.split("?")[1]);
        return { pair: window.periodComparisonOwner.acceptedPair(), target: window.periodComparisonOwner.recordsTarget(window.savedPeriodEntry),
            from: params.get("from"), to: params.get("to"), services: params.get("services"), missing: params.get("includeMissingService") };
    });
    assert.deepEqual(restored, { pair: null, target: null, from: "2026-03-07", to: "2026-03-07", services: "Files", missing: "true" });
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    await page.locator("#comparePeriods").click();
    await fillPeriods(page, ["2025-03-07", "2025-03-07"]); await compare(page);
    await expect(page.locator("#comparisonExactRecordsA .compare-empty")).toContainText("No matching activity");
    assert.deepEqual(await page.evaluate(() => {
        const owner = window.periodComparisonOwner, pair = owner.acceptedPair(), target = owner.recordsTarget(pair);
        return { tab: target.tab.id, region: target.region.id };
    }), { tab: "comparisonRecordsA", region: "comparisonExactRecordsA" });
    await fillPeriods(page, ["2025-03-07", "2025-03-07"], ["2025-03-08", "2025-03-09"]); await compare(page);
    await expect(page.locator("#periodComparisonResults")).toContainText("No activity was found in either period");
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.recordsTarget(window.periodComparisonOwner.acceptedPair())), null);
});

test("comparison presets are explicit date drafts while empty and route-provided windows remain unchanged", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.clock.setFixedTime(new Date("2026-03-09T15:00:00Z"));
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#comparisonAFrom")).toHaveValue("");
    await expect(page.locator("#comparisonBTo")).toHaveValue("");
    await expect(page.locator("#comparisonAPreset")).toHaveValue("custom");
    assert.ok((await page.locator("#comparisonAPreset-control").boundingBox()).height >= 44);
    const reads = () => requests.filter(request => request.path === "/api/period-comparison").length;
    await selectActivityOption(page, "comparisonAPreset", "previous-week");
    await selectActivityOption(page, "comparisonBPreset", "this-week");
    await expect(page.locator("#comparisonAFrom")).toHaveValue("2026-03-02");
    await expect(page.locator("#comparisonATo")).toHaveValue("2026-03-08");
    await expect(page.locator("#comparisonBFrom")).toHaveValue("2026-03-09");
    await expect(page.locator("#comparisonBTo")).toHaveValue("2026-03-15");
    await expect(page.locator("#comparisonAFrom")).toBeHidden();
    assert.equal(reads(), 0, "Choosing a preset must not compare automatically");
    await capture(page, "preset-selection");
    const compared = await compare(page);
    assert.deepEqual(compared.periods.baseline.range, { from: "2026-03-02", to: "2026-03-08" });
    assert.deepEqual(compared.periods.later.range, { from: "2026-03-09", to: "2026-03-15" });
    await expect(page.locator("#periodComparisonResultsTitle")).toHaveText("This week vs previous week");
    await capture(page, "named-period-results");
    await selectActivityOption(page, "comparisonAPreset", "custom");
    await expect(page.locator("#comparisonAFrom")).toBeVisible();
    await page.locator("#comparisonAFrom").fill("2026-03-07");
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await compare(page);
    await expect(page.locator("#comparisonAPreset")).toHaveValue("custom");
    await expect(page.locator("#comparisonAFrom")).toHaveValue("2026-03-07");
    await page.reload();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator("#comparisonAFrom")).toHaveValue("2026-03-07");
    await expect(page.locator("#comparisonATo")).toHaveValue("2026-03-08");
    await expect(page.locator("#comparisonBFrom")).toHaveValue("2026-03-09");
    await expect(page.locator("#comparisonBTo")).toHaveValue("2026-03-15");
    await expect(page.locator("#comparisonAPreset")).toHaveValue("custom");
    await selectActivityOption(page, "comparisonAPreset", "previous-week");
    await selectActivityOption(page, "comparisonBPreset", "this-week");
    const beforeRollover = reads();
    await page.clock.setFixedTime(new Date("2026-03-16T15:00:00Z"));
    await expect(page.locator("#comparisonAFrom")).toHaveValue("2026-03-02");
    assert.equal(reads(), beforeRollover);
    const nextWeek = await compare(page);
    assert.deepEqual(nextWeek.periods.baseline.range, { from: "2026-03-09", to: "2026-03-15" });
    assert.deepEqual(nextWeek.periods.later.range, { from: "2026-03-16", to: "2026-03-22" });
});

test("period selectors keep their primary baseline through mixed preset and custom selection", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t);
    await page.clock.setFixedTime(new Date("2026-10-26T15:00:00Z"));
    await enterComparison(page);
    const output = process.env.WIRE_SELECTOR_LAYOUT_PROOFS, measurements = [], failures = [];
    if (output) await mkdir(output, { recursive: true });
    const check = (condition, message) => { if (!condition) failures.push(message); };
    for (const theme of ["dark", "light"]) for (const width of [1840, 1440, 768, 390]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        let baseline;
        for (const [name, a, b] of [
            ["both-custom", "custom", "custom"],
            ["preset-custom", "this-week", "custom"],
            ["both-presets", "this-week", "previous-month"],
            ["custom-preset", "custom", "previous-month"],
        ]) {
            await selectActivityOption(page, "comparisonAPreset", a);
            await selectActivityOption(page, "comparisonBPreset", b);
            await settleLayout(page);
            await page.evaluate(() => scrollTo(0, 0));
            const value = await page.locator(".period-comparison-controls").evaluate(form => {
                const box = node => {
                    const { x, y, width, height, bottom, right } = node.getBoundingClientRect();
                    return { x, y, width, height, bottom, right };
                };
                return {
                    groups: [...form.querySelectorAll("fieldset")].map(group => ({
                        ...box(group), legend: box(group.querySelector("legend")),
                        preset: box(group.querySelector(".comparison-preset-field button")),
                        dates: [...group.querySelectorAll("input")].filter(node => node.checkVisibility()).map(box),
                    })),
                    action: box(form.querySelector("#applyPeriodComparison")),
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    wide: getComputedStyle(form.querySelector(".comparison-date-field")).gridTemplateRows.startsWith("subgrid"),
                };
            });
            const prefix = `${theme}-${width}-${name}`;
            measurements.push({ name: prefix, ...value });
            baseline ??= value.groups.map(group => group.preset.y - group.legend.bottom);
            for (const [index, group] of value.groups.entries()) {
                check(Math.abs(group.preset.y - group.legend.bottom - baseline[index]) < 1,
                    prefix + ": the period choice keeps its label-to-control gap through selection");
                check(Math.abs(group.preset.x - group.legend.x) < 1, prefix + ": period title aligns with its choice");
                if (value.wide) check(group.dates.every(date => Math.abs(date.y - group.preset.y) < 1),
                    prefix + ": date fields share the preset baseline");
                else check(group.dates.every(date => date.y >= group.preset.bottom),
                    prefix + ": narrow date pairs follow their own preset");
                check([group.preset, ...group.dates].every(control => control.x >= 0 && control.right <= width + 1 && control.height >= 44),
                    prefix + ": complete native targets stay inside the viewport");
            }
            if (Math.abs(value.groups[0].y - value.groups[1].y) < 1)
                check(Math.abs(value.groups[0].preset.y - value.groups[1].preset.y) < 1, prefix + ": peer preset baselines align");
            check(value.action.y >= Math.max(...value.groups.map(group => group.bottom)), prefix + ": Compare follows both periods");
            check(value.overflow <= 1, prefix + ": no page overflow");
            if (output && (name === "preset-custom" || width === 1840 && theme === "dark"))
                await page.screenshot({ path: path.join(output, prefix + ".png") });
        }
    }
    if (output) await writeFile(path.join(output, "selector-geometry.json"), JSON.stringify(measurements, null, 2));
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, 0);
    assert.deepEqual(failures, []);
    if (process.env.WIRE_SELECTOR_TASTE_SCRIPT) {
        assert.ok(output, "Taste inspection requires an explicit proof directory");
        const inspection = await new Promise(resolve => execFile(process.execPath,
            [process.env.WIRE_SELECTOR_TASTE_SCRIPT, "--app", page.url(), "--out", path.join(output, "taste"),
                "--allow", process.env.WIRE_SELECTOR_TASTE_ALLOW || ""],
            { encoding: "utf8", timeout: 45000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
        await writeFile(path.join(output, "taste-output.txt"), (inspection.stdout || "") + (inspection.stderr || ""));
        if (inspection.error) throw inspection.error;
    }
});

test("localized period summaries wrap without displacing controls and preset keyboard interaction survives", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze", { locale: "ca-ES" });
    const output = process.env.WIRE_SELECTOR_LAYOUT_PROOFS;
    await page.clock.setFixedTime(new Date("2026-10-26T15:00:00Z"));
    await enterComparison(page);
    await expect(page.getByRole("group", { name: "Period A", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Period B", exact: true })).toBeVisible();
    await selectActivityOption(page, "comparisonAPreset", "previous-month");
    await selectActivityOption(page, "comparisonBPreset", "this-month");
    const summary = page.locator(".comparison-preset-range").first();
    await expect(summary).toContainText("de set. del 2026");
    for (const reducedMotion of ["reduce", "no-preference"]) {
        await page.emulateMedia({ reducedMotion });
        await page.locator("#comparisonAPreset-control").focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".select-popup:visible")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
        await expect(page.locator("#comparisonAPreset")).toHaveValue("previous-month");
    }
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await settleLayout(page);
    const geometry = await summary.evaluate(node => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        textOverflow: node.scrollWidth - node.clientWidth,
        lines: node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
    }));
    assert.ok(geometry.lines > 1 && geometry.textOverflow <= 1 && geometry.overflow <= 1, JSON.stringify(geometry));
    if (output) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, "localized-narrow-200.png"), fullPage: true });
    }
    await selectActivityOption(page, "comparisonAPreset", "custom");
    await page.locator("#comparisonAFrom").fill("");
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#comparisonAFrom")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Choose a valid start and end date");
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, 0);
    await page.locator("#comparisonAFrom").fill("2026-10-31");
    await page.locator("#comparisonATo").fill("2026-10-01");
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Start date must not follow end date");
    assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, 0);
    await page.locator("#periodComparisonStatus").scrollIntoViewIfNeeded();
    if (output) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, "invalid-narrow-200.png"), fullPage: true });
    }
});

test("latency keeps a measured zero and withholds single-sample tails", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#comparePeriods").click(); await fillPeriods(page); await compare(page);
    await selectActivityOption(page, "outcomeFilter", "failure");
    await expect(page.locator(".compare-latency tbody tr").first().locator(".compare-number")).toHaveText(["0 ms", "3,000 ms"]);
    const tail = page.locator(".compare-latency tbody tr").nth(1);
    await expect(tail.locator(".compare-number")).toHaveText(["Not shown (one timing)", "Not shown (one timing)"]);
    await expect(tail.locator(".compare-better,.compare-worse")).toHaveCount(0);
    await expect(tail).toContainText("Cannot compare");
});

test("comparison record return keeps the exact reading position after the accepted result arrives", { timeout: 30000 }, async t => {
    const { page } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await page.locator("#comparePeriods").click();
    await fillPeriods(page);
    await compare(page);
    const disclosure = page.locator('[data-period-side="baseline"] details').filter({ hasText: "Exact matching records" });
    if (await disclosure.count()) await disclosure.locator("summary").click();
    const target = page.locator("#periodComparisonResults a:visible").first();
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    const position = () => page.evaluate(() => {
        const href = document.activeElement.getAttribute("href");
        const [view, query] = href?.split("?") ?? [];
        const params = new URLSearchParams(query); params.sort();
        return { y: scrollY, focusedHref: href ? `${view}?${params}` : null };
    });
    const before = await position(), box = await target.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#contextSidebar")).toBeVisible();
    if (proof) {
        await mkdir(proof, { recursive: true });
        await settleLayout(page);
        await page.screenshot({ path: path.join(proof, "record-reader-desktop.png") });
    }
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect.poll(position).toEqual(before);
});

test("exact late-record Close and Back preserve the native roster scroller and selected target", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await enterComparison(page);
    await fillPeriods(page); await compare(page);
    const target = page.locator('[data-period-side="baseline"] tbody tr').last().locator("a");
    const position = () => page.evaluate(() => ({
        y: scrollY, focus: document.activeElement.id,
        inner: document.querySelector("#comparison-record-scroll-A").scrollTop,
    }));
    for (const action of ["close", "back"]) {
        await target.scrollIntoViewIfNeeded(); await target.focus();
        const before = await position(), box = await target.boundingBox();
        assert.ok(before.inner > 0, "The selected record must be below the initial roster viewport");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.locator("#contextSidebar")).toBeVisible();
        if (proof) {
            await mkdir(proof, { recursive: true });
            await settleLayout(page);
            await page.screenshot({ path: path.join(proof, `${action}-late-record-reader.png`) });
        }
        if (action === "close") await page.locator("#closeContextSidebar").click();
        else await page.goBack();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await expect(page.locator("#createPeriodReport")).toBeVisible();
        await expect.poll(position).toEqual(before);
        await expect(page.locator("#comparisonRecordsA")).toHaveAttribute("aria-selected", "true");
        if (proof) await page.screenshot({ path: path.join(proof, `${action}-late-record-return.png`) });
    }
});

test("newer reading input cancels a pending comparison-origin restoration", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await enterComparison(page); await fillPeriods(page); await compare(page);
    const link = page.locator('[data-period-side="baseline"] tbody tr').last().locator("a");
    await link.scrollIntoViewIfNeeded(); await link.focus();
    const box = await link.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#contextSidebar")).toBeVisible();
    let entered, release;
    const held = new Promise(resolve => { entered = resolve; });
    t.after(() => release?.());
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch();
        await new Promise(resolve => { release = resolve; entered(); });
        await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#closeContextSidebar").click(); await held;
    await page.mouse.move(350, 700); await page.mouse.wheel(0, -200);
    const position = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() =>
        resolve({ y: scrollY, focus: document.activeElement.id })))));
    const before = await position();
    release();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    assert.deepEqual(await position(), before);
});

test("accepted comparison presents outcome shares and both timed distributions without conflating coverage", { timeout: 30000 }, async t => {
    const { records } = periodFixture(), faster = records[2].toolCalls[0];
    records[1].title = "Recorded fetch scenario";
    faster.durationMs = 50; faster.completedAt = new Date(Date.parse(faster.startedAt) + faster.durationMs).toISOString();
    const { page } = await setup(t, "#analyze", { records });
    await page.locator("#comparePeriods").click();
    await fillPeriods(page);
    const value = await compare(page);
    await expect(page.getByRole("heading", { name: "Call results", exact: true })).toBeVisible();
    await expect(page.locator(".compare-latency h3")).toHaveText("Tool latency");
    await expect(page.locator(".compare-outcomes .compare-finding")).toContainText("25.00% of calls failed");
    await expect(page.locator(".compare-outcomes .compare-finding + p")).toContainText("Up from 20.00%");
    await expect(page.locator(".compare-outcome-values")).toContainText("3 (60.00%)");
    await expect(page.locator(".compare-outcome-bar")).toHaveCount(2);
    await expect(page.locator(".compare-outcome-values thead .compare-outcome-bar")).toHaveCount(2);
    for (const [i, side] of Object.values(value.periods).entries()) {
        const bar = page.locator(".compare-outcome-bar").nth(i);
        await expect(bar).toHaveAttribute("aria-label", new RegExp(`Tool completed ${side.analytics.totals.success}`));
        const widths = await bar.locator("[data-outcome]").evaluateAll(nodes => nodes.map(node => [node.dataset.outcome, parseFloat(node.style.width)]));
        for (const [outcome, width] of widths) assert.equal(width, side.analytics.totals[outcome] * 100 / side.rowIds.length);
    }
    await expect(page.locator(".compare-latency svg")).toHaveCount(0);
    await expect(page.locator(".compare-latency tbody tr")).toHaveCount(3);
    await expect(page.locator(".compare-latency")).toContainText("\u221250 ms faster");
    await expect(page.locator(".compare-latency")).toContainText("+4,000 ms (+4 s) slower");
    const cells = await page.locator(".compare-values-table th,.compare-values-table td,.compare-values-table .compare-number,.compare-values-table .compare-value-detail")
        .evaluateAll(nodes => nodes.map(node => {
            const style = getComputedStyle(node);
            return { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, align: style.textAlign };
        }));
    assert.ok(cells.every(cell => cell.font === cells[0].font && cell.size === cells[0].size
        && cell.weight === cells[0].weight && cell.align === "left"));
    await expect(page.locator(".compare-latency")).toContainText(`${value.periods.later.analytics.totals.duration.sampleCount} of ${value.periods.later.rowIds.length}`);
    await expect(page.getByRole("heading", { name: "Timing of the full interactions", exact: true })).toBeVisible();
    await expect(page.locator(".compare-full-timing")).toContainText("even outside these dates or filters");
    const genericRow = page.locator('#comparisonExactRecordsA tbody tr').filter({
        has: page.getByRole("link", { name: /workiq-fetch, Recorded fetch scenario,/ }),
    });
    await expect(genericRow).toHaveCount(1);
    await expect(genericRow.locator(".compare-record-context")).toHaveCount(0);
    await expect(page.locator("#comparisonExactRecordsA .compare-record-context").first()).toHaveText("Synthetic calendar request");
    await page.locator("#comparisonRecordsB").click();
    await expect(page.locator('[data-period-side="later"]')).toBeVisible();
    await expect(page.locator('[data-period-side="baseline"]')).toBeHidden();
    assert.equal(await page.locator('[data-period-side="later"] tbody tr').count(), value.periods.later.rowIds.length);
    await capture(page, "comparison-tradeoff");
});

test("explicit comparison completion moves attention to accepted results without a second navigation action", { timeout: 30000 }, async t => {
    const { page } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await page.locator("#comparePeriods").click();
    const observations = [];
    let comparison;
    for (const [width, height, theme] of [[375, 812, "light"], [1440, 1000, "dark"]]) {
        await page.setViewportSize({ width, height }); await chooseTheme(page, theme);
        await fillPeriods(page);
        await page.locator("#applyPeriodComparison").focus();
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `submit-${width}-before.png`) });
        }
        if (width === 375) {
            const response = page.waitForResponse(response => response.url().endsWith("/api/period-comparison") && response.ok());
            await page.locator("#applyPeriodComparison").click();
            comparison = await (await response).json();
            await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
        } else comparison = await compare(page);
        const observation = await page.evaluate(() => {
            const rect = id => {
                const { top, bottom } = document.getElementById(id).getBoundingClientRect();
                return { top, bottom };
            };
            return { width: innerWidth, height: innerHeight, scrollY, focus: document.activeElement.id,
                title: rect("periodComparisonResultsTitle"), report: rect("createPeriodReport") };
        });
        observations.push(observation);
        if (proof) await page.screenshot({ path: path.join(proof, `submit-${width}-after.png`) });
    }
    if (proof) await writeFile(path.join(proof, "submit-attention.json"), JSON.stringify(observations, null, 2));
    for (const observation of observations) {
        assert.equal(observation.focus, "periodComparisonResultsTitle", JSON.stringify(observation));
        assert.ok(observation.title.top >= 0 && observation.title.bottom <= observation.height, JSON.stringify(observation));
        assert.ok(observation.report.top >= 0 && observation.report.bottom <= observation.height, JSON.stringify(observation));
    }
    await page.locator("#createPeriodReport").evaluate(node => node.focus({ preventScroll: true }));
    const reportOrigin = await page.evaluate(() => ({ url: location.href, y: scrollY, focus: document.activeElement.id }));
    const reportButton = await page.locator("#createPeriodReport").boundingBox();
    await page.mouse.click(reportButton.x + reportButton.width / 2, reportButton.y + reportButton.height / 2);
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator('[data-period-report-side="baseline"]')).toContainText("4 matching Work IQ tool calls");
    await expect(page.locator('[data-period-report-side="later"]')).toContainText("4 matching Work IQ tool calls");
    await reportContents(page);
    await expect(page.locator("#formatOptions input[value=pdf]")).not.toBeChecked();
    await page.locator('[name=promptMode][value=none]').check();
    for (const format of ["pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await response).json();
    assert.equal(preview.error, undefined);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, comparison.comparison);
    const documentTask = getDocument({ data: new Uint8Array(Buffer.from(preview.files["product-report.pdf"].data, "base64")),
        useSystemFonts: false, disableFontFace: true });
    try {
        const document = await documentTask.promise;
        const last = (await (await document.getPage(document.numPages)).getTextContent()).items.map(item => item.str ?? "").join(" ");
        assert.ok(!last.includes("Interpretation") || last.includes("Timing method") || last.includes("Record "),
            "The short-group period report must not strand Interpretation and its footer");
    } finally { await documentTask.destroy(); }
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.frameLocator(".report-frame").getByRole("heading", { name: "Recorded outcomes", exact: true })).toBeVisible();
    await expect(page.locator("input[data-review-control]")).not.toBeChecked();
    if (proof) {
        await settleLayout(page);
        await page.screenshot({ path: path.join(proof, "html-review-viewport.png") });
        await mkdir(path.join(proof, "report"), { recursive: true });
        for (const [name, contents] of Object.entries(preview.files)) await writeFile(path.join(proof, "report", name),
            typeof contents === "string" ? contents : Buffer.from(contents.data, "base64"));
    }
    await page.goBack();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({ url: location.href, y: scrollY, focus: document.activeElement.id }))).toEqual(reportOrigin);
    await expect(page.locator("#comparisonRecordsA")).toContainText("(4)");
    await expect(page.locator("#comparisonRecordsB")).toContainText("(4)");
    if (proof) {
        await settleLayout(page);
        await page.screenshot({ path: path.join(proof, "report-return.png") });
        await writeFile(path.join(proof, "report-return.json"), JSON.stringify(reportOrigin, null, 2));
    }
});

test("pending comparison respects subsequent reading and editing while automatic refinements never move focus", { timeout: 30000 }, async t => {
    const { page } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await page.setViewportSize({ width: 375, height: 812 });
    await enterComparison(page);
    let release;
    t.after(() => release?.());
    async function holdComparison() {
        let entered;
        const pending = new Promise(resolve => { entered = resolve; });
        await page.route("**/api/period-comparison", async route => {
            const response = await route.fetch();
            await new Promise(resolve => { release = resolve; entered(); });
            await route.fulfill({ response });
        }, { times: 1 });
        return { pending };
    }
    const position = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        focus: document.activeElement.id, y: scrollY,
    })))));
    const observations = [];
    for (const action of ["wheel", "keyboard-scroll", "date-edit"]) {
        await fillPeriods(page);
        const { pending } = await holdComparison();
        await page.locator("#applyPeriodComparison").focus(); await page.keyboard.press("Enter");
        await pending;
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Reading both periods...");
        if (action === "date-edit") await page.getByLabel("Period B to", { exact: true }).fill("2026-03-10");
        else {
            const settled = page.evaluate(() => new Promise(resolve => document.addEventListener("scrollend", resolve, { once: true })));
            if (action === "wheel") { await page.mouse.move(350, 750); await page.mouse.wheel(0, 260); }
            else await page.keyboard.press("PageDown");
            await settled;
        }
        const before = await position();
        release();
        if (action === "date-edit") {
            await expect(page.locator("#periodComparisonStatus")).toContainText("Dates changed");
            await expect(page.locator("#periodComparisonResults")).toBeEmpty();
        } else await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
        const after = await position();
        assert.equal(after.focus, before.focus, action);
        assert.ok(Math.abs(after.y - before.y) <= 1, JSON.stringify({ action, before, after }));
        observations.push({ action, before, after });
    }
    await fillPeriods(page); await compare(page);
    const { pending } = await holdComparison();
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await pending;
    const before = await position();
    release();
    await expect(page.locator('[data-period-side="baseline"] tbody tr')).toHaveCount(2);
    await expect(page.locator('[data-period-side="later"] tbody tr')).toHaveCount(2);
    const after = await position();
    assert.equal(after.focus, "promptAuthorFilter-control");
    assert.equal(after.focus, before.focus);
    assert.ok(Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }));
    observations.push({ action: "automatic-author-refinement", before, after });
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "no-attention-steal.json"), JSON.stringify(observations, null, 2));
    }
});

test("normal-root paired controls validate dates, show only accepted results and preserve Analyze on Stop", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t, "#analyze?from=2026-03-07&to=2026-03-07&services=Files&includeMissingService=true");
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#periodComparisonStatus")).toBeHidden();
    assert.ok(await page.locator("#analyzePopulation #periodComparisonSetup").count());
    await expect(page.locator("#periodComparisonSetup #filters")).toHaveCount(0);
    await expect(page.locator("#comparisonDateHint")).toHaveText("Start and end dates are included.");
    await expect(page.locator("#comparisonDateHint")).toHaveClass("visually-hidden");
    await expect(page.locator("#periodComparisonSetup")).not.toContainText("All authors");
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Choose a valid start and end date for both periods.");
    assert.equal(requests.filter(item => item.path === "/api/period-comparison").length, 0);
    await fillPeriods(page, ["2026-03-09", "2026-03-07"]);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Period A: Start date must not follow end date.");
    await expect(page.getByLabel("Period A from", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Period B from", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
    await fillPeriods(page);
    const value = await compare(page);
    assert.deepEqual([value.periods.baseline.rowIds.length, value.periods.later.rowIds.length], [4, 4]);
    assert.equal(value.periods.later.dateRange.to, "2026-03-10T04:00:00.000Z");
    assert.equal(value.periods.later.dateRange.toExclusive, true);
    await expect(page.locator("#periodComparisonResultsTitle")).toBeFocused();
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    const options = await page.locator(".select-popup .select-option").evaluateAll(nodes => nodes.map(node => ({
        value: node.dataset.value, count: node.querySelector(".select-option-count")?.textContent,
    })));
    for (const option of options) assert.equal(option.count,
        `A: ${value.periods.baseline.analytics.resultFacet.totals[option.value]}; B: ${value.periods.later.analytics.resultFacet.totals[option.value]}`);
    await page.keyboard.press("Escape");
    await expect(page.locator("#outcomeFilter-control")).toBeFocused();
    await page.locator("#closeAnalyzeFilters").click();
    await expect(page.locator("#analyzeFilterDialog")).toBeHidden();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#periodComparisonStatus")).toHaveClass("visually-hidden");
    await expect(page.locator(".compare-latency")).toContainText("3,000 ms");
    await expect(page.locator(".compare-latency")).toContainText("2 of 4");
    await expect(page.locator("#periodComparison")).toContainText("even outside these dates or filters");
    await page.getByLabel("Period A to", { exact: true }).fill("2026-03-08");
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#outcomeFilter-control")).not.toContainText("A:");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Dates changed");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.getByLabel("Period A to", { exact: true })).toHaveValue("2026-03-08");
    await page.keyboard.press("Escape");
    await fillPeriods(page);
    await compare(page);
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await expect(page.locator('[data-period-side="baseline"] tbody tr')).toHaveCount(2);
    await expect(page.locator('[data-period-side="later"] tbody tr')).toHaveCount(2);
    await expect(page.locator("#filterChips")).toContainText("Author:");
    await expect(page.locator("#filterChips")).toContainText("missing service details");
    await page.locator("#closeAnalyzeFilters").click();
    await expect(page.locator("#analyzeFilterDialog")).toBeHidden();
    await page.locator('nav [data-nav="analyze"]:visible').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#comparePeriods")).toBeFocused();
    await expect(page.locator("#periodComparisonSetup")).toBeHidden();
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    const route = new URLSearchParams(page.url().split("?")[1]);
    assert.equal(route.get("from"), "2026-03-07"); assert.equal(route.get("to"), "2026-03-07");
    assert.equal(route.get("services"), "Files"); assert.equal(route.get("includeMissingService"), "true");
    assert.equal(route.get("authors"), "user");
    await page.locator("#closeAnalyzeFilters").click();
    await page.locator("#comparePeriods").click();
    await expect(page.getByLabel("Period A from", { exact: true })).toHaveValue("2026-03-07");
    assert.ok(requests.filter(item => item.path === "/api/period-comparison").every(item => item.input.options.filters.from === undefined));
});

test("normal-root empty sides, pending reads and read errors never offer an invalid report", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#comparePeriods").click();
    await fillPeriods(page, ["2025-03-07", "2025-03-07"]);
    await compare(page);
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("No matching activity was found");
    await expect(page.locator('[data-period-side="baseline"] details')).toHaveCount(0);
    await expect(page.locator("#periodComparison")).toContainText("Not applicable");
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await fillPeriods(page, ["2025-03-07", "2025-03-07"], ["2025-03-08", "2025-03-09"]);
    await compare(page);
    await expect(page.locator("#periodComparison")).toContainText("No activity was found in either period");
    await expect(page.locator("#periodComparisonResults table")).toHaveCount(0);
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await capture(page, "empty");
    let release, entered;
    const held = new Promise(resolve => { entered = resolve; });
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch();
        entered(); await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response });
    }, { times: 1 });
    t.after(() => release?.());
    await fillPeriods(page);
    await page.locator("#applyPeriodComparison").click();
    await held;
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Reading both periods...");
    await expect(page.locator("#periodComparisonResults")).toHaveText("Reading both periods...");
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await capture(page, "pending");
    release();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await page.route("**/api/period-comparison", route => route.fulfill({
        status: 409, contentType: "application/json", body: JSON.stringify({ error: "Stored evidence changed. Read the current Analyze view." }),
    }), { times: 1 });
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Stored evidence changed");
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.locator("#periodComparisonResults table")).toHaveCount(0);
    await capture(page, "error");
    await page.getByRole("button", { name: "Retry comparison read", exact: true }).click();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
});

test("normal-root global Search leaves the comparison unchanged and unavailable explicit Search blocks it", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t, "#analyze", { pairChanges: true });
    await page.locator("#comparePeriods").click();
    await fillPeriods(page);
    const value = await compare(page), reads = () => requests.filter(item => item.path === "/api/period-comparison").length;
    const acceptedReads = reads();
    const pairKey = await page.evaluate(() => window.periodComparisonOwner.acceptedPair().key);
    await page.route("**/api/search/query", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Local search unavailable." }),
    }));
    await page.locator("#wireSearch").fill("workiq-fetch");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    assert.equal(reads(), acceptedReads);
    assert.deepEqual(await page.evaluate(() => {
        const pair = window.periodComparisonOwner.acceptedPair();
        return { key: pair.key, hasSearch: pair.scope.hasSearch };
    }), { key: pairKey, hasSearch: false });
    await expect(page.locator('[data-period-side="baseline"] tbody tr')).toHaveCount(value.periods.baseline.rowIds.length);
    await page.keyboard.press("Escape");
    await page.locator("#wireSearch").click();
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.locator("#wireSearch").focus();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status before comparing");
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    assert.equal(await page.evaluate(() => window.periodComparisonOwner.acceptedPair()), null);
    assert.equal(await page.evaluate(() => window.periodPairEvents.filter(event => event.kind === "pair").at(-1).description), null);
    assert.equal(reads(), acceptedReads);
    await expect(page.locator("#wireSearch")).toHaveValue("workiq-fetch");
    await capture(page, "search-unavailable");
});

test("normal-root comparison keeps controls and complete results reachable in both themes and narrow 200% text", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#comparePeriods").click();
    const layouts = [];
    for (const populated of [false, true]) {
        if (populated) { await fillPeriods(page); await compare(page); }
        for (const [width, height, scale] of [[1440, 1000, 1], [1024, 650, 1], [390, 844, 2]]) {
            for (const theme of ["light", "dark"]) {
                await page.setViewportSize({ width, height }); await chooseTheme(page, theme);
                await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
                const geometry = await page.locator("#periodComparisonSetup").evaluate(node => ({
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    fields: [...node.querySelectorAll("input[type=date]")].map(input => {
                        const rect = input.getBoundingClientRect();
                        return { left: rect.left, right: rect.right, height: rect.height };
                    }),
                }));
                assert.ok(geometry.overflow <= 1, JSON.stringify(geometry));
                assert.equal(geometry.fields.length, 4);
                assert.ok(geometry.fields.every(field => field.left >= 0 && field.right <= width && field.height >= 44));
                await expect(page.locator("#comparisonDateHint")).toHaveClass("visually-hidden");
                for (const selector of ["#applyPeriodComparison", "#periodComparisonSetup button:first-of-type", ...(populated ? ["#createPeriodReport"] : [])]) {
                    await page.locator(selector).first().focus();
                    await expect(page.locator(selector).first()).toBeFocused();
                }
                if (populated) {
                    await expect(page.getByRole("heading", { name: "Call results", exact: true })).toBeVisible();
                    await expect(page.locator(".compare-outcome-bar")).toHaveCount(2);
                    const frame = await page.locator("#analyzePopulation,#periodComparison").evaluateAll(nodes =>
                        nodes.map(node => { const box = node.getBoundingClientRect(); return [box.left, box.right]; }));
                    assert.ok(frame.every(([left, right]) => Math.abs(left - frame[0][0]) < 1 && Math.abs(right - frame[0][1]) < 1),
                        "Compare setup and results must share one bounded frame");
                    const columns = await page.locator(".compare-values-table tbody tr").evaluateAll(rows => rows.map(row =>
                        [...row.querySelectorAll("td")].map(cell => {
                            const value = cell.querySelector(".compare-number").getBoundingClientRect(), box = cell.getBoundingClientRect();
                            return { top: value.top, width: box.width, fits: value.left >= box.left - 1 && value.right <= box.right + 1 };
                        })));
                    assert.ok(columns.every(row => row.every(cell => cell.fits) && Math.abs(row[0].top - row[1].top) < 1),
                        `Period values must align below wrapped column labels: ${JSON.stringify(columns)}`);
                    if (width === 390) assert.ok(columns.every(row => Math.abs(row[0].width - row[1].width) < 1),
                        "Narrow period values must each use their full half-row, not the desktop column widths");
                }
                layouts.push({ populated, width, height, scale, theme, ...geometry });
                await capture(page, `${populated ? "populated" : "initial"}-${theme}-${width}-${scale}`);
                if (proof && populated && width === 390) for (const selector of [".compare-outcomes", ".compare-latency", ".compare-full-timing"]) {
                    await page.locator(selector).screenshot({ path: path.join(proof, `${selector.slice(1)}-${theme}-390-${scale}.png`),
                        style: ".app-header,.skip-link{visibility:hidden!important}" });
                }
            }
        }
    }
    if (proof) await writeFile(path.join(proof, "layout.json"), JSON.stringify(layouts, null, 2));
});

test("long interaction names and different-year periods remain readable at narrow enlarged text", { timeout: 30000 }, async t => {
    const { records } = periodFixture();
    const title = "Recorded interaction with extended project context ".repeat(8).trim();
    for (const record of records) record.title = title;
    const { page } = await setup(t, "#analyze", { records });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#navigationToggle").click();
    await page.locator("#comparePeriods").click();
    await expect.poll(() => page.evaluate(() => document.activeElement.id)).toBe("comparisonAPreset-control");
    await fillPeriods(page, ["2025-01-01", "2025-12-31"], ["2026-03-07", "2026-03-07"]);
    const value = await compare(page);
    assert.equal(value.periods.baseline.rowIds.length, 0);
    await expect(page.locator("#periodComparisonResultsTitle")).toContainText("2025");
    await expect(page.locator("#periodComparisonResultsTitle")).toContainText("2026");
    await page.locator("#comparisonRecordsB").click();
    const context = page.locator("#comparisonExactRecordsB .compare-record-context").first();
    await expect(context).toHaveText(title);
    assert.ok(await context.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const rows = await page.locator(".compare-latency tbody tr").evaluateAll(items => items.map(row => [...row.querySelectorAll("td .compare-number")].map(node => node.getBoundingClientRect().top)));
    assert.ok(rows.every(row => Math.abs(row[0] - row[1]) < 1));
    const exact = page.locator("#comparisonExactRecordsB a").first();
    const normalize = href => {
        const [view, query] = href.split("?"), params = new URLSearchParams(query);
        params.sort(); return view + "?" + params;
    };
    const href = normalize(await exact.getAttribute("href"));
    await exact.scrollIntoViewIfNeeded(); await exact.focus();
    const box = await exact.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await expect(exact).toBeFocused();
    assert.equal(normalize(await exact.getAttribute("href")), href);
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await page.locator(".compare-latency").screenshot({ path: path.join(proof, "different-years-latency-390-2.png"),
            style: ".app-header,.skip-link{visibility:hidden!important}" });
        await page.locator(".compare-evidence").screenshot({ path: path.join(proof, "long-evidence-390-2.png"),
            style: ".app-header,.skip-link{visibility:hidden!important}" });
    }
});

for (const width of [1440, 390]) for (const motion of ["reduce", "no-preference"]) for (const activation of ["mouse", "Enter", "Space"]) {
    test(`comparison entry follows its completed navigation: ${width}, ${motion}, ${activation}`, { timeout: 30000 }, async t => {
        const { page, requests } = await setup(t, "#analyze?range=all", { ownerApi: true });
        await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: motion });
        if (width === 390) await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await enterComparison(page, activation);
        await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
        assert.deepEqual(await page.locator("#periodComparisonSetup input[type=date]").evaluateAll(nodes => nodes.map(node => node.value)), ["", "", "", ""]);
        assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, 0);
        await fillPeriods(page);
        await page.evaluate(() => window.periodComparisonOwner.update());
        await expect(page.locator("#comparisonBTo")).toBeFocused();
        assert.deepEqual(await page.locator("#periodComparisonSetup input[type=date]").evaluateAll(nodes => nodes.map(node => node.value)),
            ["2026-03-07", "2026-03-07", "2026-03-08", "2026-03-09"]);
    });
}

for (const action of ["none", "focus", "wheel", "PageDown", "focus away and back", "navigation"]) {
    test(`comparison entry pending navigation yields to newer ${action}`, { timeout: 30000 }, async t => {
        const { page, requests } = await setup(t, "#analyze?range=custom&from=2026-03-07&to=2026-03-07");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        let release, reads = 0;
        const held = new Promise(resolve => { release = resolve; });
        const handler = async route => {
            if (++reads === 2) await page.unroute("**/api/snapshot", handler);
            const response = await route.fetch(); await held; await route.fulfill({ response });
        };
        await page.route("**/api/snapshot", handler);
        try {
            if (await page.locator("#openAnalyzeFilters").count()) await page.locator("#openAnalyzeFilters").click();
            const firstRead = page.waitForRequest(request => request.url().endsWith("/api/snapshot"));
            await selectActivityOption(page, "dateFilter", "capture"); await firstRead;
            if (await page.locator("#closeAnalyzeFilters").count()) await page.locator("#closeAnalyzeFilters").click();
            const entryRead = page.waitForRequest(request => request.url().endsWith("/api/snapshot"));
            await enterComparison(page); await entryRead;
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
            const origin = await page.evaluate(() => document.activeElement.id);
            const beforeScroll = await page.evaluate(() => scrollY);
            if (action === "focus") await page.locator("#wireSearch").click();
            if (action === "wheel") { await page.mouse.move(220, 740); await page.mouse.wheel(0, 350); }
            if (action === "PageDown") await page.keyboard.press("PageDown");
            if (action === "wheel" || action === "PageDown") await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeScroll);
            if (action === "focus away and back") assert.deepEqual(await page.evaluate(id => {
                const trusted = [], capture = event => trusted.push(event.isTrusted);
                document.addEventListener("focusin", capture);
                document.getElementById("wireSearch").focus(); document.getElementById(id).focus();
                document.removeEventListener("focusin", capture);
                return trusted;
            }, origin), [true, true]);
            if (action === "navigation") {
                await page.locator("#navigationToggle").click();
                await page.locator('nav [data-nav="reports"]:visible').click();
                await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            }
            const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
            release(); await response;
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await settleLayout(page);
            if (action === "none") {
                await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
                assert.deepEqual(await page.locator("#periodComparisonSetup input[type=date]").evaluateAll(nodes => nodes.map(node => node.value)), ["", "", "", ""]);
            } else if (action === "navigation") {
                assert.equal(await page.evaluate(() => location.hash.startsWith("#reports")), true);
                await expect(page.locator("#periodComparisonSetup")).toBeHidden();
            } else if (origin === "comparePeriods" && action !== "focus" && !await page.locator("#comparePeriods").isVisible()) {
                // The standalone toolbar disappears; cancellation must not focus the new form.
                await expect(page.locator("body")).toBeFocused();
            } else await expect(page.locator("#" + (action === "focus" ? "wireSearch" : origin))).toBeFocused();
            assert.equal(requests.filter(request => request.path === "/api/period-comparison").length, 0);
        } finally { release(); }
    });
}
