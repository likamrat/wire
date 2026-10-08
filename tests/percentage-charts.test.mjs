import test from "node:test";
import assert from "node:assert/strict";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { fixture } from "./helpers.mjs";

const charts = createPercentageCharts({ categories: createServiceCategories(), dimensional: createDimensionalCharts(), results: createRecordedResults() });
const entry = (id, count) => ({ id, label: id, count });
const sum = rows => rows.reduce((value, row) => value + row.count, 0);

test("percentages retain exact integer denominators, zero, one, tiny and near-complete shares", () => {
    for (const [value, total, text] of [[0, 0, "Not applicable"], [0, 1, "0%"], [1, 1, "100%"],
        [1, 3, "33.3%"], [2, 3, "66.7%"], [1, 1001, "<0.1%"], [10000, 10001, ">99.9%"],
        [1, Number.MAX_SAFE_INTEGER, "<0.1%"], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "100%"]]) {
        assert.equal(charts.percent(value, total), text);
        assert.equal(charts.share(value, total), total ? value / total : null);
    }
    const model = charts.partition([entry("tiny", 1), entry("large", Number.MAX_SAFE_INTEGER - 1)], Number.MAX_SAFE_INTEGER);
    assert.equal(sum(model.slices), Number.MAX_SAFE_INTEGER);
    assert.equal(model.slices.at(-1).end, 1);
    assert.ok(model.slices.find(row => row.id === "tiny").fraction > 0);
});

test("invalid percentages and nonpartitioning or duplicate groups fail explicitly", () => {
    for (const value of [NaN, Infinity, -1, .2, "2", Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => charts.percent(value, 4), TypeError);
        assert.throws(() => charts.percent(0, value), TypeError);
        assert.throws(() => charts.partition([entry("invalid", value)], 4), TypeError);
    }
    assert.throws(() => charts.percent(2, 1), RangeError);
    assert.throws(() => charts.partition([entry("a", 1)], 2), RangeError);
    assert.throws(() => charts.partition([entry("a", 1), entry("a", 1)], 2), TypeError);
    assert.throws(() => charts.partition([entry("group:other", 1)], 1), TypeError);
    assert.throws(() => charts.partition([entry("a", Number.MAX_SAFE_INTEGER), entry("b", 1)], Number.MAX_SAFE_INTEGER), TypeError);
    assert.throws(() => charts.partition([], 0, { maxSlices: 1 }), TypeError);
});

test("top five plus Other preserves unknown/mixed attribution, exact members and deterministic sorting", () => {
    const rows = Array.from({ length: 15 }, (_, index) => entry(`service-${index}`, index + 10));
    rows.push(entry("Unknown", 1), entry("Multiple workloads", 2), entry("zero", 0));
    const total = sum(rows), options = { preserve: ["Unknown", "Multiple workloads"] };
    const model = charts.partition(rows, total, options);
    assert.equal(model.slices.length, 6);
    assert.equal(sum(model.slices), total);
    assert.equal(sum(model.rows), total);
    assert.deepEqual(model, charts.partition([...rows].reverse(), total, options));
    assert.ok(model.slices.some(row => row.id === "Unknown"));
    assert.ok(model.slices.some(row => row.id === "Multiple workloads"));
    const other = model.slices.at(-1);
    assert.equal(other.id, "group:other");
    assert.equal(sum(other.members), other.count);
    assert.equal(new Set([...model.slices.slice(0, -1).map(row => row.id), ...other.members.map(row => row.id)]).size, rows.length - 1);
    assert.ok(model.rows.some(row => row.id === "zero" && row.percentage === "0%"));
    assert.equal(model.slices.at(-1).end, 1);
    for (const row of model.slices) assert.ok(Math.abs((row.end - row.start) - row.count / total) < 1e-15);
    assert.throws(() => charts.partition(rows, total, { preserve: rows.map(row => row.id) }), RangeError);
});

test("top annuli retain unrounded circular angles before the donut projection", () => {
    assert.match(charts.arc(0, 1), / 104A104 104 0 1 1/);
    assert.equal((charts.arc(0, 1).match(/A/g) || []).length, 4);
    assert.equal((charts.arc(0, .25).match(/A/g) || []).length, 2);
    assert.match(charts.arc(0, .25), /A104 104 0 0 1 -104 /);
    assert.match(charts.arc(0, .75), /A104 104 0 1 1/);
    assert.notEqual(charts.arc(0, .000001), charts.arc(0, .001));
    for (const args of [[0, 0], [-1, .5], [0, 1.1], [NaN, 1], [0, 1, 20, 20], [0, 1, Infinity, 2]]) assert.throws(() => charts.arc(...args), RangeError);
});

