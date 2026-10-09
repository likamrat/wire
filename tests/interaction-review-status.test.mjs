import test from "node:test";
import assert from "node:assert/strict";
import { buildAssessmentModel, cachedAssessmentModel, assessmentSource, assessmentDependencies, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { completeWorkIqCall } from "../lib/history.mjs";
import { evaluationFixture, assessed } from "./evaluation-fixture.mjs";
import { validateInteractionView } from "../lib/assessment-contract.mjs";
import { fixture } from "./helpers.mjs";

function failedRecord(name = "sign-in-failure") {
    const record = fixture(name);
    record.userPrompt.sourceEventId = "prompt-" + name;
    Object.assign(record.toolCalls[0], {
        toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        requestArgs: { entityUrls: ["/me?$select=creationType"] }, requestedApiPath: "/me",
        failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
            messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" },
    });
    return record;
}

test("a failed Work IQ call carries its own cause and unassessed status without changing quality metrics or evidence identity", () => {
    const record = failedRecord(), before = structuredClone(record), fingerprint = evaluationRecordFingerprint(record);
    const state = { revision: 1, evidenceRevision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
    const view = [...buildAssessmentModel(state).details.values()][0];
    assert.ok(view.reviewStatus, "The interaction summary has no connected execution/assessment context.");
    assert.deepEqual(view.reviewStatus.execution, {
        calls: 1, succeeded: 0, failed: 1, other: 0, causes: [{ cause: "workiq-sign-in-required", count: 1 }],
    });
    assert.deepEqual(view.reviewStatus.assessment, {
        result: "none", unavailableReason: null, latestAttempt: "none", inAutomaticScope: false, personalFeedback: false,
    });
    const quality = view.metrics.filter(metric => ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension));
    assert.equal(quality.length, 3);
    assert.ok(quality.every(metric => metric.value === null && metric.denominator === 0
        && metric.coverage.covered === 0 && metric.coverage.eligible === 1));
    assert.deepEqual(record, before);
    assert.equal(evaluationRecordFingerprint(record), fingerprint);
    const options = { preparedAt: "2026-10-08T12:00:00.000Z" };
    const report = buildReportFacts(state.evidence, state, options).facts;
    const oldProjection = structuredClone(state);
    oldProjection.evidence[0].toolCalls[0].failureEvidence.messageSignal = null;
    assert.deepEqual(buildReportFacts(oldProjection.evidence, oldProjection, options).facts, report,
        "Operational explanation does not become a new numerical judgment or frozen report field.");
});

test("unknown, screened and unsupported error evidence keeps its specific limitation without copying private fields", () => {
    for (const [metadata, cause] of [
        [undefined, "unqualified"],
        [{ version: 1, reason: "no-structured-error" }, "source-error-not-supplied"],
        [{ version: 1, reason: "error-details-excluded", messageStatus: "text-excluded" }, "message-excluded"],
        [{ version: 1, reason: "error-code-recorded", messageStatus: "sensitive-excluded", messageSignal: "workiq-sign-in-required" }, "message-screened"],
        [{ version: 1, reason: "error-code-recorded", messageStatus: "size-excluded" }, "message-too-large"],
        [{ version: 1, reason: "unsupported-error-format", messageStatus: "unsupported-format" }, "unsupported-error-format"],
        [{ version: 1, reason: "constructor", messageStatus: "__proto__" }, "unqualified"],
    ]) {
        const record = failedRecord();
        record.toolCalls[0].failureEvidence = metadata && { ...metadata, privateMessage: "PRIVATE_FAILURE_PROSE", stack: "PRIVATE_STACK" };
        const view = [...buildAssessmentModel({ revision: 1, pseudonymKey: "b".repeat(64), evidence: [record] }).details.values()][0];
        assert.deepEqual(view.reviewStatus.execution.causes, [{ cause, count: 1 }]);
        assert.doesNotMatch(JSON.stringify(view.reviewStatus), /PRIVATE_|stack|privateMessage/);
        const invalid = structuredClone(view);
        invalid.reviewStatus.execution.failed++;
        assert.throws(() => validateInteractionView(invalid), /invalid-execution-summary/);
    }
});

async function replaceInputs(f) {
    const current = await loadBoardState(f.context);
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(input => input.record), importCoverage: current.importCoverage }));
    f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
}
const detailFor = (model, scenarioId) => model.details.get(model.catalog.find(row => row.scenarioId === scenarioId).interactionRef);

