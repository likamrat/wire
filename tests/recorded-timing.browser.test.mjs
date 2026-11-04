// Invented retained samples only, on the real application with source timers disabled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, restoreLegacySearch, automaticScoreOffSummary } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createTimingPresentation, renderRecordedTiming } from "../web/assessment-presentation.mjs";
import { assessmentDependencies, assessmentRef, buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const proofs = process.env.WIRE_RECORDED_TIMING_PROOFS;
const start = Date.UTC(2026, 8, 30, 12), stamp = delta => new Date(start + delta).toISOString();
function responseTiming(record, durationMs) {
    return recordedResponseTiming([
        { id: record.userPrompt.sourceEventId, type: "user.message", timestamp: stamp(0), data: { messageId: "prompt" } },
        { id: "response", type: "assistant.message", timestamp: stamp(durationMs), data: {
            wireResponseMetadataVersion: 1, finalAnswer: true, hasResponseText: true, hasToolRequests: false,
            turnId: "turn", originatingMessageId: "prompt",
        } },
        { id: "end", type: "assistant.turn_end", timestamp: stamp(durationMs + 1), data: { turnId: "turn" } },
    ], record.userPrompt);
}
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
        if (i === 0) row.responseTiming = responseTiming(row, 677960);
        return row;
    });
}
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const rowFor = (page, name = "ALPHA") => page.locator("#activityList .request-row").filter({ hasText: `SYNTHETIC_TIMING_${name}` });
async function capturePage(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    try {
        await page.evaluate(() => scrollTo(0, 0));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: path.join(proofs, `${name}.png`), fullPage: true });
        await writeFile(path.join(proofs, `${name}.txt`), await page.locator("#workspace").ariaSnapshot());
    } finally {
        await page.evaluate(position => scrollTo(position.x, position.y), position);
    }
}
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

test("response timing belongs to each prompt and the reader, not a detached aggregate or review", { timeout: 45000 }, async t => {
    const { page, requests } = await setup(t);
    await expect(rowFor(page).locator(".response-timing")).toContainText("Final response");
    await expect(rowFor(page).locator(".response-timing data")).toHaveText("677,960 ms (677.96 s)");
    await expect(rowFor(page).locator(".response-timing data")).toHaveAttribute("value", "677960");
    await expect(rowFor(page, "BETA").locator(".response-timing")).toContainText("Not recorded");
    await expect(page.locator("#recordedTiming")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Inspect call durations", exact: true })).toHaveCount(0);
    await capturePage(page, "normal-analyze");
    assert.equal(requests.filter(request => request.path === "/api/assessment/detail").length, 0, "No request per prompt row");
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(page.locator("#analyzeReviewDetails > summary")).toHaveText("Saved reviews");
    await expect(page.locator("#homeInsights .assessment-empty-review")).toBeVisible();
    await expect(page.locator("#homeInsights .assessment-timing")).toHaveCount(0);
    await rowFor(page).locator(".request-link").click();
    await expect(page.locator(".request-original .response-timing data")).toHaveText("677,960 ms (677.96 s)");
    await expect(page.locator(".request-context-summaries > h2")).toHaveText("Reviews");
    await capturePage(page, "normal-interaction");
    await expect(page.locator(".interaction-insights .assessment-timing")).toHaveCount(0);
    await page.locator(".interaction-insights [data-insight-details]").click();
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    await expect(dialog).toContainText("677960");
    await page.keyboard.press("Escape");
    await expect(page.locator(".interaction-insights [data-insight-details]")).toBeFocused();
});

test("filtered prompt timing keeps its whole original interval and exact call navigation restores scope", { timeout: 45000 }, async t => {
    const { page, source, context } = await setup(t);
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_ALPHA"); await ready(page);
    await expect(rowFor(page).locator(".response-timing data")).toHaveText("677,960 ms (677.96 s)");
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    await selectActivityOption(page, "callSort", "fastest"); await ready(page);
    await expect(page.locator("#activityList .matched-action")).toHaveCount(1);
    await expect(page.locator("#activityList .call-duration")).toContainText("0 s");
    const exact = page.locator("#activityList .request-link");
    await exact.click();
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator(".request-original .response-timing data")).toHaveAttribute("value", "677960");
    await page.goBack(); await ready(page);
    await expect(page.locator("#callSort")).toHaveValue("fastest");
    await expect(exact).toBeFocused();
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    source[0].responseTiming = responseTiming(source[0], 0);
    await replaceEvidence(context, () => ({ records: source, importCoverage: { counts: { includedSessions: 2 }, roster: [] } }));
    await page.reload(); await ready(page);
    await expect(rowFor(page).locator(".response-timing data")).toHaveText("0 s");
    await expect(rowFor(page).locator(".response-timing data")).toHaveAttribute("value", "0");
    await expect(page.locator("#activitySearch")).toHaveValue("SYNTHETIC_TIMING_ALPHA");
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_NO_MATCH"); await ready(page);
    await expect(page.locator("#activityList .response-timing")).toHaveCount(0);
    await expect(page.locator(".analyze-review")).toBeHidden();
});

