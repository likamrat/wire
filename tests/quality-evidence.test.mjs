import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation, createAssessmentWording, createTimingPresentation } from "../web/assessment-presentation.mjs";
import { createActivityProjection } from "../lib/activity-projection.mjs";
import { contract, quality, samples } from "./assessment-ui-fixtures.mjs";
import { buildAssessmentModel, buildReportFacts, assessmentDependencies, assessmentOverview } from "../lib/assessment-read-model.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { freezeEvaluationFacts } from "../lib/report-facts.mjs";
import { fixture } from "./helpers.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";

const presentation = createAssessmentPresentation(contract);
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

test("live and frozen projections preserve unsupported local observations without pretending a model ran", () => {
    const records = [fixture("quality-a"), fixture("quality-b")];
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records };
    const live = buildAssessmentModel(state).overview.metrics;
    const frozen = buildReportFacts(records, state).facts.metrics;
    for (const metrics of [live, frozen]) {
        const local = metrics.find(metric => metric.dimension === "accuracy");
        assert.deepEqual(local.unassessedReasons, [{ reason: "unsupported-check", count: 2 }]);
        const summary = presentation.summarize(metrics).evidence.quality.accuracy;
        assert.equal(summary.headline, "Quality not assessed");
        assert.equal(summary.rows.length, 0);
        assert.equal(summary.localObservations.length, 1);
        assert.equal(summary.eligible, 2);
        assert.match(summary.limitation, /Tool outcomes do not establish/);
    }
});

test("execution success uses all unique calls while quality uses only assessed requests", () => {
    const records = matrixRecords("quality-denominators", [...Array(199).fill("success"), ...Array(28).fill("failure"), "unknown"], {
        groups: 108, durations: [...Array(227).fill(41100), null],
    });
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records };
    const live = buildAssessmentModel(state).overview.metrics;
    const frozen = buildReportFacts(records, state).facts;
    for (const metrics of [live, frozen.metrics]) {
        const shown = presentation.summarize(metrics).evidence;
        const execution = shown.execution.find(row => row.kind === "execution");
        assert.equal(execution.headline, "199 of 228 calls succeeded");
        assert.deepEqual(execution.successShare, { value: 199 / 228, numerator: 199, denominator: 228 });
        assert.deepEqual(execution.coverage, { count: 227, eligible: 228, unit: "calls" });
        assert.equal(shown.quality.accuracy.assessed, 0);
        assert.equal(shown.quality.accuracy.eligible, 108);
        assert.deepEqual(shown.timing.find(row => row.provenance.definitionId === "tool-duration").coverage,
            { count: 227, eligible: 228, unit: "calls" });
        const qualityMetric = metrics.find(row => row.dimension === "accuracy");
        assert.equal(qualityMetric.value, null);
        assert.equal(qualityMetric.denominator, 0);
    }
    assert.equal(frozen.recordedOutcomes.filter(row => row.kind === "tool-call").length, 228);
});

