// Invented retained data on an isolated real server; no collection or mutation API is allowed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { defaultPersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { fixture, privateFixture, navigateMain, selectActivityOption, chooseTheme, revealStoredRefresh } from "./helpers.mjs";

function recordsForScope() {
    return Array.from({ length: 10 }, (_, i) => {
        const row = fixture(`scope-request-${i}`);
        row.sourceSessionId = `scope-chat-${i}`;
        row.sourceSessionName = `Synthetic scope chat ${i}`;
        row.projectId = i < 5 ? "scope-project-a" : "scope-project-b";
        row.project = i < 5 ? "Invented project A" : "Invented project B";
        row.userPrompt = { ...row.userPrompt, sourceEventId: `prompt-${i}`, text: `Invented request ${i}` };
        row.followUpPrompts = [];
        row.toolCalls = Array.from({ length: i === 0 ? 2 : 1 }, (_, j) => ({
            ...structuredClone(row.toolCalls[0]),
            toolCallId: `call-${i}-${j}`, startEventId: `start-${i}-${j}`,
            completionEventId: i === 9 ? null : `complete-${i}-${j}`,
            requestedApiPath: i === 0 && j === 1 ? "/me/messages" : "/me/calendarView",
            requestArgs: { entityUrls: [i === 0 && j === 1 ? "/me/messages" : "/me/calendarView"] },
            toolSucceeded: i === 9 ? null : i !== 0 || j !== 0,
            reportedOutcome: i === 9 ? "unknown" : i === 0 && j === 0 ? "failed" : "succeeded",
            ...(i === 9 ? {} : {
                startedAt: "2026-09-30T12:00:00.000Z",
                completedAt: new Date(Date.parse("2026-09-30T12:00:00.000Z") + (i === 0 ? [100, 900][j] : (i + 1) * 1000)).toISOString(),
                durationMs: i === 0 ? [100, 900][j] : (i + 1) * 1000,
            }),
        }));
        return row;
    });
}
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const insightsReady = page => expect(page.locator("#activityInsights")).not.toHaveAttribute("aria-busy", "true");
async function finishRead(page, response) {
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
async function setup(t, records = recordsForScope(), { beforeOpen } = {}) {
    const cleanup = [], requests = [], responses = [], errors = [], forbidden = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC" });
    page.setDefaultTimeout(6000);
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"]);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
            forbidden.push(url.pathname); return route.abort();
        }
        if (request.method() === "POST") requests.push({ path: url.pathname, input: request.postDataJSON() });
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.url().endsWith("/api/assessment/overview") || response.url().endsWith("/api/snapshot")) {
            try { responses.push({ path: new URL(response.url()).pathname, status: response.status(), data: await response.json() }); }
            catch (error) { if (!page.isClosed()) errors.push(error.message); }
        }
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
            assert.doesNotMatch(JSON.stringify(requests), /Synthetic scope chat|SYNTHETIC_NO_MATCH|Invented request/);
            const after = await loadBoardState(context);
            assert.deepEqual(after.exports, before.exports);
            assert.deepEqual(after.cards, before.cards);
        } finally { for (const action of cleanup) await action(); }
    });
    if (beforeOpen) await beforeOpen(page);
    await page.goto(runtime.url + "#activity"); await ready(page);
    return { page, context, requests, responses, records, runtime };
}
function checkMetrics(overview, { refs, eligible, covered, pass, fail, median, samples }) {
    assert.equal(overview.interactionRefs.length, refs);
    const duration = overview.metrics.find(metric => metric.definitionId === "tool-duration");
    assert.deepEqual(duration.coverage, { eligible, covered });
    assert.equal(duration.value, median);
    assert.deepEqual(duration.samples.map(sample => sample.value).sort((a, b) => a - b), samples);
    const outcomes = overview.metrics.find(metric => metric.checkId === "recorded-tool-success");
    assert.equal(outcomes.denominator, pass + fail);
    assert.deepEqual(outcomes.counts, { pass, fail, unassessed: eligible - pass - fail, evaluatorError: 0 });
    for (const dimension of ["accuracy", "answer-trust", "action-trust"]) {
        const metric = overview.metrics.find(value => value.dimension === dimension);
        assert.equal(metric.origin, "automatic-local"); assert.equal(metric.value, null);
        assert.deepEqual(metric.coverage, { eligible: refs, covered: 0 });
    }
    assert.equal(overview.metrics.some(metric => metric.dimension === "cost"), false);
}
async function recordedOverview(responses, predicate) {
    const find = () => responses.filter(value => value.path.endsWith("/overview") && value.status === 200)
        .map(value => value.data.data).findLast(predicate);
    await expect.poll(() => Boolean(find())).toBe(true);
    return find();
}
const allExpected = { refs: 10, eligible: 11, covered: 10, pass: 9, fail: 1, median: 4000, samples: [100, 900, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000] };
const oneExpected = { refs: 1, eligible: 2, covered: 2, pass: 1, fail: 1, median: 100, samples: [100, 900] };
async function expectOne(page, session = false) {
    await expect(page.locator("#periodResult")).toHaveText(session ? "This Copilot chat: 1 request group with 2 Work IQ tool calls."
        : "1 Copilot chat / 1 request group with 2 Work IQ tool calls.");
    await expect(page.locator("#activityInsights")).toContainText("1 / 2 tool completions with a recorded success/failure result failed");
    await expect(page.locator('#activityInsights [data-dimension="speed"] .assessment-value').first()).toHaveText("100 ms");
    await expect(page.locator("#activityInsights")).toContainText("2 / 2 calls timed");
}
async function expectAll(page, host = "#activityInsights") {
    await expect(page.locator("#periodResult")).toHaveText(host === "#homeInsights" ? "11 Work IQ tool calls (All dates)" : "10 Copilot chats / 10 request groups with 11 Work IQ tool calls.");
    await expect(page.locator(host)).toContainText("1 / 10 tool completions with a recorded success/failure result failed");
    await expect(page.locator(`${host} [data-dimension="speed"] .assessment-value`).first()).toHaveText("4,000 ms");
    await expect(page.locator(host)).toContainText("10 / 11 calls timed");
}
async function expectEmpty(page) {
    await expect(page.locator("#periodResult")).toHaveText("0 Copilot chats / 0 request groups with 0 Work IQ tool calls.");
    await expect(page.locator("#activityInsights")).toHaveText("InsightsNo matching request groups. No interactions to summarize.");
    assert.equal(await page.locator("#activityInsights .assessment-value").count(), 0);
}