test("untimed calls remain inspectable after measured calls in either duration order", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    for (const order of ["slowest", "fastest"]) {
        await selectActivityOption(page, "callSort", order); await ready(page);
        const rows = page.locator("#activityList .matched-action");
        await expect(rows).toHaveCount(5);
        await expect(rows.last().locator(".call-duration")).toContainText("Not recorded");
        await expect(rows.first().locator(".call-duration")).toContainText(order === "slowest" ? "15:00 min" : "0 s");
        await expect(rows.last().locator(".request-link")).toBeVisible();
        await capturePage(page, `normal-calls-${order}`);
    }
});

test("row timing distinguishes unavailable evidence and a rejected stale projection", { timeout: 45000 }, async t => {
    const { page, source, context } = await setup(t);
    for (const [duration, expected] of [[0, "0 s"], [1200, "1.2 s"], [null, "Not recorded"]]) {
        source[0].responseTiming = duration === null ? { schemaVersion: 1, status: "unavailable", reason: "final-response-not-established" }
            : responseTiming(source[0], duration);
        await replaceEvidence(context, () => ({ records: source, importCoverage: { counts: { includedSessions: 2 }, roster: [] } }));
        await page.reload(); await ready(page);
        await expect(rowFor(page).locator(".response-timing")).toContainText(expected);
        await expect(rowFor(page).locator(".response-timing [role=alert]")).toHaveCount(0);
    }
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json();
        snapshot.assessment.catalog[0].responseTiming.sourceRevision++;
        await route.fulfill({ response, json: snapshot });
    });
    await page.reload(); await ready(page);
    await expect(rowFor(page).locator(".response-timing [role=alert]")).toHaveText("Timing could not be read");
    await expect(rowFor(page).locator(".response-timing")).not.toContainText("Not recorded");
});

test("delayed review reads never replace prompt timing and saved feedback remains independent", { timeout: 45000 }, async t => {
    const { page, context } = await setup(t);
    const gate = Promise.withResolvers(), arrived = Promise.withResolvers();
    let hold = true;
    await page.route("**/api/assessment/overview", async route => {
        if (hold) { arrived.resolve(); await gate.promise; }
        await route.fallback();
    });
    t.after(() => gate.resolve());
    await restoreLegacySearch(page, "SYNTHETIC_TIMING_ALPHA"); await arrived.promise;
    await expect(rowFor(page).locator(".response-timing data")).toHaveAttribute("value", "677960");
    const summary = page.locator("#analyzeReviewDetails > summary");
    await summary.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#homeInsights")).toContainText("Reading recorded insights");
    hold = false; gate.resolve();
    await expect(page.locator("#homeInsights")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#homeInsights .assessment-timing")).toHaveCount(0);
    await restoreLegacySearch(page, ""); await ready(page);
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
    await summary.click();
    const details = page.locator("#homeInsights .assessment-saved-details > summary");
    await details.click();
    await expect(page.locator("#homeInsights")).toContainText("Your feedback");
    const accuracy = page.locator('#homeInsights [data-dimension="accuracy"]').filter({ hasText: "Your feedback" });
    await expect(accuracy).toContainText("1 of 2 requests assessed");
    await expect(accuracy).toContainText("1 passed");
    await expect(accuracy).toContainText("0 failed");
    await expect(page.locator("#homeFindings")).toContainText("Verdict reasons not retained");
    const definitions = page.locator("#homeInsights [data-insight-details]");
    await definitions.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Insight details", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(definitions).toBeFocused();
    await expect(page.locator("#homeInsights .assessment-reading-help")).not.toContainText("Median timing");
    await expect(rowFor(page).locator(".response-timing data")).toHaveAttribute("value", "677960");
    await summary.click(); await summary.click();
    await expect(details).toBeVisible();
    await expect(accuracy).toBeVisible();
    await expect(page.locator("#homeInsights .assessment-scope")).toHaveCount(1);
});

test("review disclosure stays under the pointer with timing removed", { timeout: 45000 }, async t => {
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
    for (const open of [true, false, true, false]) {
        await page.mouse.click(position.x, position.y);
        await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", open);
        await expect(summary).toBeFocused();
        const after = await summary.boundingBox();
        for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(after[key] - before[key]) <= 1, key);
    }
    await page.keyboard.press("Enter");
    await expect(page.locator("#analyzeReviewDetails")).toHaveJSProperty("open", true);
    await expect(summary).toBeFocused();
    assert.deepEqual(await summary.boundingBox(), before);
});

