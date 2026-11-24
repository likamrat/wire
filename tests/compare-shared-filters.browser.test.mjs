import test from "node:test";
import { openDatePicker } from "./analytics-date-picker.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, selectActivityOption, closeAnalyzeFilters, chooseTheme, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

const longProject = "Invented coastal research workspace for shared release planning and cross-team evidence review";

async function setup(t, { longNames = false, analyzeSearch } = {}) {
    const cleanup = [], { records } = periodFixture();
    if (longNames) for (const record of records) {
        record.projectId = "paired-scope-project";
        record.project = longProject;
    }
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context), requests = [], errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("Providers are forbidden in shared-filter proof."); },
            readSource() { throw Error("Source reads are forbidden in shared-filter proof."); },
        } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/report-artifacts/list",
            "/api/search/query", "/api/search/status", "/api/search/events", "/api/search/cancel", "/api/session", "/api/session/release",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        requests.push({ path: url.pathname, input: request.method() === "POST" ? request.postDataJSON() : null });
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#analyze?range=custom&from=2026-03-07&to=2026-03-07");
    await ready(page);
    await page.evaluate(() => {
        window.originalFilterFields = [...document.querySelectorAll("#filters select")];
    });
    if (analyzeSearch) await restoreLegacySearch(page, analyzeSearch);
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    return { page, runtime, requests, comparisons: () => requests.filter(value => value.path === "/api/period-comparison") };
}

async function fillPeriods(page, year = "2026") {
    const panel = await openDatePicker(page, "compare", "Custom dates");
    for (const [id, value] of Object.entries({ comparisonAFrom: `${year}-03-07`, comparisonATo: `${year}-03-07`,
        comparisonBFrom: `${year}-03-08`, comparisonBTo: `${year}-03-09` })) await panel.locator("#" + id).fill(value);
}
async function compare(page) {
    await closeAnalyzeFilters(page);
    const response = page.waitForResponse(value => value.url().endsWith("/api/period-comparison") && value.ok());
    await page.locator("#comparisonCustomDates").getByRole("button", { name: "Apply dates", exact: true }).click();
    const value = await (await response).json();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    return value;
}
// Paired refinements commit each choice. Unlike Analyze, there is no Apply
// inside the outcome/author list, and the service selector allows a union.
async function toggleChoice(page, id, value) {
    await page.locator(`#${id}-control`).click();
    await page.locator(`.select-popup:visible [data-value=${JSON.stringify(value)}]`).click();
}
async function refine(page, id, value) {
    const applied = page.waitForResponse(r => r.url().endsWith("/api/period-comparison") && r.ok());
    await toggleChoice(page, id, value);
    const result = await (await applied).json();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    return result;
}
async function keepOnly(page, id, value) {
    const selected = await page.locator(`#${id}`).evaluate(node => [...node.selectedOptions].map(o => o.value));
    assert.ok(selected.includes(value));
    let result;
    for (const item of selected.filter(item => item !== value)) result = await refine(page,id,item);
    return result;
}
async function ordinary(page) {
    await closeAnalyzeFilters(page);
    const entry = page.locator('.primary-navigation [data-nav="analyze"]');
    if (!await entry.isVisible()) await page.locator("#navigationToggle").click();
    await entry.click(); await ready(page);
    await expect(page.locator("#periodComparisonSetup")).not.toBeVisible();
}
async function noOrdinaryAuthority(page, activeCount = 0) {
    const entry = page.locator("#openAnalyzeFilters");
    await expect(entry).not.toHaveAccessibleDescription(/Mar 7|Current collection/);
    if (activeCount) {
        const caption = page.locator("#comparisonAcceptedScope");
        await expect(caption).toBeVisible();
        await expect(entry).toHaveAccessibleDescription(await caption.textContent());
        const label = `${activeCount} ${activeCount === 1 ? "filter" : "filters"} applied`;
        await expect(entry).toHaveAccessibleName(label);
        await expect(entry).toHaveText(label);
    } else {
        await expect(entry).toHaveAccessibleName("Filters");
        await expect(entry).toHaveAccessibleDescription("");
        await expect(entry).toHaveText("Filters");
    }
}
async function capture(page, name, { top = false } = {}) {
    const proof = process.env.WIRE_COMPARE_FILTER_PROOFS;
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(async top => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (top) scrollTo(0, 0);
    }, top);
    await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
    await page.screenshot({ path: path.join(proof, name + "-full.png"), fullPage: true });
}

