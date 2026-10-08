import test from "node:test";
import assert from "node:assert/strict";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { createCopilotEvaluator } from "../lib/copilot-evaluator.mjs";
import { evaluationFixture, assessed } from "./evaluation-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { buildEvaluationPacket } from "../lib/evaluation-evidence.mjs";
import { createEvaluationDiagnostic, readEvaluationDiagnostic, validateEvaluationDiagnostic } from "../lib/evaluation-diagnostics.mjs";

const secretMarker = "SYNTHETIC_PRIVATE_ERROR_CONTENT";
for (const boundary of ["client-create", "session-create", "event-subscribe", "send", "response-check", "response-parse", "response-shape", "result-validation", "event-unsubscribe", "session-disconnect", "sdk-stop"]) {
    test(`safe diagnostics retain ${boundary} without retaining provider text or changing billing`, async t => {
        const f = await evaluationFixture(t);
        const handlers = new Set();
        let sends = 0, currentRequest;
        const adapter = createCopilotEvaluator({
            baseDirectory: f.context.dataDir,
            createClient: async () => {
                if (boundary === "client-create") throw Object.assign(new Error(secretMarker), { code: "EACCES" });
                return {
                    createSession: async () => {
                        if (boundary === "session-create") throw Object.assign(new Error(secretMarker), { code: -32602 });
                        return {
                            on(handler) {
                                if (boundary === "event-subscribe") throw new Error(secretMarker);
                                handlers.add(handler); return () => {
                                    handlers.delete(handler);
                                    if (boundary === "event-unsubscribe") throw new Error(secretMarker);
                                };
                            },
                            async sendAndWait() {
                                sends++;
                                if (boundary === "send") throw Object.assign(new Error(secretMarker), { code: "ECONNRESET" });
                                for (const handler of handlers) handler({ type: "assistant.usage", data: {
                                    model: "gpt-6-astra", apiCallId: "synthetic-call", copilotUsage: { totalNanoAiu: 100000000 },
                                } });
                                if (boundary === "response-check") return { type: "session.error", data: { message: secretMarker } };
                                return { type: "assistant.message", data: { content: boundary === "response-parse" ? secretMarker
                                    : JSON.stringify(boundary === "response-shape" ? [] : boundary === "result-validation" ? {} : assessed(currentRequest, false).rawResult) } };
                            },
                            async abort() {}, async disconnect() { if (boundary === "session-disconnect") throw new Error(secretMarker); },
                        };
                    },
                    async stop() { return boundary === "sdk-stop" ? [new Error(secretMarker)] : []; },
                };
            },
        });
        const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: async () => ({
            async evaluate(request, reservation, controls) { currentRequest = request; return adapter.evaluate(request, reservation, controls); },
        }) });
        t.after(async () => {
            if (["event-unsubscribe", "session-disconnect", "sdk-stop"].includes(boundary)) await assert.rejects(controller.close(), /cleanup did not finish/);
            else await controller.close();
        });
        await controller.start("panel", f.input);
        await controller.settle();
        const receipt = await controller.status("panel", { runRef: f.input.mutationRef });
        assert.equal(receipt.phase, "failed");
        assert.ok(receipt.results[0].diagnostic, "The failure boundary was lost.");
        const diagnostic = receipt.results[0].diagnostic;
        assert.equal(diagnostic.stage, boundary);
        assert.equal(diagnostic.sendInvoked, !["client-create", "session-create", "event-subscribe"].includes(boundary));
        assert.equal(diagnostic.transportEffect, diagnostic.sendInvoked ? diagnostic.responseObserved ? "response-observed" : "unknown" : "not-invoked");
        assert.equal(receipt.callsReserved, 1);
        assert.equal(receipt.spentAiCredits, ["response-check", "response-parse", "response-shape", "result-validation", "event-unsubscribe", "session-disconnect", "sdk-stop"].includes(boundary) ? 0.1 : 0);
        assert.equal(receipt.costUnknown, !["response-parse", "response-shape", "result-validation"].includes(boundary));
        if (boundary === "session-create") assert.equal(diagnostic.errorCode, "rpc-invalid-params");
        if (["event-unsubscribe", "session-disconnect", "sdk-stop"].includes(boundary)) assert.deepEqual(diagnostic.cleanupStages, [boundary]);
        assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secretMarker));
        assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
        await controller.start("panel", f.input);
        assert.equal(sends, diagnostic.sendInvoked ? 1 : 0, "A status/repeated identity must not send another request.");
    });
}

test("safe diagnostics reject unrecognized fields and cannot be forged by a provider error property", () => {
    const error = Object.assign(new Error(secretMarker), { code: secretMarker, diagnostic: { stage: "send", message: secretMarker } });
    assert.equal(readEvaluationDiagnostic(error), null);
    const diagnostic = createEvaluationDiagnostic(error, { stage: "source-read", sendInvoked: false });
    assert.equal(diagnostic.errorCode, "unknown-error");
    const missingCli = createEvaluationDiagnostic(new Error("Copilot CLI not found at " + secretMarker), { stage: "session-create", sendInvoked: false });
    assert.equal(missingCli.errorCode, "cli-executable-not-found");
    assert.doesNotMatch(JSON.stringify(missingCli), new RegExp(secretMarker));
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secretMarker));
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, message: secretMarker }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, stage: secretMarker }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, sendInvoked: false, responseObserved: true }), /Invalid safe/);
    assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, size: { kind: "reference-content", measured: 70000, limit: 65536, unit: "bytes", text: secretMarker } }), /Invalid safe/);
});

