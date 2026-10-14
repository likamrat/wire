import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation, createTimingPresentation } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { makeDuration, id } from "./assessment-contract-fixtures.mjs";

const presentation = createAssessmentPresentation(contract), timing = createTimingPresentation();
function metric(values, eligible = values.length, definitionId = "tool-duration", offset = 0) {
    const value = makeDuration(values, offset), definition = contract.DEFINITIONS[definitionId];
    Object.assign(value, { definitionId, boundary: definition.boundary, measurementBasis: definition.basis });
    value.eligibleUnitRefs = Array.from({ length: eligible }, (_, i) => id("record", offset + i + 1));
    value.coverage.eligible = eligible;
    value.observedTime.undatedUnits = eligible;
    return contract.validateMetric(value);
}

test("recorded timing reuses raw nearest ranks and keeps boundary populations separate", () => {
    const metrics = [
        metric([900000, 0, 1000, 2000], 5),
        metric([677960], 18, "recorded-response-duration", 20),
        metric([9, 20, 700], 4, "http-response-duration", 40),
        metric([30000, 60000], 2, "http-error-duration", 60),
    ];
    const before = structuredClone(metrics), rows = presentation.summarize(metrics).evidence.timing;
    assert.deepEqual(rows.map(row => [row.distribution.p50Ms, row.distribution.p95Ms, row.timed, row.eligible]),
        [[1000, 900000, 4, 5], [677960, 677960, 1, 18], [20, 700, 3, 4], [30000, 60000, 2, 2]]);
    assert.equal(rows[0].resultLabel, "Median 1 s; P95 15 min 0 s");
    assert.equal(rows[0].measurement.aggregation, "nearest-rank-p50");
    assert.equal(rows[1].coverageLabel, "1 of 18 requests timed");
    assert.equal(rows[1].display.median, "11 min 17.96 s");
    assert.equal(rows[1].display.state, "single");
    assert.match(rows[1].limitation, /One sample, not overall performance/);
    assert.match(rows[1].boundaryLabel, /not tool-call time/);
    assert.deepEqual(rows.map(row => row.measurement.boundary), metrics.map(value => value.boundary));
    assert.match(presentation.format(metrics[2]).details.join(" "), /P95: 700 ms/);
    assert.deepEqual(metrics, before);
});

test("missing, unknown and zero samples remain distinct without arbitrary sufficiency thresholds", () => {
    const summarize = createActivityProjection(null, null, ["unknown"]).summarize;
    for (const [values, timed, p50, p95] of [
        [[], 0, null, null], [[null, undefined, NaN, -1, Infinity], 0, null, null],
        [[0, null], 1, 0, 0], [[0, 0], 2, 0, 0], [[1, 500], 2, 1, 500],
    ]) {
        const summary = summarize(values.map(durationMs => ({ outcome: "unknown", durationMs }))).duration;
        const row = timing.fromSummary(summary, values.length, "tool-start-to-completion");
        assert.deepEqual([row.timed, row.distribution.p50Ms, row.distribution.p95Ms], [timed, p50, p95]);
        assert.equal(row.notTimed, values.length - timed);
        assert.equal(row.display.state, timed === 0 ? "missing" : timed === 1 ? "single" : "distribution");
        if (!timed) assert.equal(row.display.median, "Not measured");
        if (p50 === 0) assert.equal(row.display.median, "0 s");
    }
    const unknown = presentation.format(metric([], 18)).evidence;
    assert.equal(unknown.resultLabel, "Not measured");
    assert.equal(unknown.coverageLabel, "0 of 18 calls timed");
    assert.throws(() => timing.fromSummary({ sampleCount: 2, p50Ms: 1, p95Ms: 2 }, 1, "tool-start-to-completion"), /population/);
    assert.throws(() => timing.fromSummary({ sampleCount: 1, p50Ms: 1, p95Ms: 1 }, 1, "guessed-task-boundary"), /supported/);
});

test("human duration rounding crosses minute/hour boundaries without losing exact sample values", () => {
    for (const [value, text] of [[0.004, "<0.01 s"], [10, "0.01 s"], [59999, "1 min 0 s"],
        [3599999, "1 h 0 min 0 s"], [677960, "11 min 17.96 s"], [90061004, "25 h 1 min 1 s"]]) {
        const source = metric([value]), row = presentation.format(source);
        assert.equal(row.reading.value, text);
        assert.equal(row.evidence.measurement.value, value);
        assert.match(row.details.join(" "), new RegExp(`Single sample: ${String(value).replace(".", "\\.")} ms`));
        assert.equal(row.band, "neutral");
    }
});

test("compact screen duration keeps exact milliseconds and report formatting independent", () => {
    const screen = createTimingPresentation(undefined, { compact: true });
    for (const [milliseconds, displayed] of [[null, "Not measured"], [0, "0 s"], [0.004, "<0.01 s"],
        [9, "<0.01 s"], [10, "0.01 s"], [2955, "2.96 s"], [59994, "59.99 s"], [59995, "1:00 min"],
        [60000, "1:00 min"], [84892, "1:25 min"], [104000, "1:44 min"], [114090, "1:54 min"],
        [119499, "1:59 min"], [119500, "2:00 min"], [3599499, "59:59 min"], [3599500, "1:00:00 h"],
        [3600000, "1:00:00 h"], [90061004, "25:01:01 h"]]) {
        assert.equal(screen.duration(milliseconds), displayed);
        if (milliseconds === null) continue;
        const source = metric([milliseconds]), before = structuredClone(source), shown = screen.fromMetric(source);
        assert.equal(shown.display.median, displayed);
        assert.equal(shown.measurement.value, milliseconds);
        assert.deepEqual(source, before);
    }
    assert.equal(timing.duration(114090), "1 min 54.09 s", "Frozen/native presentation retains its precise format");
    for (const value of [undefined, NaN, Infinity, -1, "1000"]) assert.throws(() => screen.duration(value), TypeError);
});
