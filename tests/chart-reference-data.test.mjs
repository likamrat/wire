import test from "node:test";
import assert from "node:assert/strict";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { chartReferenceFacts } from "../web/chart-reference.mjs";
import { fixture } from "./helpers.mjs";

const projection = createActivityProjection(createTimeContext(), createServiceCategories(), Object.keys(createRecordedResults().labels("tool")));

test("reference groupings reuse the exact accepted rows and native chart group identities", () => {
    const record = fixture("reference-groups"), base = record.toolCalls[0];
    record.toolCalls = [
        { ...base, toolCallId: "single-mail", startEventId: "single-mail-start",
            requestedApiPath: "/me/messages", requestArgs: { entityUrls: ["/me/messages"] } },
        { ...base, toolCallId: "multi-target", startEventId: "multi-target-start",
            requestedApiPath: undefined, requestArgs: { entityUrls: ["/me/messages", "/me/calendar"] } },
        { ...base, toolCallId: "excluded-result", startEventId: "excluded-result-start",
            toolSucceeded: false, reportedOutcome: "failed" },
    ];
    const options = { filters: { scope: "history", outcomes: ["success"] } };
    const accepted = buildActivityAnalytics([record], { ...options, groupBy: "workload" });
    const original = structuredClone(accepted.rows);
    const exact = projection.groupRows(accepted.rows, "endpoint");
    const native = buildActivityAnalytics([record], { ...options, groupBy: "endpoint" });
    assert.deepEqual(exact, native.groups);
    assert.deepEqual(projection.groupRows(accepted.rows, "workload"), accepted.workloadGroups);
    assert.equal(exact.reduce((sum, group) => sum + group.total, 0), accepted.totals.count);
    assert.deepEqual(new Set(exact.flatMap(group => group.drilldownIds)), new Set(accepted.rows.map(row => row.id)));
    assert.equal(accepted.totals.count, 2, "A multi-target call remains one call; excluded results are not reintroduced");
    assert.deepEqual(accepted.rows, original);
});

test("an unsupported exact-data grouping cannot silently become API paths", () => {
    assert.throws(() => projection.groupRows([], "unknown"), TypeError);
});

test("the guide receives immutable display facts, not private payloads or membership arrays", () => {
    const records = [fixture("reference-facts")], analytics = buildActivityAnalytics(records);
    const charts = createPercentageCharts({ categories: createServiceCategories(), results: createRecordedResults() });
    const model = { ...charts.model(analytics), models: charts.modelUsage(records), privatePrompt: "EXCLUDED_PRIVATE_PROMPT" };
    model.separateUnits = true;
    analytics.privateQuery = "EXCLUDED_PRIVATE_QUERY";
    const result = chartReferenceFacts(analytics, model);
    assert.equal(result.model.total, analytics.totals.count);
    assert.equal(result.model.separateUnits, true, "Source-defined units must survive the immutable guide projection");
    assert.deepEqual(result.facts.categories, analytics.workloadGroups.map(group => group.label));
    assert.equal(result.model.models.total, 1);
    assert.equal(Object.isFrozen(result.model.services.recordedRows), true);
    assert.doesNotMatch(JSON.stringify(result), /EXCLUDED_PRIVATE|drilldownIds|interactionIds|scenarioId|sourceSessionId/);
    assert.throws(() => { result.facts.totals.count = 40; }, TypeError);
    assert.equal(analytics.totals.count, 1);
    const serialized = Function(`return (${chartReferenceFacts.toString()})`)();
    assert.deepEqual(serialized(analytics, model), result);
});
