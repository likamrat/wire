import test from "node:test";
import assert from "node:assert/strict";
import { retainEvent, createCollector } from "../lib/collector.mjs";
import { extractScenarios } from "../lib/history.mjs";
import { loadBoardState, replaceEvidence, mergeEvidenceWithState } from "../lib/store.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { privateFixture } from "./helpers.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildSanitizedRecord } from "../lib/export.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { indexSearchText, rankTextSearch } from "../lib/search-text.mjs";

const failedResult = () => ({
    statusCode: 500, data: null,
    error: { error: { code: "InternalServerError", message: "Error while processing response.",
        innerError: { "request-id": "PRIVATE_REQUEST_ID" } } },
});
const envelope = results => `MCP server 'workiq': ${JSON.stringify({ results, requestId: "PRIVATE_ENVELOPE_ID" })}`;
function events(message) {
    return [
        { id: "prompt", type: "user.message", timestamp: "2026-10-01T12:00:00.000Z", data: { content: "Invented request" } },
        { id: "start", type: "tool.execution_start", timestamp: "2026-10-01T12:00:01.000Z",
            data: { toolCallId: "invented-call", toolName: "workiq-fetch", arguments: { entityUrls: ["/chats/invented-a/messages", "/chats/invented-b/messages"] } } },
        { id: "complete", type: "tool.execution_complete", timestamp: "2026-10-01T12:00:02.219Z",
            data: { toolCallId: "invented-call", success: false, error: { code: "failure", message } } },
    ];
}
const extract = rows => extractScenarios(rows, { sessionId: "invented-session" }, rows[0].timestamp, rows.at(-1).timestamp).scenarios;

test("Work IQ ask error envelope retains its supplied reason and code instead of an unreadable-error fallback", () => {
    const message = "The invented source policy is unavailable.";
    const source = events("MCP server 'workiq': " + JSON.stringify({
        response: null, error: message, errorCode: "SourcePolicyUnavailable",
        conversationId: "PRIVATE_CONVERSATION", recoveryAction: "None", requestId: "PRIVATE_REQUEST",
    }));
    source[1].data.toolName = "workiq-ask";
    source[1].data.arguments = { question: "Read the invented planning conversation." };
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const call = extract(retained)[0].toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call),
        "Recorded error: The invented source policy is unavailable. (SourcePolicyUnavailable)");
    assert.equal(call.failureEvidence.code, "SourcePolicyUnavailable");
    assert.equal(call.failureEvidence.diagnostic.message, message);
    assert.equal(call.failureEvidence.diagnostic.source, "workiq-error-json");
    assert.equal(call.resultEvidence.contentStatus, "explicit-null");
    assert.equal(call.resultEvidence.statusCode, null);
    assert.deepEqual(call.apiResults, []);
    assert.equal(call.toolSucceeded, false);
    assert.equal(call.observedGraphHttp, false);
    const direct = extract(source)[0].toolCalls[0];
    assert.deepEqual(direct.failureEvidence, call.failureEvidence);
    assert.deepEqual(direct.resultEvidence, call.resultEvidence);
    assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_|recoveryAction/);
});

test("ask errors use the same diagnostic projection in structured and text results without changing tool outcomes", () => {
    const value = { response: null, error: "The invented source policy is unavailable.", errorCode: "SourcePolicyUnavailable" };
    for (const result of [{ structuredContent: value }, { content: [{ type: "text", text: JSON.stringify(value) }] }]) {
        for (const success of [false, true]) {
            const source = events();
            source[2].data = { toolCallId: "invented-call", success, result: { ...result, isError: true } };
            const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
            const call = extract(retained)[0].toolCalls[0], direct = extract(source)[0].toolCalls[0];
            const diagnostic = success ? call.resultEvidence.diagnostic : call.failureEvidence.diagnostic;
            assert.equal(diagnostic.message, value.error);
            assert.equal(diagnostic.code, value.errorCode);
            assert.equal(diagnostic.source, "result-error");
            assert.equal(call.toolSucceeded, success);
            assert.equal(call.resultEvidence.applicationError, true);
            assert.equal(call.resultEvidence.contentStatus, "explicit-null");
            assert.equal(call.resultEvidence.statusCode, null);
            assert.deepEqual(call.apiResults, []);
            assert.deepEqual(direct.failureEvidence, call.failureEvidence);
            assert.deepEqual(direct.resultEvidence, call.resultEvidence);
            if (success) assert.equal(call.failureEvidence, undefined);
        }
    }
});