test("Compare keeps the same quiet filter entry and dialog without expanding filters in its date card", { timeout: 30000 }, async t => {
    const { page, comparisons } = await setup(t);
    const accepted = comparisons().map(r => r.input.periods);
    await expect(page.locator("#openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#filters")).not.toBeVisible();
    await expect(page.locator("#analyzePopulation #filters")).toHaveCount(0);
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator("#toolFilter-control")).toBeFocused();
    await expect(page.locator("#dateFilter-control")).not.toBeVisible();
    await expect(page.locator("#fromFilter")).not.toBeVisible();
    await expect(page.locator("#toFilter")).not.toBeVisible();
    await expect(page.locator("#analyzeViewControls")).not.toBeVisible();
    assert.equal(await page.locator("#dateFilter").evaluate(node => node.closest(".filter-field").inert), true);
    assert.equal(await page.locator("#dateFields").evaluate(node => node.inert), true);
    await expect(page.locator("#analyzeSourceContext")).not.toBeVisible();
    await noOrdinaryAuthority(page);
    await expect(page.locator("#openAnalyzeFilters")).not.toHaveAccessibleDescription(/Mar 7|Current collection|Search applied/);
    assert.equal(await page.evaluate(() => window.originalFilterFields.every(node => node === document.getElementById(node.id))), true);
    assert.equal(await page.locator("#filters").count(), 1);
    assert.equal(await page.locator("#filters").evaluate(node => node.closest("dialog")?.id), "analyzeFilterDialog");
    assert.equal(accepted.length, 1);
    assert.deepEqual(comparisons().map(r => r.input.periods), accepted, "Opening filters leaves the default pair alone");
    await page.keyboard.press("Escape");
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    await openDatePicker(page,"compare","Custom dates");
    await expect(page.locator("#comparisonAFrom")).toHaveValue(accepted[0].baseline.from);
    await expect(page.locator("#comparisonBTo")).toHaveValue(accepted[0].later.to);
    await expect(page.locator("#openChartReference")).toHaveCount(1);
    await expect(page.locator("#meaning")).toHaveCount(1);
});

test("Compare's shared filter entry and fields reflow in both themes at narrow and enlarged text", { timeout: 90000 }, async t => {
    const { page, comparisons } = await setup(t), measurements = [];
    const proof = process.env.WIRE_COMPARE_FILTER_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [390, 1], [390, 2]]) {
        await closeAnalyzeFilters(page);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            scrollTo(0, 0);
        });
        const name = `${theme}-${width}-${scale}`, entry = await page.locator("#openAnalyzeFilters").boundingBox();
        assert.ok(entry.width >= 44 && entry.height >= 44 && entry.x >= 0 && entry.x + entry.width <= width);
        await noOrdinaryAuthority(page);
        if (proof) await page.screenshot({ path: path.join(proof, `${name}-initial.png`) });
        await page.locator("#openAnalyzeFilters").click();
        await expect(page.locator("#toolFilter-control")).toBeFocused();
        if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFiltersToggle").click();
        const fields = [];
        for (const id of ["toolFilter", "comparisonServices", "outcomeFilter", "promptAuthorFilter",
            "serviceFilter", "projectFilter", "chatFilter", "layerFilter", "scopeFilter"]) {
            const control = page.locator("#" + id + "-control");
            await control.scrollIntoViewIfNeeded();
            const field = await control.evaluate(node => {
                const box = node.getBoundingClientRect(), text = node.querySelector(".select-value");
                return { id: node.id, x: box.x, right: box.right, height: box.height,
                    clipped: text.scrollWidth - text.clientWidth, verticalClip: text.scrollHeight - text.clientHeight };
            });
            assert.ok(field.x >= 0 && field.right <= width + 1 && field.height >= 44 && field.clipped <= 1 && field.verticalClip <= 1,
                name + " " + JSON.stringify(field));
            fields.push(field);
        }
        await page.locator("#toolFilter-control").focus();
        for (let index = 0; index < 14; index++) {
            assert.equal(await page.evaluate(() => ["dateFilter-control", "fromFilter", "toFilter"].includes(document.activeElement.id)), false);
            await page.keyboard.press("Tab");
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator("#analyzeFilterDialog").evaluate(node => { node.scrollTop = 0; });
        if (proof) await page.screenshot({ path: path.join(proof, `${name}-panel.png`) });
        measurements.push({ theme, width, scale, entry, fields });
        await page.keyboard.press("Escape");
        await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    }
    assert.equal(comparisons().length, 1);
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
});

