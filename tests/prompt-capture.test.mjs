import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCollector } from "../lib/collector.mjs";
import { TAIL_LIMITS, hash } from "../lib/collector-io.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";

const sessionId = "10000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-10-20T04:10:00Z");
const event = (id, type, data, offset = 0) => ({
    id, type, timestamp: new Date(now - 60000 + offset).toISOString(), data,
});
const prompt = (content, extra = {}, id = "prompt", offset = 0) =>
    event(id, "user.message", { content, source: "user", ...extra }, offset);
const start = (id = "call", offset = 1000) => event(`start-${id}`, "tool.execution_start", {
    toolCallId: id, toolName: "workiq-retrieve", mcpServerName: "workiq", mcpToolName: "retrieve",
    arguments: { query: "Synthetic fixture query" }, turnId: "turn-one",
}, offset);
const startup = event("startup", "session.start", { sessionId, version: 1 }, -1000);
const lines = events => events.map(value => JSON.stringify(value) + "\n").join("");

async function installation(t, events) {
    t.mock.timers.enable({ apis: ["Date"], now });
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-prompt-capture-"));
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
    const file = path.join(config.sessionRoot, sessionId, "events.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(config.appDbPath);
    db.exec(`PRAGMA user_version=156;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sessionId, "Synthetic capture request", "chat", null, "local");
    await writeFile(file, lines([startup, ...events]));
    const context = { dataDir: path.join(root, "retained") };
    let collector = await createCollector(context, { timers: false });
    t.after(async () => { await collector.close(); db.close(); await rm(root, { recursive: true, force: true }); });
    await collector.configure({ ...config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    const fingerprint = hash(JSON.stringify([config.appDbPath, config.sessionRoot, 30]));
    return {
        file, context,
        collect: async () => { await collector.collectNow(); return loadBoardState(context, { readOnly: true }); },
        append: events => appendFile(file, lines(events)),
        checkpoint: async () => JSON.parse(await readFile(path.join(context.dataDir, "collector", fingerprint, sessionId + ".json"), "utf8")),
        restart: async () => { await collector.close(); collector = await createCollector(context, { timers: false }); },
    };
}

test("automatic continuations record absence of an original separately from uncollected host context", async t => {
    const app = await installation(t, [
        prompt("", { source: "autopilot", isAutopilotContinuation: true, transformedContent: "PRIVATE_HOST_CONTROL" }),
        start(),
        prompt("", { source: "system", isAutopilotContinuation: true, transformedContent: "PRIVATE_HOST_CONTROL" }, "system", 2000),
        start("system", 3000),
    ]);
    const state = await app.collect();
    for (const record of state.evidence) {
        assert.equal(record.userPrompt.text, "");
        assert.deepEqual(record.userPrompt.capture, {
            version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null,
        });

    }
    assert.equal(state.evidence[0].userPrompt.authorship.actor, "agent");
    assert.equal(state.evidence[1].userPrompt.authorship.basis, "conflicting-source");
    assert.doesNotMatch(JSON.stringify(state.evidence), /PRIVATE_HOST_CONTROL|transformedContent/);
    assert.doesNotMatch(JSON.stringify(await app.checkpoint()), /PRIVATE_HOST_CONTROL|transformedContent/);
    assert.equal(state.personalEvaluation, undefined);
    const before = state.evidence;
    await app.restart();
    assert.deepEqual((await app.collect()).evidence, before);
});

test("unreadable history entries stop earlier-prompt borrowing and retain a specific gap across restart", async t => {
    const app = await installation(t, [prompt("Synthetic earlier original")]);
    await appendFile(app.file, '{"type":"user.message",not-json}\n');
    await app.collect();
    await app.restart();
    await app.append([start()]);
    const state = await app.collect(), record = state.evidence[0];
    assert.equal(record.userPrompt.text, null);
    assert.equal(record.userPrompt.sourceEventId, undefined);
    assert.equal(record.userPrompt.capture.reason, "malformed-line");
    assert.equal((await app.checkpoint()).cursor.malformedLines, 1);
    await app.append([prompt("Synthetic fresh original", {}, "fresh", 2000), start("fresh", 3000)]);
    assert.equal((await app.collect()).evidence.find(value => value.userPrompt.sourceEventId === "fresh").userPrompt.text,
        "Synthetic fresh original");
});

test("one accepted pending original survives context pressure, restart and a later first call", async t => {
    const text = "x".repeat(TAIL_LIMITS.maxContextBytes + 1);
    const app = await installation(t, [prompt(text)]);
    await app.collect();
    await app.restart();
    await app.append([start()]);
    const state = await app.collect();
    assert.equal(state.evidence[0].userPrompt.text?.length, text.length);
    assert.equal(state.evidence[0].userPrompt.text, text);
    assert.ok(Buffer.byteLength(JSON.stringify((await app.checkpoint()).events))
        <= TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes);
    assert.equal((await app.checkpoint()).cursor.oversizedLines, 0);
});

test("a late original is attached only through its exact assistant tool request, without a second interaction", async t => {
    const app = await installation(t, [start()]);
    const first = await app.collect(), scenarioId = first.evidence[0].scenarioId;
    await app.append([
        event("response", "assistant.message", { originatingMessageId: "message-one", turnId: "turn-one",
            content: "PRIVATE_REPLY", toolRequests: [{ toolCallId: "call", arguments: { query: "PRIVATE_ARGUMENT" } }] }, 900),
        prompt("Synthetic late original", { messageId: "message-one" }),
    ]);
    const state = await app.collect();
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].scenarioId, scenarioId);
    assert.equal(state.evidence[0].userPrompt.text, "Synthetic late original");
    assert.equal(state.evidence[0].promptAssociationEvidence.method, "explicit-message");
    assert.equal(state.evidence[0].followUpPrompts.length, 0);
    assert.doesNotMatch(JSON.stringify(await app.checkpoint()), /PRIVATE_REPLY|PRIVATE_ARGUMENT/);
    await app.restart();
    assert.deepEqual((await app.collect()).evidence, state.evidence);
});

test("same-ID source changes qualify text conflict without replacing the immutable original", async t => {
    const app = await installation(t, [prompt("Synthetic first original"), start()]);
    const before = (await app.collect()).evidence[0].userPrompt;
    await app.append([prompt("Synthetic replacement original")]);
    const after = (await app.collect()).evidence[0].userPrompt;
    assert.equal(after.text, before.text);
    assert.equal(after.sourceTimestamp, before.sourceTimestamp);
    assert.equal(after.authorship.basis, "conflicting-source");
    assert.equal(after.capture.conflict, true);
});

for (const envelope of ["canonical", "ignored-host-context", "multiple-chunks"]) {
    test(`oversized ${envelope} entries retain a gap, not an earlier original or a partial payload`, async t => {
        const app = await installation(t, [prompt("Synthetic earlier original")]);
        const size = envelope === "multiple-chunks" ? TAIL_LIMITS.chunkBytes + 1024 : TAIL_LIMITS.maxLineBytes + 1;
        await app.append([prompt(envelope === "canonical" ? "x".repeat(size) : "Synthetic short original",
            envelope === "canonical" ? {} : { transformedContent: "x".repeat(size) }, "oversized"), start()]);
        await app.collect();
        await app.restart();
        const state = await app.collect(), record = state.evidence[0];
        assert.equal(record.userPrompt.text, null);
        assert.equal(record.userPrompt.sourceEventId, undefined);
        assert.equal(record.userPrompt.capture.reason, "oversized-line");
        assert.match(record.userPrompt.gapId, /^wire-gap-/);
        const checkpoint = await app.checkpoint();
        assert.equal(checkpoint.cursor.oversizedLines, 1);
        assert.doesNotMatch(JSON.stringify(checkpoint), /Synthetic short original|xxxxxx/);
    });
}

test("turn coincidence alone never links a late message", async t => {
    const app = await installation(t, [start()]);
    await app.collect();
    await app.append([prompt("Synthetic unrelated late message", { messageId: "message-one", turnId: "turn-one" })]);
    const state = await app.collect();
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].userPrompt.text, null);
    assert.equal(state.evidence[0].userPrompt.capture.reason, "unlinked");
});

for (const flaw of ["duplicate-message", "different-turn", "subagent"]) {
    test(`explicit linkage rejects ${flaw} evidence instead of borrowing an earlier message`, async t => {
        const response = event("response", "assistant.message", {
            originatingMessageId: "message-one", turnId: flaw === "different-turn" ? "wrong-turn" : "turn-one",
            toolRequests: [{ toolCallId: "call" }],
        }, 900);
        if (flaw === "subagent") response.agentId = "child-agent";
        const messages = [prompt("Synthetic first original", { messageId: "message-one" })];
        if (flaw === "duplicate-message") messages.push(prompt("Synthetic competing original", { messageId: "message-one" }, "competing", 1));
        const app = await installation(t, [...messages, response, start()]);
        const record = (await app.collect()).evidence[0];
        assert.equal(record.userPrompt.text, null);
        assert.equal(record.userPrompt.capture.reason, flaw === "subagent" ? "unlinked" : "ambiguous-link");
    });
}

test("evicting old correlation context never duplicates or reassigns its already saved calls", async t => {
    const oldText = "x".repeat(TAIL_LIMITS.maxContextBytes + 1);
    const app = await installation(t, [prompt(oldText), start()]);
    await app.collect();
    await app.append([prompt("Synthetic new original", {}, "new", 2000), start("new", 3000)]);
    const before = await app.collect();
    assert.equal(before.evidence.length, 2);
    await app.append([event("unrelated", "session.info", {}, 4000)]);
    const after = await app.collect();
    assert.equal(after.evidence.length, 2);
    assert.equal(after.evidence.find(record => record.userPrompt.sourceEventId === "prompt").userPrompt.text, oldText);
    assert.deepEqual(after.evidence.map(record => record.toolCalls.map(call => call.toolCallId)),
        before.evidence.map(record => record.toolCalls.map(call => call.toolCallId)));
});

test("legacy originals do not acquire newly inferred capture facts or get text replaced", async t => {
    const app = await installation(t, [prompt("Synthetic historical original"), start()]);
    await app.collect();
    await replaceEvidence(app.context, (records, importCoverage) => ({
        records: records.map(record => {
            const { capture, ...userPrompt } = record.userPrompt;
            const { promptAssociationEvidence, ...legacy } = record;
            return { ...legacy, userPrompt };
        }), importCoverage,
    }));
    const before = (await loadBoardState(app.context)).evidence[0];
    await app.append([prompt("Synthetic replacement original")]);
    const after = (await app.collect()).evidence[0];
    assert.equal(after.userPrompt.text, before.userPrompt.text);
    assert.equal(after.userPrompt.capture, undefined);
    assert.equal(after.promptAssociationEvidence, undefined);
});

test("new explicit evidence conflicting with a saved origin qualifies the link without replacing original text", async t => {
    const app = await installation(t, [prompt("Synthetic first association", { messageId: "first-message" }), start()]);
    await app.collect();
    await app.append([
        prompt("Synthetic actual linked original", { messageId: "second-message" }, "second-prompt", 10),
        event("response", "assistant.message", { originatingMessageId: "second-message", turnId: "turn-one",
            toolRequests: [{ toolCallId: "call" }] }, 900),
    ]);
    const state = await app.collect();
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].userPrompt.text, "Synthetic first association");
    assert.equal(state.evidence[0].userPrompt.capture.reason, "ambiguous-link");
});

test("a complete prompt exactly at the initial byte-window boundary is not discarded as a partial line", async t => {
    const app = await installation(t, []);
    const boundary = (await readFile(app.file)).length;
    const handle = await open(app.file, "r+");
    try {
        await handle.truncate(boundary + TAIL_LIMITS.initialFileBytes);
        await handle.write(Buffer.from(lines([prompt("Synthetic boundary original"), start()])), 0, undefined, boundary);
    } finally { await handle.close(); }
    const state = await app.collect();
    assert.equal(state.evidence[0].userPrompt.text, "Synthetic boundary original");
});

test("conflicting same-ID deliveries in one batch are disclosed on the first saved copy", async t => {
    const app = await installation(t, [prompt("Synthetic earlier delivery"), prompt("Synthetic latest delivery"), start()]);
    const record = (await app.collect()).evidence[0];
    assert.equal(record.userPrompt.text, "Synthetic latest delivery");
    assert.equal(record.userPrompt.capture.conflict, true);
    assert.equal(record.userPrompt.authorship.basis, "conflicting-source");
});

test("older assistant records without origin-link metadata do not erase an ordinary recorded-order prompt", async t => {
    const app = await installation(t, [
        prompt("Synthetic ordinary original"),
        event("response", "assistant.message", { turnId: "turn-one", toolRequests: [{ toolCallId: "call" }] }, 900),
        start(),
    ]);
    assert.equal((await app.collect()).evidence[0].userPrompt.text, "Synthetic ordinary original");
});

test("range deletion removes new tool-request linkage identifiers from retained checkpoint copies", async t => {
    const app = await installation(t, [
        prompt("Synthetic deletable original"),
        event("response", "assistant.message", { turnId: "turn-one",
            toolRequests: [{ toolCallId: "call" }, { toolCallId: "not-selected" }] }, 900), start(),
    ]);
    await app.collect();
    const controller = createDeletionController(app.context);
    const preview = await controller.preview("synthetic-delete", { scope: "range", from: "2026-10-20", to: "2026-10-20",
        timeContext: { timeZone: "UTC", locale: "en-US" } });
    await controller.confirm("synthetic-delete", { operationId: preview.operationId, confirmed: true });
    assert.deepEqual((await app.checkpoint()).events.find(value => value.id === "response").data.wireToolRequestIds, ["not-selected"]);
    await app.restart();
    await app.collect();
    assert.deepEqual((await app.checkpoint()).events.find(value => value.id === "response").data.wireToolRequestIds, ["not-selected"]);
});

test("ordinary human and agent originals survive reply-saving OFF, host augmentation and sign-in failure", async t => {
    const app = await installation(t, [
        prompt("Synthetic human original", { agentMode: "autopilot", transformedContent: "PRIVATE_AUGMENTATION" }),
        start(),
        event("failed", "tool.execution_complete", { toolCallId: "call", success: false, error: {
            code: "failure", message: "Re-authentication required for MCP server 'workiq'. Run /mcp auth workiq.",
        } }, 1300),
        prompt("Synthetic agent original", { source: "agent-synthetic", transformedContent: "PRIVATE_AUGMENTATION" }, "agent", 2000),
        start("agent", 3000),
    ]);
    const state = await app.collect();
    assert.deepEqual(state.evidence.map(record => record.userPrompt.text), ["Synthetic human original", "Synthetic agent original"]);
    assert.deepEqual(state.evidence.map(record => record.userPrompt.authorship.actor), ["user", "agent"]);
    assert.ok(state.evidence.every(record => record.userPrompt.capture.kind === "message" && record.userPrompt.capture.original === "recorded"));
    assert.equal(state.evidence[0].toolCalls[0].failureEvidence.messageSignal, "workiq-sign-in-required");
    assert.equal(state.personalEvaluation, undefined);
    assert.doesNotMatch(JSON.stringify(await app.checkpoint()), /PRIVATE_AUGMENTATION/);
});

test("privacy exclusions and unsupported message formats retain boundaries with distinct reasons", async t => {
    const app = await installation(t, [
        prompt("Synthetic preceding original", {}, "preceding", -1000),
        prompt('{"password":"invented-fixture-only"}'), start(),
        prompt([{ type: "text", text: "Synthetic unsupported content" }], {}, "unsupported", 2000), start("unsupported", 3000),
    ]);
    const state = await app.collect(), checkpoint = await app.checkpoint();
    assert.deepEqual(state.evidence.map(record => record.userPrompt.text), [null, null]);
    assert.deepEqual(state.evidence.map(record => record.userPrompt.capture.reason), ["credential-excluded", "unsupported-content"]);
    assert.equal(checkpoint.diagnostics.credentialExclusions, 1);
    assert.equal(checkpoint.diagnostics.unsupportedPromptContents, 1);
    assert.doesNotMatch(JSON.stringify(checkpoint), /invented-fixture-only|Synthetic unsupported content/);
});

test("a uniquely linked pending interaction owns new calls from the same recovered origin without a duplicate group", async t => {
    const app = await installation(t, [start()]);
    const first = await app.collect();
    await app.append([
        prompt("Synthetic linked original", { messageId: "message-one" }),
        event("response", "assistant.message", { originatingMessageId: "message-one", turnId: "turn-one",
            toolRequests: [{ toolCallId: "call" }, { toolCallId: "new-call" }] }, 900),
        start("new-call", 2000),
    ]);
    const state = await app.collect();
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].scenarioId, first.evidence[0].scenarioId);
    assert.deepEqual(state.evidence[0].toolCalls.map(call => call.toolCallId), ["call", "new-call"]);
    assert.equal(state.evidence[0].userPrompt.text, "Synthetic linked original");
});
