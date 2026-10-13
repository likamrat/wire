import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { assessmentOverview, buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { contract, quality } from "./assessment-ui-fixtures.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { retainedContextFixture } from "./request-context-fixture.mjs";
import { fixture } from "./helpers.mjs";

const presentation = createAssessmentPresentation(contract);
const text = findings => JSON.stringify(findings);
const present = view => presentation.summarize(view.metrics, {
    singleInteraction: true, reviewStatus: view.reviewStatus,
});
const detail = (model, id) => model.details.get(model.catalog.find(row => row.scenarioId === id).interactionRef);

for (const succeeded of [true, false]) for (const completion of [false, true]) {
    test(`legacy completion boundary: ${succeeded ? "success" : "failure"}, completion ${completion ? "present" : "missing"}`, () => {
        const record = fixture("connection-recovery");
        record.userPrompt.sourceEventId = "invented-prompt";
        Object.assign(record.toolCalls[0], {
            startedAt: "2026-09-30T12:00:00Z", completedAt: "2026-09-30T12:00:01Z", durationMs: 1000,
            toolSucceeded: succeeded, reportedOutcome: succeeded ? "succeeded" : "failed",
            ...(completion ? { completionEventId: "invented-completion" } : {}),
        });
        const state = { revision: 1, evidenceRevision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
        const before = structuredClone(state), model = buildAssessmentModel(state);
        const view = [...model.details.values()][0];
        const execution = view.metrics.find(metric => metric.checkId === "recorded-tool-success");
        const metricsBefore = structuredClone(view.metrics);
        const frozenBefore = buildReportFacts([record], state, { preparedAt: "2026-10-11T09:00:00.000Z" }).facts;
        assert.equal(view.reviewStatus.execution[succeeded ? "succeeded" : "failed"], 1);
        assert.deepEqual(execution.counts, {
            pass: Number(completion && succeeded), fail: Number(completion && !succeeded),
            unassessed: Number(!completion), evaluatorError: 0,
        });
        assert.equal(execution.value, completion ? Number(succeeded) : null);
        assert.deepEqual(execution.unassessedReasons, completion ? [] : [{ reason: "missing-completion", count: 1 }]);
        assert.equal(view.metrics.find(metric => metric.definitionId === "tool-duration").value, 1000);
        assert.doesNotThrow(() => present(view), "Legitimate missing-completion records must retain findings and details");
        assert.doesNotThrow(() => presentation.summarize(model.overview.metrics, model.overview));
        const shown = present(view);
        assert.equal(shown.findings.operational[0].boundary, "reported-outcomes");
        assert.deepEqual(shown.findings.operational[0].counts, {
            calls: 1, succeeded: Number(succeeded), failed: Number(!succeeded), other: 0,
        });
        assert.match(shown.findings.operational[0].text, succeeded ? /Reported outcomes: 1 recorded call succeeded/ : /Reported outcomes: 1 of 1 recorded call failed/);
        const gaps = shown.findings.operational.filter(row => row.kind === "execution-gap");
        assert.equal(gaps.length, Number(!completion));
        if (!completion) {
            assert.equal(gaps[0].count, 1);
            assert.match(gaps[0].text, /completion event reference not retained/);
            assert.equal(Object.hasOwn(record.toolCalls[0], "completionEventId"), false);
        }
        assert.deepEqual(shown.evidence.execution[0].counts, execution.counts);
        assert.deepEqual(view.metrics, metricsBefore);
        assert.deepEqual(buildReportFacts([record], state, { preparedAt: "2026-10-11T09:00:00.000Z" }).facts, frozenBefore);
        assert.deepEqual(state, before);
    });
}

test("legacy boundary guards retain partial coverage and reject over-counted or opposed qualified facts", () => {
    const { state } = qualityDisplayFixture({ requests: 2, calls: 2, finalDuration: null });
    const [first, second] = state.evidence;
    delete first.toolCalls[0].completionEventId;
    Object.assign(first.toolCalls[0], {
        toolSucceeded: false, reportedOutcome: "failed",
        failureEvidence: { version: 1, reason: "error-code-recorded", messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
    });
    Object.assign(second.toolCalls[0], { toolSucceeded: true, reportedOutcome: "succeeded" });
    const { overview } = buildAssessmentModel(state);
    const partial = presentation.summarize(overview.metrics, { reviewStatuses: overview.reviewStatuses.slice(0, 1) });
    assert.equal(partial.findings.operational[0].boundary, "completion-evidence");
    assert.deepEqual(partial.findings.operational[0].counts, { calls: 2, succeeded: 1, failed: 0, other: 1 });
    assert.match(text(partial.findings), /context covers 1 of 2 requests and 1 of 2 calls/);
    assert.match(text(partial.findings), /sign-in was required/);
    assert.equal(partial.findings.operational.some(row => row.kind === "execution-gap"), false, "A partial population is not compared as a complete reported total");
    const overcounted = structuredClone(overview.reviewStatuses.slice(0, 1));
    Object.assign(overcounted[0].reviewStatus.execution, { calls: 3, succeeded: 2 });
    assert.throws(() => presentation.summarize(overview.metrics, { reviewStatuses: overcounted }), /full selected call population/);
    const opposed = structuredClone(overview.reviewStatuses.slice(0, 1));
    opposed[0].reviewStatus.execution = { calls: 2, succeeded: 0, failed: 2, other: 0, causes: [{ cause: "unqualified", count: 2 }] };
    assert.throws(() => presentation.summarize(overview.metrics, { reviewStatuses: opposed }), /Qualified results conflict/);
    const undercounted = structuredClone(overview.reviewStatuses);
    undercounted[0].reviewStatus.execution = { calls: 0, succeeded: 0, failed: 0, other: 0, causes: [] };
    assert.throws(() => presentation.summarize(overview.metrics, { reviewStatuses: undercounted }), /full selected call population/);
    const invalidCause = structuredClone(overview.reviewStatuses);
    invalidCause[0].reviewStatus.execution.causes[0].count++;
    assert.throws(() => presentation.summarize(overview.metrics, { reviewStatuses: invalidCause }), /invalid-execution-summary/);
    const legacyMetrics = structuredClone(overview.metrics);
    delete legacyMetrics.find(metric => metric.checkId === "recorded-tool-success").unassessedReasons;
    const legacy = presentation.summarize(legacyMetrics, overview);
    const gap = legacy.findings.operational.find(row => row.kind === "execution-gap");
    assert.match(gap.text, /reason not retained/);
    assert.doesNotMatch(gap.text, /completion event reference not retained/);
    assert.deepEqual(legacy.evidence.execution[0].counts, partial.evidence.execution[0].counts);
});

test("legacy reported success does not bypass nonbinary or invalid completion-evidence checks", () => {
    for (const [toolSucceeded, reportedOutcome, reason] of [
        [null, "succeeded", "no supported binary completion outcome"],
        [true, "failed", "execution-check error"],
    ]) {
        const record = fixture("legacy-qualified-boundary");
        Object.assign(record.toolCalls[0], { completionEventId: "invented-completion", toolSucceeded, reportedOutcome });
        const view = [...buildAssessmentModel({ revision: 1, pseudonymKey: "a".repeat(64), evidence: [record] }).details.values()][0];
        const result = present(view);
        assert.equal(view.reviewStatus.execution.succeeded, 1);
        assert.match(result.findings.operational.find(row => row.kind === "execution-gap").text, new RegExp(reason));
        assert.equal(result.evidence.execution[0].counts.pass, 0);
        assert.equal(result.evidence.execution[0].counts.fail, 0);
        assert.equal(result.evidence.execution[0].counts.evaluatorError, Number(toolSucceeded === true));
        assert.equal(view.reviewStatus.assessment.latestAttempt, "none");
    }
});

test("source-supported failure and positive answer findings stay separate across changed requests", () => {
    const { records } = retainedContextFixture();
    const { state, model } = qualityDisplayFixture({ records: records.slice(0, 2), judgments: ["fail", "pass"] });
    const before = JSON.stringify(state);
    const earlier = present(detail(model, records[0].scenarioId)), later = present(detail(model, records[1].scenarioId));
    assert.match(text(earlier.findings), /sign-in was required for the recorded call/);
    assert.match(text(earlier.findings), /Answer: Not correct/);
    assert.match(text(later.findings), /Answer: Correct/);
    assert.doesNotMatch(text(later.findings), /sign-in was required|Answer: Not correct|two documents/);
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
    assert.match(text(result.findings.answers), /Saved AI review \/ Answer: Correct/);
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
    assert.deepEqual(frozen.reviewStatuses, model.overview.reviewStatuses);
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
        [[], /No saved review/],
        [["unassessed"], /Not enough saved evidence/],
        [["error"], /Review could not finish; this is not a failed verdict/],
    ]) {
        const { model } = qualityDisplayFixture({ records: [success], judgments });
        const result = present([...model.details.values()][0]);
        assert.match(text(result.findings), expected);
        assert.doesNotMatch(text(result.findings), /Answer: Not correct|sign-in was required/);
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
    assert.doesNotMatch(text(result.findings), /Not enough saved evidence/);
    const unassessed = quality("accuracy", { personal: true, unassessed: 1 });
    unassessed.reason = "not-applicable";
    assert.match(text(presentation.summarize([unassessed]).findings), /Check not applicable/);
    unassessed.status = "evaluator-error"; unassessed.reason = "evaluator-failure";
    unassessed.counts = { pass: 0, fail: 0, unassessed: 0, evaluatorError: 1 };
    assert.match(text(presentation.summarize([unassessed]).findings), /Review could not finish, not a failed/);
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
    assert.match(text(summary.findings), /Your feedback \/ Answer: Not correct \(1 request\)/);
    assert.match(text(summary.findings), /Saved AI review \/ Answer: Correct \(1 request\)/);
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
