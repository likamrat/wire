import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent } from "../lib/collector.mjs";
import { extractScenarios, resultMetadata, completeWorkIqCall } from "../lib/history.mjs";
import { loadBoardState, replaceEvidence, mergeEvidenceWithState } from "../lib/store.mjs";
import { buildSanitizedRecord, buildSanitizedBundle } from "../lib/export.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { privateFixture } from "./helpers.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "../lib/collector-io.mjs";
import { mergedRecords } from "../lib/collector.mjs";
import { evaluationRecordFingerprint } from "../lib/evaluation-fingerprint.mjs";
import { AUTOMATIC_SCORE_METHOD, automaticScoreAttemptKey, planAutomaticScore } from "../lib/automatic-score-policy.mjs";
import { completionMetadata } from "../lib/graph-history-io.mjs";
import { completeGraphActivity } from "../lib/graph-history.mjs";

function sourceEvents(data = {}) {
    return [
        { id: "prompt", type: "user.message", timestamp: "2026-10-01T12:00:00.000Z", data: { content: "Invented fixture" } },
        { id: "start", type: "tool.execution_start", timestamp: "2026-10-01T12:00:01.000Z",
            data: { toolCallId: "invented-call", toolName: "workiq-fetch_blob", arguments: { path: "/me/drive/items/invented/content" } } },
        { id: "complete", type: "tool.execution_complete", timestamp: "2026-10-01T12:00:02.000Z",
            data: { toolCallId: "invented-call", success: false, ...data } },
    ];
}
function collect(events) {
    const retained = events.map(event => retainEvent(event, { credentialExclusions: 0 })).filter(Boolean);
    return { retained, records: extractScenarios(retained, { sessionId: "invented-source" }, events[0].timestamp, events.at(-1).timestamp).scenarios };
}

test("supported completion error survives local retention without stack or report payload", async t => {
    const { retained, records } = collect(sourceEvents({ error: { code: "AccessDenied", message: "INVENTED_PRIVATE_ERROR", stack: "INVENTED_STACK" } }));
    assert.equal(records[0].toolCalls[0].failureEvidence?.code, "AccessDenied");
    assert.equal(records[0].toolCalls[0].failureEvidence?.reason, "error-code-recorded");
    assert.equal(records[0].toolCalls[0].failureEvidence.diagnostic.message, "INVENTED_PRIVATE_ERROR");
    assert.doesNotMatch(JSON.stringify(retained), /INVENTED_STACK/);
    const { context } = await privateFixture(t, []);
    await replaceEvidence(context, () => ({ records }));
    const projected = mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0];
    assert.equal(projected.failureEvidence.code, "AccessDenied");
    assert.deepEqual(projected.apiResults, []);
    assert.equal(projected.observedGraphHttp, false);
    assert.equal(projected.toolSucceeded, false);
    assert.doesNotMatch(JSON.stringify(buildSanitizedRecord(records[0], "a".repeat(64))), /INVENTED_PRIVATE_ERROR|INVENTED_STACK/);
});

test("exact Work IQ MCP sign-in failures retain their wording and machine signal without implying HTTP", async t => {
    const message = 'MCP server \'workiq\': Re-authentication required for MCP server "workiq". Run /mcp auth workiq';
    const events = sourceEvents({ error: { code: "failure", message, stack: "PRIVATE_SIGN_IN_STACK" } });
    events[1].data.toolName = "workiq-fetch";
    events[1].data.arguments = { entityUrls: ["/me?$select=creationType"] };
    const { retained, records } = collect(events);
    assert.equal(records[0].toolCalls[0].failureEvidence.messageSignal, "workiq-sign-in-required");
    assert.equal(records[0].toolCalls[0].failureEvidence.messageStatus, "text-excluded");
    assert.deepEqual(records[0].toolCalls[0].apiResults, []);
    assert.equal(records[0].toolCalls[0].observedGraphHttp, false);
    assert.equal(records[0].toolCalls[0].failureEvidence.diagnostic.message, message);
    assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_SIGN_IN_STACK/);
    const { context } = await privateFixture(t, records);
    assert.equal(mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0].failureEvidence.messageSignal, "workiq-sign-in-required");
    const direct = extractScenarios(events, { sessionId: "invented-source" }, events[0].timestamp, events.at(-1).timestamp).scenarios[0];
    assert.deepEqual(direct.toolCalls[0].failureEvidence, records[0].toolCalls[0].failureEvidence);
    for (const unsafeOrDifferent of [
        'Re-authentication required for MCP server "another-service". Run /mcp auth another-service',
        "No " + message, "Example: " + message, message + " was resolved",
        message + " Bearer " + "a".repeat(40), "x".repeat(8193) + message,
        { text: message },
    ]) {
        const projected = collect(sourceEvents({ error: { code: "failure", message: unsafeOrDifferent } }));
        assert.equal(projected.records[0].toolCalls[0].failureEvidence.messageSignal, null);
        assert.doesNotMatch(JSON.stringify(projected.retained), /Bearer/);
    }
});

