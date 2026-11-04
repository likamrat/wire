import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { privateFixture } from "./helpers.mjs";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { buildSanitizedRecord } from "../lib/export.mjs";
import { errorDiagnostic, retainedErrorDiagnostic } from "../lib/failure-details.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

export function failedEvents(data, now = Date.now() - 5000) {
    const event = (id, type, data, offset) => ({ id, type, data, timestamp: new Date(now + offset).toISOString() });
    return [
        event("prompt", "user.message", { content: "Remove the invented task plan." }, 0),
        event("start", "tool.execution_start", { toolCallId: "invented-delete", toolName: "workiq-delete_entity",
            arguments: { entityUrl: "/planner/plans/invented-plan", headers: { "If-Match": "invented-etag" } } }, 1),
        event("complete", "tool.execution_complete", { toolCallId: "invented-delete", success: false, ...data }, 839),
    ];
}

function collect(data) {
    const events = failedEvents(data);
    const retained = events.map(event => retainEvent(event, { credentialExclusions: 0 })).filter(Boolean);
    const record = extractScenarios(retained, { sessionId: "invented-session" }, events[0].timestamp, events.at(-1).timestamp).scenarios[0];
    return { events, retained, record, call: record.toolCalls[0] };
}

test("original SDK error text survives retention and persisted readback independently of reply saving", async t => {
    const message = "The supplied version does not match the current resource. Read the resource again before retrying.";
    const { call, record, retained } = collect({ error: { code: "failure", message, stack: "EXCLUDED_STACK" } });
    assert.equal(call.failureEvidence.diagnostic?.message, message);
    assert.equal(call.failureEvidence.diagnostic.source, "completion-error");
    assert.equal(call.toolCallId, "invented-delete");
    assert.equal(call.completionEventId, "complete");
    assert.equal(call.durationMs, 838);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.observedGraphHttp, false);
    const { context } = await privateFixture(t, [record]);
    const state = await loadBoardState(context);
    assert.equal(state.personalEvaluation, undefined);
    assert.equal(mergeEvidenceWithState(state)[0].toolCalls[0].failureEvidence.diagnostic.message, message);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_STACK/);
    assert.doesNotMatch(JSON.stringify(buildSanitizedRecord(record, "a".repeat(64))), /supplied version/);
});

test("Work IQ envelope keeps each error on its own result, not a guessed parent cause", () => {
    const { call, retained } = collect({ error: { code: "failure", message: 'MCP server \'workiq\': ' + JSON.stringify({
        results: [
            { statusCode: 412, error: { error: { code: "PreconditionFailed", message: "Refresh the resource version.",
                details: [{ code: "VersionMismatch", message: "The supplied version is stale." }], innerError: { requestId: "EXCLUDED_REQUEST" } } } },
            { statusCode: 200, data: { message: "EXCLUDED_SUCCESS_BODY" } },
        ], requestId: "EXCLUDED_ENVELOPE_ID",
    }) } });
    assert.equal(call.apiResults[0].errorDiagnostic?.message, "Refresh the resource version.");
    assert.deepEqual(call.apiResults[0].errorDiagnostic.details, [{ code: "VersionMismatch", message: "The supplied version is stale." }]);
    assert.equal(call.apiResults[1].errorDiagnostic, undefined);
    assert.equal(call.failureEvidence.diagnostic?.message, undefined);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_/);
});

test("single Work IQ error envelope preserves nested Graph wording and status without inventing API entries", () => {
    const message = "You cannot access the invented item, or the item may not exist.";
    const { call, retained, events } = collect({ error: { code: "failure", message: `MCP server 'workiq': ${JSON.stringify({
        statusCode: 403, data: null, error: { error: { code: "", message, innerError: {
            "request-id": "EXCLUDED_REQUEST_ID", date: "2026-10-01T00:00:00Z",
        } } }, requestId: "EXCLUDED_ENVELOPE_ID",
    })}` } });
    assert.equal(call.failureEvidence.diagnostic.message, message);
    assert.equal(call.failureEvidence.diagnostic.statusCode, 403);
    assert.equal(call.failureEvidence.diagnostic.source, "workiq-error-json");
    assert.equal(call.failureEvidence.diagnostic.code, undefined, "An empty original code is not filled with a guessed cause");
    assert.equal(call.failureEvidence.messageSignal, null, "The original either/or explanation must not become a definite access-denial diagnosis");
    assert.deepEqual(call.apiResults, [], "A single error envelope is not a recorded result array");
    assert.equal(call.observedGraphHttp, false);
    assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_|request-id|innerError/);
    const direct = extractScenarios(events, { sessionId: "invented-session" }, events[0].timestamp, events.at(-1).timestamp).scenarios[0];
    assert.deepEqual(direct.toolCalls[0].failureEvidence, call.failureEvidence);
});

