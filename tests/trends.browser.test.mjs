import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

async function capture(page, name) {
    if (!process.env.WIRE_TRENDS_PROOFS) return;
    await mkdir(process.env.WIRE_TRENDS_PROOFS, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(process.env.WIRE_TRENDS_PROOFS, name + ".png"), fullPage: true });
}

function records() {
    return Array.from({ length: 60 }, (_, index) => {
        const record = fixture(`trends-${index}`), day = String(index % 30 + 1).padStart(2, "0");
        record.sourceSessionId = `invented-chat-${index % 4}`;
        record.title = `Invented trend request ${index}`;
        record.userPrompt = { text: `Find the Cedar release notes for day ${day}.`, status: "full",
            sourceEventId: `trends-prompt-${index}`, sourceTimestamp: `2026-08-${day}T12:00:00Z`,
            authorship: index % 3 ? { actor: "user", basis: "source-user" } : { actor: "agent", basis: "source-agent" } };
        Object.assign(record.toolCalls[0], { startedAt: `2026-08-${day}T12:00:01Z`, completedAt: `2026-08-${day}T12:00:02Z`,
            durationMs: 1000, completionEventId: `trends-end-${index}`, tool: index % 4 ? "workiq-fetch" : "workiq-retrieve",
            requestArgs: { entityUrls: [index % 3 ? "/me/messages" : "/me/drive/root"] },
            toolSucceeded: index % 7 !== 0, reportedOutcome: index % 7 ? "succeeded" : "failed" });
        return record;
    });
}

function boundary(options) {
    let active = true, epoch = 0, held = false;
    const tokens = new WeakMap(), control = {};
    const publicationToken = () => { if (!active) return null; const token = {}; tokens.set(token, epoch); return token; };
    const api = Object.assign(async (...args) => {
        const value = await options.api(...args);
        if (held && args[0] === "/api/trends") { held = false; return new Promise(resolve => { control.release = () => resolve(value); }); }
        return value;
    }, { publicationToken, isCurrent: token => active && tokens.get(token) === epoch });
    const owner = assessmentFactories.mountTrends({ ...options, api, getContext: () => ({ ...options.getContext(), publication: publicationToken() }) });
    control.withdraw = () => { active = false; epoch++; owner.withdrawAccess(); };
    control.hold = () => { held = true; };
    control.update = () => owner.update();
    window.trendsBoundary = control;
    return owner;
}

async function setup(t, withBoundary = false, options = {}) {
    let cleanup;
    const { context } = await privateFixture({ after: value => { cleanup = value; } }, options.records ?? records());
    const before = await loadBoardState(context), errors = [], denied = [], reads = [];
    const server = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw new Error("No providers in Trends proof."); }, readSource() { throw new Error("No history reads in Trends proof."); } },
    });
    const browser = await chromium.launch();
    t.after(async () => {
        try { await browser.close(); await server.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(await loadBoardState(context), before); }
        finally { await cleanup(); }
    });
    const page = await browser.newPage({ viewport: options.viewport ?? { width: 1440, height: 1000 }, timezoneId: "UTC",
        reducedMotion: options.motion ?? "reduce", hasTouch: options.touch ?? false });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/trends", "/api/report-artifacts/list", "/api/period-comparison",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        if (url.pathname === "/api/trends") reads.push(request.postDataJSON());
        if (withBoundary && url.pathname === "/") {
            const response = await route.fetch(), text = await response.text();
            return route.fulfill({ response, body: text.replace("const trendsUI = assessmentFactories.mountTrends({", `const trendsUI = (${boundary.toString()})({`) });
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await navigateMain(page, "trends");
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    return { page, reads };
}
async function dates(page, from = "2026-08-01", to = "2026-08-30") {
    await page.locator("#trendsView").getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Trends from", { exact: true }).fill(from);
    await page.getByLabel("Trends to", { exact: true }).fill(to);
    const response = page.waitForResponse(response => response.url().endsWith("/api/trends") && response.ok());
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    const value = await (await response).json();
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    return value;
}

