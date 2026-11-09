import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisSlice } from "../web/client.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createReportScope } from "../web/report-scope.mjs";
import { exportCatalogFor } from "./helpers.mjs";
import { scopeRecords, scopeOptions, privateQuery } from "./analysis-scope-fixture.mjs";
import { createSearchMembership as mapSearchMembership } from "../web/search-membership.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { chatFixture } from "./native-read-model-fixtures.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";

const createSearchMembership = (snapshot, options, within, hits, receipt) => mapSearchMembership(snapshot, options, within, hits, {
    schemaVersion: 3, panelId: "11111111-1111-4111-8111-111111111111", epoch: 0, requestId: 1, generation: 1,
    indexId: "1".repeat(64), mode: "text", purpose: "strict-match-population",
    queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], matchPolicyId: searchWireContract.matchPolicyId,
    ...receipt,
}, searchWireContract);

const projection = createActivityProjection(createTimeContext(), createServiceCategories(), Object.keys(createRecordedResults().labels("tool")));
const refine = createAnalysisSlice(createLocalSearch(), projection);
const sorted = values => [...values].sort();
const rowId = (i, j = 0) => `call:${JSON.stringify([`parity-chat-${i}`, `parity-call-${i}-${j}`])}`;
const hit = (type, request, layer, call) => ({ type, match: "text", target: { kind: "route",
    href: "#request?" + new URLSearchParams({ request, ...(layer ? { layer, call } : {}) }) } });
function snapshot(options = scopeOptions) {
    const scenarios = scopeRecords();
    return { revision: 17, scenarios, analytics: { ...buildActivityAnalytics(scenarios, options), revision: 17 },
        requestActivity: buildRequestActivity(scenarios), exportCatalog: exportCatalogFor(scenarios) };
}
function exact(slice, ids, scenarioIds) {
    assert.deepEqual(sorted(slice.rowIds), sorted(ids));
    assert.equal(new Set(slice.rowIds).size, slice.rowIds.length);
    assert.deepEqual(sorted(slice.scenarioIds), sorted(scenarioIds));
    const model = slice.analytics;
    assert.equal(model.totals.count, ids.length);
    for (const groups of [model.groups, model.workloadGroups, model.timeSeries.points, model.journeys,
        [...model.visibleGroups, ...(model.otherGroup ? [model.otherGroup] : [])]]) {
        assert.deepEqual(sorted(groups.flatMap(group => group.drilldownIds)), sorted(ids));
    }

    for (const group of model.serviceInvolvement.groups) {
        assert.deepEqual(sorted(group.drilldownIds), sorted(model.rows.filter(row => row.serviceAssociation.services.includes(group.label)).map(row => row.id)));
    }
}

test("context rows retain the exact full-analytics attribution without building discarded chart projections", () => {
    const records = [...scopeRecords(), ...projectRetainedNativeRecords(chatFixture()).records];
    records.push(...extractGraphActivities([
        { id: "context-prompt", type: "user.message", timestamp: "2026-10-01T10:00:00Z", data: { content: "Read the invented calendar." } },
        { id: "context-start", type: "tool.execution_start", timestamp: "2026-10-01T10:00:01Z",
            data: { toolCallId: "context-graph", toolName: "powershell", arguments: { command: "curl https://graph.microsoft.com/v1.0/me/events" } } },
        { id: "context-end", type: "tool.execution_complete", timestamp: "2026-10-01T10:00:02Z",
            data: { toolCallId: "context-graph", success: true, result: { content: "HTTP/2 200" } } },
    ], { sessionId: "context-graph-source", projectId: "context-project", eligible: true,
        checkedAt: "2026-10-02T00:00:00Z", archiveEvidence: { archived_at: null, workspaces: [] } }).scenarios);
    records[1].httpRecords = [{ recordId: "context-http", classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: true, responseOrigin: "https://graph.microsoft.com", method: "GET", apiVersion: "v1.0",
        responsePath: { path: "/me/messages", query: [] }, startedAt: "2026-10-01T10:00:00Z", durationMs: 12, status: 200, transportError: null }];
    records.push({ ...structuredClone(records[0]), scenarioId: "context-alias" });
    const context = buildRequestActivity(records);
    for (const layer of ["tool", "reported-api", "direct-request", "recorded-http", "http"]) assert.ok(context[layer].length > 0, layer);
    for (const [layer, rows] of Object.entries(context)) {
        const complete = buildActivityAnalytics(records, { layer, bucket: "month", filters: { scope: "all", includeMetadata: true } }).rows;
        const fields = ["id", "scenarioId", "scenarioIds", "sourceSessionId", "sourceId", "sourceScope", "toolCallId", "activityId",
            "recordId", "parentCallId", "observationKey", "resultIndex", "outcome", "status", "workload", "endpoint", "serviceAssociation",
            "countUnit", "nativeToolNames", "nativeOutcome", "nativeConflicts"];
        assert.deepEqual(rows, complete.map(row => Object.fromEntries(fields.map(key => [key, row[key]]))), layer);
    }
    assert.throws(() => buildRequestActivity([records[1], records[1]]), /Population refinement/);
});

