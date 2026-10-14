import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, selectActivityOption, navigateMain, navigateSettings, restoreLegacySearch, chooseTheme } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { chooseReportScope, reportContents, cancelReportPreview } from "./report-journey-helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const sorted = values => [...values].sort();
function records() {
    const rows = [
        ["a", "A", ["2026-03-08T08:00:00Z", "2026-03-09T06:59:59.999Z"]],
        ["b", "A", ["2026-03-07T20:00:00Z"]],
        ["c", "B", ["2026-03-02T08:00:00Z"]],
        ["d", "C", ["2026-03-01T08:00:00Z"]],
        ["e", "C", ["2026-03-31T19:00:00Z"]],
        ["f", "D", ["2026-02-28T12:00:00Z"]],
        ["g", "E", [null]],
        ["h", "F", ["2026-03-09T07:00:00Z"]],
        ["i", "G", ["2026-03-08T07:59:59.999Z"]],
        ["j", "H", ["2026-04-01T07:00:00Z"]],
    ].map(([id, chat, stamps]) => {
        const record = fixture(`unified-${id}`);
        record.sourceSessionId = `unified-chat-${chat}`;
        record.capturedAt = stamps[0];
        record.userPrompt = { text: `Invented ${id === "a" || id === "c" ? "needle" : "scope"} request ${id}`,
            status: "full", authorship: { actor: id === "b" ? "agent" : "user", basis: "source-user" } };
        record.toolCalls = stamps.map((startedAt, index) => ({
            tool: "workiq-fetch", toolCallId: `${id}-${index}`, startEventId: `start-${id}-${index}`,
            requestArgs: { entityUrls: [index || id === "b" ? "/me/drive/root" : "/me/messages"] },
            startedAt, toolSucceeded: id !== "b" && id !== "d", reportedOutcome: id === "b" || id === "d" ? "failed" : "succeeded",
            durationMs: 100, completedAt: startedAt ? new Date(Date.parse(startedAt) + 100).toISOString() : null,
        }));
        return record;
    });
    rows[0].toolCalls.push(structuredClone(rows[0].toolCalls[0]));
    return [...rows, { ...structuredClone(rows[0]), scenarioId: "unified-legacy-alias", isLegacy: true }];
}
async function setup(t, source = records(), now = "2026-03-09T06:00:00Z") {
    let cleanup;
    const { context } = await privateFixture({ after: fn => { cleanup = fn; } }, source);
    const before = await loadBoardState(context), errors = [], denied = [], inputs = [];
    let snapshot, providers = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { providers++; throw new Error("Provider use forbidden in time-scope proof."); },
            readSource: async () => { providers++; throw new Error("Source reads forbidden in time-scope proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(providers, 0);
            assert.deepEqual(await loadBoardState(context), before);
        } finally { await cleanup(); }
    });
    const page = await browser.newPage({ timezoneId: "America/Los_Angeles", reducedMotion: "reduce",
        viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    await page.clock.setFixedTime(new Date(now));
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/preview", "/api/cancel-preview",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (request.method() === "POST") inputs.push({ path: url.pathname, input: request.postDataJSON() });
        return route.continue();
    });
    await page.goto(runtime.url);
    await ready(page);
    return { page, inputs, snapshot: () => snapshot };
}