function measureRecords() {
    let callIndex = 0;
    return ["user", "agent", "unknown"].map((actor, index) => {
        const record = fixture(`measure-${index}`), stamp = "2026-08-01T12:00:00.000Z";
        record.sourceSessionId = "measure-chat";
        record.userPrompt = { text: `Find Cedar evidence for request ${index}.`, status: "full", sourceTimestamp: stamp,
            sourceEventId: `measure-origin-${index}`, authorship: { actor, basis: actor === "unknown" ? "missing-source" : `source-${actor}` } };
        const base = record.toolCalls[0];
        record.toolCalls = Array.from({ length: index === 0 ? 3 : 1 }, () => {
            const id = callIndex++, duration = [100, 200, null, 900, 0][id];
            const paths = id === 0 ? ["/me/messages", "/me/drive/root"] : id === 1 ? ["/me/messages"] : id < 4 ? ["/me/drive/root"] : [];
            return { ...structuredClone(base), toolCallId: `measure-call-${id}`, startEventId: `measure-start-${id}`,
                tool: id === 4 ? "workiq-retrieve" : "workiq-fetch", startedAt: stamp,
                completedAt: duration === null ? null : new Date(Date.parse(stamp) + duration).toISOString(),
                durationMs: duration, completionEventId: duration === null ? null : `measure-end-${id}`,
                toolSucceeded: id !== 0, reportedOutcome: id === 0 ? "failed" : "succeeded",
                requestArgs: { entityUrls: paths }, requestedApiPath: paths.length === 1 ? paths[0] : null,
                apiResults: paths.map((path, index) => ({ index, path, statusCode: id === 1 ? 503 : 200 })) };
        });
        if (index !== 2) record.originalModelEvidence = {
            version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId,
            promptMessageId: `measure-message-${index}`, partial: false, ambiguous: false,
            responses: (index === 0 ? ["Cedar model", "Maple model"] : ["Maple model"]).map((model, number) => ({
                eventId: `measure-response-${index}-${number}`, apiCallId: `measure-api-${index}-${number}`,
                at: "2026-08-01T12:00:02.000Z", turnId: `measure-turn-${index}-${number}`, model, modelStatus: "recorded",
            })),
        };
        return record;
    });
}

async function inspectionBars(page) {
    return page.locator(".trends-value-row").evaluateAll(nodes => nodes.map(node => {
        const track = node.querySelector(".trends-value-track"), fill = node.querySelector(".trends-value-fill");
        return { label: node.querySelector(".trends-series-label").textContent,
            text: node.querySelector(".trends-value").textContent,
            percent: fill.getBoundingClientRect().width * 100 / track.getBoundingClientRect().width };
    }));
}

async function expectEvidence(page, calls) {
    await page.getByRole("button", { name: "View evidence", exact: true }).click();
    const ids = await page.locator(".trends-evidence-row a").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(node.hash.split("?")[1]).get("call")));
    assert.deepEqual(ids.sort(), calls.map(id => `call:["measure-chat","measure-call-${id}"]`).sort());
    await expect(page.locator(".trends-dialog")).toContainText("Opening a call shows its full interaction.");
}

test("reach, call-share and count bars use their chart scale while selected tool evidence keeps exact membership", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: measureRecords() });
    const data = await dates(page, "2026-08-01", "2026-08-01");
    assert.equal(data.totals.calls, 5); assert.equal(data.totals.interactions, 3);
    await page.locator('.trends-option[data-family="tools"]').click();
    const check = async (texts, widths) => {
        const rows = await inspectionBars(page);
        assert.deepEqual(rows.map(row => row.text), texts);
        rows.forEach((row, index) => assert.ok(Math.abs(row.percent - widths[index]) < .1, `${row.label}: ${row.percent}, expected ${widths[index]}`));
    };
    await check(["66.7% (2)", "33.3% (1)"], [200 / 3, 100 / 3]);
    await page.locator("#trendsPlot").getByRole("button", { name: /fetch,/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".trends-inspection-heading")).toContainText("fetch · Interaction reach");
    await capture(page, "qualified-reach-membership");
    await expectEvidence(page, [0, 1, 2, 3]);
    await page.locator(".trends-evidence-row a").first().click();
    await expect(page.locator("#requestContent")).toContainText("Find Cedar evidence");
    await page.getByRole("button", { name: "Close interaction", exact: true }).click();
    await expect(page.locator(".trends-inspection-heading")).toContainText("fetch · Interaction reach");
    await selectActivityOption(page, "trendsShow", "count");
    await check(["4", "1"], [80, 20]); // The stacked count axis spans all five calls.
    await expect(page.locator(".trends-inspection-heading")).toContainText("fetch · Calls");
    await expectEvidence(page, [0, 1, 2, 3]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await selectActivityOption(page, "trendsShow", "share");
    await check(["80% (4)", "20% (1)"], [80, 20]);
    await selectActivityOption(page, "trendsShow", "reach");
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const checkbox = page.getByRole("checkbox", { name: "Show fetch", exact: true });
    await checkbox.scrollIntoViewIfNeeded(); await settle(page);
    const before = await page.locator("#trendsPlot").boundingBox();
    await checkbox.click(); await settle(page);
    const after = await page.locator("#trendsPlot").boundingBox();
    assert.ok(Math.abs(before.y - after.y) < 1, "Hiding the selected series must not bounce the plot");
    await expect(page.locator(".trends-inspection-heading")).toContainText("fetch (hidden) · Interaction reach");
    await check(["33.3% (1)"], [100 / 3]);
    await expectEvidence(page, [0, 1, 2, 3]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await selectActivityOption(page, "trendsShow", "count");
    await check(["1"], [20]);
});