test("real shared filter gestures preserve date drafts, both accepted periods and ordinary exit/Back", { timeout: 45000 }, async t => {
    const { page, comparisons } = await setup(t,{analyzeSearch:periodQuery});
    const prior = comparisons().length;
    await fillPeriods(page);
    assert.equal(comparisons().length, prior, "Typing dates did not submit either endpoint");
    await compare(page);
    await page.locator("#openAnalyzeFilters").click();
    await refine(page,"toolFilter","workiq-fetch");
    await refine(page,"comparisonServices","Files");
    await refine(page,"comparisonMissingService","true");
    await keepOnly(page,"outcomeFilter","failure");
    const value = await keepOnly(page,"promptAuthorFilter","user"), input = comparisons().at(-1).input;
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator('[data-edit-period="a"]')).toHaveAccessibleName(/Mar 7/);
    await expect(page.locator('[data-edit-period="b"]')).toHaveAccessibleName(/Mar 8.*9/);
    assert.deepEqual(input.periods, { baseline: { from: "2026-03-07", to: "2026-03-07" }, later: { from: "2026-03-08", to: "2026-03-09" } });
    assert.deepEqual(input.options.filters.tools, ["workiq-fetch"]);
    assert.deepEqual(input.options.filters.services, ["Files"]);
    assert.deepEqual(input.options.filters.promptAuthors, ["user"]);
    assert.deepEqual(input.options.filters.outcomes, ["failure"]);
    assert.equal(input.options.filters.includeMissingService, true);
    assert.deepEqual(value.periods.baseline.rowIds, ['call:["period-chat-0","period-call-0"]']);
    assert.deepEqual(value.periods.later.rowIds, ['call:["period-chat-2","period-call-2"]']);
    assert.ok(!JSON.stringify(input).includes(periodQuery));
    await closeAnalyzeFilters(page);
    await capture(page, "accepted-shared-filters", { top: true });
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator('#outcomeFilter option[value="success"]')).toContainText("A: 0; B: 1");
    await expect(page.locator('#outcomeFilter option[value="failure"]')).toContainText("A: 1; B: 1");
    await expect(page.locator("#comparisonMissingService")).toHaveValue("true");
    await noOrdinaryAuthority(page, 5);
    await ordinary(page);
    await expect(page.locator("#activitySearch")).toHaveValue(periodQuery);
    const query = new URLSearchParams(page.url().split("?")[1]);
    assert.equal(query.has("from") || query.has("to"), false);
    await expect(page.locator("#periodResult")).toContainText("Mar 7, 2026");
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    assert.equal(await page.locator("#dateFields").evaluate(node => node.inert), false);
    await selectActivityOption(page, "dateFilter", "custom");
    await expect(page.locator("#fromFilter")).toHaveValue("2026-03-07");
    await page.locator("#analyzeDates").getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Mar 7/);
    await closeAnalyzeFilters(page);
    await page.goBack(); await ready(page);
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#dateFilter-control")).not.toBeVisible();
    await expect(page.locator("#toolFilter")).toHaveValue("workiq-fetch");
    assert.ok(!page.url().includes(periodQuery));
    await noOrdinaryAuthority(page, 5);
});

test("pending and failed paired reads keep the shared panel and newer filter input intact", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page);
    const accepted = await compare(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
    }, { times: 1 });
    const requested = page.waitForRequest(value => value.url().endsWith("/api/period-comparison"));
    const calendar = await openDatePicker(page, "compare", "Custom dates");
    await calendar.getByRole("button", { name: "Apply dates", exact: true }).click(); await requested;
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#outcomeFilter-control").click();
    const popup = page.locator(".select-popup:visible");
    const draft = await popup.getByRole("option").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-selected")));
    await noOrdinaryAuthority(page);
    await capture(page, "pending-pair-newer-draft");
    release();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(popup).toBeVisible();
    assert.deepEqual(await popup.getByRole("option").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-selected"))), draft);
    await page.keyboard.press("Escape");
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await page.route("**/api/period-comparison", route => route.fulfill({ status: 503, json: { error: "Invented paired-read failure." } }), { times: 1 });
    await toggleChoice(page,"comparisonServices","Files"); await ready(page);
    await expect(page.locator("#periodComparisonStatus")).toContainText("Invented paired-read failure");
    await expect(page.locator("#analyzeFilterDialog")).toBeVisible();
    await expect(page.locator("#comparisonServices-control")).toBeFocused();
    await expect(page.locator("#periodComparisonResults .compare-outcomes")).toHaveCount(0);
    await expect(page.locator("#homeView")).not.toBeVisible();
    await expect(page.locator("#activityView")).not.toBeVisible();
    await noOrdinaryAuthority(page);
    await capture(page, "failed-pair-filter-panel");
    await closeAnalyzeFilters(page);
    const retry = page.waitForResponse(value => value.url().endsWith("/api/period-comparison") && value.ok());
    await page.getByRole("button", { name: "Retry comparison read", exact: true }).click();
    const recovered = await (await retry).json();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.deepEqual(recovered.periods.baseline.range, accepted.periods.baseline.range);
    assert.deepEqual(recovered.periods.later.range, accepted.periods.later.range);
    await expect(page.locator("#comparisonServices")).toHaveValues(["Files"]);
    await noOrdinaryAuthority(page, 1);
});