test("WIRE-UX-004: typed search shares exact full-page canonical membership, empty is explicit, history/reload preserve scope", { timeout: 45000 }, async t => {
    const { page, responses, requests } = await setup(t);
    await expectAll(page);
    checkMetrics(responses.find(value => value.path === "/api/snapshot").data.assessment.overview, allExpected);
    assert.equal(await page.locator(".session-group").count(), 8);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    await expectAll(page);
    assert.equal(await page.locator(".session-group").count(), 2);
    for (let repeat = 0; repeat < 2; repeat++) {
        await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE"); await expectEmpty(page);
        await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await expectOne(page);
        await expect(page.locator("#activitySearch")).toBeFocused();
        await page.locator("#clearActivitySearch").click(); await expectAll(page);
    }
    const scoped = responses.filter(value => value.path.endsWith("/overview") && value.status === 200).map(value => value.data.data);
    assert.deepEqual(scoped.find(value => !value.interactionRefs.length), { interactionRefs: [], metrics: [] });
    const one = scoped.find(value => value.interactionRefs.length === 1);
    checkMetrics(one, oneExpected);
    const snapshot = responses.find(value => value.path === "/api/snapshot").data;
    assert.deepEqual(one.interactionRefs, [snapshot.assessment.catalog.find(row => row.scenarioId === "scope-request-0").interactionRef]);
    assert.deepEqual([...snapshot.assessment.overview.interactionRefs].sort(), snapshot.assessment.catalog.filter(row => row.status === "retained").map(row => row.interactionRef).sort());
    assert.ok(requests.some(value => value.path.endsWith("/overview") && value.input.interactionRefs.length === 0));
    await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await expectOne(page);
    await page.locator('.request-row input[type="checkbox"]').check();
    await (await revealStoredRefresh(page)).click(); await ready(page); await expectOne(page);
    assert.equal(await page.locator('.request-row input[type="checkbox"]').isChecked(), true);
    await navigateMain(page, "home"); await expectAll(page, "#homeInsights");
    await page.goBack(); await ready(page); await expectOne(page);
    await expect(page.locator("#activitySearch")).toHaveValue("Synthetic scope chat 0");
    await page.goForward(); await ready(page); await expectAll(page, "#homeInsights");
    await navigateMain(page, "activity"); await expectOne(page);
    await page.reload(); await ready(page); await expectOne(page);
    assert.equal(await page.evaluate(() => history.state.evidenceView.search), "Synthetic scope chat 0");
    assert.doesNotMatch(page.url(), /Synthetic|scope%20chat/);
    const proofs = process.env.WIRE_SCOPE_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const [theme, width, scale] of [["light", 1200, 1], ["dark", 375, 1], ["dark", 375, 2]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE"); await expectEmpty(page);
        await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await expectOne(page);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator("#activityInsights .assessment-scope").count(), 0);
        assert.equal(await page.locator("#periodResult").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        if (proofs) await page.screenshot({ path: path.join(proofs, `scope-${theme}-${width}-${scale}.png`), fullPage: true });
    }
    if (proofs) await writeFile(path.join(proofs, "scope-read-trace.json"), JSON.stringify({
        fixture: "10 invented chats, 10 request groups, 11 calls; first chat has 2 calls; final chat has unknown completion and no timing",
        expectedAll: allExpected, expectedOne: oneExpected,
        canonicalOne: one.interactionRefs,
        reads: requests.filter(value => value.path.endsWith("/overview")),
        accepted: scoped.map(value => ({
            interactionRefs: value.interactionRefs,
            toolDuration: value.metrics.find(metric => metric.definitionId === "tool-duration"),
            toolCompletion: value.metrics.find(metric => metric.checkId === "recorded-tool-success"),
        })),
    }, null, 2));
});