test("author, overlapping service/model, error, timing and calendar marks open only their supporting calls", { timeout: 60000 }, async t => {
    const { page } = await setup(t, false, { records: measureRecords() });
    await dates(page, "2026-08-01", "2026-08-01");
    await page.locator('.trends-option[data-family="authors"]').click();
    const cases = [
        ["authors", "share", "My prompts", [0, 1, 2], "33.3% (1)", 100 / 3],
        ["authors", "count", "My prompts", [0, 1, 2], "1", 100 / 3],
        ["services", "share", "Mail", [0, 1], "40% (2)", 40],
        ["services", "count", "Mail", [0, 1], "2", 200 / 3],
        ["services", "share", "Files", [0, 2, 3], "60% (3)", 60],
        ["models", "share", "Cedar model", [0, 1, 2], "33.3% (1)", 100 / 3],
        ["models", "count", "Maple model", [0, 1, 2, 3], "2", 100],
        ["problems", "share", "Errors & failures", [0, 1], "33.3% (1)", 100 / 3],
        ["problems", "count", "Errors & failures", [0, 1], "1", 100],
        ["timing", "median", "Tool latency", [0, 1, 3, 4], "100 ms", null],
        ["timing", "p95", "Tool latency", [0, 1, 3, 4], "900 ms", null],
        ["rhythm", "count", "Call activity", [0, 1, 2, 3, 4], "5", 100],
        ["rhythm", "share", "Call activity", [0, 1, 2, 3, 4], "100% (5)", 100],
    ];
    for (const [family, mode, label, calls, text, width] of cases) {
        await selectActivityOption(page, "trendsTrend", family);
        await selectActivityOption(page, "trendsShow", mode);
        const mark = family === "rhythm" ? page.locator(".trends-day-cell") : page.locator("#trendsPlot").getByRole("button", { name: new RegExp(label + ",") });
        await mark.focus(); await page.keyboard.press("Enter");
        await expect(page.locator(".trends-inspection-heading")).toContainText(label);
        const selected = page.locator('.trends-value-row[data-selected="true"]');
        await expect(selected.locator(".trends-value")).toHaveText(text);
        if (width === null) await expect(selected.locator(".trends-value-track")).toHaveCSS("visibility", "hidden");
        else {
            const row = (await inspectionBars(page)).find(row => row.label === label);
            assert.ok(Math.abs(row.percent - width) < .1, `${family}/${mode}: ${row.percent}, expected ${width}`);
        }
        await expectEvidence(page, calls);
        await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    await dates(page, "2026-08-01", "2026-08-02");
    await selectActivityOption(page, "trendsTrend", "timing");
    await page.locator("#trendsPlot").getByRole("button", { name: /Aug 2:/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('.trends-value-row[data-selected="true"] .trends-value')).toHaveText("Unavailable");
    await expect(page.getByRole("button", { name: "View evidence", exact: true })).toBeDisabled();
});

test("Trends opens normally, keeps 30 daily points and connects exact selected evidence to the existing reader", { timeout: 45000 }, async t => {
    const { page, reads } = await setup(t);
    await expect(page.locator(".trends-option")).toHaveCount(7);
    const data = await dates(page);
    assert.equal(data.days.length, 30);
    assert.equal(data.totals.calls, 60);
    await page.locator('.trends-option[data-family="tools"]').click();
    await expect(page.locator(".trends-heading h2")).toHaveText("Which tools are becoming more common?");
    const marks = page.locator("#trendsPlot [data-trend-mark]");
    await expect(marks).toHaveCount(60);
    await capture(page, "trends-tools-light");
    await marks.first().focus();
    await expect(page.locator("#trendsTooltip")).toBeVisible();
    await expect(page.locator("#trendsTooltip")).toContainText("Reach");
    await capture(page, "trends-reach-hover");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator(".trends-inspection-heading h3")).toHaveText("Aug 2");
    await page.getByRole("button", { name: "View evidence", exact: true }).click();
    await page.locator(".trends-evidence-row a").first().click();
    await expect(page.locator("#requestContent")).toContainText("Cedar release notes");
    await page.getByRole("button", { name: "Close interaction", exact: true }).click();
    await expect(page).toHaveURL(/#trends$/);
    await expect(page.locator(".trends-heading h2")).toHaveText("Which tools are becoming more common?");
    await expect(page.locator(".trends-caption")).toContainText("Aug 1, 2026");
    assert.ok(reads.every(read => !("scenarioIds" in read) && read.timeContext.timeZone === "UTC"));
});

test("series visibility does not rebase percentages, recreate controls or shift the chart at the page bottom", { timeout: 45000 }, async t => {
    const { page, reads } = await setup(t);
    const value = await dates(page);
    await page.locator('.trends-option[data-family="services"]').click();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const checkbox = page.getByRole("checkbox", { name: "Show Files", exact: true });
    await checkbox.focus();
    const before = await page.evaluate(() => {
        window.trendsControl = document.querySelector('.trends-series input[data-series="Files"]');
        return { y: scrollY, top: document.getElementById("trendsPlot").getBoundingClientRect().top };
    });
    const readCount = reads.length;
    await page.keyboard.press("Space");
    const after = await page.evaluate(() => ({ y: scrollY, top: document.getElementById("trendsPlot").getBoundingClientRect().top,
        mounted: window.trendsControl.isConnected, focused: window.trendsControl === document.activeElement }));
    assert.equal(after.mounted, true); assert.equal(after.focused, true);
    assert.ok(Math.abs(after.top - before.top) < 1); assert.ok(Math.abs(after.y - before.y) < 1);
    assert.equal(reads.length, readCount);
    await page.getByRole("button", { name: "View numbers", exact: true }).click();
    await expect(page.locator(".trends-exact")).toContainText("Files");
    assert.equal(value.totals.values.services.find(row => row.id === "Files").eligible, 60);
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 440, height: 1000 });
    await expect(page.locator("#trendsPlot")).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await capture(page, "trends-services-dark-narrow");
});

