import test from "node:test";
import assert from "node:assert/strict";
import { createCopilotEvaluator } from "../lib/copilot-evaluator.mjs";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { evaluationFixture } from "./evaluation-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { validateEvaluationDiagnostic, createEvaluationDiagnostic, projectSessionError } from "../lib/evaluation-diagnostics.mjs";
import { observeSessionSendRpc } from "../lib/evaluation-transport-diagnostics.mjs";

async function failedAttempt(t, send, { rpc = async () => ({ messageId: "synthetic-message" }), cleanupFailure = false } = {}) {
    const f = await evaluationFixture(t);
    const handlers = new Set(), counts = { sends: 0, stops: 0 };
    const connection = { sendRequest: rpc }, originalRpc = connection.sendRequest;
    const adapter = createCopilotEvaluator({
        baseDirectory: f.context.dataDir,
        observeTransport: client => observeSessionSendRpc(client.connection),
        createClient: () => ({
            connection,
            async createSession(config) {
                handlers.add(config.onEvent);
                return {
                    on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
                    async sendAndWait() {
                        counts.sends++;
                        const response = await connection.sendRequest("session.send", { prompt: "SYNTHETIC_PRIVATE_REQUEST" });
                        if (!response?.messageId) throw new Error("The runtime did not return a message ID for the structured send.");
                        return send(event => { for (const handler of handlers) handler(event); }, connection);
                    },
                    async abort() {}, async disconnect() {},
                };
            },
            async stop() { counts.stops++; return []; },
        }),
    });
    const controller = createEvaluationController(f.context, { ...f.options, evaluatorFactory: async () => adapter });
    t.after(async () => {
        if (cleanupFailure) await assert.rejects(controller.close(), /cleanup did not finish/);
        else await controller.close();
    });
    await controller.start("panel", f.input); await controller.settle();
    const receipt = await controller.status("panel", { runRef: f.input.mutationRef });
    assert.equal(counts.sends, 1); assert.equal(counts.stops, 1);
    assert.equal(receipt.phase, "failed"); assert.equal(receipt.callsReserved, 1);
    assert.equal(receipt.costUnknown, true);
    assert.equal((await loadBoardState(f.context)).personalEvaluation.modelEvaluation.records.length, 0);
    if (!cleanupFailure) assert.equal(connection.sendRequest, originalRpc);
    return receipt;
}

test("SDK session.error conversion preserves supported machine metadata in the actual receipt without retaining provider prose", async t => {
    const receipt = await failedAttempt(t, emit => {
        const event = { id: "synthetic-error", type: "session.error", data: {
            errorType: "query", statusCode: 400, errorCode: "SYNTHETIC_PRIVATE_CODE",
            message: "SYNTHETIC_PRIVATE_PROVIDER_PROSE", stack: "SYNTHETIC_PRIVATE_STACK",
            providerCallId: "SYNTHETIC_PRIVATE_CALL_ID", serviceRequestId: "SYNTHETIC_PRIVATE_SERVICE_ID",
            url: "https://private.invalid/SYNTHETIC_PRIVATE",
        } };
        emit(event); emit(event);
        throw new Error(event.data.message);
    });
    const diagnostic = receipt.results[0].diagnostic;
    assert.deepEqual(diagnostic.sessionError, {
        origin: "sdk-session-error", statusBasis: "provider-reported",
        errorType: "query", errorCode: null, statusCode: 400,
        providerCallIdPresent: true, serviceRequestIdPresent: true,
    });
    assert.equal(diagnostic.stage, "send");
    assert.equal(diagnostic.errorCode, "unknown-error", "Observation is not a retroactively assigned exception cause.");
    assert.equal(diagnostic.sendRpc.calls, 1);
    assert.equal(diagnostic.sendRpc.state, "resolved");
    assert.equal(diagnostic.sendRpc.messageIdReturned, true);
    assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_PRIVATE/);
    validateEvaluationDiagnostic(diagnostic);
});

test("a nonstandard numeric RPC rejection retains its bounded numeric code without inventing a named cause", async t => {
    const receipt = await failedAttempt(t, () => assert.fail("RPC rejection must not reach event processing"), {
        rpc: async () => { throw Object.assign(new Error("SYNTHETIC_PRIVATE"), { code: -32042 }); },
    });
    assert.equal(receipt.results[0].diagnostic.numericErrorCode, -32042);
    assert.equal(receipt.results[0].diagnostic.errorCode, "unknown-error");
    assert.equal(receipt.results[0].diagnostic.sendRpc.state, "rejected");
    assert.equal(receipt.results[0].diagnostic.sendRpc.numericErrorCode, -32042);
    assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_PRIVATE/);
});

for (const [message, code] of [
    ["Timeout after 120000ms waiting for the structured response", "evaluator-structured-timeout"],
    ["The runtime did not return a message ID for the structured send.", "evaluator-message-id-unavailable"],
    ["Session disconnected while waiting for a structured response", "evaluator-session-disconnected"],
    ["The requested run was aborted before a structured result was completed.", "evaluator-structured-aborted"],
]) {
    test(`source-defined SDK outcome ${code} remains distinct from unknown provider text`, async t => {
        const receipt = await failedAttempt(t, () => { throw new Error(message); });
        assert.equal(receipt.results[0].diagnostic.errorCode, code);
        assert.equal(receipt.results[0].diagnostic.sendInvoked, true);
        assert.equal(receipt.results[0].diagnostic.responseObserved, false);
    });
}