test("accepted no-call native conversations survive list and literal Search without becoming widget calls", () => {
    const input = snapshot(), nativeRecord = projectRetainedNativeRecords(chatFixture()).records[0];
    const native = nativeRecord.nativeConversation;
    input.scenarios.push(nativeRecord);
    const existing = [...new Set(input.analytics.rows.map(row => row.scenarioId))];
    input.analytics = { ...buildActivityAnalytics(input.scenarios, scopeOptions), revision: input.revision };
    const unsearched = refine(input, scopeOptions);
    assert.deepEqual(unsearched.scenarioIds, [...existing, native.key]);
    assert.equal(unsearched.rowIds.length, input.analytics.rows.length);
    const membership = { revision: input.revision, scopeKey: JSON.stringify([scopeOptions, []]),
        scenarioIds: [native.key], actionIds: [], parentScenarioIds: [native.key] };
    const searched = refine(input, scopeOptions, "", [], membership);
    assert.deepEqual(searched.scenarioIds, [native.key]);
    assert.equal(searched.analytics.totals.count, 0);
    assert.deepEqual(refine(input, scopeOptions, "invented question").scenarioIds, [native.key]);
    assert.deepEqual(refine(input, scopeOptions, "", [], { ...membership, scenarioIds: [] }).scenarioIds, []);
    input.analytics.population = buildActivityAnalytics(input.scenarios.filter(record => record !== nativeRecord), scopeOptions).population;
    assert.equal(refine(input, scopeOptions).scenarioIds.includes(native.key), false, "UI cannot readmit a conversation excluded by Dates or other backend scope.");
});

test("verified empty, stale and full-page literal membership never falls back to legacy or global hits", () => {
        const input = snapshot(), receipt = { revision: 17 };
        const empty = createSearchMembership(input, scopeOptions, [], [], receipt);
        exact(refine(input, scopeOptions, privateQuery, [], empty), [], []);
        assert.throws(() => createSearchMembership(input, scopeOptions, [], [], { revision: 16 }), /current strict analysis receipt/);
        assert.throws(() => refine(input, { ...scopeOptions, bucket: "month" }, "", [], empty), /scope/);
        const hits = input.scenarios.map(row => hit("interaction", row.scenarioId));
        hits.push(hit("report", "not-a-scenario"), { type: "view", match: "text", target: { kind: "route", href: "#analyze" } });
        const all = createSearchMembership(input, scopeOptions, [], hits, receipt);
        exact(refine(input, scopeOptions, "", [], all), input.analytics.rows.map(row => row.id),
            [...new Set(input.analytics.rows.map(row => row.scenarioId))]);
        assert.equal(refine(input, scopeOptions).analytics, input.analytics);
});

test("literal action membership keeps pre-outcome facets, broader API parents and complete report interactions", () => {
        const options = { ...scopeOptions, layer: "reported-api", filters: { services: ["Files"], includeMissingService: true, outcomes: ["failure"] } };
        const input = snapshot(options), allEntries = input.requestActivity["reported-api"];
        const action = allEntries.find(row => row.scenarioId === "parity-request-0" && row.outcome === "failure");
        const membership = createSearchMembership(input, options, [], [hit("action", action.scenarioId, options.layer, action.id)], { revision: 17 });
        const result = refine(input, options, "", [], membership);
        assert.deepEqual(result.rowIds, [action.id]);
        assert.equal(result.analytics.apiCoverage.eligibleToolCalls, 2, "Parent scope is not reduced to the one matching returned entry");
        const success = input.analytics.resultFacet.rows.find(row => row.outcome === "success");
        const beforeOutcome = createSearchMembership(input, options, [], [hit("action", success.scenarioId, options.layer, success.id)], { revision: 17 });
        const narrowed = refine(input, options, "", [], beforeOutcome);
        assert.deepEqual(narrowed.rowIds, []);
        assert.deepEqual(narrowed.analytics.resultFacet.rows.map(row => row.id), [success.id]);
        const report = createReportScope().resolve(input.exportCatalog, "current", result.scenarioIds, []);
        assert.equal(report.requests.find(row => row.scenarioId === action.scenarioId).counts.workIqActions, 3);
});

