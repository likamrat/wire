// Invented retained samples only, on the real application with source timers disabled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, revealStoredRefresh, restoreLegacySearch, automaticScoreOffSummary } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createTimingPresentation, renderRecordedTiming } from "../web/assessment-presentation.mjs";
import { assessmentDependencies, assessmentRef, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";

const proofs = process.env.WIRE_RECORDED_TIMING_PROOFS;
const start = Date.UTC(2026, 8, 30, 12), stamp = delta => new Date(start + delta).toISOString();
function records() {
    return ["ALPHA", "BETA"].map((name, i) => {
        const row = fixture(`timing-${name}`);
        row.sourceSessionId = `timing-source-${name}`;
        row.sourceSessionName = `Invented ${name}`;
        row.userPrompt = { ...row.userPrompt, text: `SYNTHETIC_TIMING_${name}`, sourceEventId: `prompt-${i}`, sourceTimestamp: stamp(0) };
        row.followUpPrompts = [];
        row.toolCalls = (i === 0 ? [0, 2000, 900000] : [1000, null]).map((durationMs, j) => ({
            ...structuredClone(row.toolCalls[0]), toolCallId: `call-${i}-${j}`, startEventId: `start-${i}-${j}`,
            requestArgs: durationMs === null ? {} : { entityUrls: [j === 0 ? "/me/calendarView" : "/me/messages"] },
            requestedApiPath: durationMs === null ? null : j === 0 ? "/me/calendarView" : "/me/messages",
            completionEventId: durationMs === null ? null : `end-${i}-${j}`,
            startedAt: stamp(0), completedAt: durationMs === null ? null : stamp(durationMs), durationMs,
            toolSucceeded: durationMs === null ? null : true, reportedOutcome: durationMs === null ? "unknown" : "succeeded",
        }));
        if (i === 0) row.responseTiming = recordedResponseTiming([
            { id: "prompt-0", type: "user.message", timestamp: stamp(0), data: { messageId: "prompt-0" } },
            { id: "response", type: "assistant.message", timestamp: stamp(677960), data: {
                wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false,
                turnId: "turn", originatingMessageId: "prompt-0",
            } },
            { id: "end", type: "assistant.turn_end", timestamp: stamp(677961), data: { turnId: "turn" } },
        ], row.userPrompt);
        return row;
    });
}
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#recordedTiming .recorded-timing-row")).toHaveCount(1);
};
async function setup(t, { nativeScrollbars = false } = {}) {
    const source = records(), cleanup = [], requests = [], errors = [], denied = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, source);
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory: async () => { denied.push("provider"); throw Error("No provider work in timing proof."); },
            readSource: async () => { denied.push("source"); throw Error("No source reads in timing proof."); },
        } });
    const browser = await chromium.launch(nativeScrollbars ? {
        channel: process.platform === "win32" ? "msedge" : undefined, ignoreDefaultArgs: ["--hide-scrollbars"],
    } : {}), page = await browser.newPage({
        viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US",
    });
    page.setDefaultTimeout(8000);
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/detail",
        "/api/assessment/overview", "/api/evaluation/automatic/summary"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() !== "GET") requests.push({ path: url.pathname, body: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        try {
            await browser.close(); await server.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            assert.doesNotMatch(JSON.stringify(requests), /SYNTHETIC_TIMING/);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(server.url + "#analyze"); await ready(page);
    return { page, source, context, requests };
}
const matching = page => page.locator("#recordedTiming .recorded-timing-row");
const fullCalls = page => page.locator('#homeInsights [data-timing-boundary="tool-start-to-completion"]');
async function check(page, values, coverage) {
    await expect(matching(page).locator(".assessment-value")).toHaveText(values);
    await expect(matching(page).locator(".assessment-coverage")).toHaveText(coverage);
}

test("Analyze timing pairs labels and values in aligned rows without a standalone card", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 2000, height: 1250 });
    const row = matching(page);
    await expect(row.getByRole("heading", { name: "Call duration in this view", exact: true })).toBeVisible();
    await expect(row).toContainText("Call start to recorded completion");
    await expect(row.getByRole("link", { name: "Inspect call durations", exact: true })).toBeVisible();
    const composition = await page.locator(".analyze-review").evaluate(root => {
        const style = getComputedStyle(root);
        const box = selector => root.querySelector(selector).getBoundingClientRect().toJSON();
        return { background: style.backgroundColor, border: style.borderTopWidth,
            labels: [...root.querySelectorAll("#recordedTiming dt")].map(node => node.getBoundingClientRect().toJSON()),
            values: [...root.querySelectorAll("#recordedTiming dd")].map(node => node.getBoundingClientRect().toJSON()),
            typography: [...root.querySelectorAll("#recordedTiming dt,#recordedTiming dd")].map(node => getComputedStyle(node).fontSize),
            action: box("#recordedTiming a"), details: box("#analyzeReviewDetails > summary") };
    });
    assert.equal(composition.background, "rgba(0, 0, 0, 0)");
    assert.equal(composition.border, "0px");
    assert.equal(composition.labels.length, 3, "Median, P95 and coverage each have a semantic label");
    assert.equal(composition.values.length, 3);
    assert.equal(new Set(composition.typography).size, 1, "Keys and values use the same reading size");
    for (const [index, label] of composition.labels.entries()) {
        assert.equal(label.x, composition.labels[0].x);
        assert.equal(composition.values[index].x, composition.values[0].x);
        assert.ok(Math.abs(label.y - composition.values[index].y) <= 1, "A value aligns with its own key");
    }
    assert.ok(composition.details.y >= composition.action.bottom, "Request details have a permanent row below call timing");
    assert.equal(composition.details.x, composition.action.x);
});

