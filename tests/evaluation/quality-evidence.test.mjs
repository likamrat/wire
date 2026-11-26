import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation } from "../../web/assessment-presentation.mjs";
import { createActivityProjection } from "../../lib/activity-projection.mjs";
import { contract, quality, samples } from "./assessment-ui-fixtures.mjs";
import { buildAssessmentModel, buildReportFacts } from "../../lib/assessment-read-model.mjs";
import { matrixRecords } from "../reports/report-evidence-matrix-fixtures.mjs";

const presentation = createAssessmentPresentation(contract);

test("current reports count every attributable call; timing counts only calls with recorded durations", () => {
    const outcomes = [...Array(199).fill("success"), ...Array(28).fill("failure"), "unknown"];
    const records = matrixRecords("current-denominators", outcomes, { groups: 108, durations: [...Array(227).fill(41100), null] });
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records };
    const facts = buildReportFacts(records, state).facts;
    const calls = facts.recordedOutcomes.filter(row => row.kind === "tool-call");
    assert.equal(new Set(calls.map(row => row.memberRef)).size, 228);
    assert.equal(calls.filter(row => row.outcome === "success").length, 199);
    assert.equal(calls.filter(row => row.outcome === "failure").length, 28);
    for (const metrics of [facts.metrics, buildAssessmentModel(state).overview.metrics]) {
        assert.deepEqual(metrics.find(row => row.definitionId === "tool-duration").coverage, { covered: 227, eligible: 228 });
        assert.ok(metrics.every(row => row.dimension === "speed" && row.origin === "automatic-local"));
    }
    assert.equal(facts.memberships.length, 108);
    assert.deepEqual(facts.assessments, []);
});

test("historical missing attempt history is not a confirmed empty or unstarted review", () => {
    const metric = model("accuracy", { pass: 1, unassessed: 1 });
    const attempts = metric.eligibleUnitRefs.map((interactionRef, i) => ({ interactionRef, latestAttempt: i ? "none" : "failed" }));
    const read = options => presentation.summarize([metric], options).evidence.assessmentAttempts;
    assert.equal(read({}).counts, null);
    assert.equal(read({ assessmentAttempts: attempts }).counts.failed, 1);
    assert.equal(read({ assessmentAttempts: attempts }).counts.none, 1);
    assert.throws(() => contract.validateAssessmentAttempts([attempts[0], attempts[0]]), /duplicate/);
    const empty = presentation.summarize([], { assessmentAttempts: [] }).evidence.assessmentAttempts;
    assert.equal(empty.coverage.eligible, 0);
    assert.equal(empty.counts.failed, 0);
});
function model(dimension = "accuracy", options = {}) {
    const metric = quality(dimension, { personal: true, ...options });
    metric.origin = "model-assessed";
    metric.checkId = { accuracy: "request-requirements-corroborated", "answer-trust": "recorded-answer-support", "action-trust": "action-intent-alignment" }[dimension];
    metric.evaluator = { provider: "github-copilot", model: "invented-fixture", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 };
    return contract.validateMetric(metric);
}

test("coverage-first rows preserve 2/108 and never present 100% as overall quality", () => {
    const metric = model("accuracy", { pass: 2, unassessed: 106 }), before = structuredClone(metric);
    const row = presentation.format(metric).evidence;
    assert.equal(row.headline, "2 of 108 requests assessed");
    assert.equal(row.resultLabel, "2 passed; 0 failed");
    assert.equal(row.missingLabel, "106 requests not assessed");
    assert.deepEqual(row.coverage, { count: 2, eligible: 108, unit: "requests" });
    assert.equal(row.passShare.value, 1);
    assert.equal(row.passShare.label, "100% of assessed requests passed");
    assert.match(row.limitation, /not.*overall quality/i);
    assert.deepEqual(row.counts, { pass: 2, fail: 0, unassessed: 106, evaluatorError: 0 });
    assert.deepEqual(metric, before);
});