test("legacy qualifier uses full roster and intersects literal facets and API parents", () => {
    const options = { ...scopeOptions, layer: "reported-api", filters: { services: ["Files"], includeMissingService: true, outcomes: ["failure"] } };
    const input = snapshot(options), legacy = `${privateQuery} request 2`;
    const membership = createSearchMembership(input, options, [], [
        hit("interaction", "parity-request-0"), hit("interaction", "parity-request-2"),
    ], { revision: 17 });
    const selected = refine(input, options, legacy, [], membership);
    assert.deepEqual(selected.rowIds, []);
    assert.deepEqual(selected.analytics.resultFacet.rows.map(row => row.scenarioId), ["parity-request-2"]);
    assert.deepEqual(selected.analytics.apiCoverage.calls.map(row => row.id), [rowId(2)]);
    assert.deepEqual(refine.legacyScenarioIds(input, legacy), ["parity-request-2"]);
    assert.equal(refine.legacyScenarioIds(input, ""), undefined);
    assert.deepEqual(refine.legacyScenarioIds(input, "NO_LEGACY_MATCH"), []);
    const outsideDates = { ...input, analytics: { ...input.analytics, rows: [], resultFacet: { ...input.analytics.resultFacet, rows: [] } } };
    assert.deepEqual(refine.legacyScenarioIds(outsideDates, legacy), ["parity-request-2"], "Qualifier is not derived from old Analyze dates/pages");
    const restored = refine(input, options, "", [], membership);
    assert.ok(restored.rowIds.length > 0, "Removing only the legacy phrase restores the receipt-derived scope");
});

test("one private slice supplies exact deduped IDs to all aggregations and full-interaction report selection", () => {
    const input = snapshot(), before = structuredClone(input), slice = refine(input, scopeOptions, privateQuery);
    const ids = [rowId(0), rowId(0, 1), rowId(0, 2), ...Array.from({ length: 8 }, (_, i) => rowId(i + 1))];
    const scenarios = Array.from({ length: 9 }, (_, i) => `parity-request-${i}`);
    exact(slice, ids, scenarios);
    assert.equal(slice.analytics.revision, 17);
    assert.deepEqual(slice.analytics.resultFacet.totals, projection.summarize(slice.rows));
    assert.deepEqual(createReportScope().resolve(input.exportCatalog, "current", slice.scenarioIds, []).requests.map(row => row.scenarioId).sort(), scenarios);
    assert.deepEqual(input, before);
    assert.equal(refine(input, scopeOptions, "").analytics, input.analytics, "clearing query restores the unchanged accepted projection");
});

test("search AND Author/Outcome/date/service context preserves before-outcome membership and full detail", () => {
    const options = { ...scopeOptions, filters: { scope: "history", services: ["Files"], includeMissingService: true,
        promptAuthors: ["user"], outcomes: ["failure"], from: "2026-09-30", to: "2026-09-30" } };
    const input = snapshot(options), slice = refine(input, options, privateQuery);
    exact(slice, [rowId(0), rowId(0, 1), rowId(6)], ["parity-request-0", "parity-request-6"]);
    assert.deepEqual(slice.analytics.serviceInvolvement.selection.knownMatchIds.sort(), [rowId(0), rowId(6)]);
    assert.deepEqual(slice.analytics.serviceInvolvement.selection.contextOnlyIds, [rowId(0, 1)]);
    assert.deepEqual(slice.analytics.resultFacet.rows.map(row => row.id).sort(), [rowId(0), rowId(0, 1), rowId(2), rowId(4), rowId(6)]);
    assert.equal(slice.analytics.resultFacet.totals.count, 5);
    const noFailedRows = refine(input, options, `${privateQuery} request 2`);
    exact(noFailedRows, [], []);
    assert.deepEqual(noFailedRows.analytics.resultFacet.rows.map(row => row.id), [rowId(2)]);
    assert.equal(noFailedRows.analytics.resultFacet.totals.success, 1, "before-outcome options do not collapse to matched interactions");
    assert.deepEqual(slice.analytics.serviceInvolvement.groups.find(group => group.label === "Mail").drilldownIds, [rowId(0)]);
    assert.deepEqual(slice.rows.find(row => row.id === rowId(0, 1)).serviceAssociation.services, []);
    assert.deepEqual(input.requestActivity.tool.filter(row => row.scenarioId === "parity-request-0").map(row => row.id), [rowId(0), rowId(0, 1), rowId(0, 2)]);
    const report = createReportScope().resolve(input.exportCatalog, "current", slice.scenarioIds, []);
    assert.equal(report.requests.find(row => row.scenarioId === "parity-request-0").counts.workIqActions, 3);
    const strictOptions = { ...options, filters: { ...options.filters, includeMissingService: false } };
    exact(refine(snapshot(strictOptions), strictOptions, privateQuery), [rowId(0), rowId(6)], ["parity-request-0", "parity-request-6"]);
});