test("the seven built-in choices, daily calendar, population filters and simple highlight preference work through ordinary controls", { timeout: 45000 }, async t => {
    const { page, reads } = await setup(t);
    await dates(page);
    await page.locator('.trends-option[data-family="rhythm"]').click();
    await expect(page.locator(".trends-day-cell")).toHaveCount(30);
    await page.locator(".trends-day-cell").first().focus();
    await expect(page.locator("#trendsTooltip")).toContainText("calls");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator(".trends-inspection-heading h3")).toHaveText("Aug 2");
    for (const id of ["authors", "services", "problems", "timing", "models", "tools"]) {
        await selectActivityOption(page, "trendsTrend", id);
        await expect(page.locator(".trends-panel")).toBeVisible();
        await expect(page.locator("#trendsPlot svg")).toBeVisible();
        if (id === "problems") {
            const space = await page.locator(".trends-inspection-body").evaluate(node => ({
                body: node.getBoundingClientRect().height,
                row: node.firstElementChild.getBoundingClientRect().height,
            }));
            assert.ok(space.body <= space.row + 1, "A new single-measure view must not retain the prior service rows' empty space");
        }
    }
    const count = reads.length;
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await selectActivityOption(page, "trendsService", "Files");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(reads.length, count);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await selectActivityOption(page, "trendsService", "Files");
    const response = page.waitForResponse(response => response.url().endsWith("/api/trends") && response.ok());
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    const filtered = await (await response).json();
    assert.equal(filtered.days.length, 30);
    assert.equal(filtered.totals.calls, 20);
    await expect(page.locator(".trends-restrictions")).toContainText("Files");
    await page.getByRole("button", { name: "Back to Trends", exact: true }).click();
    await page.getByRole("button", { name: "Choose highlights", exact: true }).click();
    await page.locator(".trends-choice").filter({ hasText: "Timing" }).getByRole("checkbox").check();
    await page.getByRole("button", { name: "Use my choices", exact: true }).click();
    await expect(page.locator(".trends-overview-heading")).toContainText("Your overview");
    await page.reload();
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator('.trends-highlight[data-family="timing"]')).toBeVisible();
});

test("withdrawal clears held chart content and refuses late Trends publication", { timeout: 45000 }, async t => {
    const { page } = await setup(t, true);
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').click();
    await page.locator("#trendsPlot [data-trend-mark]").first().focus();
    await page.evaluate(() => {
        window.oldTrendMark = document.querySelector("#trendsPlot [data-trend-mark]");
        window.oldTrendLabel = window.oldTrendMark.getAttributeNode("aria-label");
        window.oldTrendText = document.querySelector("#trendsTooltip .trends-tip-caption").firstChild;
        window.trendsBoundary.hold();
    });

    await page.getByRole("button", { name: "Last 14 days", exact: true }).click();
    await page.waitForFunction(() => typeof window.trendsBoundary.release === "function");
    await page.evaluate(() => { window.trendsBoundary.withdraw(); window.trendsBoundary.release(); });
    await expect(page.locator("#trendsPlot")).toBeEmpty();
    const retired = await page.evaluate(() => ({ label: window.oldTrendLabel.value, text: window.oldTrendText.data, tip: document.getElementById("trendsTooltip").textContent }));
    assert.deepEqual(retired, { label: "", text: "", tip: "" });
});

