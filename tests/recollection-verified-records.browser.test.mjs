import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createCollector } from "../lib/collector.mjs";
import { TAIL_LIMITS } from "../lib/collector-io.mjs";
import { withCausalHooks } from "./causal-hook-fixture.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";

const mode = "verified-records-only";
const timeContext = { timeZone: "UTC", locale: "en-US" };
const encode = events => events.map(event => JSON.stringify(event) + "\n").join("");
const event = (id, type, timestamp, data, parentId) => ({ id, type, timestamp, data, ...(parentId && { parentId }) });
const at = (day, offset) => new Date(Date.parse(`${day}T12:00:00Z`) + offset).toISOString();
function chain(day, key, offset, success, { literal = false, finish = true } = {}) {
    const turnId = `turn-${key}`, messageId = `message-${key}`, toolCallId = `call-${key}`;
    const server = literal ? "workiq" : "cc-invented";
    return [
        event(`prompt-${key}`, "user.message", at(day, offset), { source: "user", messageId, content: `Check invented item ${key}.` }),
        event(`answer-${key}`, "assistant.message", at(day, offset + 1), { originatingMessageId: messageId,
            messageId: `answer-message-${key}`, turnId, toolRequests: [{ toolCallId }] }, `prompt-${key}`),
        event(`start-${key}`, "tool.execution_start", at(day, offset + 2), { toolName: `${server}-fetch`, mcpServerName: server,
            mcpToolName: "fetch", turnId, toolCallId, arguments: { entityUrls: ["/me/messages"] } }, `answer-${key}`),
        ...(finish ? [event(`end-${key}`, "tool.execution_complete", at(day, offset + 3), {
            success, turnId, toolCallId, result: { structuredContent: { results: [{ statusCode: 200 }] } },
        }, `start-${key}`)] : []),
    ];
}
const ids = state => state.evidence.flatMap(r => r.toolCalls.map(c => c.toolCallId)).sort();
const receiptFor = ({ operationId, receiptToken }) => ({ operationId, receiptToken });
const confirm = p => ({ mode, operationId: p.operationId, confirmed: true });
const ok = r => { assert.equal(r.status, 200, r.body.error); return r.body; };
async function fixture(t, { preservation = false, opaque = false, large = false, disjointTurns = false, causalHooks = false, anchored = false,
    longRequest = false, denseHook = false, priorNotice = false } = {}) {
    // WIRE forbids a store under the maintained source tree. Own one new,
    // disposable sibling directory, never a configured source or an existing store.
    const root = path.resolve("..", `.wire-verified-records-${randomUUID()}`);
    await mkdir(root);
    const context = { dataDir: path.join(root, "store") }, dbPath = path.join(root, "data.db");
    const sessionRoot = path.join(root, "session-state"), sourceId = randomUUID(), file = path.join(sessionRoot, sourceId, "events.jsonl");
    const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const older = new Date(Date.parse(at(day, 0)) - 86400000).toISOString().slice(0, 10);
    const outside = new Date(Date.parse(at(day, 0)) + 2 * 86400000).toISOString().slice(0, 10);
    const otherId = randomUUID(), otherFile = path.join(sessionRoot, otherId, "events.jsonl");
    let runtime, access, panel;
    const close = async () => { try { await runtime?.close(); } finally { runtime = null; await access?.close(); access = null; } };
    t.after(async () => { try { await close(); } finally { await rm(root, { force: true, recursive: true }); } });
    await mkdir(path.dirname(file), { recursive: true });
    const edit = fn => { const db = new DatabaseSync(dbPath); try { fn(db); } finally { db.close(); } };
    edit(db => {
        db.exec(`PRAGMA user_version=156;
            CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
            CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);
            CREATE TABLE session_managed_mcp_event_display_names(session_id TEXT,event_id TEXT,display_name TEXT,PRIMARY KEY(session_id,event_id));`);
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented selected chat", "general_chat", null, "local");
        if (preservation) db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(otherId, "Invented earlier chat", "general_chat", null, "local");
    });
    const boot = event("boot", "session.start", at(day, 0), { sessionId: sourceId, version: 1 });
    if (causalHooks) Object.assign(boot, { parentId: null, data: { ...boot.data, startTime: boot.timestamp, producer: "invented-client",
        copilotVersion: "1.2.3", context: { cwd: "/invented/work" }, githubMcpToolConfig: { enableAllTools: false } } });
    const hook = event("other-hook", "hook.start", at(day, 1), { hookType: "postToolUse", hookInvocationId: "other-invocation",
        input: { sessionId: sourceId, toolCallId: "other-call", toolName: "other-tool", toolArgs: {},
            toolResult: { content: "x".repeat(TAIL_LIMITS.maxLineBytes + 100) } } }, "boot");
    if (denseHook) hook.data.input.toolResult.parts = Array(40000).fill({ value: 0 });
    await writeFile(file, encode([boot, opaque ? event("opaque", "unknown.kind", at(day, 1),
        { content: "x".repeat(TAIL_LIMITS.maxLineBytes + 100) }, "boot") : hook]));
    if (large) {
        // Distinct, disjoint, fully enveloped hooks across a genuine step boundary.
        for (let i = 1; i < 33; i++) await appendFile(file, encode([{ ...hook, id: `other-hook-${i}`, data: {
            ...hook.data, hookInvocationId: `other-invocation-${i}`, input: { ...hook.data.input, toolCallId: `other-call-${i}` },
        } }]));
    }
    if (disjointTurns) await appendFile(file, encode([
        event("other-request", "external_tool.requested", at(day, 1), { requestId: "request-key", sessionId: sourceId,
            toolCallId: "external-key", toolName: "invented-tool" }, "boot"),
        event("other-finished", "external_tool.completed", at(day, 1), { requestId: "request-key" }, "other-request"),
        event("surface", "session.canvas.recorded", at(day, 1), { extensionId: "extension", canvasId: "canvas", instanceId: "instance" }, "boot"),
        event("surface-removed", "session.canvas.removed", at(day, 1), { extensionId: "extension", canvasId: "canvas", instanceId: "instance" }, "surface"),
        event("plain-hook", "hook.start", at(day, 1), { hookInvocationId: "plain-invocation", hookType: "postToolUse",
            input: { sessionId: sourceId, toolCallId: "plain-hook-call", toolName: "other-tool", toolArgs: {} } }, "boot"),
        event("plain-hook-closed", "hook.end", at(day, 1), { hookInvocationId: "plain-invocation",
            hookType: "postToolUse", success: false }, "plain-hook"),
        event("mode-switch", "session.mode_changed", at(day, 2), { previousMode: "interactive", newMode: "plan" }, "boot"),
        event("permission-notice", "session.permissions_changed", at(day, 3), { previousAllowAllPermissions: false,
            allowAllPermissions: true, previousAllowAllPermissionMode: "off", allowAllPermissionMode: "on" }, "mode-switch"),
        event("mode-notice", "session.mode_notice_delivered", at(day, 4), { mode: "plan", instructionUpdatePersisted: true }, "permission-notice"),
        event("other-turn-open", "assistant.turn_start", at(day, 5), { turnId: "other-turn" }),
        event("other-turn-close", "assistant.turn_end", at(day, 6), { turnId: "other-turn" }),
    ]));
    const known = chain(day, "known", 10, true);
    if (longRequest) known[1].data.content = "Invented discarded reply. ".repeat(1400);
    let knownOriginals = known;
    if (priorNotice) {
        const before = event("before-prompt", "session.info", at(day, 9), { infoType: "timing", message: "Invented timeline notice." }, boot.id);
        known[0].parentId = before.id;
        knownOriginals = [before, ...known];
    }
    if (causalHooks) {
        const [prompt, assistant, start, completion] = known;
        if (anchored) {
            Object.assign(prompt.data, { source: "agent-fixture", turnId: "earlier-turn", transformedContent: "x".repeat(18000) });
            assistant.data.content = "y".repeat(18000);
        }
        const info = event("source-notice", "session.info", prompt.timestamp, { infoType: "timing", message: "Invented private timeline text." }, prompt.id);
        const usage = event("usage-note", "session.usage_checkpoint", prompt.timestamp, { totalNanoAiu: 123 }, info.id);
        const turn = event("request-turn", "assistant.turn_start", assistant.timestamp, { turnId: assistant.data.turnId }, usage.id);
        knownOriginals = withCausalHooks([prompt, { ...assistant, parentId: turn.id }, start, completion], sourceId);
        if (anchored) knownOriginals[5].data.input.serverName = start.data.mcpServerName;
        knownOriginals.splice(1, 0, info, usage, turn);
        knownOriginals.push(event("request-turn-end", "assistant.turn_end", completion.timestamp, { turnId: assistant.data.turnId }, completion.id));
        if (anchored) {
            const [, , priorStart, priorEnd] = chain(day, "prior", 14, true, { literal: true });
            delete priorStart.parentId;
            knownOriginals.push(priorStart, priorEnd);
        }
    }
    const originalBytes = encode([...knownOriginals, ...chain(day, "unknown", 20, undefined),
        ...chain(day, "unfinished", 30, undefined, { finish: false }), ...chain(outside, "unselected", 10, true)]);
    await appendFile(file, causalHooks ? originalBytes.replace('"totalNanoAiu":123', '"totalNanoAiu": 123.0') : originalBytes);
    if (preservation) {
        await mkdir(path.dirname(otherFile));
        await writeFile(otherFile, encode([event("other-boot", "session.start", at(older, 0), { sessionId: otherId, version: 1 }),
            ...chain(older, "erased", 10, true, { literal: true })]));
    }

    // The collector reaches EOF *before* discovery can identify these managed tools.
    const setup = await createCollector(context, { timers: false });
    let frozenFiles;
    try {
        let checked = await setup.configure({ approved: true, enabled: true, appDbPath: dbPath, sessionRoot, windowDays: 7, pollSeconds: 5 });
        for (let i = 0; checked.metrics.backlogBytes && i < 16; i++) checked = await setup.collectNow();
        if (preservation) {
            const state = await loadBoardState(context), reports = createExportController(context);
            assert.deepEqual(ids(state), ["call-erased"]);
            const report = await reports.preview("fixture", undefined, { promptMode: "none", formats: ["json"] },
                { kind: "all", revision: state.revision });
            await reports.review("fixture", report.previewId, true);
            frozenFiles = Object.values((await reports.confirm("fixture", report.previewId, true)).bundle.files);
            assert.ok(frozenFiles.length);
            const deletion = createDeletionController(context);
            const plan = await deletion.preview("fixture", { scope: "range", from: older, to: older, timeContext });
            await deletion.confirm("fixture", { operationId: plan.operationId, confirmed: true });
        }
    }
    finally { await setup.close(); }
    const indexFile = path.join(context.dataDir, "collector", "index.json");
    const index = JSON.parse(await readFile(indexFile));
    const checkpoint = path.join(context.dataDir, "collector", index.fingerprint, `${sourceId}.json`);
    assert.equal(JSON.parse(await readFile(checkpoint)).cursor.offset, (await stat(file)).size);
    assert.deepEqual(ids(await loadBoardState(context)), anchored ? ["call-prior"] : []);
    edit(db => {
        const insert = db.prepare("INSERT INTO session_managed_mcp_event_display_names VALUES(?,?,?)");
        for (const key of ["known", "unknown", "unfinished", "unselected"]) insert.run(sourceId, "start-" + key, "Work IQ");
    });
    const api = async (route, input, capability = panel) => {
        const origin = new URL(runtime.url).origin;
        const r = await fetch(origin + route, { method: input === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json",
            "X-Wire-Session-Protocol": "1", ...(capability && { "X-Board-Capability": capability }) }, body: JSON.stringify(input) });
        return { status: r.status, body: await r.json() };
    };
    const start = async (options = { exactRecords: true }) => {
        await close();
        runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
            createAccess: async () => access = await createCopilotRuntimeAccess(context), ...options });
        panel = (await api("/api/session", {}, null)).body.capability;
        assert.ok(panel);
    };
    return { day, file, otherFile, otherId, context, sourceId, dbPath, checkpoint, indexFile, edit, api, start, frozenFiles,
        config: path.join(context.dataDir, "collector", "config.json"), get url() { return runtime.url; },
        scope: { sourceSessionIds: [sourceId], from: day, to: day, timeContext, restorePrompts: false },
        post: (name, input, capability) => api("/api/recollection/" + name, input, capability) };
}