test("blob error envelopes retain their nested diagnostic and status without base64 payloads", () => {
    const source = events("MCP server 'workiq': " + JSON.stringify({
        statusCode: 403, sizeBytes: 0, base64Content: "", error: { error: { code: "accessDenied", message: "Access denied" } },
        requestId: "PRIVATE_REQUEST",
    }));
    source[1].data.toolName = "workiq-fetch_blob";
    source[1].data.arguments = { path: "/me/drive/items/invented/content" };
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const call = extract(retained)[0].toolCalls[0];
    assert.equal(call.failureEvidence.diagnostic.message, "Access denied");
    assert.equal(call.failureEvidence.diagnostic.code, "accessDenied");
    assert.equal(call.failureEvidence.diagnostic.statusCode, 403);
    assert.equal(call.resultEvidence.statusCode, 403);
    assert.deepEqual(call.apiResults, []);
    assert.doesNotMatch(JSON.stringify(retained), /base64Content|sizeBytes|PRIVATE_/);
});

test("singleton structured and text Graph errors keep nested reasons and independent root statuses", () => {
    const value = { statusCode: 412, data: null, error: { error: { code: "PreconditionFailed", message: "The supplied version is stale." } } };
    for (const result of [{ structuredContent: value }, { content: [{ type: "text", text: JSON.stringify(value) }] }]) {
        const source = events();
        source[2].data = { toolCallId: "invented-call", success: false, result };
        const call = extract(source.map(event => retainEvent(event, { credentialExclusions: 0 })))[0].toolCalls[0];
        assert.equal(call.failureEvidence.diagnostic.message, "The supplied version is stale.");
        assert.equal(call.failureEvidence.diagnostic.code, "PreconditionFailed");
        assert.equal(call.resultEvidence.statusCode, 412);
        const reading = createRecordedResults({ screen: true }).callReasonItems(call, "failure").map(item => item.text).join("\n");
        assert.match(reading, /supplied version is stale/);
        assert.match(reading, /412/);
        assert.deepEqual(call.apiResults, []);
    }
});

test("a failed invocation does not hide a separate singleton result diagnostic", () => {
    const source = events("The invocation ended with a transport error.");
    source[2].data.result = { structuredContent: { statusCode: 409,
        error: { code: "Conflict", message: "The result reports a version conflict." } } };
    const call = extract(source.map(event => retainEvent(event, { credentialExclusions: 0 })))[0].toolCalls[0];
    assert.equal(call.failureEvidence.diagnostic.message, "The invocation ended with a transport error.");
    assert.equal(call.resultEvidence.diagnostic?.message, "The result reports a version conflict.");
    const reading = createRecordedResults({ screen: true }).callReasonItems(call, "failure").map(item => item.text).join("\n");
    assert.match(reading, /invocation ended/);
    assert.match(reading, /result reports a version conflict/);
    assert.match(reading, /409/);
});

test("empty retrieval error envelopes distinguish an explicit stop from an absent cause", () => {
    const source = events("MCP server 'workiq': " + JSON.stringify({
        "application/vnd.ms-workiq.retrieval": { markdown: "", retrievalHits: [], resultCount: 0, stoppedReason: "error" },
        requestId: "PRIVATE_REQUEST",
    }));
    source[1].data.toolName = "workiq-retrieve";
    const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
    const call = extract(retained)[0].toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call),
        "Retrieval stopped with an error. The source did not supply a reason.");
    assert.equal(call.failureEvidence.diagnostic.status, "not-supplied");
    assert.equal(call.resultEvidence.contentStatus, "recorded-empty");
    assert.equal(call.resultEvidence.resultCount, null, "A retrieval-hit count is not an API-entry count.");
    assert.deepEqual(call.apiResults, []);
    assert.doesNotMatch(JSON.stringify(retained), /retrievalHits|PRIVATE_|markdown/);
});