test("leaving a pending range read returns to the last accepted trend without a stuck loading state", { timeout: 45000 }, async t => {
    const { page } = await setup(t, true);
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').click();
    await page.evaluate(() => window.trendsBoundary.hold());
    await page.getByRole("button", { name: "Last 14 days", exact: true }).click();
    await page.waitForFunction(() => typeof window.trendsBoundary.release === "function");
    await navigateMain(page, "analyze");
    await navigateMain(page, "trends");
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".trends-caption")).toContainText("Aug 1, 2026");
    await page.evaluate(() => window.trendsBoundary.release());
    await expect(page.locator(".trends-caption")).toContainText("Aug 1, 2026");
    await expect(page.locator(".trends-heading h2")).toHaveText("Which tools are becoming more common?");
});

function journeyRecords() {
    const names = ["gpt-5.4", "deployment/" + "ModelReference".repeat(9)];
    return Array.from({ length: 180 }, (_, index) => {
        const day = Math.floor(index / 6) + 1, slot = index % 6, stamp = `2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`;
        const record = fixture(`journey-${index}`);
        record.sourceSessionId = `invented-journey-${day % 3}`;
        record.title = `Invented Cedar request ${index}`;
        const actor = slot === 5 ? "unknown" : slot < day % 5 ? "agent" : "user";
        record.userPrompt = { text: `Find the Cedar release evidence for August ${day}.`, status: "full", sourceTimestamp: stamp,
            sourceEventId: `journey-prompt-${index}`, authorship: { actor, basis: actor === "unknown" ? "missing-source" : `source-${actor}` } };
        const tool = ["workiq-fetch", "workiq-retrieve", "workiq-fetch", "workiq-get_schema", "workiq-ask", "workiq-fetch"][slot];
        const target = slot === 0 ? "/me/drive/root" : slot === 2 || slot === 3 ? "/me/messages"
            : slot === 5 ? day % 2 ? "/me/calendarView" : "/teams/{id}/channels/{id}/messages" : null;
        const duration = day === 1 && slot === 1 ? 0 : 400 + day * 40 + slot * 110;
        const unknown = slot === 4 && day % 5 === 0, failure = slot === 4 && day % 3 === 0 && !unknown;
        Object.assign(record.toolCalls[0], { tool, startedAt: stamp,
            completedAt: unknown ? null : new Date(Date.parse(stamp) + duration).toISOString(),
            completionEventId: unknown ? null : `journey-end-${index}`, durationMs: unknown ? null : duration,
            requestArgs: target ? { entityUrls: [target] } : {}, requestedApiPath: target,
            toolSucceeded: unknown ? null : !failure, reportedOutcome: unknown ? "unknown" : failure ? "failed" : "succeeded",
            apiResults: target && slot !== 3 ? [{ index: 0, path: target, statusCode: slot === 2 && day % 7 === 0 ? 503 : 200 }] : [] });
        if (slot === 0) record.toolCalls.push({ ...structuredClone(record.toolCalls[0]), toolCallId: `journey-repeat-${index}`, startEventId: `journey-repeat-start-${index}` });
        if (slot !== 5) record.originalModelEvidence = {
            version: 1, sourceSessionId: record.sourceSessionId, promptEventId: record.userPrompt.sourceEventId,
            promptMessageId: `journey-message-${index}`, partial: slot === 4, ambiguous: false,
            responses: (slot === 0 ? names : [names[day < 15 ? 0 : 1]]).map((model, number) => ({
                eventId: `journey-response-${index}-${number}`, apiCallId: `journey-api-${index}-${number}`,
                at: new Date(Date.parse(stamp) + 2000 + number * 1000).toISOString(), turnId: `journey-turn-${index}-${number}`, model, modelStatus: "recorded",
            })),
        };
        return record;
    }).filter((_, index) => Math.floor(index / 6) !== 14);
}