test("an acknowledged send without messageId is distinct from a rejected RPC", async t => {
    const receipt = await failedAttempt(t, () => assert.fail("No messageId"), { rpc: async () => ({}) });
    const diagnostic = receipt.results[0].diagnostic;
    assert.equal(diagnostic.errorCode, "evaluator-message-id-unavailable");
    assert.equal(diagnostic.sendRpc.state, "resolved");
    assert.equal(diagnostic.sendRpc.messageIdReturned, false);
});

test("duplicate SDK error/usage delivery does not duplicate charges or replace the first error metadata", async t => {
    const receipt = await failedAttempt(t, emit => {
        const usage = { type: "assistant.usage", data: { apiCallId: "synthetic-usage", model: "gpt-6-astra", copilotUsage: { totalNanoAiu: 100000000 } } };
        const error = { type: "session.error", data: { errorType: "quota", errorCode: "quota_exceeded", statusCode: 402, message: "SYNTHETIC_PRIVATE" } };
        emit(usage); emit(usage);
        emit({ ...error, agentId: "unrelated-subagent" });
        emit(error); emit(error);
        emit({ type: "session.error", data: { errorType: "query", statusCode: 500 } });
        throw new Error("SYNTHETIC_PRIVATE");
    });
    assert.equal(receipt.spentAiCredits, 0.1);
    assert.equal(receipt.results[0].diagnostic.sessionError.errorType, "quota");
    assert.equal(receipt.results[0].diagnostic.sessionError.errorCode, "quota_exceeded");
});

test("observer cleanup failure stays explicit and retains original send/error facts", async t => {
    const receipt = await failedAttempt(t, (emit, connection) => {
        emit({ type: "session.error", data: { errorType: "query", statusCode: 400, message: "SYNTHETIC_PRIVATE" } });
        connection.sendRequest = async () => ({});
        throw Object.assign(new Error("SYNTHETIC_PRIVATE"), { code: -32042 });
    }, { cleanupFailure: true });
    const diagnostic = receipt.results[0].diagnostic;
    assert.ok(diagnostic.cleanupStages.includes("transport-observer-restore"));
    assert.equal(diagnostic.sessionError.statusCode, 400);
    assert.equal(diagnostic.numericErrorCode, -32042);
    assert.equal(diagnostic.sendRpc.state, "resolved");
});

test("transport observation preserves arguments and response identity, records monotonic milestones and ignores unrelated RPC payloads", async () => {
    const request = { prompt: "SYNTHETIC_PRIVATE" }, response = { messageId: "SYNTHETIC_PRIVATE_ID" };
    const connection = { sendRequest(method, input) { assert.equal(this, connection); assert.equal(input, request); return response; } };
    const original = connection.sendRequest, observer = observeSessionSendRpc(connection);
    assert.equal(connection.sendRequest("session.options.update", request), response);
    assert.equal(observer.snapshot().state, "not-observed");
    assert.equal(await connection.sendRequest("session.send", request), response);
    assert.equal(observer.snapshot().calls, 1);
    assert.equal(observer.snapshot().state, "resolved");
    assert.ok(observer.snapshot().elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(observer.snapshot()), /SYNTHETIC_PRIVATE/);
    observer.restore(); observer.restore();
    assert.equal(connection.sendRequest, original);
});

test("new fields are strict, machine-only and optional for every legacy diagnostic", () => {
    const legacy = createEvaluationDiagnostic(new Error("unknown"), { stage: "send", sendInvoked: true });
    validateEvaluationDiagnostic(legacy);
    assert.equal(Object.hasOwn(legacy, "sessionError"), false);
    assert.equal(Object.hasOwn(legacy, "sendRpc"), false);
    const projected = projectSessionError({ type: "session.error", data: {
        errorType: "SYNTHETIC_PRIVATE", errorCode: "SYNTHETIC_PRIVATE", statusCode: 999,
        message: "SYNTHETIC_PRIVATE", stack: "SYNTHETIC_PRIVATE", url: "https://SYNTHETIC_PRIVATE",
    } });
    assert.equal(projected.errorType, "unknown"); assert.equal(projected.errorCode, null); assert.equal(projected.statusCode, null);
    assert.doesNotMatch(JSON.stringify(projected), /SYNTHETIC_PRIVATE/);
    assert.throws(() => validateEvaluationDiagnostic({ ...legacy, sessionError: { ...projected, message: "unreviewed" } }));
    assert.throws(() => validateEvaluationDiagnostic({ ...legacy, sessionError: { ...projected, statusBasis: "observed-workiq-http" } }));
    assert.throws(() => validateEvaluationDiagnostic({ ...legacy, numericErrorCode: 2 ** 40 }));
    assert.throws(() => observeSessionSendRpc(null), error => error.code === "evaluator-transport-observer-unavailable");
});