test("Reset filters clears Compare restrictions in place and retains both periods", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page);
    await compare(page);
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "toolFilter", "workiq-fetch"); await ready(page);
    await expect(page.locator("#resetView")).toBeVisible();
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator('[data-edit-period="a"]')).toHaveAccessibleName(/Mar 7/);
    await expect(page.locator('[data-edit-period="b"]')).toHaveAccessibleName(/Mar 8.*9/);
    await expect(page.locator("#openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#dateFilter-control")).toBeHidden();
    await expect(page.locator("#toolFilter")).toHaveValue("all");
    assert.equal(await page.locator("#dateFields").evaluate(node => node.inert), true);
});

test("native Search qualification and clearing keep the shared Compare filter entry truthful", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page); await compare(page);
    await page.locator("#wireSearch").fill(periodQuery);
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toContainText("Some saved text could not be searched");
    await expect(page.locator("#periodComparisonResults .compare-outcomes")).toHaveCount(0);
    await expect(page.locator("#homeView")).not.toBeVisible();
    await expect(page.locator("#activityView")).not.toBeVisible();
    await noOrdinaryAuthority(page);
    await page.locator("#wireSearch").press("Escape");
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#toolFilter-control")).toBeFocused();
    await noOrdinaryAuthority(page);
    await closeAnalyzeFilters(page);
    await page.locator("#wireSearch").fill("");
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#periodComparisonResults .compare-outcomes")).toBeVisible();
    await noOrdinaryAuthority(page);
    assert.equal(await page.locator("#wireSearch").count(), 1);
    assert.equal(await page.locator('#analyzeFilterDialog input[type="search"]').count(), 0);
});

test("Reset from Compare does not replace newer input while its ordinary read is pending", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page); await compare(page);
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "toolFilter", "workiq-fetch"); await ready(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
    }, { times: 1 });
    const pending = page.waitForRequest(request => request.url().endsWith("/api/snapshot"));
    await page.locator("#resetView").click(); await pending;
    await expect(page.locator("#analyzeFilterDialog")).not.toBeVisible();
    await page.locator("#wireSearch").click();
    release(); await ready(page);
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await noOrdinaryAuthority(page);
});