async function settle(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => ["sidebar", "contextSidebar", "navigationDrawer"].every(id =>
        document.getElementById(id).getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
    await page.waitForFunction(() => document.getElementById("trendsView").getAnimations({ subtree: true })
        .every(animation => animation.playState !== "running"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pointerMark(page, index = 0) {
    const mark = page.locator("#trendsPlot [data-trend-mark]").nth(index);
    await mark.scrollIntoViewIfNeeded();
    await settle(page);
    const box = await mark.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#trendsTooltip")).toBeVisible();
    await expect(page.locator("#trendsTooltip")).toHaveCSS("opacity", "1");
}

test("real pointer inspection supplies specific values for every chart and never activates blank plot space", { timeout: 60000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords(), motion: "no-preference" });
    await dates(page);
    await page.locator('.trends-option[data-family="authors"]').click();
    const cases = [
        ["authors", /Calls in these interactions/], ["tools", /Additional calls/], ["services", /another service/],
        ["problems", /Failed tool calls/], ["timing", /Timing coverage/], ["models", /Model not recorded/], ["rhythm", /Interactions/],
    ];
    for (const [family, expected] of cases) {
        if (family !== "authors") await selectActivityOption(page, "trendsTrend", family);
        const valid = await page.locator("#trendsPlot [data-trend-mark]").evaluateAll(nodes =>
            nodes.findIndex(node => node.tagName.toLowerCase() !== "circle" || Number(node.getAttribute("cy")) > 44));
        await pointerMark(page, Math.max(0, valid));
        await expect(page.locator("#trendsTooltip")).toContainText(expected);
        const dimensions = await page.locator("#trendsTooltip").evaluate(node => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom, top: box.top, width: innerWidth, height: innerHeight,
                overflow: node.scrollWidth > node.clientWidth + 1 };
        });
        assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width && dimensions.top >= 0 && dimensions.bottom <= dimensions.height, family);
        assert.equal(dimensions.overflow, false, family + " tooltip text stays inside its card");
        await capture(page, `qualified-pointer-${family}`);
        await page.keyboard.press("Escape");
        await expect(page.locator("#trendsTooltip")).toBeHidden();
        await page.mouse.move(8, 8);
        await page.waitForTimeout(120);
        const blank = family === "rhythm" ? await page.locator(".trends-day-cell").first().evaluate(node => {
            const box = node.getBoundingClientRect(); return { x: box.x - 4, y: box.y + box.height / 2 };
        }) : await page.locator("#trendsPlot svg").evaluate(svg => {
            const centers = [...new Set([...svg.querySelectorAll("[data-trend-mark]")].map(node => {
                const box = node.getBBox(); return box.x + box.width / 2;
            }))].sort((a, b) => a - b);
            const grid = [...svg.querySelectorAll(".trends-grid")].map(node => Number(node.getAttribute("y1")));
            const point = new DOMPoint((centers[0] + centers[1]) / 2, Math.min(...grid) + (Math.max(...grid) - Math.min(...grid)) * .1)
                .matrixTransform(svg.getScreenCTM());
            return { x: point.x, y: point.y };
        });
        await page.mouse.move(blank.x, blank.y);
        await expect(page.locator("#trendsTooltip")).toBeHidden();
    }
});

test("the left sidebar opens every peer and preserves Trends through collapse, expansion, drawer and reader transitions", { timeout: 90000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords(), motion: "no-preference" });
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').click();
    for (const mode of ["expanded", "collapsed", "drawer"]) {
        if (mode === "collapsed") { await page.locator("#navigationCollapse").click(); await settle(page); }
        if (mode === "drawer") { await page.setViewportSize({ width: 440, height: 900 }); await settle(page); }
        for (const destination of ["analyze", "reports", "compare", "settings"]) {
            await navigateMain(page, destination); await settle(page);
            await expect(page.locator('nav [data-nav="' + destination + '"]')).toHaveAttribute("aria-current", "page");
            if (destination === "compare") await expect(page.locator("#periodComparison")).toBeVisible();
            await navigateMain(page, "trends"); await settle(page);
            await expect(page.locator(".trends-heading h2")).toHaveText("Which tools are becoming more common?");
            await expect(page.locator(".trends-caption")).toContainText("Aug 1, 2026");
            await expect(page.locator('[data-trend-period="custom"]')).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator('[data-trend-period="7"]')).toHaveAttribute("aria-pressed", "false");
            await page.mouse.move(8, 8);
            await settle(page);
            const selectedPaint = await page.locator('[data-trend-period="custom"]').evaluate(measureControlSurface);
            const ordinaryPaint = await page.locator('[data-trend-period="7"]').evaluate(measureControlSurface);
            assert.ok(contrast(selectedPaint.border, ordinaryPaint.border) > 1.1, "The accepted period has a visibly distinct control face");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
        await page.getByRole("button", { name: "View evidence", exact: true }).click();
        await page.locator(".trends-evidence-row a").first().click(); await settle(page);
        await expect(page.locator("#requestContent")).toContainText("Cedar release evidence");
        if (mode === "drawer") {
            await page.getByRole("button", { name: "Close interaction", exact: true }).click();
        } else {
            await navigateMain(page, "reports"); await settle(page);
            await navigateMain(page, "trends");
        }
        await settle(page);
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await expect(page.locator(".trends-heading h2")).toHaveText("Which tools are becoming more common?");
        await expect(page.locator(".trends-caption")).toContainText("Aug 1, 2026");
        await capture(page, `qualified-sidebar-${mode}`);
    }
});