test("idle reviews stay quiet while processing, errors, revoked and uncertain histories retain controls", { timeout: 45000 }, async t => {
    const { page } = await setup(t), host = page.locator("#homeInsights");
    await page.locator("#analyzeReviewDetails > summary").click();
    await expect(host.locator(".assessment-empty-review")).toHaveText("No saved reviews for these requests.");
    await expect(host.locator(".assessment-saved-details")).toBeHidden();
    await expect(host.locator(".assessment-reading-help")).toBeHidden();
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
    let status;
    await page.route("**/api/evaluation/automatic/summary", route => status === null
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented status unavailable." }) })
        : route.fulfill({ json: { ...automaticScoreOffSummary(), snapshot: { ...automaticScoreOffSummary().snapshot, ...status } } }));
    for (const [value, text] of [[{ state: "assessing", reason: "in-progress" }, "Assessing"],
        [{ state: "paused", reason: "evaluation-failed" }, "The evaluator could not finish"],
        [{ state: "off", reason: "revoked" }, "Off"], [null, "status unavailable"]]) {
        status = value;
        await page.reload(); await ready(page);
        await page.locator("#analyzeReviewDetails > summary").click();
        await expect(host.locator(".assessment-saved-details")).toBeVisible();
        await expect(host.locator("[data-automatic-scores]")).toBeVisible();
        await expect(host.locator(".assessment-empty-review")).toBeHidden();
        await expect(host.locator(".assessment-scoring-status")).toContainText(text);
        await expect(host.locator(".assessment-scoring-status")).toBeVisible();
        await expect(host.locator(".assessment-reading-help")).toBeVisible();
        await expect(host.locator(".assessment-timing")).toHaveCount(0);
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

test("recorded failed and uncertain attempts and unavailable history are not an idle no-review state", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    let history;
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), snapshot = await response.json(), overview = snapshot.assessment.overview;
        if (history === "unknown") delete overview.assessmentAttempts;
        else {
            overview.assessmentAttempts.forEach(item => { item.latestAttempt = history; });
            overview.reviewStatuses.forEach(item => { item.reviewStatus.assessment.latestAttempt = history; });
        }
        await route.fulfill({ response, json: snapshot });
    });
    for (history of ["failed", "uncertain", "unknown"]) {
        await page.reload(); await ready(page);
        await page.locator("#analyzeReviewDetails > summary").click();
        const host = page.locator("#homeInsights");
        await expect(host.locator(".assessment-empty-review")).toBeHidden();
        await expect(host.locator(".assessment-saved-details")).toBeVisible();
        await host.locator(".assessment-saved-details > summary").click();
        if (history === "failed") {
            await expect(host.locator(".assessment-attempts")).toContainText("Evaluator attempt failed");
            await expect(page.locator("#homeFindings")).toContainText("Review could not finish");
        } else if (history === "unknown") {
            await expect(host.locator(".assessment-attempts")).toContainText("Assessment attempt history unavailable");
        }
        await expect(host.locator("[data-automatic-scores]")).toBeVisible();
        await expect(rowFor(page).locator(".response-timing data")).toHaveAttribute("value", "677960");
    }
});

