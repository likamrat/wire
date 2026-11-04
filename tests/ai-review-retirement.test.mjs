import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { createAutomaticScoreController } from "../lib/automatic-score-controller.mjs";
import { createCopilotEvaluator } from "../lib/copilot-evaluator.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { REQUESTS } from "../lib/assessment-contract.mjs";
import { privateFixture } from "./helpers.mjs";
import { retirementFixture, retirementClient } from "./ai-review-retirement-fixture.mjs";

const retired = error => error.status === 410 && error.code === "AI_REVIEW_RETIRED";

test("personal-feedback writes retire before validation, replay or callbacks while historical receipts stay exact", async t => {
    const cleanups = [], f = await retirementFixture({ after: action => cleanups.push(action) });
    const before = await loadBoardState(f.context), invoked = [];
    const runtime = await startServer(f.context, createExportController(f.context), { port: 0, collector: { timers: false } });
    let searchFences = 0;
    for (const method of ["beginMutation", "invalidate"]) {
        const original = runtime.search[method];
        runtime.search[method] = (...args) => { searchFences++; return original.apply(runtime.search, args); };
    }
    t.after(async () => { try { await runtime.close(); } finally { for (const cleanup of cleanups.reverse()) await cleanup(); } });
    const api = await retirementClient(runtime);
    assert.equal(Object.hasOwn(REQUESTS, "set_personal_assessment"), false);
    const unauthenticated = await fetch(runtime.url + "api/assessment/feedback", {
        method: "POST", headers: { Origin: new URL(runtime.url).origin, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(unauthenticated.status, 403);
    for (const input of [{}, { mutationRef: f.personalMutationRef }, { ...f.input, withdraw: true }]) {
        const direct = await api("/api/assessment/feedback", input);
        assert.equal(direct.status, 410);
        assert.equal(direct.body.code, "PERSONAL_FEEDBACK_RETIRED");
        const canvas = await api("/api/canvas", { action: "set_personal_assessment", input });
        assert.equal(canvas.status, 410);
        await assert.rejects(executeAssessmentAction(f.context, "original-panel", "set_personal_assessment", input, {
            source() { invoked.push("source"); throw new Error("No source callback is permitted."); },
        }), error => error.status === 410 && error.code === "PERSONAL_FEEDBACK_RETIRED");
    }
    const receipt = await api("/api/assessment/mutation/status", {
        schemaVersion: 1, mutationRef: f.personalMutationRef, receiptToken: f.receiptToken,
    });
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, before.personalEvaluation.mutations[f.personalMutationRef].receipt);
    assert.equal((await api("/api/assessment/mutation/status", {
        schemaVersion: 1, mutationRef: f.personalMutationRef, receiptToken: "0".repeat(64),
    })).status, 403);
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.deepEqual(invoked, []);
    assert.equal(searchFences, 0, "Retired writes must not invalidate or fence a Search session.");
});

test("all stale execution routes reject explicitly without provider or source access", async t => {
    const { context } = await privateFixture(t), unexpected = [];
    const denied = name => () => { unexpected.push(name); throw new Error(`Unexpected ${name}`); };
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: denied("provider"), readSource: denied("source"), discover: denied("discovery") },
    });
    try {
        const api = await retirementClient(runtime), before = await loadBoardState(context);
        for (const route of [
            "/api/evaluation/setup", "/api/evaluation/start", "/api/evaluation/revoke",
            "/api/evaluation/automatic/setup", "/api/evaluation/automatic/summary",
            "/api/evaluation/automatic/approve", "/api/evaluation/automatic/revoke", "/api/evaluation/legacy-start",
        ]) {
            const result = await api(route, { confirmed: true });
            assert.equal(result.status, 410, route);
            assert.equal(result.body.code, "AI_REVIEW_RETIRED", route);
        }
        const legacy = await api("/api/canvas", { action: "start_evaluation", input: { confirmed: true } });
        assert.equal(legacy.status, 404, "No extension/CLI evaluation action exists.");
        const unauthenticated = await fetch(runtime.url + "api/evaluation/start", {
            method: "POST", headers: { Origin: new URL(runtime.url).origin, "Content-Type": "application/json" }, body: "{}",
        });
        assert.equal(unauthenticated.status, 403);
        assert.deepEqual(await loadBoardState(context), before);
        assert.deepEqual(unexpected, []);
    } finally { await runtime.close(); }
});

test("imported execution and recovery entry points cannot dispatch or alter stored evidence", async t => {
    const f = await retirementFixture(t), before = await loadBoardState(f.context), unexpected = [];
    const forbidden = () => { unexpected.push("invoked"); throw new Error("Unexpected provider or source"); };
    const evaluation = createEvaluationController(f.context, { getSourceConfig: forbidden, evaluatorFactory: forbidden, readSource: forbidden, discover: forbidden });
    const automatic = createAutomaticScoreController(f.context, { evaluation, getSourceConfig: forbidden, onChanged: forbidden });
    for (const method of ["setup", "start", "revoke", "recover", "sealSourceDeletion"]) assert.throws(() => evaluation[method]("owner", f.input), retired);
    for (const maxAiCredits of [0, 1, 10, 29.999, 30, 60]) {
        assert.throws(() => evaluation.start("owner", { ...f.input, maxAiCredits }), retired);
    }
    const uncertain = before.personalEvaluation.modelEvaluation.runs.find(run => run.phase === "uncertain");
    const receipt = await evaluation.status("reconnected-panel", { runRef: uncertain.runRef, receiptToken: f.receiptToken });
    assert.equal(receipt.phase, "uncertain");
    assert.equal(receipt.costUnknown, true);
    assert.equal(receipt.spentAiCredits, 0.125);
    for (const method of ["setup", "summary", "approve", "revoke", "reconcile", "recover"]) assert.throws(() => automatic[method]("owner", f.input), retired);
    assert.throws(() => createCopilotEvaluator({ createClient: forbidden, baseDirectory: f.context.dataDir }), retired);
    await evaluation.close(); await automatic.close();
    assert.deepEqual(await loadBoardState(f.context), before);
    assert.deepEqual(unexpected, []);
});

