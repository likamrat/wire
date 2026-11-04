import test from "node:test";
import assert from "node:assert/strict";
import { fixture as githubRecord } from "./helpers.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { nativeConsumerFixture } from "./native-consumer-fixture.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { time } from "../lib/time.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";

function returnedEntries() {
    const envelopes = [...chatFixture(), ...coworkFixture()];
    const completed = envelopes.find(row => row.record.id === "seq:8");
    completed.outcomes.nestedApi = {
        unit: "nested-api-result", availability: "recorded", declaredRequestCount: 20,
        declaredRequestCountIsSuccessDenominator: false,
        observed: [200, 403].map((statusCode, index) => ({
            index, indexKind: "response-array-position", statusCode,
            errorCode: null, paginationPresent: null, evidenceLevel: "intermediary-reported",
        })),
    };
    return envelopes;
}

test("HTTP snapshot requestActivity carries exact native returned-entry association into its reader carrier", async t => {
    const app = await nativeConsumerFixture(t, { records: [githubRecord()], envelopes: returnedEntries() });
    const api = await app.start();
    const options = { layer: "reported-api", bucket: "month", filters: { scope: "all", sources: ["microsoft-365-cowork"] } };
    const snapshot = await api("/api/snapshot", options);
    assert.equal(snapshot.status, 200);
    const { scenarios, analytics, requestActivity } = snapshot.body;
    assert.equal(analytics.rows.length, 2);
    assert.deepEqual(analytics.rows.map(row => row.resultIndex), [0, 1]);
    for (const original of analytics.rows) {
        const row = requestActivity["reported-api"].find(row => row.id === original.id);
        assert.equal(row.observationKey, original.observationKey);
        assert.equal(row.resultIndex, original.resultIndex);
        const conversation = scenarios.find(record => record.scenarioId === row.scenarioId).nativeConversation;
        const observation = conversation.returnedResults.find(result => result.observationKey === row.observationKey);
        assert.ok(observation);
        const result = observation.observed.find(result => result.index === row.resultIndex);
        assert.equal(result.statusCode, row.status);
        assert.ok(conversation.calls.some(call => call.key === row.parentCallId));
    }
    const canvas = await api("/api/canvas", { action: "get_snapshot", input: options });
    assert.equal(canvas.status, 200);
    assert.deepEqual(canvas.body.requestActivity["reported-api"], requestActivity["reported-api"]);
});

test("shared and serialized row projections replace unit denominators for narrowed, empty and legacy-only selections", () => {
    const records = [githubRecord(), ...projectRetainedNativeRecords(returnedEntries()).records];
    const options = { layer: "reported-api", bucket: "month", filters: { scope: "all" } };
    const base = buildActivityAnalytics(records, options);
    assert.equal(base.unitPopulations.length, 2);
    const serializedFactory = Function(`return (${createActivityProjection.toString()});`)();
    for (const factory of [createActivityProjection, serializedFactory]) {
        const projection = factory(time, serviceCategories, OUTCOMES);
        const refine = (rows, scenarios = JSON.parse(JSON.stringify(records))) => ({
            ...base, ...projection.project(rows, {
                groupBy: base.groupBy, limit: 10, bucket: options.bucket, filters: options.filters,
                timeContext: base.timeContext, dateRange: base.dateRange,
            }, scenarios),
        });
        const failed = base.rows.filter(row => row.countUnit === "native-returned-result-observation" && row.resultIndex === 1);
        const one = refine(failed);
        assert.deepEqual(one.unitPopulations.map(group => [group.unit, group.rowIds, group.totals.count]),
            [["native-returned-result-observation", failed.map(row => row.id), 1]]);
        assert.equal(one.unitPopulations[0].totals.failure, 1);
        assert.equal(one.unitPopulations[0].totals.successRate.denominator, 1);
        assert.equal(one.measurementEligibility.outcomeRate, "selected-unit-population");
        assert.equal(one.measurementEligibility.nativeActivityDates, "unqualified");
        assert.equal(one.timeSeries.undatedCount, 1);
        const mixedRows = [failed[0], base.rows.find(row => row.countUnit === "workiq-returned-result-entry")];
        const mixed = refine(mixedRows);
        assert.deepEqual(mixed.unitPopulations.map(group => group.rowIds).flat(), mixedRows.map(row => row.id));
        assert.deepEqual(mixed.unitPopulations.map(group => group.totals.count), [1, 1]);
        assert.equal(mixed.totals.successRate.unavailable, "different-source-unit-definitions");
        assert.equal(mixed.measurementEligibility.outcomeRate, "separate-unit-populations-only");
        const empty = refine([]);
        assert.deepEqual(empty.unitPopulations, []);
        assert.equal(empty.totals.count, 0);
        assert.equal(empty.totals.successRate.percent, null);
        assert.equal(empty.measurementEligibility.nativeActivityDates, "unqualified");
        const legacy = refine(mixedRows.slice(1), [records[0]]);
        assert.equal(legacy.unitPopulations, null);
        assert.equal(legacy.measurementEligibility, null);
        assert.deepEqual(JSON.parse(JSON.stringify({
            unitPopulations: legacy.unitPopulations, measurementEligibility: legacy.measurementEligibility,
        })), { unitPopulations: null, measurementEligibility: null });
        assert.equal(legacy.totals.successRate.denominator, 1);
        assert.equal(base.unitPopulations.flatMap(group => group.rowIds).length, 3);
    }
    const noTools = buildActivityAnalytics(records, { layer: "tool", bucket: "month", filters: { sources: ["microsoft-365-chat"] } });
    assert.equal(noTools.population.native.noToolConversations, 1);
    assert.equal(noTools.population.scenarioIds.length, 1);
    assert.deepEqual(noTools.population.rowIds, []);
});
