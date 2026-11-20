import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readTail, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { retainEvent } from "../lib/collector.mjs";
import { callIdentity, eventIdentity, recordUnits } from "../lib/deletion-identities.mjs";
import { createExactEvidence } from "../lib/exact-record-evidence.mjs";

const sessionId = "22222222-2222-4222-8222-222222222222";
const since = "2026-11-01T00:00:00.000Z", until = "2026-11-01T23:59:59.999Z";
const line = (id, type, data, n, parentId) => ({ id, type, data, timestamp: new Date(Date.parse(since) + n).toISOString(),
    ...(parentId ? { parentId } : {}) });
const boot = line("boot", "session.start", { version: 1, sessionId }, 0);
function chain(name) {
    const turnId = `turn-${name}`, toolCallId = `call-${name}`, messageId = `user-msg-${name}`;
    const p = line(`user-${name}`, "user.message", { source: "user", messageId, content: "Check the invented activity." }, 1);
    const a = line(`assistant-${name}`, "assistant.message", { originatingMessageId: messageId, messageId: `answer-msg-${name}`,
        toolRequests: [{ toolCallId }], turnId, content: "An invented fallback reply not to keep." }, 2, p.id);
    const s = line(`start-${name}`, "tool.execution_start", { toolCallId, turnId, toolName: "cc-example-fetch",
        mcpServerName: "cc-example", mcpToolName: "fetch", arguments: { entityUrls: ["/me/messages"] } }, 3, a.id);
    const e = line(`end-${name}`, "tool.execution_complete", { success: true, turnId, toolCallId,
        result: { structuredContent: { results: [{ statusCode: 207, body: { value: "invented response body" } }] } } }, 4, s.id);
    return [p, a, s, e];
}
const [p, a, s, e] = chain("one");
const source = { sessionId, eligible: true, name: "Invented", managedWorkIqEventIds: [s.id, "start-two"] };
const change = (event, data) => ({ ...event, data: { ...event.data, ...data } });
const padding = "z".repeat(TAIL_LIMITS.maxLineBytes + 100);
const hook = line("hook", "hook.start", { hookInvocationId: "inv-other", hookType: "postToolUse",
    input: { sessionId, toolCallId: "call-other", toolName: "other-tool", toolArgs: {}, toolResult: { content: padding } } }, 0, boot.id);
const state = { checkpointEvents: [] };
const encode = events => Buffer.from(events.map(x => (typeof x === "string" ? x : JSON.stringify(x)) + "\n").join(""));

// Exercise the real readTail decoder, guards, projections, and cursor retry protocol. Only
// FileHandle I/O is substituted, so these tests cannot traverse a real store or write fixtures.
async function parts(bytes, budgets = [], mtimeMs = 4) {
    const file = "invented-memory-file", stat = { size: bytes.length, dev: 1, ino: 2, birthtimeMs: 3, mtimeMs, ctimeMs: 5 };
    const oldOpen = fs.open, oldStat = fs.stat;
    try {
        fs.open = async (target, flags) => {
            assert.equal(target, file); assert.equal(flags, "r");
            return { stat: async () => stat, close: async () => {}, read: async (target, offset, length, position) =>
                ({ bytesRead: bytes.copy(target, offset, position, position + length) }) };
        };
        fs.stat = async target => { assert.equal(target, file); return stat; };
        syncBuiltinESMExports();
        const reads = [];
        let cursor;
        do {
            const tail = await readTail(file, sessionId, cursor, budgets[reads.length] ?? TAIL_LIMITS.chunkBytes,
                { completionMetadata: true, chargeGuards: true });
            reads.push(tail);
            if (cursor && tail.cursor.offset === cursor.offset && reads.length > budgets.length) break;
            cursor = tail.cursor;
        } while (cursor.backlogBytes);
        return reads;
    } finally { fs.open = oldOpen; fs.stat = oldStat; syncBuiltinESMExports(); }
}
function decide(reads, options = {}) {
    const acc = createExactEvidence(options.source ?? source, { since, until }, { ...state, ...options.state });
    for (const tail of reads) acc.consume(tail);
    return acc.finish();
}
const scan = async (events, options) => decide(await parts(encode([boot, ...events])), options);
const unverified = { code: "EXACT_EVIDENCE_UNVERIFIED" };

