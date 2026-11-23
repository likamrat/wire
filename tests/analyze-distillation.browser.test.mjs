import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { extractScenarios } from "../lib/history.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";

const proof = process.env.WIRE_DISTILL_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
function sample() {
    return [
        ["plan", "Find the five latest Harbor launch planning documents.", "/me/drive/root/children", false],
        ["retry", "Three documents are enough. I have signed in; please try again.", "/me/drive/root/children", true],
        ["handover", "Find the support handover email for the Harbor launch.", "/me/messages", true],
        ["review", "Check the launch review time without creating an event.", "/me/calendarView", true],
        ["checklist", "Find the previous launch checklist.", "/me/drive/root/children", true],
    ].flatMap(([id, text, endpoint, success], index) => {
        const at = milliseconds => new Date(Date.UTC(2026, 9, 10, 9, index) + milliseconds).toISOString();
        return extractScenarios([
            { id, timestamp: at(0), type: "user.message", data: { content: text, source: "user" } },
            { id: `${id}-start`, timestamp: at(1000), type: "tool.execution_start",
                data: { toolName: "workiq-fetch", toolCallId: `${id}-call`, arguments: { entityUrl: endpoint } } },
            { id: `${id}-end`, timestamp: at(1050), type: "tool.execution_complete",
                data: { toolCallId: `${id}-call`, success, ...(!success ? { error: {
                    code: "failure", message: "Re-authentication required for MCP server 'workiq'. Run /mcp auth workiq.",
                } } : {}) } },
        ], { sessionId: "harbor-launch", name: "Sample: Harbor launch", projectId: "harbor", project: "Sample workspace: Harbor" },
        at(0), at(1050)).scenarios;
    });
}
async function setup(t, { nativeScrollbars = false, records = sample() } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(nativeScrollbars ? {
        channel: process.platform === "win32" ? "msedge" : undefined, ignoreDefaultArgs: ["--hide-scrollbars"],
    } : {}), page = await browser.newPage({
        viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC",
    });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" &&
            !["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
                "/api/evaluation/automatic/summary"].includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url); await ready(page);
    return page;
}
async function capture(page, name) {
    if (!proof) return;
    const inventory = await page.locator("#homeView").evaluate(root => ({
        summaries: [...root.querySelectorAll("summary")].filter(node => node.checkVisibility()).map(node => node.textContent.trim()),
        words: root.innerText.trim().split(/\s+/).length,
        toolHeadings: [...root.querySelectorAll('[data-breakdown="tools"] h3')].map(node => node.textContent.trim()),
        detachedTiming: root.querySelector("#recordedTiming") !== null,
    }));
    if (proof) {
        await mkdir(proof, { recursive: true });
        await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
        await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
        await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
        if (name.startsWith("paired-widgets-")) {
            const clip = await page.locator(".analyze-dashboard").boundingBox();
            await page.screenshot({ path: path.join(proof, `${name}-widgets.png`), fullPage: true, clip });
        }
        await writeFile(path.join(proof, `${name}.json`), JSON.stringify(inventory, null, 2));
    }
    return inventory;
}

async function widgetGeometry(page) {
    return page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
            scroll: scrollY, header: rect(".app-header"), control: rect("#dateFilter-control"),
            chart: rect(".analyze-chart-main"),
            outcomes: rect(".analyze-outcome-summary"), tools: rect('[data-percentage-card="tools"]'),
            services: rect('[data-percentage-card="services"]'),
        };
    });
}