test("service chart refinement intersects the server OR set and all consumers without freezing IDs", () => {
    const options = { ...scopeOptions, filters: { scope: "history", services: ["Files"], includeMissingService: true, outcomes: ["failure"] } };
    const source = scopeRecords();
    const mailOnly = structuredClone(source[1]);
    mailOnly.scenarioId = "mail-only"; mailOnly.sourceSessionId = "mail-only";
    mailOnly.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
    mailOnly.toolCalls[0].toolSucceeded = false; mailOnly.toolCalls[0].reportedOutcome = "failed";
    source.push(mailOnly);
    const input = { scenarios: source, analytics: buildActivityAnalytics(source, options), exportCatalog: exportCatalogFor(source) };
    const before = structuredClone(input), slice = refine(input, options, privateQuery, ["Mail"]);
    exact(slice, [rowId(0)], ["parity-request-0"]);
    assert.deepEqual(slice.analytics.serviceInvolvement.selection.knownMatchIds, [rowId(0)]);
    assert.deepEqual(slice.analytics.serviceInvolvement.selection.contextOnlyIds, []);
    assert.deepEqual(slice.analytics.resultFacet.rows.map(row => row.id), [rowId(0)]);
    const report = createReportScope().resolve(input.exportCatalog, "current", slice.scenarioIds, []);
    assert.deepEqual(report.requests.map(row => row.scenarioId), ["parity-request-0"]);
    assert.equal(report.counts.workIqActions, 3, "Current report includes the full retained interaction, not just its matching call");
    assert.deepEqual(input, before);
    source[2].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/me/messages"] };
    const next = { ...input, analytics: buildActivityAnalytics(source, options) };
    const updated = refine(next, options, privateQuery, ["Mail"]);
    exact(updated, [rowId(0)], ["parity-request-0"]);
    assert.deepEqual(updated.analytics.resultFacet.rows.map(row => row.id).sort(), [rowId(0), rowId(2)]);
    const noOutcome = { ...options, filters: { ...options.filters, outcomes: undefined } };
    exact(refine({ ...next, analytics: buildActivityAnalytics(source, noOutcome) }, noOutcome, privateQuery, ["Mail"]),
        [rowId(0), rowId(2)], ["parity-request-0", "parity-request-2"]);
    assert.ok(refine(next, options, privateQuery, []).rows.length > 1, "Removing the refinement restores the existing service scope");
});

test("returned-entry refinement keeps accepted pre-outcome parent coverage and never borrows the parent service", () => {
    const options = { ...scopeOptions, layer: "reported-api", filters: { services: ["Files"], includeMissingService: true, outcomes: ["failure"] } };
    const input = snapshot(options), result = refine(input, options, `${privateQuery} request 0`, ["Files"]);
    const expected = input.analytics.rows.filter(row => row.scenarioId === "parity-request-0" && row.serviceAssociation.services.includes("Files"));
    exact(result, expected.map(row => row.id), ["parity-request-0"]);
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.analytics.apiCoverage.calls.map(row => row.id), [rowId(0)]);
    assert.equal(result.analytics.apiCoverage.returnedResultUnits, 2, "Parent coverage still counts the accepted parent's two returned entries");
    assert.equal(result.analytics.apiCoverage.selectedResultUnits, 1);
    assert.throws(() => refine({ ...input, requestActivity: undefined }, options, "", ["Files"]), /accepted returned-entry associations/);
});