test("request timing disclosure stays under the pointer through open, close and reopen with native scrollbars", { timeout: 45000 }, async t => {
    const { page } = await setup(t, { nativeScrollbars: true });
    await page.setViewportSize({ width: 2000, height: 1250 });
    await page.evaluate(async () => {
        await document.fonts.ready;
        scrollTo(0, document.querySelector(".analyze-review").getBoundingClientRect().top + scrollY - 220);
    });
    const summary = page.locator("#analyzeReviewDetails > summary");
    await summary.click(); await summary.click();
    await page.waitForFunction(() => innerWidth > document.documentElement.clientWidth);
    const before = await summary.boundingBox(), position = { x: before.x + 30, y: before.y + before.height / 2 };
    const states = [];
    for (const open of [true, false, true, false]) {
        await page.mouse.click(position.x, position.y);
        await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", open);
        await expect(summary).toBeFocused();
        const after = await summary.boundingBox();
        states.push({ open, ...after });
        for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(after[key] - before[key]) <= 1, `${key} must not change when details ${open ? "open" : "close"}`);
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", true);
    await expect(summary).toBeFocused();
    assert.deepEqual(await summary.boundingBox(), before);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "native-disclosure-anchor.json"), JSON.stringify({ before, states }, null, 2));
    }
});