test("actual read-model pooling preserves metric-specific verdicts and absent coverage across 108 requests", () => {
    const records = matrixRecords("quality-projection", Array(228).fill("success"), { groups: 108 });
    const source = { available: true, sourceConfigRef: samples.id("sourceconfig"), sourceConfigRevision: 1 };
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: records,
        personalEvaluation: { source, modelEvaluation: { records: [], grants: [], runs: [] } } };
    const original = buildAssessmentModel(state);
    const checkIds = { accuracy: "request-requirements-corroborated", "answer-trust": "recorded-answer-support", "action-trust": "action-intent-alignment" };
    for (const [index, verdicts] of [
        ["pass", "unassessed", "pass"], ["pass", "fail", "unassessed"],
    ].entries()) {
        const view = original.details.get(original.catalog[index].interactionRef);
        const record = original.internals.get(view.interaction.interactionRef).record;
        const grantRef = samples.id("grant", index + 1);
        const assessments = Object.entries(checkIds).map(([dimension, checkId], position) => {
            const verdict = verdicts[position];
            return {
                ...view.assessments.find(item => item.dimension === dimension),
                assessmentRef: samples.id("assessment", index * 3 + position + 1),
                origin: "model-assessed", checkId, verdict,
                reason: verdict === "unassessed" ? dimension === "action-trust" ? "not-applicable" : "missing-evidence" : null,
                evaluator: model().evaluator, evidenceRefs: [samples.id("evidence", index + 1)],
            };
        });
        state.personalEvaluation.modelEvaluation.grants.push({
            grantRef, state: "enabled", interactionRefs: [view.interaction.interactionRef],
            sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
        });
        state.personalEvaluation.modelEvaluation.records.push({
            interactionRef: view.interaction.interactionRef, grantRef, recordFingerprint: evaluationRecordFingerprint(record),
            dependencies: assessmentDependencies(view), assessments,
        });
    }
    const before = JSON.stringify(state), projected = buildAssessmentModel(state);
    for (const metrics of [projected.overview.metrics, buildReportFacts(records, state).facts.metrics]) {
        const byDimension = dimension => metrics.find(metric => metric.dimension === dimension && metric.origin === "model-assessed");
        assert.deepEqual(byDimension("accuracy").coverage, { covered: 2, eligible: 108 });
        assert.equal(byDimension("accuracy").value, 1);
        assert.deepEqual(byDimension("accuracy").unassessedReasons, [{ reason: "no-assessed-units", count: 106 }]);
        assert.deepEqual(byDimension("answer-trust").coverage, { covered: 1, eligible: 108 });
        assert.equal(byDimension("answer-trust").value, 0);
        assert.deepEqual(byDimension("answer-trust").unassessedReasons, [
            { reason: "missing-evidence", count: 1 }, { reason: "no-assessed-units", count: 106 },
        ]);
        assert.deepEqual(byDimension("action-trust").unassessedReasons, [
            { reason: "not-applicable", count: 1 }, { reason: "no-assessed-units", count: 106 },
        ]);
        const summary = presentation.summarize(metrics).evidence.quality;
        assert.equal(summary.accuracy.headline, "2 of 108 requests assessed");
        assert.equal(summary["answer-trust"].assessed, 1);
        assert.equal(summary["action-trust"].assessed, 1);
    }
    const subset = assessmentOverview(state, projected, projected.overview.interactionRefs.slice(0, 2));
    assert.deepEqual(subset.metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "model-assessed").coverage,
        { covered: 2, eligible: 2 });
    assert.equal(JSON.stringify(state), before, "Projection never writes ratings, attempts, permissions or source records");
    const firstRef = projected.overview.interactionRefs[0];
    state.personalEvaluation.modelEvaluation.runs.push({
        scope: [{ interactionRef: firstRef, recordFingerprint: evaluationRecordFingerprint(projected.internals.get(firstRef).record) }],
        phase: "failed", results: [{ interactionRef: firstRef, status: "failed" }],
    });
    const after = buildAssessmentModel(state).overview;
    const evidence = presentation.summarize(after.metrics, { assessmentAttempts: after.assessmentAttempts }).evidence;
    assert.equal(evidence.quality.accuracy.assessed, 2, "A later failed evaluator attempt cannot erase earlier applicable verdicts");
    assert.equal(evidence.quality.accuracy.rows[0].counts.fail, 0);
    assert.equal(evidence.assessmentAttempts.counts.failed, 1);
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