test("changed evidence layers refine returned-result IDs and their explicitly broader pre-outcome parent coverage", () => {
    const options = { ...scopeOptions, layer: "reported-api", filters: { services: ["Files"], includeMissingService: true, outcomes: ["failure"] } };
    const input = snapshot(options), slice = refine(input, options, `${privateQuery} request 0`);
    const expected = input.analytics.rows.filter(row => row.scenarioId === "parity-request-0");
    exact(slice, expected.map(row => row.id), ["parity-request-0"]);
    assert.equal(expected.length, 2);
    assert.deepEqual(slice.analytics.apiCoverage.calls.map(call => call.id).sort(), [rowId(0), rowId(0, 1)]);
    assert.equal(slice.analytics.apiCoverage.eligibleToolCalls, 2);
    assert.equal(slice.analytics.apiCoverage.returnedResultUnits, 3);
    assert.equal(slice.analytics.apiCoverage.selectedResultUnits, 2);
    assert.equal(slice.analytics.apiCoverage.callsWithNumericStatus, 2);
});

test("no-match is empty, metadata search uses existing fields, and aliases do not become an extra cohort", () => {
    const input = snapshot();
    exact(refine(input, scopeOptions, "NO_PARITY_MATCH"), [], []);
    const one = refine(input, scopeOptions, "Invented parity chat 0");
    exact(one, [rowId(0), rowId(0, 1), rowId(0, 2)], ["parity-request-0"]);
    assert.equal(one.analytics.coverage.scenarioCount, 1);
    assert.deepEqual(refine(input, scopeOptions, "NO_PARITY_MATCH").analytics.serviceInvolvement.groups, []);
});

test("serialized factories have no import closures and preserve unsearched projection math", () => {
    const standaloneProjection = Function(`return (${createActivityProjection.toString()})`)()(
        createTimeContext(), createServiceCategories(), Object.keys(createRecordedResults().labels("tool")));
    const standalone = Function(`return (${createAnalysisSlice.toString()})`)()(createLocalSearch(), standaloneProjection);
    const input = snapshot();
    const actual = standalone(input, scopeOptions, privateQuery), expected = refine(input, scopeOptions, privateQuery);
    assert.deepEqual(actual.analytics, expected.analytics);
    assert.deepEqual(actual.rowIds, expected.rowIds);
    assert.deepEqual(actual.scenarioIds, expected.scenarioIds);
    assert.deepEqual(actual.refineRows(input.analytics.resultFacet.rows), expected.refineRows(input.analytics.resultFacet.rows));
    assert.deepEqual(standaloneProjection.project(input.analytics.rows, { ...scopeOptions,
        timeContext: input.analytics.timeContext, dateRange: input.analytics.dateRange }, input.scenarios),
    Object.fromEntries(Object.keys(standaloneProjection.project([], { ...scopeOptions,
        timeContext: input.analytics.timeContext, dateRange: input.analytics.dateRange }, [])).map(key => [key, input.analytics[key]])));
});

test("serialized row predicates preserve ordinary analytics date, author and missing-service selection", () => {
    const time = createTimeContext();
    const standalone = Function(`return (${createActivityProjection.toString()})`)()(
        time, createServiceCategories(), Object.keys(createRecordedResults().labels("tool")));
    const source = snapshot();
    for (const includeMissingService of [true, false]) {
        const filters = { scope: "history", services: ["Files"], includeMissingService, promptAuthors: ["user"],
            outcomes: ["failure"], from: "2026-09-30", to: "2026-09-30" };
        const bounds = { ...filters, ...time.range(filters, scopeOptions.timeContext.timeZone) };
        const selected = source.analytics.rows.filter(row => standalone.selected(row, bounds));
        const ordinary = buildActivityAnalytics(source.scenarios, { ...scopeOptions, filters });
        assert.deepEqual(sorted(selected.map(row => row.id)), sorted([rowId(0), ...(includeMissingService ? [rowId(0, 1)] : []), rowId(6)]));
        assert.deepEqual(sorted(selected.map(row => row.id)), sorted(ordinary.rows.map(row => row.id)));
        assert.deepEqual(standalone.summarize(selected), ordinary.totals);
        assert.equal(standalone.serviceSelected(source.analytics.rows.find(row => row.id === rowId(0, 1)), filters), includeMissingService);
    }
});