function assertReview(f, p, omissions = 1) {
    assert.equal(p.mode, mode);
    assert.equal(p.coverage, "day-incomplete");
    assert.deepEqual([p.counts.proposed, p.counts.added, p.counts.excluded, p.counts.unknown], [2, 0, 1, 1]);
    assert.equal(p.omittedRegions, omissions);
    assert.deepEqual(p.exactMembers.map(m => [m.startedAt, m.outcome, m.tool]).sort(), [
        [at(f.day, 12), "succeeded", "workiq-fetch"], [at(f.day, 22), "unknown", "workiq-fetch"],
    ]);
    assert.equal(new Set(p.exactMembers.map(m => m.memberId)).size, 2);
    for (const m of p.exactMembers) assert.match(m.memberId, /^[a-f0-9]{64}$/);
}
function assertReceipt(p, r) {
    assert.equal(r.operationId, p.operationId);
    assert.equal(r.phase, "complete");
    assert.equal(r.mode, mode);
    assert.equal(r.coverage, "day-incomplete");
    assert.deepEqual(r.counts, { ...p.counts, added: 2 });
    assert.equal(r.omittedRegions, p.omittedRegions);
    assert.deepEqual(r.memberIds.toSorted(), p.exactMembers.map(m => m.memberId).sort());
}