test("one visible calendar range changes every widget, headline, row and current report together", { timeout: 40000 }, async t => {
    const app = await setup(t), { page, inputs } = app;
    const choose = async value => {
        await selectActivityOption(page, "dateFilter", value); await ready(page);
        const captions = { capture: "All dates", day: "Mar 8, 2026", week: "Mar 2 - Mar 8, 2026", month: "Mar 1 - Mar 31, 2026" };
        if (captions[value]) await expect(page.locator("#periodResult")).toContainText(`(${captions[value]})`);
    };
    async function scope(ids, interactions, chats, undated = 0) {
        const total = ids.length;
        await expect(page.locator("#activityCount")).toHaveText(String(total));
        await expect(page.locator("#periodHint")).toHaveText(`${interactions} interaction${interactions === 1 ? "" : "s"} · ${chats} Copilot chat${chats === 1 ? "" : "s"}`);
        await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", String(total));
        await expect(page.locator(".percentage-denominator")).toHaveText([
            ...Array(3).fill(`${total} Work IQ tool call${total === 1 ? "" : "s"}`),
            `${interactions} matching interaction${interactions === 1 ? "" : "s"}`,
        ]);
        await expect(page.locator('[data-percentage-card="models"]')).toHaveAttribute("data-total", String(interactions));
        assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((n, node) => n + Number(node.dataset.total), 0)), total - undated);
        assert.deepEqual(sorted(app.snapshot().analytics.rows.map(row => row.toolCallId)), sorted(ids));
        await expect(page.locator("#scopeCount-current")).toHaveText(`${interactions} request group${interactions === 1 ? "" : "s"}`);
        if (interactions <= 8) {
            const shown = await page.locator(".request-row").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey.slice(8)));
            assert.deepEqual(sorted(shown), sorted([...new Set(ids.map(id => `unified-${id[0]}`))]));
        }
        await expect(page.locator("#meaningMatched")).toHaveText(`${total} Work IQ tool call${total === 1 ? "" : "s"}`);
        await page.locator("#meaning > summary").click();
        await expect(page.locator("#countTable tfoot td").first()).toHaveText(String(total - undated));
        await page.locator("#meaning > summary").click();
    }
    const all = ["a-0", "a-1", "b-0", "c-0", "d-0", "e-0", "f-0", "g-0", "h-0", "i-0", "j-0"];
    await scope(all, 10, 8, 1);
    await expect(page.locator("#periodResult")).toHaveText("11 Work IQ tool calls (All dates)");
    await expect(page.locator("#dateFilter")).toHaveCount(1);
    await expect(page.locator("#bucketControl, #bucketFilter")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Dates", exact: true })).toBeVisible();
    await page.locator('.request-row[data-view-key="request:unified-j"] input').check();
    await choose("day");
    await expect(page.locator("#dateFilter-control")).toBeFocused();
    await scope(["a-0", "a-1"], 1, 1);
    assert.deepEqual(app.snapshot().analytics.dateRange, {
        from: "2026-03-08T08:00:00.000Z", to: "2026-03-09T07:00:00.000Z", toExclusive: true,
    });
    assert.equal(inputs.findLast(row => row.path === "/api/snapshot").input.bucket, "day");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    assert.deepEqual(sorted(await page.locator(".matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId))),
        ['call:["unified-chat-A","a-0"]', 'call:["unified-chat-A","a-1"]']);
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    await navigateMain(page, "settings"); await navigateSettings(page, "display");
    await selectActivityOption(page, "displayTimeZone", "UTC"); await ready(page);
    assert.deepEqual(sorted(app.snapshot().analytics.rows.map(row => row.toolCallId)), ["a-1", "h-0"],
        "An equal-size cohort in another zone must still replace exact membership.");
    await navigateMain(page, "home"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("2 Work IQ tool calls (Mar 9, 2026)");
    await navigateMain(page, "settings"); await navigateSettings(page, "display");
    await selectActivityOption(page, "displayTimeZone", ""); await ready(page);
    await navigateMain(page, "home"); await ready(page);
    await scope(["a-0", "a-1"], 1, 1);
    await expect(page.locator("#periodResult")).toHaveText("2 Work IQ tool calls (Mar 8, 2026)");
    await choose("week");
    await scope(["a-0", "a-1", "b-0", "c-0", "i-0"], 4, 3);
    const weekUrl = page.url();
    await choose("month");
    await scope(["a-0", "a-1", "b-0", "c-0", "d-0", "e-0", "h-0", "i-0"], 7, 5);
    assert.match(page.url(), /to=2026-03-31/);
    await page.goBack(); await ready(page);
    assert.equal(page.url(), weekUrl);
    await scope(["a-0", "a-1", "b-0", "c-0", "i-0"], 4, 3);
    await expect(page.locator("#periodResult")).toHaveText("5 Work IQ tool calls (Mar 2 - Mar 8, 2026)");
    await expect(page.locator("#scopeCount-selected")).toHaveText("1 request group");
    await page.reload(); await ready(page);
    await scope(["a-0", "a-1", "b-0", "c-0", "i-0"], 4, 3);
    await page.locator('.request-row[data-view-key="request:unified-c"] input').check();
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await scope(["b-0"], 1, 1);
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await restoreLegacySearch(page, "needle");
    await expect(page.locator("#activityCount")).toHaveText("3");
    await selectActivityOption(page, "serviceAssociationFilter", "Files"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#activityListSummary")).toContainText("1 interaction with 1 matching Work IQ tool call");
    await selectActivityOption(page, "promptAuthorFilter", "agent"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await page.locator("#resetView").click(); await ready(page);
    await scope(all, 10, 8, 1);
    await expect(page.locator("#periodResult")).toHaveText("11 Work IQ tool calls (All dates)");
    await choose("custom");
    await page.locator("#fromFilter").fill("2026-03-08"); await page.locator("#toFilter").fill("2026-03-08");
    await page.locator("#applyDates").click(); await ready(page);
    await scope(["a-0", "a-1"], 1, 1);
    await expect(page.locator("#periodResult")).toHaveText("2 Work IQ tool calls (Mar 8, 2026)");
    await choose("day");
    await navigateMain(page, "reports"); await chooseReportScope(page, "current");
    await expect(page.locator("#scopeCount-current")).toHaveText("1 request group");
    await expect(page.locator("#scopeCount-selected")).toHaveText("1 request group");
    await reportContents(page);
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    assert.equal((await response).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    const preview = inputs.findLast(row => row.path === "/api/preview").input;
    assert.deepEqual(preview.selection.scenarioIds, ["unified-a"]);
    assert.deepEqual(preview.options.dateSelection, { range: "day", from: "2026-03-08", to: "2026-03-08" });
    await cancelReportPreview(page);
    await navigateMain(page, "home");
    await choose("day");
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [["Period A from", "2026-02-28"], ["Period A to", "2026-02-28"],
        ["Period B from", "2026-03-01"], ["Period B to", "2026-03-01"]]) await page.getByLabel(label, { exact: true }).fill(value);
    const compared = page.waitForResponse(response => response.url().endsWith("/api/period-comparison") && response.ok());
    await page.locator("#applyPeriodComparison").click();
    const comparison = await (await compared).json();
    assert.deepEqual(comparison.periods.baseline.analytics.rows.map(row => row.toolCallId), ["f-0"]);
    assert.deepEqual(comparison.periods.later.analytics.rows.map(row => row.toolCallId), ["d-0"]);
    await page.getByRole("button", { name: "Stop comparing", exact: true }).click(); await ready(page);
    await scope(["a-0", "a-1"], 1, 1);
    await choose("custom");
    await page.locator("#fromFilter").fill("2026-04-02"); await page.locator("#toFilter").fill("2026-04-02");
    await page.locator("#applyDates").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityListSummary")).toContainText("0 interactions with 0 matching Work IQ tool calls");
    await expect(page.locator("#scopeCount-current")).toHaveText("0 request groups");
    await choose("capture"); await scope(all, 10, 8, 1);
    for (const [width, scale, theme] of [[1440, 1, "dark"], [375, 2, "light"]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await choose("week");
        await expect(page.locator("#dateFilter-control")).toHaveText(/This week/);
        const geometry = await page.locator("#dateFilter-control").evaluate(node => ({
            height: node.getBoundingClientRect().height,
            clipped: node.querySelector(".select-value").scrollWidth > node.querySelector(".select-value").clientWidth + 1,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }));
        assert.ok(geometry.height >= 44); assert.equal(geometry.clipped, false); assert.equal(geometry.overflow, false);
        if (process.env.WIRE_TIME_SCOPE_PROOF) await page.screenshot({ path: `${process.env.WIRE_TIME_SCOPE_PROOF}\\time-scope-${width}.png`, fullPage: true });
    }
});

test("Today follows a 25-hour civil day and refreshes its range after local midnight", async t => {
    const stamps = ["2026-11-01T06:59:59.999Z", "2026-11-01T07:00:00Z", "2026-11-01T08:30:00Z",
        "2026-11-01T09:30:00Z", "2026-11-02T07:59:59.999Z", "2026-11-02T08:00:00Z"];
    const source = stamps.map((startedAt, i) => {
        const record = fixture(`fall-${i}`); record.toolCalls[0].startedAt = startedAt; return record;
    });
    const app = await setup(t, source, "2026-11-02T07:00:00Z"), { page } = app;
    const trigger = page.locator("#dateFilter-control");
    await trigger.focus(); await trigger.press("ArrowDown"); await trigger.press("Home");
    await trigger.press("ArrowDown"); await trigger.press("Enter");
    await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("4");
    await expect(page.locator("#periodResult")).toHaveText("4 Work IQ tool calls (Nov 1, 2026)");
    assert.deepEqual(app.snapshot().analytics.dateRange, {
        from: "2026-11-01T07:00:00.000Z", to: "2026-11-02T08:00:00.000Z", toExclusive: true,
    });
    await page.clock.setFixedTime(new Date("2026-11-02T09:00:00Z"));
    await page.evaluate(() => dispatchEvent(new Event("focus"))); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#periodResult")).toHaveText("1 Work IQ tool call (Nov 2, 2026)");
});

test("pending, superseded and failed date reads never mix accepted widget cohorts", async t => {
    const app = await setup(t), { page } = app;
    let release, entered;
    const held = new Promise(resolve => { entered = resolve; });
    t.after(() => release?.());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await new Promise(resolve => { release = resolve; entered(); });
        await route.fulfill({ response });
    }, { times: 1 });
    await selectActivityOption(page, "dateFilter", "week"); await held;
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#activityCount")).toHaveText("11");
    await expect(page.locator("#periodResult")).toHaveText("11 Work IQ tool calls (All dates)");
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", "11");
    await selectActivityOption(page, "dateFilter", "day"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator("#periodResult")).toHaveText("2 Work IQ tool calls (Mar 8, 2026)");
    const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    release(); await (await late).finished();
    await expect(page.locator("#activityCount")).toHaveText("2");
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", "2");
    await expect(page.locator("#scopeCount-current")).toHaveText("1 request group");
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503,
        contentType: "application/json", body: '{"error":"Invented date read failure"}' }), { times: 1 });
    await selectActivityOption(page, "dateFilter", "month"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("Previous results: 2 Work IQ tool calls (Mar 8, 2026)");
    await expect(page.locator(".percentage-section")).toHaveAttribute("data-total", "2");
    await expect(page.locator("#exportBtn")).toBeDisabled();
    await page.locator("#resetView").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("11");
    await expect(page.locator("#periodResult")).toHaveText("11 Work IQ tool calls (All dates)");
});
