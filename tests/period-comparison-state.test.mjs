import test from "node:test";
import assert from "node:assert/strict";
import { createPeriodComparisonState } from "../web/period-comparison.mjs";
import * as resultContract from "../lib/report-result-contract.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { time } from "../lib/time.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { comparePeriodCohorts } from "../lib/period-comparison-math.mjs";
import { nativeConsumerFixture } from "./native-consumer-fixture.mjs";
import { fixture } from "./helpers.mjs";

test("actual mixed-source snapshot accepts only its qualified dated-side unit transition", async t => {
    const app = await nativeConsumerFixture(t, { records: [fixture("comparison-unit-transition")] });
    const api = await app.start();
    const options = { layer: "tool", groupBy: "workload", bucket: "day", filters: { scope: "history" },
        timeContext: time.normalize({ timeZone: "UTC", locale: "en-US" }) };
    const snapshot = (await api("/api/snapshot", options)).body;
    const machine = createPeriodComparisonState({ time, search: createLocalSearch(), contract, resultContract,
        projection: createActivityProjection(time, serviceCategories, OUTCOMES), categories: serviceCategories, comparePeriodCohorts });
    const input = machine.prepare(snapshot, options, {
        baseline: { from: "2026-09-28", to: "2026-10-01" }, later: { from: "2026-10-02", to: "2026-10-03" },
    });
    const response = await api("/api/period-comparison", input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(snapshot.analytics.unit, "source-qualified tool calls");
    assert.equal(response.body.definitions.unit, "Work IQ tool calls");
    assert.deepEqual(Object.values(response.body.periods).map(side => side.rowIds.length), [1, 0]);
    assert.equal(machine.accept(machine.begin(input, snapshot), response.body), true);
    for (const change of [
        value => { value.periods.later.analytics.unit = "source-qualified tool calls"; },
        value => { value.periods.later.analytics.measurementEligibility.nativeActivityDates = "verified"; },
        value => {
            value.definitions.unit = "invented unit";
            for (const side of Object.values(value.periods)) side.analytics.unit = "invented unit";
        },
    ]) {
        const value = structuredClone(response.body); change(value);
        assert.throws(() => machine.accept(machine.begin(input, snapshot), value), /Comparison facts/);
        assert.equal(machine.consumer(), null);
    }
});

export function comparisonStateFixture() {
    const { state, input } = periodFixture();
    const response = buildPeriodComparison(state, input);
    const snapshot = { revision: state.revision, scenarios: state.evidence, sessions: [], analytics: response.periods.baseline.analytics,
        assessment: { basis: response.assessmentBasis, source: response.source, catalog: buildAssessmentModel(state).catalog } };
    const machine = createPeriodComparisonState({ time, search: createLocalSearch(), contract, resultContract,
        projection: createActivityProjection(time, serviceCategories, OUTCOMES), categories: serviceCategories, comparePeriodCohorts });
    return { state, input, response, snapshot, machine };
}

test("private-query membership comes from the whole accepted roster, not the dated rows or page", () => {
    const { input, snapshot, machine } = comparisonStateFixture();
    snapshot.analytics = { ...snapshot.analytics, rows: [{ scenarioId: "period-request-0" }] };
    const request = machine.prepare(snapshot, { ...input.options, filters: { ...input.options.filters, from: "2026-03-07", to: "2026-03-07" } },
        input.periods, periodQuery, []);
    assert.deepEqual(request.scenarioIds, input.scenarioIds.slice().sort());
    assert.equal(request.scenarioIds.includes("period-request-5"), true);
    assert.equal(request.options.filters.from, undefined);
    assert.equal(request.options.filters.to, undefined);
    assert.doesNotMatch(JSON.stringify(request), new RegExp(periodQuery));
});

test("accepted scope names and private-narrowing presence belong to the same frozen pair", () => {
    const { state, input, snapshot, machine, response: unfiltered } = comparisonStateFixture();
    const endpoint = unfiltered.periods.baseline.analytics.rows[0].endpoint;
    input.options.filters.projectIds = ["selected-project"];
    input.options.filters.sourceSessionIds = ["period-chat-0"];
    input.options.filters.endpoints = [endpoint.id];
    snapshot.scenarios[0].projectId = "selected-project";
    snapshot.scenarios[0].project = "Accepted project";
    snapshot.sessions = [{ sessionId: "period-chat-0", name: "Accepted chat" }, { sessionId: "outside", name: "Unselected chat" }];
    const response = buildPeriodComparison(state, input);
    const token = machine.begin(input, snapshot, undefined, true);
    assert.equal(machine.scope(), null);
    snapshot.scenarios[0].project = "Newer project";
    snapshot.sessions[0].name = "Newer chat";
    assert.equal(machine.accept(token, response), true);
    assert.deepEqual(machine.consumer(), response, "Presentation metadata must not change the canonical report input");
    assert.deepEqual(machine.scope(), {
        hasSearch: true, projects: [{ id: "selected-project", name: "Accepted project" }],
        sessions: [{ id: "period-chat-0", name: "Accepted chat" }], endpoints: [{ id: endpoint.id, name: endpoint.label }],
    });
    machine.scope().projects[0].name = "Changed detached result";
    assert.equal(machine.scope().projects[0].name, "Accepted project");
    assert.doesNotMatch(JSON.stringify(machine.scope()), /Newer|Unselected|INVENTED_PERIOD_NEEDLE/);
    const newer = machine.begin(input, snapshot);
    assert.equal(machine.scope(), null);
    assert.equal(machine.accept(token, response), false);
    assert.equal(machine.scope(), null);
    assert.equal(machine.accept(newer, response), true);
    assert.equal(machine.scope().hasSearch, false);
    machine.leave();
    assert.equal(machine.scope(), null);
});

test("invalid scope metadata cannot leave a newly requested description beside an accepted pair", () => {
    const { input, response, snapshot, machine } = comparisonStateFixture();
    machine.accept(machine.begin(input, snapshot), response);
    assert.throws(() => machine.begin(input, snapshot, undefined, "PRIVATE_QUERY_MUST_NOT_BECOME_SCOPE_TEXT"), /Comparison/);
    assert.equal(machine.consumer(), null);
    assert.equal(machine.scope(), null);
});

test("scope keeps an applied private phrase even when it matches the complete retained roster", () => {
    const { state, input, snapshot, machine } = comparisonStateFixture();
    const request = machine.prepare(snapshot, input.options, input.periods, "request");
    assert.equal(request.scenarioIds.length, snapshot.scenarios.length);
    machine.accept(machine.begin(request, snapshot, undefined, true), buildPeriodComparison(state, request));
    assert.equal(machine.scope().hasSearch, true);
    assert.doesNotMatch(JSON.stringify(machine.scope()), /request/);
});

test("scope rejects conflicting accepted endpoint labels instead of choosing one period", () => {
    const { state, input, snapshot, machine, response: unfiltered } = comparisonStateFixture();
    input.options.filters.endpoints = [unfiltered.periods.baseline.analytics.rows[0].endpoint.id];
    const response = buildPeriodComparison(state, input);
    response.periods.later.analytics.filterOptions.endpoints = response.periods.later.analytics.filterOptions.endpoints.map(entry =>
        entry.id === input.options.filters.endpoints[0] ? { ...entry, label: "Different period label" } : entry);
    const token = machine.begin(input, snapshot);
    assert.throws(() => machine.accept(token, response), /Comparison/);
    assert.equal(machine.consumer(), null);
    assert.equal(machine.scope(), null);
});

test("same-count different memberships and late reads cannot replace the current comparison", () => {
    const { state, input, response, snapshot, machine } = comparisonStateFixture();
    const first = machine.begin(input, snapshot);
    const other = { ...input, scenarioIds: [...input.scenarioIds.filter(id => id !== "period-request-0"), "period-request-9"] };
    const second = machine.begin(other, snapshot);
    assert.notEqual(first, second);
    assert.equal(machine.accept(first, response), false);
    const current = buildPeriodComparison(state, other);
    assert.equal(machine.accept(second, current), true);
    assert.deepEqual(machine.consumer().periods.baseline.rowIds, current.periods.baseline.rowIds);
    machine.leave();
    assert.equal(machine.consumer(), null);
    assert.equal(machine.accept(second, current), false);
});

test("revision, permissions, definitions, exact membership and per-check coverage fail closed", () => {
    const { input, response, snapshot, machine } = comparisonStateFixture();
    const changes = [
        value => value.revision++,
        value => value.assessmentBasis.consentRevision++,
        value => { value.source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 }; },
        value => { value.timeContext.timeZone = "UTC"; },
        value => value.definitions.serviceInvolvement.version++,
        value => value.periods.baseline.rowIds.pop(),
        value => value.periods.baseline.analytics.totals.count++,
        value => { value.periods.baseline.analytics.rows[0].scenarioId = "not-selected"; },
        value => value.periods.baseline.interactionCoverage[0].eligibleUnitRefs.pop(),
        value => { value.periods.baseline.interactionRefs = value.periods.later.interactionRefs; value.periods.baseline.assessment = value.periods.later.assessment; },
        value => { value.periods.baseline.reviewStatusRevisions[0].revision = "0".repeat(64); },
    ];
    for (const change of changes) {
        const token = machine.begin(input, snapshot), altered = structuredClone(response);
        change(altered);
        assert.throws(() => machine.accept(token, altered), /comparison|Comparison|coverage|membership|Metric/i);
        assert.equal(machine.consumer(), null);
    }
    const token = machine.begin(input, snapshot);
    assert.equal(machine.accept(token, response), true);
    machine.consumer().periods.baseline.rowIds.pop();
    assert.deepEqual(machine.consumer().periods.baseline.rowIds, response.periods.baseline.rowIds);
});