test("series and measure changes stay stable in both themes and enlarged narrow text remains readable", { timeout: 60000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords() });
    await dates(page);
    await page.locator('.trends-option[data-family="services"]').click();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [1440, 776, 440]) {
            await page.setViewportSize({ width, height: 1000 }); await settle(page);
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
            for (const label of ["Teams", "Search and retrieval", "Calendar"]) {
                const control = page.getByRole("checkbox", { name: `Show ${label}`, exact: true });
                await control.scrollIntoViewIfNeeded(); await settle(page);
                const before = await page.locator("#trendsPlot").boundingBox();
                await control.click(); await settle(page);
                const after = await page.locator("#trendsPlot").boundingBox();
                assert.ok(Math.abs(before.y - after.y) < 1, `${theme}/${width}/${label} bounced: ${before.y} -> ${after.y}`);
            }
            const measureControl = page.locator('[data-select-id="trendsShow"]');
            await measureControl.scrollIntoViewIfNeeded(); await settle(page);
            const measureBefore = await page.locator("#trendsPlot").boundingBox();
            await selectActivityOption(page, "trendsShow", "count"); await settle(page);
            const measureAfter = await page.locator("#trendsPlot").boundingBox();
            assert.ok(Math.abs(measureBefore.y - measureAfter.y) < 1, `${theme}/${width}: Calls selection moved the plot ${measureBefore.y} -> ${measureAfter.y}`);
            await selectActivityOption(page, "trendsShow", "share"); await settle(page);
            await capture(page, `qualified-services-${theme}-${width}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await settle(page);
    const sizes = await page.evaluate(() => ({
        body: parseFloat(getComputedStyle(document.body).fontSize),
        chart: parseFloat(getComputedStyle(document.querySelector("#trendsPlot text")).fontSize),
        count: parseFloat(getComputedStyle(document.querySelector(".trends-stat-value")).fontSize),
        overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(sizes.overflow, false, "200% text must not overflow the page");
    assert.ok(sizes.chart >= sizes.body * .8, `Enlarged chart labels stayed tiny: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.count > sizes.body, "Period counts retain their visual hierarchy");
    await capture(page, "qualified-services-200percent");
});

test("enlarged chart text and long recorded model labels fit the working view", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords() });
    await dates(page);
    await page.locator('.trends-option[data-family="models"]').click();
    await page.setViewportSize({ width: 440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await settle(page);
    await page.locator("#trendsPlot [data-trend-mark]").first().focus();
    await page.keyboard.press("Enter");
    await capture(page, "qualified-models-200percent");
    const size = await page.evaluate(() => ({
        body: parseFloat(getComputedStyle(document.body).fontSize),
        chart: parseFloat(getComputedStyle(document.querySelector("#trendsPlot text")).fontSize),
        document: document.documentElement.scrollWidth,
        viewport: innerWidth,
    }));
    assert.ok(size.chart >= size.body * .8, `Chart labels do not scale: ${JSON.stringify(size)}`);
    assert.equal(size.document <= size.viewport, true, `Long model names overflow: ${JSON.stringify(size)}`);
    await page.getByRole("button", { name: "View evidence", exact: true }).click();
    assert.equal(await page.locator(".trends-dialog").evaluate(node => node.scrollWidth > node.clientWidth + 1), false,
        "The selected model's exact name must wrap in the evidence dialog");
    await capture(page, "qualified-model-evidence-200percent");
});

test("calendar call counts retain readable painted contrast and usable targets in both themes", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords() });
    await dates(page);
    await page.locator('.trends-option[data-family="rhythm"]').click();
    await selectActivityOption(page, "trendsShow", "count");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const cell = page.locator(".trends-day-cell").first();
        await cell.scrollIntoViewIfNeeded(); await settle(page);
        const paint = await cell.evaluate(measureControlSurface);
        assert.ok(contrast(paint.ink, paint.face) >= 4.5, `${theme}: ${JSON.stringify(paint)}`);
        assert.ok(paint.box.width >= 44 && paint.box.height >= 44);
        const panel = await page.locator(".trends-panel").evaluate(node => getComputedStyle(node).backgroundColor);
        assert.ok(contrast(paint.face, panel) > 1.05, `${theme}: the calendar's heat color is hidden by the control face`);
        const zero = page.locator(".trends-day-cell").filter({ hasText: /^0$/ }).first();
        const zeroPaint = await zero.evaluate(measureControlSurface);
        assert.ok(contrast(zeroPaint.face, panel) < 1.02, "Zero cells have no positive activity paint");
        await capture(page, `qualified-calendar-counts-${theme}`);
    }
});