test("accepted restrictions stay visible with Filters closed and are withdrawn with invalidated paired results", { timeout: 30000 }, async t => {
    const { page, comparisons } = await setup(t);
    await fillPeriods(page); await compare(page);
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    await page.locator("#openAnalyzeFilters").click();
    const value = await keepOnly(page,"outcomeFilter","failure");
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await closeAnalyzeFilters(page);
    assert.ok(Object.values(value.periods).every(side => side.analytics.totals.count > 0
        && side.analytics.totals.failure === side.analytics.totals.count));
    await expect(page.locator(".comparison-outcome-values")).toContainText("20.00%");
    await expect(page.locator(".comparison-outcome-values")).toContainText("25.00%");
    const caption = page.locator("#comparisonAcceptedScope");
    await expect(caption).toBeVisible();
    await expect(caption).toHaveText("Outcome: Tool failed");
    await expect(caption).toHaveAttribute("data-revision", String(value.revision));
    await expect(caption).toHaveAttribute("data-pair-key", /^period:\d+$/);
    await expect(caption.locator("button,a,input")).toHaveCount(0);
    assert.equal(await caption.evaluate(node => node.tagName), "P");
    assert.ok(await caption.evaluate(node => {
        return node.parentElement.matches(".workspace-command-row") &&
            Boolean(node.compareDocumentPosition(document.querySelector(".compare-period-key")) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "Accepted restrictions accompany the commands above the period readings");
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(await caption.textContent());
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleName("1 filter applied");
    await expect(page.locator("#openAnalyzeFilters")).toHaveText("1 filter applied");
    await capture(page, "filtered-100-percent", { top: true });
    const key = await caption.getAttribute("data-pair-key"), reads = comparisons().length;
    await expect(page.locator("#activityUpdateToggle,#activityUpdateSlot")).toHaveCount(0);
    await expect(caption).toHaveAttribute("data-pair-key", key);
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription("Outcome: Tool failed");
    assert.equal(comparisons().length, reads, "Ordinary status presentation does not replace paired authority or query again");
    await openDatePicker(page,"compare","Custom dates");
    await page.locator("#comparisonATo").fill("2026-03-08");
    await expect(caption).toHaveAttribute("data-pair-key",key);
    assert.equal(comparisons().length,reads,"Unapplied dates do not invalidate the accepted reading");
    await compare(page);
    await expect(caption).toHaveText("Outcome: Tool failed");
    await page.locator("#openAnalyzeFilters").click();
    const cleared = page.waitForResponse(value => value.url().endsWith("/api/period-comparison") && value.ok());
    await page.getByRole("button", { name: /^Remove outcome filter:/ }).click();
    await cleared;
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await closeAnalyzeFilters(page);
    await expect(caption).toHaveCount(0);
    await noOrdinaryAuthority(page);
});

test("accepted restrictions wrap as plain caption text alongside the matching filter entry", { timeout: 60000 }, async t => {
    const { page } = await setup(t, { longNames: true }), measurements = [];
    await fillPeriods(page);
    await compare(page);
    await page.locator("#openAnalyzeFilters").click();
    await refine(page,"toolFilter","workiq-fetch"); await refine(page,"comparisonServices","Files");
    await refine(page,"comparisonMissingService","true"); await keepOnly(page,"outcomeFilter","failure");
    await keepOnly(page,"promptAuthorFilter","user");
    const accepted = await refine(page,"projectFilter","paired-scope-project");
    await closeAnalyzeFilters(page);
    const caption = page.locator("#comparisonAcceptedScope");
    await expect(caption).toContainText(longProject);
    await expect(caption).toContainText("Outcome: Tool failed");
    await expect(caption).toContainText("Missing-service context allowed");
    await expect(caption.locator(".analyze-scope-part")).toHaveCount(6);
    await expect(caption).not.toContainText(/known matches|context-only|Current collection|All dates/);
    assert.equal(accepted.periods.baseline.rowIds.length, 1);
    assert.equal(accepted.periods.later.rowIds.length, 1);
    const key = await caption.getAttribute("data-pair-key");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await noOrdinaryAuthority(page, 6);
        await expect(caption).toHaveAttribute("data-pair-key", key);
        const geometry = await caption.evaluate(node => {
            const rect = value => { const r = value.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
            const lines = [...node.querySelectorAll(".analyze-scope-part")].flatMap(part => {
                const range = document.createRange(); range.selectNodeContents(part.firstChild);
                return [...range.getClientRects()].map(r => ({ x: r.x, right: r.right, y: r.y, bottom: r.bottom }));
            });
            return { caption: rect(node), dates: rect(document.querySelector(".compare-period-key")),
                lines,
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: node.scrollWidth - node.clientWidth, verticalClip: node.scrollHeight - node.clientHeight };
        });
        assert.ok(geometry.caption.x >= 0 && geometry.caption.right <= width + 1);
        assert.ok(geometry.caption.bottom <= geometry.dates.y);
        assert.ok(geometry.overflow <= 1 && geometry.clipped <= 1 && geometry.verticalClip <= 1);
        assert.ok(geometry.lines.every(line => line.x >= geometry.caption.x - 1 && line.right <= geometry.caption.right + 1
            && line.y >= geometry.caption.y - 1 && line.bottom <= geometry.caption.bottom + 1));
        if (scale === 2) assert.ok(geometry.lines.length > 1);
        measurements.push({ theme, width, scale, ...geometry });
        await capture(page, `scope-${theme}-${width}-${scale}`, { top: true });
        await caption.scrollIntoViewIfNeeded();
        await capture(page, `scope-reading-${theme}-${width}-${scale}`);
        await page.locator("#openAnalyzeFilters").click();
        await expect(page.locator("#projectFilter")).toHaveValue("paired-scope-project");
        await page.keyboard.press("Escape");
        await expect(page.locator("#openAnalyzeFilters")).toBeFocused();
    }
    if (process.env.WIRE_COMPARE_FILTER_PROOFS) await writeFile(path.join(process.env.WIRE_COMPARE_FILTER_PROOFS, "scope-geometry.json"),
        JSON.stringify(measurements, null, 2));
});

test("accepted empty pairs keep their identity without default recap or duplicate collection and unit captions", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page, "2025");
    const empty = await compare(page);
    assert.deepEqual(empty.periods.baseline.rowIds, []); assert.deepEqual(empty.periods.later.rowIds, []);
    await expect(page.locator("#openAnalyzeFilters")).toHaveAttribute("data-pair-key", /^period:\d+$/);
    await expect(page.locator("#openAnalyzeFilters")).toHaveAttribute("data-pair-revision", String(empty.revision));
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    await noOrdinaryAuthority(page);
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "scopeFilter", "all"); await ready(page);
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    await expect(page.locator("#periodComparisonResults > p.compare-caption").filter({ hasText: "Both collections" })).toHaveCount(0);
    await expect(page.locator("#periodComparisonResults > p.compare-caption").filter({ hasText: /^Graph code references$/ })).toHaveCount(1);
    await noOrdinaryAuthority(page);
    await page.locator("#openAnalyzeFilters").click();
    await expect(page.locator("#scopeFilter")).toHaveValue("all");
    await expect(page.locator("#layerFilter")).toHaveValue("code-reference");
    await closeAnalyzeFilters(page);
});

