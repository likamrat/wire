import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createCopilotEvaluator } from "../lib/copilot-evaluator.mjs";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { createAutomaticScoreController } from "../lib/automatic-score-controller.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { buildAssessmentModel, buildReportFacts, assessmentHash } from "../lib/assessment-read-model.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";
import { createEvaluationRequest, MODEL_EVALUATION_RUBRIC } from "../lib/model-evaluation.mjs";
import { evaluationFixture, assessed } from "./evaluation-fixture.mjs";
import { CopilotClient, RuntimeConnection, observed, setSyntheticResponder } from "./fixtures/copilot-sdk-nonstarting.mjs";
import { sessionCreditLimit } from "../lib/evaluation-budget.mjs";

const fakeExecutable = fileURLToPath(import.meta.url);
function request(maxAiCredits) {
    const interactionRef = "interaction-" + "a".repeat(32), sourceConfigRef = "sourceconfig-" + "b".repeat(32);
    const timestamp = "2026-10-08T00:00:00.000Z";
    const packet = buildEvaluationPacket([
        { id: "prompt", timestamp, type: "user.message", data: { content: "Synthetic question" } },
        { id: "answer", timestamp, type: "assistant.message", data: { content: "Synthetic answer", phase: "final_answer", turnId: "t" } },
        { id: "end", timestamp, type: "assistant.turn_end", data: { turnId: "t" } },
    ], { interactionRef, sourceSessionId: "synthetic", promptEventId: "prompt", promptTimestamp: timestamp,
        promptText: "Synthetic question", toolCallIds: [] },
    { confirmed: true, interactionRefs: [interactionRef], sourceConfigRef, sourceConfigRevision: 1, categories: ["answer", "references", "intent"] });
    return createEvaluationRequest(packet, { confirmed: true, provider: "github-copilot", model: "gpt-6-astra", maxAiCredits, maxCalls: 1,
        interactionRefs: [interactionRef], sourceConfigRef, sourceConfigRevision: 1 });
}
function adapter(baseDirectory) {
    return createCopilotEvaluator({ baseDirectory, createClient: options => new CopilotClient({
        ...options, connection: RuntimeConnection.forStdio({ path: fakeExecutable }),
    }) });
}

test("strict synthetic SDK reproduces the observed createSession floor and admits the exact30 boundary without sending", async () => {
    const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: fakeExecutable }) });
    const sends = observed.sends;
    for (const maxAiCredits of [1, 10, 29.999]) {
        await assert.rejects(client.createSession({ sessionLimits: { maxAiCredits } }),
            error => error.code === -32603 && error.message.includes("Minimum session limit is 30 AI credits."));
    }
    const session = await client.createSession({ sessionLimits: { maxAiCredits: 30 } });
    await session.disconnect(); await client.stop();
    assert.equal(observed.sends, sends);
});

test("executor rejects unsupported effective limit before constructing a client instead of surfacing opaque RPC failure", async () => {
    const before = observed.clients.length;
    for (const [requested, remaining] of [[1, 30], [30, 10], [30, 29.999]]) {
        await assert.rejects(adapter(fileURLToPath(new URL(".", import.meta.url))).evaluate(request(requested), {
            confirmed: true, reservationId: "synthetic-reservation", remainingAiCredits: remaining, callsRemaining: 1,
        }), error => error.code === "session-credit-minimum");
    }
    assert.equal(observed.clients.length, before);
});

test("new subminimum direct approvals fail actionably without source reads, grants or reservations", async t => {
    const f = await evaluationFixture(t), before = await loadBoardState(f.context);
    await assert.rejects(f.controller.start("panel", { ...f.input, maxAiCredits: 10 }), /at least 30 AI credits/i);
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.controller.setup()).minimumSessionAiCredits, 30);
});

