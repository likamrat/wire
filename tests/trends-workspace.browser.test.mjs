import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, navigateSettings, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { palettes } from "../web/theme.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

// Two distinct prompts on Monday. The first uses fetch twice, including one
// Files + Mail call; the second uses retrieve. Wednesday has a returned error
// on a completed tool call; Tuesday has no calls.
function callsFixture() {
    return [["mon-a", 16, "user", [["fetch", ["messages", "drive/root"], 180, false], ["fetch", ["messages"], 0, true]]],
        ["mon-b", 16, "agent", [["retrieve", ["drive/root"], null, true]]],
        ["wed-c", 18, "unknown", [["fetch", ["calendarView"], 840, true]]]].map(([id, date, actor, specs]) => {
        const r = fixture(`chart-${id}`), stamp = `2026-11-${date}T12:15:00Z`, base = r.toolCalls[0];
        r.userPrompt = { text: `Review the invented harbor notes ${id}.`, status: "full", sourceTimestamp: stamp,
            sourceEventId: `prompt-${id}`, authorship: { actor, basis: actor === "unknown" ? "missing-source" : `source-${actor}` } };
        r.toolCalls = specs.map(([name, paths, durationMs, ok], i) => ({
            ...base, toolCallId: `${id}-${i}`, startEventId: `start-${id}-${i}`, completionEventId: durationMs === null ? null : `end-${id}-${i}`,
            tool: `workiq-${name}`, startedAt: new Date(Date.parse(stamp) + i * 60000).toISOString(), completedAt: durationMs === null ? null : new Date(Date.parse(stamp) + i * 60000 + durationMs).toISOString(),
            durationMs, requestArgs: { entityUrls: paths.map(p => `/me/${p}`) }, requestedApiPath: paths.length === 1 ? `/me/${paths[0]}` : null,
            toolSucceeded: ok, reportedOutcome: ok ? "succeeded" : "failed",
            apiResults: paths.map((p, index) => ({ index, path: `/me/${p}`, statusCode: id === "wed-c" ? 403 : 200 })),
        }));
        if (actor !== "unknown") r.originalModelEvidence = { version: 1, sourceSessionId: r.sourceSessionId,
            promptEventId: `prompt-${id}`, promptMessageId: `message-${id}`, partial: false, ambiguous: false,
            responses: (actor === "user" ? ["Alder", "Field notes extended reasoning model"] : ["Alder"]).map((model, i) => ({
                eventId: `reply-${id}-${i}`, apiCallId: `model-${id}-${i}`, at: stamp, turnId: `turn-${id}-${i}`, model, modelStatus: "recorded",
            })),
        };
        return r;
    });
}
async function setup(t, touch = false) {
    let cleanup;
    const { context } = await privateFixture({ after(fn) { cleanup = fn; } }, callsFixture()), original = await loadBoardState(context), errors = [], reads = [];
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react",
        collector: { timers: false }, evaluation: { evaluatorFactory() { throw Error("No evaluator in chart test"); }, readSource() { throw Error("No source in chart test"); } } });
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(async () => { try { await browser.close(); await server.close(); assert.deepEqual(errors, []); assert.deepEqual(await loadBoardState(context), original); } finally { await cleanup(); } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference", timezoneId: "UTC", hasTouch: touch });
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/session", "/api/access/watch", "/api/snapshot", "/api/collection/status", "/api/collection/sources/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/trends",
        ].includes(url.pathname)) { errors.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        if (url.pathname === "/api/trends") reads.push(request.postDataJSON()); return route.continue();
    });
    await page.clock.setFixedTime(new Date("2026-11-18T19:00:00Z")); await page.goto(new URL("/trends", server.url).href);
    const index = page.getByRole("navigation", { name: "Trend measures" });
    await expect(index.getByRole("button", { name: "Tool calls", exact: true })).toHaveAttribute("aria-current", "page");
    return { page, index, reads };
}
const panelOf = (page, id) => page.locator(`.trends-panel[data-family="${id}"]`);
const proof = process.env.WIRE_TRENDS_PROOFS;
async function screenshot(page, name) {
    if (!proof) return; await mkdir(proof, { recursive: true }); await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proof, `${name}.png`) });
}

