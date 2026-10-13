import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

const proof = process.env.WIRE_COMPARISON_EXPERIENCE_PROOFS;
async function setup(t, hash = "#analyze") {
    let removeFixture;
    const { records } = periodFixture();
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
            "/api/search/query", "/api/search/status", "/api/search/events", "/api/session",
            "/api/preview", "/api/cancel-preview",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        requests.push({ path: url.pathname, input: request.method() === "POST" ? request.postDataJSON() : undefined });
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
async function compare(page) {
    const response = page.waitForResponse(response => response.url().endsWith("/api/period-comparison") && response.ok());
    await page.locator("#applyPeriodComparison").focus(); await page.keyboard.press("Enter");
    const value = await (await response).json();
    await expect(page.locator("#periodComparisonResultsTitle")).toBeVisible();
    return value;
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
    await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
}

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
    await page.locator("#createPeriodReport").click();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator("#reportPopulationNote")).toContainText("Period A: 4 matching records; Period B: 4");
    await expect(page.locator("#formatOptions input[value=pdf]")).not.toBeChecked();
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await response).json();
    assert.equal(preview.error, undefined);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, comparison.comparison);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.frameLocator(".report-frame").getByRole("heading", { name: "What differs", exact: true })).toBeVisible();
    await expect(page.locator("input[data-review-control]")).not.toBeChecked();
    if (proof) await page.screenshot({ path: path.join(proof, "html-review-viewport.png") });
});

test("pending comparison respects subsequent reading and editing while automatic refinements never move focus", { timeout: 30000 }, async t => {
    const { page } = await setup(t, "#analyze?services=Files&includeMissingService=true");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator("#comparePeriods").click();
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
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (2)");
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (2)");
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
    await expect(page.getByLabel("Period A from", { exact: true })).toBeFocused();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#periodComparisonStatus")).toBeHidden();
    assert.ok(await page.locator("#analyzePopulation #periodComparisonSetup").count());
    assert.ok((await page.locator("#periodComparisonSetup").boundingBox()).y < (await page.locator("#filters").boundingBox()).y);
    await expect(page.locator("#comparisonDateHint")).toHaveText("Both dates included. America/New_York.");
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
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.locator("#periodComparisonStatus")).toHaveClass("visually-hidden");
    await expect(page.locator("#periodComparison")).toContainText("3,000 ms; 2 / 4 calls timed");
    await expect(page.locator("#periodComparison")).toContainText("Includes calls outside the selected dates or filters");
    await page.getByLabel("Period A to", { exact: true }).fill("2026-03-08");
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#outcomeFilter-control")).not.toContainText("A:");
    await expect(page.locator("#periodComparisonStatus")).toContainText("Dates changed");
    await page.getByRole("button", { name: "Search this comparison", exact: true }).click();
    await expect(page.locator("#wireSearch")).toBeFocused();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
    await expect(page.getByLabel("Period A to", { exact: true })).toHaveValue("2026-03-08");
    await page.keyboard.press("Escape");
    await fillPeriods(page);
    await compare(page);
    await selectActivityOption(page, "promptAuthorFilter", "user");
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (2)");
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (2)");
    await expect(page.locator("#filterChips")).toContainText("Author:");
    await expect(page.locator("#filterChips")).toContainText("missing service details");
    await page.getByRole("button", { name: "Stop comparing", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#comparePeriods")).toBeFocused();
    await expect(page.locator("#periodComparisonSetup")).toBeHidden();
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(page.locator("#dateFilter-control")).toBeVisible();
    const route = new URLSearchParams(page.url().split("?")[1]);
    assert.equal(route.get("from"), "2026-03-07"); assert.equal(route.get("to"), "2026-03-07");
    assert.equal(route.get("services"), "Files"); assert.equal(route.get("includeMissingService"), "true");
    assert.equal(route.get("authors"), "user");
    await page.locator("#comparePeriods").click();
    await expect(page.getByLabel("Period A from", { exact: true })).toHaveValue("2026-03-07");
    assert.ok(requests.filter(item => item.path === "/api/period-comparison").every(item => item.input.options.filters.from === undefined));
});

test("normal-root empty sides, pending reads and read errors never offer an invalid report", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#comparePeriods").click();
    await fillPeriods(page, ["2025-03-07", "2025-03-07"]);
    await compare(page);
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("No matching retained activity");
    await expect(page.locator('[data-period-side="baseline"] details')).toHaveCount(0);
    await expect(page.locator("#periodComparison")).toContainText("Not applicable");
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    await fillPeriods(page, ["2025-03-07", "2025-03-07"], ["2025-03-08", "2025-03-09"]);
    await compare(page);
    await expect(page.locator("#periodComparison")).toContainText("No matching retained activity in either period");
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
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
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
    const { page, requests } = await setup(t);
    await page.locator("#comparePeriods").click();
    await fillPeriods(page);
    const value = await compare(page), reads = () => requests.filter(item => item.path === "/api/period-comparison").length;
    const acceptedReads = reads();
    await page.route("**/api/search/query", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Local search unavailable." }),
    }));
    await page.locator("#wireSearch").fill("workiq-fetch");
    await expect(page.locator("#wireSearchRetry")).toBeVisible();
    await expect(page.locator("#createPeriodReport")).toBeVisible();
    assert.equal(reads(), acceptedReads);
    await expect(page.locator('[data-period-side="baseline"]')).toContainText(`Exact matching records (${value.periods.baseline.rowIds.length})`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Search this comparison", exact: true }).click();
    await expect(page.locator("#periodComparisonStatus")).toContainText("Check Search status before comparing");
    await expect(page.locator("#periodComparisonResults")).toBeEmpty();
    await expect(page.locator("#createPeriodReport")).toBeHidden();
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
                for (const selector of ["#applyPeriodComparison", "#periodComparisonSetup button:first-of-type", ...(populated ? ["#createPeriodReport"] : [])]) {
                    await page.locator(selector).first().focus();
                    await expect(page.locator(selector).first()).toBeFocused();
                }
                if (populated) await expect(page.getByRole("table", { name: "Matching Work IQ tool calls", exact: true })).toContainText("Period B");
                layouts.push({ populated, width, height, scale, theme, ...geometry });
                await capture(page, `${populated ? "populated" : "initial"}-${theme}-${width}-${scale}`);
            }
        }
    }
    if (proof) await writeFile(path.join(proof, "layout.json"), JSON.stringify(layouts, null, 2));
});
