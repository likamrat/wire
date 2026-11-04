import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readMetadataProjection, validateMetadataProjection, SOURCE_METADATA_MAX_BYTES } from "../lib/source-metadata.mjs";
import { readSourceMetadata } from "../lib/source-reader.mjs";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-source-reader-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "data.db"), db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT)");
    db.exec("INSERT INTO sessions VALUES('00000000-0000-4000-8000-000000000001','Invented','chat',NULL,'local')");
    db.close();
    const files = { databaseFile: () => file, assertCurrent() {}, windowsDatabase: "C:\\owned\\data.db" };
    const projection = readMetadataProjection(file);
    const calls = [];
    const run = async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "wslpath") return { stdout: "C:\\owned\\read-copilot-metadata.mjs\n" };
        assert.equal(command, "node.exe");
        assert.deepEqual(args, ["C:\\owned\\read-copilot-metadata.mjs", files.windowsDatabase]);
        assert.equal(options.timeout, 5000);
        assert.equal(options.maxBuffer, SOURCE_METADATA_MAX_BYTES);
        assert.ok(Object.keys(options.env).every(key =>
            ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "LANG", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"].includes(key)));
        return { stdout: JSON.stringify({ schemaVersion: 1, platform: "win32", projection }) };
    };
    return { file, files, projection, calls, run };
}

test("native and source-native readers use the same fixed projection contract and stamp", async t => {
    const app = await fixture(t);
    const native = await readSourceMetadata({ ...app.files, windowsDatabase: null });
    const hosted = await readSourceMetadata(app.files, { run: app.run });
    assert.deepEqual(hosted.counts, native.counts);
    assert.equal(hosted.roster[0].sessionId, native.roster[0].sessionId);
    assert.equal(hosted.roster[0].eligible, true);
    assert.equal(hosted.metadataStamp, native.metadataStamp);
    assert.deepEqual(app.calls.map(call => call.command), ["wslpath", "node.exe"]);
});

test("a pending source-native read yields to freshness work and rechecks access afterward", async t => {
    const app = await fixture(t);
    let ticks = 0, current = true;
    const timer = setInterval(() => { ticks++; current = false; }, 5);
    t.after(() => clearInterval(timer));
    app.files.assertCurrent = () => {
        if (!current) throw Object.assign(new Error("Source access changed."), { code: "test_source_revoked" });
    };
    await assert.rejects(readSourceMetadata(app.files, { run: async (...args) => {
        if (args[0] === "node.exe") await delay(50);
        return app.run(...args);
    } }), { code: "test_source_revoked" });
    assert.ok(ticks > 0, "The helper must not block the event loop.");
});

test("source changes during the metadata read invalidate its stamp before publication", async t => {
    const app = await fixture(t);
    await assert.rejects(readSourceMetadata(app.files, { run: async (...args) => {
        const result = await app.run(...args);
        if (args[0] === "node.exe") await writeFile(app.file, "Invented changed source.");
        return result;
    } }), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
});

test("helper timeout, missing runtime, excessive output and unsuccessful exit never fall back to local SQLite", async t => {
    const app = await fixture(t);
    for (const error of [
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        Object.assign(new Error("timeout"), { killed: true }),
        Object.assign(new Error("output limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
        Object.assign(new Error("failed after output"), { code: 1,
            stdout: JSON.stringify({ schemaVersion: 1, platform: "win32", projection: app.projection }) }),
    ]) {
        const calls = [];
        await assert.rejects(readSourceMetadata(app.files, { run: async (...args) => {
            calls.push(args[0]);
            if (args[0] === "node.exe") throw error;
            return app.run(...args);
        } }), { code: "source_reader_unavailable" });
        assert.deepEqual(calls, ["wslpath", "node.exe"]);
    }
});

test("malformed, wrong-host and inconsistent projections are refused instead of becoming empty success", async t => {
    const app = await fixture(t), invalid = structuredClone(app.projection);
    invalid.counts.eligible = 0;
    for (const stdout of ["not-json", JSON.stringify({ schemaVersion: 2 }),
        JSON.stringify({ schemaVersion: 1, platform: "linux", projection: app.projection }),
        JSON.stringify({ schemaVersion: 1, platform: "win32", projection: invalid })]) {
        await assert.rejects(readSourceMetadata(app.files, {
            run: (...args) => args[0] === "node.exe" ? { stdout } : app.run(...args),
        }), { code: "source_metadata_invalid" });
    }
});

test("a source-native schema refusal retains its existing public status and reason", async t => {
    const app = await fixture(t);
    await assert.rejects(readSourceMetadata(app.files, { run: (...args) => {
        if (args[0] !== "node.exe") return app.run(...args);
        throw Object.assign(new Error("exit"), { code: 1, stdout: JSON.stringify({
            schemaVersion: 1, error: { code: "source_mapping_unsupported", status: 422, message: "Unsupported sessions mapping." },
        }) });
    } }), { code: "source_mapping_unsupported", status: 422, message: "Unsupported sessions mapping." });
});

test("native and helper projections share the exact output-byte limit", async t => {
    const app = await fixture(t), projection = structuredClone(app.projection);
    const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, platform: "win32", projection }))
        - Buffer.byteLength(projection.roster[0].name);
    projection.roster[0].name = "x".repeat(SOURCE_METADATA_MAX_BYTES - overhead);
    assert.equal(validateMetadataProjection(projection), projection);
    projection.roster[0].name += "x";
    assert.throws(() => validateMetadataProjection(projection), { code: "source_metadata_invalid" });
});