test("enabled approval and pending/unknown receipts survive boot, reads, collection and restart unchanged", async t => {
    const f = await retirementFixture(t), before = await loadBoardState(f.context), workBytes = await readFile(f.workFile);
    const stored = JSON.stringify(before.personalEvaluation), unexpected = [];
    const forbidden = () => { unexpected.push("invoked"); throw new Error("Unexpected evaluation callback"); };
    for (let restart = 0; restart < 2; restart++) {
        const runtime = await startServer(f.context, createExportController(f.context), {
            port: 0, collector: { timers: false },
            evaluation: { evaluatorFactory: forbidden, readSource: forbidden, discover: forbidden, getSourceConfig: forbidden, onChanged: forbidden },
        });
        try {
            const api = await retirementClient(runtime);
            assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation), stored);
            for (const expected of before.personalEvaluation.modelEvaluation.runs) {
                const denied = await api("/api/evaluation/status", { runRef: expected.runRef, receiptToken: "0".repeat(64) });
                assert.equal(denied.status, 404);
                const receipt = await api("/api/evaluation/status", { runRef: expected.runRef, receiptToken: f.receiptToken });
                assert.equal(receipt.status, 200);
                assert.deepEqual(receipt.body, { runRef: expected.runRef, phase: expected.phase, callsReserved: expected.callsReserved,
                    spentAiCredits: expected.spentAiCredits, costUnknown: expected.costUnknown, results: expected.results, error: expected.error });
                assert.ok(!Object.hasOwn(receipt.body, "receiptTokenHash"));
            }
            const input = { schemaVersion: 1, mutationRef: f.mutationRef, receiptToken: f.receiptToken };
            assert.equal((await api("/api/evaluation/automatic/status", { ...input, receiptToken: "0".repeat(64) })).status, 404);
            assert.equal((await api("/api/evaluation/automatic/status", input)).body.phase, "pending");
            await runtime.collector.setEnabled(true);
            const cycle = await runtime.collector.collectNow();
            assert.ok(cycle.check, "Ordinary approved history collection still completes.");
            assert.equal(JSON.stringify((await loadBoardState(f.context)).personalEvaluation), stored);
            assert.deepEqual(await readFile(f.workFile), workBytes);
        } finally { await runtime.close(); }
    }
    assert.deepEqual(unexpected, []);
});

test("current facts retain observations and timing without any historical rating projection", async t => {
    const f = await retirementFixture(t), state = await loadBoardState(f.context);
    const historical = structuredClone(state.personalEvaluation);
    const model = buildAssessmentModel(state), view = [...model.details.values()][0];
    assert.ok(view.observations.some(item => item.kind === "tool-outcome"));
    assert.ok(view.metrics.some(item => item.dimension === "speed"));
    assert.ok(view.metrics.every(item => item.dimension === "speed" && item.origin === "automatic-local"));
    assert.deepEqual(view.assessments, []);
    assert.equal(view.reviewStatus, undefined);
    const { facts } = buildReportFacts(state.evidence, state);
    assert.equal(facts.metricProjectionVersion, 4);
    assert.equal(facts.assessmentAttempts, undefined);
    assert.equal(facts.reviewStatuses, undefined);
    assert.ok(facts.recordedOutcomes.some(item => item.kind === "tool-call"));
    assert.deepEqual(state.personalEvaluation, historical);
});

test("only confirmed sealed activity deletion removes dependent historical work; unknown billing is not settled", async t => {
    const cleanups = [], f = await retirementFixture({ after: action => cleanups.push(action) });
    const runtime = await startServer(f.context, createExportController(f.context), { port: 0, collector: { timers: false } });
    t.after(async () => { try { await runtime.close(); } finally { for (const cleanup of cleanups.reverse()) await cleanup(); } });
    const api = await retirementClient(runtime), original = await readFile(f.workFile);
    const preview = await api("/api/deletion/preview", { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } });
    assert.equal(preview.status, 200);
    assert.deepEqual(await readFile(f.workFile), original, "Preview alone cannot clean historical work.");
    const removed = await api("/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    await assert.rejects(readFile(f.workFile), { code: "ENOENT" });
    const state = await loadBoardState(f.context);
    assert.equal(state.personalEvaluation.modelEvaluation.records.length, 0);
    const uncertain = state.personalEvaluation.modelEvaluation.runs.find(run => run.runRef === "run-" + "9".repeat(32));
    assert.equal(uncertain.phase, "purged");
    assert.equal(uncertain.costUnknown, true);
    assert.equal(uncertain.spentAiCredits, 0.125);
    assert.equal((await api("/api/evaluation/start", f.input)).status, 410);
});