test("supported error shapes share the same bounded diagnostic seam without parsing ordinary result bodies", () => {
    for (const [data, source] of [
        [{ error: { code: -32001, message: "Request timed out", statusCode: 504 } }, "completion-error"],
        [{ result: { structuredContent: { error: { code: "Conflict", message: "The resource changed." } } } }, "result-error"],
        [{ result: { isError: true, content: [{ type: "text", text: "The resource changed." }] } }, "mcp-result-text"],
        [{ error: { code: "failure", message: `MCP server 'workiq': ${JSON.stringify({ error: "The resource changed.", requestId: "EXCLUDED_ID" })}` } }, "workiq-error-json"],
    ]) {
        const { call, events } = collect(data);
        assert.equal(call.failureEvidence.diagnostic.source, source);
        assert.ok(call.failureEvidence.diagnostic.message);
        const direct = extractScenarios(events, { sessionId: "invented-session" }, events[0].timestamp, events.at(-1).timestamp).scenarios[0];
        assert.deepEqual(direct.toolCalls[0].failureEvidence, call.failureEvidence);
        assert.deepEqual(retainedErrorDiagnostic(call.failureEvidence.diagnostic), call.failureEvidence.diagnostic);
    }
    for (const data of [
        { success: true, error: { message: "Not a failed call." } },
        { result: { content: [{ type: "text", text: "An ordinary tool response, not an error." }] } },
    ]) assert.equal(collect(data).call.failureEvidence?.diagnostic, undefined);
    const separate = collect({ error: { message: "Parent transport failed." }, result: { structuredContent: {
        results: [{ statusCode: 403, error: { message: "Only this returned item was denied." } }],
    } } }).call;
    assert.equal(separate.failureEvidence.diagnostic.message, "Parent transport failed.");
    assert.equal(separate.apiResults[0].errorDiagnostic.message, "Only this returned item was denied.");
    assert.equal(createRecordedResults().failureReason(collect({ error: { code: -32001 } }).call), "Recorded error: -32001");
    assert.equal(createRecordedResults().failureReason(collect({ error: { statusCode: 412 } }).call), "Tool-reported status: 412");
});

test("diagnostics exclude secrets, payloads and stacks; redact identifiers; preserve explicit bounds after reload", () => {
    for (const [message, status] of [
        ["Authorization: Bearer " + "a".repeat(40), "sensitive-excluded"],
        ["Confidential customer content", "sensitive-excluded"],
        ['Returned payload: {"body":"EXCLUDED_BODY"}', "unsupported-format"],
        ["x".repeat(8193), "size-excluded"],
        ["\u65e5".repeat(2731), "size-excluded"],
        [{ text: "Not a supported string." }, "unsupported-format"],
    ]) {
        const { call, retained } = collect({ error: { code: "Conflict", message, stack: "EXCLUDED_STACK",
            body: "EXCLUDED_BODY", innerError: { message: "EXCLUDED_INNER" } } });
        assert.equal(call.failureEvidence.diagnostic.status, status);
        assert.equal(call.failureEvidence.diagnostic.message, undefined);
        assert.equal(call.failureEvidence.diagnostic.code, "Conflict");
        assert.deepEqual(retainedErrorDiagnostic(call.failureEvidence.diagnostic), call.failureEvidence.diagnostic);
        assert.doesNotMatch(JSON.stringify(retained), /EXCLUDED_|Bearer|a{40}/);
    }
    const diagnostic = errorDiagnostic({ code: "Conflict",
        message: "Read REDACTED again; contact person@example.invalid. Resource 11111111-2222-4333-8444-555555555555 changed.",
        details: [{ code: "VersionMismatch", message: "Refresh its version." }],
        target: "EXCLUDED_TARGET", stack: "EXCLUDED_STACK" }, "completion-error");
    assert.equal(diagnostic.status, "redacted");
    assert.equal(diagnostic.message, "Read REDACTED again; contact [redacted]. Resource [redacted] changed.");
    assert.deepEqual(retainedErrorDiagnostic(diagnostic), diagnostic, "redaction is idempotent and preserves source words");
    assert.equal(errorDiagnostic({ message: "x".repeat(8192) }, "completion-error").status, "recorded");
    assert.equal(errorDiagnostic({ message: "x".repeat(8192), details: [{ message: "too much" }] }, "completion-error").status, "size-excluded");
    assert.equal(errorDiagnostic({ details: Array.from({ length: 11 }, () => ({ message: "too many" })) }, "completion-error").status, "size-excluded");
    assert.equal(retainedErrorDiagnostic({ version: 2, source: "completion-error", message: "unqualified" }), null);
    assert.equal(retainedErrorDiagnostic({ version: 1, source: "completion-error", status: "sensitive-excluded",
        message: "An excluded stored field must not be re-admitted." }).message, undefined);
    assert.equal(errorDiagnostic({ message: "a@b.co ".repeat(1100) }, "completion-error").status, "size-excluded",
        "redaction must not grow retained text past its byte budget");
});
