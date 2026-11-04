import test from "node:test";
import assert from "node:assert/strict";
import { recoverSameReadCompletions } from "../lib/completion-recovery.mjs";
import { callIdentity, eventIdentity } from "../lib/deletion-identities.mjs";

function fixture() {
    const start = { id: "start", type: "tool.execution_start", timestamp: "2026-10-23T12:00:00Z",
        data: { toolCallId: "call", toolName: "workiq-fetch", mcpServerName: "workiq",
            arguments: { entityUrls: ["/me/messages"] } } };
    const end = { id: "end", type: "tool.execution_complete", timestamp: "2026-10-23T12:00:01Z",
        data: { toolCallId: "call", success: true, model: "completion-model" } };
    const call = { tool: "workiq-fetch", toolCallId: "call", startEventId: "start", startedAt: start.timestamp,
        completionEventId: null, completedAt: null, durationMs: null, reportedOutcome: "unknown",
        toolSucceeded: null, apiResults: [], model: null, modelSource: "unavailable",
        parentToolCallId: null, turnId: null, requestArgs: start.data.arguments };
    const record = { scenarioId: "record", sourceSessionId: "source", workloadKind: "recorded-history", sample: false,
        userPrompt: { text: "Retained request", sourceEventId: "prompt" },
        promptAssociationEvidence: { method: "recorded-order" }, toolCalls: [call],
        graphActivities: [{ activityId: "untouched-graph", httpStatus: 403 }], coverageNote: "Retained oversized gap" };
    const input = { sourceSessionId: "source", sourceIdentity: "1:2:3:startup",
        since: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z",
        readStart: 100, readEnd: 1000, original: [{ offset: 100, endOffset: 200, event: start }],
        projected: [{ offset: 400, endOffset: 900, event: end }], records: [record], deletion: {} };
    return { input, start, end, call, record };
}
function unchanged(input, reason) {
    const before = structuredClone(input);
    const result = recoverSameReadCompletions(input);
    assert.deepEqual(input, before);
    assert.strictEqual(result.records, input.records);
    assert.ok(result.dispositions.every(disposition => disposition.status === "unavailable"));
    if (reason) assert.equal(result.dispositions[0].reason, reason);
    return result;
}

test("recovers only the minimal completion facts without mutating the source, prompt, graph or API fields", () => {
    const { input, record, call } = fixture(), before = structuredClone(input);
    const result = recoverSameReadCompletions(input), recovered = result.records[0].toolCalls[0];
    assert.deepEqual(input, before);
    assert.deepEqual(result.dispositions, [{ offset: 400, status: "recovered" }]);
    assert.deepEqual(recovered, { ...call, completionEventId: "end", completedAt: "2026-10-23T12:00:01Z",
        durationMs: 1000, reportedOutcome: "succeeded", toolSucceeded: true,
        model: "completion-model", modelSource: "completion-event" });
    assert.strictEqual(recovered.apiResults, call.apiResults);
    assert.strictEqual(result.records[0].userPrompt, record.userPrompt);
    assert.strictEqual(result.records[0].graphActivities, record.graphActivities);
    assert.equal(result.records[0].coverageNote, record.coverageNote);
});

test("restart/replay of the same projection leaves a completed call exactly unchanged", () => {
    const { input } = fixture();
    input.records = structuredClone(recoverSameReadCompletions(input).records);
    unchanged(input, "target-not-incomplete");
    input.projected[0].event.id = "different-completion";
    unchanged(input, "target-not-incomplete");
});

test("all richer, completed, contradictory or legacy-incomplete target variants are unchanged", () => {
    for (const patch of [
        { completionEventId: "end" }, { completionEventId: "different-end" }, { completedAt: "2026-10-23T12:00:01Z" },
        { durationMs: 0 }, { reportedOutcome: "succeeded" }, { reportedOutcome: "failed" }, { toolSucceeded: false },
        { apiResults: [{ statusCode: 403 }] }, { apiResults: null }, { failureEvidence: {} },
        { failureEvidence: { reason: "no-structured-error" } },
    ]) {
        const { input, call } = fixture();
        Object.assign(call, patch);
        unchanged(input, "target-not-incomplete");
    }
    for (const field of ["completionEventId", "completedAt", "durationMs", "reportedOutcome", "toolSucceeded", "apiResults"]) {
        const { input, call } = fixture();
        delete call[field];
        unchanged(input, "target-not-incomplete");
    }
    for (const patch of [{ isLegacy: true }, { sample: true }, { workloadKind: "imported" }]) {
        const { input, record } = fixture();
        Object.assign(record, patch);
        unchanged(input, "target-not-incomplete");
    }
});