test("same-endpoint failed/unassessed and later successful/scored attempts never transfer cause or quality", async t => {
    const f = await evaluationFixture(t, request => assessed(request, false));
    for (const input of f.inputs) {
        input.record.toolCalls[0].requestArgs = { entityUrls: ["/me?$select=creationType"] };
        input.record.toolCalls[0].requestedApiPath = "/me";
        input.events[2].data.arguments = input.record.toolCalls[0].requestArgs;
    }
    const failed = f.inputs[0], end = failed.events[3];
    end.data = { toolCallId: failed.record.toolCalls[0].toolCallId, success: false,
        error: { code: "failure", message: 'Re-authentication required for MCP server "workiq". Run /mcp auth workiq' } };
    failed.record.toolCalls[0] = completeWorkIqCall(failed.record.toolCalls[0], end);
    await replaceInputs(f);
    f.input.scenarioIds = [f.inputs[1].record.scenarioId]; f.input.maxAiCredits = 30;
    await f.controller.start("fixture", f.input); await f.controller.settle();
    const state = await loadBoardState(f.context), before = JSON.stringify(state.evidence);
    const model = buildAssessmentModel(state, { source: assessmentSource(state, f.config) });
    const a = detailFor(model, failed.record.scenarioId), b = detailFor(model, f.inputs[1].record.scenarioId);
    assert.equal(a.reviewStatus.execution.failed, 1);
    assert.equal(a.reviewStatus.execution.causes[0].cause, "workiq-sign-in-required");
    assert.equal(a.reviewStatus.assessment.result, "none");
    assert.equal(a.reviewStatus.assessment.latestAttempt, "none");
    assert.ok(a.metrics.filter(metric => ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension)).every(metric => metric.value === null));
    assert.deepEqual(b.reviewStatus.execution, { calls: 1, succeeded: 1, failed: 0, other: 0, causes: [] });
    assert.equal(b.reviewStatus.assessment.result, "assessed");
    assert.equal(b.reviewStatus.assessment.latestAttempt, "complete");
    assert.ok(b.metrics.filter(metric => metric.origin === "model-assessed").every(metric => metric.value === 1));
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(state.evidence), before);
    assert.deepEqual(assessmentDependencies(b), assessmentDependencies({ ...b, reviewStatus: undefined }));
});

test("a recovered multi-call request retains a failed call alongside success and an independent positive model assessment", async t => {
    const f = await evaluationFixture(t, request => assessed(request, false)), input = f.inputs[0];
    const original = structuredClone(input.record.toolCalls[0]), originalEnd = structuredClone(input.events[3]);
    input.events[3].data = { toolCallId: original.toolCallId, success: false,
        error: { code: "failure", message: 'Re-authentication required for MCP server "workiq". Run /mcp auth workiq' } };
    input.record.toolCalls[0] = completeWorkIqCall(original, input.events[3]);
    const retryStart = { ...structuredClone(input.events[2]), id: "retry-start", data: { ...input.events[2].data, toolCallId: "retry-call" } };
    const retryEnd = { ...originalEnd, id: "retry-end", data: { ...originalEnd.data, toolCallId: "retry-call" } };
    input.events.splice(4, 0, retryStart, retryEnd);
    input.record.toolCalls.push(completeWorkIqCall({ ...original, toolCallId: "retry-call", startEventId: "retry-start" }, retryEnd));
    await replaceInputs(f);
    f.input.scenarioIds = [input.record.scenarioId]; f.input.maxAiCredits = 30;
    await f.controller.start("fixture", f.input); await f.controller.settle();
    const state = await loadBoardState(f.context), model = buildAssessmentModel(state, { source: assessmentSource(state, f.config) });
    const view = detailFor(model, input.record.scenarioId);
    assert.deepEqual(view.reviewStatus.execution, { calls: 2, succeeded: 1, failed: 1, other: 0,
        causes: [{ cause: "workiq-sign-in-required", count: 1 }] });
    assert.equal(view.reviewStatus.assessment.result, "assessed");
    assert.ok(view.metrics.filter(metric => metric.origin === "model-assessed").every(metric => metric.value === 1 && metric.denominator === 1));
});