test("compiled index applies every available filter, supports calendar navigation and pages without changing the full period", { timeout: 90000 }, async t => {
    const { page, reads } = await setup(t), region = page.locator("#trendsView"), card = panelOf(page, "rhythm");
    const period = page.locator("#trendsPeriod"), filter = region.getByRole("button", { name: "Filters", exact: true });
    const cases = { trendsPromptauthors: { "": 4, user: 2, agent: 1, unknown: 1 }, trendsTool: { "": 4, "workiq-fetch": 3, "workiq-retrieve": 1 },
        trendsService: { "": 4, Files: 2, Mail: 2, Calendar: 1, Discovery: 0, missing: 0 } };
    for (const [field, expected] of Object.entries(cases)) {
        await filter.click();
        const values = await page.locator(`#${field} option`).evaluateAll(options => options.map(option => option.value));
        assert.deepEqual(values.sort(), Object.keys(expected).sort());
        await page.keyboard.press("Escape"); await expect(filter).toBeFocused();
        for (const value of values) {
            await filter.click(); await selectActivityOption(page, field, value);
            await page.getByRole("button", { name: "Apply filters", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
            await expect(card.locator(".trends-index-scope")).toContainText(`${expected[value]} dated calls`);
        }
        await region.getByRole("button", { name: "Clear filters", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
    }
    for (const days of [14, 30, 7]) {
        await period.click(); await region.getByRole("button", { name: `Last ${days} days`, exact: true }).click();
        await expect(card.locator("[data-date-tick]")).toHaveCount(days);
    }
    const before = reads.length;
    await period.click(); await region.getByRole("button", { name: "Custom dates", exact: true }).click();
    await region.getByRole("button", { name: "Trends: Previous month" }).click(); await region.getByRole("button", { name: "Trends: Next month" }).click();
    const cell = page.locator('[data-day="2026-11-16"]'); await cell.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
    await expect(page.getByLabel("Trends from", { exact: true })).toHaveValue("2026-11-17");
    await expect(page.getByLabel("Trends to", { exact: true })).toHaveValue("2026-11-18");
    await page.getByLabel("Trends to", { exact: true }).fill("2026-11-10");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await expect(region.getByRole("dialog")).toBeVisible();
    assert.equal(reads.length, before, "invalid calendar drafts never read or replace the accepted range");
    await page.getByLabel("Trends from", { exact: true }).fill("2026-07-01"); await page.getByLabel("Trends to", { exact: true }).fill("2026-11-18");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(region.locator(".trends-paging")).toContainText("91–141 of 141");
    await region.getByRole("button", { name: "Earlier days" }).click(); await expect(card.locator("[data-date-tick]")).toHaveCount(90);
    await expect(card.locator(".trends-index-scope")).toContainText("4 dated calls");
    await region.getByRole("button", { name: "Later days" }).click(); await expect(card.locator("[data-date-tick]")).toHaveCount(51);
    await region.getByRole("button", { name: "Chart guide" }).click(); await expect(region.getByRole("dialog")).toContainText("Filters and series"); await page.keyboard.press("Escape");
    await period.click();
    const retainedFocus = await region.getByRole("dialog").evaluate(async dialog => {
        const mark = document.querySelector("#trendsPlot-rhythm [data-trend-mark]");
        const closed = new Promise(resolve => dialog.addEventListener("close", resolve, { once: true }));
        dialog.querySelector(".trends-dialog-heading button").click();
        mark.focus({ preventScroll: true });
        await closed;
        return document.activeElement === mark;
    });
    assert(retainedFocus, "A delayed close event must not steal an intentional chart focus");
});

test("compiled Trends uses the exact daily populations on both chart types and keeps dates, data and comparisons independent", { timeout: 90000 }, async t => {
    const { page, index, reads } = await setup(t);
    const names = { problems: "Errors & failures", rhythm: "Tool calls", tools: "Tool usage", services: "Services", timing: "Call duration", authors: "Prompt authors", models: "Response models" };
    const series = { problems: 1, rhythm: 1, tools: 2, services: 3, timing: 2, authors: 3, models: 2 };
    const initial = reads.length;
    for (const [id, label] of Object.entries(names)) {
        await index.getByRole("button", { name: label, exact: true }).click(); const panel = panelOf(page, id);
        await expect(panel).toBeVisible(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
        await expect(panel.locator("[data-trend-mark]")).toHaveCount(7 * series[id]);
        const names = await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label")));
        await screenshot(page, `measure-${id}-columns`);
        await panel.getByRole("button", { name: "Lines", exact: true }).click();
        assert.deepEqual(await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label"))), names);
        await panel.getByRole("button", { name: "Columns", exact: true }).click();
        if (id !== "timing") {
            await panel.getByRole("button", { name: "Percentage", exact: true }).click();
            await panel.getByRole("button", { name: "Count", exact: true }).click();
        }
        for (const check of await panel.locator(".trends-series input").all()) { await check.uncheck(); await expect(check).not.toBeChecked(); }
        if (series[id] > 1) await expect(panel.locator("[data-trend-mark]")).toHaveCount(0);
        for (const check of await panel.locator(".trends-series input").all()) await check.check();
        await panel.getByRole("button", { name: "Data table", exact: true }).click();
        const table = page.locator(".trends-dialog table"); await expect(table.locator("tbody tr")).toHaveCount(8);
        const monday = table.locator("tbody tr").filter({ hasText: "Nov 16" });
        await expect(monday.locator("td").nth(-2)).toHaveText("2"); await expect(monday.locator("td").last()).toHaveText("3");
        if (id === "rhythm") await expect(monday.locator("td").first()).toHaveText("3");
        if (id === "timing") { await expect(monday).toContainText("0 ms"); await expect(monday).toContainText("180 ms"); }
        if (id === "problems") { await expect(monday.locator("td").first()).toHaveText("1"); await expect(table.locator("tbody tr").filter({ hasText: /Nov 18|Today/ })).toContainText("1"); }
        await page.keyboard.press("Escape"); await expect(panel.getByRole("button", { name: "Data table" })).toBeFocused();
    }
    assert.equal(reads.length, initial, "Style, inspection, visibility and unit must not change the retained population");
    await index.getByRole("button", { name: "Tool usage", exact: true }).click();
    const tools = panelOf(page, "tools"), basis = tools.getByLabel("Percentage of", { exact: true });
    const percentage = tools.getByRole("button", { name: "Percentage", exact: true });
    await percentage.focus(); await page.keyboard.press("Space");
    await expect(percentage).toHaveAttribute("aria-pressed", "true");
    const fetch = tools.locator('[data-trend-mark][data-series="workiq-fetch"]').nth(4), tip = page.locator("#trendsTooltip");
    for (const [value, expected, fraction] of [["reach", "50%", "1 of 2 interactions"], ["share", "66.7%", "2 of 3 calls"]]) {
        await selectActivityOption(page, "trendsPercentageof", value); await fetch.focus();
        await expect(tip.locator(".trends-tip-value")).toHaveText(expected); await expect(tip).toContainText(fraction);
        await page.keyboard.press("Enter"); await expect(tools.getByRole("button", { name: "View 2 calls" })).toBeVisible();
    }
    await screenshot(page, "tool-percentage-inspected");
    await tools.getByRole("button", { name: "Count", exact: true }).click(); await expect(basis).toBeHidden();
    await index.getByRole("button", { name: "Services", exact: true }).click(); const services = panelOf(page, "services");
    const mail = services.locator('[data-trend-mark][data-series="Mail"]').nth(4);
    await mail.focus(); await expect(page.locator("#trendsTooltip")).toContainText("2 calls"); await page.keyboard.press("Enter");
    await expect(services.getByRole("button", { name: "View 2 calls" })).toBeVisible();
    await services.getByRole("button", { name: "Lines", exact: true }).click();
    await services.getByRole("button", { name: "Percentage", exact: true }).click(); await mail.focus();
    await expect(page.locator("#trendsTooltip")).toContainText("66.7%"); await expect(page.locator("#trendsTooltip")).toContainText("2 of 3 calls");
    await page.keyboard.press("Escape"); await services.getByRole("button", { name: "View 2 calls" }).click();
    const links = page.locator(".trends-evidence-row a");
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
        assert(!new URL(await link.getAttribute("href"), page.url()).searchParams.has("call"));
        await expect(link).toContainText("Review the invented harbor notes mon-a.");
    }
    const times = await page.locator(".trends-evidence-time").allTextContents();
    assert(times.some(text => text.includes("12:15")) && times.some(text => text.includes("12:16")), times.join("; "));
    await page.keyboard.press("Escape");
    await services.getByRole("button", { name: "Compare measures" }).click();
    const dialog = page.getByRole("dialog", { name: "Compare measures" }), choices = dialog.getByRole("checkbox");
    await dialog.getByRole("checkbox", { name: "Call duration", exact: true }).check();
    await dialog.getByRole("button", { name: "Cancel" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
    await services.getByRole("button", { name: "Compare measures" }).click();
    for (const check of await choices.all()) await check.check();
    await dialog.getByRole("button", { name: "Apply comparison" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(7);
    await services.getByRole("button", { name: "Compare measures" }).click();
    for (const check of await choices.all()) await check.uncheck();
    await dialog.getByRole("button", { name: "Apply comparison" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
    assert.equal(reads.length, initial);
});

test("compiled Trends keeps its mounted chart and scroll during accepted, canceled, pending and failed filter reads", { timeout: 90000 }, async t => {
    const { page, index } = await setup(t);
    await index.getByRole("button", { name: "Services", exact: true }).click();
    const panel = panelOf(page, "services"), filters = page.getByRole("button", { name: "Filters", exact: true });
    await page.setViewportSize({ width: 440, height: 650 });
    const marks = () => panel.locator("[data-trend-mark]").count(); const before = await marks();
    await filters.click(); await selectActivityOption(page, "trendsService", "Files"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await marks(), before); await expect(filters).toBeFocused();
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/trends", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); }, { times: 1 });
    await filters.click(); await selectActivityOption(page, "trendsService", "Files");
    await page.evaluate(() => { const chart = document.querySelector('[data-family="services"] .trends-plot'), control = document.querySelector(".trends-toolbar button[aria-label=Filters]");
        const top = chart.getBoundingClientRect().top, y = scrollY;
        window.sampleFilter = { chart, control, frames: [], done: false };
        (function tick() { const s = window.sampleFilter; s.frames.push([scrollY - y, chart.getBoundingClientRect().top - top]); if (!s.done) requestAnimationFrame(tick); })();
    });
    await page.getByRole("button", { name: "Apply filters" }).click(); await expect(page.locator(".trends-pending")).toContainText("Loading");
    await expect(panel.locator(".trends-index-scope")).toContainText("4 dated calls"); release();
    await expect(panel.locator(".trends-index-scope")).toContainText("2 dated calls");
    const motion = await page.evaluate(() => { const s = window.sampleFilter; s.done = true;
        return { frames: s.frames.length, mounted: s.chart.isConnected && s.control.isConnected, worst: Math.max(...s.frames.flat().map(Math.abs)) }; });
    assert(motion.frames > 2); assert(motion.mounted); assert(motion.worst <= 1, JSON.stringify(motion)); await expect(filters).toBeFocused();
    await page.route("**/api/trends", route => route.fulfill({ status: 422, json: { error: "Invented range failure" } }), { times: 1 });
    await page.getByRole("button", { name: "Clear filters", exact: true }).click(); await expect(page.locator("#trendsView .notice")).toBeVisible();
    await expect(panel.locator(".trends-index-scope")).toContainText("2 dated calls");
    await page.getByRole("button", { name: "Read stored activity", exact: true }).click(); await expect(panel.locator(".trends-index-scope")).toContainText("4 dated calls");
    if (proof) await writeFile(path.join(proof, "filter-motion.json"), JSON.stringify(motion));
});

test("compiled Trends is readable in all five palettes, both modes, narrow and enlarged with the same keyboard and touch evidence", { timeout: 150000 }, async t => {
    const { page, index } = await setup(t, true);
    for (const id of Object.keys(palettes)) {
        await navigateMain(page, "settings"); await navigateSettings(page, "themes"); await page.locator(`.palette-option:has(#palette-${id})`).click();
        await navigateMain(page, "trends"); await index.getByRole("button", { name: "Services", exact: true }).click();
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme); await expect(page.locator("html")).toHaveAttribute("data-evidence-palette", id);
            await page.mouse.move(0, 0); await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            const active = await index.getByRole("button", { name: "Services", exact: true }).evaluate(measureControlSurface);
            const normal = await index.getByRole("button", { name: "Response models", exact: true }).evaluate(measureControlSurface);
            assert.notEqual(active.face, normal.face, `${id}/${theme}: the current measure has a painted state`);
            assert(contrast(active.ink, active.face) >= 4.5, `${id}/${theme}: current measure contrast`);
            await screenshot(page, `product-${id}-${theme}`);
            const panel = panelOf(page, "services"), point = panel.locator('[data-trend-mark][data-series="Mail"]').nth(4);
            await point.tap(); await expect(panel.getByRole("button", { name: "View 2 calls" })).toBeVisible();
            await expect(page.locator("#trendsTooltip")).toContainText("2 calls"); await page.keyboard.press("Escape");
        }
    }
    for (const [width, scale] of [[768, 1], [390, 1], [390, 2], [320, 2]]) {
        await page.setViewportSize({ width, height: 850 }); await page.evaluate(s => document.documentElement.style.fontSize = `${s * 100}%`, scale);
        for (const label of ["Response models", "Services", "Call duration"]) {
            await index.getByRole("button", { name: label, exact: true }).click();
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: ${width}px @ ${scale}`);
            await expect(index.getByRole("button")).toHaveCount(7);
            const geometry = await page.locator(".trends-panel:visible").evaluate(panel => ({
                plot: panel.querySelector(".trends-plot").getBoundingClientRect().top,
                title: panel.querySelector("h2").getBoundingClientRect().top, focus: document.activeElement.tagName, y: scrollY, h: innerHeight,
            }));
            assert(geometry.plot < geometry.h, `${width}/${scale}/${label}: ${JSON.stringify(geometry)}`);
        }
        await screenshot(page, `product-narrow-${width}-${scale}`);
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    const duration = panelOf(page, "timing"), lines = duration.getByRole("button", { name: "Lines", exact: true });
    await lines.focus(); await page.keyboard.press("Space");
    await expect(lines).toHaveAttribute("aria-pressed", "true");
    assert.equal(await lines.evaluate(n => getComputedStyle(n).outlineStyle), "solid");
    await duration.locator('[data-trend-mark][data-series="timing"]').nth(4).focus();
    await expect(page.locator("#trendsTooltip")).toContainText("0 ms");
});
