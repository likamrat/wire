import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { collectorFor } from "../lib/collector.mjs";

export async function recollectionFixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-recollection-"));
    const context = { dataDir: path.join(root, "private") };
    const dbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    const sourceId = randomUUID(), otherSourceId = randomUUID();
    const firstDay = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const secondDay = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const event = (id, type, day, data) => ({ id, type, timestamp: `${day}T12:00:00.000Z`, data });
    const calls = (id, day) => [
        event(`prompt-${id}`, "user.message", day, { content: `Synthetic request ${id}` }),
        event(`start-${id}`, "tool.execution_start", day, { toolCallId: id, toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", arguments: { entityUrls: ["/me/messages"] } }),
        { ...event(`end-${id}`, "tool.execution_complete", day, { toolCallId: id, success: true }), timestamp: `${day}T12:00:01.000Z` },
    ];
    const files = [];
    for (const [id, name, events] of [[sourceId, "Recollection selected chat", [...calls("selected-A", firstDay), ...calls("outside-B", secondDay)]],
        [otherSourceId, "Recollection other chat", calls("outside-C", firstDay)]]) {
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, name, "chat", null, "local");
        const file = path.join(sessionRoot, id, "events.jsonl");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, [event(`startup-${id}`, "session.start", firstDay, { sessionId: id, version: 1 }), ...events].map(row => JSON.stringify(row) + "\n").join(""));
        files.push(file);
    }
    db.close();
    let runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    await collectorFor(context).configure({ appDbPath: dbPath, sessionRoot, approved: true, enabled: false, windowDays: 7, pollSeconds: 5 });
    await collectorFor(context).collectNow();
    let closeClient;
    t.after(async () => {
        try { await closeClient?.(); }
        finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
    });
    return { context, root, dbPath, files, sourceId, otherSourceId, firstDay, secondDay,
        closeClient(close) { closeClient = close; },
        get runtime() { return runtime; },
        get collector() { return collectorFor(context); },
        async stop() {
            await runtime?.close();
            runtime = null;
        },
        async restart() {
            await runtime?.close();
            runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
        },
    };
}
