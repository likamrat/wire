import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readTail, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { retainEvent } from "../lib/collector.mjs";
import { callIdentity, eventIdentity, recordUnits } from "../lib/deletion-identities.mjs";
import { createExactEvidence } from "../lib/exact-record-evidence.mjs";
import { withCausalHooks } from "./causal-hook-fixture.mjs";

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

test("an ambiguous or ineligible saved parent is not a missing prompt", async () => {
    const originals = [p, a, s, e];
    const { records } = await scan(originals);
    const [record] = records;
    const parent = { ...record, toolCalls: [{ ...record.toolCalls[0],
        toolCallId: "prior-call", startEventId: "prior-start", completionEventId: "prior-end" }] };
    const withParents = existingRecords => scan(originals, { state: { existingRecords } });
    for (const existingRecords of [[parent, parent], [{ ...parent, assessmentMembershipPruned: true }],
        [{ ...parent, userPrompt: { ...parent.userPrompt, capture: { ...parent.userPrompt.capture, conflict: true } } }]]) {
        const result = await withParents(existingRecords);
        assert.deepEqual([result.records.length, result.excluded], [0, 1]);
    }
    const other = { ...parent, sourceSessionId: "different-source", scenarioId: `history-different-source-${p.id}` };
    for (const existingRecords of [[parent], [other]]) {
        assert.deepEqual((await withParents(existingRecords)).records, records);
    }
});

test("a mapped call can use a bounded original projection of its unchanged retained agent parent across turns", async () => {
    const agent = change(p, { source: "agent-invented", turnId: "origin-turn", transformedContent: "x".repeat(18000) });
    const answer = change(a, { content: "y".repeat(18000) });
    const originals = withCausalHooks([agent, answer, s, e], sessionId);
    originals[5].data.input.serverName = s.data.mcpServerName;
    const { promptRecord } = await import("../lib/prompt-authorship.mjs");
    const parent = { sourceSessionId: sessionId, scenarioId: `history-${sessionId}-${agent.id}`,
        workloadKind: "recorded-history", userPrompt: promptRecord(retainEvent(agent, {})) };
    const anchored = { state: { existingRecords: [parent] } };
    const result = await scan(originals, anchored);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0].userPrompt, parent.userPrompt);
    assert.equal(result.records[0].promptAssociationEvidence.method, "explicit-message");
    assert.equal(result.records[0].toolCalls[0].completionEventId, e.id);
    for (const prior of [[], [parent, parent], [{ ...parent, sourceSessionId: "elsewhere" }],
        [{ ...parent, userPrompt: { ...parent.userPrompt, text: "Another prompt" } }],
        [{ ...parent, userPrompt: { ...parent.userPrompt, authorship: { actor: "user", basis: "source-user" } } }]]) {
        await assert.rejects(scan(originals, { state: { existingRecords: prior } }), unverified);
    }
    const bad = structuredClone(originals); bad[5].data.input.serverName = "cc-elsewhere";
    await assert.rejects(scan(bad, anchored), unverified);
    await assert.rejects(scan(originals, { ...anchored, source: { ...source, managedWorkIqEventIds: [] } }), unverified);
    await assert.rejects(scan(originals.with(0, { ...agent, checkpoint: true }), anchored), unverified);
    await assert.rejects(scan(originals, { state: { ...anchored.state, deletion: {
        events: [eventIdentity(sessionId, agent.id)] } } }), unverified);
    const unknown = line("unknown-ref", "skill.context_delivered_ref", { interactionId: a.data.messageId }, 0);
    await assert.rejects(scan([unknown, ...originals], anchored), unverified);
});

test("a classified timeline notice immediately before the prompt is not a competing prompt", async () => {
    const notice = line("prior-notice", "session.info", { infoType: "timing", message: "An invented notice." }, 1, boot.id);
    const prompt = { ...p, parentId: notice.id };
    const rows = [notice, prompt, a, s, e];
    assert.deepEqual((await scan(rows)).records, (await scan([p, a, s, e])).records);
    for (const changed of [rows.with(0, { ...notice, timestamp: e.timestamp }),
        rows.toSpliced(1, 0, line("intervening", "assistant.message", {}, 1)),
        [...rows, { ...a, id: "other-answer", data: { apiCallId: notice.id } }]]) {
        await assert.rejects(scan(changed), unverified);
    }
    await assert.rejects(scan(rows, { state: { checkpointEvents: [{ data: { alias: notice.id } }] } }), unverified);
    await assert.rejects(scan(rows, { state: { deletion: { events: [eventIdentity(sessionId, notice.id)] } } }), unverified);
    assert.deepEqual((await scan(rows.with(2, change(a, { originatingMessageId: "another-message" })))).records, []);
});