test("qualified calls are canonical individual records; only disjoint projected regions count", async () => {
    const unlinked = change({ ...s, id: "unlinked", parentId: "missing-parent" }, { toolCallId: "call-unlinked" });
    for (const events of [[hook, p, a, s, e, unlinked], [p, a, s, e, unlinked, hook]]) {
        const out = await scan([...events, ...chain("two")]);
        assert.deepEqual(out.records.map(r => [r.userPrompt.authorship.actor, r.promptAssociationEvidence.method,
            r.toolCalls[0].tool, r.toolCalls[0].completionEventId, r.toolCalls[0].apiResults[0].statusCode]), [
            ["user", "explicit-message", "workiq-fetch", e.id, 207], ["user", "explicit-message", "workiq-fetch", "end-two", 207],
        ]);
        assert.equal(out.excluded, 1); assert.equal(out.omittedRegions, 1); assert.match(out.witness, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(out), /invented fallback reply|invented response body/);
    }
    const inside = await scan([p, a, s, hook, e]);
    assert.deepEqual([inside.records.length, inside.excluded, inside.omittedRegions], [0, 1, 1]);
});

test("a related, ambiguous or unidentified omission anywhere refuses the entire source", async () => {
    for (const extra of [
        change(hook, { input: { ...hook.data.input, toolCallId: s.data.toolCallId } }),
        change(hook, { input: { ...hook.data.input, toolName: s.data.mcpToolName } }),
        change(hook, { input: { ...hook.data.input, toolCallId: undefined } }),
        { ...hook, parentId: a.id }, { ...hook, id: e.id },
        change(hook, { input: { ...hook.data.input, toolCalls: [{ id: s.data.toolCallId }] } }),
        change(e, { result: { content: padding } }), line("opaque", "unknown.kind", { content: padding }, 2),
    ]) {
        for (const at of [0, 3, 4]) {
            const events = [p, a, s, e].toSpliced(at, 0, extra);
            await assert.rejects(scan(events), unverified);
        }
    }
});

test("only committed spans advance; split retained members and a retried projected line agree with one read", async () => {
    const bytes = encode([boot, p, a, s, e, hook]);
    const budgets = [65536 + 256 + encode([boot, p]).length + 11,
        65536 + 384 + encode([a, s]).length + 13, 65536 + 384 + encode([e]).length + 512];
    const reads = await parts(bytes, budgets);
    assert.ok(reads.length >= 4);
    for (const [i, tail] of reads.slice(0, -1).entries()) {
        assert.ok(tail.recovery.readEnd > tail.cursor.offset);
        assert.equal(reads[i + 1].recovery.readStart, tail.cursor.offset);
    }
    const out = decide(reads);
    assert.equal(out.records.length, 1);
    assert.deepEqual(out, decide(await parts(bytes)));
    assert.throws(() => decide(reads.slice(0, -1)), unverified);
    assert.throws(() => decide(reads.slice(1)), unverified);
    assert.throws(() => decide([reads[0], ...reads]), unverified);
    assert.throws(() => decide([reads[0], ...reads.slice(2)]), unverified);
    const changed = await parts(bytes, budgets, 7);
    assert.throws(() => decide([reads[0], ...changed.slice(1)]), unverified);
    assert.throws(() => decide([]), unverified);
    for (const bytes of [Buffer.concat([encode([boot, p, a, s, e]), Buffer.from("{")]),
        encode([boot, p, a, "", s, e]), encode([boot, p, a, s, e, "{broken"]), encode([boot, p, a, [1], s, e])]) {
        await assert.rejects(async () => decide(await parts(bytes)), unverified);
    }
});

