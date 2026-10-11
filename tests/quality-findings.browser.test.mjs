import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { currentStatePayload } from "../lib/server.mjs";
import { assessmentDependencies, assessmentOverview, buildAssessmentModel, invalidateAssessmentCache } from "../lib/assessment-read-model.mjs";
import { validatePersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { samples } from "./assessment-ui-fixtures.mjs";
import { automaticScoreOffSummary, chooseTheme, revealStoredRefresh, selectActivityOption } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_FINDINGS_PROOFS;
const answerText = "Here are three synthetic documents:\nResearch / Architecture / Design";
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#homeFindings .assessment-findings")).toBeVisible();
};
async function setup(t, { legacy = false } = {}) {
    const records = retainedContextFixture().records.slice(0, 2);
    records[0].toolCalls.push({ ...structuredClone(records[1].toolCalls[0]),
        toolCallId: "calendar-sibling", startEventId: "calendar-start", completionEventId: "calendar-end",
        startedAt: "2026-09-30T12:00:02.100Z", completedAt: "2026-09-30T12:00:03.100Z", durationMs: 1000,
        requestArgs: { entityUrl: "/me/calendarView" }, requestedApiPath: "/me/calendarView", apiResults: [],
    });
    const extras = qualityDisplayFixture({ requests: 3, calls: 3, finalDuration: null }).state.evidence;
    extras.forEach((record, index) => {
        record.toolCalls[0].toolSucceeded = true; record.toolCalls[0].reportedOutcome = "succeeded";
        record.userPrompt.text = `Other synthetic request ${index}`;
    });
    const { state } = qualityDisplayFixture({ records: [...records, ...extras], judgments: ["fail", "pass", "unassessed", "error"] });
    // Seed invented already-retained metadata in memory. No capture, consent, source or evaluator action.
    state.personalEvaluation.consent = { ...samples.enabledConsent(), categories: ["answer"] };
    let model = buildAssessmentModel(state);
    const first = model.details.get(model.catalog[0].interactionRef), second = model.details.get(model.catalog[1].interactionRef);
    const dependencies = assessmentDependencies(second);
    state.personalEvaluation.captures.push({
        category: "answer", dependencies, payloadFile: "e".repeat(64) + ".json",
        captureKeys: [{ category: "answer", eventHash: "e".repeat(64) }],
        observation: {
            schemaVersion: 1, interactionRef: second.interaction.interactionRef, basis: second.basis,
            createdAt: samples.at, evidenceRefs: [samples.id("evidence", 800)], observationRef: samples.id("observation", 800),
            memberRef: null, adapter: "copilot-local-events-v1", kind: "answer", origin: "optional-capture",
            availability: "available", reason: null, occurredAt: "2026-09-30T12:00:07.000Z",
            sourceEventRefs: [samples.id("event", 800)], deletionKeys: dependencies.deletionKeys,
            payload: { textRef: samples.id("text", 800), utf8Bytes: Buffer.byteLength(answerText),
                completeness: "full-record", finality: "unverified", credentialScreenVersion: 1, credentialScreen: "passed" },
            captureContext: { consentRevision: 1, sourceConfigRef: state.personalEvaluation.source.sourceConfigRef, sourceConfigRevision: 1 },
        },
    });
    state.personalEvaluation.feedback.records.push({
        schemaVersion: 1, dependencies: assessmentDependencies(first),
        assessment: { ...first.assessments.find(item => item.dimension === "accuracy"), origin: "user-personal",
            assessmentRef: samples.id("assessment", 900), verdict: "pass", reason: "user-verdict" },
    });
    state.personalEvaluation.feedback.revision = 1;
    state.personalEvaluation.overrideRevision = 1;
    validatePersonalEvaluation(state.personalEvaluation);
    model = buildAssessmentModel(state);
    let expected = structuredClone(state), holdOverview = null, holdDetail = null, failDetail = false, failOverview = false;
    const errors = [], denied = [], reads = [];
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "wire-findings-memory-"));
    const contractSource = await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url), "utf8");
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "findings-fixture")); return;
            }
            if (req.method === "GET" && req.url === "/assets/assessment-contract.mjs") {
                res.setHeader("Content-Type", "text/javascript"); res.end(contractSource); return;
            }
            if (req.method === "GET" && req.url === "/favicon.svg") { res.statusCode = 204; res.end(); return; }
            let body = ""; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body || "{}");
            reads.push({ route: req.url, input });
            const envelope = data => ({ schemaVersion: 1, basis: model.basis, data });
            let data;
            if (req.url === "/api/snapshot") data = await currentStatePayload({ dataDir }, state, input);
            else if (req.url === "/api/assessment/overview") {
                if (failOverview) {
                    res.statusCode = 503; res.end(JSON.stringify({ error: "Invented summary read failure. Nothing was retried." })); return;
                }
                data = envelope(assessmentOverview(state, model, input.interactionRefs));
                if (holdOverview) await holdOverview(input);
            } else if (req.url === "/api/assessment/detail") {
                if (failDetail) {
                    res.statusCode = 503; res.end(JSON.stringify({ error: "Invented read failure. Nothing was retried." })); return;
                }
                data = envelope(model.details.get(input.interactionRef));
                if (holdDetail) await holdDetail(input);
            } else if (req.url === "/api/assessment/evidence") {
                const view = model.details.get(input.interactionRef);
                assert.equal(view.consent.state, "enabled");
                assert.equal(view.observations.find(item => item.observationRef === input.observationRef)?.kind, "answer");
                data = envelope({ observationRef: input.observationRef, basis: model.basis, text: answerText, completeness: "full-record", finality: "unverified" });
            } else if (req.url === "/api/evaluation/automatic/summary") data = automaticScoreOffSummary();
            else if (req.url === "/api/collection/status") data = { state: "paused", config: null, revision: state.revision };
            else { denied.push(`${req.method} ${req.url}`); res.statusCode = 403; data = { error: "Only read-only fixture requests are allowed." }; }
            if (legacy) {
                data = structuredClone(data);
                for (const value of [data.assessment?.overview, data.data]) if (value) {
                    delete value.reviewStatuses; delete value.assessmentAttempts;
                }
            }
            res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
        } catch (error) { errors.push(error.message); res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
        await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true });
        assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(state, expected);
        assert.doesNotMatch(JSON.stringify(reads), /Find five synthetic|Three synthetic documents|Research \/ Architecture/);
    });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(7000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === url) return route.continue();
        denied.push(route.request().url()); return route.abort();
    });
    return {
        page, url, records, extras, reads, state, get model() { return model; },
        holdOverview: callback => { holdOverview = callback; }, holdDetail: callback => { holdDetail = callback; },
        failDetail: () => { failDetail = true; },
        failOverview: value => { failOverview = value; },
        acceptFixtureChange: () => { expected = structuredClone(state); model = buildAssessmentModel(state); invalidateAssessmentCache(); },
    };
}
async function capture(page, host, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    const clip = await host.evaluate(node => {
        const box = node.getBoundingClientRect();
        return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
    });
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: true, clip });
    await writeFile(path.join(proof, name + ".txt"), await host.innerText());
}
async function captureContext(page, start, end, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.evaluate(() => scrollTo(0, 0));
    const top = (await start.boundingBox()).y, bottom = await end.boundingBox();
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: true,
        clip: { x: 0, y: Math.max(0, top - 40), width: page.viewportSize().width, height: bottom.y + bottom.height - Math.max(0, top - 40) } });
}