test("every strict result predicate survives persistence without scores, private values or a second call", async t => {
    const cases = [
        ["invalid-model-evaluation", result => { result.requirements[0] = null; }],
        ["unexpected-evaluation-field", result => { result.privateText = secretMarker; }],
        ["evaluation-packet-mismatch", result => { result.packetHash = "0".repeat(64); }],
        ["invalid-evaluation-check-list", result => { result.requirements = {}; }],
        ["invalid-evidence-anchor", result => { result.requirements[0].answerEvidence[0].end = 1000000; }],
        ["evidence-anchor-kind", result => { result.requirements[0].promptEvidence[0].ref = result.requirements[0].answerEvidence[0].ref; }],
        ["duplicate-evidence-anchor", result => { result.requirements[0].promptEvidence.push({ ...result.requirements[0].promptEvidence[0] }); }],
        ["invalid-evaluation-verdict", result => { result.requirements[0].verdict = secretMarker; }],
        ["invalid-verdict-reason", result => { result.requirements[0].reason = "missing-evidence"; }],
        ["invalid-requirement-identity", result => { result.requirements.push(structuredClone(result.requirements[0])); }],
        ["requirement-without-request", result => { result.requirements[0].promptEvidence = []; }],
        ["positive-accuracy-without-evidence", result => { result.requirements[0].referenceEvidence = []; }],
        ["contradiction-without-evidence", result => {
            Object.assign(result.requirements[0], { verdict: "not-met", reason: "contradicted", referenceEvidence: [] });
        }],
        ["incomplete-answer-coverage", result => { result.answerSegments[0].start = 1; }],
        ["invalid-answer-segment-kind", result => { result.answerSegments[0].kind = secretMarker; }],
        ["invalid-answer-applicability", result => { result.answerSegments[0].kind = "nonfactual"; }],
        ["positive-support-without-reference", result => { result.answerSegments[0].referenceEvidence = []; }],
        ["incomplete-action-coverage", result => { result.actions = []; }],
        ["action-intent-without-request", result => { result.actions[0].promptEvidence = []; }],
    ];
    for (const [code, change] of cases) await t.test(code, async t => {
        const f = await evaluationFixture(t, async request => {
            const response = assessed(request, false);
            change(response.rawResult);
            return response;
        });
        f.input.scenarioIds = f.input.scenarioIds.slice(0, 1);
        f.input.maxAiCredits = 30;
        await f.controller.start("panel", f.input); await f.controller.settle();
        const receipt = await f.controller.status("renewed-panel", { runRef: f.input.mutationRef, receiptToken: f.input.receiptToken });
        assert.equal(receipt.phase, "failed");
        assert.equal(receipt.callsReserved, 1);
        assert.equal(receipt.spentAiCredits, 0.1);
        assert.equal(receipt.costUnknown, false);
        assert.equal(receipt.results[0].reason, "evaluation-failed");
        const diagnostic = receipt.results[0].diagnostic;
        assert.equal(diagnostic.stage, "result-validation");
        assert.equal(diagnostic.errorCode, code);
        assert.equal(diagnostic.responseObserved, true);
        const state = await loadBoardState(f.context);
        assert.equal(state.personalEvaluation.modelEvaluation.records.length, 0);
        const quality = buildAssessmentModel(state).overview.metrics.filter(metric => ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension));
        assert.equal(quality.length, 3);
        assert.ok(quality.every(metric => metric.value === null && metric.denominator === 0 && metric.coverage.covered === 0));
        assert.doesNotMatch(JSON.stringify(state.personalEvaluation.modelEvaluation), /SYNTHETIC_PRIVATE_ERROR_CONTENT|How many synthetic|Three synthetic/);
        assert.deepEqual((await f.controller.start("panel", f.input)).results, receipt.results);
        assert.equal(f.calls.length, 1);
        assert.throws(() => validateEvaluationDiagnostic({ ...diagnostic, stage: "send" }), /Invalid safe/);
        assert.equal(createEvaluationDiagnostic(new TypeError(code), { stage: "send" }).errorCode, "unknown-error");
        assert.equal(createEvaluationDiagnostic(Object.assign(new Error(secretMarker), { code }), { stage: "result-validation" }).errorCode, "unknown-error");
    });
});

