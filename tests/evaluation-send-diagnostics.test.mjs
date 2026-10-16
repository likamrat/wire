import test from "node:test";
import assert from "node:assert/strict";
import { validateEvaluationDiagnostic, createEvaluationDiagnostic, projectSessionError } from "../lib/evaluation-diagnostics.mjs";
import { observeSessionSendRpc } from "../lib/evaluation-transport-diagnostics.mjs";

test("historical transport observation preserves identity and ignores unrelated private RPC payloads", async () => {
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

test("machine-only fields remain strict and optional for every legacy diagnostic", () => {
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
