import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { createAutomaticScoreController } from "../lib/automatic-score-controller.mjs";
import { recordedResponseTiming } from "../lib/response-timing.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { evaluationFixture, assessed, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { createCollector } from "../lib/collector.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { automaticScoreAttemptKey } from "../lib/automatic-score-policy.mjs";

const identity = () => ({ schemaVersion: 1, mutationRef: "mutation-" + randomBytes(16).toString("hex"), receiptToken: randomBytes(32).toString("hex"), confirmed: true });
async function fixture(t, evaluate) {
    const cleanup = [], f = await evaluationFixture({ after: action => cleanup.push(action) }, evaluate);
    f.config.enabled = true;
    const before = await loadBoardState(f.context);
    for (const input of f.inputs) input.record.responseTiming = recordedResponseTiming(input.events, input.record.userPrompt);
    await replaceEvidence(f.context, () => ({
        records: f.inputs.map(input => input.record),
        importCoverage: { ...before.importCoverage, roster: f.inputs.map(input => ({
            sessionId: input.record.sourceSessionId, name: "Synthetic " + input.record.scenarioId + " chat", eligible: true,
        })) },
    }));
    const automatic = createAutomaticScoreController(f.context, { evaluation: f.controller, getSourceConfig: () => f.config });
    t.after(async () => { await automatic.close(); for (const action of cleanup.reverse()) await action(); });
    return { ...f, automatic };
}
async function approval(automatic, changes = {}) {
    const setup = await automatic.setup();
    return {
        ...identity(), expectedSourceRevision: setup.sourceRevision, expectedApprovalRevision: setup.approvalRevision,
        source: setup.source, method: setup.method, chatRefs: setup.chats.map(chat => chat.chatRef),
        evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 2, maxAiCredits: 60, ...changes,
    };
}

test("one explicit named-chat approval automatically produces exact pooled facts without per-request actions", async t => {
    const f = await fixture(t), before = await loadBoardState(f.context);
    await f.automatic.reconcile();
    assert.equal(f.calls.length, 0);
    const input = await approval(f.automatic);
    const receipt = await f.automatic.approve("panel", input);
    assert.equal(receipt.phase, "complete");
    await f.controller.settle();
    await f.automatic.reconcile();
    await f.controller.settle();
    const state = await loadBoardState(f.context);
    assert.equal(f.calls.length, 2);
    assert.equal(state.personalEvaluation.consent.state, "off");
    assert.deepEqual(state.evidence, before.evidence);
    const metric = buildAssessmentModel(state).overview.metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "model-assessed");
    assert.equal(metric.value, 0.5);
    assert.deepEqual(metric.coverage, { eligible: 2, covered: 2 });
    assert.equal(buildReportFacts(state.evidence, state).facts.metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "model-assessed").value, 0.5);
    const status = await f.automatic.setup();
    assert.equal(status.snapshot.usage.callsReserved, 2);
    assert.equal(status.snapshot.usage.spentAiCredits, 0.2);
    assert.equal(status.snapshot.reason, "allowance-used");
    assert.equal((await f.automatic.approve("panel", input)).phase, "complete");
    await f.automatic.reconcile();
    assert.equal(f.calls.length, 2);
});

test("zero allowance, source collection approval alone and paused collection cannot dispatch scores", async t => {
    const f = await fixture(t);
    await assert.rejects(f.automatic.approve("panel", await approval(f.automatic, { maxAiCredits: 0 })), /positive cumulative allowance/);
    assert.equal((await loadBoardState(f.context)).personalEvaluation, undefined);
    f.config.enabled = false;
    await f.automatic.approve("panel", await approval(f.automatic));
    assert.equal(f.calls.length, 0);
    assert.equal((await f.automatic.setup()).snapshot.reason, "collection-paused");
    f.config.enabled = true;
    await f.automatic.reconcile();
    await f.controller.settle();
    assert.equal(f.calls.length, 1);
});

