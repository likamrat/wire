import test from "node:test";
import assert from "node:assert/strict";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createPromptAuthorship } from "../lib/prompt-authorship.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { createTimeContext } from "../lib/time.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createLocalSearch } from "../web/local-search.mjs";
import { createAnalysisSlice } from "../web/client.mjs";
import { createSearchMembership } from "../web/search-membership.mjs";
import { searchWireContract } from "../lib/search-wire-contract.mjs";
import { promptWidgetRecords } from "./prompt-widget-fixture.mjs";

const authorship = createPromptAuthorship(), charts = createPercentageCharts({ authorship });
const refine = createAnalysisSlice(createLocalSearch(), createActivityProjection(createTimeContext(),
    createServiceCategories(), Object.keys(createRecordedResults().labels("tool"))));
const records = promptWidgetRecords();
const options = { layer: "tool", groupBy: "workload", bucket: "day", limit: 1, timeContext: { timeZone: "UTC", locale: "en-US" }, filters: { scope: "all" } };
const snapshot = input => ({ revision: 7, scenarios: records, analytics: buildActivityAnalytics(records, input),
    requestActivity: buildRequestActivity(records) });
const counts = model => model.rows.map(row => row.count);

test("prompt shares partition complete canonical origins, not calls, aliases, follow-ups or available text", () => {
    const before = structuredClone(records), input = snapshot(options), slice = refine(input, options);
    const model = charts.authorUsage(slice.scenarios);
    assert.equal(input.analytics.totals.count, 36);
    assert.equal(input.analytics.visibleGroups.length, 1);
    assert.equal(model.total, 18);
    assert.deepEqual(model.rows.map(row => row.label), ["My prompts", "Agent prompts", "Author unverified"]);
    assert.deepEqual(counts(model), [6, 6, 6]);
    assert.deepEqual(model.rows.map(row => row.percentage), ["33.3%", "33.3%", "33.3%"]);
    assert.equal(model.rows.reduce((sum, row) => sum + row.fraction, 0), 1);
    assert.deepEqual(counts(charts.authorUsage(records)), [6, 6, 6]);
    assert.deepEqual(counts(charts.authorUsage([...records].reverse())), [6, 6, 6]);
    assert.deepEqual(counts(charts.authorUsage([records[3], records[4]])), [1, 1, 0],
        "Missing user text and an empty automatic continuation retain recorded authorship");
    const conflicting = { ...records[0], userPrompt: { ...records[0].userPrompt,
        authorship: { actor: "agent", basis: "source-agent" } } };
    for (const aliases of [[records[0], conflicting], [conflicting, records[0]]]) {
        assert.deepEqual(counts(charts.authorUsage(aliases)), [0, 0, 1]);
    }
    assert.deepEqual(records, before);
});

test("prompt counts use accepted date/service/tool/outcome/author and authorized action Search membership", () => {
    for (const [filters, expected] of [
        [{ from: "2026-10-14", to: "2026-10-14" }, [1, 1, 1]],
        [{ services: ["Mail"], outcomes: ["failure"], tools: ["workiq-fetch"] }, [2, 1, 1]],
        [{ promptAuthors: ["user", "agent"] }, [6, 6, 0]],
        [{ promptAuthors: ["unknown"] }, [0, 0, 6]],
        [{ from: "2020-01-01", to: "2020-01-02" }, [0, 0, 0]],
    ]) {
        const input = { ...options, filters: { ...options.filters, ...filters } };
        assert.deepEqual(counts(charts.authorUsage(refine(snapshot(input), input).scenarios)), expected);
    }
    const input = snapshot(options), row = input.analytics.rows.find(row => row.scenarioId === "prompt-widget-2");
    const receipt = { schemaVersion: searchWireContract.schemaVersion, panelId: "11111111-1111-4111-8111-111111111111",
        epoch: 0, requestId: 1, generation: 1, indexId: "1".repeat(64), mode: "text", purpose: "strict-match-population",
        queryPurpose: "analysis", queryTypes: [...searchWireContract.allTypes],
        matchPolicyId: searchWireContract.matchPolicyId, revision: input.revision };
    const hit = { type: "action", match: "text", target: { kind: "route",
        href: "#request?" + new URLSearchParams({ request: row.scenarioId, layer: "tool", call: row.id }) } };
    const membership = createSearchMembership(input, options, [], [hit], receipt, searchWireContract);
    const slice = refine(input, options, "", [], membership);
    assert.deepEqual(slice.rowIds, [row.id]);
    assert.deepEqual(counts(charts.authorUsage(slice.scenarios)), [0, 0, 1]);
    assert.throws(() => refine(input, options, "", [], { ...membership, revision: 6 }), /accepted analytical scope/);
    const empty = charts.authorUsage([]);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.rows.map(row => row.fraction), [null, null, null]);
    assert.deepEqual(empty.rows.map(row => row.percentage), ["Not applicable", "Not applicable", "Not applicable"]);
});

test("incompatible native conversations stay outside prompt shares and factory serialization retains the contract", () => {
    const native = { recordKind: "native-conversation", scenarioId: "native-context",
        userPrompt: { authorship: { actor: "user", basis: "source-user" } } };
    const model = charts.authorUsage([records[0], native, native], 4);
    assert.equal(model.total, 1);
    assert.equal(model.nativeConversations, 5);
    assert.deepEqual(counts(model), [1, 0, 0]);
    assert.equal(charts.authorUsage([native]).total, 0);
    const serialized = Function(`return (${createPercentageCharts.toString()})`)()({
        authorship: Function(`return (${createPromptAuthorship.toString()})`)()(),
    });
    assert.deepEqual(serialized.authorUsage(records), charts.authorUsage(records));
    assert.throws(() => charts.authorUsage(null), /matching interaction slice/);
    assert.throws(() => charts.authorUsage([{}]), /canonical scenario/);
});
