import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, selectActivityOption, chooseTheme, closeAnalyzeFilters, restoreLegacySearch } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

async function setup(t, hash = "#analyze?tool=workiq-ask", { enforced = false, records = periodFixture().records } = {}) {
    let removeFixture;
    const { context } = await privateFixture({ after: cleanup => { removeFixture = cleanup; } }, records);
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
test("Compare sections keep the period view and saved report choices across keyboard navigation and Back", async t => {
    const app = await searchFixture(t, { records: periodFixture().records.slice(1, 5), frontend: "react", reply: false,
        formats: ["json", "html"], reportTitles: ["Earlier weekly review", "Later weekly review"] });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    await page.goto(app.runtime.url + "compare?aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09");
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Compare sections" });
    const periods = nav.getByRole("link", { name: "Periods" }), reports = nav.getByRole("link", { name: "Saved reports" });
    await page.getByRole("button", { name: "By tool", exact: true }).click();
    await ready(page);
    await expect(periods).toHaveAttribute("aria-current", "page");
    await periods.focus(); await page.keyboard.press("Tab"); await expect(reports).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reports).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#reportTaskNav")).toBeHidden();
    const picker = page.locator("#comparisonWorkspace");
    for (const [label, bundle] of [["Earlier report", app.bundles[0]], ["Later report", app.bundles[1]]]) {
        await picker.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup [data-value="${bundle.bundleId}"]`).click();
    }
    await page.goBack(); await ready(page);
    await expect(reports).toBeFocused();
    await expect(page.getByRole("button", { name: "By tool", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".compare-period-key")).toContainText(/Mar 7.*Mar 9/s);
    await reports.click();
    await expect(picker.getByRole("combobox", { name: "Earlier report", exact: true })).toContainText("Earlier weekly review");
    await expect(picker.getByRole("combobox", { name: "Later report", exact: true })).toContainText("Later weekly review");
    await periods.click(); await ready(page);
    await page.getByRole("button", { name: "View numbers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Exact numbers" })).toBeVisible();
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await expect(page.getByRole("button", { name: "View numbers", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('nav [data-nav="reports"]').click();
    await page.locator("#viewAllSavedReports").click();
    const libraryEntry = page.getByRole("link", { name: "Compare saved reports", exact: true });
    await libraryEntry.click();
    await expect(reports).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Back to saved reports", exact: true }).click();
    await expect(libraryEntry).toBeFocused();
});
test("exact-call captions follow narrowed membership", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#comparePeriods").click(); await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await page.locator('.compare-outcome-bar').first().locator('[data-outcome="failure"]').click();
    await expect(page.locator("#comparisonExactRecordsA > .compare-caption").first()).toHaveText("1 call across 1 interaction");
    await expect(page.locator("#comparisonExactRecordsB > .compare-caption").first()).toHaveText("0 calls across 0 interactions");
    await expect(page.locator("#comparisonExactRecordsA")).not.toContainText("missing service details");
});
test("comparison peers align at narrow enlarged text and menu combinations stay explicit", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t);
    await page.locator("#comparePeriods").click(); await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    await selectActivityOption(page, "comparisonQuickChoice", "completed"); await ready(page);
    await selectActivityOption(page, "comparisonQuickChoice", "mine"); await ready(page);
    await expect(page.locator("#comparisonQuickChoice-control")).toContainText("Completed calls + Human prompts");
    assert.deepEqual(comparisons.at(-1).options.filters.promptAuthors, ["user"]);
    assert.match(page.url(), /comparisonFocus=completed/);
    await selectActivityOption(page, "comparisonQuickChoice", "all"); await ready(page);
    const measurements = [], output = process.env.WIRE_COMPARISON_PROOFS;
    if (output) await mkdir(output, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [768, 100], [390, 100], [390, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.locator(".comparison-outcome-values").evaluate(table => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            pairs: [...table.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("button")].map(button => {
                const box = button.getBoundingClientRect();
                return { top: box.top, right: box.right, height: box.height, font: parseFloat(getComputedStyle(button).fontSize) };
            })),
        }));
        assert.equal(geometry.overflow, false, `${theme}/${width}/${scale}`);
        assert.ok(geometry.pairs.every(([a, b]) => Math.abs(a.top - b.top) < 1 && a.height >= 44 && b.height >= 44
            && b.right <= width && a.font >= 14 * scale / 100), JSON.stringify(geometry));
        measurements.push({ theme, width, scale, ...geometry });
        if (output) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(output, `paired-${theme}-${width}-${scale}.png`), fullPage: true });
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.getByRole("button", { name: "By tool", exact: true }).click();
    await expect(page.locator(".comparison-breakdown")).toContainText("Call count scale:");
    await expect(page.locator(".comparison-group").first()).toContainText("Later minus earlier:");
    await expect(page.locator(".comparison-group").first()).toContainText("calls total");
    if (output) await writeFile(path.join(output, "peer-geometry.json"), JSON.stringify(measurements, null, 2));
});
test("comparison paint is linear and exact-call captions follow narrowed membership", { timeout: 60000 }, async t => {
    const records = periodFixture().records;
    for (let index = 0; index < 100; index++) {
        const record = structuredClone(records[4]);
        record.scenarioId = `paint-${index}`;
        record.sourceSessionId = `paint-chat-${index}`;
        record.userPrompt.sourceEventId = `paint-prompt-${index}`;
        Object.assign(record.toolCalls[0], { toolCallId: `paint-call-${index}`, startEventId: `paint-start-${index}`, completionEventId: `paint-end-${index}` });
        records.push(record);
    }
    const { page, comparisons } = await setup(t, "#analyze", { records });
    await page.locator("#comparePeriods").click(); await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    const pair = comparisons.at(-1), maximum = Math.max(...Object.values(pair.periods).map(side => side.analytics.resultFacet.totals.count));
    for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => document.fonts.ready);
        const bars = await page.locator(".compare-outcome-bar").evaluateAll(nodes => nodes.map(node => ({
            width: node.getBoundingClientRect().width,
            marks: [...node.querySelectorAll("[data-outcome]")].map(mark => ({
                outcome: mark.dataset.outcome, width: mark.querySelector(".compare-outcome-paint").getBoundingClientRect().width,
            })),
        })));
        for (const [index, side] of Object.values(pair.periods).entries()) {
            for (const mark of bars[index].marks) {
                const count = side.analytics.totals[mark.outcome];
                assert.ok(mark.width > 0, `${theme}/${width}: nonzero ${mark.outcome} must paint`);
                assert.ok(Math.abs(mark.width - bars[index].width * count / maximum) < .1, `${theme}/${width}: ${mark.outcome} paint must be linear`);
            }
            assert.ok(bars[index].marks.every(mark => side.analytics.totals[mark.outcome] > 0), "True zero has no paint");
        }
    }
    await page.locator('.compare-outcome-bar').first().locator('[data-outcome="failure"]').click();
    await expect(page.locator("#comparisonExactRecordsA > .compare-caption").first()).toHaveText("1 call across 1 interaction");
    await expect(page.locator("#comparisonExactRecordsB > .compare-caption").first()).toHaveText("0 calls across 0 interactions");
    await expect(page.locator("#comparisonExactRecordsA")).not.toContainText("missing service details");
    await expect(page.locator("#comparisonExactRecordsA tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await expect(page.locator("#comparisonExactRecordsA > .compare-caption").first()).toHaveText("5 calls across 3 interactions");
    await expect(page.locator("#comparisonExactRecordsA")).toContainText("missing service details");
});
test("primary comparison opens complete days independently, keeps chart membership and restores Analyze", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t);
    const compare = page.getByRole("link", { name: "Compare", exact: true });
    await expect(compare).toHaveAttribute("id", "comparePeriods");
    await expect(compare).toHaveAttribute("href", /^\/compare(?:\?|$)/);
    await expect(compare).toHaveText("Compare");
    await compare.click(); await ready(page);
    await expect(page.locator("#pageTitle")).toHaveText("Compare");
    await expect(page.locator("#pageTitle")).toHaveAccessibleName("Compare");
    await expect(page.locator("#periodComparisonSetup")).toHaveAccessibleName("Compare");
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await compare.focus();
    await expect(page.locator('[role=tooltip]:visible')).toHaveText("Compare");
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
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
    await expect(page.locator("#pageTitle")).toHaveText("Compare");
    await page.locator("nav [data-nav=settings]").click();
    await expect(page.locator("#breadcrumbs")).toBeHidden();
});
test("custom cancellation, immediate refinements, exact hover and both themes retain the accepted pair", { timeout: 60000 }, async t => {
    const { page, comparisons } = await setup(t, "#analyze?compare=periods");
    await ready(page);
    await dates(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    const accepted = comparisons.at(-1), address = page.url();
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Period A from", { exact: true }).fill("2026-04-01");
    await expect(page.getByRole("button", { name: "Use dates", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(page.url(), address);
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
    await expect(page.locator("#accessPageTitle")).toHaveText("Compare");
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
    await page.getByRole("link", { name: "Compare", exact: true }).focus();
    await page.keyboard.press("Enter");
    await ready(page);
    await expect(page.locator("#navigationDrawer")).toBeHidden();
    await expect(page.locator("#pageTitle")).toHaveAccessibleName("Compare");
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
    assert.equal(page.url().includes("workiq"), false);
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
        const { pathname, searchParams } = new URL(page.url());
        searchParams.sort(); return pathname + "?" + searchParams;
    };
    const pair = comparisons.at(-1), origin = locationKey();
    await page.getByRole("button", { name: "View calls", exact: true }).click();
    await page.locator("#comparisonRecordsB").click();
    const call = page.locator("#comparisonExactRecordsB a").first(), id = await call.getAttribute("id");
    for (const back of ["close", "history"]) {
        await call.click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        assert.equal(await page.evaluate(() => JSON.stringify(history.state).includes("physician")), false);
        assert.match(await page.evaluate(() => history.state.evidenceView.privateKey), /^[a-f0-9-]{36}$/);
        assert.equal(await page.evaluate(() => Object.hasOwn(history.state.evidenceView, "returnToResults")), false);
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
    await expect(page.locator("#message")).toContainText(/private (Search selection is unavailable|view|selection could not be restored)/i);
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