test("Analyze matching-call timing follows filters/private search/refinements and Back without repooling full interactions", { timeout: 45000 }, async t => {
    const { page, source, context } = await setup(t);
    await check(page, ["1 s", "15 min"], "4 of 5 calls timed");
    await expect(fullCalls(page).locator(".assessment-coverage")).toHaveText("4 of 5 calls timed");
    const response = page.locator('#homeInsights [data-timing-boundary="recorded-request-to-final-answer"]');
    await expect(response.locator(".assessment-value")).toHaveText("11 min 17.96 s");
    await expect(response).toContainText("One sample, not overall performance");
    assert.equal(await response.locator(".timing-scale").count(), 0);
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    await check(page, ["0 ms", "1 s"], "2 of 3 calls timed");
    await expect(fullCalls(page).locator(".assessment-coverage")).toHaveText("4 of 5 calls timed");
    await expect(page.locator("#homeInsights")).toContainText("selected requests, with all their recorded calls");
    await expect(page.locator("#homeInsights .assessment-scope")).toHaveCount(1);
    const calendar = page.locator('[data-percentage-card="services"] [data-category="Calendar"] .percentage-label[href]').first();
    await calendar.click(); await ready(page);
    await check(page, ["0 ms", "1 s"], "2 of 2 calls timed");
    assert.match(page.url(), /withinServices=Calendar/);
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_ALPHA"); await ready(page);
    await check(page, ["0 ms"], "1 of 1 call timed");
    await expect(fullCalls(page).locator(".assessment-value")).toHaveText(["2 s", "15 min"]);
    await expect(matching(page).locator("data.assessment-value")).toHaveAttribute("value", "0");
    await expect(matching(page).locator("details")).toHaveCount(0);
    const exact = page.locator("#meaning");
    await exact.locator(":scope > summary").focus(); await page.keyboard.press("Enter");
    await expect(exact).toHaveAttribute("open", "");
    await expect(exact).toContainText("Median is the middle recorded duration");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await selectActivityOption(page, "callSort", "fastest"); await ready(page);
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    await page.getByRole("link", { name: "Inspect call durations", exact: true }).click(); await ready(page);
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    await page.locator("#activityList .request-link").first().click();
    await expect(page.locator('.interaction-insights [data-timing-boundary="tool-start-to-completion"] .assessment-value')).toHaveText(["2 s", "15 min"]);
    await page.locator(".request-context-summaries > summary").click();
    await expect(page.locator(".interaction-insights .assessment-timing")).toBeVisible();
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.locator(".interaction-insights .assessment-timing").screenshot({ path: path.join(proofs, "request-recorded-timing.png") });
    }
    await page.goBack(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue("SYNTHETIC_TIMING_ALPHA");
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await page.goBack(); await ready(page);
    await expect(exact).toHaveAttribute("open", "");
    await expect(page.getByRole("link", { name: "Inspect call durations", exact: true })).toBeFocused();
    source[0].toolCalls[0].durationMs = 3000; source[0].toolCalls[0].completedAt = stamp(3000);
    await replaceEvidence(context, () => ({ records: source, importCoverage: { counts: { includedSessions: 2, includedProjects: 1 }, roster: [] } }));
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await check(page, ["3 s"], "1 of 1 call timed");
    assert.match(page.url(), /withinServices=Calendar/);
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_NO_MATCH"); await ready(page);
    await check(page, ["Not measured"], "0 of 0 calls timed");
    await expect(page.locator("#homeView .analyze-review")).toBeHidden();
    assert.equal(await matching(page).locator(".timing-scale").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Inspect call durations", exact: true }).count(), 0);
});

test("compact timing preserves equal, missing, zero, single, few and dense sample meaning", { timeout: 45000 }, async t => {
    const { page, source, context } = await setup(t);
    for (const [name, durations, values, coverage] of [
        ["missing", [null, null], ["Not measured"], "0 of 2 calls timed"],
        ["single-zero", [0], ["0 ms"], "1 of 1 call timed"],
        ["partial", [0, null], ["0 ms"], "1 of 2 calls timed"],
        ["equal", [1800, 1800, 1800, 1800, 1800], ["1.8 s"], "5 of 5 calls timed"],
        ["few", [0, 1800, 2400], ["1.8 s", "2.4 s"], "3 of 3 calls timed"],
        ["long", [60001, 90061004], ["1 min 0.001 s", "1501 min 1.004 s"], "2 of 2 calls timed"],
        ["dense", Array.from({ length: 41 }, (_, i) => i + 1), ["21 ms", "39 ms"], "41 of 41 calls timed"],
        ["empty", [], ["Not measured"], "0 of 0 calls timed"],
    ]) {
        const record = structuredClone(source[0]), call = record.toolCalls[0];
        record.toolCalls = durations.map((durationMs, i) => ({
            ...call, toolCallId: `state-${i}`, startEventId: `state-start-${i}`,
            completionEventId: durationMs === null ? null : `state-end-${i}`,
            completedAt: durationMs === null ? null : stamp(durationMs), durationMs,
        }));
        await replaceEvidence(context, () => ({ records: durations.length ? [record] : [],
            importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
        await page.reload(); await ready(page);
        await check(page, values, coverage);
        const labels = matching(page).locator(".assessment-cell-label");
        const timed = durations.filter(value => value !== null).length;
        if (timed < 2) await expect(labels).toHaveText(timed === 1 ? "Single sample" : "Duration");
        else await expect(labels).toHaveText(values.length === 1 ? ["Median and 95th percentile"] : ["Median", "95th percentile"]);
        if (timed === 1) await expect(matching(page)).toContainText("One sample, not overall performance");
        if (timed < durations.length) await expect(matching(page)).toContainText("Missing timing is not zero");
        await expect(page.locator(".analyze-review")).toBeVisible({ visible: durations.length > 0 });
        if (name === "long") {
            await page.setViewportSize({ width: 375, height: 1000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
            assert.ok(await matching(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (proofs) {
                await mkdir(proofs, { recursive: true });
                await page.locator(".analyze-review").screenshot({ path: path.join(proofs, "long-durations-375-200.png") });
            }
            await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
            await page.setViewportSize({ width: 1200, height: 1000 });
        }
        if (proofs && durations.length) {
            await mkdir(proofs, { recursive: true });
            await page.locator(".analyze-review").screenshot({ path: path.join(proofs, `state-${name}.png`) });
        }
    }
});

test("full-interaction timing stays separate and its keyboard controls survive a delayed scoped read and reopening", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    const gate = Promise.withResolvers(), arrived = Promise.withResolvers();
    let hold = true;
    await page.route("**/api/assessment/overview", async route => {
        if (hold) { arrived.resolve(); await gate.promise; }
        await route.fallback();
    });
    t.after(() => gate.resolve());
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_ALPHA");
    await arrived.promise;
    await check(page, ["2 s", "15 min"], "3 of 3 calls timed");
    const summary = page.locator("#analyzeReviewDetails > summary");
    await summary.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#homeInsights")).toContainText("Reading recorded insights");
    await page.keyboard.press("Enter");
    hold = false; gate.resolve();
    await expect(page.locator("#homeInsights")).not.toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator("#homeInsights")).toBeVisible();
    await expect(fullCalls(page).locator(".assessment-coverage")).toHaveText("3 of 3 calls timed");
    await expect(page.locator('#homeInsights [data-timing-boundary="recorded-request-to-final-answer"]')).toContainText("11 min 17.96 s");
    await expect(page.locator("#homeInsights .assessment-empty-review")).toBeVisible();
    const definitions = page.locator("#homeInsights [data-insight-details]");
    await definitions.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Insight details", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(definitions).toBeFocused();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await summary.focus(); await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", false);
    await page.keyboard.press("Enter");
    await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", true);
    await expect(definitions).toBeVisible();
    await expect(page.locator("#homeInsights .assessment-saved-details")).toBeHidden();
    await expect(page.locator("#analyzeReviewDetails")).toContainText("selected request, with all their recorded calls");
    await expect(page.locator("#analyzeReviewDetails > summary")).toHaveText("Request timing and reviews");
    assert.ok(await page.locator("#homeInsights").evaluate(host => {
        const timing = host.querySelector(".assessment-timing"), reviews = host.querySelector(".assessment-saved-details");
        return Boolean(timing.compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "Timing comes before saved review details");
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.locator(".analyze-review").screenshot({ path: path.join(proofs, "reopened-full-interaction-timing.png") });
    }
});

test("request timing keeps saved feedback facts and definitions after reordered timing rows", { timeout: 45000 }, async t => {
    const { page, context, requests } = await setup(t);
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(page.locator("#homeInsights .assessment-empty-review")).toBeVisible();
    await page.locator("#analyzeReviewDetails > summary").click();
    await updateBoardState(context, state => {
        state.personalEvaluation ??= defaultPersonalEvaluation();
        const model = buildAssessmentModel(state), view = model.details.get(model.catalog[0].interactionRef);
        state.personalEvaluation.feedback.records.push({ schemaVersion: 1, dependencies: assessmentDependencies(view),
            assessment: { ...view.assessments.find(item => item.dimension === "accuracy"),
                assessmentRef: assessmentRef(state, "assessment", "invented-timing-saved-feedback"),
                origin: "user-personal", verdict: "pass", reason: "user-verdict" } });
        state.personalEvaluation.feedback.revision = 1;
        state.personalEvaluation.overrideRevision = 1;
    });
    await page.reload(); await ready(page);
    const summary = page.locator("#analyzeReviewDetails > summary");
    await summary.click();
    const details = page.locator("#homeInsights .assessment-saved-details > summary");
    await details.focus(); await page.keyboard.press("Enter");
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Your feedback" });
    await expect(accuracy).toContainText("1 of 2 requests assessed");
    await expect(accuracy).toContainText("1 passed");
    await expect(accuracy).toContainText("0 failed");
    await expect(page.locator("#homeFindings")).toContainText("Verdict reasons not retained");
    const definitions = page.locator("#homeInsights [data-insight-details]");
    await definitions.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Insight details", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(definitions).toBeFocused();
    await summary.click(); await summary.click();
    await expect(accuracy).toBeVisible();
    await expect(page.locator("#homeInsights .assessment-scope")).toHaveCount(1);
    assert.ok(requests.every(request => !/feedback|consent|evaluate|approve/.test(request.path)));
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.locator(".analyze-review").screenshot({ path: path.join(proofs, "saved-reviews-reopened.png") });
    }
});

test("idle unreviewed Analyze shows one honest statement while processing, errors and revoked status keep controls", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    const host = page.locator("#homeInsights");
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(host.locator(".assessment-scoring-status")).toContainText("Automatic scores: Off");
    await expect(host.locator(".assessment-saved-details")).toBeHidden();
    await expect(host.locator(".assessment-reading-help")).toBeHidden();
    await expect(host.locator(".assessment-empty-review")).toHaveText("No saved reviews for these requests.");
    await expect(host.locator(".assessment-heading button:visible")).toHaveText("Measure definitions");
    assert.doesNotMatch(await host.innerText(), /Automatic scores: Off|Review Automatic scores to approve|How to read these results|Saved assessment details and counts/);
    const definitions = host.locator("[data-insight-details]");
    await definitions.click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await expect(dialog).toContainText("AI reviews the recorded evidence and can be wrong");
    await expect(dialog).toContainText("Matching the request does not prove a person gave permission");
    await expect(dialog).toContainText("Reported outcomes: 4 of 5 recorded calls succeeded");
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    await expect(dialog).toContainText("Boundary");
    await page.keyboard.press("Escape"); await expect(definitions).toBeFocused();
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.locator(".analyze-review").screenshot({ path: path.join(proofs, "idle-no-reviews.png") });
    }
    let status;
    await page.route("**/api/evaluation/automatic/summary", route => status === null
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented status unavailable." }) })
        : route.fulfill({ json: { ...automaticScoreOffSummary(), snapshot: { ...automaticScoreOffSummary().snapshot, ...status } } }));
    for (const [name, value, text] of [
        ["pending", { state: "assessing", reason: "in-progress" }, "Assessing"],
        ["error", { state: "paused", reason: "evaluation-failed" }, "The evaluator could not finish"],
        ["revoked", { state: "off", reason: "revoked" }, "Off"],
        ["unknown", null, "status unavailable"],
    ]) {
        status = value;
        await page.reload(); await ready(page);
        await page.locator("#analyzeReviewDetails > summary").click();
        await expect(host.locator(".assessment-scoring-status")).toContainText(text);
        await expect(host.locator(".assessment-scoring-status")).toBeVisible();
        await expect(host.locator(".assessment-saved-details")).toBeVisible();
        await expect(host.locator(".assessment-reading-help")).toBeVisible();
        await expect(host.locator("[data-automatic-scores]")).toBeVisible();
        await expect(host.locator(".assessment-empty-review")).toBeHidden();
        if (proofs && ["pending", "error"].includes(name)) {
            await page.locator(".analyze-review").screenshot({ path: path.join(proofs, `reviews-${name}.png`) });
        }
    }
    status = { state: "off", reason: "not-approved" };
    await page.evaluate(() => sessionStorage.setItem("wire.automaticScore.stop", JSON.stringify({
        mutationRef: "mutation-" + "a".repeat(32), receiptToken: "b".repeat(64),
    })));
    await page.reload(); await ready(page);
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(host.locator(".assessment-empty-review")).toBeHidden();
    await expect(host.locator("[data-automatic-scores]")).toBeVisible();
});

test("recorded failed attempts and unavailable history cannot become the idle no-review state", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    let history = "failed";
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        const overview = snapshot.assessment.overview;
        if (history === "failed") {
            overview.assessmentAttempts.forEach(item => { item.latestAttempt = "failed"; });
            overview.reviewStatuses.forEach(item => { item.reviewStatus.assessment.latestAttempt = "failed"; });
        } else delete overview.assessmentAttempts;
        await route.fulfill({ response, json: snapshot });
    });
    for (const [name, expected] of [["failed", "Evaluator attempt failed"], ["unknown", "Assessment attempt history unavailable"]]) {
        history = name;
        await page.reload(); await ready(page);
        await page.locator("#analyzeReviewDetails > summary").click();
        const host = page.locator("#homeInsights");
        await expect(host.locator(".assessment-empty-review")).toBeHidden();
        await expect(host.locator(".assessment-saved-details")).toBeVisible();
        await host.locator(".assessment-saved-details > summary").click();
        await expect(host.locator(".assessment-attempts")).toContainText(expected);
        await expect(host.locator("[data-automatic-scores]")).toBeVisible();
        if (name === "failed") await expect(page.locator("#homeFindings")).toContainText("Review could not finish");
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.locator(".analyze-review").screenshot({ path: path.join(proofs, `recorded-review-${name}.png`) });
        }
    }
});

