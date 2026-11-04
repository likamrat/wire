import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { extractGraphActivities } from "../lib/graph-history.mjs";
import { migratePrivateData } from "../lib/migration.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { createHash } from "node:crypto";

const all = { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } };

test("preview, status and cancellation leave every private file byte unchanged", async t => {
    const { context } = await privateFixture(t);
    const inventory = async () => {
        const entries = await readdir(context.dataDir, { recursive: true, withFileTypes: true });
        const result = {};
        for (const entry of entries.filter(entry => entry.isFile())) {
            const file = path.join(entry.parentPath, entry.name);
            result[path.relative(context.dataDir, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
        }
        return result;
    };
    const before = await inventory(), controller = createDeletionController(context);
    const preview = await controller.preview("panel", all);
    assert.equal((await controller.status(preview.operationId)).phase, "not-started");
    controller.cancel("panel", preview.operationId);
    await controller.preview("panel", { scope: "range", from: "2026-09-30", to: "2026-09-30", timeContext: all.timeContext });
    assert.deepEqual(await inventory(), before);
});

test("confirmed all deletion purges local evidence and review copies and suppresses reimport, not new calls", async t => {
    const original = fixture();
    const { context } = await privateFixture(t, [original]);
    const before = await loadBoardState(context);
    const deletion = createDeletionController(context);
    const preview = await deletion.preview("panel", all);
    assert.equal(preview.counts.records, 1);
    assert.equal((await loadBoardState(context)).evidence.length, 1, "Preview cannot delete");
    const result = await deletion.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, []);
    assert.deepEqual(after.cards, {});
    assert.equal(after.pseudonymKey, before.pseudonymKey);
    assert.deepEqual(after.exports, before.exports);
    const snapshots = await readdir(path.join(context.dataDir, "private-evidence"));
    for (const name of snapshots) assert.doesNotMatch(await readFile(path.join(context.dataDir, "private-evidence", name), "utf8"), /SYNTHETIC_PRIVATE/);
    await replaceEvidence(context, () => ({ records: [original, fixture("new-call")] }));
    assert.deepEqual((await loadBoardState(context)).evidence.map(s => s.scenarioId), ["new-call"]);
    assert.doesNotMatch(JSON.stringify((await loadBoardState(context)).deletion), /SYNTHETIC_PRIVATE|entityUrls/);
});

test("range deletion respects each Graph/HTTP start and removes stale report approval while saved copies stay frozen", async t => {
    const source = { sessionId: "graph-source" };
    const events = [
        { id: "p", type: "user.message", timestamp: "2026-09-28T00:00:00Z", data: { content: "SYNTHETIC_GRAPH_秘密" } },
        { id: "g1", type: "tool.execution_start", timestamp: "2026-09-29T12:00:00Z", data: { toolCallId: "g1", toolName: "powershell", arguments: { command: "curl 'https://graph.microsoft.com/v1.0/me/messages'" } } },
        { id: "g2", type: "tool.execution_start", timestamp: "2026-09-30T12:00:00Z", data: { toolCallId: "g2", toolName: "powershell", arguments: { command: "curl 'https://graph.microsoft.com/v1.0/me/events'" } } },
        { id: "g3", type: "tool.execution_start", timestamp: "2026-09-30T13:00:00Z", data: { toolCallId: "g3", toolName: "powershell", arguments: { command: "git diff # https://graph.microsoft.com/v1.0/me/messages" } } },
    ];
    const graph = extractGraphActivities(events, source).scenarios[0];
    const http = { ...fixture("http"), capturedAt: "2026-09-28T00:00:00Z", toolCalls: [{ tool: "owned-graph-http" }], httpRecords: [
        { recordId: "h1", startedAt: "2026-09-30T01:00:00Z" }, { recordId: "h2", startedAt: "2026-10-01T00:00:00Z" },
    ] };
    const work = fixture("work");
    work.toolCalls[0].startedAt = "2026-09-30T02:00:00Z";
    const { context } = await privateFixture(t, [graph, http, work]);
    const exports = createExportController(context);
    const selection = () => ({ kind: "selected", scenarioIds: ["work"] });
    let state = await loadBoardState(context);
    const saved = await exports.preview("report-panel", undefined, { promptMode: "none", formats: ["html"] }, { ...selection(), revision: state.revision });
    await exports.review("report-panel", saved.previewId, true);
    const written = await exports.confirm("report-panel", saved.previewId, true);
    const savedBytes = await readFile(written.bundle.files["product-report.html"]);
    state = await loadBoardState(context);
    const stale = await exports.preview("stale-panel", undefined, { promptMode: "none", formats: ["html"] }, { ...selection(), revision: state.revision });
    await exports.review("stale-panel", stale.previewId, true);
    const controller = createDeletionController(context);
    const preview = await controller.preview("delete-panel", { scope: "range", from: "2026-09-30", to: "2026-09-30", timeContext: all.timeContext });
    assert.equal(preview.counts.records, 4);
    assert.equal(preview.counts.graphRecords, 2);
    assert.equal(preview.counts.diagnostics, 1);
    await controller.confirm("delete-panel", { operationId: preview.operationId, confirmed: true });
    const remaining = (await loadBoardState(context)).evidence;
    assert.deepEqual(remaining.find(row => row.scenarioId === graph.scenarioId).graphActivities, [graph.graphActivities[0]]);
    assert.deepEqual(remaining.find(row => row.scenarioId === "http").httpRecords, [http.httpRecords[1]]);
    await assert.rejects(exports.confirm("stale-panel", stale.previewId, true), /changed/);
    assert.deepEqual(await readFile(written.bundle.files["product-report.html"]), savedBytes);
    assert.equal((await loadBoardState(context)).exports.length, 1);
});

test("managed immutable migration copies are sanitized, not external migration source or report files", async t => {
    const { root, context: source } = await privateFixture(t);
    const imports = path.join(root, "inputs");
    await mkdir(imports);
    await writeFile(path.join(imports, "app-inventory.json"), "[]");
    await writeFile(path.join(imports, "history-window.json"), '{"windowDays":30}');
    const migrated = await migratePrivateData({ source: source.dataDir, destination: path.join(root, "maintained"),
        importFiles: imports, sessionRoot: root, appDbPath: path.join(root, "external.db") });
    const context = { dataDir: migrated.destination };
    const oldBytes = await readFile(path.join(source.dataDir, `${BOARD_ID}.state.json`));
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", all);
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.deepEqual(await readFile(path.join(source.dataDir, `${BOARD_ID}.state.json`)), oldBytes, "Never follow a migration manifest's external source path");
    const backup = await loadBoardState({ dataDir: migrated.backup });
    assert.deepEqual(backup.evidence, []);
    assert.deepEqual(backup.cards, {});
    const files = await readdir(path.join(migrated.backup, "private-evidence"));
    for (const name of files) assert.doesNotMatch(await readFile(path.join(migrated.backup, "private-evidence", name), "utf8"), /SYNTHETIC_PRIVATE/);
});

test("sealed crash fails closed and restart completes only the original identities and file hashes", async t => {
    const { context } = await privateFixture(t);
    const controller = createDeletionController(context, { afterSeal: () => { throw new Error("SIMULATED_CRASH"); } });
    const preview = await controller.preview("panel", all);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /SIMULATED_CRASH/);
    assert.equal((await controller.status(preview.operationId)).phase, "pending");
    await assert.rejects(loadBoardState(context), /incomplete/);
    await assert.rejects(replaceEvidence(context, () => ({ records: [fixture("blocked")] })), /incomplete/);
    const restarted = createDeletionController(context);
    await restarted.recover();
    assert.equal((await restarted.status(preview.operationId)).phase, "complete");
    assert.deepEqual((await loadBoardState(context)).evidence, []);
    await restarted.recover();
    await replaceEvidence(context, () => ({ records: [fixture("new")] }));
    assert.equal((await loadBoardState(context)).evidence.length, 1);
    assert.equal((await restarted.confirm("panel", { operationId: preview.operationId, confirmed: true })).phase, "complete");
    assert.equal((await loadBoardState(context)).evidence.length, 1, "Duplicate confirmation only reads its durable result");
});

