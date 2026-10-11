import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { assessmentDependencies, assessmentRef, assessmentSource, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { collectRecordedAnswerCandidates, commitRecordedAnswers } from "../lib/assessment-capture.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { fixture, privateFixture, revealStoredRefresh } from "./helpers.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const proof = process.env.WIRE_CONTEXT_PROOFS;
const bodyText = "Here are three synthetic documents:\nResearch / Architecture / Design";

async function setup(t, { responses = true, missing = false, extraReplies = [] } = {}) {
    const source = retainedContextFixture();
    const records = source.records.slice(0, 2);
    // Kept as a fragment exactly as supplied to the existing authorized reader.
    records[1].userPrompt.status = "partial";
    if (missing) records[1].followUpPrompts = [{ sourceEventId: "not-retained", status: "unavailable",
        text: "EXCLUDED_UNAVAILABLE_TEXT", authorship: { actor: "unknown", basis: "missing-source" } }];
    else records[1].followUpPrompts = [];
    const unrelated = Array.from({ length: 9 }, (_, i) => {
        const record = fixture("unrelated-" + i);
        record.sourceSessionId = i === 0 ? records[0].sourceSessionId : "other-chat";
        record.userPrompt = { ...record.userPrompt, text: "UNRELATED_RECORD_" + i, sourceEventId: "unrelated-prompt-" + i, sourceTimestamp: "2026-10-01T12:00:00Z" };
        record.followUpPrompts = [];
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, [...records, ...unrelated]);
    let closeResources = async () => {};
    t.after(async () => {
        try { await closeResources(); }
        finally { for (const action of cleanup) await action(); }
    });
    const config = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 5,
        sourceAdapter: "copilot-app-sqlite-v156", appDbPath: path.join(context.dataDir, "invented-only.db"),
        sessionRoot: path.join(context.dataDir, "invented-only-events") };
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify(config));
    const sourceConfig = assessmentSource(await loadBoardState(context), config);
    if (responses) {
        await updateBoardState(context, state => {
            const personal = defaultPersonalEvaluation();
            personal.source = sourceConfig;
            personal.consent = { ...personal.consent, state: "enabled", revision: 1, categories: ["answer"],
                sourceConfigRef: sourceConfig.sourceConfigRef, sourceConfigRevision: sourceConfig.sourceConfigRevision,
                grantedAt: "2026-09-30T11:00:00.000Z", grantOrigin: "explicit-in-app-setup" };
            state.personalEvaluation = personal;
        });
        const candidates = collectRecordedAnswerCandidates(source.events, new Set(["reply-three"]), records[0].sourceSessionId);
        candidates.push(...extraReplies.map(reply => ({ sourceSessionId: records[0].sourceSessionId, ...reply })));
        assert.equal((await commitRecordedAnswers(context, candidates, { consentRevision: 1, source: sourceConfig })).captured, candidates.length);
    }
    await updateBoardState(context, state => {
        state.personalEvaluation ??= defaultPersonalEvaluation();
        const personal = state.personalEvaluation;
        const model = buildAssessmentModel(state, { source: sourceConfig });
        const view = model.details.get(model.catalog.find(item => item.scenarioId === records[0].scenarioId).interactionRef);
        const dependencies = assessmentDependencies(view), ref = view.interaction.interactionRef;
        personal.feedback.records.push({ schemaVersion: 1, dependencies, assessment: {
            schemaVersion: 1, interactionRef: ref, basis: view.basis, createdAt: "2026-09-30T12:00:03.000Z",
            evidenceRefs: dependencies.evidenceRefs, assessmentRef: assessmentRef(state, "assessment", "invented-prior-verdict"),
            checkId: "semantic-answer-correctness", checkVersion: 1, dimension: "accuracy", unitRef: ref,
            origin: "user-personal", rubricVersion: 1, verdict: "fail", reason: "user-verdict", revision: 1, supersedes: null, withdrawn: false,
        } });
        personal.feedback.revision = 1;
        personal.overrideRevision = 1;
    });
    let expected = await loadBoardState(context);
    const configBefore = await readFile(path.join(context.dataDir, "collector", "config.json"));
    let forbiddenSourceReads = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { forbiddenSourceReads++; throw Error("No provider work in context proof."); },
            readSource: async () => { forbiddenSourceReads++; throw Error("No source reads in context proof."); } } });
    closeResources = () => runtime.close();
    const browser = await chromium.launch();
    closeResources = async () => { await browser.close(); await runtime.close(); };
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(7000);
    const errors = [], denied = [], requests = [], payloadReads = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/assessment/evidence", "/api/evaluation/automatic/summary"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push({ path: url.pathname, method: request.method(), body: request.postData() });
        if (url.pathname === "/api/assessment/evidence") payloadReads.push(request.postDataJSON());
        return route.continue();
    });
    await page.addInitScript(() => {
        window.contextClipboard = { writes: [], denied: false };
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) {
                if (window.contextClipboard.denied) throw new DOMException("Invented clipboard refusal", "NotAllowedError");
                window.contextClipboard.writes.push(text);
            },
        } });
    });
    closeResources = async () => {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.equal(forbiddenSourceReads, 0);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], expected[key], key);
            assert.deepEqual(await readFile(path.join(context.dataDir, "collector", "config.json")), configBefore);
            assert.doesNotMatch(JSON.stringify(requests), /Find five synthetic|Three synthetic documents|Here are three synthetic|Keep these spaces/);
    };
    return { page, runtime, records, context, payloadReads, requests, acceptFixtureChange: async () => { expected = await loadBoardState(context); } };
}