test("zero, all-assessed, actual failure, insufficient evidence and evaluator errors stay distinct", () => {
    const empty = presentation.format(model("accuracy", { unassessed: 18 })).evidence;
    assert.equal(empty.headline, "Quality not assessed");
    assert.equal(empty.resultLabel, "No pass or fail verdicts");
    assert.equal(empty.passShare.value, null);
    const all = presentation.format(model("accuracy", { pass: 17, fail: 1, unassessed: 0 })).evidence;
    assert.equal(all.headline, "All 18 requests assessed");
    assert.equal(all.resultLabel, "17 passed; 1 failed");
    assert.equal(all.notAssessed, 0);
    const failed = presentation.format(model("accuracy", { fail: 1, unassessed: 17 })).evidence;
    assert.equal(failed.passShare.value, 0);
    assert.equal(failed.resultLabel, "0 passed; 1 failed");
    const insufficient = model("accuracy", { unassessed: 18 });
    insufficient.reason = "missing-evidence";
    assert.equal(presentation.format(insufficient).evidence.unassessedReasons[0].label, "Not enough saved evidence");
    const error = model("accuracy", { unassessed: 18 });
    error.status = "evaluator-error"; error.reason = "evaluator-failure";
    error.counts = { pass: 0, fail: 0, unassessed: 0, evaluatorError: 18 };
    const shown = presentation.format(error).evidence;
    assert.equal(shown.counts.evaluatorError, 18);
    assert.match(shown.missingLabel, /18 evaluator errors/);
    assert.equal(shown.passShare.value, null);
    assert.equal(shown.counts.fail, 0);
});

test("pooled unassessed reasons survive measured and error neighbors without inventing missing reasons", () => {
    const measured = model("accuracy", { pass: 1, unassessed: 0 });
    measured.unassessedReasons = [];
    const insufficient = model("accuracy", { unassessed: 1, offset: 10 });
    insufficient.reason = "missing-evidence";
    insufficient.unassessedReasons = [{ reason: "missing-evidence", count: 1 }];
    const absent = model("accuracy", { unassessed: 1, offset: 20 });
    absent.unassessedReasons = [{ reason: "no-assessed-units", count: 1 }];
    const error = model("accuracy", { unassessed: 1, offset: 30 });
    error.status = "evaluator-error"; error.reason = "evaluator-failure";
    error.counts = { pass: 0, fail: 0, unassessed: 0, evaluatorError: 1 };
    error.unassessedReasons = [];
    const pooled = contract.poolMetrics([measured, insufficient, absent, error], samples.id("metric", 900), samples.at);
    assert.deepEqual(pooled.counts, { pass: 1, fail: 0, unassessed: 2, evaluatorError: 1 });
    assert.deepEqual(pooled.unassessedReasons, [
        { reason: "missing-evidence", count: 1 }, { reason: "no-assessed-units", count: 1 },
    ]);
    const shown = presentation.format(pooled).evidence;
    assert.equal(shown.unassessedReasons[0].count, 1);
    assert.equal(shown.counts.evaluatorError, 1);
    assert.throws(() => contract.validateMetric({ ...pooled, unassessedReasons: [{ reason: "missing-evidence", count: 3 }] }), /unassessed-reason-count/);
    const legacy = model("accuracy", { pass: 1, unassessed: 1, offset: 50 });
    const mixed = contract.poolMetrics([pooled, legacy], samples.id("metric", 901), samples.at);
    assert.deepEqual(mixed.unassessedReasons.at(-1), { reason: null, count: 1 });
});

test("mixed origins and rubrics count distinct assessed requests once without blending verdicts", () => {
    const first = model("accuracy", { pass: 2, unassessed: 106 });
    const second = structuredClone(first);
    second.evaluator.rubricVersion = 2;
    second.counts = { pass: 0, fail: 2, unassessed: 106, evaluatorError: 0 };
    second.numerator = 0; second.value = 0;
    const personal = quality("accuracy", { pass: 2, unassessed: 106, personal: true });
    const local = quality("accuracy", { unassessed: 108 });
    const summary = presentation.summarize([local, first, second, personal]).evidence.quality.accuracy;
    assert.deepEqual(summary.coverage, { count: 2, eligible: 108, unit: "requests" });
    assert.equal(summary.notAssessed, 106);
    assert.equal(summary.rows.length, 3);
    assert.equal(summary.localObservations.length, 1);
    assert.equal(summary.overlappingAssessments, true);
    assert.equal(summary.passShare, undefined, "Distinct assessment definitions must not be averaged");
    assert.deepEqual(summary.rows.map(row => row.passShare.value), [1, 0, 1]);
});