test("timing component is compact, exact and legible in both themes at desktop and narrow doubled text", { timeout: 45000 }, async t => {
    const { page } = await setup(t), proof = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const action = page.locator("#recordedTiming .recorded-timing-row>a");
        await action.focus();
        await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        const metrics = await page.locator("#recordedTiming").evaluate(root => {
            const nodes = [...root.querySelectorAll("*")].filter(node => node.checkVisibility());
            const clipped = nodes.filter(node => node.clientWidth && node.scrollWidth > node.clientWidth + 1).map(node => node.className);
            const colors = [".assessment-value", ".assessment-cell-label", ".assessment-unavailable-reason", ".timing-boundary"].map(selector => {
                const node = root.querySelector(selector);
                return { selector, fg: getComputedStyle(node).color, bg: getComputedStyle(document.body).backgroundColor };
            });

            const action = root.querySelector("a"), focus = getComputedStyle(action);
            colors.push({ selector: "a.button-link", fg: focus.color, bg: getComputedStyle(action, "::before").backgroundColor });
            const target = action.getBoundingClientRect();
            return { clipped, colors, overflow: document.documentElement.scrollWidth - innerWidth,
                values: [...root.querySelectorAll(".assessment-value")].map(node => node.textContent),
                coverage: root.querySelector(".assessment-coverage").textContent,
                exact: [...root.querySelectorAll("data")].map(node => node.value),
                secondaryControls: root.querySelectorAll("details,.timing-scale").length,
                targets: [...root.querySelectorAll("a")].map(node => node.getBoundingClientRect().height),
                focusVisible: action.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2)),
                focus: { width: focus.outlineWidth, style: focus.outlineStyle, color: focus.outlineColor } };
        });
        assert.deepEqual(metrics.clipped, []); assert.ok(metrics.overflow <= 1);
        assert.ok(metrics.targets.every(height => height >= 44));
        assert.deepEqual(metrics.exact, ["1000", "900000"]);
        assert.equal(metrics.secondaryControls, 0);
        await expect(page.locator("#recordedTiming .timing-boundary")).toHaveCount(1);
        assert.notEqual(metrics.focus.style, "none"); assert.ok(parseFloat(metrics.focus.width) >= 2);
        assert.ok(metrics.focusVisible, "Keyboard-focused timing disclosure is not covered by the sticky header");
        for (const color of metrics.colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, `${theme} ${color.selector}`);
        await expect(matching(page)).not.toContainText("Boundary ID");
        proof.push({ theme, width, scale, ...metrics });
        if (proofs) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `recorded-timing-${theme}-${width}-${scale}.png`),
                clip: await page.locator("#recordedTiming").boundingBox(), fullPage: true });
            await writeFile(path.join(proofs, `recorded-timing-${theme}-${width}-${scale}.txt`), await page.locator("#recordedTiming").ariaSnapshot());
        }
    }
    if (proofs) await writeFile(path.join(proofs, "numeric-visual-proof.json"), JSON.stringify(proof, null, 2));
});

