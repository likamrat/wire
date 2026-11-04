import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateFixture } from "./helpers.mjs";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

export async function collectedResultFixture(t, completion) {
    const cleanup = [], { root, context } = await privateFixture({ after: fn => cleanup.push(fn) }, []);
    const sourceId = randomUUID(), appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented result evidence", "chat", null, "local");
    await mkdir(path.join(sessionRoot, sourceId), { recursive: true });
    const file = path.join(sessionRoot, sourceId, "events.jsonl"), now = Date.now() - 5000;
    const event = (id, type, data, ms) => ({ id, type, data, timestamp: new Date(now + ms).toISOString() });
    await writeFile(file, [
        event("session", "session.start", { sessionId: sourceId, version: 1 }, 0),
        event("prompt", "user.message", { content: "Inspect the invented task." }, 1),
        event("start", "tool.execution_start", { toolName: "workiq-fetch", toolCallId: "result-call",
            arguments: { entityUrls: ["/planner/tasks/invented-task"] } }, 2),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    let collector = await createCollector(context, { timers: false }), runtime, providerCalls = 0;
    t.after(async () => {
        if (runtime) await runtime.close(); else await collector.close();
        db.close(); for (const fn of cleanup) await fn();
        assert.equal(providerCalls, 0);
    });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: false, windowDays: 30, pollSeconds: 5 });
    await collector.collectNow();
    await collector.close();
    collector = await createCollector(context, { timers: false });
    await appendFile(file, [
        event("completion", "tool.execution_complete", { toolCallId: "result-call", ...completion }, 1002),
        event("reply", "assistant.message", { content: "EXCLUDED_ASSISTANT_REPLY" }, 1003),
    ].map(value => JSON.stringify(value) + "\n").join(""));
    const sourceBefore = await readFile(file);
    await collector.collectNow();
    const state = await loadBoardState(context), record = state.evidence[0];
    assert.equal(state.personalEvaluation, undefined);
    assert.equal(record.toolCalls[0].completionEventId, "completion");
    const index = JSON.parse(await readFile(path.join(context.dataDir, "collector", "index.json"), "utf8"));
    const checkpoint = await readFile(path.join(context.dataDir, "collector", index.fingerprint, sourceId + ".json"), "utf8");
    assert.doesNotMatch(checkpoint, /EXCLUDED_/);
    await collector.close();
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providerCalls++; throw Error("Provider work is not permitted in retained-result proof."); },
            readSource: async () => { providerCalls++; throw Error("No evaluator source reads."); } } });
    return { root, context, runtime, record, checkpoint, unchanged: async () => {
        assert.deepEqual(await readFile(file), sourceBefore);
        assert.deepEqual((await loadBoardState(context)).evidence, state.evidence);
    } };
}
