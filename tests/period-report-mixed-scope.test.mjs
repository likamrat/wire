import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { privateFixture, restoreLegacySearch, selectActivityOption } from "./helpers.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { assessmentSource, buildAssessmentModel, buildReportFacts, cachedAssessmentModel } from "../lib/assessment-read-model.mjs";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";
import { executeAction, startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportFile } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { reportContextRef } from "../lib/report-context.mjs";

const preparedAt = "2026-10-12T02:00:00.000Z";
const reportMetric = metric => ({ ...metric, observedTime: { ...metric.observedTime,
    state: metric.observedTime.state === "available" ? "withheld" : metric.observedTime.state, firstAt: null, lastAt: null } });

function assertFrozenPair(frozen, live, pseudonymKey) {
    assert.deepEqual(frozen.comparison, live.comparison);
    for (const key of ["baseline", "later"]) {
        const side = frozen.periods[key], original = live.periods[key];
        assert.equal(side.rows.length, original.rowIds.length);
        assert.deepEqual(side.totals, original.analytics.totals);
        if (pseudonymKey) {
            assert.deepEqual(side.rows.map(row => row.id), original.rowIds.map(id => reportContextRef(pseudonymKey, "row", id)));
            assert.deepEqual(side.scenarioRefs, original.scenarioIds.map(id => reportContextRef(pseudonymKey, "scenario", id)));
        }
        assert.deepEqual(side.facts.memberships.map(item => item.interactionRef), original.interactionRefs);
        assert.deepEqual(side.facts.metrics, original.assessment.metrics.map(reportMetric));
        assert.equal(side.facts.metricProjectionVersion, 4);
        assert.deepEqual(side.facts.assessments, []);
        assert.equal(Object.hasOwn(side.facts, "reviewStatuses"), false);
        assert.equal(Object.hasOwn(side.facts, "assessmentAttempts"), false);
        assert.deepEqual(side.interactionCoverage, original.interactionCoverage);
    }
}

