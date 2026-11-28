import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readMetadataProjection, readMetadataSnapshot, validateMetadataProjection, metadataReadVersion,
    SOURCE_METADATA_MAX_BYTES, SOURCE_METADATA_READER_VERSION } from "../../lib/source-metadata.mjs";
import { readCollectionMetadata, readSourceMetadata, sourceMetadataStamp, observeSourceMetadataSelection } from "../../lib/source-reader.mjs";
import { BoardError } from "../../lib/store.mjs";

test("missing required metadata is qualified consistently by stamp, native read and helper snapshot", async t => {
    const app = await fixture(t);
    await rm(app.file);
    const missing = error => {
        assert.equal(error.code, "source_metadata_unavailable");
        assert.equal(error.status, 503);
        assert.match(error.message, /ENOENT/);
        assert.doesNotMatch(error.message, new RegExp(path.basename(path.dirname(app.file))));
        return true;
    };
    assert.throws(() => sourceMetadataStamp(app.files), error => {
        assert.ok(error instanceof BoardError);
        return missing(error);
    });
    await assert.rejects(readSourceMetadata({ ...app.files, windowsDatabase: null }), missing);
    await assert.rejects(readSourceMetadata(app.files, { run: () => assert.fail("A missing input must not launch its helper.") }), missing);
    assert.throws(() => readMetadataSnapshot(app.file), missing);
});

test("absent WAL is optional but unreadable required or companion metadata is not", async t => {
    const app = await fixture(t);
    const before = sourceMetadataStamp(app.files), version = metadataReadVersion(app.file);
    assert.match(before, /:absent$/);
    const stat = fs.statSync;
    const failure = Object.assign(new Error("Invented path must not enter the public message"), { code: "EACCES", syscall: "stat" });
    for (const target of [app.file, app.file + "-wal"]) {
        const mocked = t.mock.method(fs, "statSync", (file, ...args) => {
            if (file === target) throw failure;
            return stat(file, ...args);
        });
        syncBuiltinESMExports();
        try {
            assert.throws(() => sourceMetadataStamp(app.files), { code: "source_metadata_unavailable", status: 503 });
            assert.throws(() => metadataReadVersion(app.file), { code: "source_metadata_unavailable", status: 503 });
            await assert.rejects(readSourceMetadata({ ...app.files, windowsDatabase: null }), { code: "source_metadata_unavailable", status: 503 });
        } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    }
    assert.equal(sourceMetadataStamp(app.files), before);
    assert.equal(metadataReadVersion(app.file), version);
});

test("metadata disappearing after a valid helper read cannot publish its earlier projection", async t => {
    const app = await fixture(t);
    await assert.rejects(readSourceMetadata(app.files, { run: async (...args) => {
        const result = await app.run(...args);
        if (args[0] === "node.exe") await rm(app.file);
        return result;
    } }), { code: "source_metadata_unavailable", status: 503 });
});

test("metadata loss between stamp, identity and SQLite open stays a qualified read failure", async t => {
    for (const boundary of ["identity", "open"]) await t.test(boundary, async t => {
        const app = await fixture(t);
        let paths = 0;
        const files = { ...app.files, windowsDatabase: null, databaseFile() {
            if (++paths === (boundary === "identity" ? 2 : 3)) fs.rmSync(app.file);
            return app.file;
        } };
        await assert.rejects(readSourceMetadata(files), { code: "source_metadata_unavailable", status: 503 });
    });
});