test("invalid, reversed, future-empty and missing timestamps never silently become all; previews expire", async t => {
    const { context } = await privateFixture(t);
    let now = Date.now();
    const controller = createDeletionController(context, { now: () => now });
    for (const scope of [
        { scope: "range" }, { scope: "range", from: "2026-02-30", to: "2026-03-01" },
        { scope: "range", from: "2026-10-02", to: "2026-10-01" },
        { scope: "all", from: "2026-10-01" },
    ]) await assert.rejects(controller.preview("panel", { ...scope, timeContext: all.timeContext }), { status: 422 });
    const empty = await controller.preview("panel", { scope: "range", from: "2099-01-01", to: "2099-01-02", timeContext: all.timeContext });
    assert.equal(empty.counts.records, 0);
    await assert.rejects(controller.confirm("panel", { operationId: empty.operationId, confirmed: true }), /No collected records/);
    const preview = await controller.preview("panel", all);
    now += 120001;
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /expired/);
    assert.equal((await loadBoardState(context)).evidence.length, 1);
});

test("deletion rejects a linked private directory rather than touching an external file", async t => {
    const { context, root } = await privateFixture(t);
    const external = path.join(root, "external");
    await mkdir(external);
    const target = path.join(external, "record.json");
    await writeFile(target, '{"recordId":"external"}');
    await symlink(external, path.join(context.dataDir, "http-records"), "junction");
    await assert.rejects(createDeletionController(context).preview("panel", all), /linked/);
    assert.equal(await readFile(target, "utf8"), '{"recordId":"external"}');
});

