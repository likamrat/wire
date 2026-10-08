import test from "node:test";
import assert from "node:assert/strict";
import { compareMetricFacts } from "../lib/report-metric-comparison.mjs";

const fact = (overrides = {}) => ({
    metric: "accuracy", kind: "pass-rate", definitionId: "accuracy-checks", definitionVersion: 1,
    unit: "percent", basis: "automatic-assessment", aggregation: "pass-rate",
    boundary: "eligible-interactions", state: "available",
    coverage: { count: 50, eligible: 60 }, numerator: 42, denominator: 50,
    ...overrides,
});
const duration = (value, overrides = {}) => fact({
    metric: "speed", kind: "duration", definitionId: "recorded-call-duration",
    unit: "ms", basis: "observed", aggregation: "median", boundary: "call-start-to-completion",
    numerator: undefined, denominator: undefined, value, ...overrides,
});
const cost = (value, overrides = {}) => fact({
    metric: "cost", kind: "cost", definitionId: "attributed-usage-cost",
    unit: "USD", basis: "estimated", aggregation: "mean-per-interaction",
    boundary: "recorded-priced-usage", numerator: undefined, denominator: undefined, value, ...overrides,
});

test("assessed accuracy uses assessed denominator, with selected coverage separate", () => {
    const result = compareMetricFacts(fact(), fact({ numerator: 45 }));
    assert.equal(result.status, "comparable");
    assert.equal(result.baseline.value, 84);
    assert.equal(result.later.value, 90);
    assert.equal(result.delta.value, 6);
    assert.equal(result.delta.unit, "percentage-points");
    assert.deepEqual(result.baseline.coverage, { count: 50, eligible: 60, missing: 10 });
    assert.ok(result.warnings.includes("partial-coverage"));
    assert.equal(result.interpretation, "higher-is-better");
});

test("unequal denominators are compared as shares, never raw pass-count changes", () => {
    const result = compareMetricFacts(
        fact({ numerator: 9, denominator: 10, coverage: { count: 10, eligible: 10 } }),
        fact({ numerator: 80, denominator: 100, coverage: { count: 100, eligible: 100 } }),
    );
    assert.equal(result.delta.value, -10);
    assert.equal(result.delta.direction, "down");
});

test("answer and action trust cannot be blended or compared to each other", () => {
    const a = fact({ metric: "answer-trust", definitionId: "answer-support-checks" });
    const b = fact({ metric: "action-trust", definitionId: "authorization-checks" });
    const result = compareMetricFacts(a, b);
    assert.equal(result.status, "incompatible");
    assert.ok(result.mismatches.includes("metric"));
    assert.equal(result.delta, null);
});

test("changed rubric, evaluator basis, aggregation or measurement boundary blocks a delta", () => {
    for (const patch of [
        { definitionVersion: 2 }, { definitionId: "another-check-set" },
        { basis: "user-assessment" }, { boundary: "returned-api-results" },
    ]) {
        const result = compareMetricFacts(fact(), fact(patch));
        assert.equal(result.status, "incompatible");
        assert.equal(result.delta, null);
    }
    const changedStatistic = compareMetricFacts(duration(100), duration(80, { aggregation: "p95" }));
    assert.equal(changedStatistic.status, "incompatible");
    assert.ok(changedStatistic.mismatches.includes("aggregation"));
});

test("recorded duration delta retains its boundary and unit", () => {
    const result = compareMetricFacts(duration(1250), duration(950));
    assert.equal(result.delta.value, -300);
    assert.equal(result.delta.unit, "ms");
    assert.equal(result.interpretation, "lower-is-better");
    assert.equal(result.boundary, "call-start-to-completion");
    assert.equal(Object.hasOwn(result, "taskLatency"), false);
});

test("call duration and task wall time are not interchangeable", () => {
    const result = compareMetricFacts(duration(100), duration(100, { boundary: "user-request-to-final-response" }));
    assert.equal(result.status, "incompatible");
    assert.equal(result.delta, null);
});

test("cost compares only matching currencies, definitions and measured/estimated basis", () => {
    const measured = cost(0.02, { basis: "observed" });
    assert.equal(compareMetricFacts(measured, cost(0.01)).status, "incompatible");
    assert.equal(compareMetricFacts(cost(0.02), cost(0.01, { unit: "EUR" })).status, "incompatible");
    assert.equal(compareMetricFacts(cost(0.02), cost(0.01, { definitionVersion: 2 })).status, "incompatible");
    const same = compareMetricFacts(cost(0.02), cost(0.01));
    assert.equal(same.delta.value, -0.01);
    assert.equal(same.delta.unit, "USD");
    assert.equal(same.interpretation, "lower-is-better");
});

test("missing scores or unknown pricing stay unavailable, not zero or free", () => {
    const result = compareMetricFacts(cost(0.01), cost(undefined, {
        state: "unavailable", reason: "usage-not-attributable", coverage: { count: 0, eligible: 60 },
    }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.later.value, null);
    assert.equal(result.later.reason, "usage-not-attributable");
    assert.equal(result.delta, null);
});

test("verified zero cost is allowed and distinguishable from unavailable cost", () => {
    const result = compareMetricFacts(cost(0.01), cost(0));
    assert.equal(result.status, "comparable");
    assert.equal(result.later.value, 0);
    assert.equal(result.later.state, "available");
});

test("declining coverage is visible beside numerical improvement", () => {
    const result = compareMetricFacts(
        fact({ numerator: 40, denominator: 50, coverage: { count: 50, eligible: 50 } }),
        fact({ numerator: 9, denominator: 10, coverage: { count: 10, eligible: 50 } }),
    );
    assert.equal(result.delta.value, 10);
    assert.ok(result.warnings.includes("coverage-decreased"));
    assert.ok(result.warnings.includes("partial-coverage"));
    assert.equal(Object.hasOwn(result, "improved"), false);
});

test("malformed counts, missing values and inconsistent denominators fail explicitly", () => {
    for (const invalid of [
        fact({ numerator: 51 }),
        fact({ denominator: 49 }),
        fact({ numerator: -1 }),
        fact({ numerator: 1.5 }),
        fact({ denominator: 0, numerator: 0, coverage: { count: 0, eligible: 10 } }),
        fact({ coverage: { count: 51, eligible: 50 } }),
        duration(-1), duration(Number.NaN), duration(undefined),
        cost(Infinity), cost(1, { unit: "money" }),
    ]) assert.throws(() => compareMetricFacts(fact(), invalid), TypeError);
});

test("unavailable states require a reason and do not carry a hidden number", () => {
    assert.throws(() => compareMetricFacts(fact(), fact({ state: "unavailable", reason: undefined })), /reason/);
    assert.throws(() => compareMetricFacts(cost(1), cost(1, { state: "unavailable", reason: "missing" })), /unavailable.*value/i);
});

test("caller inputs remain unchanged", () => {
    const a = fact(), b = fact({ numerator: 45 });
    const before = structuredClone([a, b]);
    Object.freeze(a.coverage);
    Object.freeze(b.coverage);
    Object.freeze(a);
    Object.freeze(b);
    compareMetricFacts(a, b);
    assert.deepEqual([a, b], before);
});