test("a30-credit cumulative allowance stops before the second read/reservation when first observed spend leaves29.9", async t => {
    const f = await evaluationFixture(t);
    let reads = 0, sends = 0;
    setSyntheticResponder(({ message, options, emit }) => {
        sends++;
        const input = JSON.parse(message.prompt);
        const result = assessed({ input, packetHash: input.packetHash, model: options.model,
            rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version }, false);
        emit({ type: "assistant.usage", data: { apiCallId: "floor-witness-" + sends, model: options.model,
            copilotUsage: { totalNanoAiu: 100000000 } } });
        return { type: "assistant.message", data: { content: JSON.stringify(result.rawResult) } };
    });
    const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: adapter,
        readSource: async file => { reads++; return f.options.readSource(file); } });
    t.after(() => controller.close());
    await controller.start("panel", { ...f.input, maxAiCredits: 30 });
    await controller.settle();
    const state = await loadBoardState(f.context), receipt = await controller.status("panel", { runRef: f.input.mutationRef });
    assert.equal(sends, 1);
    assert.equal(reads, 1, "Insufficient remaining session allowance must stop before another private source read.");
    assert.equal(receipt.callsReserved, 1); assert.equal(receipt.spentAiCredits, 0.1);
    assert.equal(receipt.costUnknown, false); assert.equal(receipt.error, "session-credit-minimum");
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 1);
    const metrics = buildAssessmentModel(state).overview.metrics.filter(metric => metric.origin === "model-assessed");
    assert.equal(metrics.length, 3);
    assert.ok(metrics.every(metric => metric.value === 1 && metric.coverage.covered === 1 && metric.coverage.eligible === 2));
    assert.equal(buildReportFacts(state.evidence, state).facts.metrics.filter(metric => metric.origin === "model-assessed").length, 3);
    await controller.start("panel", { ...f.input, maxAiCredits: 30 }); await controller.settle();
    assert.equal(sends, 1, "Paused receipt must not replay.");
});

const identity = () => ({ schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"),
    receiptToken: randomBytes(32).toString("hex"), confirmed: true });
async function automaticFixture(t, evaluate) {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) }, evaluate);
    f.config.enabled = true;
    const before = await loadBoardState(f.context);
    for (const input of f.inputs) input.record.responseTiming = recordedResponseTiming(input.events, input.record.userPrompt);
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(input => input.record), importCoverage: before.importCoverage }));
    let reads = 0;
    const evaluation = createEvaluationController(f.context, { ...f.options,
        readSource: async file => { reads++; return f.options.readSource(file); } });
    const automatic = createAutomaticScoreController(f.context, { evaluation, getSourceConfig: () => f.config });
    t.after(async () => { await automatic.close(); await evaluation.close(); for (const action of cleanup.reverse()) await action(); });
    const approval = async maxAiCredits => {
        const setup = await automatic.setup();
        return { ...identity(), expectedSourceRevision: setup.sourceRevision, expectedApprovalRevision: setup.approvalRevision,
            source: setup.source, method: setup.method, chatRefs: setup.chats.map(chat => chat.chatRef),
            evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 2, maxAiCredits };
    };
    return { ...f, evaluation, automatic, approval, get reads() { return reads; } };
}

test("effective session limits are never rounded up and exact30 remaining is supported", () => {
    assert.equal(sessionCreditLimit(60, 30), 30);
    assert.equal(sessionCreditLimit(30, 60), 30);
    assert.equal(sessionCreditLimit(60, 30.1), 30.1);
    assert.throws(() => sessionCreditLimit(60, 29.999999), error => error.code === "session-credit-minimum");
});

test("automatic setup advertises the floor and rejects a new10-credit grant without any durable state or private read", async t => {
    const f = await automaticFixture(t), before = await loadBoardState(f.context);
    assert.equal((await f.automatic.setup()).minimumSessionAiCredits, 30);
    await assert.rejects(f.automatic.approve("panel", await f.approval(10)), /at least 30 AI credits/);
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
});