test("legacy mixed-reason pools remain unknown when presented or repooled without changing historical bytes", () => {
    const insufficient = model("accuracy", { unassessed: 1 });
    insufficient.reason = "missing-evidence";
    const inapplicable = model("accuracy", { unassessed: 1, offset: 10 });
    inapplicable.reason = "not-applicable";
    const legacy = contract.poolMetrics([insufficient, inapplicable], samples.id("metric", 910), samples.at);
    assert.equal(legacy.reason, "no-assessed-units");
    assert.equal(Object.hasOwn(legacy, "unassessedReasons"), false);
    const before = JSON.stringify(legacy);
    assert.deepEqual(presentation.format(legacy).evidence.unassessedReasons, [{
        reason: null, count: 2, label: "Reason not retained for these unassessed requests",
    }]);
    const measured = model("accuracy", { pass: 1, unassessed: 0, offset: 20 });
    measured.unassessedReasons = [];
    const repooled = contract.poolMetrics([legacy, measured], samples.id("metric", 911), samples.at);
    assert.deepEqual(repooled.unassessedReasons, [{ reason: null, count: 2 }]);
    assert.equal(repooled.value, 1);
    assert.equal(JSON.stringify(legacy), before);
    for (const metric of [insufficient, inapplicable]) {
        assert.equal(presentation.format(metric).evidence.unassessedReasons[0].reason, metric.reason);
        assert.deepEqual(contract.poolMetrics([metric, measured], samples.id("metric", 912), samples.at).unassessedReasons,
            [{ reason: metric.reason, count: 1 }]);
    }
    const explicit = { ...legacy, unassessedReasons: [{ reason: "no-assessed-units", count: 2 }] };
    assert.equal(presentation.format(explicit).evidence.unassessedReasons[0].reason, "no-assessed-units");
    assert.deepEqual(contract.poolMetrics([explicit, measured], samples.id("metric", 913), samples.at).unassessedReasons,
        [{ reason: "no-assessed-units", count: 2 }]);
});

test("metric-specific coverage never substitutes equal totals for equal memberships", () => {
    const accuracy = model("accuracy", { pass: 2, unassessed: 106 });
    const support = model("answer-trust", { pass: 1, unassessed: 107 });
    const action = model("action-trust", { pass: 2, unassessed: 106 });
    action.coveredUnitRefs = action.eligibleUnitRefs.slice(2, 4);
    const evidence = presentation.summarize([accuracy, support, action]).evidence;
    assert.equal(evidence.quality.accuracy.assessed, 2);
    assert.equal(evidence.quality["answer-trust"].assessed, 1);
    assert.equal(evidence.quality["action-trust"].assessed, 2);
    assert.match(evidence.quality["action-trust"].rows[0].limitation, /not.*permission/);
    assert.equal(evidence.overallScore, undefined);
});

test("timing states retain exact milliseconds and boundary-specific units with incomplete-sample warning", () => {
    const metric = samples.makeDuration([677960]);
    metric.definitionId = "recorded-response-duration";
    metric.boundary = contract.DEFINITIONS[metric.definitionId].boundary;
    metric.measurementBasis = contract.DEFINITIONS[metric.definitionId].basis;
    metric.eligibleUnitRefs = Array.from({ length: 18 }, (_, i) => samples.id("record", i + 1));
    metric.coverage.eligible = 18;
    metric.observedTime.undatedUnits = 18;
    const row = presentation.format(metric).evidence;
    assert.equal(row.headline, "1 of 18 requests timed");
    assert.deepEqual(row.coverage, { count: 1, eligible: 18, unit: "requests" });
    assert.deepEqual(row.measurement, { value: 677960, unit: "ms", aggregation: "nearest-rank-p50", boundary: metric.boundary });
    assert.match(row.limitation, /One sample, not overall performance/);
    assert.match(row.missingLabel, /17 requests/);
    assert.equal(presentation.format(samples.makeDuration([0])).evidence.measurement.value, 0);
    assert.equal(presentation.format(samples.makeDuration([])).evidence.measurement.value, null);
});

test("browser-serialized factory and server use exactly the same evidence model", () => {
    const browserFactory = Function(`
        const timing = (${createTimingPresentation.toString()})((${createActivityProjection.toString()})(null, null, ["unknown"]).summarize);
        const wording = (${createAssessmentWording.toString()})();
        return contract => (${createAssessmentPresentation.toString()})({ ...contract, timing, wording });
    `)();
    const metrics = [model("accuracy", { pass: 2, unassessed: 106 }), samples.makeDuration([41100])];
    assert.deepEqual(browserFactory(contract).summarize(metrics).evidence, presentation.summarize(metrics).evidence);
    assert.deepEqual(presentation.summarize([]).evidence.quality.accuracy.coverage,
        { count: null, eligible: null, unit: "requests" });
    assert.equal(presentation.format(model("accuracy", { unassessed: 0 })).evidence.headline, "No eligible requests");
});
