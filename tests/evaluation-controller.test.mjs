import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { createCopilotEvaluator } from "../lib/copilot-evaluator.mjs";
import { buildAssessmentModel, buildReportFacts } from "../lib/assessment-read-model.mjs";
import { loadBoardState, replaceEvidence, exclusiveBoard } from "../lib/store.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { evaluationFixture as setup, assessed } from "./evaluation-fixture.mjs";

test("normal evaluation remains off on setup; explicit scope/budget consent runs two controlled-provider cases and freezes model facts", async t => {
    const { context, controller, calls, input } = await setup(t);
    const initial = await loadBoardState(context);
    assert.equal((await controller.setup({ scenarioIds: input.scenarioIds })).active, false);
    assert.equal(calls.length, 0);
    await assert.rejects(controller.start("panel", { ...input, confirmed: false }), /Explicit scope/);
    assert.equal((await loadBoardState(context)).personalEvaluation, undefined);
    const started = await controller.start("panel", input);
    assert.equal(started.phase, "queued");
    await controller.settle();
    const status = await controller.status("renewed-panel", { runRef: input.mutationRef, receiptToken: input.receiptToken });
    assert.equal(status.phase, "complete", JSON.stringify(status));
    assert.equal(calls.length, 2);
    const state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.consent.state, "off", "Existing reply capture is not evaluator consent.");
    assert.deepEqual(state.evidence, initial.evidence);
    const model = buildAssessmentModel(state);
    const accuracy = model.overview.metrics.find(metric => metric.origin === "model-assessed" && metric.dimension === "accuracy");
    assert.equal(accuracy.value, 0.5);
    assert.deepEqual(accuracy.coverage, { eligible: 2, covered: 2 });
    const facts = buildReportFacts(state.evidence, state).facts;
    assert.equal(facts.metrics.find(metric => metric.origin === "model-assessed" && metric.dimension === "accuracy").value, 0.5);
    assert.doesNotMatch(JSON.stringify(state.personalEvaluation.modelEvaluation), /How many synthetic|Two synthetic|Three synthetic/);
    assert.equal((await controller.start("panel", input)).phase, "complete");
    assert.equal(calls.length, 2, "Same operation is never replayed.");
    await controller.revoke();
    const revoked = await loadBoardState(context);
    assert.equal(buildAssessmentModel(revoked).overview.metrics.some(metric => metric.origin === "model-assessed"), false);
    assert.equal(facts.metrics.find(metric => metric.origin === "model-assessed" && metric.dimension === "accuracy").value, 0.5, "Old frozen facts are unchanged.");
});

test("revocation drains aborted owned work before success and never publishes its late result or starts another call", async t => {
    let release, aborted = false;
    const held = new Promise(resolve => { release = resolve; });
    const { context, controller, calls, input, workDirs } = await setup(t, async (request, _reservation, _call, { signal }) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await held;
        return assessed(request, false);
    });
    await controller.start("panel", input);
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    let returned = false;
    const revocation = controller.revoke().then(result => { returned = true; return result; });
    try {
        while (!aborted) await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(returned, false, "Revocation cannot report completion before the owned provider/work exits.");
        await assert.rejects(controller.start("panel", { ...input, mutationRef: "mutation-" + randomBytes(16).toString("hex") }), /cleanup is already pending/);
    } finally { release(); await revocation; await controller.settle(); }
    assert.equal(calls.length, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
    assert.equal((await controller.status("panel", { runRef: input.mutationRef })).phase, "revoked");
    for (const workDir of workDirs) await assert.rejects(readdir(workDir), { code: "ENOENT" });
});

test("unknown provider failure consumes its reservation, stops the cohort and does not turn into a zero score", async t => {
    const { context, controller, calls, input } = await setup(t, async () => { throw new Error("Synthetic provider failure"); });
    await controller.start("panel", input); await controller.settle();
    const status = await controller.status("panel", { runRef: input.mutationRef });
    assert.equal(status.phase, "failed");
    assert.equal(status.costUnknown, true);
    assert.equal(calls.length, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
    assert.equal((await controller.start("panel", input)).phase, "failed");
    assert.equal(calls.length, 1);
});

test("a billed response that fails the rubric retains known overhead without publishing a score", async t => {
    const { context, controller, calls, input } = await setup(t, async request => ({ ...assessed(request, false), rawResult: {} }));
    await controller.start("panel", input);
    await controller.settle();
    const status = await controller.status("panel", { runRef: input.mutationRef });
    assert.equal(status.phase, "failed");
    assert.equal(status.spentAiCredits, 0.1);
    assert.equal(status.costUnknown, false);
    assert.equal(calls.length, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
});

test("discarding a stale result does not discard its billed cost or permit another budgeted call", async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { context, controller, calls, input } = await setup(t, async request => {
        await held;
        const result = assessed(request, false);
        result.evaluatorCost.aiCredits = 30.1;
        return result;
    });
    input.maxAiCredits = 30;
    await controller.start("panel", input);
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    const before = await loadBoardState(context);
    await replaceEvidence(context, records => ({ records: records.map(record => record.scenarioId === "first"
        ? { ...record, userPrompt: { ...record.userPrompt, text: "Changed synthetic request" } } : record), importCoverage: before.importCoverage }));
    release(); await controller.settle();
    const status = await controller.status("panel", { runRef: input.mutationRef });
    assert.equal(calls.length, 1);
    assert.equal(status.spentAiCredits, 30.1);
    assert.equal(status.phase, "partial");
    assert.equal(status.error, "budget-exhausted");
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
});

test("receipts are owner/token and payload bound and recovery never replays a reserved call", async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { context, controller, calls, input, options } = await setup(t, async request => { await held; return assessed(request, false); });
    await controller.start("panel", input);
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(controller.status("other", { runRef: input.mutationRef }), /not available/);
    await assert.rejects(controller.start("other", input), /reused/);
    await assert.rejects(controller.start("panel", { ...input, maxAiCredits: 2 }), /different inputs/);
    const recovered = createEvaluationController(context, options);
    t.after(() => recovered.close());
    await recovered.recover();
    const status = await recovered.status("renewed-panel", { runRef: input.mutationRef, receiptToken: input.receiptToken });
    assert.equal(status.phase, "uncertain");
    assert.equal(status.costUnknown, true);
    release(); await controller.settle();
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
    assert.equal((await recovered.start("panel", input)).phase, "uncertain");
    assert.equal(calls.length, 1);
});

