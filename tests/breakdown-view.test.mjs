import test from "node:test";
import assert from "node:assert/strict";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture } from "./helpers.mjs";

const categories = createServiceCategories();
const charts = createPercentageCharts({ dimensional: createDimensionalCharts(), categories, results: createRecordedResults() });
function records() {
    const source = fixture("breakdown");
    source.toolCalls = [
        ["workiq-fetch", ["/me/drive/root", "/me/messages", "/me/drive/root"]],
        ["workiq-fetch", ["/me/drive/root", "/unrecognized-resource"]],
        ["workiq-call_function", ["https://untrusted.example.invalid/me/drive/root"]],
        ["workiq-ask", []],
        ["workiq-get_schema", ["/me/drive/root"]],
        ["workiq-retrieve", []],
    ].map(([tool, paths], index) => ({
        tool, toolCallId: `breakdown-${index}`, startEventId: `start-${index}`,
        requestArgs: paths.length ? { entityUrls: paths } : {}, toolSucceeded: true,
    }));
    return [source, { ...structuredClone(source), scenarioId: "breakdown-alias", isLegacy: true }];
}

test("breakdowns use v1 overlapping associations, exact canonical IDs and distinct gaps/preparation", () => {
    const source = records(), original = structuredClone(source);
    const analytics = buildActivityAnalytics(source, { filters: { scope: "all" } }), model = charts.model(analytics);
    assert.equal(model.total, 6);
    assert.deepEqual(model.services.definition, categories.involvementDefinition);
    assert.deepEqual(model.services.rows.map(row => [row.id, row.count, row.percentage]),
        [["Files", 2, "33.3%"], ["Mail", 1, "16.7%"], ["Search", 1, "16.7%"]]);
    for (const row of model.services.rows) assert.deepEqual(row.drilldownIds,
        analytics.serviceInvolvement.groups.find(group => group.label === row.id).drilldownIds);
    assert.equal(model.services.missingDetailCount, 3);
    assert.equal(model.services.notApplicableCount, 1);
    assert.equal(model.services.partialCount, 1);
    assert.equal(model.services.purposeCount, 1);
    assert.deepEqual(model.services.gaps.map(row => [row.id, row.count]).sort(),
        [["hosted-routing", 1], ["unrecognized-path", 1], ["unsupported-target", 1]]);
    for (const key of ["tools", "outcomes", "categories"]) {
        assert.equal(model[key].rows.reduce((sum, row) => sum + row.count, 0), model.total);
    }
    assert.deepEqual(source, original);
});

test("flat exclusive rings preserve zero, tiny and extreme shares without readability inflation", () => {
    const frame = charts.frame();
    assert.equal(frame.width, frame.height);
    assert.equal(frame.depth, 0);
    assert.equal(frame.compression, 1);
    for (const counts of [[], [1], [0, 1], [1, 1000], [1, Number.MAX_SAFE_INTEGER - 1], [4, 3, 2, 1]]) {
        const total = counts.reduce((sum, value) => sum + value, 0);
        const data = charts.partition(counts.map((count, i) => ({ id: `row-${i}`, label: `Row ${i}`, count })), total);
        for (const slice of charts.visualSlices(data)) {
            assert.equal(slice.visualStart, slice.start);
            assert.equal(slice.visualEnd, slice.end);
            assert.equal(slice.visualFraction, slice.fraction);
            assert.doesNotMatch(charts.arc(slice.start, slice.end), /NaN|Infinity/);
        }
    }
});

test("service shares may exceed 100% in sum but never exceed the declared denominator individually", () => {
    const source = fixture("overlap-only");
    source.toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/me/messages"] };
    const data = charts.model(buildActivityAnalytics([source]));
    assert.equal(data.total, 1);
    assert.deepEqual(data.services.rows.map(row => [row.count, row.percentage]), [[1, "100%"], [1, "100%"]]);
    assert.equal(data.services.rows.reduce((sum, row) => sum + row.count, 0), 2);
    assert.equal(data.services.slices, undefined, "Overlapping services cannot be treated as a donut partition");
});

