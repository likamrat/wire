import test from "node:test";
import assert from "node:assert/strict";
import { validateAnalyticsInput } from "../lib/analytics-input.mjs";

test("synthetic: additive chart and activity filters retain original input", () => {
    const options = { layer: "direct-request", groupBy: "workload", bucket: "week", limit: 10, filters: { scope: "history", includeMetadata: false, workloads: ["Mail", "Calendar"], activityTypes: ["direct-request", "recorded-http"], outcomes: ["unknown"], projectIds: [null], from: "2026-10-01", to: "2026-10-04" } };
    assert.equal(validateAnalyticsInput(options), options);
    assert.deepEqual(validateAnalyticsInput({}), {});
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