test("observed permission or source cleanup fences consumer and late response while snapshot application is deferred", () => {
    const { input, response, snapshot, machine } = comparisonStateFixture();
    const token = machine.begin(input, snapshot); machine.accept(token, response);
    assert.equal(machine.observe({ basis: snapshot.assessment.basis, pendingCleanup: true, kind: "artifact-deletion" }), false);
    assert.ok(machine.consumer());
    assert.equal(machine.observe({ basis: { ...snapshot.assessment.basis, consentRevision: 5 } }), true);
    assert.equal(machine.consumer(), null);
    assert.equal(machine.accept(token, response), false);
    const next = machine.begin(input, snapshot); machine.accept(next, response);
    assert.equal(machine.observe({ basis: snapshot.assessment.basis, pendingCleanup: true, kind: "activity-deletion" }), true);
    assert.equal(machine.consumer(), null);
});

for (const [label, change] of [
    ["out-of-range outcome delta", value => { value.comparison.outcomes.change.success = 10000; }],
    ["incorrect in-range outcome delta", value => { value.comparison.outcomes.change.success = 1; }],
    ["negative before-outcome total", value => { value.periods.baseline.analytics.resultFacet.totals.count = -1; }],
    ["incorrect before-outcome membership", value => { value.periods.baseline.analytics.resultFacet.rows.pop(); }],
    ["before-outcome row outside its date range", value => {
        value.periods.baseline.analytics.resultFacet = structuredClone(value.periods.baseline.analytics.resultFacet);
        value.periods.baseline.analytics.resultFacet.rows[0].startedAt = "2026-03-09T12:00:00.000Z";
    }],
    ["incorrect in-range call timing delta", value => { value.comparison.matchingCallTiming.median.delta.value = 1; }],
    ["altered call timing comparison fact", value => { value.comparison.matchingCallTiming.median.baseline.value = 1; }],
    ["altered metric comparison fact", value => { value.comparison.metrics.find(item => item.baseline?.kind === "pass-rate").baseline.numerator = 100; }],
    ["altered metric comparison coverage", value => { value.comparison.metrics.find(item => item.baseline?.kind === "pass-rate").baseline.coverage.eligible++; }],
    ["altered metric comparison compatibility", value => { value.comparison.metrics.find(item => item.result?.delta).result.status = "incompatible"; }],
    ["incorrect in-range metric delta", value => { value.comparison.metrics.find(item => item.result?.delta).result.delta.value = 1; }],
    ["altered projected service coverage", value => { value.periods.baseline.analytics.serviceInvolvement.missingDetailCount++; }],
]) test(`derived comparison consumer rejects ${label}`, () => {
    const { input, response, snapshot, machine } = comparisonStateFixture();
    const token = machine.begin(input, snapshot), altered = structuredClone(response);
    change(altered);
    assert.throws(() => machine.accept(token, altered), /comparison|Comparison|coverage|membership|Metric/i);
    assert.equal(machine.consumer(), null);
});

