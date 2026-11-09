import test from "node:test";
import assert from "node:assert/strict";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { privateFixture } from "./helpers.mjs";
import { executeAction } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";

test("two unequal periods retain exact canonical cohorts from one revision", () => {
    const { state } = qualityDisplayFixture({ requests: 3, calls: 3, timed: 2, finalDuration: null });
    state.evidence[0].toolCalls[0].startedAt = "2026-09-30T12:00:00.000Z";
    const input = {
        schemaVersion: 1, expectedRevision: state.revision,
        options: { layer: "tool", bucket: "day", filters: { scope: "history" }, timeContext: { timeZone: "UTC", locale: "en-US" } },
        periods: { baseline: { from: "2026-09-30", to: "2026-09-30" }, later: { from: "2026-10-01", to: "2026-10-03" } },
        scenarioIds: state.evidence.map(record => record.scenarioId), withinServices: [],
    };
    const value = buildPeriodComparison(state, input);
    assert.equal(value.kind, "retained-period-comparison");
    assert.equal(value.revision, state.revision);
    assert.deepEqual(value.periods.baseline.rowIds, ['call:["test-session","quality-call-0"]']);
    assert.deepEqual(value.periods.later.rowIds, ['call:["test-session","quality-call-1"]', 'call:["test-session","quality-call-2"]']);
    assert.equal(value.periods.baseline.analytics.totals.count, 1);
    assert.equal(value.periods.later.analytics.totals.count, 2);
    assert.equal(value.comparison.outcomes.change.failure, -100);
    assert.equal(value.periods.later.analytics.totals.duration.sampleCount, 1);
    assert.equal(value.periods.later.assessment.interactionRefs.length, 2);
});

test("DST local boundaries, overlapping services and full-interaction timing have separate exact populations", () => {
    const { state, input } = periodFixture(), before = structuredClone(state);
    const value = buildPeriodComparison(state, input), a = value.periods.baseline, b = value.periods.later;
    assert.deepEqual(a.rowIds, ['call:["period-chat-0","period-call-0"]', 'call:["period-chat-0","period-missing"]', 'call:["period-chat-1","period-call-1"]']);
    assert.deepEqual(b.scenarioIds, ["period-request-2", "period-request-3", "period-request-4", "period-request-5"]);
    assert.equal((Date.parse(b.dateRange.to) - Date.parse(b.dateRange.from)) / 3600000, 47);
    assert.equal(a.analytics.serviceInvolvement.selection.contextOnlyIds.length, 1);
    assert.equal(a.analytics.serviceInvolvement.groups.find(group => group.label === "Files").total, 2);
    assert.equal(a.analytics.serviceInvolvement.groups.find(group => group.label === "Mail").total, 1);
    assert.deepEqual(a.analytics.totals.duration, { sampleCount: 2, p50Ms: 0, p95Ms: 1000, method: "nearest-rank; available samples only" });
    assert.deepEqual(b.analytics.totals.duration, { sampleCount: 2, p50Ms: 3000, p95Ms: 5000, method: "nearest-rank; available samples only" });
    const toolMetric = a.assessment.metrics.find(metric => metric.definitionId === "tool-duration");
    assert.equal(toolMetric.coverage.eligible, 4); // Calendar sibling remains full-interaction context.
    assert.equal(toolMetric.coverage.covered, 3);
    assert.equal(toolMetric.value, 100);
    assert.ok(value.comparison.metrics.length > 0);
    assert.ok(value.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    assert.equal(value.comparison.matchingCallTiming.median.delta.value, 3000);
    assert.equal(a.assessment.metrics.find(metric => metric.definitionId === "recorded-response-duration").samples[0].value, 8000);
    assert.deepEqual(state, before);
    assert.equal(Object.hasOwn(value, "bundleId"), false);
    assert.equal(Object.hasOwn(value, "manifest"), false);
});

test("named services refine the OR selection with AND, author choices intersect, and explicit empty stays empty", () => {
    const { state, input } = periodFixture();
    const both = buildPeriodComparison(state, { ...input, withinServices: ["Files", "Mail"] });
    assert.deepEqual(both.periods.baseline.rowIds, ['call:["period-chat-0","period-call-0"]']);
    assert.deepEqual(both.periods.later.rowIds, []);
    assert.equal(both.periods.baseline.assessment.metrics.find(metric => metric.definitionId === "tool-duration").coverage.eligible, 3);
    assert.equal(both.comparison.outcomes.change.success, null);
    const authors = buildPeriodComparison(state, { ...input, options: { ...input.options, filters: { ...input.options.filters, promptAuthors: ["agent"] } } });
    assert.deepEqual(authors.periods.baseline.scenarioIds, ["period-request-1"]);
    assert.deepEqual(authors.periods.later.scenarioIds, ["period-request-3", "period-request-5"]);
    const empty = buildPeriodComparison(state, { ...input, scenarioIds: [] });
    for (const side of Object.values(empty.periods)) {
        assert.deepEqual(side.rowIds, []); assert.deepEqual(side.assessment.metrics, []);
        assert.deepEqual(side.interactionCoverage, []); assert.equal(side.analytics.totals.successRate.percent, null);
        assert.equal(side.analytics.totals.duration.p50Ms, null);
    }
    assert.equal(empty.comparison.matchingCallTiming.median.delta, null);
});

test("overlapping periods count each identity once per side, without changing full-interaction membership", () => {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, { ...input, periods: { baseline: input.periods.baseline, later: input.periods.baseline } });
    assert.equal(value.comparison.outcomes.overlap.sharedCount, 3);
    assert.equal(value.comparison.outcomes.change.failure, 0);
    assert.deepEqual(value.periods.baseline.interactionRefs, value.periods.later.interactionRefs);
    assert.deepEqual(value.periods.baseline.rowIds, value.periods.later.rowIds);
});