test("close aborts an owned in-flight request and does not evaluate the next selected interaction", async t => {
    let aborted = 0;
    const { controller, calls, input } = await setup(t, async (_request, _reservation, _call, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(new Error("Synthetic shutdown")); }, { once: true })));
    await controller.start("panel", input);
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    await controller.close();
    assert.equal(aborted, 1);
    assert.equal(calls.length, 1);
    assert.notEqual((await controller.status("panel", { runRef: input.mutationRef })).phase, "running");
    await assert.rejects(controller.start("panel", input), /controller is closed/);
});

test("an unknown overhead preserves the assessed result but stops subsequent paid requests", async t => {
    const { context, controller, calls, input } = await setup(t, async request => ({
        ...assessed(request, false),
        evaluatorCost: { aiCredits: null, modelCalls: null, attribution: "evaluation-overhead-only", status: "unavailable" },
    }));
    await controller.start("panel", input); await controller.settle();
    const status = await controller.status("panel", { runRef: input.mutationRef });
    assert.equal(calls.length, 1);
    assert.equal(status.phase, "partial");
    assert.equal(status.costUnknown, true);
    const metrics = buildAssessmentModel(await loadBoardState(context)).overview.metrics;
    const accuracy = metrics.find(metric => metric.origin === "model-assessed" && metric.dimension === "accuracy");
    assert.equal(accuracy.value, 1);
    assert.deepEqual(accuracy.coverage, { eligible: 2, covered: 1 });
    assert.equal(metrics.some(metric => metric.dimension === "cost"), false, "Evaluator overhead cannot restore the removed interaction Cost metric.");
});

test("partially observed overhead retains its subtotal and valid assessment but stops additional model requests", async t => {
    const { context, controller, calls, input } = await setup(t, async request => ({
        ...assessed(request, false),
        evaluatorCost: { aiCredits: 0.1, modelCalls: null, attribution: "evaluation-overhead-only", status: "partial" },
    }));
    await controller.start("panel", input);
    await controller.settle();
    const receipt = await controller.status("panel", { runRef: input.mutationRef });
    assert.equal(receipt.spentAiCredits, 0.1);
    assert.equal(receipt.costUnknown, true);
    assert.equal(receipt.phase, "partial");
    assert.equal(calls.length, 1);
    const state = await loadBoardState(context);
    assert.equal(state.personalEvaluation.modelEvaluation.records[0].evaluatorCost.status, "partial");
    assert.equal(buildAssessmentModel(state).overview.metrics.some(metric => metric.dimension === "cost"), false);
});

test("source changes during evidence reading block model submission", async t => {
    let release, entered = false;
    const held = new Promise(resolve => { release = resolve; });
    const f = await setup(t);
    const originalRead = f.options.readSource;
    const controller = createEvaluationController(f.context, { ...f.options, readSource: async file => {
        entered = true; await held; return originalRead(file);
    } });
    t.after(() => controller.close());
    await controller.start("panel", f.input);
    while (!entered) await new Promise(resolve => setImmediate(resolve));
    f.config.windowDays = 90;
    release(); await controller.settle();
    assert.equal(f.calls.length, 0);
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
});

test("SDK work creation and recovery refuse redirected private directories", async t => {
    const { context, controller, calls, input } = await setup(t);
    const outside = path.join(path.dirname(context.dataDir), "not-evaluator-work");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "KEEP");
    await symlink(outside, path.join(context.dataDir, "evaluation-work"), process.platform === "win32" ? "junction" : "dir");
    await controller.start("panel", input); await controller.settle();
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(outside), ["keep.txt"]);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "KEEP");
    await assert.rejects(controller.recover(), /linked/);
});