test("F12 mixed current/legacy comparison freezes exact accepted order without retired rating lanes", () => {
    const { state, input } = periodFixture();
    input.options.filters.scope = "all";
    assert.doesNotThrow(() => validateAnalyticsInput(input.options));
    const live = buildPeriodComparison(state, input);
    assert.deepEqual([live.periods.baseline.rowIds.length, live.periods.later.rowIds.length], [4, 4]);
    assert.ok(live.periods.baseline.scenarioIds.includes("period-request-8"));
    assert.ok(live.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    const accepted = acceptPeriodReport(state, live);
    const order = live.periods.baseline.interactionRefs;
    const records = order.map(ref => accepted.model.internals.get(ref).record);
    assert.deepEqual(records.map(record => record.scenarioId), ["period-request-0", "period-request-8", "period-request-1"]);
    const frozen = freezePeriodReport(state, accepted, preparedAt).frozen;
    assertFrozenPair(frozen, live, state.pseudonymKey);
    const ordinary = buildReportFacts(records, state, { preparedAt, source: accepted.model.source });
    assert.deepEqual(ordinary, buildReportFacts(records, state, { preparedAt, source: accepted.model.source, interactionOrder: undefined }));
    assert.notDeepEqual(ordinary.facts.memberships.map(item => item.interactionRef), order,
        "ordinary canonicalization retains current-before-legacy precedence");
    const cached = cachedAssessmentModel(state, accepted.model.source), cachedBefore = structuredClone(cached.overview);
    const acceptedBefore = structuredClone(accepted.value), orderBefore = [...order];
    const ordered = buildReportFacts(records, state, { preparedAt, source: accepted.model.source, interactionOrder: order });
    assert.deepEqual(ordered.facts.metrics.map(metric => ({ ...metric, createdAt: preparedAt })),
        live.periods.baseline.assessment.metrics.map(metric => ({ ...reportMetric(metric), createdAt: preparedAt })));
    assert.ok(ordered.facts.metrics.every(metric => metric.createdAt === preparedAt));
    assert.deepEqual(order, orderBefore);
    assert.deepEqual(accepted.value, acceptedBefore);
    assert.deepEqual(cached.overview, cachedBefore);
    assert.deepEqual(buildReportFacts(records, state, { preparedAt, source: accepted.model.source }), ordinary,
        "an ordered call cannot change the next omitted-order call");
    for (const interactionOrder of [order.slice(1), [...order, order[0]], [...order.slice(0, -1), "unknown"],
        Object.assign(new Array(order.length), { 0: order[0], 1: order[1] }), null, "invalid"]) {
        assert.throws(() => buildReportFacts(records, state, { preparedAt, interactionOrder }),
            error => error.code === "invalid-report-interaction-order");
    }
    assert.throws(() => buildReportFacts(records, state, { preparedAt, interactionOrder: [] }),
        error => error.code === "invalid-report-interaction-order");
    assert.deepEqual(buildReportFacts([], state, { preparedAt, interactionOrder: [] }), buildReportFacts([], state, { preparedAt }));
    assert.throws(() => buildReportFacts([], state, { preparedAt, interactionOrder: [order[0]] }),
        error => error.code === "invalid-report-interaction-order");
    for (const scope of ["history", "legacy"]) {
        const control = buildPeriodComparison(state, { ...input, options: { ...input.options, filters: { ...input.options.filters, scope } } });
        assertFrozenPair(freezePeriodReport(state, acceptPeriodReport(state, control), preparedAt).frozen, control, state.pseudonymKey);
    }
    const tampered = structuredClone(live);
    tampered.periods.baseline.assessment.metrics[0].eligibleUnitRefs.reverse();
    assert.throws(() => acceptPeriodReport(state, tampered), /differs from the accepted/);
});

test("F12 ordered report assembly keeps current-before-legacy deduplication intact", () => {
    const { state } = periodFixture();
    const current = structuredClone(state.evidence[0]), legacy = structuredClone(current);
    legacy.scenarioId = "legacy-duplicate"; legacy.isLegacy = true;
    for (const call of legacy.toolCalls) {
        call.toolSucceeded = true; call.reportedOutcome = "succeeded"; call.durationMs = 99000;
    }
    state.evidence = [legacy, current];
    const model = buildAssessmentModel(state, { createdAt: preparedAt }), order = [...model.details.keys()];
    assert.equal(order.length, 1);
    const ordered = buildReportFacts([legacy, current], state, { preparedAt, interactionOrder: order });
    const currentOnly = buildReportFacts([current], state, { preparedAt, interactionOrder: order });
    assert.deepEqual(ordered.facts.metrics, currentOnly.facts.metrics);
    assert.deepEqual(ordered.facts.recordedOutcomes, currentOnly.facts.recordedOutcomes);
    assert.deepEqual(ordered.facts.memberships, currentOnly.facts.memberships);
    assert.ok(ordered.facts.recordedOutcomes.some(outcome => outcome.outcome === "failure"));
    assert.equal(ordered.facts.metrics.some(metric => metric.samples.some(sample => sample.value === 99000)), false);
});

async function storeFixture(t, { collectorSource = false } = {}) {
    const fixture = periodFixture();
    // The original arithmetic fixture's out-of-slice calendar fetch uses the
    // wrong argument key; keep its call, and give it the documented fetch shape.
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const assessed = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"], finalDuration: null }).state;
    const app = await privateFixture(t, fixture.records);
    let config;
    if (collectorSource) {
        config = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 5,
            sourceAdapter: "copilot-app-sqlite-v156", appDbPath: path.join(app.context.dataDir, "invented-only.db"),
            sessionRoot: path.join(app.context.dataDir, "invented-only-events") };
        await mkdir(path.join(app.context.dataDir, "collector"), { recursive: true });
        await writeFile(path.join(app.context.dataDir, "collector", "config.json"), JSON.stringify(config));
    }
    await updateBoardState(app.context, state => {
        state.pseudonymKey = assessed.pseudonymKey;
        state.personalEvaluation = assessed.personalEvaluation;
        if (config) {
            const source = assessmentSource(state, config);
            state.personalEvaluation.source = source;
            for (const grant of state.personalEvaluation.modelEvaluation.grants) {
                grant.sourceConfigRef = source.sourceConfigRef; grant.sourceConfigRevision = source.sourceConfigRevision;
            }
        }
    });
    const state = await loadBoardState(app.context);
    return { ...app, state, input: { ...fixture.input, expectedRevision: state.revision,
        options: { ...fixture.input.options, filters: { ...fixture.input.options.filters, scope: "all" } } } };
}