test("late older paired reads cannot replace newer accepted restrictions or ordinary exit authority", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page); await compare(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch(); await gate; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#openAnalyzeFilters").click();
    const pending = page.waitForRequest(request => request.url().endsWith("/api/period-comparison"));
    await toggleChoice(page, "comparisonServices", "Files"); await pending;
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    await noOrdinaryAuthority(page);
    await toggleChoice(page, "toolFilter", "workiq-fetch"); await ready(page);
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    const caption = page.locator("#comparisonAcceptedScope");
    await expect(caption).toContainText("Tool: workiq-fetch");
    const accepted = await caption.textContent();
    const key = await caption.getAttribute("data-pair-key");
    const stale = page.waitForResponse(response => response.url().endsWith("/api/period-comparison")
        && response.request().postDataJSON().options.filters.services.includes("Files") && !response.request().postDataJSON().options.filters.tools);
    release(); await stale;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(caption).toHaveText(accepted);
    await expect(caption).toHaveAttribute("data-pair-key", key);
    await noOrdinaryAuthority(page, 2);
    await ordinary(page);
    await expect(caption).toHaveCount(0);
    await expect(page.locator("#openAnalyzeFilters")).not.toHaveAttribute("data-pair-key");
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Mar 7/);
    await expect(page.locator("#openAnalyzeFilters")).not.toHaveAccessibleDescription(/workiq-fetch|Files only/);
});

for (const holdCollectionStatus of [false, true]) test("exact numbers and their scope follow the accepted read, not a collection poll"
    + (holdCollectionStatus ? " without a collection-status response" : ""), { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await fillPeriods(page);
    await compare(page); await page.locator("#openAnalyzeFilters").click();
    await keepOnly(page,"outcomeFilter","failure");
    if (holdCollectionStatus) await page.route("**/api/collection/status", () => {});
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch(); await gate; await route.fulfill({ response });
    }, { times: 1 });
    const pending = page.waitForRequest(request => request.url().endsWith("/api/period-comparison"));
    await toggleChoice(page,"comparisonServices","Files"); await pending;
    await closeAnalyzeFilters(page);
    await expect(page.locator("#comparisonAcceptedScope")).toHaveCount(0);
    const numbers = page.getByRole("button",{name:"View numbers",exact:true});
    await expect(numbers).toBeDisabled();
    release();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#comparisonAcceptedScope")).toHaveText("Service: Files only; Outcome: Tool failed");
    await numbers.click();
    await expect(page.getByRole("table",{name:"Exact outcome counts and shares"}).getByRole("row",{name:/Tool failed/})).toContainText("1 of");
    await page.getByRole("button",{name:"Back to comparison",exact:true}).click();
    await expect(numbers).toBeFocused();
});
