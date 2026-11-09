import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, selectActivityOption, chooseTheme, closeAnalyzeFilters, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

async function setup(t, hash = "#analyze?tool=workiq-ask", { enforced = false } = {}) {
    let removeFixture;
    const { context } = await privateFixture({ after: cleanup => { removeFixture = cleanup; } }, periodFixture().records);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, ...(access ? { access } : {}),
        evaluation: { evaluatorFactory() { throw new Error("No provider in comparison proof."); },
            readSource() { throw new Error("No source access in comparison proof."); } } });
    const browser = await chromium.launch();
    const profile = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York" });
    const page = await profile.newPage();
    const errors = [], comparisons = [], denied = [];
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(server.url).origin) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    page.on("pageerror", error => { errors.push(error.message); console.error(error.stack); });
    page.on("response", async response => {
        if (response.url().endsWith("/api/period-comparison") && response.ok()) comparisons.push(await response.json());
    });
    t.after(async () => { try { await browser.close(); await server.close(); await access?.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); } finally { await removeFixture(); } });
    await page.goto(server.url + hash);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    if (!enforced) await page.clock.setFixedTime(new Date("2026-03-10T12:00:00Z"));
    return { page, comparisons, server };
}
async function ready(page) {
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#comparisonActions button").first()).toBeEnabled();
}
async function dates(page, a, b) {
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    for (const [label, value] of [["Period A from", a[0]], ["Period A to", a[1]], ["Period B from", b[0]], ["Period B to", b[1]]])
        await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByRole("button", { name: "Use dates", exact: true }).click();
    await ready(page);
}
test("primary comparison opens complete days independently, keeps chart membership and restores Analyze", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t);
    await page.locator("#comparePeriods").click(); await ready(page);
    assert.deepEqual(comparisons.at(-1).periods.later.range, { from: "2026-03-03", to: "2026-03-09" });
    assert.deepEqual(comparisons.at(-1).periods.baseline.range, { from: "2026-02-24", to: "2026-03-02" });
    assert.equal(comparisons.at(-1).options.filters.tools, undefined);
    await expect(page.locator("#comparePeriods")).toHaveAttribute("aria-current", "page");
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    const pair = comparisons.at(-1), reads = comparisons.length;
    await page.locator("#comparisonActions").evaluate(node => { window.comparisonFooter = node; });
    for (const name of ["Timeline", "By tool", "Timing", "Outcomes"]) {
        await page.getByRole("button", { name, exact: true }).click();
        if (process.env.WIRE_COMPARISON_PROOFS && ["Timeline", "Outcomes"].includes(name)) {
            await mkdir(process.env.WIRE_COMPARISON_PROOFS, { recursive: true });
            await page.evaluate(() => scrollTo(0, 0));
            await page.locator("#pageTitle").click();
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_PROOFS,
                name === "Timeline" ? "compare-timeline.png" : "compare-periods.png"), fullPage: true });
        }
        await expect(page.locator("#comparisonActions button")).toHaveText(["View calls", "View numbers", "Create report"]);
        assert.equal(await page.locator("#comparisonActions").evaluate(node => node === window.comparisonFooter), true);
        await page.getByRole("button", { name: "View calls", exact: true }).click();
        await expect(page.locator("#comparisonExactRecordsA tbody tr")).toHaveCount(pair.periods.baseline.rowIds.length);
        await expect(page.locator("#comparisonExactRecordsB tbody tr")).toHaveCount(pair.periods.later.rowIds.length);
        await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
        await page.getByRole("button", { name: "View numbers", exact: true }).click();
        await expect(page.locator(".compare-inspection table").first()).toBeVisible();
        await page.keyboard.press("Escape");
    }
    assert.equal(comparisons.length, reads);
    await page.locator("nav [data-nav=analyze]").click();
    await expect(page).toHaveURL(/tool=workiq-ask/);
    await page.locator("#comparePeriods").click(); await ready(page);
    assert.deepEqual(comparisons.at(-1).periods.later.range, pair.periods.later.range);
    assert.equal(comparisons.at(-1).options.filters.tools, undefined);
    await page.locator("#comparePeriods").click(); await ready(page);
    await expect(page.locator("#pageTitle")).toHaveText("Compare periods");
    await page.locator("nav [data-nav=settings]").click();
    await expect(page.locator("#breadcrumbs")).toBeHidden();
});
test("custom cancellation, immediate refinements, exact hover and both themes retain the accepted pair", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    const accepted = comparisons.at(-1), hash = new URL(page.url()).hash;
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Period A from", { exact: true }).fill("2026-04-01");
    await expect(page.getByRole("button", { name: "Use dates", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(new URL(page.url()).hash, hash);
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page); await ready(page);
    await selectActivityOption(page, "comparisonQuickChoice", "agent"); await ready(page);
    assert.deepEqual(comparisons.at(-1).options.filters.tools, ["workiq-fetch"]);
    assert.deepEqual(comparisons.at(-1).options.filters.promptAuthors, ["agent"]);
    await selectActivityOption(page, "comparisonQuickChoice", "all"); await ready(page);
    assert.deepEqual(comparisons.at(-1).periods.later.range, accepted.periods.later.range);
    const mark = page.locator(".compare-outcome-bar button").first();
    await mark.focus();
    await expect(page.locator('[role=tooltip]:visible')).toContainText("of");
    await page.keyboard.press("Escape");
    await expect(page.locator('[role=tooltip]:visible')).toHaveCount(0);
    for (const theme of ["dark", "light"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: theme === "dark" ? 1440 : 680, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await expect(page.getByRole("button", { name: "View numbers", exact: true })).toBeVisible();
        if (process.env.WIRE_COMPARISON_PROOFS) {
            await mkdir(process.env.WIRE_COMPARISON_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_COMPARISON_PROOFS, `comparison-${theme}.png`), fullPage: true });
        }
    }
});
test("Use Analyze view preserves deliberate private narrowing without changing either destination", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await restoreLegacySearch(page, "request 0");
    await page.locator("#comparePeriods").click(); await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    assert.ok(comparisons.at(-1).selection.scenarioIds.length > 1);
    await page.locator("#openAnalyzeFilters").click();
    await page.getByRole("button", { name: "Use Analyze view", exact: true }).click();
    await closeAnalyzeFilters(page); await ready(page);
    assert.deepEqual(comparisons.at(-1).selection.scenarioIds, ["period-request-0"]);
    assert.deepEqual(comparisons.at(-1).options.filters.services, ["Files"]);
    assert.ok(!page.url().includes("request+0") && !page.url().includes("request%200"));
    await page.locator("nav [data-nav=analyze]").click();
    await expect(page.locator("#activitySearch")).toHaveValue("request 0");
    await page.locator("#comparePeriods").click(); await ready(page);
    assert.deepEqual(comparisons.at(-1).selection.scenarioIds, ["period-request-0"]);
});
test("optional unions, intersections, grouping and intervals preserve independent restrictions", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await page.locator("#openAnalyzeFilters").click();
    await page.locator("#comparisonServices-control").click();
    await page.getByRole("searchbox", { name: "Find an option", exact: true }).fill("Files");
    await page.locator('.select-popup [data-value="Files"]').click(); await ready(page);
    await page.locator("#comparisonServices-control").click();
    await page.locator('.select-popup [data-value="Mail"]').click(); await ready(page);
    assert.deepEqual(comparisons.at(-1).options.filters.services, ["Files", "Mail"]);
    await page.locator("#comparisonWithinServices-control").click();
    await page.locator('.select-popup [data-value="Files"]').click(); await ready(page);
    assert.deepEqual(comparisons.at(-1).selection.withinServices, ["Files"]);
    await selectActivityOption(page, "comparisonBucket", "week"); await ready(page);
    assert.equal(comparisons.at(-1).options.bucket, "week");
    const pair = comparisons.at(-1);
    await selectActivityOption(page, "comparisonBucket", "month"); await ready(page);
    for (const side of ["baseline", "later"]) assert.deepEqual(comparisons.at(-1).periods[side].rowIds, pair.periods[side].rowIds);
    await closeAnalyzeFilters(page);
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(page.locator(".comparison-timeline-series")).toHaveCount(2);
    await page.locator("#openAnalyzeFilters").click();
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    assert.equal(comparisons.at(-1).definitions.layer, "reported-api");
    assert.deepEqual(comparisons.at(-1).options.filters.services, ["Files", "Mail"]);
    await closeAnalyzeFilters(page);
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    await expect(page.locator(".compare-latency")).toContainText("Unavailable for this evidence layer");
});
test("later period choices win over held replies without relabeling unsupported facts", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page); await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    let release, entered;
    const pending = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    await page.route("**/api/period-comparison", async route => {
        await page.unroute("**/api/period-comparison");
        const response = await route.fetch(); entered(); await pending; await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Last 14 days", exact: true }).click(); await held;
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await expect(page.locator("#periodComparisonResultsTitle")).toBeHidden();
    await page.getByRole("button", { name: "Last 30 days", exact: true }).click(); await ready(page);
    const accepted = comparisons.at(-1).periods;
    release();
    await expect.poll(() => comparisons.length).toBeGreaterThan(3);
    await expect(page.locator(".compare-date-qualification").last()).toContainText("Feb 8, 2026");
    assert.equal(accepted.later.range.from, "2026-02-08");
});
test("access withdrawal scrubs comparison marks, inspection and held links without replay", { timeout: 60000 }, async t => {
    const { page, server } = await setup(t, "#analyze", { enforced: true });
    await page.locator("#comparePeriods").click();
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await page.evaluate(() => {
        window.heldComparisonLink = document.querySelector("#comparisonExactRecordsA a");
        window.heldComparisonText = window.heldComparisonLink.firstChild;
        window.heldComparisonHref = window.heldComparisonLink.getAttributeNode("href");
    });
    const controller = await page.context().newPage();
    await controller.goto(server.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(await page.evaluate(() => [window.heldComparisonText.data, window.heldComparisonHref.value,
        window.heldComparisonLink.textContent, window.heldComparisonLink.getAttribute("href")]), ["", "", "", null]);
    const url = page.url();
    await page.evaluate(() => window.heldComparisonLink.click());
    assert.equal(page.url(), url);
});
test("exact call reading returns to the selected period, chart and focused record", { timeout: 60000 }, async t => {
    const { page } = await setup(t, "#analyze?compare=periods");
    await ready(page); await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await page.locator("#comparisonRecordsB").click();
    const link = page.locator("#comparisonExactRecordsB a").last(), id = await link.getAttribute("id");
    await link.click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await ready(page);
    await expect(page.locator("#comparisonRecordsB")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toBeFocused();
    await expect(page.getByRole("button", { name: "Timeline", exact: true })).toHaveAttribute("aria-pressed", "true");
});
test("narrow keyboard entry and enlarged text keep the same navigation and chart actions", { timeout: 60000 }, async t => {
    const { page } = await setup(t, "#analyze");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator("#navigationToggle").click();
    await page.locator("#comparePeriods").focus();
    await page.keyboard.press("Enter");
    await ready(page);
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    await expect(page.getByRole("button", { name: "Outcomes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View numbers", exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => [...document.querySelectorAll("#workspace *")].filter(node => node.checkVisibility()
        && node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ tag: node.tagName, id: node.id, cls: node.className,
        width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(overflow));
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    assert.equal(await page.locator("#comparisonCustomDates").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Custom dates", exact: true })).toBeFocused();
});
test("global Search is independent and an unavailable analytical Search never broadens the pair", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page); await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    const reads = comparisons.length;
    await page.route("**/api/search/query", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Local search unavailable." }),
    }));
    await page.locator("#wireSearch").fill("workiq-fetch");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    assert.equal(comparisons.length, reads);
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await page.keyboard.press("Escape");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status");
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    assert.equal(comparisons.length, reads);
    assert.equal(new URL(page.url()).hash.includes("workiq"), false);
});
test("overlap, one empty side and two empty sides retain exact membership and report eligibility", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-07", "2026-03-07"]);
    const overlap = comparisons.at(-1);
    assert.deepEqual(overlap.periods.baseline.rowIds, overlap.periods.later.rowIds);
    await expect(page.locator("#periodComparison")).toContainText(`${overlap.periods.baseline.rowIds.length} records`);
    await expect(page.locator("#periodComparison")).toContainText("appear in both periods");
    await dates(page, ["2025-03-07", "2025-03-07"], ["2026-03-08", "2026-03-09"]);
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.getByRole("button", { name: "View numbers", exact: true }).click();
    await expect(page.locator(".compare-inspection")).toContainText("Unavailable");
    await expect(page.locator(".compare-inspection")).toContainText("Not comparable");
    await page.keyboard.press("Escape");
    await dates(page, ["2025-03-07", "2025-03-07"], ["2025-03-08", "2025-03-09"]);
    assert.equal(comparisons.at(-1).periods.baseline.rowIds.length + comparisons.at(-1).periods.later.rowIds.length, 0);
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await expect(page.locator("#periodComparison")).toContainText("No activity was found in either period");
});
for (const reloadAt of ["analyze", "call"]) test(`analytical Search restores exact membership and keeps query text out of browser history (${reloadAt} reload)`, { timeout: 60000 }, async t => {
    const cleanup = [], app = await searchFixture({ after: action => cleanup.push(action) });
    const browser = await chromium.launch(), page = await browser.newPage({ timezoneId: "America/New_York" }), comparisons = [], errors = [];
    t.after(async () => { await browser.close(); for (const action of cleanup) await action(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.url().endsWith("/api/period-comparison") && response.ok()) comparisons.push(await response.json());
    });
    await page.goto(app.runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#wireSearch").fill("physician");
    await selectActivityOption(page, "wireSearchType", "interaction");
    await selectActivityOption(page, "wireSearchScope", "analysis");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await page.keyboard.press("Escape");
    await page.locator("#comparePeriods").click(); await ready(page);
    await page.goBack();
    await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    await expect(page.locator("#wireSearch")).toHaveValue("physician");
    await expect(page.locator("#wireAnalysisSearchNotice")).toBeHidden();
    await page.goForward(); await ready(page);
    await dates(page, ["2026-09-29", "2026-09-29"], ["2026-09-30", "2026-09-30"]);
    assert.equal(comparisons.at(-1).selection.semanticMembership, undefined);
    await page.locator("#openAnalyzeFilters").click();
    await page.getByRole("button", { name: "Use Analyze view", exact: true }).click();
    await closeAnalyzeFilters(page); await ready(page);
    assert.deepEqual(comparisons.at(-1).selection.semanticMembership.scenarioIds, ["search-0"]);
    await expect(page.locator("#wireSearchType")).toHaveValue("");
    await expect(page.locator("#wireSearchType")).toBeDisabled();
    assert.equal(await page.evaluate(() => JSON.stringify(history.state).includes("physician")), false);
    assert.equal(page.url().includes("physician"), false);
    const locationKey = () => {
        const [view, query] = new URL(page.url()).hash.split("?"), parameters = new URLSearchParams(query);
        parameters.sort(); return view + "?" + parameters;
    };
    const pair = comparisons.at(-1), origin = locationKey();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await page.locator("#comparisonRecordsB").click();
    const call = page.locator("#comparisonExactRecordsB a").first(), id = await call.getAttribute("id");
    for (const back of ["close", "history"]) {
        await call.click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        assert.equal(await page.evaluate(() => JSON.stringify(history.state).includes("physician")), false);
        assert.match(await page.evaluate(() => history.state.evidenceView.returnToResults.analysisKey), /^[a-f0-9-]{36}$/);
        if (back === "close") await page.locator("#closeContextSidebar").click();
        else await page.goBack();
        await ready(page);
        assert.equal(locationKey(), origin);
        assert.deepEqual(comparisons.at(-1).selection.semanticMembership, pair.selection.semanticMembership);
        assert.deepEqual(comparisons.at(-1).periods.later.rowIds, pair.periods.later.rowIds);
        await expect(page.locator(`[id=${JSON.stringify(id)}]`)).toBeFocused();
    }
    if (reloadAt === "analyze") {
        await page.locator("nav [data-nav=analyze]").click();
        await expect(page.locator("#wireSearch")).toHaveValue("physician");
        await expect(page.locator("#wireSearchType")).toHaveValue("");
    } else {
        await call.click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await page.evaluate(() => {
            const { analysisKey, ...entry } = history.state.evidenceView;
            history.replaceState({ ...history.state, evidenceView: entry }, "");
        });
        assert.equal(await page.evaluate(() => JSON.stringify(history.state).includes("physician")), false);
    }
    await page.reload();
    await expect(page.locator("#message")).toContainText("private Search selection is unavailable");
    await expect(page.locator("#workspace")).toBeHidden();
});
test("incomplete public comparison dates require an explicit choice without dispatch or fallback", { timeout: 30000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods&aFrom=2026-03-07");
    const url = page.url();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Choose a start and end date for both periods");
    await expect(page.locator("#createPeriodReport")).toBeDisabled();
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await expect(page.getByRole("button", { name: "Use dates", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(page.url(), url);
    assert.deepEqual(comparisons, []);
});
test("withdrawal during a held comparison read retires every endpoint option and retained handle", { timeout: 60000 }, async t => {
    const { page, server } = await setup(t, "#analyze", { enforced: true });
    await page.locator("#comparePeriods").click();
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await expect.poll(() => page.locator("#comparisonEndpoint option").evaluateAll(options => options.filter(option => option.value).length)).toBeGreaterThan(1);
    await page.evaluate(() => {
        const control = document.getElementById("comparisonEndpoint");
        window.heldEndpointSignature = control.getAttributeNode("data-options-signature");
        window.heldEndpointOptions = [...control.options].filter(option => option.value).map(option => ({
            option, text: option.firstChild, attributes: [...option.attributes],
        }));
    });
    let release, entered, finished;
    const waiting = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { entered = resolve; });
    const delivered = new Promise(resolve => { finished = resolve; });
    await page.route("**/api/period-comparison", async route => {
        const response = await route.fetch(); entered(); await waiting;
        try { await route.fulfill({ response }); } finally { finished(); }
    }, { times: 1 });
    await page.getByRole("button", { name: "Last 14 days", exact: true }).click(); await held;
    await expect(page.locator("#periodComparisonResults .comparison-chart")).toHaveCount(0);
    await expect(page.locator(".compare-inspection table")).toHaveCount(0);
    const controller = await page.context().newPage();
    await controller.goto(server.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    try {
        assert.deepEqual(await page.evaluate(() => ({
            options: [...document.getElementById("comparisonEndpoint").options].map(option => option.value),
            signature: document.getElementById("comparisonEndpoint").getAttribute("data-options-signature"),
            heldSignature: window.heldEndpointSignature.value,
            held: window.heldEndpointOptions.map(({ option, text, attributes }) =>
                [option.textContent, text.data, option.value, ...attributes.map(attribute => attribute.value)]),
        })), {
            options: [""], signature: null, heldSignature: "",
            held: await page.evaluate(() => window.heldEndpointOptions.map(({ attributes }) => Array(3 + attributes.length).fill(""))),
        });
    } finally { release(); await delivered; }
    await expect(page.locator("#comparisonEndpoint option")).toHaveCount(1);
    await expect(page.locator("#comparisonEndpoint")).toHaveValue("");
    await expect(page.locator("#workspace")).toBeHidden();
});