test("discarded assistant text does not disqualify an explicitly linked mapped call under a new human prompt", async () => {
    const long = change(a, { content: "Invented discarded reply. ".repeat(1400) });
    const rows = [p, long, s, e], result = await scan(rows);
    assert.deepEqual(result.records, (await scan([p, a, s, e])).records);
    assert.equal(result.records.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /Invented discarded reply/);

    for (const bad of [change(long, { originatingMessageId: "other-message" }),
        change(long, { content: long.data.content + " api_key=invented_secret_value" }),
        JSON.stringify(long).replace('"turnId":', '"turnId":"other","turnId":')]) {
        assert.deepEqual((await scan([p, bad, s, e])).records, []);
    }
    const literalStart = change(s, { toolName: "workiq-fetch", mcpServerName: "workiq" });
    assert.deepEqual((await scan([p, long, literalStart, e], { source: { ...source, managedWorkIqEventIds: [] } })).records, []);
    assert.deepEqual((await scan([p, long, s, e, { ...a, id: "another-request" }])).records, []);
});

test("explicit original-record flags do not turn an ordinary source event into a replay copy", async () => {
    const direct = [p, a, s, e], baseline = await scan(direct);
    const marked = direct.map(event => ({ ...event, ephemeral: false, checkpoint: false }));
    assert.deepEqual((await scan(marked)).records, baseline.records);
    for (const field of ["ephemeral", "checkpoint"]) {
        for (const value of [true, "false", 0, null]) {
            await assert.rejects(scan(marked.with(2, { ...marked[2], [field]: value })), unverified);
        }
        const duplicate = JSON.stringify(marked[2]).replace(`"${field}":false`, `"${field}":true,"${field}":false`);
        await assert.rejects(scan(marked.with(2, duplicate)), unverified);
    }
});

test("a direct-call proposal requires field agreement even on ordinary rows outside the call", async () => {
    const direct = [p, a, { ...s, checkpoint: false }, e];
    const other = JSON.stringify(line("other", "assistant.message", { apiCallId: "other-api" }, 86400001));
    const harmless = other.replace('"apiCallId":', '"apiCallId": ');
    const ambiguous = other.replace('"apiCallId":', `"apiCallId":"${a.data.turnId}","apiCallId":`);
    assert.equal((await scan([...direct, harmless])).records.length, 1);
    for (const events of [[ambiguous, ...direct], [...direct, ambiguous]]) await assert.rejects(scan(events), unverified);
});

test("no literal call alias in a bounded off-chain record does not prove disjointness", async () => {
    // The SDK's completion receipt covers an inclusive *range*. Its endpoints
    // need not be the IDs on the independently observed call inside that range.
    const first = line("range-first", "user.message", { messageId: "range-message", source: "user", content: "An earlier request." }, 0);
    const last = line("range-last", "assistant.turn_end", { turnId: "outside-turn" }, 5);
    const receipt = line("range-summary", "session.completion_receipt", {
        attempt: 1, eventRange: { startEventId: first.id, endEventId: last.id }, failedToolCount: 0,
        successfulToolCount: 1, schemaVersion: 1, sourceEventId: last.id, stopReason: "natural",
    }, 6, last.id);
    const events = [first, p, a, s, e, last, receipt];
    const idx = eventId => events.findIndex(ev => ev.id === eventId);
    assert.ok(idx(receipt.data.eventRange.startEventId) < idx(s.id) && idx(e.id) < idx(receipt.data.eventRange.endEventId));
    const scalarStrings = v => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(scalarStrings) : [];
    const encodedIds = new Set(scalarStrings(receipt));
    assert.ok([p.id, p.data.messageId, a.id, a.data.messageId, s.id, s.data.turnId, s.data.toolCallId, e.id].every(v => !encodedIds.has(v)));
    assert.equal(retainEvent(receipt, { credentialExclusions: 0 }), null);
    const bytes = encode([boot, ...events]), reads = await parts(bytes);
    assert.equal(reads.at(-1).cursor.offset, bytes.length);
    assert.equal(reads.at(-1).cursor.oversizedLines, 0);
    assert.throws(() => decide(reads), unverified);
    assert.equal((await scan(events.slice(0, -1))).records.length, 1);
});

