import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { extractScenarios } from "../lib/history.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { assessmentDependencies, assessmentRef, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

const proof = process.env.WIRE_DISTILL_PROOFS;
const baseline = Boolean(process.env.WIRE_DISTILL_BASELINE);
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
async function setup(t, { savedFeedback = false, nativeScrollbars = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, sample());
    if (savedFeedback) await updateBoardState(context, state => {
        state.personalEvaluation ??= defaultPersonalEvaluation();
        const model = buildAssessmentModel(state), view = model.details.get(model.catalog[0].interactionRef);
        state.personalEvaluation.feedback.records.push({
            schemaVersion: 1, dependencies: assessmentDependencies(view),
            assessment: { ...view.assessments.find(item => item.dimension === "accuracy"),
                assessmentRef: assessmentRef(state, "assessment", "invented-chart-saved-feedback"),
                origin: "user-personal", verdict: "pass", reason: "user-verdict" },
        });
        state.personalEvaluation.feedback.revision = 1;
        state.personalEvaluation.overrideRevision = 1;
    });
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
    await expect(page.locator("#homeFindings")).toContainText("Work IQ sign-in was required");
    return page;
}
async function capture(page, name) {
    const inventory = await page.locator("#homeView").evaluate(root => ({
        summaries: [...root.querySelectorAll("summary")].filter(node => node.checkVisibility()).map(node => node.textContent.trim()),
        words: root.innerText.trim().split(/\s+/).length,
        toolHeadings: [...root.querySelectorAll('[data-breakdown="tools"] h3')].map(node => node.textContent.trim()),
        timing: root.querySelector("#recordedTiming").innerText,
    }));
    if (proof) {
        await mkdir(proof, { recursive: true });
        await page.evaluate(async () => { await document.fonts.ready; scrollTo(0, 0); });
        await page.screenshot({ path: path.join(proof, `${name}-viewport.png`) });
        await page.screenshot({ path: path.join(proof, `${name}-full.png`), fullPage: true });
        await writeFile(path.join(proof, `${name}.json`), JSON.stringify(inventory, null, 2));
    }
    return inventory;
}

for (const savedFeedback of [false, true]) test(`native chart mode cycles retain the reading anchor ${savedFeedback ? "with saved feedback" : "without saved reviews"}`, { timeout: 45000 }, async t => {
    const page = await setup(t, { savedFeedback, nativeScrollbars: true });
    const modes = page.locator(".analyze-chart-main .view-switch");
    const geometry = () => modes.evaluate(node => ({
        y: node.getBoundingClientRect().y, scroll: scrollY,
        header: document.querySelector(".app-header").getBoundingClientRect().height,
        nativeScrollbar: innerWidth - document.documentElement.clientWidth,
    }));
    const observations = [];
    for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: 812 });
        await page.reload(); await ready(page);
        await expect(page.locator("#homeFindings")).not.toHaveAttribute("aria-busy", "true");
        await page.evaluate(() => document.fonts.ready);
        if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Answer: 1 correct");
        else await expect(page.locator("#homeFindings")).not.toContainText("Your feedback");
        await page.mouse.move(width - 30, 700);
        await page.mouse.wheel(0, (await geometry()).y - 445);
        await page.waitForTimeout(500);
        const initial = await geometry();
        assert.ok(initial.nativeScrollbar > 0, "This regression requires real native scrollbar geometry");
        await page.evaluate(() => {
            window.chartModeClicks = [];
            document.addEventListener("click", event => {
                const control = event.target.closest("[data-chart]");
                if (control) window.chartModeClicks.push({ mode: control.dataset.chart, trusted: event.isTrusted });
            });
        });
        for (const mode of ["workload", "endpoint", "time", "workload", "endpoint", "time"]) {
            const control = page.locator(`[data-chart="${mode}"]`), box = await control.boundingBox();
            assert.ok(box.y >= initial.header && box.y + box.height <= 812, "The click needs no intervening scrolling");
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await ready(page); await page.waitForTimeout(500);
            const current = await geometry();
            observations.push({ savedFeedback, width, mode, initial, current });
            if (proof) {
                await mkdir(proof, { recursive: true });
                await writeFile(path.join(proof, `native-mode-${savedFeedback}.json`), JSON.stringify(observations, null, 2));
            }
            assert.ok(Math.abs(current.scroll - initial.scroll) < 2, `${mode} preserves scroll with savedFeedback=${savedFeedback}`);
            assert.ok(Math.abs(current.y - initial.y) < 2, `${mode} preserves the mode controls' viewport anchor`);
            await expect(control).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator("#activityCount")).toHaveText("5");
            if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Answer: 1 correct");
        }
        assert.deepEqual(await page.evaluate(() => window.chartModeClicks), ["workload", "endpoint", "time", "workload", "endpoint", "time"].map(mode => ({ mode, trusted: true })));
        await page.goBack(); await ready(page); await page.waitForTimeout(500);
        await expect(page.locator('[data-chart="endpoint"]')).toHaveAttribute("aria-pressed", "true");
        assert.ok(Math.abs((await geometry()).y - initial.y) < 2, "Mode Back preserves the control anchor");
        await page.locator('[data-chart="time"]').focus(); await page.keyboard.press("Enter"); await ready(page);
        const dateAction = page.locator(".time-column");
        await dateAction.focus();
        const focused = await dateAction.getAttribute("data-view-key"), scroll = await page.evaluate(() => scrollY);
        await page.keyboard.press("Enter"); await ready(page);
        await page.goBack(); await ready(page); await page.waitForTimeout(500);
        await expect(dateAction).toBeFocused();
        assert.equal(await dateAction.getAttribute("data-view-key"), focused);
        assert.ok(Math.abs(await page.evaluate(() => scrollY) - scroll) < 2, "Date drilldown Back restores focus and native reading position");
        const timing = page.locator("#analyzeReviewDetails > summary");
        await page.mouse.move(width - 30, 700);
        await page.mouse.wheel(0, (await timing.boundingBox()).y - 445);
        await page.waitForTimeout(500);
        const timingTop = (await timing.boundingBox()).y, timingScroll = await page.evaluate(() => scrollY);
        for (const open of [true, false, true, false]) {
            const box = await timing.boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(500);
            assert.equal(await timing.evaluate(node => node.parentElement.open), open);
            assert.ok(Math.abs((await timing.boundingBox()).y - timingTop) < 2, "Timing disclosure stays stationary");
            assert.ok(Math.abs(await page.evaluate(() => scrollY) - timingScroll) < 2, "Timing disclosure preserves native scroll");
            if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Answer: 1 correct");
        }
    }
});