test("MCP text-content JSON result array retains supported API metadata only", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ results: [{ statusCode: 403, error: { code: "AccessDenied" }, body: { displayName: "INVENTED_BODY" } }] }) }] };
    assert.equal(resultMetadata(result)[0]?.errorCode, "AccessDenied");
    const { retained, records } = collect(sourceEvents({ result }));
    assert.equal(records[0].toolCalls[0].apiResults[0]?.statusCode, 403);
    assert.doesNotMatch(JSON.stringify(retained), /INVENTED_BODY/);
});

test("direct source extraction and incremental collection agree on explicit structured errors", () => {
    const events = sourceEvents({ result: { structuredContent: { error: { code: "failure", message: "Access denied. INVENTED_PRIVATE_PAYLOAD" } } } });
    const source = { sessionId: "invented-source" };
    const direct = extractScenarios(events, source, events[0].timestamp, events.at(-1).timestamp).scenarios[0].toolCalls[0];
    const incremental = collect(events).records[0].toolCalls[0];
    assert.deepEqual(direct.failureEvidence, incremental.failureEvidence);
    assert.equal(direct.failureEvidence?.messageSignal, "access-denial");
    assert.equal(direct.failureEvidence.diagnostic.message, "Access denied. INVENTED_PRIVATE_PAYLOAD");
});

test("absence reasons distinguish inspected source, excluded content and unqualified retained history", () => {
    for (const [data, reason] of [
        [{}, "no-structured-error"],
        [{ error: { message: "INVENTED_ERROR_WITH_NO_CODE" } }, "error-details-excluded"],
        [{ error: { code: "bad code with prose", message: "INVENTED_ERROR" } }, "error-details-excluded"],
        [{ error: { code: "ghp_" + "a".repeat(36), message: "INVENTED_SECRET" } }, "error-details-excluded"],
        [{ error: { code: "github_pat_" + "a".repeat(36), message: "INVENTED_SECRET" } }, "error-details-excluded"],
        [{ error: { code: "call_INVENTED12345", message: "INVENTED_SECRET" } }, "error-details-excluded"],
        [{ error: { code: "C:\\private\\INVENTED_PATH", message: "INVENTED_ERROR" } }, "error-details-excluded"],
        [{ error: { code: "https://example.invalid/INVENTED_PATH", message: "INVENTED_ERROR" } }, "error-details-excluded"],
        [{ result: { content: "INVENTED_UNSTRUCTURED_COMPLETION" } }, "result-content-excluded"],
        [{ result: { structuredContent: { error: { code: "AccessDenied", message: "INVENTED_ERROR" } } } }, "error-code-recorded"],
    ]) {
        const { retained, records } = collect(sourceEvents(data));
        assert.equal(records[0].toolCalls[0].failureEvidence.reason, reason);
        assert.doesNotMatch(JSON.stringify(retained), /INVENTED_UNSTRUCTURED|INVENTED_PATH|call_INVENTED|ghp_|github_pat_/);
        assert.equal(records[0].toolCalls[0].parentInvocationEvidence, "source-field-absent");
        assert.equal(records[0].toolCalls[0].parallelGroupEvidence, "adapter-not-supported");
    }
    const old = extractScenarios(sourceEvents(), { sessionId: "invented-source" }, sourceEvents()[0].timestamp, sourceEvents().at(-1).timestamp).scenarios[0].toolCalls[0];
    assert.equal(Object.hasOwn(old, "failureEvidence"), false, "Old compacted history has no source-absence attestation");
    assert.equal(Object.hasOwn(old, "parentInvocationEvidence"), false);
    assert.equal(Object.hasOwn(completeWorkIqCall({ startedAt: sourceEvents()[1].timestamp }, null), "failureEvidence"), false);
});