test("sidebar glide keeps the Trends plot and legend vertically steady through collapse and expansion", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords(), motion: "no-preference" });
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').click();
    await page.evaluate(() => scrollTo(0, 0)); await settle(page);
    for (const phase of ["collapse", "expand"]) {
        await page.evaluate(() => {
            window.trendsMotionSamples = [];
            window.trendsMotionFinished = false;
            const end = performance.now() + 700;
            const sample = () => {
                window.trendsMotionSamples.push({
                    width: document.getElementById("sidebar").getBoundingClientRect().width,
                    plot: document.getElementById("trendsPlot").getBoundingClientRect().top,
                    legend: document.querySelector(".trends-legend").getBoundingClientRect().top,
                });

                if (performance.now() < end) requestAnimationFrame(sample);
                else window.trendsMotionFinished = true;
            };
            requestAnimationFrame(sample);
        });
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => window.trendsMotionFinished);
        const samples = await page.evaluate(() => window.trendsMotionSamples);
        const widths = samples.map(value => value.width), minimum = Math.min(...widths), maximum = Math.max(...widths);
        assert.ok(maximum - minimum > 100 && widths.some(width => width > minimum + 5 && width < maximum - 5), phase + " has an actual glide");
        for (const field of ["plot", "legend"]) {
            const positions = samples.map(value => value[field]);
            assert.ok(Math.max(...positions) - Math.min(...positions) < 1, `${phase}/${field}: ${Math.min(...positions)}–${Math.max(...positions)}`);
        }
    }
});

test("touch selects exact line and calendar dates without depending on hover", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords(), touch: true, viewport: { width: 440, height: 1000 } });
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').tap();
    const mark = page.locator("#trendsPlot [data-trend-mark]").first();
    await mark.scrollIntoViewIfNeeded(); await settle(page);
    const box = await mark.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".trends-inspection-heading h3")).toHaveText("Aug 1");
    await page.getByRole("button", { name: "View evidence", exact: true }).tap();
    await expect(page.locator(".trends-evidence-row a").first()).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).tap();
    await selectActivityOption(page, "trendsTrend", "rhythm");
    await page.locator(".trends-day-cell").nth(2).tap();
    await expect(page.locator(".trends-inspection-heading h3")).toHaveText("Aug 3");
});

test("unchanged parent renders do not remount a chart or dismiss its inspected value", { timeout: 45000 }, async t => {
    const { page, reads } = await setup(t, true);
    await dates(page);
    await page.locator('.trends-option[data-family="tools"]').click();
    await settle(page);
    await page.locator("#trendsPlot [data-trend-mark]").first().focus();
    await expect(page.locator("#trendsTooltip")).toBeVisible();
    const readCount = reads.length;
    const result = await page.evaluate(() => {
        const chart = document.querySelector("#trendsPlot svg"), value = document.getElementById("trendsTooltip").textContent;
        window.trendsBoundary.update();
        return { sameChart: chart === document.querySelector("#trendsPlot svg"),
            sameValue: value === document.getElementById("trendsTooltip").textContent,
            visible: !document.getElementById("trendsTooltip").hidden };
    });
    assert.deepEqual(result, { sameChart: true, sameValue: true, visible: true });
    assert.equal(reads.length, readCount);
});

test("suggested highlights name their measured subject and open the exact supporting day across date pages", { timeout: 45000 }, async t => {
    const { page } = await setup(t, false, { records: journeyRecords() });
    const data = await dates(page, "2026-01-01", "2026-09-10");
    assert.ok(data.suggestions.length);
    const suggestion = data.suggestions[0];
    const card = page.locator(`.trends-highlight[data-family="${suggestion.family}"]`);
    await expect(card.locator("h3")).toHaveText(suggestion.first.value.label);
    await expect(page.locator(".trends-option").first()).toHaveCSS("border-top-width", "0px");
    assert.equal(await page.locator(".trends-option").first().evaluate(node => getComputedStyle(node, "::before").content), "none",
        "Marketplace rows must not acquire an extra inset button frame");
    await capture(page, "qualified-marketplace");
    await card.click();
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator(".trends-inspection-heading h3")).toHaveText("Aug 30");
    await expect(page.locator(".trends-paging")).toContainText("181–253 of 253 days");
    await expect(page.locator(".trends-inspection-heading")).toContainText(suggestion.last.value.label);
    await page.getByRole("button", { name: "View evidence", exact: true }).click();
    const ids = await page.locator(".trends-evidence-row a").evaluateAll(nodes => nodes.map(node =>
        new URLSearchParams(node.hash.split("?")[1]).get("call")));
    assert.deepEqual(ids.sort(), [...suggestion.last.value.rowIds].sort());
});
