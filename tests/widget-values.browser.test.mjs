import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createPeriodComparisonPresentation } from "../web/period-comparison.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const proof = process.env.WIRE_WIDGET_PROOFS;
const percentages = createPercentageCharts();
const comparison = createPeriodComparisonPresentation(createTimeContext());
const paths = ["/me/messages", "/me/drive/root", "/me/calendarView", "/me/contacts", "/me/todo/lists",
    "/me/onenote/notebooks", "/teams", "/users", "/groups", "/sites", "/me/joinedTeams", "/search/query"];
function records() {
    return paths.map((apiPath, index) => {
        const row = fixture(`widget-values-${index}`);
        row.sourceSessionId = `widget-chat-${index}`;
        row.sourceSessionName = "Invented release review";
        row.capturedAt = `2026-11-${index < 6 ? "09" : "10"}T12:00:00Z`;
        row.userPrompt = { text: `Inspect the recorded release review in ${apiPath}.`, status: "full",
            sourceEventId: `widget-prompt-${index}`, sourceTimestamp: row.capturedAt,
            authorship: { actor: "user", basis: "source-user" } };
        row.toolCalls = Array.from({ length: index === 0 ? 1001 : index === 1 ? 1 : index + 1 }, (_, call) => ({
            ...row.toolCalls[0], toolCallId: `widget-call-${index}-${call}`, startEventId: `widget-start-${index}-${call}`,
            startedAt: row.capturedAt, requestArgs: { entityUrls: index === 1 ? [apiPath, "/me/messages"] : [apiPath] },
            requestedApiPath: index === 1 ? undefined : apiPath,
            tool: index === 11 ? "workiq-get_schema" : "workiq-fetch",
            toolSucceeded: index === 10 ? undefined : index !== 2, reportedOutcome: index === 10 ? "unknown" : index === 2 ? "failed" : "succeeded",
            apiResults: [],
        }));
        return row;
    });
}