test("screen timing renders each exact value once without rounding tiny samples to zero", async t => {
    const browser = await chromium.launch(), page = await browser.newPage();
    t.after(() => browser.close());
    await page.setContent('<div id="timing"></div>');
    const timing = createTimingPresentation();
    for (const [value, text] of [[0, "0 ms"], [.0001, "0.0001 ms"], [Number.MIN_VALUE, "5e-324 ms"],
        [1001.1, "1001.1 ms"], [60001, "1 min 0.001 s"], [null, "Not measured"]]) {
        const row = timing.fromSummary({ sampleCount: value === null ? 0 : 2, p50Ms: value, p95Ms: value }, 3, "tool-start-to-completion");
        await page.evaluate(({ render, row }) => {
            (0, eval)(`(${render})`)(document.querySelector("#timing"), [row]);
        }, { render: renderRecordedTiming.toString(), row });
        await expect(page.locator("data")).toHaveCount(1);
        await expect(page.locator("data")).toHaveText(text);
        if (value !== null) await expect(page.locator("data")).toHaveAttribute("value", String(value));
        else await expect(page.locator("data")).not.toHaveAttribute("value");
        await expect(page.locator("#timing")).toContainText("Missing timing is not zero.");
        await expect(page.locator("#timing details,#timing button,.timing-scale")).toHaveCount(0);
        await expect(page.locator("#timing")).not.toContainText("Boundary ID");
    }
});