test("HTTP deletion is panel-bound, stale-safe, explicit, and status never replays a mutation", async t => {
    const { context } = await privateFixture(t);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const origin = runtime.url.slice(0, -1);
    const connect = async () => (await (await fetch(origin + "/api/session", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" })).json()).capability;
    const one = await connect(), two = await connect();
    const request = async (capability, endpoint, input) => {
        const response = await fetch(origin + "/api/deletion/" + endpoint, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
    const preview = await request(one, "preview", all);
    assert.equal(preview.status, 200);
    assert.equal((await request(two, "confirm", { operationId: preview.body.operationId, confirmed: true })).status, 409);
    assert.equal((await request(one, "confirm", { operationId: preview.body.operationId, confirmed: false })).status, 422);
    const cancelled = (await request(one, "preview", all)).body;
    await request(one, "cancel", { operationId: cancelled.operationId });
    assert.equal((await request(one, "confirm", { operationId: cancelled.operationId, confirmed: true })).status, 409);
    await replaceEvidence(context, () => ({ records: [fixture(), fixture("added")] }));
    assert.equal((await request(one, "confirm", { operationId: preview.body.operationId, confirmed: true })).status, 409);
    assert.equal((await loadBoardState(context)).evidence.length, 2);
    const fresh = (await request(one, "preview", all)).body;
    assert.equal((await request(one, "confirm", { operationId: fresh.operationId, confirmed: true })).body.phase, "complete");
    assert.equal((await request(two, "status", { operationId: fresh.operationId })).body.phase, "complete", "An unguessable operation receipt can be read after reconnect");
    assert.equal((await request(two, "confirm", { operationId: fresh.operationId, confirmed: true })).status, 403);
    assert.equal((await request(one, "confirm", { operationId: fresh.operationId, confirmed: true })).body.phase, "complete");
    assert.equal((await request(one, "preview", { ...all, path: ".." })).status, 422);
    assert.equal((await request("unauthorized", "preview", all)).status, 403);
});

test("queued confirmation is not reported as not-started and duplicate dispatch never creates a second operation", async t => {
    const { context } = await privateFixture(t);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const controller = createDeletionController(context, { coordinateRecorder: async work => { entered(); await gate; return work(); } });
    const preview = await controller.preview("panel", all);
    const pending = controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    await waiting;
    assert.equal((await controller.status(preview.operationId)).phase, "in-progress");
    assert.equal((await controller.confirm("panel", { operationId: preview.operationId, confirmed: true })).phase, "in-progress");
    assert.equal((await loadBoardState(context)).evidence.length, 1);
    release();
    assert.equal((await pending).phase, "complete");
    assert.equal(Object.keys((await loadBoardState(context)).deletion.operations).length, 1);
});

test("a sealed cleanup rejects changed files instead of claiming partial success or broadening recovery", async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const snapshot = path.join(context.dataDir, "private-evidence", before.evidenceFile);
    const original = await readFile(snapshot);
    const controller = createDeletionController(context, { afterSeal: async () => { await writeFile(snapshot, '{"changed":"UNRELATED_BYTES"}'); } });
    const preview = await controller.preview("panel", all);
    await assert.rejects(controller.confirm("panel", { operationId: preview.operationId, confirmed: true }), /changed/);
    assert.equal((await controller.status(preview.operationId)).phase, "pending");
    await assert.rejects(createDeletionController(context).recover(), /changed/);
    assert.equal(await readFile(snapshot, "utf8"), '{"changed":"UNRELATED_BYTES"}');
    await writeFile(snapshot, original);
    await createDeletionController(context).recover();
    assert.deepEqual((await loadBoardState(context)).evidence, []);
});

test("deletion removes historical recovery and diagnostic copies and checkpoints without touching saved report bytes", async t => {
    const original = fixture("historical");
    const { context } = await privateFixture(t, [original]);
    await replaceEvidence(context, () => ({ records: [fixture("active")] }));
    const checkpointDir = path.join(context.dataDir, "collector", "a".repeat(64));
    await mkdir(checkpointDir, { recursive: true });
    const checkpoint = path.join(checkpointDir, "test-session.json");
    const events = [{ id: "private-prompt", type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "DELETE_CONTEXT_秘密" } }];
    await writeFile(checkpoint, JSON.stringify({ schemaVersion: 1, cursor: { offset: 123 }, events }));
    const before = await loadBoardState(context);
    await writeFile(path.join(context.dataDir, "prior-state.snapshot.json"), JSON.stringify(before));
    await mkdir(path.join(context.dataDir, "http-records"));
    await writeFile(path.join(context.dataDir, "http-records", "orphan.json"), JSON.stringify({ recordId: "orphan", startedAt: "2026-09-30T12:00:00Z", synthetic: true }));
    const saved = path.join(context.dataDir, "exports", "saved.html");
    await writeFile(saved, "FROZEN_SAVED_REPORT_秘密");
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", all);
    assert.equal(preview.counts.records, 3, "Active, retained-only historical, and orphan diagnostic count once");
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(await readFile(saved, "utf8"), "FROZEN_SAVED_REPORT_秘密");
    const recovery = JSON.parse(await readFile(path.join(context.dataDir, "prior-state.snapshot.json")));
    assert.deepEqual(recovery.cards, {});
    assert.notEqual(recovery.evidenceFile, before.evidenceFile);
    assert.deepEqual(await readdir(path.join(context.dataDir, "http-records")), []);
    const clean = JSON.parse(await readFile(checkpoint));
    assert.deepEqual(clean.events, []);
    assert.deepEqual(clean.cursor, { offset: 123 });
    await replaceEvidence(context, () => ({ records: [original] }));
    assert.deepEqual((await loadBoardState(context)).evidence, [], "An obsolete snapshot cannot resurrect its old-only record");
});

test("date deletion uses inclusive civil days, canonical aliases and exact calls in spanning groups", async t => {
    const record = fixture("spanning");
    record.toolCalls = [
        { ...record.toolCalls[0], toolCallId: "keep", startEventId: "keep-start", startedAt: "2026-11-01T06:59:59.999Z" },
        { ...record.toolCalls[0], toolCallId: "remove", startEventId: "remove-start", startedAt: "2026-11-02T07:59:59.999Z" },
        { ...record.toolCalls[0], toolCallId: "later", startEventId: "later-start", startedAt: "2026-11-02T08:00:00.000Z" },
        { ...record.toolCalls[0], toolCallId: "unknown", startEventId: "unknown-start", startedAt: "not-a-date" },
    ];
    const alias = { ...record, scenarioId: "legacy-copy", isLegacy: true, toolCalls: [
        { ...record.toolCalls[1], toolCallId: undefined, startedAt: "2026-10-31T10:00:00.000Z" },
    ] };
    const { context } = await privateFixture(t, [record, alias]);
    const deletion = createDeletionController(context);
    const preview = await deletion.preview("panel", { scope: "range", from: "2026-11-01", to: "2026-11-01", timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" } });
    assert.equal(preview.counts.records, 1);
    assert.equal(preview.counts.requestGroups, 2, "All aliases are included even if an older copy has a conflicting date");
    assert.equal(preview.counts.partialGroups, 1);
    assert.equal(preview.scope.bounds.from, "2026-11-01T07:00:00.000Z");
    assert.equal(preview.scope.bounds.to, "2026-11-02T08:00:00.000Z", "25-hour DST day");
    await deletion.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const remaining = (await loadBoardState(context)).evidence;
    assert.equal(remaining.length, 1);
    assert.deepEqual(remaining[0].toolCalls, [record.toolCalls[0], record.toolCalls[2], record.toolCalls[3]]);
});

test("partial deletion preserves a recovery state's surviving group even when an older snapshot loses that entire group", async t => {
    const record = fixture("shared");
    record.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    const { context } = await privateFixture(t, [record]);
    const retained = { ...record.toolCalls[0], toolCallId: "keep", startEventId: "keep", startedAt: "2026-10-01T12:00:00Z" };
    await replaceEvidence(context, () => ({ records: [{ ...record, toolCalls: [...record.toolCalls, retained] }] }));
    const state = await loadBoardState(context);
    const backup = path.join(context.dataDir, "prior-state.snapshot.json");
    await writeFile(backup, JSON.stringify(state));
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", { scope: "range", from: "2026-09-30", to: "2026-09-30", timeContext: all.timeContext });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const recovery = JSON.parse(await readFile(backup));
    const snapshot = JSON.parse(await readFile(path.join(context.dataDir, "private-evidence", recovery.evidenceFile)));
    assert.deepEqual(snapshot.records[0].toolCalls, [retained]);
    assert.deepEqual(recovery.cards.shared, state.cards.shared);
});

test("surviving Graph evidence drops references to deleted Work IQ calls without changing its request metadata", async t => {
    const work = fixture("prior-work");
    work.toolCalls[0].startedAt = "2026-09-30T23:59:00Z";
    const graph = extractGraphActivities([
        { id: "g", type: "tool.execution_start", timestamp: "2026-10-01T00:01:00Z", data: { toolCallId: "g", toolName: "powershell", arguments: { command: "curl 'https://graph.microsoft.com/v1.0/me/messages'" } } },
    ], { sessionId: work.sourceSessionId }).scenarios[0];
    graph.graphActivities[0].fallback = { association: "same-prompt-after-failure", precedingWorkIqCallIds: [work.toolCalls[0].toolCallId], causeProven: false };
    const { context } = await privateFixture(t, [work, graph]);
    const controller = createDeletionController(context);
    const preview = await controller.preview("panel", { scope: "range", from: "2026-09-30", to: "2026-09-30", timeContext: all.timeContext });
    await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    const remaining = (await loadBoardState(context)).evidence[0].graphActivities[0];
    assert.deepEqual(remaining.fallback, { association: "none", precedingWorkIqCallIds: [], causeProven: false });
    assert.deepEqual(remaining.endpoint, graph.graphActivities[0].endpoint);
    assert.equal(remaining.startedAt, graph.graphActivities[0].startedAt);
});