test("normal grouped widgets and live comparisons use complete accepted populations and percentage-first values", { timeout: 90000 }, async t => {
    const cleanups = [], source = records();
    const { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) }, source);
    const before = await loadBoardState(context), errors = [], denied = [], evidence = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No provider in widget proof"); },
            readSource() { throw Error("No source reads in widget proof"); } } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, timezoneId: "UTC", locale: "en-US" });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    const ready = async () => {
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"
            || animation.effect?.getTiming().iterations === Infinity));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const snapshot = async hash => {
        await page.goto("about:blank");
        const response = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
        await page.goto(runtime.url + hash);
        const data = await (await response).json(); await ready(); return data.analytics;
    };
    const capture = async (name, selector) => {
        await ready();
        const geometry = await page.locator(selector).evaluate(host => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            clipped: [...host.querySelectorAll(".percentage-value,.percentage-value>*,.group-name")]
                .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
        }));
        assert.equal(geometry.overflow, false, name); assert.deepEqual(geometry.clipped, [], name);
        evidence.push({ name, geometry });
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.evaluate(() => scrollTo(0, 0));
            await page.mouse.move(0, 0);
            await page.screenshot({ path: path.join(proof, name + "-screen.png"), fullPage: true });
        }
    };
    const grouped = async (hash, expanded = false) => {
        const analytics = await snapshot(hash);
        const expected = expanded ? analytics.groups : [...analytics.visibleGroups, ...analytics.otherGroup ? [analytics.otherGroup] : []];
        const rows = page.locator("#chart .flat-comparison-action");
        assert.deepEqual(await rows.locator(".flat-comparison-count").allTextContents(),
            expected.map(row => `${percentages.percent(row.total, analytics.totals.count)} (${row.total.toLocaleString()})`));
        assert.equal(expected.reduce((sum, row) => sum + row.total, 0), analytics.totals.count);
        return analytics;
    };
    const analytics = await grouped("#analyze?chart=endpoint");
    assert.ok(analytics.otherGroup && analytics.groups.length > analytics.visibleGroups.length);
    await expect(page.locator("#chart .flat-comparison-count").first()).toHaveText("92.9% (1,001)");
    const widgetRows = await page.locator("#percentageCharts .percentage-legend-row,#outcomeChart .percentage-legend-row")
        .evaluateAll(rows => rows.map(row => ({ count: Number(row.dataset.count), value: row.querySelector(".percentage-value").textContent })));
    for (const row of widgetRows) assert.equal(row.value, `${percentages.percent(row.count, analytics.totals.count)} (${row.count.toLocaleString()})`);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(`paths-${theme}`, ".analyze-dashboard");
    }
    await grouped("#analyze?chart=endpoint&expanded=true", true);
    await expect(page.locator("#chart .flat-comparison-count").filter({ hasText: "<0.1% (1)" })).toHaveCount(1);
    await grouped("#analyze?chart=workload");
    await chooseTheme(page, "light");
    await capture("categories-light", ".analyze-dashboard");
    const filtered = await grouped("#analyze?chart=endpoint&result=failure");
    assert.equal(filtered.totals.count, 3);
    await expect(page.locator("#chart .flat-comparison-count")).toHaveText("100% (3)");
    const control = page.locator("#chart .flat-comparison-action");
    await control.focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/endpoint=/);
    await page.goBack(); await ready();
    await expect(page.locator("#chart .flat-comparison-count")).toHaveText("100% (3)");

    const pairRoute = "#analyze?compare=periods&aFrom=2026-11-09&aTo=2026-11-09&bFrom=2026-11-10&bTo=2026-11-10";
    const pair = async suffix => {
        await page.goto("about:blank");
        const response = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
        await page.goto(runtime.url + pairRoute + suffix);
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.", { timeout: 10000 });
        const result = await response, value = await result.json();
        assert.equal(result.status(), 200, JSON.stringify(value));
        await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
        await ready(); return value;
    };
    const outcomeValues = async value => {
        const sides = [value.periods.baseline, value.periods.later];
        const keys = ["success", "failure", "unknown", "partial", "other", "transport"]
            .filter(key => sides.some(side => side.analytics.totals[key]));
        for (const [index, side] of sides.entries()) {
            const expected = keys.map(key => {
                const rates = comparison.rates(...sides.map(side => ({ ...side.analytics.totals,
                    count: side.analytics.resultFacet.totals.count })), key);
                return `${rates[index] ?? "share unavailable"} (${side.analytics.totals[key].toLocaleString()})`;
            });
            assert.deepEqual(await page.locator(".compare-outcome-row").nth(index).locator(".percentage-value").allTextContents(), expected);
        }
    };
    await outcomeValues(await pair(""));
    for (const [theme, width, size] of [["light", 1600, ""], ["dark", 390, "200%"]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
        await capture(`comparison-${theme}-${width}`, "#periodComparisonResults");
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await outcomeValues(await pair("&result=failure"));
    await expect(page.locator(".comparison-outcome-values .percentage-value").first()).not.toHaveText("100.00% (3)");
    const tools = await pair("&comparisonView=tools");
    await chooseTheme(page, "light");
    for (const group of await page.locator(".comparison-group").all()) {
        const label = await group.locator("h4").textContent();
        const expected = Object.values(tools.periods).map(side => {
            const count = side.analytics.rows.filter(row => row.tool === label).length;
            const percentage = comparison.rates({ count: side.rowIds.length, success: count }, { count: side.rowIds.length, success: count }, "success")[0] ?? "Unavailable";
            return `${percentage} (${count.toLocaleString()})`;
        });
        assert.deepEqual(await group.locator(".percentage-value").allTextContents(), expected);
    }
    await capture("comparison-tools-light", "#periodComparisonResults");
    await page.setViewportSize({ width: 390, height: 1000 });
    await chooseTheme(page, "dark");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await capture("comparison-tools-dark-390", "#periodComparisonResults");
    if (proof) await writeFile(path.join(proof, "widget-evidence.json"), JSON.stringify(evidence, null, 2));
});