test("evaluator errors refresh cached per-attempt status without becoming tool failures or failed quality scores", async t => {
    const f = await evaluationFixture(t, async () => { throw new Error("PRIVATE_EVALUATOR_FAILURE"); });
    const original = await loadBoardState(f.context);
    await replaceEvidence(f.context, () => ({ records: [...original.evidence, fixture("unrelated-request")], importCoverage: original.importCoverage }));
    f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
    const before = await loadBoardState(f.context), source = assessmentSource(before, f.config);
    const cached = cachedAssessmentModel(before, source);
    const firstId = f.inputs[0].record.scenarioId, secondId = f.inputs[1].record.scenarioId;
    assert.equal(detailFor(cached, firstId).reviewStatus.assessment.latestAttempt, "none");
    await f.controller.start("fixture", f.input); await f.controller.settle();
    const after = await loadBoardState(f.context), current = cachedAssessmentModel(after, source);
    assert.notEqual(current, cached);
    assert.deepEqual(current.basis, cached.basis, "Attempt state is not a fabricated measurement or feedback revision.");
    const first = detailFor(current, firstId), later = detailFor(current, secondId);
    assert.equal(first.reviewStatus.execution.failed, 0);
    assert.equal(first.reviewStatus.assessment.latestAttempt, "failed");
    assert.equal(first.reviewStatus.assessment.result, "none");
    assert.equal(later.reviewStatus.assessment.latestAttempt, "not-run", "A cohort peer that was never reached did not have an evaluator failure.");
    assert.notEqual(current.catalog.find(row => row.scenarioId === firstId).reviewStatusRevision,
        cached.catalog.find(row => row.scenarioId === firstId).reviewStatusRevision);
    assert.equal(current.catalog.find(row => row.scenarioId === "unrelated-request").reviewStatusRevision,
        cached.catalog.find(row => row.scenarioId === "unrelated-request").reviewStatusRevision);
    assert.doesNotMatch(JSON.stringify(first.reviewStatus), /PRIVATE_EVALUATOR_FAILURE/);
    assert.ok(first.metrics.filter(metric => ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension)).every(metric => metric.value === null));
    assert.equal(f.calls.length, 1);
    const changed = { ...after, evidence: after.evidence.map(record => record.scenarioId === firstId ? {
        ...record, toolCalls: record.toolCalls.map(call => ({ ...call, requestArgs: { entityUrls: ["/me?$select=accountEnabled"] } })),
    } : record) };
    assert.equal(detailFor(buildAssessmentModel(changed, { source }), firstId).reviewStatus.assessment.latestAttempt, "not-current",
        "An error for previous material evidence is not the current attempt's evaluator failure.");
});

test("a real controller insufficient result stays distinct from evaluator failure and not-requested status", async t => {
    const f = await evaluationFixture(t, request => {
        const result = assessed(request, false);
        for (const item of [...result.rawResult.requirements, ...result.rawResult.answerSegments, ...result.rawResult.actions]) {
            item.verdict = "insufficient"; item.reason = "missing-evidence";
        }
        return result;
    });
    f.input.scenarioIds = [f.inputs[0].record.scenarioId]; f.input.maxAiCredits = 30;
    await f.controller.start("fixture", f.input); await f.controller.settle();
    const state = await loadBoardState(f.context), view = detailFor(buildAssessmentModel(state, { source: assessmentSource(state, f.config) }), f.input.scenarioIds[0]);
    assert.equal(view.reviewStatus.execution.failed, 0);
    assert.equal(view.reviewStatus.assessment.result, "unassessed");
    assert.equal(view.reviewStatus.assessment.unavailableReason, "missing-evidence");
    assert.equal(view.reviewStatus.assessment.latestAttempt, "complete");
    assert.ok(view.metrics.filter(metric => metric.origin === "model-assessed").every(metric => metric.value === null && metric.denominator === 0));
});