test("normal Analyze and changed-request context lead with supported findings and retain optional keyboard details", { timeout: 60000 }, async t => {
    const app = await setup(t), { page, url, records, reads } = app;
    await page.goto(url + "#analyze"); await ready(page);
    const host = page.locator("#homeInsights"), findings = page.locator("#homeFindings .assessment-findings");
    await expect(findings).toContainText("Work IQ sign-in was required");
    await expect(findings.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: 1 correct, 1 not correct");
    await expect(findings.locator('[data-finding-origin="user-personal"]')).toContainText("Answer: 1 correct");
    await expect(findings).toContainText("Insufficient recorded evidence");
    await expect(findings).toContainText("Evaluator could not complete");
    assert.equal(await page.locator("#homeFindings").evaluate(node =>
        Boolean(node.compareDocumentPosition(document.getElementById("percentageCharts")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal((await findings.innerText()).match(/Insufficient recorded evidence/g).length, 1);
    assert.equal((await findings.innerText()).match(/Saved AI review/g).length, 1);
    assert.equal(reads.filter(read => read.route.endsWith("/evidence")).length, 0);
    assert.equal(await host.locator(".assessment-saved-details").evaluate(node => node.open), false);
    assert.equal(await host.locator(".assessment-grid").isVisible(), false);
    const measurements = [];
    for (const [theme, width, scale] of [["light", 1280, 1], ["dark", 1280, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const metrics = await findings.evaluate(root => {
            const nodes = [...root.querySelectorAll("li,p,h3,h4,li>span")];
            return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className),
                colors: nodes.map(node => ({ fg: getComputedStyle(node).color, bg: getComputedStyle(document.body).backgroundColor })),
                textSize: getComputedStyle(root.querySelector("li")).fontSize,
            };
        });
        assert.ok(metrics.overflow <= 1); assert.deepEqual(metrics.clipped, []);
        for (const color of metrics.colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, JSON.stringify(color));
        assert.equal(parseFloat(metrics.textSize) >= (scale === 2 ? 28 : 14), true);
        const disclosure = host.locator(".assessment-saved-details > summary");
        await disclosure.focus(); await page.keyboard.press("Enter");
        await expect(host.locator(".assessment-grid")).toBeVisible();
        await expect(host.locator('[data-quality-dimension="accuracy"]')).toContainText("2 of 5 requests assessed");
        await expect(host.locator('[data-quality-dimension="accuracy"]')).toContainText("50% of assessed requests passed");
        const focused = await disclosure.evaluate(node => ({
            focused: node === document.activeElement, outline: getComputedStyle(node).outlineStyle,
            height: node.getBoundingClientRect().height,
        }));
        assert.equal(focused.focused, true); assert.notEqual(focused.outline, "none"); assert.ok(focused.height >= 44);
        await page.keyboard.press("Enter");
        measurements.push({ theme, width, scale, ...metrics, focused });
        await capture(page, findings, `analyze-${theme}-${width}-${scale}`);
        await captureContext(page, page.locator("#homeFindings"), page.locator("#percentageCharts").locator("h2").first(),
            `analyze-context-${theme}-${width}-${scale}`);
    }
    if (proof) await writeFile(path.join(proof, "layout-measurements.json"), JSON.stringify(measurements, null, 2));
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await page.locator("#activitySearch").fill("Find five");
    await selectActivityOption(page, "serviceAssociationFilter", "Calendar"); await ready(page);
    await expect(findings).toContainText("1 of 2 recorded calls failed; 1 succeeded");
    await expect(host.locator(".assessment-scope")).toContainText("full retained interaction");
    await expect(page.locator("#recordedTiming .assessment-coverage")).toHaveText("1 of 1 call timed");
    await expect(host.locator('[data-timing-boundary="tool-start-to-completion"] .assessment-coverage')).toHaveText("2 of 2 calls timed");
    await selectActivityOption(page, "serviceAssociationFilter", "all"); await ready(page);
    await page.locator("#activitySearch").fill("Three synthetic");
    await expect(findings.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: Correct");
    await expect(findings).not.toContainText("sign-in was required");
    await page.locator("#activityList .request-link").first().click();
    const first = page.locator(`.interaction-findings[data-context-group="${records[0].scenarioId}"]`);
    const second = page.locator(`.interaction-findings[data-context-group="${records[1].scenarioId}"]`);
    await expect(second.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: Correct");
    await expect(first.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: Not correct");
    await expect(second).not.toContainText("sign-in was required");
    await expect(page.locator(".interaction-response .full-text-content")).toHaveText(answerText);
    assert.equal(reads.filter(read => read.route.endsWith("/evidence")).length, 1);
    assert.equal(await second.evaluate(node => node.closest('[data-context-kind="prompt"]')?.querySelector(".request-original") !== null), true);
    await capture(page, second, "changed-request-findings");
    await captureContext(page, page.locator("#selectedContext"), page.locator(".interaction-response .full-text-content"), "request-context-desktop");
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    assert.equal(await second.evaluate(node => document.documentElement.scrollWidth <= innerWidth + 1
        && [...node.querySelectorAll("li,p")].every(item => item.scrollWidth <= item.clientWidth + 1)), true);
    const summary = page.locator(`.interaction-insights[data-context-group="${records[1].scenarioId}"]`);
    const trigger = summary.locator("[data-insight-details]");
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
    await dialog.getByText("Recorded measures and definitions", { exact: true }).click();
    await expect(dialog).toContainText("100%");
    await expect(dialog).toContainText("synthetic-quality-fixture");
    await expect(dialog).toContainText("wire-recorded-interaction-review v1");
    const feedback = dialog.getByRole("button", { name: "Give personal feedback", exact: true });
    await feedback.focus(); await page.keyboard.press("Enter");
    const feedbackDialog = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
    await expect(feedbackDialog).toBeVisible();
    await page.keyboard.press("Escape"); await expect(feedbackDialog).toBeHidden();
    await expect(feedback).toBeFocused();
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    assert.equal(reads.filter(read => /feedback|approve|capture|collect-now|evaluate/.test(read.route)).length, 0);
    await capture(page, second, "changed-request-narrow-200");
    await captureContext(page, page.locator("#selectedContext"), page.locator(".interaction-response .full-text-content"), "request-context-narrow-200");
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await page.goBack(); await ready(page);
    await expect(page.locator("#activitySearch")).toHaveValue("Three synthetic");
});

test("late overview and detail reads cannot borrow a neighbor's findings; same-basis attempt changes refresh", { timeout: 45000 }, async t => {
    const app = await setup(t), { page, url, state } = app;
    await page.goto(url + "#analyze"); await ready(page);
    const findings = page.locator("#homeFindings .assessment-findings");
    let release;
    app.holdOverview(input => input.interactionRefs.includes(app.model.catalog[0].interactionRef)
        ? new Promise(resolve => { release = resolve; }) : undefined);
    await page.locator("#activitySearch").fill("Find five");
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(page.locator("#homeFindings")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#homeFindings")).toContainText("Reading saved findings");
    await expect(findings).toHaveCount(0);
    await page.locator("#activitySearch").fill("Three synthetic");
    await expect(findings.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: Correct");
    const oldOverview = page.waitForResponse(response => response.url().endsWith("/api/assessment/overview")
        && response.request().postDataJSON().interactionRefs.includes(app.model.catalog[0].interactionRef));
    release(); await (await oldOverview).finished(); await frames(page); app.holdOverview(null);
    await expect(findings).not.toContainText("sign-in was required");
    const before = structuredClone(app.model.basis);
    const prior = structuredClone(state.personalEvaluation.modelEvaluation.runs[1]);
    prior.runRef = samples.id("run", 990); prior.phase = "failed"; prior.error = "evaluation-failed";
    prior.results = prior.results.map(row => ({ ...row, status: "failed", reason: "evaluation-failed" }));
    state.personalEvaluation.modelEvaluation.runs.push(prior);
    app.acceptFixtureChange();
    assert.deepEqual(app.model.basis, before);
    await (await revealStoredRefresh(page)).click(); await ready(page);
    await expect(findings).toContainText("Evaluator could not complete");
    await expect(findings.locator('[data-finding-origin="model-assessed"]')).toContainText("Answer: Correct");
    let releaseDetail;
    const originalSecond = app.model.catalog[1].interactionRef;
    app.holdDetail(input => input.interactionRef === originalSecond ? new Promise(resolve => { releaseDetail = resolve; }) : undefined);
    await page.goto(url + "#request?request=" + encodeURIComponent(app.records[1].scenarioId));
    await expect.poll(() => Boolean(releaseDetail)).toBe(true);
    await page.goto(url + "#request?request=" + encodeURIComponent(app.extras[2].scenarioId));
    const current = page.locator(`.interaction-findings[data-context-group="${app.extras[2].scenarioId}"]`);
    await expect(current).toContainText("No saved answer or action assessment is available");
    const oldDetail = page.waitForResponse(response => response.url().endsWith("/api/assessment/detail")
        && response.request().postDataJSON().interactionRef === originalSecond);
    releaseDetail(); await (await oldDetail).finished(); await frames(page); app.holdDetail(null);
    await expect(current.locator('[data-finding-origin="model-assessed"]')).toHaveCount(0);
    assert.equal(await page.locator(`.interaction-findings[data-context-group="${app.records[1].scenarioId}"]`).count(), 0);
    app.failDetail();
    await page.goto(url + "#request?request=" + encodeURIComponent(app.extras[0].scenarioId));
    await expect(page.locator(".interaction-findings")).toContainText("Saved findings could not be read");
    assert.equal(await page.locator(".interaction-findings [data-finding-kind=verdict]").count(), 0);
});

test("missing legacy status metadata is explicitly unavailable, not no problems or no attempts", { timeout: 25000 }, async t => {
    const { page, url } = await setup(t, { legacy: true });
    await page.goto(url + "#analyze"); await ready(page);
    const host = page.locator("#homeInsights");
    await expect(page.locator("#homeFindings .assessment-findings")).toContainText("Detailed call-status context is unavailable");
    await expect(page.locator("#homeFindings .assessment-findings")).not.toContainText("sign-in was required");
    await host.locator(".assessment-saved-details > summary").click();
    await expect(host.locator(".assessment-attempts")).toContainText("Assessment attempt history unavailable");
    await expect(host.locator("[data-attempt-state=none]")).toHaveCount(0);
});

test("saved overview disclosure survives ordinary rerender and Back with its focused summary", { timeout: 25000 }, async t => {
    const { page, url, records } = await setup(t);
    await page.goto(url + "#analyze"); await ready(page);
    const saved = page.locator("#homeInsights .assessment-saved-details"), summary = saved.locator(":scope > summary");
    await summary.click();
    await page.locator('[data-chart="workload"]').click(); await ready(page);
    await expect(saved).toHaveAttribute("open", "");
    await page.locator("#activitySearch").fill("Three synthetic"); await ready(page);
    await expect(saved).not.toHaveAttribute("open", "");
    await page.locator("#activitySearch").fill(""); await ready(page);
    await expect(saved).toHaveAttribute("open", "");
    await summary.focus();
    await page.evaluate(id => { location.hash = "#request?request=" + encodeURIComponent(id); }, records[1].scenarioId);
    await expect(page.locator(".interaction-findings").first()).toBeVisible();
    await page.goBack(); await ready(page);
    await expect(saved).toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
});

test("saved request disclosures retain independent keys, rerender state and Back focus", { timeout: 25000 }, async t => {
    const { page, url, records } = await setup(t);
    await page.goto(url + "#request?request=" + encodeURIComponent(records[1].scenarioId));
    const selected = page.locator(`.interaction-insights[data-context-group="${records[1].scenarioId}"] .assessment-saved-details`);
    const earlier = page.locator(`.interaction-insights[data-context-group="${records[0].scenarioId}"] .assessment-saved-details`);
    await selected.locator(":scope > summary").click();
    await page.locator("#requestReportToggle").click();
    await expect(selected).toHaveAttribute("open", "");
    await expect(earlier).not.toHaveAttribute("open", "");
    await selected.locator(":scope > summary").focus();
    await page.evaluate(() => { location.hash = "#analyze"; }); await ready(page);
    await page.goBack();
    await expect(selected).toHaveAttribute("open", "");
    await expect(selected.locator(":scope > summary")).toBeFocused();
});

test("leading overview host clears on empty scope and read failure and recovers by read-only retry", { timeout: 25000 }, async t => {
    const app = await setup(t), { page, url } = app;
    await page.goto(url + "#analyze"); await ready(page);
    const leading = page.locator("#homeFindings");
    await page.locator("#activitySearch").fill("NO_SYNTHETIC_MATCH");
    await expect(leading).toContainText("No matching request groups");
    await expect(leading.locator(".assessment-findings")).toHaveCount(0);
    await expect(leading).not.toHaveAttribute("aria-busy");
    app.failOverview(true);
    await page.locator("#activitySearch").fill("Other synthetic request 2");
    await expect(leading).toContainText("Saved findings could not be read");
    await expect(leading.locator(".assessment-findings")).toHaveCount(0);
    await expect(leading).not.toHaveAttribute("aria-busy");
    app.failOverview(false);
    await page.locator("#homeInsights").getByRole("button", { name: "Read insights again", exact: true }).click();
    await ready(page);
    await expect(leading).toContainText("No saved answer or action assessment is available");
    await expect(leading).not.toContainText("sign-in was required");
});