test("invalid derived facts clear an already accepted consumer without clearing a newer generation", () => {
    const { input, response, snapshot, machine } = comparisonStateFixture();
    const token = machine.begin(input, snapshot);
    machine.accept(token, response);
    const altered = structuredClone(response);
    altered.comparison.outcomes.change.success = 1;
    assert.throws(() => machine.accept(token, altered), /Comparison/);
    assert.equal(machine.consumer(), null);
    const newer = machine.begin(input, snapshot); machine.accept(newer, response);
    assert.equal(machine.accept(token, altered), false);
    assert.deepEqual(machine.consumer(), response);
});

for (const [label, change] of [
    ["date", row => { row.startedAt = "2026-03-07T12:00:00.000Z"; }],
    ["private membership", row => { row.scenarioId = "period-request-9"; }],
    ["collection", row => { row.scope = "legacy"; }],
    ["author", row => { row.promptAuthor = "agent"; }],
    ["named service refinement", row => { row.serviceAssociation.services = ["Mail"]; }],
    ["duplicate identity", (row, facet) => { facet.rows.push(structuredClone(row)); }],
]) test(`before-outcome-only rows must match the declared ${label} scope`, () => {
    const { state, input: ordinary, snapshot, machine } = comparisonStateFixture();
    const input = { ...ordinary, withinServices: ["Files"], options: { ...ordinary.options,
        filters: { ...ordinary.options.filters, outcomes: ["failure"], promptAuthors: ["user"] } } };
    const response = buildPeriodComparison(state, input), token = machine.begin(input, snapshot);
    const altered = structuredClone(response), side = altered.periods.later;
    side.analytics.resultFacet = structuredClone(side.analytics.resultFacet);
    const nonmatching = side.analytics.resultFacet.rows.find(row => row.outcome === "success");
    assert.ok(nonmatching);
    change(nonmatching, side.analytics.resultFacet);
    const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
    side.analytics.resultFacet.totals = projection.summarize(side.analytics.resultFacet.rows);
    assert.throws(() => machine.accept(token, altered), /Comparison/);
    assert.equal(machine.consumer(), null);
});
