import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { privateFixture } from "./helpers.mjs";
import { buildPeriodComparison, validatePeriodComparisonInput } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport, validatePeriodReport } from "../lib/period-report.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { createPeriodComparisonState } from "../web/period-comparison.mjs";
import * as resultContract from "../lib/report-result-contract.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { comparePeriodCohorts } from "../lib/period-comparison-math.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { time } from "../lib/time.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { executeAction } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";

function setup(state, input) {
    const legacy = buildPeriodComparison(state, input), model = buildAssessmentModel(state);
    const membership = { scenarioIds: [], actionIds: [legacy.periods.baseline.rowIds[0], legacy.periods.later.rowIds[0]],
        parentScenarioIds: [legacy.periods.baseline.scenarioIds[0], legacy.periods.later.scenarioIds[0]] };
    const receipt = { schemaVersion: 3, panelId: randomUUID(), epoch: 0, requestId: 1, generation: 1, indexId: "1".repeat(64),
        mode: "text", revision: state.revision, purpose: "strict-match-population",
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], matchPolicyId: searchWireContract.matchPolicyId };
    assert.equal(searchWireContract.analysisReceipt(receipt), true);
    const search = { status: "ready", coverage: "whole-retained-corpus", receipt, ...membership };
    const snapshot = { revision: state.revision, scenarios: state.evidence, sessions: [], analytics: legacy.periods.baseline.analytics,
        assessment: { basis: model.basis, source: model.source, catalog: model.catalog } };
    const machine = createPeriodComparisonState({ time, search: createLocalSearch(), contract, resultContract,
        projection: createActivityProjection(time, serviceCategories, OUTCOMES), categories: serviceCategories, comparePeriodCohorts, searchContract: searchWireContract });
    const request = machine.prepare(snapshot, { ...input.options, filters: { ...input.options.filters, from: "2026-03-07", to: "2026-03-07" } },
        input.periods, "", [], search);
    return { membership, receipt, search, snapshot, machine, request };
}

test("typed complete literal Search hits stay exact across replacement dates, live consumer and frozen report", () => {
    const { state, input } = periodFixture(), { membership, search, snapshot, machine, request } = setup(state, input);
    assert.equal(request.scenarioIds, undefined);
    assert.equal(request.options.filters.from, undefined);
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE QUERY/);
    const value = buildPeriodComparison(state, request, { semanticMembership: membership });
    assert.equal(value.periods.baseline.rowIds.length, 1, "one exact action hit does not select all calls in its interaction");
    assert.equal(value.periods.later.rowIds.length, 1, "later period ignores old Analyze dates");
    const token = machine.begin(request, snapshot, search);
    assert.equal(machine.accept(token, value), true);
    const accepted = acceptPeriodReport(state, value, { semanticSelection: request.semanticSelection, resolveSemantic: () => membership });
    const frozen = freezePeriodReport(state, accepted, new Date().toISOString()).frozen;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.equal(frozen.periods.baseline.facts.metrics[0].coverage.eligible, 3, "assessment remains full-interaction rather than exact-call");
    assert.doesNotMatch(JSON.stringify(frozen), /panelId|requestId|indexId|modelId|PRIVATE QUERY|period-request-/);
    assert.throws(() => validatePeriodComparisonInput({ ...request, scenarioIds: [] }));
    assert.throws(() => buildPeriodComparison(state, request), /search-membership-unavailable/);
    assert.throws(() => buildPeriodComparison(state, request, { semanticMembership: { ...membership, actionIds: ["invented-not-a-canonical-action"] } }), /stale-search-membership/);
    for (const status of ["pending", "partial", "stale"]) assert.throws(() => machine.prepare(snapshot, input.options, input.periods, "", [], { ...search, status }));
    assert.throws(() => machine.prepare(snapshot, input.options, input.periods, "", [], { ...search, coverage: "displayed-page-only" }));
    assert.throws(() => machine.accept(token, { ...value, selection: { ...value.selection, semanticMembership: { ...membership, actionIds: [] } } }));
});