test("all new-report privacy modes exclude private failure payloads across every format", { timeout: 60000 }, async () => {
    const { records } = collect(sourceEvents({ error: { code: "failure", message: "INVENTED_PRIVATE_ERROR_PAYLOAD", stack: "INVENTED_PRIVATE_STACK" } }));
    // Even malformed legacy/local metadata must not bypass the report allowlist.
    records[0].toolCalls[0].failureEvidence.privatePayload = "INVENTED_PRIVATE_RETAINED_PAYLOAD";
    records[0].toolCalls[0].failureEvidence.code = "C:\\INVENTED_PRIVATE_PATH";
    records[0].toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError: true, statusCode: 403,
        contentStatus: "body-excluded", resultCount: null,
        diagnostic: { version: 1, source: "mcp-result-text", status: "recorded", message: "INVENTED_PRIVATE_RESULT_ERROR" },
        description: { version: 1, status: "recorded", text: "INVENTED_PRIVATE_RESULT_DESCRIPTION" } };
    for (const promptMode of ["none", "masked", "original"]) {
        const bundle = await buildSanitizedBundle(JSON.parse(JSON.stringify(records)), "b".repeat(64), { promptMode, formats: ["json", "html", "markdown", "pdf"] });
        for (const [file, content] of Object.entries(bundle.files)) {
            if (!file.endsWith(".pdf")) {
                assert.doesNotMatch(String(content), /INVENTED_PRIVATE/);
                continue;
            }
            const loading = getDocument({ data: new Uint8Array(content), useSystemFonts: true });
            const pdf = await loading.promise;
            try {
                for (let page = 1; page <= pdf.numPages; page++) {
                    const text = (await (await pdf.getPage(page)).getTextContent()).items.map(item => item.str).join(" ");
                    assert.doesNotMatch(text, /INVENTED_PRIVATE/);
                }
            } finally { await loading.destroy(); }
        }
    }
});

test("successful completion is not converted to tool failure by returned API metadata", () => {
    const { records } = collect(sourceEvents({ success: true, error: { code: "IgnoredForSuccess" },
        result: { structuredContent: { results: [{ statusCode: 403, error: { code: "AccessDenied" } }] } } }));
    const call = records[0].toolCalls[0];
    assert.equal(call.toolSucceeded, true);
    assert.equal(call.reportedOutcome, "succeeded");
    assert.equal(Object.hasOwn(call, "failureEvidence"), false);
    assert.equal(call.apiResults[0].statusCode, 403);
    assert.equal(call.observedGraphHttp, false);
});

test("known parent survives while a parallel grouping is not guessed from unrelated fields", () => {
    const events = sourceEvents();
    Object.assign(events[1].data, { parentToolCallId: "invented-parent", parallelGroup: "unsupported-input" });
    const call = collect(events).records[0].toolCalls[0];
    assert.equal(call.parentToolCallId, "invented-parent");
    assert.equal(call.parentInvocationEvidence, "recorded");
    assert.equal(call.parallelGroup, null);
    assert.equal(call.parallelGroupEvidence, "adapter-not-supported");
});

test("message signals are bounded, credential-screened mentions, not inferred causes", () => {
    for (const [message, signal, status] of [
        ["Access denied to C:\\private\\INVENTED_PATH; contact example@example.invalid. INVENTED_PRIVATE_PAYLOAD", "access-denial", "text-excluded"],
        ["Permission denied", "access-denial", "text-excluded"],
        ["No access denied error occurred", null, "text-excluded"],
        ["Access denied was ruled out", null, "text-excluded"],
        ["It might be access denied or another failure", null, "text-excluded"],
        ["Forbidden response is possible", null, "text-excluded"],
        ["Access denied. Bearer " + "a".repeat(40), null, "sensitive-excluded"],
        ["Access denied " + "x".repeat(8192), null, "size-excluded"],
        ["Access denied " + "\u65e5".repeat(2800), null, "size-excluded"],
        [{ text: "Access denied", body: "INVENTED_PRIVATE_PAYLOAD" }, null, "unsupported-format"],
        [undefined, null, "not-supplied"],
    ]) {
        const { retained, records } = collect(sourceEvents({ error: { code: "failure", message } }));
        const evidence = records[0].toolCalls[0].failureEvidence;
        assert.equal(evidence.code, "failure");
        assert.equal(evidence.messageStatus, status);
        assert.equal(evidence.messageSignal, signal);
        assert.doesNotMatch(JSON.stringify(retained), /INVENTED_PRIVATE|INVENTED_PATH|example@example|Bearer/);
        assert.equal(records[0].toolCalls[0].observedGraphHttp, false);
        assert.deepEqual(records[0].toolCalls[0].apiResults, []);
    }
    for (const error of ["Unsupported prose format", { code: 403 }, ["Forbidden"]]) {
        assert.equal(collect(sourceEvents({ error })).records[0].toolCalls[0].failureEvidence.reason, "unsupported-error-format");
    }
});