test("Harbor widgets share row edges without fixed heights or clipped content", { timeout: 30000 }, async t => {
    const page = await setup(t), measurements = [], failures = [];
    for (const theme of ["light", "dark"]) for (const [width, textSize] of [[2000, 100], [1600, 100], [1100, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, textSize);
        await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
        const geometry = await widgetGeometry(page);
        const clipping = await page.locator(".analyze-dashboard").evaluate(root =>
            [...root.querySelectorAll(".percentage-label,.percentage-value,.percentage-card h3,#homeFindings li,#homeFindings p")]
                .filter(node => node.checkVisibility()).flatMap(node => {
                    const box = node.getBoundingClientRect(), card = node.closest(".analyze-outcome-summary,.percentage-card").getBoundingClientRect();
                    return node.scrollWidth > node.clientWidth + 1 || box.x < card.x || box.right > card.right + 1 || box.bottom > card.bottom + 1
                        ? [node.textContent] : [];
                }));
        assert.deepEqual(clipping, [], "All outcome, tool and service text stays inside its widget without clipping");
        measurements.push({ theme, width, textSize, geometry, clipping });
        for (const [left, right] of [["outcomes", "chart"], ["tools", "services"]]) {
            const a = geometry[left], b = geometry[right];
            if (Math.abs(a.y - b.y) < 2 && a.right > b.x + 1) {
                failures.push(`${theme}/${width}: ${left} overlaps ${right}`);
            }
            if (width === 375) assert.ok(b.y >= a.bottom, `${theme}/${textSize}%: ${right} starts at ${b.y}, ${left} ends at ${a.bottom}`);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture(page, `paired-widgets-${width}-${textSize}-${theme}`);
    }
    if (proof) await writeFile(path.join(proof, "paired-widgets.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("a filtered card keeps its failed sibling in full activity, outside the matching-call count", async t => {
    const records = sample();
    records[0].toolCalls.push(...records.splice(1, 1)[0].toolCalls);
    const page = await setup(t, { records });
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page); await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("4");
    await expect(page.locator('#outcomeChart [data-category="failure"]')).toHaveAttribute("data-count", "0");
    const card = page.locator("#activityList article").filter({ hasText: "1 of 2 Work IQ tool calls matches this view" });
    await card.getByRole("link", { name: "Open activity panel: 2 tool calls", exact: true }).click();
    const sibling = page.locator('[data-tool-call-id="plan-call"]');
    await expect(sibling).toContainText("Outside current view");
    await expect(sibling).toContainText("Re-authentication required for MCP server 'workiq'. Run /mcp auth workiq.");
    await expect(sibling).toContainText("This historical error does not establish the account's current sign-in state.");
});

test("stable time layout keeps zero and undated meanings with native horizontal scrolling", async t => {
    const records = sample().slice(0, 4), undated = fixture("harbor-undated");
    records[0].capturedAt = "2026-10-08T09:00:00.000Z";
    records[0].toolCalls[0].startedAt = "2026-10-08T09:00:01.000Z";
    undated.capturedAt = null;
    const page = await setup(t, { records: [...records, undated], nativeScrollbars: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await expect(page.locator("#activityCount")).toHaveText("5");
    await expect(page.locator("#chartFooter")).toContainText("1 undated record.");
    await expect(page.locator(".time-zero .dimensional-count")).toHaveText("0 calls");
    await expect(page.locator(".flat-time-column")).toHaveCount(2);
    assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((total, node) => total + Number(node.dataset.total), 0)), 4);
    const scroll = page.locator(".flat-time-scroll");
    await expect(scroll).toHaveAttribute("tabindex", "0");
    await scroll.focus();
    await page.keyboard.press("ArrowRight"); await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await page.locator("a.time-zero").press("Enter");
    await expect(page.locator("#meaning")).toContainText("4 dated records; 1 without a usable date.");
    await page.locator("#chartReferenceShowData").click();
    await expect(page.locator("#chartReferenceData tfoot td").first()).toHaveText("4");
});

test("the shared date field remains the control anchor when calendar membership changes", async t => {
    const records = sample().map((record, index) => {
        const date = `2026-10-${String(index + 6).padStart(2, "0")}`;
        record.capturedAt = `${date}T09:00:00.000Z`;
        for (const call of record.toolCalls) {
            call.startedAt = `${date}T09:00:01.000Z`;
            call.completedAt = `${date}T09:00:01.050Z`;
        }
        return record;
    });
    const page = await setup(t, { nativeScrollbars: true, records });
    await page.clock.setFixedTime(new Date("2026-10-07T12:00:00Z"));
    await openAnalyzeFilters(page); await page.waitForFunction(() => !document.querySelector("#analyzeFilterDialog").getAnimations().length);
    await page.locator("#dateFilter-control").scrollIntoViewIfNeeded();
    const initial = await page.locator("#dateFilter-control").boundingBox();
    for (const [range, count] of [["day", "1"], ["week", "2"], ["month", "2"], ["capture", "5"]]) {
        await selectActivityOption(page, "dateFilter", range); await ready(page);
        await expect(page.locator("#dateFilter-control")).toBeFocused();
        await expect(page.locator("#activityCount")).toHaveText(count);
        const current = await page.locator("#dateFilter-control").boundingBox();
        assert.ok(Math.abs(current.y - initial.y) < 2);
    }
});