test("duplicate or contradictory original identities are checked before retention and day filtering", async () => {
    for (const extra of [
        { ...p, id: "other-user" }, { ...a, id: "other-response" },
        change({ ...a, id: "other" }, { messageId: "new", originatingMessageId: "new-origin", toolRequests: [] }),
        change({ ...a, id: "also", parentId: "none" }, { turnId: "other", originatingMessageId: "other", toolRequests: [] }),
        change({ ...s, id: "another-start", timestamp: "2026-11-02T00:00:00.000Z" }, { toolName: "shell", mcpToolName: "other" }),
        change({ ...e, id: "other-end" }, { turnId: "other-turn" }),
        change({ ...a, id: "foreign-request", parentId: "no-parent" }, { messageId: "else", turnId: "foreign", originatingMessageId: "elsewhere" }),
        change({ ...p, id: e.id }, { messageId: "other" }),
    ]) {
        const result = await scan([p, a, s, e, extra]);
        assert.equal(result.records.length, 0, extra.id); assert.equal(result.excluded, 1);
    }
    for (const type of ["external_tool.requested", "subagent.started", "hook.end", "wire.history_gap"]) {
        await assert.rejects(scan([p, a, s, e, line("foreign", type, { toolCallId: s.data.toolCallId }, 8)]), unverified);
    }
    const deletedDuplicate = { ...s, id: "deleted-duplicate" };
    const out = await scan([p, a, s, e, deletedDuplicate], { state: { deletion: { events: [eventIdentity(sessionId, deletedDuplicate.id)] } } });
    assert.deepEqual([out.records.length, out.excluded], [0, 2]);
});

test("no inferred origin, order-only match, missing completion or unverified connector", async () => {
    for (const events of [
        [change(p, { source: undefined }), a, s, e], [change(p, { source: "agent-peer" }), a, s, e],
        [change(p, { isAutopilotContinuation: true }), a, s, e], [p, { ...a, agentId: "nested" }, s, e],
        [change(p, { transformedContent: "unclassified non-user wrapper" }), a, s, e],
        [p, change(a, { messageId: p.data.messageId }), s, e],
        [p, a, { ...s, parentId: undefined }, e], [p, change(a, { originatingMessageId: undefined }), s, e],
        [p, change(a, { turnId: "different" }), s, e], [p, a, s, change(e, { turnId: "different" })],
        [p, a, s, { ...e, parentId: a.id }], [p, a, s], [p, a, s, { ...e, timestamp: since }],
        [p, change(a, { toolRequests: [{ toolCallId: "other" }] }), s, e],
        [p, change(a, { toolRequests: [...a.data.toolRequests, ...a.data.toolRequests] }), s, e],
        [p, a, change(s, { mcpConfigServerName: "another" }), e],
    ]) {
        const out = await scan(events);
        assert.deepEqual([out.records.length, out.excluded], [0, 1]);
    }
    assert.equal((await scan([p, a, s, e], { source: { ...source, managedWorkIqEventIds: [] } })).excluded, 1);
    const direct = change(s, { toolName: "workiq-fetch", mcpServerName: "workiq" });
    for (const [success, outcome] of [[undefined, "unknown"], [false, "failed"], [true, "succeeded"]]) {
        const result = await scan([p, a, direct, change(e, { success, result: undefined })], { source: { ...source, managedWorkIqEventIds: [] } });
        const call = result.records[0].toolCalls[0];
        assert.deepEqual([call.completionEventId, call.reportedOutcome, call.toolSucceeded], [e.id, outcome, success ?? null]);
    }
});