test("structured MCP request timeout survives the real collector without implying HTTP or copying the stack", async t => {
    const events = sourceEvents({ error: { code: "failure", message: "Invented tool: MCP error -32001: Request timed out", stack: "PRIVATE_TIMEOUT_STACK" } });
    events[2].timestamp = "2026-10-01T12:03:01.024Z";
    const { retained, records } = collect(events);
    const call = records[0].toolCalls[0];
    assert.equal(call.failureEvidence.messageSignal, "request-timeout");
    assert.equal(call.failureEvidence.code, "failure");
    assert.equal(call.durationMs, 180024);
    assert.equal(call.observedGraphHttp, false);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.failureEvidence.diagnostic.message, events[2].data.error.message);
    assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_TIMEOUT_STACK/);
    const { context } = await privateFixture(t, records);
    assert.equal(mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0].failureEvidence.messageSignal, "request-timeout");
    for (const message of ["No MCP error -32001: Request timed out", "Possibly MCP error -32001: Request timed out",
        "MCP error -32001: Request timed out was ruled out", "Request timed out", "HTTP 504",
        "MCP error -32001: Request timed out. Bearer " + "a".repeat(40),
        "x".repeat(8193) + " MCP error -32001: Request timed out"]) {
        assert.equal(collect(sourceEvents({ error: { code: "failure", message } })).records[0].toolCalls[0].failureEvidence.messageSignal, null);
    }
});

test("JSON payloads never fall back to raw status lines when result arrays are absent or empty", async t => {
    const { root } = await privateFixture(t, []);
    const payload = { error: { code: "failure", message: "Access denied", stack: "PRIVATE_STACK" }, statusCode: 403, body: { name: "PRIVATE_PERSON" } };
    const examples = [
        JSON.stringify(payload),
        JSON.stringify({ ...payload, results: [] }),
        JSON.stringify({ ...payload, results: [{ statusCode: 403, body: { name: "PRIVATE_ENTITY" } }] }),
        JSON.stringify(payload, null, 2),
        '{"statusCode":403,"body":{"name":"PRIVATE_MALFORMED"',
        '```json\n{"statusCode":403,"body":{"name":"PRIVATE_FENCED"}}\n```',
        '{"statusCode":403,"body":{"name":"PRIVATE_OVERSIZE","padding":"' + "x".repeat(256001) + '"}}',
    ];
    for (const [index, text] of examples.entries()) {
        const events = sourceEvents({ result: { content: [{ type: "text", text }] } });
        const { retained, records } = collect(events);
        const checkpoint = path.join(root, `checkpoint-${index}.json`);
        await atomicJson(checkpoint, { schemaVersion: 1, events: retained });
        assert.doesNotMatch(await readFile(checkpoint, "utf8"), /PRIVATE_/, `checkpoint case ${index}`);
        const direct = extractScenarios(events, { sessionId: "invented-source" }, events[0].timestamp, events.at(-1).timestamp).scenarios;
        assert.doesNotMatch(JSON.stringify([records, direct]), /PRIVATE_/, `projection case ${index}`);
    }
});

test("completion projections keep numeric metadata and blockers without payload strings", () => {
    const project = result => completionMetadata({ id: "complete", type: "tool.execution_complete", data: { toolCallId: "call", success: false, result } });
    const graph = { outputStatusEligible: true, evidenceLevel: "requested-direct-graph", evidenceRefs: [] };
    for (const result of [
        { content: '{"statusCode":403,"body":{"name":"PRIVATE_JSON"}}' },
        { content: [{ type: "text", text: '{"results":[],"httpStatus":403,"body":"PRIVATE_EMPTY"}' }] },
        { structuredContent: { statusCode: 403, body: { name: "PRIVATE_STRUCTURED" } } },
        { content: "HTTP/1.1 403 PRIVATE_DISPLAY_LINE" },
    ]) {
        const retained = project(result);
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_/);
        assert.equal(completeGraphActivity(graph, retained, 1).httpStatus, 403);
    }
    for (const text of [
        'diff --git PRIVATE_DIFF\nstatusCode: 403',
        'fixture PRIVATE_FIXTURE statusCode: 403',
        'Bearer ' + "x".repeat(40) + '\n{"statusCode":403}',
        'statusCode: 403 ghp_' + "x".repeat(40),
        'statusCode: 403 password=PRIVATE_PASSWORD',
        'HTTP/1.1 301 PRIVATE_REDIRECT\nHTTP/2 403 PRIVATE_SECOND_STATUS',
    ]) {
        const retained = project({ content: text });
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_|x{40}|ghp_/);
        assert.notEqual(completeGraphActivity(graph, retained, 1).evidenceLevel, "output-visible-http");
    }
    assert.doesNotMatch(JSON.stringify(project({ structuredContent: { statusCode: { body: "PRIVATE_STATUS" }, httpStatus: "PRIVATE_STATUS" } })), /PRIVATE_/);
});