test("ask envelope qualification never mines response bodies or relaxes diagnostic privacy and bounds", () => {
    const value = { response: null, error: "Invented policy unavailable.", errorCode: "SourcePolicyUnavailable" };
    const retainedCall = value => {
        const source = events("MCP server 'workiq': " + JSON.stringify(value));
        const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
        return { retained, call: extract(retained)[0].toolCalls[0] };
    };
    for (const invalid of [
        { ...value, response: "PRIVATE_BODY" }, { ...value, unexpected: true },
        { ...value, conversationId: {} }, { ...value, recoveryAction: [] },
        { ...value, requestId: 123 }, { ...value, errorCode: {} },
    ]) {
        const { retained, call } = retainedCall(invalid);
        assert.equal(call.failureEvidence.diagnostic.status, "unsupported-format");
        assert.equal(call.failureEvidence.diagnostic.message, undefined);
        assert.deepEqual(call.apiResults, []);
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_BODY/);
    }
    for (const [error, status] of [
        ["x".repeat(8192), "recorded"],
        ["x".repeat(8193), "size-excluded"],
        ["\u65e5".repeat(2731), "size-excluded"],
        ["Bearer " + "a".repeat(40), "sensitive-excluded"],
        ["Confidential invented error", "sensitive-excluded"],
        ['Returned payload: {"body":"PRIVATE_BODY"}', "unsupported-format"],
    ]) {
        const { retained, call } = retainedCall({ ...value, error });
        assert.equal(call.failureEvidence.diagnostic.status, status);
        if (status !== "recorded") assert.equal(call.failureEvidence.diagnostic.message, undefined);
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_BODY|Bearer|Confidential/);
    }
    const redacted = retainedCall({ ...value, error: "Contact person@example.invalid about the invented policy." }).call;
    assert.equal(redacted.failureEvidence.diagnostic.message, "Contact [redacted] about the invented policy.");
    assert.equal(redacted.failureEvidence.diagnostic.status, "redacted");
    const unsafeCode = retainedCall({ ...value, errorCode: "call_PRIVATEIDENTIFIER1234" });
    assert.equal(unsafeCode.call.failureEvidence.diagnostic.code, undefined);
    assert.doesNotMatch(JSON.stringify(unsafeCode.retained), /PRIVATEIDENTIFIER/);
    const legacy = events();
    delete legacy[2].data.error;
    legacy[2].data.wireFailureEvidence = {
        version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: null,
        diagnostic: { version: 1, source: "completion-error", status: "unsupported-format", code: "failure" },
    };
    const before = JSON.stringify(legacy), call = extract(legacy)[0].toolCalls[0];
    assert.equal(createRecordedResults().failureReason(call), "WIRE could not extract a readable reason from the recorded error");
    assert.equal(JSON.stringify(legacy), before, "Reading old saved evidence does not recover discarded source text.");
});

test("error envelopes require bounded, qualified Work IQ JSON and never mine prose or successful payloads", () => {
    const supported = envelope([failedResult()]);
    for (const message of [
        undefined, { text: supported }, "HTTP/1.1 500 InternalServerError",
        `Example: ${supported}`, supported + " trailing prose",
        supported.replace("'workiq'", "'another-service'"),
        `MCP server 'workiq': ${JSON.stringify({ results: "HTTP/1.1 500" })}`,
        envelope([{ ...failedResult(), data: "Bearer " + "a".repeat(40) }]),
        `MCP server 'workiq': ${JSON.stringify({ example: true, results: [failedResult()] })}`,
    ]) {
        const retained = events(message).map(event => retainEvent(event, { credentialExclusions: 0 }));
        const call = extract(retained)[0].toolCalls[0];
        assert.deepEqual(call.apiResults, []);
        assert.equal(call.failureEvidence.messageSignal, null);
        assert.equal(call.failureEvidence.code, "failure");
        assert.doesNotMatch(JSON.stringify(retained), /PRIVATE_|Bearer/);
    }
    const successful = events(supported);
    successful[2].data.success = true;
    const success = extract(successful.map(event => retainEvent(event, { credentialExclusions: 0 })))[0].toolCalls[0];
    assert.deepEqual(success.apiResults, []);
    assert.equal(success.toolSucceeded, true);
    assert.equal(success.failureEvidence, undefined);
    const existing = events(supported);
    existing[2].data.result = { structuredContent: { results: [{ statusCode: 403, error: { code: "AccessDenied" } }] } };
    assert.deepEqual(extract(existing)[0].toolCalls[0].apiResults.map(result => result.statusCode), [403],
        "A separate result is authoritative; never duplicate or merge arrays by guessed position.");
    const mixed = events(envelope([failedResult(), { statusCode: 403, error: { error: { code: "AccessDenied", message: "PRIVATE_DIFFERENT_ERROR" } } }]));
    const mixedCall = extract(mixed)[0].toolCalls[0];
    assert.equal(mixedCall.failureEvidence.code, "failure", "Different errors must not collapse into one cause.");
    assert.equal(mixedCall.failureEvidence.messageSignal, null);
    assert.deepEqual(mixedCall.apiResults.map(result => result.errorCode), ["InternalServerError", "AccessDenied"]);
    const unrelated = events(envelope([{ statusCode: 200, data: { body: "Access denied" } }]));
    assert.equal(extract(unrelated)[0].toolCalls[0].failureEvidence.messageSignal, null);
    for (const extra of [{ messageSource: undefined }, { messageStatus: "unqualified" }, { messageStatus: "sensitive-excluded" }, { code: "failure" }]) {
        const call = extract(events(supported))[0].toolCalls[0];
        Object.assign(call.failureEvidence, extra);
        assert.doesNotMatch(createRecordedResults().failureReason(call), /could not process/);
    }
    const compacted = events();
    delete compacted[2].data.error;
    assert.equal(extract(compacted)[0].toolCalls[0].failureEvidence, undefined,
        "Old compacted completions cannot gain a cause or claim that the source omitted one.");
});