test("privacy and deletion veto the entire candidate, not just its displayed text", async () => {
    for (const events of [
        [change(p, { content: "api_key=invented-value" }), a, s, e],
        [p, change(a, { content: "password=invented-value" }), s, e],
        [p, a, change(s, { arguments: { authorization: "invented-value" } }), e],
        [p, a, s, change(e, { error: { message: "client_secret=invented-value" } })],
        [p, a, s, change(e, { result: { content: '{"password":"invented-value"}' } })],
    ]) assert.equal((await scan(events)).excluded, 1);
    const reads = await parts(encode([boot, p, a, s, e]));
    const [unit] = recordUnits(decide(reads).records[0]);
    for (const deletion of [
        ...[p, a, s, e].map(x => ({ events: [eventIdentity(sessionId, x.id)] })),
        { contextCalls: [callIdentity(sessionId, s.data.toolCallId)] }, ...unit.aliases.map(alias => ({ identities: [alias] })),
    ]) assert.equal(decide(reads, { state: { deletion } }).excluded, 1);
});

test("the selected interval must contain every dependency; only starts in it count", async () => {
    const before = "2026-10-31T23:59:59.999Z", after = "2026-11-02T00:00:00.000Z";
    for (const events of [[{ ...p, timestamp: before }, a, s, e], [p, a, s, { ...e, timestamp: after }]]) {
        const out = await scan(events);
        assert.deepEqual([out.records.length, out.excluded, out.omittedRegions], [0, 1, 0]);
    }
    const outside = await scan([p, a, { ...s, timestamp: after }, { ...e, timestamp: after }]);
    assert.deepEqual([outside.records.length, outside.excluded], [0, 0]);
    const inclusive = await scan([{ ...p, timestamp: since }, a, s, { ...e, timestamp: until }]);
    assert.deepEqual([inclusive.records[0].userPrompt.sourceTimestamp, inclusive.records[0].toolCalls[0].completedAt], [since, until]);
});

test("proof limits invalidate earlier proposals rather than truncating the proof", async () => {
    const acc = createExactEvidence(source, { since, until }, state);
    const starts = Array.from({ length: 1024 }, (_, n) =>
        change({ ...s, id: `also-${n}`, parentId: undefined }, { toolCallId: `also-call-${n}` }));
    const reads = await parts(encode([boot, p, a, s, e, ...starts]));
    assert.throws(() => { for (const tail of reads) acc.consume(tail); }, { code: "EXACT_EVIDENCE_LIMIT" });
    assert.throws(() => acc.finish(), unverified);
});

test("checkpoint proof admits equal ordinary overlaps, never rewrites references or tolerates competing preimages", async () => {
    const reads = await parts(encode([boot, p, a, s, e]));
    const ordinary = [p, a, s, e].map(event => JSON.parse(JSON.stringify(retainEvent(event, { credentialExclusions: 0 },
        { managedWorkIqEventIds: new Set(source.managedWorkIqEventIds) }))));
    for (const ok of [[], ordinary.slice(0, 2), ordinary]) {
        assert.equal(decide(reads, { state: { checkpointEvents: ok } }).records.length, 1);
    }
    for (const conflict of [
        change(ordinary[0], { content: "changed" }), change(ordinary[1], { originatingMessageId: "elsewhere" }),
        { ...ordinary[2], id: "another-start" }, change(ordinary[3], { success: false }),
        line("else", "unexpected.type", { parentToolCallId: s.data.toolCallId }, 3),
        line("else", "assistant.message", { wireOriginalModel: { originatingMessageId: p.data.messageId } }, 3),
        line("else", "assistant.message", { wireToolRequestIds: [s.data.toolCallId] }, 3),
        line("else", "assistant.turn_start", { turnId: s.data.turnId }, 3),
        change(ordinary[3], { wireCompletionRef: 1 }), ordinary[0],
    ]) assert.equal(decide(reads, { state: { checkpointEvents: [ordinary[0], conflict] } }).excluded, 1);
    const changed = await parts(encode([boot, p, change(a, { content: "Different private reply." }), s, e]));
    assert.notEqual(decide(changed).witness, decide(reads).witness);
});