test("WIRE-UX-004: result/service/date/project/chat scopes retain explicit whole-interaction context and unknown coverage", { timeout: 45000 }, async t => {
    const { page, responses, runtime } = await setup(t);
    await expectAll(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("1 Copilot chat / 1 request group with 1 Work IQ tool call.");
    await expect(page.locator("#activityInsights")).toContainText("2 / 2 calls timed");
    assert.equal(await page.locator("#activityInsights .assessment-scope").count(), 0);
    await expect(page.locator("#coverageBody .activity-list-explanation")).toContainText("each matching group's full retained interaction");
    checkMetrics(responses.filter(value => value.path.endsWith("/overview")).at(-1).data.data, oneExpected);
    await selectActivityOption(page, "outcomeFilter", ["failure", "unknown"]); await ready(page); await insightsReady(page);
    await expect(page.locator("#periodResult")).toHaveText("2 Copilot chats / 2 request groups with 2 Work IQ tool calls.");
    assert.equal(await page.locator("#activityInsights .assessment-scope").count(), 0);
    await expect(page.locator("#activityInsights")).toContainText("2 / 3 calls timed");
    checkMetrics(await recordedOverview(responses, value => value.interactionRefs.length === 2),
        { refs: 2, eligible: 3, covered: 2, pass: 1, fail: 1, median: 100, samples: [100, 900] });
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    await expect(page.locator("#periodResult")).toContainText("1 request group with 1 Work IQ tool call");
    await expect(page.locator("#activityInsights")).toContainText("2 / 2 calls timed");
    await selectActivityOption(page, "serviceFilter", "all"); await ready(page);
    await selectActivityOption(page, "projectFilter", "scope-project-b"); await ready(page);
    await expect(page.locator("#periodResult")).toHaveText("5 Copilot chats / 5 request groups with 5 Work IQ tool calls.");
    await expect(page.locator("#activityInsights")).toContainText("4 / 5 calls timed");
    checkMetrics(await recordedOverview(responses, value => value.interactionRefs.length === 5),
        { refs: 5, eligible: 5, covered: 4, pass: 4, fail: 0, median: 7000, samples: [6000, 7000, 8000, 9000] });
    await page.locator("#activitySearch").fill("Synthetic scope chat 9"); await insightsReady(page);
    await expect(page.locator("#periodResult")).toHaveText("1 Copilot chat / 1 request group with 1 Work IQ tool call.");
    await expect(page.locator('#activityInsights [data-dimension="speed"] .assessment-value')).toHaveText("Not measured");
    checkMetrics(await recordedOverview(responses, value => value.interactionRefs.length === 1 && value.metrics.find(metric => metric.definitionId === "tool-duration")?.coverage.covered === 0),
        { refs: 1, eligible: 1, covered: 0, pass: 0, fail: 0, median: null, samples: [] });
    await page.goto(runtime.url + "#activity?from=2026-10-01&to=2026-10-02"); await ready(page); await expectEmpty(page);
    await page.goto(runtime.url + "#activity?session=scope-chat-0"); await ready(page); await expectOne(page, true);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    await expect(page.locator(".assessment-scope")).toContainText("full retained interaction");
    await expect(page.locator("#activityInsights")).toContainText("2 / 2 calls timed");
});

test("WIRE-UX-004: old same-source responses cannot overwrite new query/clear, failures stay unavailable, same-scope focus survives", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await expectAll(page);
    const held = deferred(), release = deferred(), delivered = deferred();
    t.after(() => release.resolve());
    await page.route("**/api/assessment/overview", async route => {
        const response = await route.fetch();
        held.resolve(); await release.promise;
        await route.fulfill({ response }); delivered.resolve();
    });
    await page.locator("#activitySearch").fill("Synthetic scope chat 0");
    await held.promise;
    await expect(page.locator("#activityInsights")).toContainText("Reading recorded insights");
    assert.equal(await page.locator("#activityInsights .assessment-value").count(), 0);
    await page.locator("#clearActivitySearch").click(); await expectAll(page);
    const oldRead = page.waitForResponse(response => response.url().endsWith("/api/assessment/overview"));
    release.resolve(); await delivered.promise;
    await finishRead(page, oldRead);
    await expectAll(page);
    await page.unroute("**/api/assessment/overview");
    const rejected = deferred(), rejectRelease = deferred(), rejectDelivered = deferred();
    t.after(() => rejectRelease.resolve());
    let reads = 0;
    await page.route("**/api/assessment/overview", async route => {
        if (++reads !== 1) return route.continue();
        rejected.resolve(); await rejectRelease.promise;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic obsolete scope failure" }) });
        rejectDelivered.resolve();
    });
    await page.locator("#activitySearch").fill("Synthetic scope chat 2"); await rejected.promise;
    await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE"); await expectEmpty(page);
    const oldFailure = page.waitForResponse(response => response.url().endsWith("/api/assessment/overview"));
    rejectRelease.resolve(); await rejectDelivered.promise;
    await finishRead(page, oldFailure); await expectEmpty(page);
    await page.unroute("**/api/assessment/overview");
    await page.route("**/api/assessment/overview", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic authoritative overview unavailable" }),
    }));
    await page.locator("#activitySearch").fill("Synthetic scope chat 1");
    await expect(page.locator("#activityInsights")).toContainText("Synthetic authoritative overview unavailable");
    assert.equal(await page.locator("#activityInsights .assessment-value").count(), 0);
    await page.unroute("**/api/assessment/overview");
    await page.locator("#activityInsights").getByRole("button", { name: "Read insights again", exact: true }).click();
    await expect(page.locator("#activityInsights")).toContainText("1 / 1 calls timed");
    await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE"); await expectEmpty(page);
    await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await expectOne(page);
    const field = await page.locator("#activitySearch").elementHandle();
    await field.focus(); await field.evaluate(node => node.setSelectionRange(3, 8));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await ready(page); await expectOne(page);
    assert.equal(await field.evaluate(node => node.isConnected && node === document.activeElement && node.selectionStart === 3 && node.selectionEnd === 8), true);
    const definitions = await page.locator("#activityInsights").getByRole("button", { name: "Measure definitions", exact: true }).elementHandle();
    await definitions.focus();
    const refreshRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await finishRead(page, refreshRead); await ready(page);
    assert.equal(await definitions.evaluate(node => node.isConnected && node === document.activeElement), true);
});