test("known failed and unfinished attempts remain separate, scoped and content-free in live and frozen summaries", () => {
    const records = matrixRecords("attempt-status", Array(5).fill("success"), { groups: 5 });
    const alias = { ...structuredClone(records[0]), scenarioId: "legacy-attempt-alias", isLegacy: true };
    const state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [...records, alias],
        personalEvaluation: { modelEvaluation: { records: [], grants: [], runs: [] } } };
    const initial = buildAssessmentModel(state), refs = initial.overview.interactionRefs;
    const scope = index => ({
        interactionRef: refs[index], recordFingerprint: evaluationRecordFingerprint(initial.internals.get(refs[index]).record),
    });
    state.personalEvaluation.modelEvaluation.runs.push(
        { scope: [scope(0), scope(1)], phase: "failed", results: [{ interactionRef: refs[0], status: "failed", reason: "PRIVATE_PROVIDER_ERROR" }] },
        { scope: [scope(2)], phase: "uncertain", results: [] },
        { scope: [scope(3)], phase: "running", results: [] },
    );
    const before = JSON.stringify(state), model = buildAssessmentModel(state);
    const frozen = buildReportFacts(state.evidence, state).facts;
    for (const projection of [model.overview, frozen]) {
        assert.equal(projection.assessmentAttempts.length, 5, "Aliased source rows do not duplicate attempt status");
        assert.doesNotMatch(JSON.stringify(projection.assessmentAttempts), /PRIVATE_|provider|reason|prompt/);
        const shown = presentation.summarize(projection.metrics, { assessmentAttempts: projection.assessmentAttempts }).evidence;
        assert.equal(shown.assessmentAttempts.status, "available");
        assert.deepEqual(shown.assessmentAttempts.coverage, { count: 5, eligible: 5, unit: "requests" });
        for (const state of ["failed", "not-run", "uncertain", "pending", "none"]) assert.equal(shown.assessmentAttempts.counts[state], 1);
        assert.equal(shown.quality.accuracy.assessed, 0);
        assert.ok(projection.metrics.filter(metric => metric.dimension === "accuracy")
            .every(metric => metric.counts.fail === 0 && metric.counts.evaluatorError === 0));
    }
    const subset = assessmentOverview(state, model, [refs[1], refs[4]]);
    const shown = presentation.summarize(subset.metrics, { assessmentAttempts: subset.assessmentAttempts }).evidence.assessmentAttempts;
    assert.equal(shown.counts.failed, 0);
    assert.equal(shown.counts.none, 1);
    assert.equal(shown.counts["not-run"], 1);
    assert.throws(() => presentation.summarize(subset.metrics, { assessmentAttempts: model.overview.assessmentAttempts }), /outside selected requests/);
    assert.throws(() => contract.validateAssessmentAttempts([subset.assessmentAttempts[0], subset.assessmentAttempts[0]]), /duplicate-identity/);
    assert.throws(() => contract.validateAssessmentAttempts([{ ...subset.assessmentAttempts[0], rawError: "PRIVATE" }]), /unexpected-or-missing-field/);
    assert.throws(() => freezeEvaluationFacts({ ...frozen, assessmentAttempts: [{ interactionRef: samples.id("interaction", 900), latestAttempt: "none" }] }), /attempt-outside-frozen-membership/);
    assert.equal(JSON.stringify(state), before);
});

test("legacy absence is unknown while observed no-attempt status and empty scope remain exact", () => {
    const record = fixture("legacy-status"), state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
    const facts = structuredClone(buildReportFacts(state.evidence, state).facts);
    const known = presentation.summarize(facts.metrics, { assessmentAttempts: facts.assessmentAttempts }).evidence.assessmentAttempts;
    assert.equal(known.counts.none, 1);
    assert.equal(known.counts.failed, 0);
    delete facts.assessmentAttempts;
    for (const metric of facts.metrics) delete metric.unassessedReasons;
    const before = JSON.stringify(facts), frozen = freezeEvaluationFacts(facts);
    const missing = presentation.summarize(frozen.metrics).evidence.assessmentAttempts;
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.counts, null);
    assert.equal(missing.coverage.count, null);
    assert.equal(JSON.stringify(frozen), before);
    const empty = presentation.summarize([], { assessmentAttempts: [] }).evidence.assessmentAttempts;
    assert.equal(empty.status, "available");
    assert.equal(empty.coverage.eligible, 0);
    assert.equal(empty.counts.failed, 0);
});
