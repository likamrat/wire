import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createCollector } from "../lib/collector.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { discoverSources } from "../lib/source-discovery.mjs";

const execute = promisify(execFile);
const distro = process.env.WIRE_WSL_DISTRO, node = process.env.WIRE_WSL_NODE, source = process.env.WIRE_WSL_SOURCE;
assert.equal(process.platform, "win32", "Run this opt-in qualification from Windows against native WSL.");
assert.ok(distro && node?.startsWith("/") && source?.startsWith("/"));
const nativePath = async file => (await execute("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", file])).stdout.trim();

async function setup(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-source-reader-")), nonce = randomUUID();
    const sessionId = randomUUID(), context = { dataDir: path.join(root, "data") };
    const config = { appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    await writeFile(path.join(root, "fixture.json"), JSON.stringify({ nonce }));
    const directory = path.join(config.sessionRoot, sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, "source.json"), JSON.stringify(config));
    const db = new DatabaseSync(config.appDbPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT)");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sessionId, "Invented shared input", "chat", null, "local");
    const initial = [{ type: "session.start", data: { sessionId, version: 1 } }, ...interaction("one")];
    await writeFile(path.join(directory, "events.jsonl"), initial.map(envelope).map(event => JSON.stringify(event) + "\n").join(""));
    const nativeRoot = await nativePath(root), windowsNode = await nativePath(path.dirname(process.execPath));
    const native = async (action, dataDir = "") => {
        const result = await execute("wsl.exe", ["--distribution", distro, "--exec", "env", "-i",
            `HOME=${nativeRoot}/empty-home`, `PATH=/usr/bin:/bin:${windowsNode}`, "LANG=C.UTF-8",
            `GH_CONFIG_DIR=${nativeRoot}/no-profile`, `COPILOT_HOME=${nativeRoot}/no-copilot`,
            node, `${source}/tests/wsl-portability-fixture.mjs`, action, nativeRoot, nonce, dataDir],
        { timeout: 30000, maxBuffer: 1024 * 1024 });
        const value = JSON.parse(result.stdout.trim());
        assert.equal(value.platform, "linux");
        return value;
    };
    let collector, linuxData;
    t.after(async () => {
        await collector?.close();
        if (linuxData) await native("cleanup", linuxData);
        db.close(); await rm(root, { recursive: true, force: true });
    });
    collector = await createCollector(context, { timers: false });
    await collector.configure(config);
    linuxData = (await native("init")).dataDir;
    return { root, context, config, db, sessionId, directory, collector, native, linuxData,
        closeWindows: async () => { await collector.close(); collector = null; } };
}
function envelope(event, position) {
    return { ...event, id: randomUUID(), timestamp: new Date(Date.now() - 1000 + position).toISOString() };
}
function interaction(id) {
    return [
        { type: "user.message", data: { source: "user", content: `Invented source request ${id}.` } },
        { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: id, arguments: { entityUrls: ["/me/messages"] } } },
        { type: "tool.execution_complete", data: { toolCallId: id, success: true } },
    ];
}

test("independent Windows and WSL instances consume one live Windows WAL source, restart and append without sharing state", async t => {
    const app = await setup(t);
    assert.equal((await discoverSources(app.config)).counts.eligible, 1);
    await app.collector.collectNow();
    const first = await app.native("collect", app.linuxData);
    assert.equal(first.status, 200);
    assert.equal(first.records, 1);
    assert.deepEqual(first.sessions, [app.sessionId]);
    assert.equal(first.owner.platform, "linux");
    assert.equal(first.indexVersion, 3);
    const windowsIndex = JSON.parse(await readFile(path.join(app.context.dataDir, "collector/index.json"), "utf8"));
    assert.equal(windowsIndex.ownerHost.platform, "win32");
    assert.equal(windowsIndex.schemaVersion, 3);
    assert.notEqual(windowsIndex.sources[app.sessionId].cursor.identity, first.cursors[0]);
    const again = await app.native("collect", app.linuxData);
    assert.equal(again.records, 1);
    assert.deepEqual(again.cursors, first.cursors);
    await appendFile(path.join(app.directory, "events.jsonl"), interaction("two").map(envelope).map(event => JSON.stringify(event) + "\n").join(""));
    assert.equal((await app.native("collect", app.linuxData)).records, 2);
    assert.equal((await loadBoardState(app.context, { readOnly: true })).evidence.length, 1);
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context, { readOnly: true })).evidence.length, 2);
});

test("source-native failure preserves existing WSL evidence and cursors without a fallback read", async t => {
    const app = await setup(t);
    const before = await app.native("collect", app.linuxData);
    app.db.exec("PRAGMA user_version=155");
    const after = await app.native("collect", app.linuxData);
    assert.equal(after.status, 422);
    assert.equal(after.code, "source_mapping_unsupported");
    assert.equal(after.stateHash, before.stateHash);
    assert.equal(after.indexHash, before.indexHash);
    assert.equal(after.records, 1);
});

test("independent instances cannot take a live foreign store or adopt its released cursors", async t => {
    const app = await setup(t);
    await app.collector.collectNow();
    const indexFile = path.join(app.context.dataDir, "collector/index.json"), before = await readFile(indexFile);
    const target = await nativePath(app.context.dataDir);
    assert.equal((await app.native("foreign", target)).refused, "COLLECTOR_OWNER_FOREIGN");
    await app.closeWindows();
    assert.equal((await app.native("foreign", target)).refused, "source_store_foreign");
    assert.deepEqual(await readFile(indexFile), before);
    const legacy = JSON.parse(before);
    delete legacy.ownerHost;
    legacy.schemaVersion = 2;
    await writeFile(indexFile, JSON.stringify(legacy));
    const legacyBytes = await readFile(indexFile);
    assert.equal((await app.native("foreign", target)).refused, "source_store_foreign");
    assert.deepEqual(await readFile(indexFile), legacyBytes);
});