test("mixed structured and display statuses preserve disagreement, agreement and blockers without raw text", () => {
    const graph = { outputStatusEligible: true, evidenceLevel: "requested-direct-graph", evidenceRefs: [], httpStatus: null };
    const cases = [
        [{ statusCode: 200 }, "HTTP/1.1 403 PRIVATE_DISAGREEMENT", null],
        [{ statusCode: 200 }, [{ type: "text", text: "HTTP/1.1 403 PRIVATE_MCP_DISPLAY" }], null],
        [{ statusCode: 200 }, '{"statusCode":403,"body":"PRIVATE_JSON_CONFLICT"}', null],
        [{ httpStatus: 200, statusCode: 403 }, "", null],
        [{ statusCode: 200 }, "HTTP/1.1 200 PRIVATE_AGREEMENT", 200],
        [{ statusCode: 200 }, "HTTP/1.1 200\n".repeat(50), 200],
        [{ statusCode: 200 }, "HTTP/1.1 200\n".repeat(50) + "HTTP/1.1 403", null],
        [{ statusCode: 200 }, "HTTP/1.1 200\nfixture PRIVATE_FIXTURE", null],
        [{ statusCode: 200 }, "HTTP/1.1 200\nBearer " + "x".repeat(40), null],
        [{ statusCode: 200 }, "HTTP/1.1 403\nBearer " + "x".repeat(40), null],
    ];
    for (const [structuredContent, content, expected] of cases) {
        const end = sourceEvents({ result: { structuredContent, content } }).at(-1);
        for (const projected of [completionMetadata(end), retainEvent(end, { credentialExclusions: 0 })]) {
            assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|x{40}/);
            const completed = completeGraphActivity(graph, projected, 1);
            assert.equal(completed.httpStatus, expected, JSON.stringify({ structuredContent, expected }));
            assert.equal(completed.evidenceLevel, expected === null ? "requested-direct-graph" : "output-visible-http");
            if (expected !== null) assert.equal(projected.data.result.content, `statusCode: ${expected}`);
        }
    }
});

test("unqualified checkpoint reprocessing preserves completed automatic attempt identity with allowance remaining", () => {
    const events = sourceEvents();
    const extracted = extractScenarios(events, { sessionId: "invented-source" }, events[0].timestamp, events.at(-1).timestamp).scenarios;
    const old = structuredClone(extracted[0]);
    old.graphActivities = [];
    for (const key of ["failureEvidence", "parentInvocationEvidence", "parallelGroupEvidence"]) delete old.toolCalls[0][key];
    old.responseTiming = { status: "measured", reason: null, promptEventId: "prompt", finalEventId: "final", completionEventId: "turn-end" };
    const fingerprint = evaluationRecordFingerprint(old);
    const approval = { schemaVersion: 1, approvalRef: "approval-" + "a".repeat(32), revision: 1, state: "enabled",
        sourceConfigRef: "sourceconfig-" + "b".repeat(32), sourceConfigRevision: 1, windowDays: 30, chatRefs: ["chat-" + "c".repeat(32)],
        method: { ...AUTOMATIC_SCORE_METHOD }, evidenceCategories: ["prompt", "answer", "references", "intent"],
        maxCalls: 6, maxAiCredits: 60, approvedAt: events[0].timestamp, origin: "explicit-automatic-score-approval" };
    const interactionRef = "interaction-" + "d".repeat(32), key = automaticScoreAttemptKey(approval, interactionRef, old);
    const reprocessed = mergedRecords([old], extracted)[0];
    assert.equal(evaluationRecordFingerprint(reprocessed), fingerprint);
    assert.equal(automaticScoreAttemptKey(approval, interactionRef, reprocessed), key);
    const decision = planAutomaticScore({ approval,
        source: { available: true, collectionEnabled: true, sourceConfigRef: approval.sourceConfigRef, sourceConfigRevision: 1, windowDays: 30 },
        candidates: [{ interactionRef, chatRef: approval.chatRefs[0], record: reprocessed }], attempts: [{ attemptKey: key, phase: "complete" }],
        usage: { callsReserved: 1, spentAiCredits: 0.1, costUnknown: false, active: false, cleanupPending: false }, now: "2026-10-08T12:00:00.000Z" });
    assert.equal(decision.reason, "processed");
    assert.equal(decision.next, null);
});