test("error-envelope byte, array and error-code limits remain exact", () => {
    const supported = envelope([failedResult()]);
    for (const [size, expected] of [[8192, "response-processing-error"], [8193, null]]) {
        const message = supported + " ".repeat(size - Buffer.byteLength(supported));
        const call = extract(events(message))[0].toolCalls[0];
        assert.equal(call.failureEvidence.messageSignal, expected);
        assert.equal(call.failureEvidence.messageStatus, size === 8192 ? "text-excluded" : "size-excluded");
    }
    const hundred = envelope(Array.from({ length: 101 }, () => ({ statusCode: 500 })));
    const bounded = extract(events(hundred))[0].toolCalls[0];
    assert.equal(bounded.apiResults.length, 100);
    assert.equal(bounded.resultEvidence.resultCount, 101);
    for (const code of ["ghp_" + "a".repeat(36), "call_PRIVATEIDENTIFIER1234", "https://example.invalid/private", "Error with prose"]) {
        const result = failedResult(); result.error.error.code = code;
        const retained = events(envelope([result])).map(event => retainEvent(event, { credentialExclusions: 0 }));
        const call = extract(retained)[0].toolCalls[0];
        assert.equal(call.failureEvidence.code, "failure");
        assert.equal(call.failureEvidence.messageSignal, null);
        assert.ok(call.apiResults.every(result => result.errorCode === null));
        assert.ok(!JSON.stringify(retained).includes(code));
    }
});

