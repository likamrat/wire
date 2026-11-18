import test from "node:test";
import assert from "node:assert/strict";
import { ANALYTICS_SCHEMA, validateAnalyticsInput } from "../lib/analytics-input.mjs";

test("timeline navigation is a validated date separate from population filters", () => {
    const input = { bucket: "day", timelineFrom: "1926-11-16", filters: { scope: "all" } };
    assert.deepEqual(validateAnalyticsInput(input), input);
    for (const timelineFrom of ["1926-02-30", "2026-11-16T00:00:00Z", "", 0, null]) {
        assert.throws(() => validateAnalyticsInput({ ...input, timelineFrom }), error => error.status === 400);
    }
    assert.throws(() => validateAnalyticsInput({ ...input, timelineLimit: 100000 }), error => error.status === 400);
});

test("synthetic: additive chart and activity filters retain original input", () => {
    const options = { layer: "direct-request", groupBy: "workload", bucket: "week", limit: 10, filters: { scope: "history", includeMetadata: false, workloads: ["Mail", "Calendar"], activityTypes: ["direct-request", "recorded-http"], outcomes: ["unknown"], projectIds: [null], from: "2026-10-01", to: "2026-10-04" } };
    assert.equal(validateAnalyticsInput(options), options);
    assert.deepEqual(validateAnalyticsInput({}), {});
});

test("missing-service context is an explicit boolean in both analytics input contracts", () => {
    assert.deepEqual(ANALYTICS_SCHEMA.properties.filters.properties.includeMissingService, { type: "boolean" });
    for (const includeMissingService of [true, false]) {
        const input = { filters: { services: ["Files"], includeMissingService } };
        assert.equal(validateAnalyticsInput(input), input);
    }
    for (const includeMissingService of ["true", "false", 0, 1, null, [], {}]) {
        assert.throws(() => validateAnalyticsInput({ filters: { services: ["Files"], includeMissingService } }), error => error.status === 400);
    }
});

test("synthetic: schema rejects unbounded or malformed chart filters with BoardError", () => {
    const cases = [
        null, [], { nope: 1 }, { layer: "wire-guessed" }, { groupBy: "private" }, { bucket: "year" }, { limit: 101 },
        { filters: { includeMetadata: "false" } }, { filters: { workloads: ["Finance secret"] } },
        { filters: { activityTypes: ["all"] } }, { filters: { outcomes: ["reviewed"] } },
        { filters: { tools: Array(501).fill("workiq-fetch") } }, { filters: { from: "invalid" } },
        { filters: { from: "2026-10-04", to: "2026-10-01" } }, { filters: { prompt: "PRIVATE" } },
    ];
    for (const value of cases) assert.throws(() => validateAnalyticsInput(value), (e) => e.status === 400);
});