test("F12 production actions admit A4/B4 preview, then preserve disclosure/save guards", async t => {
    const { context, input, state } = await storeFixture(t), exports = createExportController(context);
    const live = await executeAction(context, exports, "owner", "get_period_comparison", input);
    assert.deepEqual([live.periods.baseline.rowIds.length, live.periods.later.rowIds.length], [4, 4]);
    const preview = await executeAction(context, exports, "owner", "preview_export", {
        periodComparison: live, options: { formats: ["json"], timeContext: live.timeContext },
    });
    assertFrozenPair(preview.snapshot.periodComparison, live, state.pseudonymKey);
    await assert.rejects(exports.confirm("owner", preview.previewId, true, live.timeContext), /disclosure/);
    await exports.review("owner", preview.previewId, true, live.timeContext);
    const saved = await exports.confirm("owner", preview.previewId, true, live.timeContext);
    assert.equal(saved.state.exports.length, 1);
    const read = await readSavedReportFile(context, saved.state, saved.bundle.bundleId, "json");
    assert.deepEqual(read.snapshot.periodComparison, preview.snapshot.periodComparison);
    const next = await loadBoardState(context);
    const current = await executeAction(context, exports, "owner", "get_period_comparison", { ...input, expectedRevision: next.revision });
    const pending = await executeAction(context, exports, "owner", "preview_export", {
        periodComparison: current, options: { formats: ["json"], timeContext: current.timeContext },
    });
    await exports.review("owner", pending.previewId, true, current.timeContext);
    await updateBoardState(context, state => { state.personalEvaluation.consent.revision++; });
    await assert.rejects(exports.confirm("owner", pending.previewId, true, current.timeContext), /Assessment evidence changed/);
    assert.equal((await loadBoardState(context)).exports.length, 1);
});

test("F12 public Both collections UI keeps A4/B4 through four-format review save and frozen reopen", { timeout: 60000 }, async t => {
    const { context, state: initial } = await storeFixture(t, { collectorSource: true });
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, timezoneId: "America/New_York" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/preview", "/api/privacy-review",
            "/api/export", "/api/cancel-preview", "/api/report/open"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze?services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, periodQuery);
    await selectActivityOption(page, "scopeFilter", "all");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#comparePeriods").click();
    for (const [label, date] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) await page.getByLabel(label, { exact: true }).fill(date);
    const compared = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
    await page.locator("#applyPeriodComparison").click();
    const live = await (await compared).json();
    assert.equal(live.options.filters.scope, "all");
    assert.deepEqual([live.periods.baseline.rowIds.length, live.periods.later.rowIds.length], [4, 4]);
    assert.ok(live.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (4)");
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (4)");
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.locator("#createPeriodReport").click();
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    for (const format of ["json", "markdown", "pdf"]) await page.locator(`#formatOptions input[value=${format}]`).check();
    const scanned = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await scanned).json();
    assert.equal(preview.error, undefined, preview.error);
    assertFrozenPair(preview.snapshot.periodComparison, live, initial.pseudonymKey);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const saved = await (await savedResponse).json();
    assert.equal(saved.error, undefined, saved.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context), bundle = state.exports[0];
    assert.equal(state.exports.length, 1);
    const extracted = {};
    for (const format of ["html", "pdf", "json", "markdown"]) {
        const document = await readSavedReportFile(context, state, bundle.bundleId, format);
        extracted[format] = (await extractReportFile(document)).content;
        assert.match(extracted[format], /Period A/);
        assert.match(extracted[format], /Period B/);
        assert.doesNotMatch(extracted[format], /synthetic-quality-fixture|Personal feedback|assessment coverage|full-interaction findings/i);
        if (format === "json") assertFrozenPair(document.snapshot.periodComparison, live, initial.pseudonymKey);
    }
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    await expect(page.frameLocator("#savedReportReader iframe").locator("#numbers")).toContainText("4");
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    if (process.env.WIRE_PERIOD_F12_PROOFS) {
        await mkdir(process.env.WIRE_PERIOD_F12_PROOFS, { recursive: true });
        for (const [name, file] of Object.entries(bundle.files)) await writeFile(path.join(process.env.WIRE_PERIOD_F12_PROOFS, name), await readFile(file));
        await writeFile(path.join(process.env.WIRE_PERIOD_F12_PROOFS, "proof.json"), JSON.stringify({
            comparison: live.comparison, orderedInteractions: Object.fromEntries(Object.entries(live.periods).map(([key, side]) => [key, side.interactionRefs])),
            frozen: preview.snapshot.periodComparison, extracted, errors, denied,
        }, null, 2));
    }
});
