import test from "node:test";
import assert from "node:assert/strict";
import { projectInteractionModels } from "../lib/interaction-model.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createAnalysisSlice } from "../web/client.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { modelRecords, modelNames, modelOptions } from "./model-widget-fixture.mjs";

const charts = createPercentageCharts();
const refine = createAnalysisSlice(createLocalSearch(), createActivityProjection(createTimeContext(),
    createServiceCategories(), Object.keys(createRecordedResults().labels("tool"))));
const identity = index => JSON.stringify([`model-chat-${index}`, `model-prompt-${index}`]);
const source = modelRecords();
function snapshot(options = modelOptions) {
    return { revision: 7, scenarios: projectInteractionModels(source), analytics: buildActivityAnalytics(source, options),
        requestActivity: buildRequestActivity(source) };
}
const values = model => Object.fromEntries(model.rows.map(row => [row.label, row.count]));

test("Model counts exact canonical interactions, not aliases, calls, responses or status labels", () => {
    const before = structuredClone(source), input = snapshot(), slice = refine(input, modelOptions);
    const model = charts.modelUsage(slice.scenarios);
    assert.equal(input.analytics.totals.count, 11);
    assert.equal(model.total, 9);
    assert.deepEqual(model.coverage, { recorded: 3, partial: 1, unavailable: 2, unverified: 2, conflicting: 1 });
    assert.deepEqual(values(model), { [modelNames[1]]: 2, [modelNames[0]]: 2, [modelNames[2]]: 1, [modelNames[3]]: 1 });
    assert.deepEqual(model.rows.find(row => row.id === modelNames[0]).interactionIds.sort(), [identity(0), identity(1)]);
    assert.deepEqual(model.rows.find(row => row.id === modelNames[1]).interactionIds.sort(), [identity(1), identity(8)]);
    assert.deepEqual(charts.modelUsage(projectInteractionModels(source)), model, "Even explicit alias membership counts the interaction once");
    assert.doesNotMatch(JSON.stringify(model), /not-an-original-model|current-default|conflicting-model|Not recorded/);
    assert.deepEqual(source, before);
});

test("one accepted slice drives date, service, tool, author, outcome and Search intersections", () => {
    const cases = [
        [{ from: "2026-10-14", to: "2026-10-14" }, [0, 1, 5, 6]],
        [{ from: "2026-10-12", to: "2026-10-18" }, [0, 1, 2, 5, 6, 7, 8]],
        [{ from: "2026-10-01", to: "2026-10-31" }, [0, 1, 2, 4, 5, 6, 7, 8]],
        [{ services: ["Mail"], outcomes: ["failure"], promptAuthors: ["user"], tools: ["workiq-fetch"] }, [0]],
        [{ promptAuthors: ["agent"] }, [2]],
        [{ tools: ["workiq-get_schema"] }, [5]],
    ];
    for (const [filters, members] of cases) {
        const options = { ...modelOptions, filters: { scope: "history", ...filters } }, input = snapshot(options);
        const model = charts.modelUsage(refine(input, options).scenarios);
        assert.deepEqual(model.interactionIds.sort(), members.map(identity).sort());
        assert.equal(model.total, members.length);
    }
    const input = snapshot(), row = input.analytics.rows.find(row => row.scenarioId === "model-request-1");
    const receipt = { schemaVersion: 2, panelId: "11111111-1111-4111-8111-111111111111", epoch: 0, requestId: 1, generation: 1,
        indexId: "1".repeat(64), modelId: "2".repeat(64), mode: "lexical-only", purpose: "strict-match-population",
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes], matchPolicyId: searchWireContract.matchPolicyId, revision: input.revision };
    const hit = { type: "action", match: "exact", target: { kind: "route",
        href: "#request?" + new URLSearchParams({ request: row.scenarioId, layer: "tool", call: row.id }) } };
    const membership = createSearchMembership(input, modelOptions, [], [hit], receipt, searchWireContract);
    const slice = refine(input, modelOptions, "", [], membership);
    assert.deepEqual(slice.rowIds, [row.id]);
    const model = charts.modelUsage(slice.scenarios);
    assert.equal(model.total, 1);
    assert.deepEqual(values(model), { [modelNames[1]]: 1, [modelNames[0]]: 1 });
    assert.equal(model.rows.reduce((sum, row) => sum + row.fraction, 0), 2, "Overlapping models are not forced into a pie");
    const empty = createSearchMembership(input, modelOptions, [], [], receipt, searchWireContract);
    assert.deepEqual(charts.modelUsage(refine(input, modelOptions, "", [], empty).scenarios).rows, []);
    assert.throws(() => createSearchMembership(input, modelOptions, [], [hit], { ...receipt, revision: 6 }, searchWireContract), /current strict/);
    assert.equal(charts.modelUsage(refine(input, modelOptions, "no-invented-match").scenarios).total, 0);
    assert.equal(charts.modelUsage(refine(input, modelOptions).scenarios).total, 9);
    const serviceSlice = refine(input, modelOptions, "", ["Mail"]);
    assert.deepEqual(charts.modelUsage(serviceSlice.scenarios).interactionIds.sort(), [0, 2, 4, 6, 8].map(identity));
    const apiOptions = { ...modelOptions, layer: "reported-api" }, api = snapshot(apiOptions);
    assert.deepEqual(charts.modelUsage(refine(api, apiOptions).scenarios), charts.modelUsage(refine(input, modelOptions).scenarios),
        "Returned API entries keep the same whole-interaction models, not per-entry attribution");
});

test("Model projection rejects contradictory or malformed screen facts and serializes without closures", () => {
    const projected = projectInteractionModels(source);
    const standalone = Function(`return (${createPercentageCharts.toString()})`)()();
    assert.deepEqual(standalone.modelUsage(projected), charts.modelUsage(projected));
    assert.throws(() => charts.modelUsage([{ ...projected[0], originalModel: { status: "recorded", models: [] } }]), /validated/);
    assert.throws(() => charts.modelUsage([{ ...projected[0], originalModel: { status: "conflicting", models: ["guessed"] } }]), /validated/);
    assert.throws(() => charts.modelUsage([projected[0], { ...projected[0], originalModel: { status: "recorded", models: ["different"] } }]), /Aliases/);
});
