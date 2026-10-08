import test from "node:test";
import assert from "node:assert/strict";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { OUTCOMES } from "../lib/analytics.mjs";
import { fixture } from "./helpers.mjs";

function source() {
    const record = fixture("facet");
    record.toolCalls = ["succeeded", "failed", undefined, "partial"].map((outcome, index) => ({
        ...record.toolCalls[0], toolCallId: `facet-${index}`, startEventId: `facet-start-${index}`,
        toolSucceeded: undefined, reportedOutcome: outcome, startedAt: `2026-09-${10 + index}T23:30:00Z`,
        requestArgs: { entityUrls: index === 3 ? ["/me/messages", "/me/calendar"] : ["/me/messages"] },
        requestedApiPath: "/me/messages",
        apiResults: [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 503 }, { index: 2, statusCode: null }, { index: 3, statusCode: 302 }],
    }));
    const duplicate = { ...structuredClone(record), scenarioId: "legacy-facet", isLegacy: true };
    const second = { ...structuredClone(record), scenarioId: "facet-other", sourceSessionId: "other-session", projectId: "other-project" };
    return [record, duplicate, second];
}

function reconcile(analytics) {
    assert.equal(OUTCOMES.reduce((sum, key) => sum + analytics.totals[key], 0), analytics.rows.length);
    assert.equal(analytics.groups.reduce((sum, group) => sum + group.total, 0), analytics.rows.length);
    assert.equal(analytics.workloadGroups.reduce((sum, group) => sum + group.total, 0), analytics.rows.length);
    assert.equal(analytics.timeSeries.points.reduce((sum, point) => sum + point.total, 0) + analytics.timeSeries.undatedCount, analytics.rows.length);
    assert.equal(OUTCOMES.reduce((sum, key) => sum + analytics.resultFacet.totals[key], 0), analytics.resultFacet.totals.count);
}

test("faceted result counts use identical canonical scope except outcome, including dedup and multi-target calls", () => {
    const records = source();
    for (const filters of [
        {}, { scope: "all" }, { scope: "legacy" }, { projectIds: ["test-project"] },
        { sourceSessionIds: ["other-session"] }, { workloads: ["Mail"] }, { workloads: ["Multiple workloads"] },
        { from: "2026-09-11", to: "2026-09-12", projectIds: ["test-project"], scope: "all" },
    ]) {
        const options = { bucket: "day", filters, timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" } };
        const baseline = buildActivityAnalytics(records, options);
        for (const outcome of OUTCOMES) {
            const selected = buildActivityAnalytics(records, { ...options, filters: { ...filters, outcomes: [outcome] } });
            assert.deepEqual(selected.resultFacet.totals, baseline.totals);
            assert.equal(selected.totals.count, baseline.totals[outcome]);
            assert.ok(selected.rows.every(row => row.outcome === outcome));
            reconcile(selected);
        }
    }
    assert.equal(buildActivityAnalytics(records, { filters: { scope: "all" } }).totals.count, 8, "Two chats, not three aliases or per-target calls");
    assert.equal(buildActivityAnalytics(records, { filters: { workloads: ["Multiple workloads"] } }).totals.count, 2);
    const endpoint = buildActivityAnalytics(records).rows.find(row => row.targetCount > 1).endpoint.id;
    const scoped = buildActivityAnalytics(records, { filters: { endpoints: [endpoint], outcomes: ["partial"] } });
    assert.equal(scoped.resultFacet.totals.count, 2);
    assert.equal(scoped.totals.count, 2);
});

test("API returned results retain their own outcome facet, not parent tool outcomes", () => {
    const records = source();
    const baseline = buildActivityAnalytics(records, { layer: "reported-api" });
    assert.equal(baseline.totals.count, 32, "Eight canonical calls with four returned units each");
    for (const result of OUTCOMES) {
        const selected = buildActivityAnalytics(records, { layer: "reported-api", filters: { outcomes: [result] } });
        assert.deepEqual(selected.resultFacet.totals, baseline.totals);
        assert.equal(selected.totals.count, baseline.totals[result]);
        reconcile(selected);
    }
    const failed = buildActivityAnalytics(records, { layer: "reported-api", filters: { outcomes: ["failure"] } });
    assert.equal(failed.totals.count, 8, "Error result units, not the two failed parent calls");
    assert.equal(failed.apiCoverage.eligibleToolCalls, 8);
});

test("undated and empty outcome slices reconcile without fabricated timeline records", () => {
    const records = source();
    for (const record of records) {
        delete record.capturedAt;
        delete record.toolCalls[0].startedAt;
    }
    const selected = buildActivityAnalytics(records, { filters: { outcomes: ["success"] } });
    assert.equal(selected.timeSeries.undatedCount, 2);
    reconcile(selected);
    const empty = buildActivityAnalytics(records, { filters: { projectIds: ["missing"], outcomes: ["failure"] } });
    assert.equal(empty.resultFacet.totals.count, 0);
    assert.equal(empty.totals.count, 0);
    reconcile(empty);
});