test("real collection checkpoints keep per-call returned errors for canonical results, local Search and new reports while replies stay off", async t => {
    const { root, context } = await privateFixture(t, []);
    const sourceId = "11111111-1111-4111-8111-111111111111", sourceRoot = path.join(root, "session-state");
    const dbPath = path.join(root, "data.db"), db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented source", "chat", null, "local");
    db.close();
    await mkdir(path.join(sourceRoot, sourceId), { recursive: true });
    const source = [
        { id: "session", type: "session.start", data: { sessionId: sourceId, version: 1 } },
        ...events(envelope([failedResult(), { statusCode: 200, data: { body: "PRIVATE_CHAT_BODY" } }])),
        { id: "second-start", type: "tool.execution_start", data: { toolCallId: "second-call", toolName: "workiq-fetch", arguments: { entityUrls: ["/chats/invented-c/messages"] } } },
        { id: "second-complete", type: "tool.execution_complete", data: { toolCallId: "second-call", success: false, error: { code: "failure", message: envelope([failedResult()]) } } },
        { id: "reply", type: "assistant.message", data: { content: "PRIVATE_ORIGINAL_REPLY" } },
    ].map((event, index) => ({ ...event, timestamp: new Date(Date.now() - 10000 + index * 1000).toISOString() }));
    const file = path.join(sourceRoot, sourceId, "events.jsonl"), original = source.map(event => JSON.stringify(event) + "\n").join("");
    await writeFile(file, original);
    const collector = await createCollector(context, { timers: false });
    await collector.configure({ appDbPath: dbPath, sessionRoot: sourceRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    const state = await loadBoardState(context), records = mergeEvidenceWithState(state);
    assert.equal(records.length, 1);
    assert.equal(state.personalEvaluation?.consent?.state ?? "off", "off");
    assert.equal(state.personalEvaluation?.captures?.length ?? 0, 0);
    assert.equal(await readFile(file, "utf8"), original);
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(context.dataDir, "collector", index.fingerprint, `${sourceId}.json`), "utf8");
    assert.doesNotMatch(checkpoint + JSON.stringify(state), /PRIVATE_/);
    assert.match(checkpoint, /Error while processing response/);
    assert.match(checkpoint, /InternalServerError/);
    const calls = records[0].toolCalls;
    assert.deepEqual(calls.map(call => [call.toolCallId, call.startEventId, call.completionEventId]),
        [["invented-call", "start", "complete"], ["second-call", "second-start", "second-complete"]]);
    const activity = buildRequestActivity(records);
    assert.deepEqual(activity.tool.map(row => row.outcome), ["failure", "failure"]);
    assert.deepEqual(activity["reported-api"].map(row => [row.status, row.outcome]), [[500, "failure"], [200, "success"], [500, "failure"]]);
    assert.deepEqual(activity["reported-api"].map(row => row.parentCallId), [activity.tool[0].id, activity.tool[0].id, activity.tool[1].id]);
    const frame = await createCorpusSources(context, { source: () => collector.assessmentSource(state) }).scan();
    const matches = await rankTextSearch(frame.entries.filter(entry => entry.coverage.layer === "tool").map(indexSearchText), "InternalServerError", ["action"], new AbortController().signal);
    assert.equal(matches.length, 2, "Both exact tool calls remain searchable by their recorded error code.");
    const report = buildSanitizedRecord(records[0], state.pseudonymKey);
    assert.deepEqual(report.toolCalls.map(call => call.apiResults.map(result => [result.statusCode, result.errorCode])),
        [[[500, "InternalServerError"], [200, null]], [[500, "InternalServerError"]]]);
    assert.ok(report.toolCalls.every(call => call.toolSucceeded === false && call.observedGraphHttp === false));
    assert.doesNotMatch(JSON.stringify([frame, report]), /PRIVATE_/);
    assert.doesNotMatch(JSON.stringify(report), /Error while processing response/);
    await collector.close();
});
test("Work IQ error-envelope results survive retention, storage and reader explanation without payloads", async t => {
    for (const results of [[failedResult(), { statusCode: 200, data: { body: "PRIVATE_CHAT_BODY" } }], [failedResult()]]) {
        const source = events(envelope(results));
        const retained = source.map(event => retainEvent(event, { credentialExclusions: 0 }));
        const records = extract(retained);
        const call = records[0].toolCalls[0];
        assert.deepEqual(call.apiResults.map(result => [result.index, result.statusCode, result.errorCode]),
            results.map((result, index) => [index, result.statusCode, index === 0 ? "InternalServerError" : null]));
        assert.equal(call.failureEvidence.code, "InternalServerError");
        assert.equal(call.failureEvidence.messageSignal, "response-processing-error");
        assert.equal(call.failureEvidence.messageSource, "workiq-error-json");
        assert.equal(call.toolCallId, "invented-call");
        assert.equal(call.completionEventId, "complete");
        assert.equal(call.durationMs, 1219);
        assert.equal(call.toolSucceeded, false);
        assert.equal(call.observedGraphHttp, false);
        assert.ok(call.apiResults.every(result => result.evidenceLevel === "intermediary-reported"));
        assert.deepEqual(extract(source)[0].toolCalls[0].failureEvidence, call.failureEvidence);
        assert.deepEqual(extract(source)[0].toolCalls[0].apiResults, call.apiResults);
        assert.doesNotMatch(JSON.stringify([retained, records]), /PRIVATE_/);
        const { context } = await privateFixture(t, []);
        await replaceEvidence(context, () => ({ records }));
        const projected = mergeEvidenceWithState(await loadBoardState(context))[0].toolCalls[0];
        assert.deepEqual(projected.failureEvidence, call.failureEvidence);
        assert.deepEqual(projected.apiResults, call.apiResults);
        assert.equal(createRecordedResults().failureReason(projected),
            "Returned entry 1: Error while processing response. (InternalServerError; status 500)");
    }
});
