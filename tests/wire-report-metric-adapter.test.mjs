import test from "node:test";
import assert from "node:assert/strict";
import * as contract from "../lib/assessment-contract.mjs";
import { makeRatio, makeDuration, makeCost, id } from "./report-comparison-fixtures.mjs";
import { createWireMetricAdapter } from "../lib/wire-report-metric-adapter.mjs";
import { compareMetricFacts } from "../lib/report-metric-comparison.mjs";

const adapt = createWireMetricAdapter(contract);
function accuracy(pass, fail, unknown, origin = "user-personal") {
    const metric = makeRatio(pass, fail, unknown);
    metric.dimension = "accuracy";
    metric.checkId = "semantic-answer-correctness";
    metric.origin = origin;
    metric.eligibleUnitRefs = metric.eligibleUnitRefs.map((_, index) => id("interaction", index + 1));
    metric.coveredUnitRefs = metric.eligibleUnitRefs.slice(0, metric.coverage.covered);
    if (origin === "automatic-local") metric.reason = "unsupported-check";
    return metric;
}

test("backend ratios become percentage points without treating unassessed as failure", () => {
    const baseline = adapt(accuracy(8, 2, 2)), later = adapt(accuracy(9, 1, 2));
    const result = compareMetricFacts(baseline, later);
    assert.equal(result.baseline.value, 80);
    assert.equal(result.delta.value, 10);
    assert.deepEqual(result.baseline.coverage, { count: 10, eligible: 12, missing: 2 });
    assert.deepEqual(result.baseline.counts, { pass: 8, fail: 2, unassessed: 2, evaluatorError: 0 });
    assert.equal(result.baseline.basis, "user-assessment");
});

test("unsupported automatic semantics stay unassessed despite an available answer", () => {
    const a = adapt(accuracy(0, 0, 12, "automatic-local"));
    const result = compareMetricFacts(a, a);
    assert.equal(result.status, "unavailable");
    assert.equal(result.baseline.reason, "unsupported-check");
    assert.equal(result.baseline.value, null);
    assert.equal(result.baseline.counts.unassessed, 12);
});

test("recorded tool success cannot be relabeled as accuracy", () => {
    assert.throws(() => adapt(makeRatio(9, 1)), /Execution and evidence-availability/);
    assert.throws(() => adapt({ ...makeRatio(9, 1), dimension: "accuracy" }), /check-definition-mismatch/);
});

test("backend timing boundaries survive unchanged", () => {
    const result = compareMetricFacts(adapt(makeDuration([100, 200, 300])), adapt(makeDuration([50, 100, 150])));
    assert.equal(result.boundary, "tool-start-to-completion");
    assert.equal(result.delta.value, -100);
    assert.equal(result.baseline.aggregation, "median");
    assert.equal(result.baseline.qualifiers.measurementBasis, "retained-event-timestamps");
});

test("history/consent/override revision differences are provenance, not changed metric definitions", () => {
    const baseline = makeDuration([1000]), later = makeDuration([900]);
    later.basis.sourceRevision++;
    later.basis.overrideRevision++;
    const result = compareMetricFacts(adapt(baseline), adapt(later));
    assert.equal(result.status, "comparable");
    assert.equal(result.delta.value, -100);
});

test("unknown and unpriced cost do not inherit a false zero or observed-pricing basis", () => {
    const result = compareMetricFacts(adapt(makeCost("estimated")), adapt(makeCost("unpriced")));
    assert.equal(result.status, "unavailable");
    assert.equal(result.later.value, null);
    assert.equal(result.later.reason, "pricing-unavailable");
    assert.equal(result.later.basis, "not-established");
});

test("cost remains attributed total, not invented cost per task", () => {
    const baseline = makeCost("estimated"), later = makeCost("estimated");
    later.value = 0.2;
    const result = compareMetricFacts(adapt(baseline), adapt(later));
    assert.equal(result.status, "comparable");
    assert.equal(result.baseline.aggregation, "total");
    assert.equal(result.interpretation, "total-cost-only");
});

test("pricing reference or version differences block a cost comparison", () => {
    const baseline = makeCost("estimated"), later = makeCost("estimated");
    later.pricing.version = 2;
    const result = compareMetricFacts(adapt(baseline), adapt(later));
    assert.equal(result.status, "incompatible");
    assert.ok(result.mismatches.includes("qualifiers"));
    assert.equal(result.delta, null);
});

test("backend-owned cost partitions retain distinct comparison identities", () => {
    const measured = makeCost("measured"), estimated = makeCost("estimated"), unpriced = makeCost("unpriced");
    const secondPrice = makeCost("estimated");
    secondPrice.pricing.version = 2;
    const metrics = [measured, estimated, unpriced, secondPrice];
    const adapted = metrics.map(adapt);
    assert.equal(new Set(adapted.map(metric => metric.comparisonKey)).size, 4);
    assert.deepEqual(adapted.map(metric => metric.comparisonKey), metrics.map(contract.metricSlotKey));
});

test("adapters do not expose raw source times, private references, or transient deletion metadata", () => {
    const metric = makeDuration([1000]), before = structuredClone(metric);
    const result = adapt(metric);
    for (const key of ["observedTime", "evidenceRefs", "eligibleUnitRefs", "createdAt", "sourceRef", "sourceRevision", "deletionEpoch"]) {
        assert.equal(Object.hasOwn(result, key), false);
    }
    assert.deepEqual(metric, before);
});
