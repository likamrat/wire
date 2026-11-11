import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { readTail, readCompletionLookbehind, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { projectOversizedSourceEvent, projectOversizedCompletion, COMPLETION_PROJECTION_LIMITS } from "../lib/completion-projection.mjs";
import { recoverSameReadCompletions } from "../lib/completion-recovery.mjs";
import { eventIdentity } from "../lib/deletion-identities.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { buildRequestActivity } from "../lib/activity-analytics.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";
import { indexSearchText, rankTextSearch } from "../lib/search-text.mjs";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

const sourceId = "22222222-2222-4222-8222-222222222222";
const budgets = { maxInputBytes: TAIL_LIMITS.chunkBytes, maxOutputBytes: 16384 };
const encoded = events => events.map(event => JSON.stringify(event) + "\n").join("");

function sourceEvents({ padding = 0, payload = "EXCLUDED_BODY_" + "x".repeat(1100000) } = {}) {
    const now = Date.now() - 10000;
    const event = (id, type, data, offset, parentId) => ({
        id, type, timestamp: new Date(now + offset).toISOString(), data, ...(parentId ? { parentId } : {}),
    });
    const start = event("start", "tool.execution_start", {
        toolCallId: "call", toolName: "workiq-fetch_blob", mcpToolName: "fetch_blob", mcpServerName: "workiq",
        mcpConfigServerName: "workiq", mcpTransport: "stdio", mcpConfigSource: "global", toolTitle: "fetch_blob",
        model: "recorded-model", turnId: "turn", arguments: { path: "/me/drive/items/invented/content" },
    }, 1, "prompt");
    const inputs = [
        { sessionId: sourceId, cwd: "invented", toolCalls: [{ id: "call", name: start.data.toolName, args: start.data.arguments }] },
        { sessionId: sourceId, cwd: "invented", timestamp: now + 3, toolCallId: "call", serverName: "workiq",
            toolName: "fetch_blob", arguments: start.data.arguments },
        { sessionId: sourceId, cwd: "invented", timestamp: now + 5, toolName: start.data.toolName,
            toolArgs: start.data.arguments, toolResult: { content: payload } },
    ];
    const hooks = ["preToolUse", "preMcpToolCall", "postToolUse"].flatMap((hookType, index) => [
        event(`hook-${index}-start`, "hook.start", { hookInvocationId: `invocation-${index}`, hookType, input: inputs[index] },
            2 + index * 2, index ? `hook-${index - 1}-end` : "start"),
        event(`hook-${index}-end`, "hook.end", { hookInvocationId: `invocation-${index}`, hookType, success: true },
            3 + index * 2, `hook-${index}-start`),
    ]);
    const completion = event("completion", "tool.execution_complete", {
        toolCallId: "call", model: "recorded-model", interactionId: "interaction", turnId: "turn", rte: true,
        success: true, result: { content: payload },
        toolTelemetry: { properties: { result_type: "success" }, metrics: { output_bytes: payload.length } },
    }, 2022, "hook-2-end");
    return {
        start, hooks, completion,
        events: [event("startup", "session.start", { sessionId: sourceId, version: 1 }, 0),
            ...Array.from({ length: padding }, (_, i) => event(`padding-${i}`, "assistant.message", { content: "x".repeat(950000) }, 0)),
            event("prompt", "user.message", { content: "Read the invented file." }, 0, "startup"), start, ...hooks, completion],
    };
}

async function installation(t, source) {
    const { root, context } = await privateFixture(t, []);
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
    const db = new DatabaseSync(config.appDbPath);
    try {
        db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented qualification", "chat", null, "local");
    } finally { db.close(); }
    const file = path.join(config.sessionRoot, sourceId, "events.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, encoded(source.events));
    let collector = await createCollector(context, { timers: false });
    await collector.configure({ ...config, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    return { context, config, file, collector, async restart() {
        await collector.close();
        collector = await createCollector(context, { timers: false });
        this.collector = collector;
    } };
}

async function finish(app) {
    const reads = [];
    for (let n = 0; n < 5; n++) {
        const result = await app.collector.collectNow();
        reads.push(result);
        assert.ok(result.metrics.lastBytesRead <= TAIL_LIMITS.cycleBytes);
        if (!result.metrics.backlogBytes) break;
    }
    const state = await loadBoardState(app.context), calls = state.evidence.flatMap(record => record.toolCalls);
    assert.equal(calls.length, 1);
    assert.equal(reads.at(-1).metrics.backlogBytes, 0);
    return { state, call: calls[0], reads };
}

test("ordinary collection qualifies the complete source hook chain without retaining omitted payloads", async t => {
    const source = sourceEvents(), app = await installation(t, source);
    const original = await fs.readFile(app.file);
    const result = await finish(app);
    assert.equal(result.call.reportedOutcome, "succeeded");
    assert.equal(result.call.durationMs, 2021);
    assert.equal(result.call.completionEventId, "completion");
    assert.deepEqual(result.call.apiResults, []);
    assert.ok(result.reads[0].metrics.oversizedLines >= 2);
    assert.deepEqual(await fs.readFile(app.file), original);
    assert.doesNotMatch(JSON.stringify(result.state.evidence), /EXCLUDED_BODY_|toolTelemetry|hookInvocationId/);
    const index = JSON.parse(await fs.readFile(path.join(app.context.dataDir, "collector", "index.json")));
    const cache = await fs.readFile(path.join(app.context.dataDir, "collector", index.fingerprint, `${sourceId}.json`), "utf8");
    assert.doesNotMatch(cache, /EXCLUDED_BODY_|toolResult|toolTelemetry/);
    await app.restart();
    assert.deepEqual((await finish(app)).call, result.call);
    assert.equal((await app.collector.collectNow()).metrics.lastBytesRead, 0);
});

for (const mode of ["late-restart", "chunk-boundary"]) {
    test(`fresh original lookbehind qualifies ${mode} without saved-start authority`, async t => {
        const source = sourceEvents({ padding: mode === "chunk-boundary" ? 4 : 0 });
        const complete = source.events.pop();
        if (mode !== "late-restart") source.events.push(complete);
        const app = await installation(t, source);
        if (mode === "late-restart") {
            assert.equal((await finish(app)).call.reportedOutcome, "unknown");
            await app.restart();
            await fs.appendFile(app.file, encoded([complete]));
        }
        const original = await fs.readFile(app.file), result = await finish(app);
        assert.equal(result.call.reportedOutcome, "succeeded");
        assert.equal(result.call.durationMs, 2021);
        assert.deepEqual(result.call.apiResults, []);
        assert.ok(result.reads.some(read => read.metrics.lastBytesRead > Buffer.byteLength(encoded([complete]))));
        assert.deepEqual(await fs.readFile(app.file), original);
    });
}

test("fresh lookbehind cannot hide a conflicting completion or hook already observed after its fence", async t => {
    for (const type of ["completion", "hook"]) await t.test(type, async t => {
        const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
        await finish(app);
        const conflict = type === "completion" ? { ...completion, id: "another-completion" }
            : { ...source.hooks[1], id: "another-hook-end" };
        await fs.appendFile(app.file, encoded([completion, conflict]));
        assert.equal((await finish(app)).call.reportedOutcome, "unknown");
    });
});

test("projected optional metadata has no authority and malformed or excessive selected values refuse", () => {
    const { completion, hooks } = sourceEvents();
    const good = projectOversizedCompletion(Buffer.from(encoded([completion])), budgets);
    assert.equal(good.kind, "projected");
    assert.deepEqual(good.event.data, { toolCallId: "call", success: true, turnId: "turn", model: "recorded-model" });
    for (const patch of [{ interactionId: "bad/scope" }, { rte: "true" }, { toolTelemetry: [] },
        { toolTelemetry: { metrics: { result: "success" } } }, { toolTelemetry: { actor: "user" } }]) {
        assert.equal(projectOversizedCompletion(Buffer.from(encoded([{ ...completion, data: { ...completion.data, ...patch } }])), budgets).kind, "unavailable");
    }
    const hook = projectOversizedSourceEvent(Buffer.from(encoded([hooks[4]])), budgets);
    assert.equal(hook.kind, "projected");
    assert.equal(hook.event.data.input.sessionId, sourceId);
    assert.deepEqual(hook.event.data.input.toolArgs, { path: "/me/drive/items/invented/content" });
    assert.doesNotMatch(JSON.stringify(hook), /EXCLUDED_BODY_|toolResult/);
    const huge = structuredClone(hooks[4]);
    huge.data.input.toolArgs = Object.fromEntries(Array.from({ length: 1200 }, (_, n) => [`key${n}`, n]));
    const rejected = projectOversizedSourceEvent(Buffer.from(encoded([huge])), budgets);
    assert.equal(rejected.reason, "projection-limit");
    assert.ok(rejected.work.selectedNodes <= COMPLETION_PROJECTION_LIMITS.selectedNodes + 1);
});

test("hook pairing, explicit scope, source and call bindings all remain mandatory", async t => {
    for (const [name, mutate] of [
        ["wrong source", s => { s.hooks[4].data.input.sessionId = "other-source"; }],
        ["wrong call", s => { s.hooks[2].data.input.toolCallId = "other-call"; }],
        ["wrong arguments", s => { s.hooks[4].data.input.toolArgs = { path: "/different" }; }],
        ["wrong pre-tool call", s => { s.hooks[0].data.input.toolCalls[0].id = "other-call"; }],
        ["cross turn", s => { s.hooks[3].data.turnId = "other-turn"; }],
        ["cross agent", s => { s.hooks[3].agentId = "other-agent"; }],
        ["unpaired invocation", s => { s.hooks[3].data.hookInvocationId = "other-invocation"; }],
        ["duplicate invocation", s => { s.hooks[2].data.hookInvocationId = s.hooks[3].data.hookInvocationId = "invocation-0"; }],
        ["duplicate outside chain", s => { s.events.splice(-1, 0, { ...s.hooks[1], id: "duplicate-hook-end" }); }],
        ["reversed chronology", s => { s.hooks[2].timestamp = s.completion.timestamp; }],
        ["missing intermediary", s => { s.hooks[4].parentId = "missing"; }],
    ]) await t.test(name, async t => {
        const source = sourceEvents(); mutate(source);
        const app = await installation(t, source);
        assert.equal((await finish(app)).call.reportedOutcome, "unknown");
    });
});

test("fresh lookbehind refuses original mutation, replacement and truncation rather than trusting saved starts", async t => {
    for (const action of ["mutate", "replace", "truncate"]) await t.test(action, async t => {
        const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
        const first = await finish(app);
        await fs.appendFile(app.file, encoded([completion]));
        const index = JSON.parse(await fs.readFile(path.join(app.context.dataDir, "collector", "index.json")));
        const tail = await readTail(app.file, sourceId, index.sources[sourceId].cursor, TAIL_LIMITS.chunkBytes, { completionMetadata: true });
        const target = tail.recovery.projected.find(entry => entry.event.type === "tool.execution_complete");
        if (action === "replace") {
            await fs.rename(app.file, `${app.file}.old`);
            await fs.writeFile(app.file, encoded([...source.events, completion]));
        } else if (action === "truncate") await fs.truncate(app.file, 500);
        else await fs.appendFile(app.file, "\n");
        await assert.rejects(readCompletionLookbehind(app.file, sourceId, target, tail.recovery, TAIL_LIMITS.chunkBytes),
            error => error.code === "HISTORY_SOURCE_CHANGED" && error.bytesRead === 0);
        assert.deepEqual((await loadBoardState(app.context)).evidence[0].toolCalls[0], first.call);
    });
});

test("a deleted hook dependency and a credential-bearing original start veto fresh qualification", async t => {
    const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
    const first = await finish(app);
    await fs.appendFile(app.file, encoded([completion]));
    const index = JSON.parse(await fs.readFile(path.join(app.context.dataDir, "collector", "index.json")));
    const tail = await readTail(app.file, sourceId, index.sources[sourceId].cursor, TAIL_LIMITS.chunkBytes, { completionMetadata: true });
    const target = tail.recovery.projected.find(entry => entry.event.type === "tool.execution_complete");
    const fresh = await readCompletionLookbehind(app.file, sourceId, target, tail.recovery, TAIL_LIMITS.chunkBytes);
    assert.ok(fresh.bytesRead <= TAIL_LIMITS.chunkBytes);
    const input = { ...fresh.recovery, sourceSessionId: sourceId, since: new Date(Date.now() - 86400000).toISOString(),
        until: new Date().toISOString(), records: first.state.evidence, deletion: { events: [eventIdentity(sourceId, "hook-2-start")] } };
    assert.equal(recoverSameReadCompletions(input).dispositions[0].reason, "deleted-or-suppressed");
    const start = input.original.find(entry => entry.event.id === "start");
    start.event.data.arguments.secret = "ghp_" + "a".repeat(30);
    input.deletion = {};
    assert.equal(recoverSameReadCompletions(input).dispositions[0].status, "unavailable");
});

test("lookbehind rejects insufficient budget before opening any file", async t => {
    let opens = 0;
    const original = fs.open;
    const mock = t.mock.method(fs, "open", (...args) => { opens++; return original(...args); });
    syncBuiltinESMExports();
    try {
        await assert.rejects(readCompletionLookbehind("not-opened", sourceId, {}, {}, TAIL_LIMITS.chunkBytes - 1), RangeError);
        const tooWide = await readCompletionLookbehind("not-opened", sourceId, {
            event: { type: "tool.execution_complete" }, offset: 0, endOffset: TAIL_LIMITS.chunkBytes,
            sha256: "0".repeat(64), endAnchor: "0".repeat(64),
        }, { sourceIdentity: "source", sourceStamp: "stamp" }, TAIL_LIMITS.chunkBytes);
        assert.equal(tooWide.reason, "lookbehind-span-limit");
        assert.equal(tooWide.bytesRead, 0);
        assert.equal(opens, 0);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("cycle budget defers at the unqualified completion and makes forward progress after restart", async t => {
    const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
    const sources = [{ id: sourceId, file: app.file, completion, offset: Buffer.byteLength(encoded(source.events)) }];
    const db = new DatabaseSync(app.config.appDbPath);
    try {
        for (let n = 1; n <= 10; n++) {
            const id = `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
            const values = JSON.parse(JSON.stringify(sourceEvents().events).replaceAll(sourceId, id));
            const completion = values.pop(), file = path.join(app.config.sessionRoot, id, "events.jsonl");
            db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, "Invented budget source", "chat", null, "local");
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, encoded(values));
            sources.push({ id, file, completion, offset: Buffer.byteLength(encoded(values)) });
        }
    } finally { db.close(); }
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.flatMap(record => record.toolCalls).length, sources.length);
    for (const source of sources) await fs.appendFile(source.file, encoded([source.completion]));
    const read = await app.collector.collectNow();
    assert.ok(read.metrics.lastBytesRead <= TAIL_LIMITS.cycleBytes);
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    const index = JSON.parse(await fs.readFile(indexFile));
    const deferred = Object.entries(index.sources).filter(([, value]) => value.errorCode === "COMPLETION_READ_DEFERRED");
    assert.ok(deferred.length > 0, "This fixture must consume the shared budget before every fresh lookbehind");
    for (const [id, value] of deferred) {
        const source = sources.find(source => source.id === id);
        assert.equal(value.cursor.offset, source.offset);
        const tail = await readTail(source.file, id, value.cursor, TAIL_LIMITS.chunkBytes, { completionMetadata: true });
        assert.equal(tail.reset, false, "The deferred cursor anchor must bind the original source boundary");
        assert.equal(tail.recovery.projected.find(entry => entry.event.type === "tool.execution_complete").offset, source.offset);
    }
    await app.restart();
    let calls;
    for (let pass = 0; pass < 4; pass++) {
        const result = await app.collector.collectNow();
        assert.ok(result.metrics.lastBytesRead <= TAIL_LIMITS.cycleBytes);
        calls = (await loadBoardState(app.context)).evidence.flatMap(record => record.toolCalls);
        if (calls.every(call => call.reportedOutcome === "succeeded")) break;
    }
    assert.equal(calls.length, sources.length);
    assert.ok(calls.every(call => call.reportedOutcome === "succeeded"));
    assert.equal((await app.collector.collectNow()).metrics.lastBytesRead, 0);
});

test("ordinary publication refuses a source change after fresh lookbehind reading", async t => {
    const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
    const initial = await finish(app);
    const indexFile = path.join(app.context.dataDir, "collector", "index.json");
    const index = JSON.parse(await fs.readFile(indexFile));
    const checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${sourceId}.json`);
    const checkpoint = await fs.readFile(checkpointFile);
    await fs.appendFile(app.file, encoded([completion]));
    const opening = fs.open;
    let opens = 0, changed = false;
    const mock = t.mock.method(fs, "open", async (...args) => {
        const handle = await opening(...args);
        if (args[0] === app.file && ++opens === 3) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
                await close();
                await fs.appendFile(app.file, "\n");
                changed = true;
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(app.collector.collectNow(), error => error.code === "COLLECTION_SOURCE_CHANGED");
        assert.equal(changed, true, "Mutation must occur after the fresh lookbehind, not an earlier ordinary read");
        assert.deepEqual((await loadBoardState(app.context)).evidence, initial.state.evidence);
        assert.deepEqual(await fs.readFile(checkpointFile), checkpoint);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("deleted calls cannot be restored from a fresh source chain on late completion", async t => {
    const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
    await finish(app);
    const deletion = createDeletionController(app.context);
    const preview = await deletion.preview("invented-owner", { scope: "all" });
    const applied = await deletion.confirm("invented-owner", { operationId: preview.operationId, confirmed: true });
    assert.equal(applied.phase, "complete");
    await app.restart();
    await fs.appendFile(app.file, encoded([completion]));
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 0);
});

test("complex discarded structures retain the real generated-token refusal", async t => {
    const source = sourceEvents({ payload: "EXCLUDED_BODY_" + "x".repeat(1100000) });
    source.completion.data.result.structuredContent = Array.from({ length: 35000 }, () => ({ value: "x" }));
    const projected = projectOversizedCompletion(Buffer.from(encoded([source.completion])), budgets);
    assert.equal(projected.reason, "token-limit");
    assert.ok(projected.work.consumedTokens <= COMPLETION_PROJECTION_LIMITS.tokens);
    assert.ok(projected.work.generatedTokens <= COMPLETION_PROJECTION_LIMITS.tokens + COMPLETION_PROJECTION_LIMITS.batchTokens);
    const app = await installation(t, source), result = await finish(app);
    assert.equal(result.call.reportedOutcome, "unknown");
    assert.equal(result.call.toolSucceeded, null);
    assert.equal(result.call.durationMs, null);
});

test("qualified completion reaches normal cards, reader, report facts, analytics and literal Search", { timeout: 30000 }, async t => {
    const source = sourceEvents(), completion = source.events.pop(), app = await installation(t, source);
    await finish(app);
    await app.restart();
    await fs.appendFile(app.file, encoded([completion]));
    const result = await finish(app), record = result.state.evidence[0];
    const activity = buildRequestActivity(result.state.evidence);
    assert.deepEqual(activity.tool.map(row => row.outcome), ["success"]);
    assert.deepEqual(activity["reported-api"], []);
    const { facts } = buildReportFacts(result.state.evidence, result.state);
    assert.deepEqual(facts.recordedOutcomes.filter(row => row.kind === "tool-call").map(row => row.outcome), ["success"]);
    assert.equal(facts.metrics.find(metric => metric.definitionId === "tool-duration").value, 2021);
    const frame = await createCorpusSources(app.context, { source: () => app.collector.assessmentSource(result.state) }).scan();
    const matches = await rankTextSearch(frame.entries.filter(entry => entry.coverage.layer === "tool").map(indexSearchText),
        "fetch_blob", ["action"], new AbortController().signal);
    assert.equal(matches.length, 1);
    assert.doesNotMatch(JSON.stringify(frame.entries), /EXCLUDED_BODY_/);
    await app.collector.close();
    const runtime = await startServer(app.context, createExportController(app.context), { port: 0, collector: { timers: false } });
    let browser;
    try {
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
        const errors = [], external = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
                external.push(route.request().url());
                return route.abort();
            }
            return route.continue();
        });
        await page.goto(runtime.url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            const card = page.locator(".request-card-open");
            await expect(card).toContainText("Recorded tool call completed.");
            await expect(card).toContainText("1 recorded call");
            await expect(card).not.toContainText("1 failed");
            await card.click();
            const call = page.locator('[data-reader-section=activity] [data-tool-call-id="call"]');
            await expect(call).toContainText("Call #1 completed");
            await expect(call).toContainText("2,021 ms");
            await expect(call).toContainText("fetch_blob");
            await expect(page.locator("#requestContent")).not.toContainText("EXCLUDED_BODY_");
            await page.locator("#closeContextSidebar").click();
            await page.waitForFunction(() => !document.querySelector("#contextSidebar").open
                && !document.querySelector("#contextSidebar").getAnimations().length);
        }
        assert.deepEqual((await loadBoardState(app.context)).evidence[0], record);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    } finally {
        await browser?.close();
        await runtime.close();
    }
});
