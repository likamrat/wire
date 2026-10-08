import test from "node:test";
import assert from "node:assert/strict";
import { compareToolOutcomeRows, describeToolOutcomeComparison } from "../lib/report-outcome-comparison.mjs";

// Isolated software fixtures, never collected as personal evaluation evidence.
const row = (id, patternId, outcome = "success") => ({ id, patternId, outcome });
const calls = (prefix, patternId, succeeded, failed = 0, unknown = 0, partial = 0) =>
    ["success", "failure", "unknown", "partial"].flatMap((outcome, index) =>
        Array.from({ length: [succeeded, failed, unknown, partial][index] }, (_, n) => row(`${prefix}-${outcome}-${n}`, patternId, outcome)));
const same = { identityRelation: "same-namespace" };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("all outcome buckets remain in the displayed rate denominator", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 80, 12, 5, 3), calls("b", "mail", 85, 8, 5, 2), same);
    assert.equal(result.raw.baseline.count, 100);
    assert.deepEqual(result.raw.baseline.successRate, { numerator: 80, denominator: 100, percent: 80 });
    assert.deepEqual(result.raw.baseline.binaryOutcomeCoverage, { numerator: 92, denominator: 100, percent: 92 });
    assert.equal(result.raw.baseline.partial, 3);
    assert.equal(result.raw.baseline.unknown, 5);
    near(result.matched.change.success, 5);
    near(result.matched.change.failure, -4);
    assert.equal(result.canDescribeRecordedChange, true);
});

test("traffic mix cannot masquerade as changed per-pattern performance", () => {
    const baseline = [...calls("a-easy", "easy", 90, 10), ...calls("a-hard", "hard", 50, 50)];
    const later = [...calls("b-easy", "easy", 810, 90), ...calls("b-hard", "hard", 50, 50)];
    const result = compareToolOutcomeRows(baseline, later, same);
    near(result.raw.change.success, 16);
    assert.equal(result.matched.mixChanged, true);
    near(result.matched.fixedBaselineMix.baseline.success, 70);
    near(result.matched.fixedBaselineMix.later.success, 70);
    near(result.matched.fixedBaselineMix.change.success, 0);
    assert.ok(result.patterns.every(pattern => pattern.change.success === 0));
    assert.ok(result.warnings.includes("traffic-mix-changed"));
});

test("new and absent patterns stay visible without invented zero failure rates", () => {
    const result = compareToolOutcomeRows(
        [...calls("a", "matched", 8, 2), ...calls("old", "absent", 3, 7)],
        [...calls("b", "matched", 9, 1), ...calls("new", "new", 2, 8)],
        same,
    );
    const absent = result.patterns.find(pattern => pattern.patternId === "absent");
    const added = result.patterns.find(pattern => pattern.patternId === "new");
    assert.equal(absent.presence, "baseline-only");
    assert.equal(absent.later.failureRate.percent, null);
    assert.equal(absent.change.failure, null);
    assert.equal(added.presence, "later-only");
    assert.equal(added.baseline.count, 0);
    assert.equal(added.change.failure, null);
    assert.equal(result.matched.patternCount, 1);
    assert.equal(result.matched.baseline.count, 10);
    assert.equal(result.matched.later.count, 10);
    assert.equal(result.matched.baselineCoverage.percent, 50);
    near(result.matched.change.failure, -10);
});

test("all-unknown evidence is not counted as failed or binary-assessed", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 0, 0, 4), calls("b", "mail", 0, 0, 7), same);
    assert.equal(result.raw.baseline.failure, 0);
    assert.equal(result.raw.baseline.successRate.percent, 0);
    assert.equal(result.raw.baseline.binaryOutcomeCoverage.percent, 0);
    assert.equal(result.raw.baseline.unknown, 4);
    assert.ok(result.warnings.includes("no-binary-outcomes"));
    assert.equal(result.canDescribeRecordedChange, false);
});

test("empty samples return unavailable rates, not a zero score", () => {
    const empty = compareToolOutcomeRows([], [], same);
    assert.equal(empty.status, "unavailable");
    assert.equal(empty.reason, "empty-baseline");
    assert.equal(empty.raw.baseline.successRate.percent, null);
    assert.equal(empty.raw.change.success, null);
    assert.equal(empty.matched.fixedBaselineMix, null);
    const noLater = compareToolOutcomeRows([row("a", "mail")], [], same);
    assert.equal(noLater.reason, "empty-later");
});