test("automatic30 allowance pauses at29.9; only a new explicit cumulative allowance can admit another unattempted interaction", async t => {
    const f = await automaticFixture(t);
    const input = await f.approval(30);
    await f.automatic.approve("panel", input); await f.evaluation.settle();
    await f.automatic.reconcile(); await f.evaluation.settle();
    const paused = await f.automatic.setup();
    assert.equal(paused.snapshot.reason, "session-credit-minimum");
    assert.equal(paused.snapshot.approval.maxAiCredits, 30);
    assert.equal(paused.snapshot.usage.callsReserved, 1);
    assert.equal(paused.snapshot.usage.spentAiCredits, 0.1);
    assert.equal(f.calls.length, 1); assert.equal(f.reads, 1);
    await f.automatic.approve("panel", input); await f.automatic.reconcile();
    assert.equal(f.calls.length, 1, "Original approval receipt is a lookup, never a top-up.");
    await assert.rejects(f.automatic.approve("panel", await f.approval(30)), /at least 30 AI credits/);
    await f.automatic.approve("panel", await f.approval(30.1)); await f.evaluation.settle();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].maxAiCredits, 30, "The existing min-of-remaining rule reaches the exact runtime boundary.");
    assert.notEqual(f.calls[0].packetHash, f.calls[1].packetHash);
});

test("legacy10 approval stays readable and untouched while new dispatch is paused", async t => {
    const f = await automaticFixture(t);
    f.config.enabled = false;
    const original = await f.approval(60);
    const receipt = await f.automatic.approve("panel", original);
    await updateBoardState(f.context, state => { state.personalEvaluation.modelEvaluation.automatic.approval.maxAiCredits = 10; });
    f.config.enabled = true;
    const before = (await loadBoardState(f.context)).personalEvaluation;
    const setup = await f.automatic.setup();
    assert.equal(setup.snapshot.approval.maxAiCredits, 10);
    assert.equal(setup.snapshot.reason, "session-credit-minimum");
    await f.automatic.reconcile();
    assert.deepEqual(await f.automatic.status("panel", { schemaVersion: 1, mutationRef: original.mutationRef, receiptToken: original.receiptToken }), receipt);
    assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, before);
    assert.equal(f.calls.length, 0); assert.equal(f.reads, 0);
});

test("unknown billing and its original failed receipt take precedence over the minimum even for a legacy10 grant", async t => {
    const f = await automaticFixture(t, async () => { throw new Error("Synthetic unknown-billing result"); });
    await f.automatic.approve("panel", await f.approval(60)); await f.evaluation.settle();
    await updateBoardState(f.context, state => {
        const data = state.personalEvaluation.modelEvaluation;
        data.automatic.approval.maxAiCredits = 10;
        data.grants[0].maxAiCredits = 10;
    });
    const before = (await loadBoardState(f.context)).personalEvaluation;
    assert.equal((await f.automatic.setup()).snapshot.reason, "unknown-billing");
    await f.automatic.reconcile();
    await assert.rejects(f.automatic.approve("panel", await f.approval(10)), /Observed spending cannot be reset/);
    assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, before);
    assert.equal(f.calls.length, 1);
    assert.equal(before.modelEvaluation.runs[0].callsReserved, 1);
    assert.equal(before.modelEvaluation.runs[0].costUnknown, true);
});

test("completed legacy10 direct receipt remains recoverable before new-admission validation", async t => {
    const f = await evaluationFixture(t);
    const current = { ...f.input, scenarioIds: f.input.scenarioIds.slice(0, 1) };
    await f.controller.start("panel", current); await f.controller.settle();
    const legacy = { ...current, maxAiCredits: 10 };
    await updateBoardState(f.context, state => {
        const data = state.personalEvaluation.modelEvaluation;
        data.grants[0].maxAiCredits = 10; data.runs[0].inputHash = assessmentHash(legacy);
    });
    const before = (await loadBoardState(f.context)).personalEvaluation.modelEvaluation;
    assert.equal((await f.controller.start("panel", legacy)).phase, "complete");
    assert.deepEqual((await loadBoardState(f.context)).personalEvaluation.modelEvaluation, before);
    assert.equal(f.calls.length, 1);
});