test("a bound exact preview reviews only identified members, never the full day", async t => {
    const f = await fixture(t, { longRequest: true, priorNotice: true });
    await f.start();
    const review = ok(await f.post("preview", { ...f.scope, mode }));
    assertReview(f, review);
    assert.doesNotMatch(JSON.stringify(review), /Invented discarded reply/);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("exact preview can finish validating a dense, disjoint hook without changing ordinary collection", async t => {
    const f = await fixture(t, { denseHook: true });
    await f.start();
    assertReview(f, ok(await f.post("preview", { ...f.scope, mode })));
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("a missing mapped call joins the existing agent prompt without rewriting it", async t => {
    const f = await fixture(t, { causalHooks: true, anchored: true });
    await f.start();
    const [prior] = (await loadBoardState(f.context)).evidence;
    assert.equal(prior.userPrompt.authorship.actor, "agent");
    const p = ok(await f.post("preview", { ...f.scope, mode }));
    assert.ok(p.exactMembers.some(m => m.startedAt === at(f.day, 12)));
    assert.deepEqual(ids(await loadBoardState(f.context)), ["call-prior"]);
    const receipt = ok(await f.post("confirm", confirm(p)));
    await f.start();
    assert.deepEqual(ok(await f.post("status", receiptFor(p))), receipt);
    const parent = (await loadBoardState(f.context)).evidence.find(row => row.scenarioId === prior.scenarioId);
    assert.deepEqual(parent.userPrompt, prior.userPrompt);
    assert.deepEqual(parent.toolCalls.find(c => c.toolCallId === "call-prior"), prior.toolCalls[0]);
    assert.equal(parent.toolCalls.find(c => c.toolCallId === "call-known")?.completionEventId, "end-known");
});

test("the reviewed subset and original receipts survive ordinary incremental collection and restart", async t => {
    const f = await fixture(t, { preservation: true, disjointTurns: true, causalHooks: true });
    await f.start();
    // A real, older strict receipt must not acquire the new mode or its membership.
    await appendFile(f.otherFile, encode(chain(f.day, "earlier", 5, true, { literal: true })));
    const strict = ok(await f.post("preview", { ...f.scope, sourceSessionIds: [f.otherId] }));
    assert.equal(strict.counts.newRecords, 1);
    const oldReceipt = ok(await f.post("confirm", { operationId: strict.operationId, confirmed: true }));
    assert.equal(oldReceipt.mode, undefined);
    const before = await loadBoardState(f.context);
    assert.deepEqual(ids(before), ["call-earlier"]);
    assert.ok(before.deletion.identities.length);
    const protectedPaths = [f.config, f.dbPath, ...f.frozenFiles];
    const bytes = files => Promise.all(files.map(file => readFile(file)));
    const preserved = await bytes(protectedPaths), cursors = await bytes([f.indexFile, f.checkpoint]), original = await readFile(f.file);
    const p = ok(await f.post("preview", { ...f.scope, mode }));
    assertReview(f, p);
    assert.deepEqual(await loadBoardState(f.context), before);
    const r = ok(await f.post("confirm", confirm(p)));
    assertReceipt(p, r);
    const exactCalls = state => state.evidence.flatMap(row => row.toolCalls).filter(c => c.recollection?.operationId === p.operationId)
        .sort((a, b) => a.toolCallId.localeCompare(b.toolCallId));
    const committedCalls = exactCalls(await loadBoardState(f.context));
    const stored = async added => {
        const state = await loadBoardState(f.context);
        const expected = ["call-earlier", "call-known", "call-unknown", ...added].sort();
        assert.deepEqual(ids(state), expected);
        const visible = ok(await f.api("/api/state")).scenarios;
        assert.deepEqual(visible.flatMap(row => row.toolCalls.map(c => c.toolCallId)).sort(), expected);
        assert.deepEqual(exactCalls(state), committedCalls, "The original qualified stored calls are not reprojected or downgraded");
        const reviewed = state.evidence.flatMap(row => row.toolCalls.filter(c => c.recollection?.operationId === p.operationId)
            .map(c => [row.sourceSessionId, row.userPrompt.sourceEventId, c.toolCallId, c.startEventId, c.completionEventId, c.reportedOutcome]));
        assert.deepEqual(reviewed.sort(), [
            [f.sourceId, "prompt-known", "call-known", "start-known", "end-known", "succeeded"],
            [f.sourceId, "prompt-unknown", "call-unknown", "start-unknown", "end-unknown", "unknown"],
        ]);
        assert.deepEqual(state.deletion, before.deletion);
        assert.deepEqual(state.exports, before.exports);
        assert.deepEqual(state.recollection.operations[strict.operationId], before.recollection.operations[strict.operationId]);
        assert.deepEqual(Object.keys(state.recollection.operations).sort(), [p.operationId, strict.operationId].sort());
        assert.deepEqual(await bytes(protectedPaths), preserved);
    };
    await stored([]);
    assert.deepEqual((await loadBoardState(f.context)).importCoverage, before.importCoverage,
        "Adding individual records is not a new whole-day coverage assessment");
    assert.deepEqual(await bytes([f.indexFile, f.checkpoint]), cursors);
    assert.deepEqual(await readFile(f.file), original);

    await appendFile(f.file, encode(chain(f.day, "incremental", 60, true, { literal: true })));
    ok(await f.api("/api/collection/now", {}));
    const next = await readFile(f.checkpoint);
    assert.notDeepEqual(next, cursors[1]);
    assert.equal(JSON.parse(next).cursor.offset, (await stat(f.file)).size);
    await stored(["call-incremental"]);
    assert.deepEqual(ok(await f.post("status", receiptFor(p))), r);
    // New port, new access owner, feature OFF and no selected source file: only a
    // receipt read may succeed. A fresh preview/implicit rescan cannot explain it.
    await f.start({});
    await rename(f.file, f.file + ".away");
    assert.equal((await f.post("status", { operationId: p.operationId })).status, 403);
    assert.deepEqual(ok(await f.post("status", receiptFor(p))), r);
    assert.deepEqual(ok(await f.post("status", receiptFor(strict))), oldReceipt);
    await stored(["call-incremental"]);
    await rename(f.file + ".away", f.file);
    await appendFile(f.file, encode(chain(f.day, "after-restart", 70, true, { literal: true })));
    ok(await f.api("/api/collection/now", {}));
    assert.equal(JSON.parse(await readFile(f.checkpoint)).cursor.offset, (await stat(f.file)).size);
    await stored(["call-incremental", "call-after-restart"]);
    assert.deepEqual(ok(await f.post("status", receiptFor(p))), r);
});

test("the server option is the only gate; mode, owner and scope cannot be supplied by another decision", async t => {
    const f = await fixture(t);
    await f.start({});
    assert.notEqual(ok(await f.post("sources", {})).exactRecordsAvailable, true);
    assert.equal((await f.post("preview", { ...f.scope, mode })).status, 403);
    assert.equal((await f.post("preview", { ...f.scope, exactRecords: true, mode })).status, 422);
    await f.start();
    assert.equal(ok(await f.post("sources", {})).exactRecordsAvailable, true);
    for (const extra of [{ restorePrompts: true }, { correctExisting: true }, { to: new Date().toISOString().slice(0, 10) },
        { sourceSessionIds: [f.sourceId, randomUUID()] }, { exactMembers: [] }]) {
        assert.equal((await f.post("preview", { ...f.scope, mode, ...extra })).status, 422);
    }
    const strict = ok(await f.post("preview", f.scope));
    assert.equal(strict.mode, undefined);
    assert.equal(strict.exactMembers, undefined);
    assert.equal((await f.post("confirm", confirm(strict))).status, 409);
    const p = ok(await f.post("preview", { ...f.scope, mode }));
    assertReview(f, p);
    const other = ok(await f.api("/api/session", {}, null)).capability;
    for (const [input, status, owner] of [
        [confirm(p), 409, other], [{ ...confirm(p), confirmed: false }, 422],
        [{ ...confirm(p), memberIds: [] }, 422], [{ operationId: p.operationId, confirmed: true }, 409],
    ]) assert.equal((await f.post("confirm", input, owner)).status, status);
    assert.equal(ok(await f.post("status", receiptFor(p))).phase, "not-started");
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

for (const change of ["cancel", "expiry", "new preview", "replaced file", "replaced database", "changed mapping", "appended bytes", "restart"])
    test(`exact confirmation cannot publish after ${change}`, async t => {
        const f = await fixture(t);
        let clock = Date.now();
        if (change === "expiry") t.mock.method(Date, "now", () => clock);
        await f.start();
        const p = ok(await f.post("preview", { ...f.scope, mode }));
        assertReview(f, p);
        switch (change) {
            case "cancel": ok(await f.post("cancel", { operationId: p.operationId })); break;
            case "expiry": clock = Date.parse(p.expiresAt) + 1; break;
            case "new preview": {
                const other = new Date(Date.parse(at(f.day, 0)) + 86400000).toISOString().slice(0, 10);
                const changed = ok(await f.post("preview", { ...f.scope, mode, from: other, to: other }));
                assert.notEqual(changed.operationId, p.operationId);
                assert.equal(changed.coverage, "day-incomplete");
                assert.deepEqual(changed.exactMembers, []);
                break;
            }
            case "changed mapping":
                f.edit(db => db.prepare("DELETE FROM session_managed_mcp_event_display_names WHERE session_id=? AND event_id=?")
                    .run(f.sourceId, "start-known")); break;
            case "appended bytes": await appendFile(f.file, encode(chain(f.day, "late", 50, true))); break;
            case "restart": await f.start(); break;
            default: {
                const original = change === "replaced file" ? f.file : f.dbPath;
                await copyFile(original, original + ".new");
                await rename(original + ".new", original);
            }
        }
        assert.equal((await f.post("confirm", confirm(p))).status, 409);
        assert.equal(ok(await f.post("status", receiptFor(p))).phase, "not-started");
        assert.deepEqual(ids(await loadBoardState(f.context)), []);
    });

test("sign-out revokes the exact review and sign-in does not replay it; Pause grants no new review", async t => {
    const f = await fixture(t);
    await f.start();
    const p = ok(await f.post("preview", { ...f.scope, mode }));
    const wire = async action => ok(await f.api("/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(),
        generation: ok(await f.api("/api/access/status")).generation }));
    await wire("wire-sign-out");
    for (const [action, input] of [["preview", { ...f.scope, mode }], ["confirm", confirm(p)], ["status", receiptFor(p)]]) {
        assert.equal((await f.post(action, input)).status, 403);
    }
    await wire("wire-sign-in");
    assert.equal((await f.post("confirm", confirm(p))).status, 409);
    assert.equal(ok(await f.post("status", receiptFor(p))).phase, "not-started");
    const next = ok(await f.post("preview", { ...f.scope, mode }));
    const current = ok(await f.api("/api/collection/status", {}));
    ok(await f.api("/api/collection/enabled", { enabled: false, expectedConfigVersion: current.configVersion }));
    for (const [action, input] of [["preview", { ...f.scope, mode }], ["confirm", confirm(next)]]) {
        const r = await f.post(action, input);
        assert.ok([403, 409].includes(r.status), JSON.stringify(r));
    }
    assert.equal(ok(await f.post("status", receiptFor(next))).phase, "not-started");
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("a raw oversized region does not become an omitted hook or a verified empty day", async t => {
    const f = await fixture(t, { opaque: true });
    await f.start();
    const p = await f.post("preview", { ...f.scope, mode });
    assert.equal(p.status, 422, p.body.error);
    assert.equal(p.body.counts, undefined);
    assert.equal(p.body.exactMembers, undefined);
    assert.equal(p.body.operationId, undefined);
    assert.deepEqual(ids(await loadBoardState(f.context)), []);
});

test("the entire exact decision expires when an originating prompt, but neither reviewed call, leaves the approved window", async t => {
    const f = await fixture(t);
    const windowMs = 7 * 86400000;
    let clock = Date.parse(at(f.day, 9)) + windowMs;
    t.mock.method(Date, "now", () => clock);
    await f.start();
    const p = ok(await f.post("preview", { ...f.scope, mode }));
    assertReview(f, p);
    assert.equal(p.scope.since, at(f.day, 9));
    clock += 2; // The first prompt is at +10ms and its call begins at +12ms.
    assert.ok(p.exactMembers.every(m => Date.parse(m.startedAt) >= clock - windowMs));
    const refusal = await f.post("confirm", confirm(p));
    assert.equal(refusal.status, 409);
    assert.deepEqual(refusal.body.recollection, { operationId: p.operationId, outcome: "not-saved" });
    assert.equal(ok(await f.post("status", receiptFor(p))).phase, "not-started");
    const state = await loadBoardState(f.context);
    assert.deepEqual(ids(state), []);
    assert.equal(state.recollection?.operations?.[p.operationId], undefined);
});

test("a multi-step exact preview and separate verification stay bound until the last write", async t => {
    const f = await fixture(t, { large: true });
    const size = (await stat(f.file)).size;
    assert.ok(size > TAIL_LIMITS.cycleBytes && size < TAIL_LIMITS.initialFileBytes);
    await f.start();
    const part = ok(await f.post("preview", { ...f.scope, mode }));
    const step = data => ({ operationId: data.operationId, continuation: data.continuation });
    function checkPart(data, phase) {
        assert.equal(data.operationId, part.operationId);
        assert.equal(data.expiresAt, part.expiresAt);
        assert.equal(data.phase, phase);
        assert.equal(data.mode, mode);
        assert.equal(data.coverage, "day-incomplete");
        assert.equal(data.counts, undefined);
        assert.equal(data.exactMembers, undefined);
        assert.ok(data.progress.bytesRead > 0 && data.progress.bytesRead <= TAIL_LIMITS.cycleBytes);
        assert.ok(data.progress.remainingBytes > 0);
    }
    checkPart(part, "reading");
    assert.equal((await f.post("preview", step(part))).status, 409, "Dropping the mode cannot resume an exact read");
    assert.equal((await f.post("confirm", confirm(part))).status, 409, "A prefix is not a review");
    const p = ok(await f.post("preview", { ...step(part), mode }));
    assert.equal(p.operationId, part.operationId);
    assert.equal(p.expiresAt, part.expiresAt);
    assertReview(f, p, 33);
    assert.ok(p.progress.bytesRead > 0 && p.progress.bytesRead <= TAIL_LIMITS.cycleBytes);
    assert.equal(p.progress.totalBytesRead, part.progress.bytesRead + p.progress.bytesRead);
    assert.ok(p.progress.totalBytesRead >= size && p.progress.totalBytesRead <= 2 * TAIL_LIMITS.cycleBytes);
    assert.equal(ok(await f.post("status", receiptFor(p))).phase, "not-started");
    const verifying = ok(await f.post("confirm", confirm(p)));
    checkPart(verifying, "verifying");
    assert.equal(ok(await f.post("status", receiptFor(p))).phase, "verification-incomplete");
    const before = await loadBoardState(f.context);
    assert.deepEqual(ids(before), []);
    assert.equal(before.recollection?.operations?.[p.operationId], undefined);
    assert.equal((await f.post("confirm", step(verifying))).status, 409);
    const r = ok(await f.post("confirm", { ...step(verifying), mode }));
    assertReceipt(p, r);
    assert.deepEqual(ok(await f.post("status", receiptFor(p))), r);
    assert.deepEqual(ids(await loadBoardState(f.context)), ["call-known", "call-unknown"]);
});

test("the normal panel reports a proved exact refusal without offering to check an uncertain result", async t => {
    const f = await fixture(t);
    await f.start({ exactRecords: true, frontend: "bundled" });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
        const origin = new URL(f.url).origin;
        await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(f.url);
        await page.locator("#workspace[aria-busy=false]").waitFor();
        await navigateMain(page, "settings"); await navigateSettings(page, "data");
        await page.locator("#recollectActivity").click();
        await selectActivityOption(page, "recollectOperation", mode);
        await page.locator("#recollectLoadSources").click();
        await expect(page.locator("#recollectOperation")).toHaveValue(mode);
        await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
        await page.locator("#recollectFrom").fill(f.day);
        const previewed = page.waitForResponse(r => r.url() === `${origin}/api/recollection/preview`);
        await page.locator("#recollectPreview").click();
        const preview = await (await previewed).json();
        assertReview(f, preview);
        // Pause only after the gesture, before its request arrives at the real controller.
        await page.route("**/api/recollection/confirm", async route => {
            const config = ok(await f.api("/api/collection/status", {}));
            ok(await f.api("/api/collection/enabled", { enabled: false, expectedConfigVersion: config.configVersion }));
            await route.continue();
        }, { times: 1 });
        const confirmed = page.waitForResponse(r => r.url() === `${origin}/api/recollection/confirm`);
        await page.locator("#recollectConfirm").click();
        const res = await confirmed, body = await res.json();
        assert.equal(res.status(), 409);
        assert.equal(body.code, "RECOLLECTION_NOT_QUALIFIED");
        assert.deepEqual(body.recollection, { operationId: preview.operationId, outcome: "not-saved" });
        await expect(page.locator("#recollectStatus")).toContainText("Nothing was saved.", { timeout: 1500 });
        await expect(page.locator("#recollectCheck")).toBeHidden();
        assert.equal(ok(await f.post("status", receiptFor(preview))).phase, "not-started");
        assert.deepEqual(ids(await loadBoardState(f.context)), []);
    } finally { await browser.close(); }
});

for (const causalHooks of [false, true]) test(`the normal panel recovers a lost confirmation without replay: ${causalHooks ? "hook-linked" : "direct"} completion`, async t => {
    const f = await fixture(t, { disjointTurns: true, causalHooks });
    await f.start({ exactRecords: true, frontend: "bundled" });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce", timezoneId: "UTC" });
        page.setDefaultTimeout(7000);
        const origin = new URL(f.url).origin, sent = [];
        await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        page.on("request", r => {
            const name = new URL(r.url()).pathname.match(/^\/api\/recollection\/(\w+)$/)?.[1];
            if (name) sent.push([name, r.postDataJSON()]);
        });
        const action = async (control, name, status = 200) => {
            const [r] = await Promise.all([page.waitForResponse(r => r.url() === `${origin}/api/recollection/${name}`),
                page.locator(control).click()]);
            const body = await r.json();
            assert.equal(r.status(), status, body.error);
            return body;
        };
        const open = async () => {
            await page.locator("#workspace[aria-busy=false]").waitFor();
            await navigateMain(page, "settings"); await navigateSettings(page, "data");
            await page.locator("#recollectActivity").click();
        };
        await page.goto(f.url);
        await open();
        const operation = page.locator("#recollectOperation");
        await expect(operation).toHaveValue("strict");
        assert.deepEqual(sent, [], "Opening the chooser does not read the approved source");
        await action("#recollectLoadSources", "sources");
        await page.locator(`#recollectSources input[value="${f.sourceId}"]`).check();
        await page.locator("#recollectFrom").fill(f.day);
        await page.locator("#recollectTo").fill(f.day);
        const strict = await action("#recollectPreview", "preview");
        assert.equal(strict.mode, undefined);
        assert.equal(Object.hasOwn(sent.find(([name]) => name === "preview")[1], "mode"), false);
        await action("#recollectChange", "cancel");
        await selectActivityOption(page, "recollectOperation", mode);
        const otherDay = new Date(Date.parse(at(f.day, 0)) + 86400000).toISOString().slice(0, 10);
        await page.locator("#recollectFrom").fill(otherDay);
        const empty = await action("#recollectPreview", "preview", causalHooks ? 422 : 200);
        if (causalHooks) {
            // The start on the other day cannot authorize inspecting its causal arguments.
            assert.equal(empty.code, "EXACT_EVIDENCE_UNVERIFIED");
            await expect(page.locator("#recollectConfirm")).toBeHidden();
        } else {
            assert.deepEqual(empty.exactMembers, []);
            await expect(page.locator("#recollectExactCounts")).toContainText(/day coverage is incomplete/i);
            await expect(page.locator("#recollectStatus")).toContainText(/does not establish that no calls are missing/i);
            await expect(page.locator("#recollectConfirm")).toBeDisabled();
            await action("#recollectChange", "cancel");
        }
        await page.locator("#recollectFrom").fill(f.day);
        const p = await action("#recollectPreview", "preview");
        assertReview(f, p);
        assert.notEqual(p.operationId, empty.operationId);
        await expect(page.locator("#recollectConfirm")).toHaveText(/add 2 verified calls/i);
        const list = page.locator("#recollectExactMembers li");
        await expect(list).toHaveCount(2);
        for (const m of p.exactMembers) {
            const row = list.filter({ hasText: m.memberId });
            await expect(row).toContainText(m.tool);
            await expect(row).toContainText(m.outcome);
        }
        let committed;
        await page.route("**/api/recollection/confirm", async route => {
            const res = await route.fetch();
            committed = { status: res.status(), body: await res.json() };
            await route.abort("failed"); // The actual server reply is lost only on its way back to the panel.
        });
        await page.locator("#recollectConfirm").click();
        await expect(page.locator("#recollectCheck")).toBeVisible();
        assertReceipt(p, ok(committed));
        await page.reload(); await open();
        await expect(page.locator("#recollectConfirm")).toBeHidden();
        const recovered = await action("#recollectCheck", "status");
        assert.deepEqual(recovered, committed.body);
        await expect(page.locator("#recollectExactCounts")).toBeVisible();
        await expect(page.locator("#recollectExactCounts")).toContainText(/2 added/i);
        await expect(page.locator("#recollectExactCounts")).toContainText(/day coverage is incomplete/i);
        for (const id of recovered.memberIds) await expect(list.filter({ hasText: id })).toBeVisible();
        assert.deepEqual(sent.filter(([name]) => name === "confirm"), [["confirm", confirm(p)]]);
        assert.deepEqual(sent.filter(([name]) => name === "status"), [["status", receiptFor(p)]]);
        assert.deepEqual(sent.filter(([name]) => name === "cancel").map(([, req]) => req.operationId),
            [strict.operationId, ...(causalHooks ? [] : [empty.operationId])]);
        assert.deepEqual(ids(await loadBoardState(f.context)), ["call-known", "call-unknown"]);
    } finally { await browser.close(); }
});

test("the normal CLI exposes a strict-first operation chooser only by explicit opt-in", { timeout: 90000 }, async t => {
    const f = await fixture(t), root = path.dirname(f.context.dataDir);
    const browser = await chromium.launch();
    try {
        for (const enabled of [false, true, false]) {
            const child = fork(new URL("../scripts/start.mjs", import.meta.url),
                ["--development-frontend", "react", "--port", "0", ...(enabled ? ["--verified-record-recovery"] : [])],
                { silent: true, execArgv: [], env: { ...process.env, COPILOT_HOME: root, GH_CONFIG_DIR: path.join(root, "no-profile"),
                    WORKIQ_EVIDENCE_DATA_DIR: f.context.dataDir, LOCALAPPDATA: root } });
            const exited = once(child, "exit"), context = await browser.newContext();
            let timer;
            try {
                const url = await new Promise((resolve, reject) => {
                    let output = "";
                    child.stdout.on("data", bytes => {
                        output += bytes;
                        const ready = /WIRE ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                        if (ready) resolve(ready[1]);
                    });
                    child.once("error", reject);
                    child.once("exit", () => reject(new Error("Normal WIRE startup exited before ready")));
                    timer = setTimeout(() => reject(new Error("Normal WIRE startup timed out")), 15000);
                });
                const origin = new URL(url).origin, calls = [], page = await context.newPage();
                await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
                page.on("request", r => {
                    const match = new URL(r.url()).pathname.match(/^\/api\/recollection\/(\w+)$/);
                    if (match) calls.push(match[1]);
                });
                const status = page.waitForResponse(r => r.url() === origin + "/api/collection/status");
                await page.goto(url + "settings?section=privacy&setting=recollect-activity");
                const col = await (await status).json();
                assert.equal(col.recollection.mode, "new-only");
                assert.equal(col.recollection.exactRecordsAvailable === true, enabled);
                await page.locator("#recollectActivity").click();
                await expect(page.locator("#recollectOperation")).toHaveValue("strict");
                if (enabled) {
                    await expect(page.locator("#recollectOperationChoice")).toBeVisible();
                    await expect(page.locator("#recollectLoadSources")).toBeVisible();
                    await expect(page.locator("#recollectScopeFields")).toBeHidden();
                    await selectActivityOption(page, "recollectOperation", mode);
                    await page.locator("#recollectClose").click();
                    await page.locator("#recollectActivity").click();
                    await expect(page.locator("#recollectOperation")).toHaveValue("strict");
                    assert.deepEqual(calls, []);
                } else {
                    await expect(page.locator(`#recollectSources input[value="${f.sourceId}"]`)).toBeVisible();
                    await expect(page.locator("#recollectOperationChoice")).toBeHidden();
                    assert.deepEqual(calls, ["sources"]);
                }
            } finally {
                clearTimeout(timer);
                await context.close();
                if (child.connected) child.disconnect();
                const killTimer = setTimeout(() => child.kill(), 10000);
                try { assert.equal((await exited)[0], 0); } finally { clearTimeout(killTimer); }
            }
        }
    } finally { await browser.close(); }
});
