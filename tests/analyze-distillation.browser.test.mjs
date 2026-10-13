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
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";

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
async function setup(t, { savedFeedback = false, nativeScrollbars = false, records = sample() } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
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
    await expect(page.locator("#homeFindings")).toContainText("Failure details");
    return page;
}
async function capture(page, name) {
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
            scroll: scrollY, header: rect(".app-header"), control: rect("#bucketFilter-control"),
            heading: rect(".analyze-chart-main .chart-heading"), chart: rect(".analyze-chart-main"),
            outcomes: rect(".analyze-outcome-summary"), tools: rect('[data-percentage-card="tools"]'),
            services: rect('[data-percentage-card="services"]'),
        };
    });
}

async function clickVisible(page, locator) {
    const box = await locator.boundingBox(), viewport = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
        "Trusted pointer action must not need locator auto-scrolling");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("Harbor widgets share row edges without fixed heights or clipped content", { timeout: 30000 }, async t => {
    const page = await setup(t), measurements = [], failures = [];
    for (const theme of ["light", "dark"]) for (const [width, textSize] of [[2000, 100], [1600, 100], [1100, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, textSize);
        await page.evaluate(() => document.fonts.ready);
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
            if (Math.abs(a.y - b.y) < 2 && Math.abs(a.bottom - b.bottom) >= 2) {
                failures.push(`${theme}/${width}: ${left} bottom ${a.bottom} differs from ${right} ${b.bottom}`);
            }
            if (width === 375) assert.ok(b.y >= a.bottom, "Narrow widgets stack naturally");
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture(page, `paired-widgets-${width}-${textSize}-${theme}`);
    }
    if (proof) await writeFile(path.join(proof, "paired-widgets.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("the concise footer still reports a failed sibling outside matching-call counts", async t => {
    const records = sample();
    records[0].toolCalls.push(...records.splice(1, 1)[0].toolCalls);
    const page = await setup(t, { records });
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("4");
    await expect(page.locator('#outcomeChart [data-category="failure"]')).toHaveAttribute("data-count", "0");
    await expect(page.locator("#homeFindings")).toContainText("1 failed call");
    await expect(page.locator("#homeFindings")).toContainText("Details include all 5 calls in matching interactions.");
    await page.locator("#homeFindings").getByRole("button", { name: "Failure details" }).click();
    await expect(page.locator("#homeInsights .assessment-findings")).toContainText("Work IQ sign-in was required for the recorded call (1 call).");
    await expect(page.locator("#homeFindings")).not.toContainText("/mcp auth");
});

test("outcome footer links recorded causes without repeating them or routine full-interaction scope", async t => {
    const page = await setup(t), findings = page.locator("#homeFindings");
    await expect(findings).toContainText("Failure details");
    await expect(findings).not.toContainText("Notes on full interactions");
    await expect(findings).not.toContainText("/mcp auth");
    await expect(findings).not.toContainText("No retry");
    await expect(findings.locator("p,li,summary")).toHaveCount(0);
    await expect(findings.locator("button")).toHaveCount(1);
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page);
    await expect(findings).toBeHidden();
    await expect(page.locator("#activityCount")).toHaveText("4");
});

test("stable time layout keeps zero and undated meanings with native horizontal scrolling", async t => {
    const records = sample().slice(0, 4), undated = fixture("harbor-undated");
    records[0].capturedAt = "2026-10-08T09:00:00.000Z";
    records[0].toolCalls[0].startedAt = "2026-10-08T09:00:01.000Z";
    undated.capturedAt = null;
    const page = await setup(t, { records: [...records, undated], nativeScrollbars: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await selectActivityOption(page, "bucketFilter", "day"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("5");
    await expect(page.locator("#chartFooter")).toContainText("1 undated records are not plotted.");
    await expect(page.locator(".time-zero .dimensional-count")).toHaveText("0 calls");
    await expect(page.locator(".flat-time-column")).toHaveCount(2);
    assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((total, node) => total + Number(node.dataset.total), 0)), 4);
    const scroll = page.locator(".flat-time-scroll");
    await expect(scroll).toHaveAttribute("aria-description", /Scroll horizontally.*arrow keys/);
    await scroll.focus();
    await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250);
    assert.ok(await scroll.evaluate(node => node.scrollLeft > 0), "Native keyboard scrolling still reaches offscreen dates");
    const summary = page.locator("#meaning > summary");
    await summary.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#chartReadingNotes")).toBeVisible();
    await expect(page.locator("#chartReadingNotes")).toContainText("Zero means no matching records, not proof that no activity occurred.");
    await expect(page.locator("#countTable tfoot td").first()).toHaveText("4");
});

test("real time-scale choices keep the widget and page still throughout the change", { timeout: 45000 }, async t => {
    const records = sample().map((record, index) => {
        const date = `2026-10-${String(index + 6).padStart(2, "0")}`;
        record.capturedAt = `${date}T09:00:00.000Z`;
        for (const call of record.toolCalls) {
            call.startedAt = `${date}T09:00:01.000Z`;
            call.completedAt = `${date}T09:00:01.050Z`;
        }
        return record;
    });
    const page = await setup(t, { nativeScrollbars: true, records }), observations = [], failures = [];
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 812 });
        await chooseTheme(page, theme);
        await page.reload(); await ready(page);
        await expect(page.locator("#homeFindings")).not.toHaveAttribute("aria-busy", "true");
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(width - 30, 700);
        await page.mouse.wheel(0, (await widgetGeometry(page)).control.y - 400);
        await page.waitForTimeout(500);
        const initial = await widgetGeometry(page);
        assert.ok(initial.control.y >= initial.header.bottom && initial.control.bottom <= 812);
        await page.evaluate(() => {
            window.scaleEvents = [];
            document.addEventListener("click", event => {
                const control = event.target.closest("#bucketFilter-control, .select-option");
                if (control) window.scaleEvents.push({ trusted: event.isTrusted, value: control.dataset.value || "open" });
            }, true);
        });
        for (const [bucket, label, keyboard] of [["day", "Daily", false], ["month", "Monthly", false], ["week", "Weekly", true]]) {
            await page.evaluate(() => {
                window.scaleFrames = [];
                window.recordScaleFrames = true;
                const record = () => {
                    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
                    window.scaleFrames.push({ scroll: scrollY, control: rect("#bucketFilter-control"),
                        heading: rect(".analyze-chart-main .chart-heading"), chart: rect(".analyze-chart-main"),
                        header: rect(".app-header"), tools: rect('[data-percentage-card="tools"]') });
                    if (window.recordScaleFrames) requestAnimationFrame(record);
                };
                record();
            });
            await clickVisible(page, page.locator("#bucketFilter-control"));
            if (keyboard) {
                await page.keyboard.press(label[0]); await page.keyboard.press("Enter");
            } else await clickVisible(page, page.locator(`.select-popup [data-value="${bucket}"]`));
            await ready(page); await page.waitForTimeout(500);
            await expect(page.locator("#bucketFilter")).toHaveValue(bucket);
            await expect(page.locator("#bucketFilter-control")).toBeFocused();
            await expect(page.locator(".flat-time-column")).toHaveCount(bucket === "day" ? 5 : 1);
            assert.equal(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.reduce((total, node) => total + Number(node.dataset.total), 0)), 5);
            const frames = await page.evaluate(() => { window.recordScaleFrames = false; return window.scaleFrames; });
            const current = await widgetGeometry(page);
            const drift = {
                scroll: Math.max(...frames.map(frame => Math.abs(frame.scroll - initial.scroll))),
                control: Math.max(...frames.map(frame => Math.abs(frame.control.y - initial.control.y))),
                header: Math.max(...frames.map(frame => Math.abs(frame.header.height - initial.header.height))),
                chart: Math.max(...frames.map(frame => Math.abs(frame.chart.y - initial.chart.y))),
                chartHeight: Math.max(...frames.map(frame => Math.abs(frame.chart.height - initial.chart.height))),
                tools: Math.max(...frames.map(frame => Math.abs(frame.tools.y - initial.tools.y))),
                heading: Math.max(...frames.map(frame => Math.abs(frame.heading.y - initial.heading.y))),
            };
            observations.push({ theme, width, bucket, keyboard, initial, current, drift, frames });
            if (Object.values(drift).some(value => value >= 2)) failures.push({ theme, width, bucket, drift });
            await expect(page.locator("#activityCount")).toHaveText("5");
            await expect(page.locator("#filterChips")).toBeEmpty();
            await expect(page.locator("#resetView")).toBeDisabled();
            if (proof) {
                await mkdir(proof, { recursive: true });
                await page.screenshot({ path: path.join(proof, `scale-${width}-${theme}-${bucket}.png`) });
            }
        }
        const events = await page.evaluate(() => window.scaleEvents);
        assert.equal(events.length, 5, "Three visible trigger clicks and two pointer choices were observed");
        assert.ok(events.every(event => event.trusted));
        assert.match(page.url(), /bucket=week/);
        const beforeWheel = await page.evaluate(() => scrollY);
        await page.mouse.move(width - 30, 700); await page.mouse.wheel(0, 180);
        await page.waitForTimeout(250);
        assert.ok(await page.evaluate(() => scrollY) > beforeWheel + 100, "Ordinary native page scrolling is not suppressed");
    }
    if (proof) await writeFile(path.join(proof, "time-scale-transitions.json"), JSON.stringify({ observations, failures }, null, 2));
    assert.deepEqual(failures, []);
});

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
        if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Saved reviews");
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
            if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Saved reviews");
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
            if (savedFeedback) await expect(page.locator("#homeFindings")).toContainText("Saved reviews");
        }
    }
});

test("Analyze uses one chart information destination and keeps exact data live through filtering", { timeout: 60000 }, async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const inventory = await capture(page, `human-${baseline ? "before" : "after"}-${theme}`);
        if (!baseline) {
            assert.deepEqual(inventory.summaries, ["Saved reviews", "Chart data and definitions"]);
            assert.deepEqual(inventory.toolHeadings, ["Work IQ tool calls"]);
            assert.equal(inventory.detachedTiming, false);
        }
    }
    if (baseline) return;
    await expect(page.locator("#activityCount")).toHaveText("5");
    await expect(page.locator("#homeFindings")).not.toContainText("Reported outcomes");
    await expect(page.locator("#homeFindings")).not.toContainText("No saved review");
    await expect(page.locator("#recordedTiming")).toHaveCount(0);
    await expect(page.locator("#activityList .response-timing")).toHaveCount(5);
    await expect(page.locator("#activityList .response-timing dd")).toHaveText(Array(5).fill("Not recorded"));
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
    await expect(page.locator("#homeFindings")).toContainText("Failure details");
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