test("Stop advances an empty generation and prevents a delayed older approval from enabling any score", async t => {
    const f = await fixture(t);
    const late = await approval(f.automatic), stop = identity();
    assert.equal((await f.automatic.revoke("panel", stop)).phase, "complete");
    await assert.rejects(f.automatic.approve("panel", late), /reviewed scope changed/);
    assert.equal((await f.automatic.status("renewed-panel", { schemaVersion: 1, mutationRef: stop.mutationRef, receiptToken: stop.receiptToken })).phase, "complete");
    await f.automatic.reconcile();
    assert.equal(f.calls.length, 0);
});

test("global revision changes and repeated normal reconciliation never spend twice for the same evidence", async t => {
    const f = await fixture(t);
    const input = await approval(f.automatic);
    input.chatRefs = input.chatRefs.slice(0, 1);
    await f.automatic.approve("panel", input);
    await f.controller.settle();
    for (let i = 0; i < 3; i++) {
        await updateBoardState(f.context, () => {});
        await f.automatic.reconcile();
        await f.controller.settle();
    }
    assert.equal(f.calls.length, 1);
    assert.equal((await f.automatic.setup()).snapshot.state, "ready");
    const fresh = createAutomaticScoreController(f.context, { evaluation: f.controller, getSourceConfig: () => f.config });
    try { await fresh.recover(); await fresh.reconcile(); await f.controller.settle(); }
    finally { await fresh.close(); }
    assert.equal(f.calls.length, 1);
});

test("author-only metadata recovery neither invalidates a score nor submits another assessment", async t => {
    const f = await fixture(t), input = await approval(f.automatic);
    input.chatRefs = input.chatRefs.slice(0, 1);
    await f.automatic.approve("panel", input);
    await f.controller.settle();
    const before = await loadBoardState(f.context);
    await replaceEvidence(f.context, records => ({
        records: records.map(record => ({ ...record, userPrompt: { ...record.userPrompt,
            authorshipVersion: 4, authorship: { actor: "user", basis: "host-direct-input" },
        } })), importCoverage: before.importCoverage,
    }));
    await f.automatic.reconcile();
    await f.controller.settle();
    assert.equal(f.calls.length, 1);
    assert.ok(buildAssessmentModel(await loadBoardState(f.context)).overview.metrics.some(metric => metric.origin === "model-assessed"));
});