test("single-call samples retain their exact counts without certainty claims", () => {
    const result = compareToolOutcomeRows([row("a", "mail", "failure")], [row("b", "mail")], same);
    assert.equal(result.raw.baseline.count, 1);
    assert.equal(result.raw.later.count, 1);
    assert.equal(result.matched.change.success, 100);
    assert.equal(Object.hasOwn(result, "significant"), false);
    assert.equal(Object.hasOwn(result, "confidence"), false);
});

test("duplicates count once within each report", () => {
    const source = row("same", "mail");
    const result = compareToolOutcomeRows([source, { ...source }], calls("later", "mail", 1), same);
    assert.equal(result.raw.baseline.count, 1);
    assert.deepEqual(result.duplicates, { baseline: 1, later: 0 });
    assert.ok(result.warnings.includes("duplicate-records"));
});

test("conflicting duplicates fail rather than selecting a favorable outcome", () => {
    assert.throws(() => compareToolOutcomeRows([row("a", "mail"), row("a", "mail", "failure")], [], same), /Conflicting.*identity/);
    assert.throws(() => compareToolOutcomeRows([row("a", "mail"), row("a", "calendar")], [], same), /Conflicting.*identity/);
});

test("same names across unverified namespaces never prove overlap or disjointness", () => {
    const result = compareToolOutcomeRows([row("a", "mail")], [row("a", "mail")]);
    assert.equal(result.overlap.verified, false);
    assert.equal(result.overlap.sharedCount, null);
    assert.equal(result.canDescribeRecordedChange, false);
    assert.ok(result.warnings.includes("overlap-unverified"));
    assert.equal(result.raw.baseline.count, 1);
    assert.equal(result.raw.later.count, 1);
});

test("overlap-dependent cohorts require explicit verified identity relation", () => {
    for (const cohort of ["non-overlapping", "later-additions"]) {
        const result = compareToolOutcomeRows([row("a", "mail")], [row("b", "mail")], { cohort });
        assert.equal(result.status, "unavailable");
        assert.equal(result.reason, "overlap-unverified");
        assert.equal(result.selected, null);
        assert.equal(result.matched, null);
        assert.equal(result.raw.baseline.count, 1);
    }
});

test("shared calls with updated outcomes are identified, not fresh performance", () => {
    const result = compareToolOutcomeRows([row("a", "mail", "unknown")], [row("a", "mail")], same);
    assert.equal(result.overlap.sharedCount, 1);
    assert.equal(result.overlap.changedCount, 1);
    assert.equal(result.canDescribeRecordedChange, false);
    assert.ok(result.warnings.includes("shared-outcomes-updated"));
    assert.equal(result.raw.change.success, 100);
});

test("explicit non-overlapping cohort excludes copied calls from both sides", () => {
    const result = compareToolOutcomeRows(
        [row("shared", "mail", "failure"), row("a", "mail", "failure")],
        [row("shared", "mail"), row("b", "mail")],
        { ...same, cohort: "non-overlapping" },
    );
    assert.equal(result.raw.baseline.count, 2);
    assert.equal(result.selected.baseline.count, 1);
    assert.equal(result.selected.later.count, 1);
    assert.equal(result.matched.change.success, 100);
    assert.equal(result.canDescribeRecordedChange, true);
    assert.equal(result.overlap.changedCount, 1);
});

test("cumulative later-additions mode preserves the original baseline", () => {
    const result = compareToolOutcomeRows(
        [row("a", "mail", "failure"), row("b", "mail")],
        [row("a", "mail", "failure"), row("b", "mail"), row("c", "mail"), row("d", "mail")],
        { ...same, cohort: "later-additions" },
    );
    assert.equal(result.selected.baseline.count, 2);
    assert.equal(result.selected.later.count, 2);
    assert.equal(result.raw.later.count, 4);
    assert.equal(result.matched.change.success, 50);
    assert.equal(result.canDescribeRecordedChange, false);
    assert.ok(result.warnings.includes("new-membership-not-execution-time"));
});

test("no matching patterns prevents a headline improvement verdict", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 0, 10), calls("b", "calendar", 10), same);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "no-matched-patterns");
    assert.equal(result.patterns.length, 2);
    assert.equal(result.matched.patternCount, 0);
    assert.equal(result.matched.change.success, null);
    assert.equal(result.matched.fixedBaselineMix, null);
    assert.equal(result.canDescribeRecordedChange, false);
});

test("less recorded failure accompanied by more unknown remains qualified", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 8, 2), calls("b", "mail", 8, 0, 2), same);
    assert.equal(result.matched.change.failure, -20);
    assert.equal(result.matched.change.success, 0);
    assert.ok(result.warnings.includes("unknown-share-increased"));
    assert.ok(result.warnings.includes("binary-outcome-coverage-decreased"));
    assert.equal(result.canDescribeRecordedChange, false);
});