test("WIRE-UX-004: a delayed contract import honors the latest query before any overview read", { timeout: 20000 }, async t => {
    const held = deferred(), release = deferred();
    t.after(() => release.resolve());
    const { page, requests } = await setup(t, recordsForScope(), { beforeOpen: async page => {
        await page.route("**/assets/assessment-contract.mjs", async route => {
            held.resolve(); await release.promise; await route.continue();
        });
    } });
    await held.promise;
    await page.locator("#activitySearch").fill("Synthetic scope chat 0");
    await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE");
    release.resolve(); await expectEmpty(page);
    assert.deepEqual(requests.filter(value => value.path.endsWith("/overview")).map(value => value.input.interactionRefs), [[]]);
});

test("WIRE-UX-004: typing while a filtered snapshot is pending cannot publish facts for the previous filter", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await expectAll(page);
    const acceptedSummary = await page.locator("#periodResult").textContent();
    const held = deferred(), release = deferred();
    t.after(() => release.resolve());
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        held.resolve(); await release.promise; await route.fulfill({ response });
    });
    await selectActivityOption(page, "projectFilter", "scope-project-b"); await held.promise;
    await page.locator("#activitySearch").fill("Synthetic scope chat 0");
    await expect(page.locator("#periodResult")).toHaveText(acceptedSummary);
    await expect(page.locator("#periodResult")).toHaveAttribute("aria-busy", "true");
    release.resolve(); await ready(page); await expectEmpty(page);
    await expect(page.locator("#activitySearch")).toHaveValue("Synthetic scope chat 0");
    await page.unroute("**/api/snapshot");
    await (await revealStoredRefresh(page)).click(); await ready(page); await expectEmpty(page);
    const failed = deferred(), failRelease = deferred();
    t.after(() => failRelease.resolve());
    await page.route("**/api/snapshot", async route => {
        failed.resolve(); await failRelease.promise;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic filtered snapshot unavailable" }) });
    });
    await selectActivityOption(page, "projectFilter", "scope-project-a"); await failed.promise;
    await page.locator("#activitySearch").fill("SYNTHETIC_NO_MATCH_SCOPE");
    failRelease.resolve(); await ready(page);
    await expect(page.locator("#message")).toContainText("last recorded snapshot");
    await expect(page.locator("#periodResult")).toContainText("Previous results: 0 Copilot chats / 0 request groups with 0 Work IQ tool calls.");
    await expect(page.locator("#activityInsights")).toContainText("No matching request groups");
    await expect(page.locator("#projectFilter")).toHaveValue("scope-project-b");
    await expect(page.locator("#activitySearch")).toHaveValue("SYNTHETIC_NO_MATCH_SCOPE");
    assert.equal(await page.evaluate(() => history.state.evidenceView.search), "SYNTHETIC_NO_MATCH_SCOPE");
    await page.unroute("**/api/snapshot");
    await page.reload(); await ready(page); await expectEmpty(page);
});

