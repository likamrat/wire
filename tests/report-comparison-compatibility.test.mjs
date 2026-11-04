import test from "node:test";
import assert from "node:assert/strict";
import { restoreOneSidedMetricDisplay } from "../lib/report-comparison-compatibility.mjs";
import { adaptReportMetric } from "../lib/report-facts.mjs";
import { normalizeMetricFact } from "../lib/report-metric-comparison.mjs";
import { makeSnapshot, makeRatio, id } from "./assessment-contract-fixtures.mjs";

const hash = "f".repeat(64);
function sourceMetric(personal) {
    const metric = makeRatio(0, personal ? 1 : 0, personal ? 0 : 1);
    return {
        ...metric,
        metricRef: id("metric", personal ? 2 : 1),
        dimension: "accuracy", checkId: "semantic-answer-correctness",
        origin: personal ? "user-personal" : "automatic-local",
        eligibleUnitRefs: [id("interaction")],
        coveredUnitRefs: personal ? [id("interaction")] : [],
    };
}
function example(side, personal = true) {
    const metric = sourceMetric(personal), comparisonKey = adaptReportMetric(metric).comparisonKey;
    const baseline = { bundleId: "export-a", snapshotHash: "a".repeat(64) }, later = { bundleId: "export-b", snapshotHash: "b".repeat(64) };
    const snapshots = [makeSnapshot(), makeSnapshot()];
    snapshots[0].metrics = side === "baseline" ? [metric] : [];
    snapshots[1].metrics = side === "later" ? [metric] : [];
    const comparison = {
        schemaVersion: 1, status: "ready", baseline, later, toolComparison: null,
        narrative: { heading: "Frozen narrative", detail: "Do not recompute this text.", tone: "neutral" },
        metrics: [{
            metric: "accuracy", comparisonKey, status: "unavailable",
            reason: side === "baseline" ? "later-metric-not-saved" : "baseline-metric-not-saved", delta: null,
        }],
    };
    return { metric, comparison, sources: [baseline, later].map((report, index) => ({ report: { ...report }, evaluationFacts: snapshots[index], legacyFacts: null })) };
}

for (const side of ["baseline", "later"]) for (const personal of [true, false]) {
    test(`legacy ${personal ? "personal" : "automatic"} ${side} is restored only from its exact frozen source`, () => {
        const data = example(side, personal), before = structuredClone(data);
        const result = restoreOneSidedMetricDisplay(data.comparison, data.sources, hash);
        const row = result.comparison.metrics[0], missing = side === "baseline" ? "later" : "baseline";
        assert.deepEqual(row[side], normalizeMetricFact(adaptReportMetric(data.metric)));
        assert.equal(row[missing], null);
        assert.equal(row.status, "unavailable");
        assert.equal(row.delta, null);
        assert.deepEqual(result.comparison.narrative, data.comparison.narrative);
        assert.deepEqual(result.comparison.baseline, data.comparison.baseline);
        assert.deepEqual(result.comparison.later, data.comparison.later);
        assert.equal(result.displayCompatibility.restoredMetricCount, 1);
        assert.equal(result.displayCompatibility.storedComparisonHash, hash);
        assert.equal(result.displayCompatibility.savedFilesUnchanged, true);
        assert.match(result.displayCompatibility.message, /frozen source facts/);
        assert.deepEqual(data, before);
    });
}

for (const side of ["baseline", "later"]) test(`explicit null or unavailable ${side} values are never replaced`, () => {
    for (const retained of [null, { state: "unavailable", value: null, reason: "withheld" }]) {
        const data = example(side);
        data.comparison.metrics[0][side] = retained;
        const before = structuredClone(data.comparison);
        const result = restoreOneSidedMetricDisplay(data.comparison, data.sources, hash);
        assert.deepEqual(result.comparison, before);
        assert.equal(result.displayCompatibility, undefined);
    }
});

test("missing, invalid, or differently bound frozen proof stays unavailable", () => {
    for (const alter of [
        data => { data.sources[0].evaluationFacts = null; },
        data => { data.sources[0].evaluationFacts.schemaVersion = 99; },
        data => { data.sources[1].evaluationFacts = null; },
        data => { data.sources[0].report.snapshotHash = "c".repeat(64); },
        data => { data.sources[0].evaluationFacts.metrics[0].checkVersion = 99; },
        data => { data.sources[1].evaluationFacts.metrics = [structuredClone(data.metric)]; },
        data => { data.comparison.metrics[0].comparisonKey = "unknown-definition"; },
    ]) {
        const data = example("baseline");
        alter(data);
        const result = restoreOneSidedMetricDisplay(data.comparison, data.sources, hash);
        assert.equal(Object.hasOwn(result.comparison.metrics[0], "baseline"), false);
        assert.equal(result.comparison.metrics[0].delta, null);
        assert.equal(result.displayCompatibility.restoredMetricCount, 0);
        assert.equal(result.displayCompatibility.unavailableMetricCount, 1);
    }
});

test("an explicit null missing peer stays null when only the absent present-side summary is restored", () => {
    const data = example("baseline");
    data.comparison.metrics[0].later = null;
    const result = restoreOneSidedMetricDisplay(data.comparison, data.sources, hash);
    assert.equal(result.comparison.metrics[0].baseline.value, 0);
    assert.equal(result.comparison.metrics[0].later, null);
    assert.equal(result.comparison.metrics[0].delta, null);
});