test("requires the unique original start in this read, not a saved target or reconstructed event", () => {
    for (const setup of [
        f => { f.input.original = []; },
        f => { f.start.id = "other-start"; },
        f => { f.start.timestamp = "2026-10-23T11:59:59Z"; },
        f => { f.start.data.toolName = "other-fetch"; f.start.data.mcpServerName = "other"; },
        f => { f.record.sourceSessionId = "another-source"; },
        f => { f.input.original.push({ offset: 210, endOffset: 220, event: { ...f.start, id: "other-start" } }); },
        f => { f.input.records.push(structuredClone(f.record)); },
        f => { f.input.original.push({ offset: 210, endOffset: 220, event: { ...f.start, type: "assistant.message" } }); },
    ]) {
        const f = fixture(); setup(f); unchanged(f.input);
    }
});

test("requires exact observed scope presence/value and matching retained call parent/turn", () => {
    for (const path of [["agentId"], ["data", "parentToolCallId"], ["data", "turnId"]]) {
        const key = path.at(-1);
        const scope = event => path.length === 1 ? event : event.data;
        for (const value of ["scope", null, "", "invalid/scope"]) {
            const f = fixture(); scope(f.end)[key] = value;
            unchanged(f.input, "scope-mismatch");
        }
        const f = fixture();
        scope(f.start)[key] = scope(f.end)[key] = "scope";
        if (path.length === 2) f.call[key] = "scope";
        assert.equal(recoverSameReadCompletions(f.input).dispositions[0].status, "recovered");
        delete scope(f.end)[key];
        unchanged(f.input, "scope-mismatch");
    }
    for (const key of ["parentToolCallId", "turnId"]) {
        const f = fixture(); delete f.call[key];
        unchanged(f.input, "scope-mismatch");
    }
});

test("resolves a strictly ordered original parent chain to the exact start, not equal parent labels", () => {
    const chainFixture = () => {
        const f = fixture();
        f.start.parentId = "earlier-than-read";
        const middle = { id: "middle", type: "assistant.message", timestamp: "2026-10-23T12:00:00.500Z",
            parentId: "start", data: { content: "Not copied" } };
        f.input.original.push({ offset: 250, endOffset: 300, event: middle });
        f.end.parentId = "middle";
        return { ...f, middle };
    };
    const f = chainFixture();
    assert.equal(recoverSameReadCompletions(f.input).dispositions[0].status, "recovered");
    for (const change of [
        f => { f.end.parentId = "not-in-read"; },
        f => { f.middle.parentId = "middle"; },
        f => { f.middle.parentId = "end"; },
        f => { f.middle.timestamp = "2026-10-23T12:00:02Z"; },
        f => { f.middle.agentId = "different-agent"; },
        f => { delete f.middle.parentId; },
    ]) {
        const f = chainFixture();
        change(f);
        unchanged(f.input, "unresolved-parent-chain");
    }
});

test("qualifies every causal intermediary root without stripping legitimate assistant data", () => {
    const withMiddle = () => {
        const f = fixture();
        const middle = { id: "middle", type: "assistant.message", timestamp: "2026-10-23T12:00:00.500Z",
            parentId: "start", data: { content: "Ordinary assistant text", reasoningText: "Not retained",
                toolRequests: [{ toolCallId: "call" }], phase: "final_answer" } };
        f.input.original.push({ offset: 250, endOffset: 300, event: middle });
        f.end.parentId = "middle";
        return { ...f, middle };
    };
    const supported = withMiddle(), before = structuredClone(supported.input);
    assert.equal(recoverSameReadCompletions(supported.input).dispositions[0].status, "recovered");
    assert.deepEqual(supported.input, before);
    for (const change of [
        middle => { middle.tenantId = "unrecognized-scope"; },
        middle => { middle.sessionId = "another-source"; },
        middle => { middle.wireTrusted = true; },
        middle => { delete middle.type; },
        middle => { middle.type = null; },
        middle => { middle.type = 5; },
        middle => { middle.type = ""; },
        middle => { middle.type = "unsupported.future-event"; },
        middle => { middle.data = []; },
    ]) {
        const f = withMiddle(); change(f.middle);
        unchanged(f.input, "unresolved-parent-chain");
    }
});

test("rejects negative, reversed, invalid and outside-window completion chronology", () => {
    for (const timestamp of ["2026-10-23T11:59:59Z", "2026-02-30T00:00:00Z", "2026-11-01T00:00:01Z"]) {
        const f = fixture(); f.end.timestamp = timestamp;
        unchanged(f.input, "invalid-chronology");
    }
    const f = fixture(); f.input.since = "2026-10-23T12:00:00.001Z";
    unchanged(f.input, "invalid-chronology");
    f.input.since = "2026-10-01T00:00:00Z";
    [f.input.original[0].offset, f.input.projected[0].offset] = [500, 100];
    [f.input.original[0].endOffset, f.input.projected[0].endOffset] = [600, 200];
    unchanged(f.input, "invalid-chronology");
});