test("unknown, partial, other and transport shares reconcile without blending", () => {
    const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
    const result = compareToolOutcomeRows(
        outcomes.map((outcome, index) => row(`a${index}`, "pattern", outcome)),
        outcomes.map((outcome, index) => row(`b${index}`, "pattern", outcome)),
        same,
    );
    assert.equal(result.raw.baseline.count, 6);
    assert.equal(outcomes.reduce((total, outcome) => total + result.raw.baseline[outcome], 0), 6);
    assert.ok(outcomes.every(outcome => result.matched.change[outcome] === 0));
});

test("deterministic order and frozen caller inputs survive comparison", () => {
    const baseline = calls("a", "z", 2, 1).concat(calls("a2", "a", 1, 1));
    const later = calls("b", "z", 2, 0, 1).concat(calls("b2", "a", 2));
    const before = structuredClone({ baseline, later });
    baseline.forEach(Object.freeze);
    later.forEach(Object.freeze);
    Object.freeze(baseline);
    Object.freeze(later);
    const result = compareToolOutcomeRows(baseline, later, same);
    assert.deepEqual(result, compareToolOutcomeRows([...baseline].reverse(), [...later].reverse(), same));
    assert.deepEqual({ baseline, later }, before);
    assert.deepEqual(result.patterns.map(pattern => pattern.patternId), ["a", "z"]);
});

test("malformed identities, outcomes and options fail explicitly", () => {
    for (const value of [null, {}, [null], [row("", "x")], [row("x", "")], [row("x", "mail", "reviewed")]]) {
        assert.throws(() => compareToolOutcomeRows(value, [], same), /rows|identity|pattern|outcome/i);
    }
    assert.throws(() => compareToolOutcomeRows([], [], { identityRelation: "probably" }), /identityRelation/);
    assert.throws(() => compareToolOutcomeRows([], [], { cohort: "best-looking" }), /cohort/);
});

test("more unknown outcomes cannot hide behind a compensating partial decrease", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 7, 1, 0, 2), calls("b", "mail", 7, 1, 2, 0), same);
    assert.equal(result.raw.baseline.binaryOutcomeCoverage.percent, result.raw.later.binaryOutcomeCoverage.percent);
    assert.equal(result.canDescribeRecordedChange, false);
    assert.equal(describeToolOutcomeComparison(result).tone, "neutral");
});

test("the narrative prevents the traffic-mix example from claiming improvement", () => {
    const result = compareToolOutcomeRows(
        [...calls("a1", "easy", 90, 10), ...calls("a2", "hard", 50, 50)],
        [...calls("b1", "easy", 810, 90), ...calls("b2", "hard", 50, 50)], same,
    );
    const narrative = describeToolOutcomeComparison(result);
    assert.match(narrative.heading, /individual pattern rates did not/);
    assert.equal(narrative.tone, "neutral");
    assert.doesNotMatch(JSON.stringify(narrative), /team|fixed the|improved/);
});

test("the narrative uses failure share rather than fewer failures when volume grows", () => {
    const result = compareToolOutcomeRows(calls("a", "mail", 8, 2), calls("b", "mail", 90, 10), same);
    const narrative = describeToolOutcomeComparison(result);
    assert.equal(narrative.heading, "A smaller share of matched calls failed.");
    assert.equal(narrative.detail, "2 of 10 matched calls failed earlier; 10 of 100 failed later.");
    assert.doesNotMatch(narrative.heading, /fewer calls/);
});

test("the narrative keeps regression visible beside improvements", () => {
    const result = compareToolOutcomeRows(
        [...calls("a1", "mail", 8, 2), ...calls("a2", "files", 9, 1)],
        [...calls("b1", "mail", 10), ...calls("b2", "files", 8, 2)], same,
    );
    const narrative = describeToolOutcomeComparison(result);
    assert.equal(narrative.tone, "mixed");
    assert.match(narrative.detail, /1 matched pattern had a lower failure share; 1 had a higher/);
});

test("unverified overlap and cumulative membership cannot receive a positive period narrative", () => {
    const unverified = compareToolOutcomeRows(calls("a", "mail", 0, 5), calls("b", "mail", 5));
    assert.match(describeToolOutcomeComparison(unverified).detail, /Overlap is unverified/);
    const cumulative = compareToolOutcomeRows(
        calls("a", "mail", 0, 5), [...calls("a", "mail", 0, 5), ...calls("b", "mail", 5)],
        { ...same, cohort: "later-additions" },
    );
    const narrative = describeToolOutcomeComparison(cumulative);
    assert.equal(narrative.tone, "neutral");
    assert.match(narrative.detail, /does not establish when a call executed/);
});