test("empty valid literal Search result stays empty, while scenario hits retain complete matching interactions", () => {
    const { state, input } = periodFixture(), { request } = setup(state, input);
    const empty = buildPeriodComparison(state, request, { semanticMembership: { scenarioIds: [], actionIds: [], parentScenarioIds: [] } });
    assert.equal(empty.periods.baseline.rowIds.length, 0); assert.equal(empty.periods.later.rowIds.length, 0);
    const hit = buildPeriodComparison(state, request, { semanticMembership: { scenarioIds: ["period-request-0"], actionIds: [], parentScenarioIds: [] } });
    assert.equal(hit.periods.baseline.rowIds.length, 2, "same service filter, including missing-service context");
    assert.equal(hit.periods.baseline.assessment.metrics[0].coverage.eligible, 3);
});

test("literal Search returned-entry selection freezes broader parent identities and does not widen measured result rows", () => {
    const { state, input } = periodFixture();
    input.options.layer = "reported-api";
    input.options.filters.outcomes = ["failure"];
    const { request, membership } = setup(state, input);
    request.withinServices = ["Files"];
    const value = buildPeriodComparison(state, request, { semanticMembership: membership });
    assert.equal(value.periods.baseline.rowIds.length, 1);
    assert.equal(value.periods.baseline.analytics.resultFacet.rows.length, 1);
    assert.equal(value.periods.baseline.analytics.apiCoverage.calls.length, 1);
    assert.equal(value.periods.baseline.analytics.apiCoverage.returnedResultUnits, 2, "both returned entries remain in broader parent coverage");
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value, {
        semanticSelection: request.semanticSelection, resolveSemantic: () => membership,
    }), new Date().toISOString()).frozen;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.equal(frozen.periods.baseline.rows.length, 1);
    assert.equal(frozen.periods.baseline.apiCoverage.calls[0].resultIds.length, 2);
});

test("real action boundary resolves receipt once at preview; unrelated search changes do not revoke prepared pair", async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const { context } = await privateFixture(t, fixture.records);
    const state = await loadBoardState(context), input = { ...fixture.input, expectedRevision: state.revision };
    const { request, membership } = setup(state, input);
    delete request.options.layer;
    request.semanticSelection.withinScenarioIds = ["period-request-0"];
    let resolutions = 0, revoked = false;
    const search = { membership(owner, receipt, acceptedState, layer) {
        assert.equal(owner, "panel-owner"); assert.equal(receipt.revision, acceptedState.revision); assert.equal(layer, "tool");
        if (revoked) throw new Error("stale-search-membership");
        resolutions++; return structuredClone(membership);
    } };
    const exports = createExportController(context);
    const value = await executeAction(context, exports, "panel-owner", "get_period_comparison", request, { search });
    assert.equal(value.periods.later.rowIds.length, 0);
    const preview = await executeAction(context, exports, "panel-owner", "preview_export", {
        periodComparison: value, semanticSelection: request.semanticSelection, options: { formats: ["json"], timeContext: value.timeContext },
    }, { search });
    assert.equal(preview.snapshot.periodComparison.selection.withinScenarioRefs.length, 1);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
    assert.equal(resolutions, 2);
    revoked = true;
    await exports.review("panel-owner", preview.previewId, true, value.timeContext);
    await updateBoardState(context, current => { current.cards["period-request-9"].workflowState = "reviewing"; });
    await exports.confirm("panel-owner", preview.previewId, true, value.timeContext);
    assert.equal(resolutions, 2, "no active-receipt check or search rerun at review/save");
    const current = await loadBoardState(context);
    assert.equal(current.exports.length, 1);
});