test("unchanged legacy checkpoint reprocessing keeps a completed score current with allowance remaining and no dispatch", async t => {
    const f = await fixture(t);
    await materializeEvaluationSource(f);
    await replaceEvidence(f.context, () => ({ records: [] }));
    const collector = await createCollector(f.context, { timers: false });
    t.after(() => collector.close());
    await collector.setEnabled(true);
    f.config.enabled = true;
    await collector.collectNow();
    const collected = await loadBoardState(f.context);
    const fingerprint = createHash("sha256").update(JSON.stringify([f.config.appDbPath, f.config.sessionRoot, f.config.windowDays])).digest("hex");
    for (const source of f.inputs) {
        const checkpointPath = path.join(f.context.dataDir, "collector", fingerprint, source.record.sourceSessionId + ".json");
        const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
        for (const event of checkpoint.events) {
            delete event.data.wireFailureEvidence;
            delete event.data.wireParentInvocation;
        }
        await writeFile(checkpointPath, JSON.stringify(checkpoint));
    }
    await replaceEvidence(f.context, records => ({ records: records.map(record => ({
        ...record, graphActivities: record.graphActivities ?? [],
        toolCalls: record.toolCalls.map(call => {
            const legacy = { ...call };
            for (const key of ["failureEvidence", "parentInvocationEvidence", "parallelGroupEvidence"]) delete legacy[key];
            return legacy;
        }),
    })), importCoverage: collected.importCoverage }));
    const input = await approval(f.automatic);
    input.chatRefs = input.chatRefs.slice(0, 1);
    await f.automatic.approve("panel", input);
    await f.controller.settle();
    const before = await loadBoardState(f.context);
    assert.equal(f.calls.length, 1, "Only the owned synthetic evaluator seam was called");
    const completed = before.personalEvaluation.modelEvaluation.records[0];
    const old = buildAssessmentModel(before).internals.get(completed.interactionRef).record;
    const oldFingerprint = evaluationRecordFingerprint(old);
    const grant = before.personalEvaluation.modelEvaluation.automatic.approval;
    const oldKey = automaticScoreAttemptKey(grant, completed.interactionRef, old);
    assert.ok(buildAssessmentModel(before).overview.metrics.some(metric => metric.origin === "model-assessed"));
    for (const source of f.inputs) {
        await appendFile(path.join(f.config.sessionRoot, source.record.sourceSessionId, "events.jsonl"), JSON.stringify({
            id: "invented-unrelated-event", type: "session.info", timestamp: new Date().toISOString(), data: {},
        }) + "\n");
    }
    await collector.collectNow();
    const after = await loadBoardState(f.context);
    const current = buildAssessmentModel(after).internals.get(completed.interactionRef).record;
    assert.equal(evaluationRecordFingerprint(current), oldFingerprint);
    assert.equal(automaticScoreAttemptKey(grant, completed.interactionRef, current), oldKey);
    assert.ok(buildAssessmentModel(after).overview.metrics.some(metric => metric.origin === "model-assessed"));
    assert.equal(Object.hasOwn(current.toolCalls[0], "failureEvidence"), false);
    assert.equal(Object.hasOwn(current.toolCalls[0], "parentInvocationEvidence"), false);
    assert.equal(Object.hasOwn(current.toolCalls[0], "parallelGroupEvidence"), false);
    await f.automatic.reconcile();
    await f.controller.settle();
    const setup = await f.automatic.setup();
    assert.equal(setup.snapshot.reason, "processed");
    assert.equal(setup.snapshot.next, null);
    assert.equal(setup.snapshot.usage.callsReserved, 1);
    assert.ok(setup.snapshot.usage.callsReserved < setup.snapshot.approval.maxCalls);
    assert.ok(setup.snapshot.usage.spentAiCredits < setup.snapshot.approval.maxAiCredits);
    assert.equal(f.calls.length, 1, "Unchanged evidence cannot dispatch another assessment");
    await replaceEvidence(f.context, records => ({ records: records.map(record => record.scenarioId !== current.scenarioId ? record : {
        ...record, toolCalls: record.toolCalls.map(call => ({ ...call, durationMs: call.durationMs + 1 })),
    }), importCoverage: after.importCoverage }));
    const changedState = await loadBoardState(f.context);
    const changed = buildAssessmentModel(changedState).internals.get(completed.interactionRef).record;
    assert.notEqual(evaluationRecordFingerprint(changed), oldFingerprint);
    assert.notEqual(automaticScoreAttemptKey(grant, completed.interactionRef, changed), oldKey);
    assert.equal(buildAssessmentModel(changedState).overview.metrics.some(metric => metric.origin === "model-assessed"), false);
    assert.equal(f.calls.length, 1, "The material-change control does not dispatch an evaluator");
});

test("a changed final answer must match collected metadata before it can trigger another automatic assessment", async t => {
    const f = await fixture(t);
    const input = await approval(f.automatic);
    input.chatRefs = input.chatRefs.slice(0, 1);
    await f.automatic.approve("panel", input);
    await f.controller.settle();
    const state = await loadBoardState(f.context), first = state.personalEvaluation.modelEvaluation.records[0];
    const source = f.inputs.find(item => buildAssessmentModel(state).internals.get(first.interactionRef).record.sourceSessionId === item.record.sourceSessionId);
    const final = source.events.find(event => event.type === "assistant.message");
    final.id = "new-synthetic-final";
    source.record.responseTiming = recordedResponseTiming(source.events, source.record.userPrompt);
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(item => item.record), importCoverage: state.importCoverage }));
    assert.equal(buildAssessmentModel(await loadBoardState(f.context)).overview.metrics.some(metric => metric.origin === "model-assessed"), false);
    await f.automatic.reconcile();
    await f.controller.settle();
    assert.equal(f.calls.length, 2);
});