test("result diagnostics keep unknown historical errors and never retain near-match exception prose", () => {
    const legacy = createEvaluationDiagnostic(new Error(secretMarker), { stage: "result-validation", sendInvoked: true, responseObserved: true });
    assert.equal(validateEvaluationDiagnostic(legacy).errorCode, "unknown-error");
    const diagnostic = createEvaluationDiagnostic(new TypeError("invalid-evidence-anchor: " + secretMarker), {
        stage: "result-validation", sendInvoked: true, responseObserved: true,
    });
    assert.equal(diagnostic.errorCode, "unknown-error");
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secretMarker));
});

test("source-read failures persist a no-send diagnostic without reserving or starting an evaluator", async t => {
    const f = await evaluationFixture(t, undefined, { readSource: async () => { throw Object.assign(new Error(secretMarker), { code: "ENOENT" }); } });
    f.input.scenarioIds = f.input.scenarioIds.slice(0, 1);
    await f.controller.start("panel", f.input); await f.controller.settle();
    const result = await f.controller.status("panel", { runRef: f.input.mutationRef });
    assert.equal(result.callsReserved, 0); assert.equal(f.calls.length, 0);
    assert.equal(result.results[0].diagnostic.stage, "source-read");
    assert.equal(result.results[0].diagnostic.errorCode, "ENOENT");
    assert.equal(result.results[0].diagnostic.transportEffect, "not-invoked");
});

test("reference-count diagnostics preserve the existing count bound rather than silently dropping documents", async t => {
    const f = await evaluationFixture(t), original = f.inputs[0], events = original.events;
    const source = [events[0], events[1]], ids = [];
    for (let i = 0; i < 51; i++) {
        const id = "synthetic-call-" + i; ids.push(id);
        source.push(
            { ...events[2], id: "start-" + i, data: { ...events[2].data, toolCallId: id } },
            { ...events[3], id: "end-" + i, data: { toolCallId: id, success: true, result: { content: "Synthetic", structuredContent: { count: 1 } } } },
        );
    }
    source.push(events[4], events[5]);
    const interactionRef = "interaction-" + "a".repeat(32);
    assert.throws(() => buildEvaluationPacket(source, {
        interactionRef, sourceSessionId: original.record.sourceSessionId, promptEventId: events[1].id,
        promptTimestamp: events[1].timestamp, promptText: events[1].data.content, toolCallIds: ids,
    }, { confirmed: true, interactionRefs: [interactionRef], categories: ["answer", "references", "intent"],
        sourceConfigRef: "sourceconfig-" + "b".repeat(32), sourceConfigRevision: 1 }), error => {
        assert.deepEqual(readEvaluationDiagnostic(error).size, { kind: "references", measured: 102, limit: 100, unit: "items" });
        return error.message === "evidence-limit";
    });
});

test("packet size diagnostics distinguish UTF-8 item and aggregate packet limits with no source text", async t => {
    for (const kind of ["answer", "reference-content", "reference-structured", "packet"]) {
        const f = await evaluationFixture(t);
        const source = f.inputs[0], answer = source.events.find(event => event.type === "assistant.message");
        const completion = source.events.find(event => event.type === "tool.execution_complete");
        if (kind === "answer") answer.data.content = "é".repeat(32769);
        if (kind === "reference-content") completion.data.result.content = "x".repeat(65537);
        if (kind === "reference-structured") completion.data.result = { structuredContent: { text: "x".repeat(65537) } };
        if (kind === "packet") {
            source.record.userPrompt.text = "p".repeat(64000); source.events[1].data.content = source.record.userPrompt.text;
            answer.data.content = "a".repeat(64000);
            source.record.toolCalls[0].requestArgs = { text: "g".repeat(64000) };
            source.events[2].data.arguments = source.record.toolCalls[0].requestArgs;
            completion.data.result = { content: "r".repeat(64000), structuredContent: { text: "s".repeat(64000) } };
            const { replaceEvidence } = await import("../lib/store.mjs");
            const current = await loadBoardState(f.context);
            await replaceEvidence(f.context, () => ({ records: f.inputs.map(item => item.record), importCoverage: current.importCoverage }));
            f.input.expectedSourceRevision = (await loadBoardState(f.context)).evidenceRevision;
        }
        f.input.scenarioIds = [source.record.scenarioId];
        await f.controller.start("panel", f.input); await f.controller.settle();
        const receipt = await f.controller.status("panel", { runRef: f.input.mutationRef });
        assert.equal(receipt.results[0].reason, "evidence-limit");
        assert.ok(receipt.results[0].diagnostic, "The size kind/count was lost.");
        const diagnostic = receipt.results[0].diagnostic;
        assert.equal(diagnostic.stage, "packet-build");
        assert.equal(diagnostic.size.kind, kind);
        assert.ok(diagnostic.size.measured > diagnostic.size.limit);
        assert.equal(diagnostic.size.unit, "bytes");
        assert.equal(diagnostic.size.limit, kind === "packet" ? 262144 : 65536);
        if (kind === "answer") assert.equal(diagnostic.size.measured, 65538);
        assert.equal(diagnostic.sendInvoked, false);
        assert.equal(f.calls.length, 0);
        assert.equal(receipt.callsReserved, 0);
        assert.equal(receipt.costUnknown, false);
    }
});
