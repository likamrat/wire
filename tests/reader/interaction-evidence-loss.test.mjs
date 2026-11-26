import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../../lib/collector.mjs";
import { extractScenarios, completeWorkIqCall } from "../../lib/history.mjs";
import { loadBoardState, replaceEvidence, mergeEvidenceWithState } from "../../lib/store.mjs";
import { createRecordedResults } from "../../web/recorded-results.mjs";
import { privateFixture } from "../support/helpers.mjs";

const wrappedError = path => "MCP server 'workiq': " + JSON.stringify({
    error: `Error: Error executing tool: No MCP server was found for path '${path}'. Use search to discover valid MCP server paths.\r\nCorrelationId: 00000000-0000-4000-8000-000000000000, TimeStamp: 2026-10-01_12:00:02`,
    requestId: "[invented-request]",
});
function events(message) {
    return [
        { id: "invented-prompt", type: "user.message", timestamp: "2026-10-01T12:00:00Z", data: { content: "Find the planning schema." } },
        { id: "invented-start", type: "tool.execution_start", timestamp: "2026-10-01T12:00:01Z",
            data: { toolCallId: "invented-call", toolName: "workiq-get_schema", arguments: { path: "invented-target" } } },
        { id: "invented-end", type: "tool.execution_complete", timestamp: "2026-10-01T12:00:02Z",
            data: { toolCallId: "invented-call", success: false, error: { code: "failure", message } } },
    ];
}
function collect(source) {
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 })).filter(Boolean);
    return { retained, records: extractScenarios(retained, { sessionId: "invented-session" },
        source[0].timestamp, source.at(-1).timestamp).scenarios };
}

test("wrapped Work IQ path failure preserves the screened reason through storage without envelope identifiers", async t => {
    const source = events(wrappedError("/invented/service"));
    const { retained, records } = collect(source);
    const failure = records[0].toolCalls[0].failureEvidence;
    assert.equal(failure.messageSignal, "mcp-server-path-not-found");
    assert.equal(failure.messageSource, "workiq-error-json");
    const direct = extractScenarios(source, { sessionId: "invented-session" }, source[0].timestamp, source.at(-1).timestamp).scenarios;
    assert.deepEqual(direct[0].toolCalls[0].failureEvidence, failure);
    const { context } = await privateFixture(t, []);
    await replaceEvidence(context, () => ({ records }));
    const call = mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0];
    const reason = createRecordedResults().failureReason(call);
    assert.match(reason, /No MCP server was found for path '\/invented\/service'/);
    assert.equal(call.failureEvidence.diagnostic.message, failure.diagnostic.message);
    const { diagnostic, ...historicalSignal } = failure;
    assert.equal(createRecordedResults().failureReason({ failureEvidence: historicalSignal }), "Work IQ could not find the requested MCP server");
    assert.equal(call.completionEventId, "invented-end");
    assert.equal(call.durationMs, 1000);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.observedGraphHttp, false);
    assert.doesNotMatch(JSON.stringify([retained, records, call, reason]), /00000000-0000-0000-0000-000000000000|invented-request/);
});

test("unsupported, private and ambiguous wrapped errors remain qualified gaps, not guessed causes", () => {
    const good = wrappedError("invented-path");
    for (const message of [
        good.replace("No MCP server was found", "Possibly no MCP server was found"),
        good.replace("Use search to discover valid MCP server paths.", "This was resolved."),
        good.replace("'workiq'", "'another-service'"),
        good + " trailing text", good.slice(0, -1),
        good.replace("invented-path", "Bearer " + "a".repeat(40)),
        wrappedError("x".repeat(8193)), { text: good },
        good.replace("invented-path", "\\u0042earer " + "a".repeat(40)),
        JSON.stringify({ error: good }), "No MCP server was found",
    ]) {
        const collected = collect(events(message));
        assert.equal(collected.records[0].toolCalls[0].failureEvidence.messageSignal, null);
        assert.doesNotMatch(JSON.stringify(collected), /a{40}/, "Credential-bearing inputs stay excluded from retained diagnostics");
    }
});

test("each completion keeps its own cause in a mixed call sequence", () => {
    const source = [events()[0]];
    for (const [index, outcome] of [true, true, true, true, false, false, null].entries()) {
        const [, start, end] = events(wrappedError("invented-path-" + index));
        start.id += index; end.id += index;
        start.data.toolCallId += index; end.data.toolCallId += index;
        source.push(start);
        if (outcome !== null) source.push({ ...end, data: { ...end.data, success: outcome } });
    }
    const calls = collect(source).records[0].toolCalls;
    assert.equal(calls.length, 7);
    assert.deepEqual(calls.map(call => call.toolSucceeded), [true, true, true, true, false, false, null]);
    assert.deepEqual(calls.map(call => call.failureEvidence?.messageSignal ?? null),
        [null, null, null, null, "mcp-server-path-not-found", "mcp-server-path-not-found", null]);
    assert.equal(calls[6].durationMs, null);
    assert.notEqual(calls[4].completionEventId, calls[5].completionEventId);
});

test("absence wording distinguishes source absence, policy exclusions and unsupported shapes", () => {
    const results = createRecordedResults();
    for (const [message, expected] of [
        [undefined, "The source supplied only a generic failure marker"],
        ["An invented unclassified failure", "Recorded error: An invented unclassified failure"],
        ["x".repeat(8193), "Error details exceeded the saving limit"],
        ["Bearer " + "a".repeat(40), "Error details excluded for privacy"],
        [{ error: "invented nested value" }, "WIRE could not extract a readable reason from the recorded error"],
    ]) {
        const call = collect(events(message)).records[0].toolCalls[0];
        assert.equal(results.failureReason(call), expected);
    }
    const missing = events();
    delete missing.at(-1).data.error;
    const missingCall = collect(missing).records[0].toolCalls[0];
    assert.equal(missingCall.failureEvidence.reason, "no-structured-error");
    assert.doesNotMatch(results.failureReason(missingCall), /generic failure marker/);
    assert.equal(results.failureReason({}), "Failure reason was not saved");
});

test("legacy unqualified failure metadata cannot attest that the source supplied no reason", () => {
    const results = createRecordedResults();
    for (const messageStatus of [undefined, "unqualified", "unknown-old-status"]) {
        const evidence = { version: 1, reason: "error-code-recorded", code: "failure", messageStatus, messageSignal: null };
        const before = structuredClone(evidence);
        const call = completeWorkIqCall({ startedAt: "2026-10-01T12:00:00Z" }, {
            id: "invented-legacy-end", timestamp: "2026-10-01T12:00:01Z",
            data: { success: false, wireFailureEvidence: evidence },
        });
        assert.equal(call.failureEvidence.messageStatus, "unqualified");
        assert.equal(results.failureReason(call), "Failure reason unavailable");
        assert.deepEqual(evidence, before);
    }
});