test("legacy narrowing intersects semantic action/scenario hits, facets, parents and frozen report without granting membership", () => {
    const { state, input } = periodFixture();
    input.options.layer = "reported-api";
    input.options.filters.outcomes = ["failure"];
    const { membership, search, snapshot, machine } = setup(state, input);
    membership.scenarioIds = ["period-request-0", "period-request-1"];
    membership.parentScenarioIds.push("period-request-1");
    Object.assign(search, membership);
    snapshot.sessions = [{ sessionId: "period-chat-0", name: "KEEP_LEGACY" },
        { sessionId: "period-chat-2", name: "KEEP_LEGACY" }, { sessionId: "period-chat-9", name: "KEEP_LEGACY" }];
    const legacy = machine.prepare(snapshot, input.options, input.periods, "KEEP_LEGACY");
    assert.deepEqual(legacy.scenarioIds, ["period-request-0", "period-request-2", "period-request-9"]);
    const semantic = { ...search, withinScenarioIds: legacy.scenarioIds };
    const request = machine.prepare(snapshot, input.options, input.periods, "KEEP_LEGACY", [], semantic);
    assert.deepEqual(request.semanticSelection.withinScenarioIds, legacy.scenarioIds);
    assert.doesNotMatch(JSON.stringify(request), /KEEP_LEGACY/);
    const value = buildPeriodComparison(state, request, { semanticMembership: membership });
    const token = machine.begin(request, snapshot, semantic);
    assert.equal(machine.accept(token, value), true);
    assert.deepEqual(value.periods.baseline.scenarioIds, ["period-request-0"]);
    assert.deepEqual(value.periods.later.scenarioIds, ["period-request-2"]);
    assert.equal(value.periods.baseline.analytics.resultFacet.rows.some(row => row.scenarioId === "period-request-1"), false);
    assert.equal(value.periods.baseline.analytics.apiCoverage.calls.some(row => row.scenarioId === "period-request-1"), false);
    assert.equal(value.periods.baseline.analytics.rows.some(row => row.scenarioId === "period-request-9"), false, "qualifier-only group grants no semantic membership");
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value, {
        semanticSelection: request.semanticSelection, resolveSemantic: () => membership,
    }), new Date().toISOString()).frozen;
    assert.deepEqual(frozen.comparison, value.comparison);
    assert.equal(frozen.selection.withinScenarioRefs.length, 3);
    assert.doesNotMatch(JSON.stringify(frozen), /KEEP_LEGACY|period-request-|panelId/);
    const forgedParent = structuredClone(frozen);
    forgedParent.periods.baseline.apiCoverage.calls[0].scenarioId = frozen.selection.withinScenarioRefs[2];
    assert.throws(() => validatePeriodReport(forgedParent), /API parent outside frozen search membership/);
    const narrowedEmpty = structuredClone(frozen);
    narrowedEmpty.selection.withinScenarioRefs = [];
    assert.throws(() => validatePeriodReport(narrowedEmpty), /outside frozen interaction narrowing/);
    const empty = { ...request, semanticSelection: { ...request.semanticSelection, withinScenarioIds: [] } };
    const none = buildPeriodComparison(state, empty, { semanticMembership: membership });
    for (const side of Object.values(none.periods)) {
        assert.equal(side.rowIds.length, 0); assert.equal(side.analytics.resultFacet.rows.length, 0);
        assert.equal(side.analytics.apiCoverage.eligibleToolCalls, 0);
    }
    for (const withinScenarioIds of [["not-in-roster"], ["period-request-0", "period-request-0"], null, [4]]) {
        const invalid = { ...request, semanticSelection: { ...request.semanticSelection, withinScenarioIds } };
        assert.throws(() => buildPeriodComparison(state, invalid, { semanticMembership: membership }));
        assert.throws(() => machine.prepare(snapshot, input.options, input.periods, "KEEP_LEGACY", [], { ...search, withinScenarioIds }));
    }
    const widened = structuredClone(value);
    delete widened.selection.withinScenarioIds;
    assert.throws(() => machine.accept(token, widened));
    const widenedParents = structuredClone(value);
    widenedParents.periods.baseline.analytics.apiCoverage.calls.push({
        id: "unselected-parent", scenarioId: "period-request-1", resultIds: [], numericStatusIds: [],
    });
    assert.throws(() => machine.accept(token, widenedParents));
    const wrongPreviewScope = { ...request.semanticSelection, withinScenarioIds: [] };
    assert.throws(() => acceptPeriodReport(state, value, { semanticSelection: wrongPreviewScope, resolveSemantic: () => membership }));
    assert.throws(() => machine.prepare(snapshot, input.options, input.periods, "KEEP_LEGACY", [], search),
        "a visible legacy phrase cannot silently become an unqualified semantic selection");
});