test("a single measured zero is not missing, and response timing stays a different population", () => {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, { ...input, scenarioIds: ["period-request-0", "period-request-3"], withinServices: ["Files"] });
    assert.equal(value.periods.baseline.analytics.totals.duration.sampleCount, 1);
    assert.equal(value.periods.baseline.analytics.totals.duration.p50Ms, 0);
    assert.equal(value.periods.later.analytics.totals.duration.sampleCount, 0);
    assert.equal(value.periods.later.analytics.totals.duration.p50Ms, null);
    assert.equal(value.comparison.matchingCallTiming.median.delta, null);
    const response = value.periods.baseline.assessment.metrics.find(metric => metric.definitionId === "recorded-response-duration");
    assert.equal(response.coverage.eligible, 1); assert.equal(response.value, 8000);
});

test("returned-result refinements preserve exact all-page rows and broader pre-outcome parent coverage", () => {
    const { state, input } = periodFixture();
    const value = buildPeriodComparison(state, { ...input, withinServices: ["Files"],
        options: { ...input.options, layer: "reported-api", filters: { ...input.options.filters, outcomes: ["failure"] } } });
    assert.equal(value.periods.baseline.rowIds.length, 1);
    assert.equal(value.periods.baseline.analytics.apiCoverage.eligibleToolCalls, 2);
    assert.equal(value.periods.later.rowIds.length, 1);
    assert.equal(value.periods.later.analytics.apiCoverage.eligibleToolCalls, 4);
    assert.equal(value.comparison.matchingCallTiming, null);
    assert.equal(value.definitions.layer, "reported-api");
});

test("historical evaluator and rubric lanes cannot become current comparison facts", () => {
    const { state, input } = periodFixture();
    assert.ok(state.personalEvaluation.modelEvaluation.records.length > 0);
    for (const assessment of state.personalEvaluation.modelEvaluation.records[0].assessments) assessment.evaluator.model = "invented-earlier-model";
    const model = buildAssessmentModel(state);
    const value = buildPeriodComparison(state, input, { model });
    const quality = value.comparison.metrics.filter(item => (item.baseline ?? item.later).basis === "model-assessment");
    assert.equal(quality.length, 0);
    assert.ok(value.comparison.metrics.every(item => (item.baseline ?? item.later).basis === "observed"));
    assert.equal(value.periods.baseline.assessment.metrics.filter(metric => metric.origin === "model-assessed").length, 0);
    assert.equal(value.periods.later.assessment.metrics.filter(metric => metric.origin === "model-assessed").length, 0);
});

test("all retained matching calls survive presentation limits and unequal scopes", () => {
    const { state } = qualityDisplayFixture({ requests: 12, calls: 25, timed: 25, finalDuration: null });
    state.evidence.forEach((record, index) => record.toolCalls.forEach(call => { call.startedAt = index % 2 ? "2026-10-02T12:00:00.000Z" : "2026-10-01T12:00:00.000Z"; }));
    const { input } = periodFixture();
    const value = buildPeriodComparison(state, { ...input, scenarioIds: state.evidence.map(record => record.scenarioId),
        options: { ...input.options, limit: 1, filters: { scope: "history" } },
        periods: { baseline: { from: "2026-10-01", to: "2026-10-01" }, later: { from: "2026-10-02", to: "2026-10-03" } } });
    assert.equal(value.periods.baseline.rowIds.length, 13);
    assert.equal(value.periods.later.rowIds.length, 12);
    assert.equal(value.periods.baseline.assessment.metrics.find(metric => metric.definitionId === "tool-duration").samples.length, 13);
});

test("invalid ranges, scope, stale revision and unknown IDs fail explicitly without fallback", () => {
    const { state, input } = periodFixture();
    for (const changed of [
        { expectedRevision: 99 }, { scenarioIds: ["not-retained"] }, { scenarioIds: [input.scenarioIds[0], input.scenarioIds[0]] },
        { withinServices: ["invented-service"] }, { query: "must-not-be-sent" },
        { options: { ...input.options, filters: { ...input.options.filters, from: "2026-03-07" } } },
        { periods: { ...input.periods, baseline: { from: "2026-03-08", to: "2026-03-07" } } },
        { periods: { ...input.periods, baseline: { from: "2026-02-30", to: "2026-03-07" } } },
    ]) assert.throws(() => buildPeriodComparison(state, { ...input, ...changed }));
    const missing = { ...input }; delete missing.scenarioIds;
    assert.throws(() => buildPeriodComparison(state, missing));
});

test("read-only action uses the captured stored revision and does not mutate invented storage", async t => {
    const { records, input } = periodFixture(), { context } = await privateFixture(t, records);
    const before = await loadBoardState(context);
    const value = await executeAction(context, {}, "invented-owner", "get_period_comparison", { ...input, expectedRevision: before.revision });
    assert.equal(value.revision, before.revision);
    assert.equal(value.periods.baseline.rowIds.length, 3);
    assert.deepEqual(await loadBoardState(context), before);
    await assert.rejects(executeAction(context, {}, "invented-owner", "get_period_comparison", { ...input, expectedRevision: before.revision + 1 }), /revision changed/);
});