test("metadata stat normalization does not relabel an unrelated implementation error", async t => {
    const app = await fixture(t), unexpected = new TypeError("Invented implementation defect");
    const stat = fs.statSync;
    const mocked = t.mock.method(fs, "statSync", (file, ...args) => {
        if (file === app.file) throw unexpected;
        return stat(file, ...args);
    });
    syncBuiltinESMExports();
    try {
        assert.throws(() => sourceMetadataStamp(app.files), error => error === unexpected);
        await assert.rejects(readSourceMetadata(app.files), error => error === unexpected);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("source-native metadata changes before SQL begins are included rather than rejected as stale", async t => {
    const app = await fixture(t);
    const result = await readSourceMetadata(app.files, { run: async (...args) => {
        if (args[0] === "node.exe") {
            const database = new DatabaseSync(app.file);
            database.exec("UPDATE sessions SET title='Freshly committed before the read'");
            database.close();
            const current = await fixtureResponse(app.file);
            return { stdout: JSON.stringify(current) };
        }
        return app.run(...args);
    } });
    assert.equal(result.roster[0].name, "Freshly committed before the read");
});

async function fixtureResponse(file, observeChange = false) {
    return { schemaVersion: SOURCE_METADATA_READER_VERSION, platform: "win32", ...readMetadataSnapshot(file, { observeChange }) };
}

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
        return { stdout: JSON.stringify(await fixtureResponse(file)) };
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

test("native and source-native readers bind managed Work IQ identity to its exact session and event", async t => {
    const app = await fixture(t), db = new DatabaseSync(app.file);
    db.exec(`CREATE TABLE session_managed_mcp_event_display_names(
        session_id TEXT NOT NULL,event_id TEXT NOT NULL,display_name TEXT,
        PRIMARY KEY(session_id,event_id));
        INSERT INTO session_managed_mcp_event_display_names VALUES
        ('00000000-0000-4000-8000-000000000001','managed-fetch','Work IQ'),
        ('00000000-0000-4000-8000-000000000001','unrelated-fetch','Another connector'),
        ('00000000-0000-4000-8000-000000000002','foreign-fetch','Work IQ');`);
    db.close();
    const native = await readSourceMetadata({ ...app.files, windowsDatabase: null });
    const hosted = await readSourceMetadata(app.files, { run: app.run });
    assert.deepEqual(native.roster[0].managedWorkIqEventIds, ["managed-fetch"]);
    assert.deepEqual(hosted.roster[0].managedWorkIqEventIds, ["managed-fetch"]);
    for (const ids of [["duplicate", "duplicate"], ["bad\nidentity"], "not-an-array"]) {
        const invalid = structuredClone(hosted);
        invalid.roster[0].managedWorkIqEventIds = ids;
        assert.throws(() => validateMetadataProjection(invalid), { code: "source_metadata_invalid" });
    }
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

test("a source-native database replacement during launch cannot adopt another identity", async t => {
    const app = await fixture(t);
    await assert.rejects(readSourceMetadata(app.files, { run: async (...args) => {
        if (args[0] !== "node.exe") return app.run(...args);
        await rename(app.file, app.file + ".old");
        const db = new DatabaseSync(app.file);
        db.close();
        return { stdout: JSON.stringify({ ...await fixtureResponse(app.file + ".old"),
            readVersion: metadataReadVersion(app.file) }) };
    } }), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-identity" });
});

test("changes inside the actual SQL read still invalidate the source-native snapshot", async t => {
    const app = await fixture(t);
    const writer = new DatabaseSync(app.file);
    writer.exec("PRAGMA journal_mode=WAL; UPDATE sessions SET title='Before read'");
    const prepare = DatabaseSync.prototype.prepare;
    let changed = false;
    t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (sql === "PRAGMA user_version") {
            const get = statement.get.bind(statement);
            statement.get = () => {
                const result = get();
                changed = true;
                writer.exec("UPDATE sessions SET title=title||'!'");
                return result;
            };
        }
        return statement;
    });

    try {
        assert.throws(() => readMetadataSnapshot(app.file), { code: "COLLECTION_SOURCE_CHANGED" });
        assert.equal(changed, true);
        const observation = readMetadataSnapshot(app.file, { observeChange: true });
        assert.equal(observation.changedDuringRead, true);
        assert.notEqual(observation.readVersion, metadataReadVersion(app.file));
        assert.equal(observation.projection.roster[0].name, "Before read!");
    } finally { writer.close(); }
});

const selectedRow = value => {
    const { checkedAt, ...row } = value.roster.find(row => row.sessionId === "00000000-0000-4000-8000-000000000001");
    return JSON.stringify([value.adapter, value.schemaVersion, value.sourceIdentity, row]);
};

for (const hosted of [false, true]) test(`read-only selected observations tolerate unrelated commits without issuing a stamp: ${hosted ? "helper" : "native"}`, async t => {
    const app = await fixture(t), writer = new DatabaseSync(app.file);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE unrelated(n INTEGER); INSERT INTO unrelated VALUES(0)");
    let checks = 0, reads = 0;
    const verify = () => { checks++; writer.exec("UPDATE unrelated SET n=n+1"); };
    const run = async (command, args) => {
        if (command === "wslpath") return { stdout: "C:\\owned\\read-copilot-metadata.mjs" };
        assert.equal(args.at(-1), "--observe-selection");
        reads++;
        const response = await fixtureResponse(app.file, true);
        writer.exec("UPDATE unrelated SET n=n+1");
        return { stdout: JSON.stringify(response) };
    };
    try {
        const result = await observeSourceMetadataSelection({ ...app.files, windowsDatabase: hosted ? app.files.windowsDatabase : null },
            { verify, proof: selectedRow, run });
        assert.equal(result.roster[0].sessionId, app.projection.roster[0].sessionId);
        assert.match(result.sourceIdentity, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(result, "metadataStamp"), false, "An observation cannot become a whole-database publication fence.");
        assert.equal(checks, hosted ? 6 : 4);
        assert.equal(reads, hosted ? 2 : 0);
        await assert.rejects(readSourceMetadata({ ...app.files, windowsDatabase: null },
            { selection: { verify, proof: selectedRow } }), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
    } finally { writer.close(); }
});

for (const change of ["selected", "revoked", "replacement", "unreadable"]) test(`read-only selected observations refuse ${change}`, async t => {
    const app = await fixture(t), replacement = await fixture(t), writer = new DatabaseSync(app.file);
    let reads = 0, revoked = false, file = app.file;
    const files = { ...app.files, databaseFile: () => file };
    try {
        writer.exec("PRAGMA journal_mode=WAL");
        await assert.rejects(observeSourceMetadataSelection(files, {
            proof: selectedRow,
            verify() { if (revoked) throw Object.assign(new Error("Withdrawn source grant"), { code: "wire_access_revoked" }); },
            run: async command => {
                if (command === "wslpath") return { stdout: "C:\\owned\\read-copilot-metadata.mjs" };
                reads++;
                if (reads === 2 && change === "unreadable") throw Object.assign(new Error("Timed out"), { killed: true });
                const response = await fixtureResponse(file, true);
                if (reads === 1) {
                    if (change === "selected") writer.exec("UPDATE sessions SET title='Changed selected mapping'");
                    if (change === "revoked") revoked = true;
                    if (change === "replacement") file = replacement.file;
                }
                return { stdout: JSON.stringify(response) };
            },
        }), { code: { revoked: "wire_access_revoked", unreadable: "source_reader_unavailable" }[change] ?? "COLLECTION_SOURCE_CHANGED" });
        assert.equal(reads, ["selected", "unreadable"].includes(change) ? 2 : 1);
    } finally { writer.close(); }
});

for (const collection of [false, true]) test(`the ${collection ? "ordinary collector" : "selected read"} returns only the fresh Windows helper roster and its verified stamp`, { skip: process.platform !== "win32" }, async t => {
    const app = await fixture(t), execute = promisify(execFile);
    const files = { ...app.files, windowsDatabase: app.file };
    const script = fileURLToPath(new URL("../../scripts/read-copilot-metadata.mjs", import.meta.url));
    const writer = new DatabaseSync(app.file);
    try {
        writer.exec("PRAGMA journal_mode=WAL");
        let reads = 0;
        const run = async (command, args, options) => {
            if (command === "wslpath") return { stdout: script };
            const response = await execute(process.execPath, args, options);
            if (++reads === 1) writer.exec(collection ? "UPDATE sessions SET title='New display name'"
                : "INSERT INTO sessions VALUES('00000000-0000-4000-8000-000000000002','Other','chat',NULL,'local')");
            return response;
        };
        const result = collection ? await readCollectionMetadata(files, () => {}, { run })
            : await readSourceMetadata(files, { selection: { proof: selectedRow, verify() {} }, run });
        assert.equal(reads, 2);
        if (collection) assert.equal(result.roster[0].name, "New display name");
        else assert.equal(result.counts.enumerated, 2, "Do not attach a current stamp to the first roster.");
        assert.equal(result.metadataStamp, sourceMetadataStamp(files));
    } finally { writer.close(); }
});

for (const cause of ["revoked", "replacement", "unreadable", "wrong-host", "stale-version"]) {
    test(`selected revalidation cannot return a first observation after ${cause}`, async t => {
        const app = await fixture(t), replacement = await fixture(t);
        const writer = new DatabaseSync(app.file);
        let reads = 0, revoked = false, file = app.file;
        const files = { ...app.files, databaseFile: () => file };
        const verify = () => { if (revoked) throw Object.assign(new Error("Retired acquisition generation."), { code: "wire_access_revoked" }); };
        try {
            writer.exec("PRAGMA journal_mode=WAL; INSERT INTO projects VALUES('initial','Initial WAL state')");
            const failure = readSourceMetadata(files, { selection: { proof: selectedRow, verify }, run: async command => {
                if (command === "wslpath") {
                    if (reads === 1 && cause === "revoked") revoked = true;
                    if (reads === 1 && cause === "replacement") file = replacement.file;
                    return { stdout: "C:\\owned\\read-copilot-metadata.mjs" };
                }
                reads++;
                if (reads === 2 && cause === "unreadable") throw Object.assign(new Error("Timed out"), { killed: true });
                const reply = await fixtureResponse(file);
                if (reads === 1) writer.exec("INSERT INTO projects VALUES('unselected','Other')");
                if (reads === 2 && cause === "wrong-host") reply.platform = "linux";
                if (reads === 2 && cause === "stale-version") reply.readVersion = "0".repeat(64);
                return { stdout: JSON.stringify(reply) };
            } });
            await assert.rejects(failure, { code: { revoked: "wire_access_revoked", unreadable: "source_reader_unavailable",
                "wrong-host": "source_metadata_invalid" }[cause] ?? "COLLECTION_SOURCE_CHANGED" });
            assert.equal(reads, ["revoked", "replacement"].includes(cause) ? 1 : 2);
        } finally { writer.close(); }
    });
}

test("helper timeout, missing runtime, excessive output and unsuccessful exit never fall back to local SQLite", async t => {
    const app = await fixture(t);
    for (const error of [
        Object.assign(new Error("missing"), { code: "ENOENT" }),
        Object.assign(new Error("timeout"), { killed: true }),
        Object.assign(new Error("output limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
        Object.assign(new Error("failed after output"), { code: 1,
            stdout: JSON.stringify(await fixtureResponse(app.file)) }),
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
    for (const stdout of ["not-json", JSON.stringify({ schemaVersion: 1 }),
        JSON.stringify({ schemaVersion: SOURCE_METADATA_READER_VERSION, platform: "linux", projection: app.projection }),
        JSON.stringify({ ...await fixtureResponse(app.file), projection: invalid }),
        JSON.stringify({ schemaVersion: SOURCE_METADATA_READER_VERSION, platform: "win32", projection: app.projection })]) {
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
            schemaVersion: SOURCE_METADATA_READER_VERSION, error: { code: "source_mapping_unsupported", status: 422, message: "Unsupported sessions mapping." },
        }) });
    } }), { code: "source_mapping_unsupported", status: 422, message: "Unsupported sessions mapping." });
});

test("native and helper projections share the exact output-byte limit", async t => {
    const app = await fixture(t), projection = structuredClone(app.projection);
    const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: SOURCE_METADATA_READER_VERSION, platform: "win32",
        projection, readVersion: "0".repeat(64) }))
        - Buffer.byteLength(projection.roster[0].name);
    projection.roster[0].name = "x".repeat(SOURCE_METADATA_MAX_BYTES - overhead);
    assert.equal(validateMetadataProjection(projection), projection);
    projection.roster[0].name += "x";
    assert.throws(() => validateMetadataProjection(projection), { code: "source_metadata_invalid" });
});
