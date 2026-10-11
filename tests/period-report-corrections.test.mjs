import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { privateFixture } from "./helpers.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createReportDraft } from "../web/report-draft.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { promptAuthorship } from "../lib/prompt-authorship.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";

async function fixtureFor(t) {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const app = await privateFixture(t, fixture.records);
    const state = await loadBoardState(app.context);
    return { ...app, state, input: { ...fixture.input, expectedRevision: state.revision } };
}

test("paired Setup copy options revoke disclosure without invalidating the unchanged comparison", { timeout: 30000 }, async t => {
    const { context } = await fixtureFor(t);
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/preview", "/api/privacy-review", "/api/cancel-preview"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze?services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#activitySearch").fill(periodQuery);
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [
        ["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    const compared = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
    await page.locator("#applyPeriodComparison").click();
    const value = await (await compared).json();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.locator("#createPeriodReport").click();
    await page.locator("#reportRecordedContext").check();
    await expect(page.locator("#exportBtn")).toBeEnabled();
    const pair = value.comparison;
    for (const [mode, contextEnabled] of [["masked", true], ["none", false], ["original", true], ["masked", false]]) {
        await page.locator(`[name=promptMode][value=${mode}]`).check();
        if (mode !== "none") await page.locator("#reportRecordedContext").setChecked(contextEnabled);
        await expect(page.locator("#exportBtn")).toBeEnabled();
        const scanned = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#exportBtn").click();
        const preview = await (await scanned).json();
        assert.equal(preview.error, undefined, preview.error);
        assert.deepEqual(preview.snapshot.periodComparison.comparison, pair);
        assert.equal(Boolean(preview.snapshot.recordedContext), contextEnabled);
        assert.equal(preview.privacy.reviewerConfirmed, false);
        await page.locator("input[data-review-control]").check();
        await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        await page.getByRole("button", { name: "Back to review", exact: true }).click();
        await page.getByRole("button", { name: "Back to setup", exact: true }).click();
    }
    await page.locator("#reportRecordedContext").check();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "draft");
    await expect(page.locator("#exportBtn")).toBeEnabled();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
});

for (const boundary of ["preview completion", "review", "save"]) test(`changed broader API parent evidence rejects ${boundary} without changing matching cohorts`, async t => {
    const { context, state, input } = await fixtureFor(t);
    input.options = { ...input.options, layer: "reported-api", filters: { ...input.options.filters, outcomes: ["failure"] } };
    const value = buildPeriodComparison(state, input);
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const controller = createExportController(context, undefined, async () => {
        started(); await gate; return Buffer.from("%PDF-invented-held-render");
    });
    assert.deepEqual(value.periods.baseline.scenarioIds, ["period-request-0"]);
    assert.deepEqual(value.periods.later.scenarioIds, ["period-request-2"]);
    assert.equal(value.periods.baseline.analytics.apiCoverage.returnedResultUnits, 3);
    const preparing = controller.preview("owner", undefined, {
        formats: boundary === "preview completion" ? ["json", "pdf"] : ["json"], timeContext: value.timeContext,
    }, undefined, value);
    let preview;
    if (boundary === "preview completion") await waiting;
    else {
        preview = await preparing;
        if (boundary === "save") await controller.review("owner", preview.previewId, true, value.timeContext);
    }
    const records = structuredClone(state.evidence);
    const parent = records.find(record => record.scenarioId === "period-request-1").toolCalls[0];
    if (boundary === "review") parent.apiResults[0].statusCode = 201;
    else parent.apiResults = [];
    await replaceEvidence(context, () => ({ records }));
    const current = await loadBoardState(context);
    const after = buildPeriodComparison(current, { ...input, expectedRevision: current.revision });
    assert.equal(after.periods.baseline.analytics.apiCoverage.returnedResultUnits, boundary === "review" ? 3 : 2);
    for (const side of ["baseline", "later"]) assert.deepEqual(after.periods[side].rowIds, value.periods[side].rowIds);
    release();
    await assert.rejects(boundary === "preview completion" ? preparing : boundary === "review"
        ? controller.review("owner", preview.previewId, true, value.timeContext)
        : controller.confirm("owner", preview.previewId, true, value.timeContext), /API parent.*changed/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
});

test("unchanged broader API parent coverage survives an unrelated accepted update", async t => {
    const { context, state, input } = await fixtureFor(t);
    input.options = { ...input.options, layer: "reported-api", filters: { ...input.options.filters, outcomes: ["failure"] } };
    const value = buildPeriodComparison(state, input), controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, { formats: ["json"], timeContext: value.timeContext }, undefined, value);
    await controller.review("owner", preview.previewId, true, value.timeContext);
    const unrelated = structuredClone(state.evidence.at(-1));
    unrelated.scenarioId = "unrelated-parent-scope"; unrelated.sourceSessionId = "unrelated-parent-chat";
    unrelated.toolCalls[0].toolCallId = "unrelated-parent-call"; unrelated.toolCalls[0].startEventId = "unrelated-parent-start";
    await replaceEvidence(context, () => ({ records: [...state.evidence, unrelated] }));
    const saved = await controller.confirm("owner", preview.previewId, true, value.timeContext);
    assert.equal(saved.state.exports.length, 1);
    assert.equal(preview.snapshot.periodComparison.periods.baseline.apiCoverage.returnedResultUnits, 3);
    assert.equal(preview.snapshot.periodComparison.periods.baseline.rows.length, 1);
    assert.equal(preview.records.length, 2);
});

test("paired authority remains independent of context choices but still invalidates on selected-source and permission changes", async t => {
    const { state } = await fixtureFor(t), draft = createReportDraft();
    const scope = createReportScope(promptAuthorship).resolve(buildExportCatalog(state.evidence), "selected", [], ["period-request-0"]);
    const snapshot = { boardId: state.boardId, revision: state.revision, scenarios: state.evidence,
        assessment: { source: { available: true }, basis: { consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 }, catalog: [] } };
    assert.equal(draft.synchronizeBasis(snapshot, scope, { paired: true }), false);
    draft.change({ recordedContext: true });
    const token = draft.token();
    assert.equal(draft.synchronizeBasis(snapshot, scope, { paired: true }), false);
    assert.equal(draft.current(token), false, "copy basis still revokes disclosure");
    snapshot.assessment.basis.consentRevision++;
    assert.equal(draft.synchronizeBasis(snapshot, scope, { paired: true }), true);
    snapshot.scenarios[0].userPrompt.text += "changed selected source";
    assert.equal(draft.synchronizeBasis(snapshot, scope, { paired: true }), true);
});