test("ordinary number or whitespace spelling does not hide a field; duplicate or rounded values still refuse", async () => {
    const rows = originJournal(), ordinary = rows[2];
    const encoded = JSON.stringify(ordinary);
    const differentlyWritten = encoded.replace('"data":{', '"data": { ').replace('"totalNanoAiu":17', '"totalNanoAiu": 17.000e0 ');
    const baseline = await scan(rows);
    const accepted = await scan(rows.with(2, differentlyWritten));
    assert.deepEqual(accepted.records, baseline.records);
    assert.notEqual(accepted.witness, baseline.witness, "Confirmation must still bind the original bytes, not reserialized JSON");
    for (const invalid of [
        differentlyWritten.replace('"totalNanoAiu":', '"totalNanoAiu":42,"totalNanoAiu":'),
        differentlyWritten.replace('"totalNanoAiu":', '"totalNanoAiu":16,"totalNanoAi\\u0075":'),
        differentlyWritten.replace("17.000e0", "17.0000000000000001"),
    ]) await assert.rejects(scan(rows.with(2, invalid)), unverified);
});

function otherLifecycle(family) {
    if (family === "external") return [
        line("dispatch", "external_tool.requested", { requestId: "foreign-request", sessionId, toolCallId: "foreign-call", toolName: "invented-tool", arguments: {} }, 0, boot.id),
        line("dispatch-end", "external_tool.completed", { requestId: "foreign-request" }, 0, "dispatch"),
    ];
    const data = { canvasId: "foreign-canvas", extensionId: "invented-extension", instanceId: "foreign-instance" };
    return [line("surface-open", "session.canvas.recorded", { ...data, title: "Invented private title." }, 0, boot.id),
        line("surface-close", "session.canvas.removed", data, 0, "surface-open")];
}

test("a disjoint lifecycle pair needs unambiguous original fields throughout a direct-call journal", async () => {
    for (const kind of ["external", "canvas"]) {
        const [open, close] = otherLifecycle(kind);
        const claimedId = kind === "external" ? open.data.requestId : open.data.instanceId;
        const parsed = line("outside", "assistant.message", { apiCallId: "unrelated" }, 86400001);
        const ambiguous = JSON.stringify(parsed).replace('"apiCallId":', `"apiCallId":"${claimedId}","apiCallId":`);
        const direct = [open, close, p, a, s, e];
        assert.equal((await scan([...direct, parsed])).records.length, 1);
        for (const events of [[ambiguous, ...direct], [...direct, ambiguous]]) await assert.rejects(scan(events), unverified);
    }
});

test("paired unrelated external requests and canvas records cannot become tool outcomes or user origins", async () => {
    const baseline = (await scan([p, a, s, e])).records;
    for (const kind of ["external", "canvas"]) {
        const [start, end] = otherLifecycle(kind);
        const result = await scan([start, end, p, a, s, e]);
        assert.deepEqual(result.records, baseline); assert.equal(result.omittedRegions, 0);
        assert.doesNotMatch(JSON.stringify(result), /private title|invented-tool/);
        for (const events of [[end], [start, { ...end, parentId: boot.id }], [start, end, end],
            [start, change(end, { result: {} })], [{ ...start, id: p.data.messageId }, { ...end, parentId: p.data.messageId }],
            [change(start, kind === "external" ? { toolCallId: s.data.toolCallId } : { instanceId: a.data.messageId }), end]]) {
            await assert.rejects(scan([...events, p, a, s, e]), unverified);
        }
        await assert.rejects(scan([start, end, p, a, s, e], { state: { checkpointEvents: [{ data: { alias: end.id } }] } }), unverified);
        await assert.rejects(scan([start, end, p, a, s, e], { state: { deletion: { events: [eventIdentity(sessionId, start.id)] } } }), unverified);
        // No crossing into the assistant's logical attribution through a foreign UI or request.
        assert.deepEqual((await scan([p, start, end, a, s, e])).records, []);
    }
    const [external, end] = otherLifecycle("external");
    for (const bad of [change(external, { sessionId: "another-chat" }), change(external, { toolName: "workiq-fetch" }),
        change(external, { toolName: s.data.toolName }), change(external, { arguments: { namedCallId: s.data.toolCallId } }),
        change(external, { providerId: "unknown-provider" })]) {
        await assert.rejects(scan([bad, end, p, a, s, e]), unverified);
    }
});

function originJournal() {
    const info = line("info", "session.info", { infoType: "timing", message: "Invented private timeline notice." }, 1, p.id);
    const usage = line("usage", "session.usage_checkpoint", { totalNanoAiu: 17 }, 1, info.id);
    const turn = line("run", "assistant.turn_start", { turnId: a.data.turnId }, 2, usage.id);
    return [p, info, usage, turn, { ...a, parentId: turn.id }, s, e];
}