test("normal isolated source opens retained correction, retry and reply immediately; Analyze Back is exact", { timeout: 40000 }, async t => {
    const app = await setup(t), { page, runtime, records, payloadReads } = app;
    await page.goto(runtime.url + "#analyze"); await ready(page);
    assert.equal(payloadReads.length, 0, "Analyze never preloads retained response payloads");
    await page.locator("#activitySearch").fill("synthetic");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    const row = page.locator(`.request-row[data-view-key="request:${records[0].scenarioId}"]`);
    await row.locator("input").check();
    const open = row.locator(".request-link");
    await open.focus(); await frames(page);
    const origin = page.url(), position = await open.boundingBox();
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveText(bodyText);
    const timeline = page.locator(".request-context-timeline");
    assert.doesNotMatch(await timeline.innerText(), /UNRELATED_RECORD|Separate synthetic topic|More unrelated synthetic/);
    assert.deepEqual(await timeline.locator(".full-text-content").allTextContents(),
        [records[0].userPrompt.text, records[1].userPrompt.text, bodyText]);
    assert.deepEqual(await timeline.locator("li[data-context-kind=action]").evaluateAll(nodes => nodes.map(node => node.dataset.toolCallId)),
        ["failed-lookup", "retry-lookup"]);
    const kinds = await timeline.locator(":scope > li:visible").evaluateAll(nodes => nodes.map(node => node.dataset.contextKind));
    assert.deepEqual(kinds.slice(0, 5), ["prompt", "action", "prompt", "action", "response"]);
    await expect(page.locator("#selectedContext")).toHaveAttribute("data-context-group", records[0].scenarioId);
    const failed = timeline.locator('[data-tool-call-id="failed-lookup"]');
    await expect(failed).toContainText("Work IQ sign-in was required");
    await expect(failed).toContainText("Historical call evidence only");
    assert.doesNotMatch(await failed.innerText(), /HTTP 401|HTTP 403|Sign in now/);
    for (const record of records) {
        const prompt = timeline.locator(`[data-context-group="${record.scenarioId}"][data-context-kind=prompt]`);
        await expect(prompt.locator("[data-prompt-actor]").first()).toHaveAttribute("data-prompt-actor", promptAuthorship.read(record.userPrompt).actor);
    }
    await expect(page.locator(".request-context-summaries")).toContainText("original recorded group and assessment scope");
    await expect(page.locator(`.interaction-insights[data-context-group="${records[0].scenarioId}"]`)).toContainText("Your feedback");
    assert.equal(payloadReads.length, 1, "Only the independently authorized linked answer was read");
    await expect(timeline.locator(".reader-state-partial")).toHaveText("Partial text");
    const correction = timeline.locator(`[data-context-group="${records[1].scenarioId}"][data-context-kind=prompt]`);
    const copy = correction.getByRole("button", { name: "Copy prompt", exact: true });
    await copy.focus(); await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.contextClipboard.writes), [records[1].userPrompt.text]);
    await page.evaluate(() => { window.contextClipboard.denied = true; });
    await copy.click();
    await expect(correction.locator("[role=alert]")).toContainText("Couldn't copy");
    await page.evaluate(() => { window.contextClipboard.denied = false; });
    const response = page.locator(".interaction-response").filter({ has: page.locator(".full-text-content") });
    await response.getByRole("button", { name: "Copy response", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.contextClipboard.writes), [records[1].userPrompt.text, bodyText]);
    await response.getByRole("button", { name: "Hide response", exact: true }).click();
    const reads = payloadReads.length;
    await page.locator("#requestReportToggle").click();
    await expect(page.locator(".interaction-response:visible")).toContainText(["No response text retained.", "Response text is hidden."]);
    assert.equal(payloadReads.length, reads, "Rerender never re-reads intentionally hidden private response text");
    await page.locator(".interaction-response:visible").getByRole("button", { name: "Read response", exact: true }).click();
    await expect(page.locator(".interaction-response .full-text-content")).toHaveText(bodyText);
    await page.locator("#requestReportToggle").click();
    await page.locator("#contextBack").click(); await ready(page); await frames(page);
    assert.equal(page.url(), origin);
    await expect(page.locator("#activitySearch")).toHaveValue("synthetic");
    await expect(open).toBeFocused();
    assert.ok(Math.abs((await open.boundingBox()).y - position.y) < 3);
    await expect(row.locator("input")).toBeChecked();
    await open.click(); await ready(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveText(bodyText);
    for (const [width, scale] of [[1280, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${100 * scale}%`, scale);
        await frames(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await timeline.locator(".full-text-content,button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility())
            .every(node => node.scrollWidth <= node.clientWidth + 1)), true);
        await correction.getByRole("button", { name: "Hide prompt", exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(correction.locator(".full-text-content")).toHaveCount(0);
        await correction.getByRole("button", { name: "Read prompt", exact: true }).press("Space");
        await expect(correction.locator(".full-text-content")).toHaveText(records[1].userPrompt.text);
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.evaluate(() => scrollTo(0, 0)); await frames(page);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x.png`), fullPage: true });
            const align = node => scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 16);
            await timeline.locator(":scope > li").first().evaluate(align);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x-messages.png`) });
            await page.locator('[data-context-kind=response]').evaluate(align);
            await page.screenshot({ path: path.join(proof, `context-${width}-${scale}x-response.png`) });
            await writeFile(path.join(proof, `context-${width}-${scale}x.txt`), await page.locator("#requestContent").ariaSnapshot());
        }
    }
});

test("leaving before the shared reader is ready never starts an eager hidden payload read", { timeout: 20000 }, async t => {
    const { page, runtime, records, payloadReads } = await setup(t);
    let release, reached;
    const intercepted = new Promise(resolve => { reached = resolve; });
    await page.route("**/assets/assessment-contract.mjs", async route => {
        const response = await route.fetch();
        reached();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response });
    });
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await intercepted;
    await page.locator('nav [data-nav="analyze"]').click(); await ready(page);
    release();
    await expect(page.locator("#homeInsights .assessment-summary")).toBeVisible();
    assert.equal(payloadReads.length, 0);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
});

test("each adjacent reply is independently authorized and multiple retained responses keep their real time and completeness", { timeout: 20000 }, async t => {
    const app = await setup(t, { extraReplies: [
        { sourceEventId: "old-answer", messageEventId: "five", at: "2026-09-30T12:00:03.000Z", text: "INACCESSIBLE_NEIGHBOR_RESPONSE" },
        { sourceEventId: "untimed-answer", messageEventId: "three", at: "2026-09-30T12:00:09.000Z", text: "Exact retained response fragment.\r\n  unchanged  " },
    ] });
    const { page, context, records, runtime, payloadReads } = app;
    let excludedRef;
    await updateBoardState(context, state => {
        const old = state.personalEvaluation.captures.find(capture => capture.observation.occurredAt === "2026-09-30T12:00:03.000Z");
        old.observation.captureContext.sourceConfigRevision++;
        excludedRef = old.observation.observationRef;
        const untimed = state.personalEvaluation.captures.find(capture => capture.observation.occurredAt === "2026-09-30T12:00:09.000Z");
        untimed.observation.occurredAt = null;
        untimed.observation.payload.completeness = "bounded-fragment";
    });
    await app.acceptFixtureChange();
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(2);
    assert.equal(payloadReads.some(input => input.observationRef === excludedRef), false);
    const responses = page.locator('[data-context-kind="response"]');
    await expect(responses.first()).toContainText("Response recorded:");
    await expect(responses.last()).toContainText("Time not recorded; position in the chronology is unknown.");
    await expect(responses.last()).toContainText("Partial text");
    assert.deepEqual(await responses.locator(".full-text-content").allTextContents(),
        [bodyText, "Exact retained response fragment.\r\n  unchanged  "]);
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /INACCESSIBLE_NEIGHBOR_RESPONSE/);
});

test("off capture, missing retained text and unmatched same-chat records remain explicit without payload reads", { timeout: 20000 }, async t => {
    const { page, runtime, records, payloadReads } = await setup(t, { responses: false, missing: true });
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await expect(page.locator(".interaction-response:visible")).toHaveCount(2);
    await expect(page.locator(".interaction-response:visible").first()).toContainText("No response text retained.");
    await expect(page.locator(".request-context-timeline")).toContainText("Prompt not available");
    await expect(page.locator(".request-context-timeline")).toContainText("inferred follow-up, not a confirmed continuation");
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /EXCLUDED_UNAVAILABLE_TEXT|UNRELATED_RECORD/);
    assert.equal(payloadReads.length, 0);
});

test("late eager answers cannot survive navigation or revoked access; no mutation is replayed", { timeout: 40000 }, async t => {
    const app = await setup(t), { page, runtime, records, context } = app;
    let sourceChecks = 0;
    // Unified Refresh needs a receipt before applying a snapshot; never read the invented source paths.
    await page.route("**/api/collection/now", async route => {
        sourceChecks++;
        const status = await runtime.collector.status();
        await route.fulfill({ json: { ...status, check: {
            schemaVersion: 2, id: "invented-context-refresh", revision: status.revision, beforeRevision: status.revision,
            configVersion: status.configVersion, completedAt: "2026-10-01T12:00:00.000Z", outcome: "complete",
            changes: { added: 0, updated: 0, items: [] }, coverage: {},
            sourcesChecked: 0, eligibleSources: 0, pendingSources: 0, partialSources: 0, skippedSources: 0,
        } } });
    });
    let release, reached;
    const intercepted = new Promise(resolve => { reached = resolve; });
    await page.route("**/api/assessment/evidence", async route => {
        const response = await route.fetch();
        reached();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response });
    });
    await page.goto(runtime.url + "#request?request=" + records[0].scenarioId); await ready(page);
    await intercepted;
    await page.locator('nav [data-nav="analyze"]').click(); await ready(page);
    const leftResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/evidence"));
    release(); await (await leftResponse).finished(); await frames(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
    await page.unroute("**/api/assessment/evidence");
    let releaseStale, sawStale;
    const pending = new Promise(resolve => { sawStale = resolve; });
    await page.route("**/api/assessment/evidence", async route => {
        const response = await route.fetch();
        assert.equal((await response.json()).basis.consentRevision, 1);
        sawStale();
        await new Promise(resolve => { releaseStale = resolve; });
        await route.fulfill({ response });
    });
    await page.goto(runtime.url + "#request?request=" + records[1].scenarioId); await ready(page);
    await pending;
    await updateBoardState(context, state => {
        state.personalEvaluation.consent = { ...state.personalEvaluation.consent, state: "revoked", revision: 2,
            categories: [], revokedAt: "2026-10-01T12:00:00.000Z" };
    });
    await app.acceptFixtureChange();
    const revoked = await loadBoardState(context);
    const revokedSnapshot = page.waitForResponse(async response => {
        if (!response.ok() || !response.url().endsWith("/api/snapshot")) return false;
        const snapshot = await response.json();
        return snapshot.revision === revoked.revision
            && snapshot.assessment?.basis.consentRevision === revoked.personalEvaluation.consent.revision;
    });
    await (await revealStoredRefresh(page)).click();
    await (await revokedSnapshot).finished();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-revision", String(revoked.revision));
    await ready(page);
    const revokedResponse = page.locator(`[data-context-kind="prompt"][data-context-group="${records[1].scenarioId}"] .interaction-response`);
    await expect(revokedResponse).toContainText("No response text retained.");
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
    const staleResponse = page.waitForResponse(response => response.url().endsWith("/api/assessment/evidence"));
    releaseStale(); await (await staleResponse).finished(); await frames(page);
    await expect(page.locator(".interaction-response .full-text-content")).toHaveCount(0);
    await page.unroute("**/api/assessment/evidence");
    const reads = app.payloadReads.length;
    await page.reload(); await ready(page);
    await expect(revokedResponse).toContainText("No response text retained.");
    assert.equal(app.payloadReads.length, reads, "Revoked payloads aren't fetched on reopening");
    assert.equal(sourceChecks, 1, "The fixture source check is never replayed by the late answer or reload");
});