test("full and conflicting same-read completions always veto metadata recovery", () => {
    for (const id of ["end", "full-end"]) {
        const f = fixture();
        f.input.original.push({ offset: 920, endOffset: 950, event: {
            ...f.end, id, data: { ...f.end.data, result: { structuredContent: { results: [{ statusCode: 403 }] } } },
        } });
        unchanged(f.input, "ambiguous-or-missing-match");
    }
    const f = fixture();
    f.input.projected.push({ offset: 920, endOffset: 950, event: { ...f.end, id: "other-projection" } });
    unchanged(f.input, "ambiguous-or-missing-match");
});

test("deletion of any call, start, completion or parent-chain dependency vetoes recovery", () => {
    for (const deletion of [
        { events: [eventIdentity("source", "start")] },
        { events: [eventIdentity("source", "end")] },
        { contextCalls: [callIdentity("source", "call")] },
        { identities: [callIdentity("source", "call")] },
    ]) {
        const f = fixture(); f.input.deletion = deletion;
        unchanged(f.input, "deleted-or-suppressed");
    }
    const f = fixture();
    f.input.original.push({ offset: 250, endOffset: 300, event: { id: "middle", type: "user.message",
        timestamp: "2026-10-23T12:00:00.500Z", parentId: "start", data: { content: "Private removed prompt" } } });
    f.end.parentId = "middle";
    f.input.deletion = { events: [eventIdentity("source", "middle")] };
    unchanged(f.input, "deleted-or-suppressed");
});

test("selected credentials and raw-start arguments are excluded without echoing them in dispositions", () => {
    const secret = "ghp_" + "a".repeat(30);
    for (const setup of [
        f => { f.end.data.model = secret; },
        f => { f.start.data.arguments = { token: secret }; },
        f => { f.start.agentId = f.end.agentId = secret; },
    ]) {
        const f = fixture(); setup(f);
        const result = unchanged(f.input, "credential-excluded");
        assert.equal(JSON.stringify(result.dispositions).includes(secret), false);
    }
});

test("does not accept source trust markers, payloads or unknown scope in the projected envelope", () => {
    for (const patch of [{ result: {} }, { error: {} }, { wireRecovered: true }, { sessionId: "other" }]) {
        const f = fixture(); Object.assign(f.end.data, patch);
        unchanged(f.input, "unsupported-completion");
    }
    const f = fixture(); f.start.data.tenantId = "unrecognized";
    unchanged(f.input, "target-not-incomplete");
});

test("preserves existing model precedence and optional field absence", () => {
    const f = fixture(); f.call.model = "start-model"; f.call.modelSource = "start-event";
    const result = recoverSameReadCompletions(f.input);
    assert.equal(result.records[0].toolCalls[0].model, "start-model");
    assert.equal(result.records[0].toolCalls[0].modelSource, "start-event");
    assert.equal(Object.hasOwn(result.records[0].toolCalls[0], "failureEvidence"), false);
    for (const field of ["model", "modelSource"]) {
        const f = fixture(); delete f.call[field];
        const updated = recoverSameReadCompletions(f.input).records[0].toolCalls[0];
        assert.equal(Object.hasOwn(updated, field), false);
    }
});

test("rejects invalid caller read windows and overlapping/out-of-read entry positions", () => {
    for (const patch of [{ sourceIdentity: "" }, { since: "invalid" }, { readStart: -1 }, { readEnd: 5 * 1024 ** 2 },
        { readEnd: 50 }, { original: null }]) {
        const f = fixture(); Object.assign(f.input, patch);
        assert.throws(() => recoverSameReadCompletions(f.input), TypeError);
    }
    for (const patch of [{ offset: 150 }, { offset: 99 }, { endOffset: 1001 }, { endOffset: 400 }]) {
        const f = fixture(); Object.assign(f.input.projected[0], patch);
        assert.throws(() => recoverSameReadCompletions(f.input), TypeError);
    }
});

test("keeps independent recovered calls and unrelated records isolated", () => {
    const f = fixture(), other = fixture();
    other.start.id = "start-two"; other.start.data.toolCallId = "call-two";
    other.end.id = "end-two"; other.end.data.toolCallId = "call-two";
    other.call.startEventId = "start-two"; other.call.toolCallId = "call-two";
    f.input.original.push({ offset: 250, endOffset: 300, event: other.start });
    f.input.projected.push({ offset: 920, endOffset: 950, event: other.end });
    f.record.toolCalls.push(other.call);
    const unrelated = { ...structuredClone(f.record), sourceSessionId: "other-source" };
    f.input.records.push(unrelated);
    const result = recoverSameReadCompletions(f.input);
    assert.deepEqual(result.records[0].toolCalls.map(call => call.completionEventId), ["end", "end-two"]);
    assert.strictEqual(result.records[1], unrelated);
    f.input.deletion = { contextCalls: [callIdentity("source", "call-two")] };
    const suppressed = recoverSameReadCompletions(f.input);
    assert.equal(suppressed.records[0].toolCalls[0].completionEventId, "end");
    assert.strictEqual(suppressed.records[0].toolCalls[1], other.call);
});