test("prompt timing is readable in both themes at desktop and narrow doubled text", { timeout: 45000 }, async t => {
    const { page } = await setup(t), measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const row = rowFor(page), timing = row.locator(".response-timing");
        await row.locator(".request-link").focus();
        const metrics = await timing.evaluate(root => {
            const nodes = [...root.querySelectorAll("*")].filter(node => node.checkVisibility());
            return { clipped: nodes.filter(node => node.clientWidth && node.scrollWidth > node.clientWidth + 1).map(node => node.className),
                colors: nodes.filter(node => node.matches("dt,data")).map(node => ({ fg: getComputedStyle(node).color,
                    bg: getComputedStyle(document.body).backgroundColor })),
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.deepEqual(metrics.clipped, []); assert.ok(metrics.overflow <= 1);
        for (const color of metrics.colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, `${theme} timing text`);
        await expect(timing.locator("data")).toHaveAttribute("value", "677960");
        await expect(timing.locator("details,button,.timing-scale")).toHaveCount(0);
        measurements.push({ theme, width, scale, ...metrics });
        if (proofs) await row.screenshot({ path: path.join(proofs, `prompt-timing-${theme}-${width}-${scale}.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "prompt-timing-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("retained aggregate renderer still preserves exact values for optional definitions", async t => {
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
        await expect(page.locator("[data-timing-boundary]")).toHaveAttribute("aria-label", "Tool latency: Call start to recorded completion");
    }
});

test("Tool latency in newly rendered HTML Markdown and PDF keeps exact values and readable theme layouts", { timeout: 60000 }, async t => {
    const records = matrixRecords("tool-latency", ["success", "success", "success", "unknown"], { durations: [0, 7, 1200, null] });
    const key = "a".repeat(64), state = { revision: 1, pseudonymKey: key, evidence: records };
    const facts = buildReportFacts(records, state).facts, before = JSON.stringify(facts);
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "none", formats: ["html", "markdown", "pdf", "json"] },
        undefined, undefined, facts);
    const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
    let pdfText = "";
    try {
        const pdf = await loading.promise;
        for (let number = 1; number <= pdf.numPages; number++) {
            pdfText += (await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(" ") + "\n";
        }
    } finally { await loading.destroy(); }
    for (const content of [bundle.previewHtml, bundle.files["product-report.md"], pdfText]) {
        assert.match(content, /Tool latency/);
        assert.match(content, /7 ms/);
        assert.match(content, /1200 ms/);
        assert.match(content, /3 of 4 calls timed/);
        assert.doesNotMatch(content, /call duration|tool-call duration/i);
    }
    assert.equal(JSON.stringify(facts), before);
    const json = JSON.parse(bundle.files["product-report.json"]);
    const metric = json.evaluationFacts.metrics.find(metric => metric.definitionId === "tool-duration");
    assert.equal(metric.boundary, "tool-start-to-completion");
    assert.equal(metric.value, 7);
    assert.deepEqual(metric.samples.map(sample => sample.value).sort((a, b) => a - b), [0, 7, 1200]);
    const browser = await chromium.launch(), page = await browser.newPage({ javaScriptEnabled: false });
    t.after(() => browser.close());
    const denied = [];
    await page.route("**/*", route => { denied.push(route.request().url()); return route.abort(); });
    await page.setContent(bundle.previewHtml);
    const toolRow = page.locator("#timing tbody tr").filter({ hasText: /^Tool latency/ });
    await expect(toolRow).toHaveCount(1);
    await expect(toolRow.locator("td").first()).toHaveText("<0.01 s (7 ms)");
    await expect(toolRow.locator("td").last()).toHaveText("1.2 s (1200 ms)");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, scale }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = `${scale * 100}%`;
        }, { theme, scale });
        const geometry = await toolRow.evaluate(root => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            clipped: [...root.querySelectorAll("th,td")].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
        }));
        assert.ok(geometry.overflow <= 1); assert.deepEqual(geometry.clipped, []);
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.locator("#timing").screenshot({ path: path.join(proofs, `tool-latency-report-${theme}-${width}-${scale}.png`) });
        }
    }
    assert.deepEqual(denied, []);
});