test("sealed deletion cancels a pre-send authority check queued behind the board writer without deadlock", { timeout: 10000 }, async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { context, controller, calls, input } = await setup(t, async (request, _reservation, _call, { authorize }) => {
        await held;
        await authorize();
        return assessed(request, false);
    });
    await controller.start("panel", input);
    while (!calls.length) await new Promise(resolve => setImmediate(resolve));
    await exclusiveBoard(context, async (state, save) => {
        state.personalEvaluation = selectPersonalEvaluationCleanup(state.personalEvaluation, { allCollectedActivity: true }).next;
        state.revision++;
        await save(state);
        release();
        await new Promise(resolve => setImmediate(resolve));
        await controller.sealSourceDeletion(state);
    });
    await controller.settle();
    assert.equal(calls.length, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.modelEvaluation.records.length, 0);
});

test("owned SDK cleanup failure remains an error for deletion and close, not a successful stop", async t => {
    const f = await setup(t);
    const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: async () => ({
        evaluate: async () => { throw Object.assign(new Error("Synthetic SDK cleanup failure"), { code: "EVALUATOR_CLEANUP_FAILED" }); },
    }) });
    await controller.start("panel", f.input);
    await controller.settle();
    const state = await loadBoardState(f.context);
    state.personalEvaluation = selectPersonalEvaluationCleanup(state.personalEvaluation, { allCollectedActivity: true }).next;
    await assert.rejects(controller.sealSourceDeletion(state), /cleanup is incomplete/);
    await assert.rejects(controller.close(), /cleanup did not finish/);
});

test("revocation surfaces an affected provider cleanup failure after durable revocation", async t => {
    const f = await setup(t);
    let entered = false;
    const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: async () => ({
        evaluate: async (_request, _reservation, { signal }) => new Promise((_, reject) => {
            entered = true;
            signal.addEventListener("abort", () => reject(Object.assign(new Error("Synthetic stop failure"), {
                code: "EVALUATOR_CLEANUP_FAILED",
            })), { once: true });
        }),
    }) });
    await controller.start("panel", f.input);
    while (!entered) await new Promise(resolve => setImmediate(resolve));
    try {
        await assert.rejects(controller.revoke(), /cleanup/);
        assert.equal((await controller.status("panel", { runRef: f.input.mutationRef })).phase, "revoked");
        assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
    } finally {
        await controller.settle();
        await assert.rejects(controller.close(), /cleanup did not finish/);
    }
});

for (const mode of ["malformed-json", "non-object", "cleanup-failure", "listener-cleanup", "disconnect-failure", "abort-failure", "partial-usage"]) {
    test(`provider-boundary ${mode} retains identified billing without publishing a score or replaying`, async t => {
        const f = await setup(t);
        const cleanupFailure = ["cleanup-failure", "listener-cleanup", "disconnect-failure", "abort-failure"].includes(mode);
        let sends = 0, disconnects = 0, stops = 0;
        const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: async baseDirectory =>
            createCopilotEvaluator({ baseDirectory, createClient: () => {
                const events = new Set();
                return {
                    createSession: async () => ({
                        on(handler) {
                            events.add(handler);
                            return () => {
                                events.delete(handler);
                                if (mode === "listener-cleanup") throw new Error("Synthetic listener cleanup failure");
                            };
                        },
                        async sendAndWait() {
                            sends++;
                            const usage = { type: "assistant.usage", data: {
                                apiCallId: "known-call", model: "gpt-6-astra", copilotUsage: { totalNanoAiu: 100000000 },
                            } };
                            for (const event of [usage, usage, ...(mode === "partial-usage" ? [{
                                type: "assistant.usage", data: { model: "gpt-6-astra" },
                            }] : [])]) for (const handler of events) handler(event);
                            return { type: "assistant.message", data: {
                                content: mode === "non-object" ? "[]" : cleanupFailure && mode !== "abort-failure" ? "{}" : "SYNTHETIC INVALID JSON",
                            } };
                        },
                        async abort() { if (mode === "abort-failure") throw new Error("Synthetic abort failure"); },
                        async disconnect() {
                            disconnects++;
                            if (mode === "disconnect-failure") throw new Error("Synthetic disconnect failure");
                        },
                    }),
                    async stop() { stops++; return mode === "cleanup-failure" ? [new Error("Synthetic cleanup failure")] : []; },
                };
            } }),
        });
        t.after(async () => {
            if (cleanupFailure) await assert.rejects(controller.close(), /cleanup did not finish/);
            else await controller.close();
        });
        await controller.start("panel", f.input);
        await controller.settle();
        const result = await controller.status("panel", { runRef: f.input.mutationRef });
        assert.equal(result.phase, "failed");
        assert.equal(result.callsReserved, 1);
        assert.equal(result.spentAiCredits, 0.1, "Identical usage delivery is charged once even when the provider result is rejected.");
        assert.equal(result.costUnknown, cleanupFailure || mode === "partial-usage");
        assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
        assert.equal((await controller.start("panel", f.input)).phase, "failed");
        assert.equal((await controller.status("panel", { runRef: f.input.mutationRef })).spentAiCredits, 0.1);
        assert.equal(sends, 1);
        assert.equal(disconnects, 1);
        assert.equal(stops, 1);
    });
}