test("a fixed out-of-window cohort cannot be replaced by another eligible request in the same approved chat", async t => {
    const f = await fixture(t), state = await loadBoardState(f.context);
    const first = f.inputs[0], second = f.inputs[1], old = "2026-09-04T12:00:00.000Z";
    first.record.userPrompt.sourceTimestamp = old;
    Object.assign(first.record.toolCalls[0], { startedAt: old, completedAt: old });
    first.events.forEach(event => { event.timestamp = old; });
    first.record.responseTiming = recordedResponseTiming(first.events, first.record.userPrompt);
    second.record.sourceSessionId = first.record.sourceSessionId;
    first.events.push(...second.events.slice(1));
    await replaceEvidence(f.context, () => ({ records: f.inputs.map(item => item.record), importCoverage: state.importCoverage }));
    const setup = await f.automatic.setup({ scenarioIds: [first.record.scenarioId] });
    assert.equal(setup.chats.length, 1);
    assert.equal(setup.chats[0].outsideWindow, 1);
    const input = {
        ...identity(), expectedSourceRevision: setup.sourceRevision, expectedApprovalRevision: setup.approvalRevision,
        source: setup.source, method: setup.method, chatRefs: setup.chats.map(chat => chat.chatRef), interactionRefs: setup.interactionRefs,
        evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 2, maxAiCredits: 60,
    };
    await f.automatic.approve("panel", input);
    await f.automatic.reconcile();
    assert.equal(f.calls.length, 0);
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.runs.length, 0);
    assert.deepEqual((await f.automatic.setup()).snapshot.exclusions, [{ interactionRef: setup.interactionRefs[0], reason: "outside-approved-window" }]);
});

test("the legacy global evaluation Stop also invalidates delayed automatic approval", async t => {
    const f = await fixture(t), input = await approval(f.automatic);
    await f.controller.revoke();
    await assert.rejects(f.automatic.approve("panel", input), /reviewed scope changed/);
    assert.equal(f.calls.length, 0);
});

test("a billed invalid provider result pauses automatic processing instead of spending on another interaction", async t => {
    const f = await fixture(t, async () => ({
        rawResult: {}, evaluatorCost: { aiCredits: 0.1, modelCalls: 1, status: "recorded", attribution: "evaluation-overhead-only" },
    }));
    await f.automatic.approve("panel", await approval(f.automatic));
    await f.controller.settle();
    await f.automatic.reconcile();
    await f.controller.settle();
    assert.equal(f.calls.length, 1);
    const setup = await f.automatic.setup();
    assert.equal(setup.snapshot.reason, "evaluation-failed");
    assert.equal(setup.snapshot.usage.spentAiCredits, 0.1);
});

test("a fresh approval after Stop cannot replay an earlier uncertain interaction", async t => {
    const f = await fixture(t, async (request, _reservation, call) => {
        if (call === 1) throw new Error("Synthetic uncertain provider outcome");
        return assessed(request, false);
    });
    const first = await approval(f.automatic);
    first.chatRefs = first.chatRefs.slice(0, 1);
    await f.automatic.approve("panel", first);
    await f.controller.settle();
    assert.equal((await f.automatic.setup()).snapshot.reason, "unknown-billing");
    await f.automatic.revoke("panel", identity());
    await f.automatic.approve("panel", await approval(f.automatic));
    await f.controller.settle();
    await f.automatic.reconcile();
    assert.equal(f.calls.length, 2, "The new approval may process the other chat, but not repeat the uncertain interaction.");
    assert.notEqual(f.calls[0].input.packet.interactionRef, f.calls[1].input.packet.interactionRef);
    assert.ok((await f.automatic.setup()).snapshot.exclusions.some(item => item.reason === "earlier-uncertain-assessment"));
});