test("recorded-target presentation separates tool-purpose Search without changing canonical membership", () => {
    const source = fixture("mixed-search-basis");
    source.toolCalls = [
        { tool: "workiq-retrieve", toolCallId: "purpose", startEventId: "purpose-start", requestArgs: {}, toolSucceeded: true },
        { tool: "workiq-fetch", toolCallId: "recorded", startEventId: "recorded-start", requestArgs: { entityUrl: "/search/query" }, toolSucceeded: true },
        { tool: "workiq-fetch", toolCallId: "partial", startEventId: "partial-start",
            requestArgs: { entityUrls: ["/me/messages", "/unrecognized/resource", "/me/messages"] }, toolSucceeded: true },
    ];
    const analytics = buildActivityAnalytics([source]), data = charts.model(analytics).services;
    assert.equal(data.total, 3);
    assert.deepEqual(data.rows.map(row => [row.id, row.count]), [["Search", 2], ["Mail", 1]]);
    assert.deepEqual(data.recordedRows.map(row => [row.id, row.count, row.aggregateCount]), [["Mail", 1, 1], ["Search", 1, 2]]);
    const purpose = analytics.rows.filter(row => row.serviceAssociation.basis === "tool-purpose");
    const recorded = data.recordedRows.find(row => row.id === "Search");
    assert.deepEqual(new Set([...recorded.drilldownIds, ...purpose.map(row => row.id)]), new Set(data.rows[0].drilldownIds));
    assert.equal(recorded.percentage, "33.3%");
    assert.equal(data.purposeCount, 1); assert.equal(data.partialCount, 1); assert.equal(data.missingDetailCount, 1);
    assert.deepEqual(data.rows[0].drilldownIds, analytics.serviceInvolvement.groups.find(group => group.label === "Search").drilldownIds);
});

test("screen assistance uses exact targetless ask IDs and leaves other missing service evidence unchanged", () => {
    const source = fixture("assistance-screen");
    const call = (index, tool, paths) => ({
        tool, toolCallId: `assistance-${index}`, startEventId: `assistance-start-${index}`,
        requestArgs: paths ? { entityUrls: paths } : {}, toolSucceeded: true,
        apiResults: [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }],
    });
    source.toolCalls = [
        ...Array.from({ length: 20 }, (_, index) => call(index, "workiq-ask")),
        ...Array.from({ length: 4 }, (_, index) => call(index + 20, "workiq-fetch", ["/me/messages", "/me/drive/root", "/unrecognized/resource"])),
        call(24, "workiq-ask", ["/me/messages"]),
        call(25, "workiq-ask", ["/me/messages", "/unrecognized/resource"]),
        call(26, "workiq-ask", ["https://unsupported.example.invalid/target"]),
        call(27, "workiq-fetch"),
    ];
    const analytics = buildActivityAnalytics([source]), original = structuredClone(analytics), data = charts.model(analytics).services;
    assert.equal(data.assistance.count, 20);
    assert.equal(data.assistance.label, "Copilot assistance");
    assert.equal(data.assistance.endpointId, "operation:workiq-ask");
    assert.deepEqual(data.assistance.drilldownIds,
        analytics.rows.filter(row => row.endpoint.id === "operation:workiq-ask").map(row => row.id));
    const actual = buildActivityAnalytics([source], { filters: { endpoints: [data.assistance.endpointId] } });
    assert.deepEqual(new Set(actual.rows.map(row => row.id)), new Set(data.assistance.drilldownIds));
    assert.equal(data.unresolved.drilldownIds.length, 7);
    assert.equal(data.unresolved.partialCount, 5);
    assert.deepEqual(data.unresolved.gaps.map(row => [row.id, row.count]).sort(),
        [["missing-target", 1], ["unrecognized-path", 5], ["unsupported-target", 1]]);
    assert.equal(data.missingDetailCount, 27, "The frozen v1 meaning is unchanged");
    assert.equal(data.total, 28);
    assert.deepEqual(analytics, original);
    assert.equal(charts.model(buildActivityAnalytics([source], { layer: "reported-api" })).services.assistance.count, 0);
    assert.equal(charts.model(buildActivityAnalytics([], {})).services.assistance.count, 0);
    const mixedEndpoint = structuredClone(analytics);
    mixedEndpoint.rows.find(row => data.assistance.drilldownIds.includes(row.id)).serviceAssociation.gaps = [{
        reason: "missing-target", label: "No target recorded", description: "No service target is available in this recorded evidence.",
    }];
    const guarded = charts.model(mixedEndpoint).services;
    assert.equal(guarded.assistance.count, 19);
    assert.equal(guarded.assistance.endpointId, null, "A broader endpoint must not masquerade as an exact assistance link");
    assert.equal(guarded.unresolved.count, 8);
});

test("unknown service definitions, missing coverage and mismatched identities fail rather than imply attribution", () => {
    const data = buildActivityAnalytics(records());
    for (const mutate of [
        value => { value.serviceInvolvement.definition.version++; },
        value => { value.serviceInvolvement.definition.id = "exclusive-category"; },
        value => { value.serviceInvolvement.denominator++; },
        value => { value.serviceInvolvement.missingDetailCount++; },
        value => { value.serviceInvolvement.groups[0].drilldownIds[0] = "outside-cohort"; },
        value => { value.serviceInvolvement.groups.push(value.serviceInvolvement.groups[0]); },
        value => { delete value.rows[0].serviceAssociation; },
        value => { value.rows[0].serviceAssociation.services.push("Unknown"); },
        value => { delete value.rows[0].serviceAssociation.basis; },
        value => { value.rows[0].serviceAssociation.basis = "none"; },
    ]) {
        const invalid = structuredClone(data); mutate(invalid);
        assert.throws(() => charts.model(invalid), { name: /TypeError|RangeError/ });
    }
});