test("the originating message and the preceding journal event can be different originals", async () => {
    const rows = originJournal(), baseline = await scan([p, a, s, e]);
    const close = line("run-end", "assistant.turn_end", { turnId: a.data.turnId }, 4, e.id);
    for (const events of [rows, [...rows, close]]) {
        const checkpointEvents = events.map(ev => retainEvent(ev, { credentialExclusions: 0 }, {
            managedWorkIqEventIds: new Set(source.managedWorkIqEventIds),
        })).filter(Boolean);
        const out = await scan(events, { state: { checkpointEvents } });
        assert.deepEqual(out.records, baseline.records);
        assert.equal(out.records[0].promptAssociationEvidence.method, "explicit-message");
        assert.notEqual(out.witness, baseline.witness);
        assert.doesNotMatch(JSON.stringify(out), /private timeline notice|totalNanoAiu/);
    }
});

test("a journal chain alone cannot attribute a call or bridge unknown, private or conflicting originals", async () => {
    const rows = originJournal(), [, info, usage, turn, answer] = rows;
    for (const [at, bad] of [
        [1, { ...info, parentId: "other-prompt" }], [1, change(info, { originatingMessageId: "another" })],
        [1, change(info, { tip: "api_key=invented-value" })], [1, { ...info, agentId: "other-agent" }],
        [2, change(usage, { totalNanoAiu: -1 })], [2, change(usage, { usageAccountingWatermarks: { unknown: 1 } })],
        [2, { ...usage, type: "session.usage_record" }], [2, { ...usage, timestamp: since }],
        [3, change(turn, { parentToolCallId: s.data.toolCallId })], [3, change(turn, { turnId: "foreign-turn" })],
        [4, { ...answer, parentId: info.id }], [4, change(answer, { originatingMessageId: undefined })],
        [4, change(answer, { originatingMessageId: "another-user" })],
    ]) await assert.rejects(scan(rows.with(at, bad)), unverified);
    for (const extra of [{ ...p, id: "another-user" }, { ...a, id: "second-answer" }, { ...s, id: "unmapped", data: {
        ...s.data, toolCallId: "foreign", mcpServerName: "foreign", mcpToolName: "other", turnId: a.data.turnId,
    } }]) assert.deepEqual((await scan([...rows, extra])).records, []);
    for (const extra of [line("other", "assistant.message", { apiCallId: turn.id }, 5), { ...info, id: s.id, parentId: boot.id }]) {
        await assert.rejects(scan([...rows, extra]), unverified);
    }
    for (const member of [info, usage, turn]) {
        await assert.rejects(scan(rows, { state: { deletion: { events: [eventIdentity(sessionId, member.id)] } } }), unverified);
    }
    const reads = await parts(encode([boot, ...rows]));
    assert.throws(() => decide(reads, { state: { checkpointEvents: [{ data: { unexpected: usage.id } }] } }), unverified);
    assert.throws(() => decide(reads, { state: { checkpointEvents: [change(turn, { turnId: "changed" })] } }), unverified);
    const shadowed = JSON.stringify(info).replace('"parentId":', '"parentId":"other","parentId":');
    await assert.rejects(scan(rows.with(1, shadowed)), unverified);
});

test("fully screened timeline notices survive a read boundary without carrying text or inventing a prompt", async () => {
    const rows = originJournal();
    const warning = line("warning", "session.warning", { warningType: "mcp", message: "Invented private warning." }, 1, rows[1].id);
    const system = line("system", "system.message", { role: "developer", content: "Invented private control text." }, 1, warning.id);
    rows.splice(2, 1, warning, system, { ...rows[2], parentId: system.id });
    const pad = line("pad", "assistant.message", { content: "x".repeat(68000) }, 0);
    const all = [boot, pad, ...rows], bytes = encode(all), split = encode(all.slice(0, 6)).length;
    const reads = await parts(bytes, [65536 + 256 + split + 5]);
    assert.equal(reads[0].cursor.offset, split);
    const accepted = decide(reads);
    assert.deepEqual(accepted, decide(await parts(bytes)));
    assert.deepEqual(accepted.records[0].userPrompt.sourceEventId, p.id);
    assert.doesNotMatch(JSON.stringify(accepted), /private warning|private control text/i);
    for (const [at, patch] of [[2, { originatingMessageId: p.data.messageId }], [3, { role: "user" }],
        [3, { interactionId: a.id }], [3, { metadata: { origin: p.id } }]]) {
        await assert.rejects(scan(rows.with(at, change(rows[at], patch))), unverified);
    }
});