test("ring camera opens the annulus without roll or changing the columns, with one contained fixed extrusion", () => {
    const column = createDimensionalCharts().layout({ total: 1, maximum: 1, service: "Unknown" }), f = charts.frame();
    assert.equal(column.rise / column.frontWidth, .18);
    assert.ok(column.depthY > 0);
    assert.equal(f.shear, 0);
    assert.equal(f.compression, .68);
    assert.ok(f.compression / .46846153846153843 > 1.4, "Top ellipse remains appreciably less foreshortened");
    assert.ok(Math.abs(f.compression - .72) <= .04 + Number.EPSILON, "Pitch adjustment stays subtle");
    assert.equal(f.depth, 22);
    assert.ok(f.depth < f.inner * f.compression, "Rear inner walls do not swallow the hole");
    for (const fraction of [0, .000001, ...Array.from({ length: 361 }, (_, i) => i / 360)]) {
        const top = charts.point(f.outer, fraction), bottom = charts.point(f.outer, fraction, f.depth);
        assert.equal(top.x, bottom.x);
        assert.ok(Math.abs((bottom.y - top.y) * f.compression - f.depth) < 1e-12);
        for (const p of [top, bottom]) {
            assert.ok(p.x + f.cx > 0 && p.x + f.cx < f.width);
            const y = f.cy + f.shear * p.x + f.compression * p.y;
            assert.ok(y > 0 && y < f.height);
        }
    }
});

test("visible walls split at silhouette boundaries without hidden rear exteriors, missing seams or inflated tiny slices", () => {
    for (const values of [[1], [1, 1], [1, 3], [3, 1], [1, 999999], [999999, 1], Array(24).fill(1)]) {
        const data = charts.partition(values.map((value, i) => entry(`segment-${i}`, value)), sum(values.map(count => ({ count }))), { maxSlices: Math.max(2, values.length) });
        const all = data.slices.map(slice => ({ slice, ...charts.surfaces(slice.start, slice.end) }));
        assert.ok(all.every(g => g.depth === 22));
        assert.ok(Math.abs(all.flatMap(g => g.outer).reduce((n, p) => n + p.end - p.start, 0) - .5) < 1e-14);
        assert.ok(Math.abs(all.flatMap(g => g.inner).reduce((n, p) => n + p.end - p.start, 0) - .5) < 1e-14);
        for (const g of all) {
            assert.ok(g.top.length > 0);
            for (const face of [...g.outer, ...g.inner]) {
                assert.ok(face.start >= g.slice.start && face.end <= g.slice.end && face.end > face.start);
                assert.equal(/NaN|Infinity/.test(face.d), false);
            }
            for (const face of g.inner) assert.ok(face.start >= .25 && face.end <= .75);
            for (const face of g.outer) assert.ok(face.end <= .25 || face.start >= .75);
        }
    }
    const tiny = charts.surfaces(.999999, 1);
    assert.equal(tiny.outer.length, 1);
    assert.equal(tiny.outer[0].start, .999999);
    assert.equal(tiny.inner.length, 0);
    assert.notEqual(tiny.top, charts.surfaces(.999, 1).top);
    assert.deepEqual(charts.partition([], 0).slices, []);
});

function records() {
    const record = fixture("percentage-units");
    const source = record.toolCalls[0];
    record.toolCalls = [
        { ...source, toolCallId: "multi", startEventId: "multi-start", requestArgs: { entityUrls: ["/me/messages", "/me/calendar"] } },
        { ...source, toolCallId: "failed", startEventId: "failed-start", toolSucceeded: false },
        { ...source, toolCallId: "missing", startEventId: "missing-start", toolSucceeded: undefined, reportedOutcome: undefined, requestArgs: {}, requestedApiPath: undefined },
        { ...source, tool: "workiq-retrieve", toolCallId: "partial", startEventId: "partial-start", reportedOutcome: "partial" },
    ];
    const alias = structuredClone(record);
    alias.scenarioId = "percentage-alias"; alias.isLegacy = true;
    return [record, alias];
}

test("canonical deduplication and multi-target identity retain one call in every partition", () => {
    const source = records(), before = structuredClone(source), analytics = buildActivityAnalytics(source, { filters: { scope: "all" }, limit: 1 });
    const model = charts.model(analytics);
    assert.equal(model.total, 4);
    for (const dimension of ["outcomes", "services", "tools"]) {
        assert.equal(sum(model[dimension].slices), 4);
        assert.equal(sum(model[dimension].rows), 4);
        assert.ok(Math.abs(model[dimension].slices.reduce((value, row) => value + row.fraction, 0) - 1) < 1e-15);
    }
    assert.deepEqual(Object.fromEntries(model.outcomes.rows.map(row => [row.id, row.count])), {
        failure: 1, partial: 1, success: 1, unknown: 1, other: 0, transport: 0,
    });
    assert.equal(model.services.rows.find(row => row.id === "Multiple workloads").count, 1);
    assert.equal(model.services.rows.find(row => row.id === "Unknown").count, 1);
    assert.equal(analytics.visibleGroups.length, 1);
    assert.ok(model.services.rows.length > 1, "Percentages ignore paginated/group-limited chart presentation");
    assert.deepEqual(model, charts.model(buildActivityAnalytics([...source].reverse(), { filters: { scope: "all" } })));
    assert.deepEqual(source, before);
});