test("Analyze uses one chart information destination and keeps exact data live through filtering", { timeout: 60000 }, async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const inventory = await capture(page, `human-${baseline ? "before" : "after"}-${theme}`);
        if (!baseline) {
            assert.deepEqual(inventory.summaries, ["Request timing and reviews", "Chart data and definitions"]);
            assert.deepEqual(inventory.toolHeadings, ["Work IQ tool calls"]);
            assert.doesNotMatch(inventory.timing, /Matching tool calls|Boundary ID|Exact timing|Dot =|Line =/);
            assert.match(inventory.timing, /Call start to recorded completion/);
        }
    }
    if (baseline) return;
    await expect(page.locator("#activityCount")).toHaveText("5");
    await expect(page.locator("#homeFindings")).not.toContainText("Reported outcomes");
    await expect(page.locator("#homeFindings")).not.toContainText("No saved review");
    await expect(page.locator("#recordedTiming data")).toHaveCount(1);
    await expect(page.locator("#recordedTiming data")).toHaveText("50 ms");
    await expect(page.locator("#recordedTiming data")).toHaveAttribute("value", "50");
    await expect(page.locator("#recordedTiming .assessment-cell-label")).toHaveText("Median and 95th percentile");
    await expect(page.locator("#recordedTiming .assessment-coverage")).toHaveText("5 of 5 calls timed");
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(page.locator("#homeInsights .assessment-saved-details")).toBeHidden();
    await expect(page.locator("#homeInsights .assessment-secondary-findings")).toContainText("1 of 5 recorded calls failed; 4 succeeded");
    await expect(page.locator("#homeInsights .assessment-empty-review")).toBeVisible();
    await page.locator("#analyzeReviewDetails > summary").click();
    const summary = page.locator("#meaning > summary");
    await summary.focus();
    const top = await summary.evaluate(node => node.getBoundingClientRect().top + scrollY);
    await page.keyboard.press("Enter");
    assert.ok(Math.abs(await summary.evaluate(node => node.getBoundingClientRect().top + scrollY) - top) < 2);
    await expect(page.locator("#meaning details")).toHaveCount(0);
    await expect(page.locator("#meaning table")).toHaveCount(4);
    await expect(page.locator("#countTable tfoot td").first()).toHaveText("5");
    await expect(page.locator("#percentageData .percentage-table tfoot td:first-of-type")).toHaveText(["5", "5", "5"]);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(page.locator("#meaning")).toHaveAttribute("open", "");
    await expect(page.locator("#countTable tfoot td").first()).toHaveText("1");
    await expect(page.locator("#percentageData .percentage-table tfoot td:first-of-type")).toHaveText(["1", "1", "1"]);
    await expect(page.locator("#homeFindings")).toContainText("Work IQ sign-in was required");
    await page.locator("#percentageData .percentage-table tbody a").first().click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(page.locator("#activityList .request-row")).toHaveCount(1);
    await page.locator("#activityList .request-link").first().click(); await ready(page);
    await expect(page.locator("#requestView")).toBeVisible();
    await page.goBack(); await ready(page);
    await expect(page.locator("#meaning")).toHaveAttribute("open", "");
    await summary.click();
    await page.locator("#resetView").click(); await ready(page);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 1000 });
        for (const size of [100, 200]) {
            await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
            await capture(page, `human-after-${theme}-375-${size}`);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await summary.focus(); await page.keyboard.press("Enter");
            await expect(page.locator("#meaning table")).toHaveCount(4);
            await expect(page.locator("#meaning details")).toHaveCount(0);
            await page.keyboard.press("Enter");
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    await expect(page.locator('[data-breakdown="tools"] h3')).toHaveText("Tools in code references");
    await expect(page.locator("#activityCount")).toHaveText("0");
});