test("a verified SDK startup header is source context, never a recovered identity or authorization", async () => {
    const header = { ...boot, parentId: null, data: { ...boot.data, startTime: since, producer: "invented-client", copilotVersion: "1.2.3",
        selectedModel: "invented-model", reasoningEffort: "high", remoteSteerable: true, alreadyInUse: false, contextTier: "default",
        context: { cwd: "/invented/directory", branch: "example" }, githubMcpToolConfig: { enableAllTools: true, additionalToolsets: ["invented-set"] } } };
    const read = async h => decide(await parts(encode([h, p, a, s, e])));
    const baseline = await scan([p, a, s, e]), accepted = await read(header);
    assert.deepEqual(accepted.records, baseline.records); assert.notEqual(accepted.witness, baseline.witness);
    assert.doesNotMatch(JSON.stringify(accepted), /invented-model|invented-client|invented-set|invented\/directory/);
    for (const bad of [change(header, { version: 2 }), change(header, { sessionId: "other-chat" })]) {
        await assert.rejects(read(bad), { code: "HISTORY_IDENTITY_UNSUPPORTED" });
    }
    for (const bad of [{ ...header, parentId: p.id }, { ...header, checkpoint: true }, change(header, { detachedFromSpawningParentSessionId: "other" }),
        change(header, { context: { cwd: "/invented", originatingMessageId: "other" } }),
        change(header, { context: { cwd: "/invented", pendingGitContext: "false" } }),
        change(header, { githubMcpToolConfig: { additionalTools: [{ toolCallId: s.data.toolCallId }] } }),
        change(header, { githubMcpToolConfig: { additionalTools: [s.data.toolCallId] } }),
        change(header, { context: { cwd: "/invented", branch: "api_key=invented-value" } }),
        JSON.stringify(header).replace('"parentId":null', `"parentId":"${a.id}","parentId":null`)]) {
        await assert.rejects(read(bad), unverified);
    }
});

test("six causal originals link an app-mapped start only to its independently recorded completion", async () => {
    for (const [success, outcome] of [[true, "succeeded"], [false, "failed"], [undefined, "unknown"]]) {
        const rows = withCausalHooks([p, a, s, change(e, { success })], sessionId);
        const out = await scan(rows);
        assert.deepEqual(out.records, (await scan([p, a, s, change(e, { success })])).records);
        const [call] = out.records[0].toolCalls;
        assert.deepEqual([call.startEventId, call.completionEventId, call.reportedOutcome, out.excluded, out.omittedRegions],
            [s.id, e.id, outcome, 0, 0]);
        assert.doesNotMatch(JSON.stringify(out), /private hook result|invented response body/i);
    }
});

test("a causal chain cannot borrow another request, source, hook, completion or grant", async () => {
    const rows = withCausalHooks([p, a, s, e], sessionId);
    const input = (i, fields) => change(rows[i], { input: { ...rows[i].data.input, ...fields } });
    for (const [index, replacement] of [
        [0, change(p, { source: "agent-peer" })], [1, change(a, { toolRequests: [{ toolCallId: "other" }] })],
        [3, input(3, { sessionId: "other" })], [3, input(3, { toolCalls: [] })],
        [4, change(rows[4], { hookInvocationId: "other" })], [4, change(rows[4], { success: "false" })],
        [5, input(5, { serverName: "another" })], [5, input(5, { toolCallId: "other" })],
        [5, input(5, { toolName: "other" })], [5, input(5, { arguments: {} })], [5, input(5, { timestamp: 0 })],
        [6, { ...rows[6], parentId: rows[3].id }], [6, { ...rows[6], agentId: "subagent" }],
        [6, { ...rows[6], timestamp: since }], [6, { ...rows[6], timestamp: "2026-11-02T00:00:00.000Z" }],
        [7, input(7, { toolArgs: {} })], [7, input(7, { toolResult: { content: '{"password":"invented-value"}' } })],
        [7, input(7, { toolResult: { content: padding } })], [7, input(7, { toolResult: { content: "x".repeat(16500) } })],
        [7, JSON.stringify(rows[7]).replace('"postToolUse"', '"other","hookType":"postToolUse"')],
        [8, change(rows[8], { output: { success: true } })],
        [9, { ...rows[9], parentId: s.id }], [9, change(rows[9], { toolCallId: "other" })],
        [9, change(rows[9], { parentToolCallId: "subtask" })], [9, change(rows[9], { turnId: undefined })],
    ]) await assert.rejects(scan(rows.with(index, replacement)), unverified, `replacement at ${index}`);
    for (const bad of [rows.slice(0, -1), rows.toSpliced(4, 1), rows.toSpliced(5, 0, p),
        rows.toSpliced(5, 2, rows[7], rows[8]), rows.toSpliced(5, 2, ...rows.slice(5, 7).map(row =>
            change(row, { hookInvocationId: rows[3].data.hookInvocationId })))]) await assert.rejects(scan(bad), unverified);
    await assert.rejects(scan(rows, { source: { ...source, managedWorkIqEventIds: [] } }), unverified);
});

