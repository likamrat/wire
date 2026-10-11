import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { assessmentOverview, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { contract, quality } from "./assessment-ui-fixtures.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";

const presentation = createAssessmentPresentation(contract);
const text = findings => JSON.stringify(findings);
const present = view => presentation.summarize(view.metrics, {
    singleInteraction: true, reviewStatus: view.reviewStatus,
});
const detail = (model, id) => model.details.get(model.catalog.find(row => row.scenarioId === id).interactionRef);

test("source-supported failure and positive answer findings stay separate across changed requests", () => {
    const { records } = retainedContextFixture();
    const { state, model } = qualityDisplayFixture({ records: records.slice(0, 2), judgments: ["fail", "pass"] });
    const before = JSON.stringify(state);
    const earlier = present(detail(model, records[0].scenarioId)), later = present(detail(model, records[1].scenarioId));
    assert.match(text(earlier.findings), /sign-in was required for the recorded call/);
    assert.match(text(earlier.findings), /answer not correct/);
    assert.match(text(later.findings), /answer correct/);
    assert.doesNotMatch(text(later.findings), /sign-in was required|answer not correct|two documents/);
    for (const summary of [earlier, later]) {
        assert.match(summary.findings.scope, /original request group/);
        assert.match(summary.findings.rationale, /reasons.*not retained/);
        assert.match(summary.findings.qualification, /not proof of human permission/);
    }
    assert.equal(JSON.stringify(state), before);
});

test("a failed lookup can coexist with a positive saved explanatory-answer assessment", () => {
    const { records } = retainedContextFixture();
    const { model } = qualityDisplayFixture({ records: [records[0]], judgments: ["pass"] });
    const result = present([...model.details.values()][0]);
    assert.match(text(result.findings.operational), /1 of 1 recorded call failed/);
    assert.match(text(result.findings.answers), /AI assessment: answer correct/);
    assert.equal(result.evidence.quality.accuracy.rows[0].passShare.value, 1);
    assert.doesNotMatch(text(result.findings), /request failed|answer failed|currently.*sign/);
});

test("read-only selected overview carries exact status refs without altering metrics or frozen facts", () => {
    const { records } = retainedContextFixture();
    const { state, model } = qualityDisplayFixture({ records: records.slice(0, 2), judgments: ["fail", "pass"] });
    const before = JSON.stringify(state);
    const refs = model.overview.interactionRefs;
    for (const chosen of [refs, [refs[1]], [refs[0]], []]) {
        const overview = assessmentOverview(state, model, chosen);
        assert.deepEqual(overview.reviewStatuses.map(row => row.interactionRef), chosen);
        const legacy = presentation.summarize(overview.metrics, { assessmentAttempts: overview.assessmentAttempts });
        const current = presentation.summarize(overview.metrics, overview);
        assert.deepEqual(current.evidence, legacy.evidence);
        assert.deepEqual(current.groups, legacy.groups);
        assert.equal(/sign-in was required/.test(text(current.findings)), chosen.includes(refs[0]));
        assert.equal(/call-status context is unavailable/.test(text(current.findings)), false);
    }
    const frozen = buildReportFacts(records.slice(0, 2), state).facts;
    assert.equal(Object.hasOwn(frozen, "reviewStatuses"), false);
    assert.equal(Object.hasOwn(frozen, "findings"), false);
    assert.equal(JSON.stringify(state), before);
    const duplicate = [model.overview.reviewStatuses[0], model.overview.reviewStatuses[0]];
    assert.throws(() => presentation.summarize(model.overview.metrics, { reviewStatuses: duplicate }), /duplicated/);
    assert.throws(() => presentation.summarize(detail(model, records[1].scenarioId).metrics, {
        reviewStatuses: [model.overview.reviewStatuses[0]],
    }), /outside selected/);
    const malformed = structuredClone(model.overview.reviewStatuses);
    malformed[0].reviewStatus.execution.failed++;
    assert.throws(() => presentation.summarize(model.overview.metrics, { reviewStatuses: malformed }), /invalid-execution/);
    const mismatch = structuredClone(model.overview.reviewStatuses);
    mismatch[0].reviewStatus.execution = { calls: 1, succeeded: 1, failed: 0, other: 0, causes: [] };
    assert.throws(() => presentation.summarize(model.overview.metrics, { reviewStatuses: mismatch }), /full selected call population/);
});

test("success without assessment, insufficient evidence and failed evaluator remain distinct", () => {
    const { records } = retainedContextFixture();
    const success = records[1];
    for (const [judgments, expected] of [
        [[], /No saved answer or action assessment/],
        [["unassessed"], /Insufficient recorded evidence/],
        [["error"], /evaluator could not complete; this is not a failed answer/],
    ]) {
        const { model } = qualityDisplayFixture({ records: [success], judgments });
        const result = present([...model.details.values()][0]);
        assert.match(text(result.findings), expected);
        assert.doesNotMatch(text(result.findings), /answer not correct|sign-in was required/);
        assert.equal(result.evidence.quality.accuracy.assessed, 0);
        assert.equal(result.findings.rationale, "");
    }
});

test("unknown legacy reasons, inapplicable checks and evaluator-error metrics never invent semantics", () => {
    const { model } = qualityDisplayFixture({ requests: 2, calls: 2, judgments: ["pass", "unassessed"] });
    const metric = structuredClone(model.overview.metrics.find(row => row.origin === "model-assessed" && row.dimension === "accuracy"));
    delete metric.unassessedReasons;
    const result = presentation.summarize([metric]);
    assert.match(text(result.findings), /Reason not retained for these unassessed requests/);
    assert.match(text(result.findings), /Detailed call-status context is unavailable/);
    assert.doesNotMatch(text(result.findings), /Insufficient recorded evidence/);
    const unassessed = quality("accuracy", { personal: true, unassessed: 1 });
    unassessed.reason = "not-applicable";
    assert.match(text(presentation.summarize([unassessed]).findings), /Check not applicable/);
    unassessed.status = "evaluator-error"; unassessed.reason = "evaluator-failure";
    unassessed.counts = { pass: 0, fail: 0, unassessed: 0, evaluatorError: 1 };
    assert.match(text(presentation.summarize([unassessed]).findings), /Evaluator error, not a failed/);
});

test("opposed origins and rubrics retain independent findings and deduplicated coverage", () => {
    const personal = quality("accuracy", { personal: true, fail: 1, unassessed: 2 });
    const model = structuredClone(personal);
    model.origin = "model-assessed"; model.checkId = "request-requirements-corroborated";
    model.counts = { pass: 1, fail: 0, unassessed: 2, evaluatorError: 0 }; model.numerator = 1; model.value = 1;
    model.evaluator = { provider: "github-copilot", model: "invented", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 };
    const otherRubric = structuredClone(model);
    otherRubric.evaluator.rubricVersion = 2;
    const metrics = [personal, model, otherRubric], before = structuredClone(metrics);
    const summary = presentation.summarize(metrics);
    assert.equal(summary.evidence.quality.accuracy.assessed, 1);
    assert.equal(summary.evidence.quality.accuracy.rows.length, 3);
    assert.match(text(summary.findings), /Your feedback: answer not correct in 1 request/);
    assert.match(text(summary.findings), /AI assessment: answer correct in 1 request/);
    assert.deepEqual(summary.evidence.quality.accuracy.rows.map(row => row.passShare.value), [0, 1, 1]);
    assert.deepEqual(metrics, before);
});

test("qualified timeout, denial and excluded cause signals remain historical and content-free", () => {
    const { records } = retainedContextFixture();
    for (const [signal, expected] of [["request-timeout", /reported an MCP request timeout/], ["access-denial", /error mentions access denial/]]) {
        const record = structuredClone(records[0]);
        record.toolCalls[0].failureEvidence.messageSignal = signal;
        record.toolCalls[0].failureEvidence.privateMessage = "PRIVATE_ERROR_PROSE";
        const { model } = qualityDisplayFixture({ records: [record] });
        const shown = present([...model.details.values()][0]);
        assert.match(text(shown.findings), expected);
        assert.doesNotMatch(text(shown.findings), /HTTP 40|PRIVATE_|sign in|retry now/i);
    }
});