test("WIRE-UX-004: canonical aliases do not double count and unidentifiable rows never broaden empty membership", { timeout: 20000 }, async t => {
    const records = recordsForScope(), duplicate = { ...structuredClone(records[0]), scenarioId: "legacy-scope-alias", isLegacy: true };
    const unidentifiable = fixture("scope-no-identity");
    unidentifiable.sourceSessionName = "Synthetic excluded scope";
    delete unidentifiable.toolCalls[0].toolCallId; delete unidentifiable.toolCalls[0].startEventId;
    const { page, responses } = await setup(t, [...records, duplicate, unidentifiable]);
    await expectAll(page);
    checkMetrics(responses.find(value => value.path === "/api/snapshot").data.assessment.overview, allExpected);
    await page.locator("#activitySearch").fill("Synthetic excluded scope"); await expectEmpty(page);
    await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await expectOne(page);
});

test("WIRE-UX-004: source, permission and deletion basis changes invalidate in-flight scoped facts", { timeout: 45000 }, async t => {
    for (const change of ["source", "consent", "deletion"]) {
        await t.test(change, async t => {
            const { page, context, records, responses } = await setup(t);
            await expectAll(page);
            const held = deferred(), release = deferred(), delivered = deferred();
            t.after(() => release.resolve());
            let calls = 0;
            await page.route("**/api/assessment/overview", async route => {
                const response = await route.fetch();
                if (++calls === 1) { held.resolve(); await release.promise; }
                await route.fulfill({ response }); delivered.resolve();
            });
            await page.locator("#activitySearch").fill("Synthetic scope chat 0"); await held.promise;
            const oldBasis = responses.find(value => value.path === "/api/snapshot").data.assessment.basis;
            if (change === "source") {
                const next = structuredClone(records);
                next[0].toolCalls[0].durationMs = 500;
                next[0].toolCalls[0].completedAt = "2026-09-30T12:00:00.500Z";
                await replaceEvidence(context, () => ({ records: next, importCoverage: { counts: {}, roster: [] } }));
            } else await updateBoardState(context, state => {
                if (change === "consent") {
                    state.personalEvaluation = defaultPersonalEvaluation();
                    state.personalEvaluation.consent.revision = 1;
                } else state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [], operations: {}, pending: null, ...(state.deletion ?? {}), epoch: 1 };
            });
            await (await revealStoredRefresh(page)).click(); await ready(page);
            await expect(page.locator("#activityInsights")).toContainText("2 / 2 calls timed");
            await expect(page.locator('#activityInsights [data-dimension="speed"] .assessment-value').first()).toHaveText(change === "source" ? "500 ms" : "100 ms");
            const newBasis = responses.filter(value => value.path === "/api/snapshot").at(-1).data.assessment.basis;
            assert.notDeepEqual(newBasis, oldBasis);
            const oldRead = page.waitForResponse(response => response.url().endsWith("/api/assessment/overview"));
            release.resolve(); await delivered.promise;
            await finishRead(page, oldRead);
            await expect(page.locator('#activityInsights [data-dimension="speed"] .assessment-value').first()).toHaveText(change === "source" ? "500 ms" : "100 ms");
            await expect(page.locator("#activitySearch")).toHaveValue("Synthetic scope chat 0");
        });
    }
});