test("causal hook identities are exclusive over the source and checkpoint, including later and suppressed rows", async () => {
    const rows = withCausalHooks([p, a, s, e], sessionId);
    const reads = await parts(encode([boot, ...rows]));
    for (const id of rows.slice(3, 9).flatMap(row => [row.id, row.data.hookInvocationId])) {
        const foreign = line("foreign", "assistant.message", { apiCallId: id }, 86400001);
        for (const events of [[foreign, ...rows], [...rows, foreign]]) await assert.rejects(scan(events), unverified);
        for (const options of [{ checkpointEvents: [{ data: { nested: [id] } }] },
            { deletion: { events: [eventIdentity(sessionId, id)] } }, { deletion: { contextCalls: [callIdentity(sessionId, id)] } }]) {
            assert.throws(() => decide(reads, { state: options }), unverified);
        }
    }
    const retained = [p, a, s, rows.at(-1)].map(event => retainEvent(event, { credentialExclusions: 0 },
        { managedWorkIqEventIds: new Set(source.managedWorkIqEventIds) }));
    assert.equal(decide(reads, { state: { checkpointEvents: retained } }).records.length, 1);
    assert.equal(decide(reads, { state: { checkpointEvents: [...retained, retained[3]] } }).excluded, 1);
});

test("a parsed original that could hide a second ID cannot validate a causal chain", async () => {
    const rows = withCausalHooks([p, a, s, e], sessionId);
    const shadowed = JSON.stringify(line("foreign", "assistant.message", {}, 86400001))
        .replace('"id":', `"id":"${rows[3].id}","id":`);
    for (const events of [[shadowed, ...rows], [...rows, shadowed]]) await assert.rejects(scan(events), unverified);
    for (const key of ["id", "hookInvocationId", "toolCallId"]) {
        const shadowedProjection = JSON.stringify(hook).replace(`"${key}":`, `"${key}":"${rows[3].id}","${key}":`);
        await assert.rejects(scan([shadowedProjection, ...rows]), unverified);
    }
});

test("only an entire start/hooks/completion in one committed part can certify the causal edge", async () => {
    const rows = withCausalHooks([p, a, s, e], sessionId);
    const pad = line("pad", "assistant.message", { content: "x".repeat(68000) }, 0);
    const bytes = encode([boot, pad, ...rows]);
    for (let split = 2; split < rows.length; split++) {
        const offset = encode([boot, pad, ...rows.slice(0, split)]).length;
        const reads = await parts(bytes, [65536 + 256 + offset + 2]);
        assert.equal(reads[0].cursor.offset, offset);
        if (split === 2) assert.equal(decide(reads).records.length, 1);
        else assert.throws(() => decide(reads), unverified);
    }
});

test("a compact, unrelated post-tool hook can close without certifying a tool completion", async () => {
    const simple = change(hook, { input: { sessionId, toolCallId: "hook-call", toolName: "other-tool", toolArgs: {} } });
    const close = line("hook-done", "hook.end", { hookInvocationId: simple.data.hookInvocationId,
        hookType: "postToolUse", success: false }, 1, simple.id);
    const expected = (await scan([p, a, s, e])).records;
    for (const at of [0, 4]) {
        const out = await scan([p, a, s, e].toSpliced(at, 0, simple, close));
        assert.deepEqual(out.records, expected);
        assert.equal(out.omittedRegions, 0);
    }
    assert.equal((await scan([p, a, s, simple, close, e])).excluded, 1);
    const prefix = encode([boot, line("padding", "user.message", { content: "x".repeat(68000) }, 0), simple]);
    const bytes = Buffer.concat([prefix, encode([close, p, a, s, e])]);
    const reads = await parts(bytes, [65536 + 256 + prefix.length + 2]);
    assert.equal(reads[0].cursor.offset, prefix.length);
    assert.deepEqual(decide(reads), decide(await parts(bytes)));
    for (const pair of [[close], [simple, { ...close, parentId: s.id }], [simple, { ...close, id: p.data.messageId }],
        [simple, change(close, { output: { toolCallId: s.data.toolCallId } })], [simple, change(close, { success: "false" })],
        [simple, change(close, { hookInvocationId: "other-invocation" })], [simple, close, close], [hook, close]]) {
        await assert.rejects(scan([p, a, s, e, ...pair]), unverified);
    }
    await assert.rejects(scan([simple, close, p, a, s, e], { state: { checkpointEvents: [
        line("foreign", "assistant.message", { wireToolRequestIds: [simple.data.input.toolCallId] }, 8),
    ] } }), unverified);
    await assert.rejects(scan([simple, close, p, a, s, e], { state: { deletion: {
        contextCalls: [callIdentity(sessionId, simple.data.input.toolCallId)],
    } } }), unverified);
});

