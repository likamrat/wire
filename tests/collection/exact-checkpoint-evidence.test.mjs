import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { readTail } from "../../lib/collector-io.mjs";
import { retainEvent } from "../../lib/collector.mjs";
import { createExactEvidence } from "../../lib/exact-record-evidence.mjs";
import { callIdentity, eventIdentity } from "../../lib/deletion-identities.mjs";
import { extractScenarios } from "../../lib/history.mjs";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", callId = "call-missing";
const source = { sessionId, name: "Invented chat", eligible: true, managedWorkIqEventIds: ["start-missing"] };
const scope = { since: "2026-11-02T00:00:00.000Z", until: "2026-11-02T23:59:59.999Z" };
const file = "invented-memory-journal";
function chain(name, day, content, server) {
    const toolCallId = `call-${name}`, turnId = `turn-${name}`, messageId = `msg-${name}`;
    const event = (kind, type, data, n, parentId) => ({ id: `${kind}-${name}`, type, data,
        timestamp: `2026-11-0${day}T12:00:00.00${n}Z`, ...(parentId && { parentId }) });
    return [
        event("prompt", "user.message", { content, source: "user", messageId }, 1),
        event("answer", "assistant.message", { messageId: `answer-msg-${name}`, originatingMessageId: messageId,
            turnId, toolRequests: [{ toolCallId }] }, 2, `prompt-${name}`),
        event("start", "tool.execution_start", { toolCallId, turnId, toolName: `${server}-fetch`,
            mcpServerName: server, mcpToolName: "fetch", arguments: { entityUrls: ["/invented"] } }, 3, `answer-${name}`),
        event("end", "tool.execution_complete", { toolCallId, turnId, success: true }, 4, `start-${name}`),
    ];
}
const saved = chain("saved", 1, callId, "workiq"), missing = chain("missing", 2, "Review the invented item.", "cc-invented");
const boot = { id: "boot", type: "session.start", data: { sessionId, version: 1 }, timestamp: "2026-11-01T00:00:00.000Z" };
const journal = [boot, ...saved, ...missing];
const encode = rows => Buffer.from(rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");

async function memoryRead(rows, run) {
    const bytes = encode(rows), stat = { size: bytes.length, dev: 1, ino: 2, birthtimeMs: 3, mtimeMs: 4, ctimeMs: 5 };
    const { open, stat: oldStat } = fs;
    try {
        fs.stat = async target => { assert.equal(target, file); return stat; };
        fs.open = async (target, flags) => {
            assert.equal(target, file); assert.equal(flags, "r");
            return { stat: async () => stat, close: async () => {}, read: async (buf, off, len, pos) =>
                ({ bytesRead: bytes.copy(buf, off, pos, pos + len) }) };
        };
        syncBuiltinESMExports();
        const tail = await readTail(file, sessionId, undefined, undefined, { completionMetadata: true, chargeGuards: true });
        assert.equal(tail.cursor.offset, bytes.length);
        return await run(tail, stat);
    } finally { Object.assign(fs, { open, stat: oldStat }); syncBuiltinESMExports(); }
}
// Ordinary collection before the opaque server mapping was available. Both prompts and
// assistant requests are checkpointed; only the literal Work IQ start produced a saved call.
function collection(tail) {
    const retained = tail.events.map(e => retainEvent(e, { credentialExclusions: 0 })).filter(Boolean);
    const { scenarios: existingRecords } = extractScenarios(retained, { ...source, managedWorkIqEventIds: [] },
        boot.timestamp, scope.until);
    assert.deepEqual(existingRecords.flatMap(r => r.toolCalls.map(c => c.toolCallId)), ["call-saved"]);
    // contextAfter keeps this small recent context, but drops the unmapped call's orphan completion.
    const starts = new Set(retained.filter(e => e.type === "tool.execution_start").map(e => e.data.toolCallId));
    const checkpointEvents = JSON.parse(JSON.stringify(retained.filter(e => e.type !== "tool.execution_complete" || starts.has(e.data.toolCallId))));
    return { checkpointEvents, existingRecords };
}
function decide(tail, state) {
    const acc = createExactEvidence(source, scope, state);
    acc.consume(tail);
    return acc.finish();
}
function veto(tail, state, reason) {
    const { records, excluded } = decide(tail, state);
    assert.deepEqual([records.length, excluded], [0, 1], reason);
}
test("a second claim or an unverified saved prompt remains a veto", async () => {
    await memoryRead(journal, tail => {
        const state = collection(tail);
        const other = state.existingRecords[0], row = state.checkpointEvents.find(r => r.id === saved[0].id);
        const without = state.checkpointEvents.filter(r => r !== row);
        assert.equal(decide(tail, { ...state, checkpointEvents: without }).records.length, 1, "isolate the colliding row");
        for (const [reason, rows] of [
            ["duplicate", [row, row]], ["duplicate with changed content", [row, { ...row, data: { content: "another" } }]],
            ["incomplete prompt", [{ ...row, data: { content: callId } }]], ["unknown type", [{ ...row, type: "unknown" }]],
            ["extra checkpoint field", [{ ...row, extra: true }]],
            ["genuine request", [row, { ...retainEvent(saved[1], {}), data: { ...retainEvent(saved[1], {}).data,
                wireToolRequestIds: [callId] } }]],
            ["unknown nested reference", [row, { type: "unrecognized", data: { nested: [callId] } }]],
        ]) veto(tail, { ...state, checkpointEvents: [...without, ...rows] }, reason);
        for (const [reason, prior] of [
            ["missing", []], ["duplicate", [other, other]], ["sample", [{ ...other, sample: true }]],
            ["different source", [{ ...other, sourceSessionId: "elsewhere" }]],
            ["changed prior text", [{ ...other, userPrompt: { ...other.userPrompt, text: "different" } }]],
            ["changed prior metadata", [{ ...other, userPrompt: { ...other.userPrompt, sourceTimestamp: scope.since } }]],
            ["current call", [{ ...other, toolCalls: [{ ...other.toolCalls[0], toolCallId: callId }] }]],
            ["current Graph call", [{ ...other, graphActivities: [{ toolCallId: callId }] }]],
        ]) veto(tail, { ...state, existingRecords: prior }, reason);
        for (const deletion of [{ events: [eventIdentity(sessionId, saved[0].id)] },
            { contextCalls: [callIdentity(sessionId, callId)] }]) veto(tail, { ...state, deletion }, "deletion");
    });
});
test("the saved row needs one fully read durable original, including at EOF", async () => {
    const state = await memoryRead(journal, collection);
    for (const [reason, rows] of [
        ["original absent", journal.filter(e => e !== saved[0])],
        ["later duplicate original", [...journal, saved[0]]],
        ["changed original", journal.with(1, { ...saved[0], data: { ...saved[0].data, messageId: "different" } })],
        ["suppressed credential elsewhere in the original", journal.with(1, { ...saved[0],
            data: { ...saved[0].data, delivery: "client_secret=invented-value" } })],
        ["unclassified nested prompt field", journal.with(1, { ...saved[0], data: { ...saved[0].data, delivery: { nested: callId } } })],
    ]) await memoryRead(rows, tail => veto(tail, state, reason));
    for (const original of [{ ...saved[0], checkpoint: true }, JSON.stringify(saved[0]).replace('"content":', '"content":"other","content":')]) {
        await assert.rejects(memoryRead(journal.with(1, original), tail => decide(tail, state)), { code: "EXACT_EVIDENCE_UNVERIFIED" });
    }
});
test("a matching value elsewhere in the retained row is not a content-only hit", async () => {
    // "message" is also a collector-generated capture kind, not the claimed prompt text alone.
    const changeId = e => JSON.parse(JSON.stringify(e).replaceAll(callId, "message"));
    await memoryRead(journal.map(changeId), tail => veto(tail, collection(tail), "another occurrence in this row"));
});
test("a saved prompt from another interaction can quote the exact missing call id", async () => {
    await memoryRead(journal, tail => {
        const state = collection(tail);
        const result = decide(tail, state);
        assert.deepEqual(result.records.map(r => [r.userPrompt.sourceEventId, r.toolCalls[0].toolCallId,
            r.toolCalls[0].completionEventId]), [["prompt-missing", callId, "end-missing"]]);
        assert.equal(result.excluded, 0);
    });
});

// Substitute only the controller's outside-world ports. The public preview still
// selects the source, rereads the journal, checks its fence and filters current calls.
async function previewController(ports) {
    const entry = new URL("../../lib/recollection.mjs?checkpoint-memory", import.meta.url).href;
    const memory = "data:text/javascript,export const ports = {}";
    Object.assign((await import(memory)).ports, ports);
    const imports = {
        "./collector.mjs": ["collectorFor"], "./store.mjs": ["loadBoardState", "exclusiveBoard"],
        "./source-host.mjs": ["sourceHost"], "./source-reader.mjs": ["sourceMetadataStamp"],
        "./source-discovery.mjs": ["discoverSources"], "node:fs": ["statSync"],
    };
    const hooks = registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL !== entry || !Object.hasOwn(imports, specifier)) return next(specifier, context);
        const actual = next(specifier, context).url;
        const shim = `export * from ${JSON.stringify(actual)}; import { ports } from ${JSON.stringify(memory)};\n`
            + imports[specifier].map(name => `export const ${name} = (...args) => ports.${name}(...args);`).join("\n");
        return { url: "data:text/javascript," + encodeURIComponent(shim), shortCircuit: true };
    } });
    try {
        const { createRecollectionController } = await import(entry);
        return createRecollectionController({}, { now: () => Date.parse(scope.until), exactRecords: true });
    } finally { hooks.deregister(); }
}
test("normal verified-record preview proposes just the missing call and does not save", async () => {
    await memoryRead(journal, async (tail, stat) => {
        const { checkpointEvents: events, existingRecords: evidence } = collection(tail);
        const board = { evidence, revision: 1, pseudonymKey: "c".repeat(64), exports: [] };
        const checkpoint = { events, proof: ["invented"], cursor: tail.cursor, assertCurrent() {} };
        const before = structuredClone({ board, events });
        const controller = await previewController({
            collectorFor: () => ({ exclusiveActivity: fn => fn(), openRecollectionScope: async () => ({
                verify() {}, check() {}, newOnly: true, config: { windowDays: 7 }, generation: 1,
                correctionContext: async id => { assert.equal(id, sessionId); return checkpoint; },
            }) }),
            loadBoardState: (_session, options) => { assert.equal(options.readOnly, true); return board; },
            exclusiveBoard: (_session, fn, options) => { assert.equal(options.readOnly, true); return fn(board); },
            discoverSources: () => ({ roster: [source], sourceIdentity: "a".repeat(64), metadataStamp: "invented" }),
            sourceHost: () => ({ historyFile: id => { assert.equal(id, sessionId); return file; }, assertCurrent() {} }),
            sourceMetadataStamp: () => "invented", statSync: target => { assert.equal(target, file); return stat; },
        });
        const preview = () => controller.preview("invented-owner", { mode: "verified-records-only",
            sourceSessionIds: [sessionId], from: "2026-11-02", to: "2026-11-02", timeContext: { timeZone: "UTC", locale: "en-US" },
            restorePrompts: false });
        const result = await preview();
        assert.deepEqual([result.counts.proposed, result.counts.added, result.exactMembers.length], [1, 0, 1]);
        assert.doesNotMatch(JSON.stringify(result), /call-missing|Review the invented item/);
        assert.deepEqual({ board, events }, before);
        checkpoint.cursor = { ...checkpoint.cursor, partialBytes: 1 };
        await assert.rejects(preview, { code: "RECOLLECTION_BASIS_CHANGED" });
    });
});