test("applied outcome/service/chat/date scopes stay canonical; empty and undated calls remain truthful", () => {
    for (const filters of [{ outcomes: ["failure"] }, { workloads: ["Multiple workloads"] }, { sourceSessionIds: ["test-session"] },
        { from: "2026-09-30", to: "2026-09-30" }, { sourceSessionIds: ["none"] }]) {
        const analytics = buildActivityAnalytics(records(), { filters, timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" } });
        const model = charts.model(analytics);
        assert.equal(model.total, analytics.totals.count);
        for (const dimension of ["outcomes", "services", "tools"]) assert.equal(sum(model[dimension].slices), model.total);
        if (!model.total) assert.equal(model.outcomes.slices.length, 0);
    }
    const [undated] = records();
    delete undated.capturedAt;
    const a = buildActivityAnalytics([undated]), model = charts.model(a);
    assert.equal(a.timeSeries.undatedCount, model.total);
    assert.equal(model.total, 4, "Percentage denominator includes undated eligible calls unlike dated columns");
});

test("API result rows and code references never become a Work IQ/Graph execution pie", () => {
    const record = fixture("api-many");
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 403 }, { index: 2 }];
    const calls = charts.model(buildActivityAnalytics([record]));
    const results = charts.model(buildActivityAnalytics([record], { layer: "reported-api" }));
    assert.equal(calls.total, 1); assert.equal(results.total, 3);
    assert.equal(results.unit, "tool-returned API results");
    const events = [
        { id: "message", type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "Synthetic graph references" } },
        { id: "start", type: "tool.execution_start", timestamp: "2026-09-30T12:00:01Z", data: {
            toolName: "powershell", toolCallId: "graph-command", arguments: { command: 'curl https://graph.microsoft.com/v1.0/me/messages' },
        } },
    ];
    const graph = extractGraphActivities(events, { sessionId: "synthetic-graph" }).scenarios;
    for (const layer of ["direct-request", "recorded-http", "code-reference", "http"]) {
        const a = buildActivityAnalytics([...graph, record], { layer }), m = charts.model(a);
        assert.equal(m.total, a.totals.count);
        assert.notEqual(m.unit, "Work IQ tool calls");
        assert.equal(sum(m.outcomes.slices), a.rows.length);
    }
    const referenceEvents = structuredClone(events);
    referenceEvents[1].data.arguments.command = "git diff # https://graph.microsoft.com/v1.0/me/messages";
    const references = extractGraphActivities(referenceEvents, { sessionId: "synthetic-reference" }).scenarios;
    const ref = charts.model(buildActivityAnalytics(references, { layer: "code-reference" }));
    assert.equal(ref.total, 1);
    assert.equal(ref.outcomes.slices[0].id, "unknown");
    assert.equal(ref.outcomes.slices[0].label, "Execution not observed");
});

test("numeric status, other status and transport outcomes retain their own percentages", () => {
    const record = fixture("api-statuses");
    record.toolCalls[0].apiResults = [{ index: 0, statusCode: 204 }, { index: 1, statusCode: 302 }, { index: 2, statusCode: 500 }, { index: 3 }];
    const api = charts.model(buildActivityAnalytics([record], { layer: "reported-api" }));
    assert.deepEqual(api.outcomes.slices.map(row => [row.id, row.percentage]).sort(),
        [["failure", "25%"], ["other", "25%"], ["success", "25%"], ["unknown", "25%"]]);
    const analytics = buildActivityAnalytics(records());
    analytics.layer = "http";
    const missing = analytics.rows.find(row => row.outcome === "unknown");
    missing.outcome = "transport";
    analytics.totals.unknown--; analytics.totals.transport++;
    const http = charts.model(analytics);
    assert.equal(http.unit, "owned HTTP records");
    assert.equal(http.outcomes.slices.find(row => row.id === "transport").percentage, "25%");
    assert.equal(http.outcomes.rows.find(row => row.id === "success").label, "HTTP 2xx");
});

test("malformed or stale canonical summaries cannot silently replace the chart", () => {
    const analytics = buildActivityAnalytics(records());
    for (const change of [
        a => { a.rows.push(a.rows[0]); },
        a => { a.rows[0].outcome = "invented"; },
        a => { a.workloadGroups.pop(); },
        a => { a.workloadGroups[0].total++; },
        a => { a.totals.count++; },
        a => { a.rows[0].workload = "unaccounted"; },
    ]) {
        const bad = structuredClone(analytics); change(bad);
        assert.throws(() => charts.model(bad), { name: /TypeError|RangeError/ });
    }
    const missingTool = structuredClone(analytics);
    missingTool.rows[0].tool = null;
    assert.equal(charts.model(missingTool).tools.rows.find(row => row.label === "Tool not identified").count, 1);
});

test("factory survives browser serialization without imports or ambient state", () => {
    const standalone = Function(`return (${createPercentageCharts.toString()})`)()({
        categories: createServiceCategories(), dimensional: createDimensionalCharts(), results: createRecordedResults(),
    });
    assert.deepEqual(standalone.model(buildActivityAnalytics(records())), charts.model(buildActivityAnalytics(records())));
});