test("SDK session-mode metadata is a boundary, not a call, grant or source of missing links", async () => {
    const changeMode = line("mode-event", "session.mode_changed", { previousMode: "interactive", newMode: "plan" }, 5, boot.id);
    const permission = line("permission-event", "session.permissions_changed", { mode: "manual" }, 6, changeMode.id);
    const notice = line("notice-event", "session.mode_notice_delivered", { mode: "plan", instructionUpdatePersisted: true }, 7, permission.id);
    const metadata = [changeMode, permission, notice], baseline = await scan([p, a, s, e]);
    for (const pos of [0, 4]) {
        const out = await scan([p, a, s, e].toSpliced(pos, 0, ...metadata));
        assert.deepEqual(out.records, baseline.records);
        assert.notEqual(out.witness, baseline.witness);
    }
    assert.deepEqual((await scan([p, a, ...metadata, s, e])).records, []);
    for (const bad of [change(changeMode, { parentToolCallId: s.data.toolCallId }), change(changeMode, { newMode: "undeclared" }),
        { ...permission, parentId: s.id }, { ...changeMode, id: p.data.messageId }, { ...changeMode, agentId: "foreign-agent" },
        { ...changeMode, checkpoint: true }, { ...notice, parentId: boot.id, data: { mode: "plan", content: "Unexpected free text" } }]) {
        for (const pos of [0, 2, 4]) await assert.rejects(scan([p, a, s, e].toSpliced(pos, 0, bad)), unverified);
    }
    await assert.rejects(scan([changeMode, p, a, s, e], { state: { checkpointEvents: [
        line("foreign", "assistant.message", { wireToolRequestIds: [changeMode.id] }, 8),
    ] } }), unverified);
});

test("an on/off permissions transition is a notice only when its two recorded forms agree", async () => {
    const before = line("permission", "session.permissions_changed", { previousAllowAllPermissions: false,
        allowAllPermissions: true, previousAllowAllPermissionMode: "off", allowAllPermissionMode: "on" }, 0, boot.id);
    const direct = [p, a, s, e];
    for (const notice of [before, change(before, { previousAllowAllPermissions: true, previousAllowAllPermissionMode: "on",
        allowAllPermissions: false, allowAllPermissionMode: "off" })]) {
        assert.deepEqual((await scan([notice, ...direct])).records, (await scan(direct)).records);
    }
    for (const bad of [{ allowAllPermissions: false }, { allowAllPermissions: "true" }, { previousAllowAllPermissionMode: "always" },
        { allowAllPermissionMode: undefined }, { mode: "manual" }, { previousMode: "manual" }, { interactionId: p.id }]) {
        await assert.rejects(scan([change(before, bad), ...direct]), unverified);
    }
});

test("a remote task notice contributes a fenced reference, never a second source or call", async () => {
    const task = "395078e3-b26f-43f5-81ae-681384491cad";
    const url = `https://github.com/copilot/tasks/${task}`;
    const remote = line("remote-notice", "session.info", { infoType: "remote", message: "An invented notice.", url }, 0, boot.id);
    const original = [p, a, s, e];
    const out = await scan([remote, ...original]);
    assert.deepEqual(out.records, (await scan(original)).records);
    assert.doesNotMatch(JSON.stringify(out), /github\.com|invented notice|395078e3/);
    for (const data of [{ url: url + "?token=private" }, { url: url + "#fragment" }, { url: url.replace("github.com", "example.org") },
        { url: url.replace(task, s.data.toolCallId) }, { infoType: "other" }, { destination: url }, { url: `https://github.com/copilot/tasks/${sessionId}` }]) {
        await assert.rejects(scan([change(remote, data), ...original]), unverified);
    }
    await assert.rejects(scan([remote, ...original, change(a, { apiCallId: task })]), unverified);
    await assert.rejects(scan([remote, ...original], { state: { checkpointEvents: [{ alias: task }] } }), unverified);
});

// Root timing metadata as consumed/produced by retainResponseTimingEvent (not an
// assertion about other Copilot envelope versions). No parent link is inferred.
const begin = line("boundary-open", "assistant.turn_start", { turnId: "other-turn" }, 5);
const end = line("boundary-close", "assistant.turn_end", { turnId: "other-turn" }, 6);
test("fully read disjoint turn boundaries leave the same exact call, never bridge its chain", async () => {
    const baseline = await scan([p, a, s, e]);
    for (const context of [[begin], [end], [begin, end]]) {
        for (const at of [0, 4]) {
            const rows = at ? context : context.map(x => ({ ...x, timestamp: since }));
            const out = await scan([p, a, s, e].toSpliced(at, 0, ...rows), { state: { checkpointEvents: rows } });
            assert.deepEqual(out.records, baseline.records);
            assert.deepEqual([out.records[0].toolCalls[0].toolCallId, out.excluded, out.omittedRegions], ["call-one", 0, 0]);
            assert.notEqual(out.witness, baseline.witness);
        }
    }
    const inside = await scan([p, a, begin, end, s, e]);
    assert.deepEqual([inside.records, inside.excluded, inside.omittedRegions], [[], 1, 0]);
});

test("turn identity must be disjoint across the whole original and retained checkpoint", async () => {
    for (const extra of [
        change(begin, { turnId: s.data.turnId }), change(begin, { turnId: a.data.messageId }),
        { ...begin, id: e.id }, change(begin, { turnId: s.data.toolCallId }),
    ]) {
        for (const at of [0, 4]) await assert.rejects(scan([p, a, s, e].toSpliced(at, 0, extra)), unverified);
    }
    // Neither an unmapped, out-of-day start nor an earlier proposal makes a late alias harmless.
    const other = line("shell-start", "tool.execution_start", {
        turnId: begin.data.turnId, toolCallId: "shell-call", toolName: "shell",
    }, 86400000);
    for (const events of [[begin, other], [begin, { ...end, id: begin.id }], [begin, { ...begin, id: "another-open" }],
        [begin, { ...end, timestamp: since }], [end, begin], [begin, ...chain("two"), end]]) {
        await assert.rejects(scan([p, a, s, e, ...events]), unverified);
    }
    const reads = await parts(encode([boot, p, a, s, e, begin, end]));
    for (const checkpointEvents of [[begin, begin], [change(begin, { turnId: "elsewhere" })],
        [line("unknown", "unknown.kind", { nested: { alias: begin.data.turnId } }, 8)]]) {
        assert.throws(() => decide(reads, { state: { checkpointEvents } }), unverified);
    }
});

test("turn context must be complete, unlinked, credential-free and not deleted", async () => {
    const raw = JSON.stringify(begin);
    for (const extra of [
        { ...begin, agentId: "other-agent" }, { ...end, parentId: begin.id },
        change(begin, { parentToolCallId: "other-call" }), change(end, { turnId: undefined }),
        { ...begin, type: "session.usage_record" }, { ...end, metadata: {} },
        { ...end, id: "ghp_" + "Z".repeat(24) }, change(begin, { turnId: "api_key:invented" }),
        raw.replace('"other-turn"', '"turn-one","turnId":"other-turn"'),
        raw.slice(0, -1), raw + " ".repeat(TAIL_LIMITS.maxLineBytes),
    ]) await assert.rejects(scan([p, a, s, e, extra]), unverified);
    const reads = await parts(encode([boot, p, a, s, e, begin, end]));
    for (const deletion of [{ events: [eventIdentity(sessionId, end.id)] },
        { contextCalls: [callIdentity(sessionId, begin.data.turnId)] }]) {
        assert.throws(() => decide(reads, { state: { deletion } }), unverified);
    }
});

test("a disjoint turn can close across committed reads, but never across a missing read or index overflow", async () => {
    const prefix = encode([boot, hook, begin]), bytes = Buffer.concat([prefix, encode([end, p, a, s, e])]);
    const reads = await parts(bytes, [65536 + 256 + prefix.length + 3]);
    assert.equal(reads[0].cursor.offset, prefix.length);
    assert.deepEqual(decide(reads), decide(await parts(bytes)));
    assert.throws(() => decide(reads.slice(0, 1)), unverified);

    // Two identities per singleton, including the last one: never drop an old key
    // to make room for a later one, even when a candidate was already proposed.
    const boundaries = Array.from({ length: 2049 }, (_, i) =>
        line(`boundary-${i}`, "assistant.turn_start", { turnId: `other-${i}` }, 5));
    await assert.rejects(scan([p, a, s, e, ...boundaries]), { code: "EXACT_EVIDENCE_LIMIT" });
});

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
