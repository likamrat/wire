import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createExportController } from "../lib/export.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createCollector } from "../lib/collector.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { prepareHostHandover, applyHostHandover, hostHandoverStatus } from "../lib/host-handover.mjs";
import { sourceFingerprint, sourceStoreBinding } from "../lib/source-host.mjs";
import { BACKFILL_DIRECTORY, validateBackfillCheckpoint } from "../lib/collector-backfill.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture } from "./helpers.mjs";

const execute = promisify(execFile);
const distro = process.env.WIRE_WSL_DISTRO, node = process.env.WIRE_WSL_NODE, source = process.env.WIRE_WSL_SOURCE;
assert.equal(process.platform, "win32", "Run this opt-in qualification from Windows against native WSL.");
assert.ok(distro && node?.startsWith("/") && source?.startsWith("/"),
    "Set WIRE_WSL_DISTRO, WIRE_WSL_NODE and WIRE_WSL_SOURCE to the owned Linux qualification installation.");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function setup(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-wsl-portability-"));
    const context = { dataDir: path.join(root, "data") }, nonce = randomUUID();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "fixture.json"), JSON.stringify({ nonce }));
    await loadBoardState(context);
    const native = (await execute("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", context.dataDir])).stdout.trim();
    return { root, context, nonce, native };
}
function wslArguments(app, action, argument = "") {
    const parent = app.native.slice(0, app.native.lastIndexOf("/"));
    return ["--distribution", distro, "--exec", "env", "-i",
        `HOME=${parent}/home`, "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
        `COPILOT_HOME=${parent}/no-copilot`, `GH_CONFIG_DIR=${parent}/no-profile`,
        node, `${source}/tests/wsl-portability-fixture.mjs`, action, app.native, app.nonce, argument];
}
async function inWsl(app, action, argument = "") {
    const result = await execute("wsl.exe", wslArguments(app, action, argument),
        { timeout: 30000, maxBuffer: 1024 * 1024 });
    const value = JSON.parse(result.stdout.trim());
    assert.equal(value.platform, "linux");
    return value;
}
async function observer(app, request) {
    const file = path.join(app.root, `verification-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(request));
    const native = (await execute("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", file])).stdout.trim();
    try {
        const result = await inWsl(app, "verify-host-rows", native);
        return { host: result.host, rows: result.rows };
    } finally { await rm(file); }
}

test("native WSL startup accepts an unchanged approved Windows source reference", async t => {
    const app = await setup(t);
    await mkdir(path.join(app.context.dataDir, "collector"));
    const configFile = path.join(app.context.dataDir, "collector", "config.json");
    const config = JSON.stringify({ schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 60,
        appDbPath: path.join(app.root, "source", "data.db"), sessionRoot: path.join(app.root, "source", "session-state") });
    await writeFile(configFile, config);
    assert.equal((await inWsl(app, "startup")).started, true);
    assert.equal(await readFile(configFile, "utf8"), config, "Startup must not rewrite logical source configuration.");
});

async function collected(t) {
    const app = await setup(t), sessionId = randomUUID();
    const config = { appDbPath: path.join(app.root, "data.db"), sessionRoot: path.join(app.root, "session-state"),
        approved: true, enabled: false, windowDays: 30, pollSeconds: 5 };
    const db = new DatabaseSync(config.appDbPath);
    try {
        db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sessionId, "Invented cross-host source", "chat", null, "local");
    } finally { db.close(); }
    const directory = path.join(config.sessionRoot, sessionId), now = Date.now() - 10000;
    await mkdir(directory, { recursive: true });
    const events = [
        { type: "session.start", data: { sessionId, version: 1 } },
        { type: "user.message", data: { source: "user", content: "Invented cached v5 request." } },
        { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: "invented-portability-call",
            arguments: { entityUrls: ["/me/messages"] } } },
        { type: "tool.execution_complete", data: { toolCallId: "invented-portability-call", success: true } },
    ].map((event, position) => ({ ...event, id: randomUUID(), timestamp: new Date(now + position).toISOString() }));
    await writeFile(path.join(directory, "events.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""));
    const collector = await createCollector(app.context, { timers: false });
    try { await collector.configure(config); await collector.collectNow(); }
    finally { await collector.close(); }
    const state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    await replaceEvidence(app.context, () => ({ records: state.evidence.map(record => ({ ...record,
        userPrompt: { ...record.userPrompt, authorshipVersion: 5, authorship: { actor: "unknown", basis: "invalid-source" } },
    })), importCoverage: state.importCoverage }));
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json"), "utf8"));
    const cacheFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${sessionId}.json`);
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    for (const event of cache.events.filter(event => event.type === "user.message")) {
        event.data.wirePromptAuthorshipVersion = 5;
        event.data.wirePromptAuthorship = { actor: "unknown", basis: "invalid-source" };
    }
    await writeFile(cacheFile, JSON.stringify(cache));
    const access = await createCopilotRuntimeAccess(app.context);
    await access.close();
    const committed = await loadBoardState(app.context);
    const storedConfig = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "config.json"), "utf8"));
    const policy = { kind: "windows-to-wsl", operationId: randomUUID(), windowsDataDir: app.context.dataDir,
        storeBinding: sourceStoreBinding(committed), sourceFingerprint: sourceFingerprint(storedConfig),
        targetHost: (await inWsl(app, "host")).host };
    const options = { authorize: () => true, observeWsl: request => observer(app, request) };
    return { ...app, config, directory, sessionId, events, cacheFile, cache, committed, policy, options };
}

test("an unqualified host change cannot reread history or rewrite v5 caches across restart", async t => {
    const app = await collected(t);
    const { sessionId, directory, events, cacheFile, cache, committed, policy, options } = app;
    const result = await inWsl(app, "foreign-collection", sessionId);
    assert.equal(result.preserved, true);
    assert.equal(result.sourceReadsRefused, true);
    const plan = await prepareHostHandover(app.context, policy, options);
    assert.equal(plan.mapping.rows.length, 1);
    assert.equal(plan.mapping.rows[0].disposition, "verified");
    assert.deepEqual(plan.writeSet, [path.join("collector", "host-handover.json")]);
    const originalCache = await readFile(cacheFile), originalPrompt = structuredClone(committed.evidence[0].userPrompt);
    const receipt = await applyHostHandover(app.context, plan, { ...options, reviewedPlanHash: plan.planHash });
    assert.equal(receipt.outcome, "applied");
    for (const file of plan.before) {
        assert.equal(digest(await readFile(path.join(app.context.dataDir, file.path))), file.sha256,
            `Mapping must preserve existing store bytes: ${file.path}`);
    }
    assert.equal((await hostHandoverStatus(app.context, plan)).outcome, "applied");
    await assert.rejects(applyHostHandover(app.context, plan, { ...options, reviewedPlanHash: plan.planHash }),
        { code: "HOST_HANDOVER_REFUSED" });
    for (let restart = 0; restart < 2; restart++) {
        const resumed = await inWsl(app, "mapped-collect");
        assert.equal(resumed.oldVersion, 5);
        assert.equal((await inWsl(app, "startup")).started, true);
        assert.deepEqual(await readFile(cacheFile), originalCache);
    }
    const added = [
        { type: "user.message", data: { source: "user", content: "Invented later Linux continuation." } },
        { type: "tool.execution_start", data: { toolName: "workiq-fetch", toolCallId: "invented-later-call",
            arguments: { entityUrls: ["/me/messages"] } } },
        { type: "tool.execution_complete", data: { toolCallId: "invented-later-call", success: true } },
    ].map((event, position) => ({ ...event, id: randomUUID(), timestamp: new Date(Date.now() - 1000 + position).toISOString() }));
    await appendFile(path.join(directory, "events.jsonl"), added.map(event => JSON.stringify(event) + "\n").join(""));
    assert.equal((await inWsl(app, "mapped-collect")).records, 2);
    const after = await loadBoardState(app.context, { readOnly: true });
    assert.deepEqual(after.evidence[0].userPrompt, originalPrompt);
    const afterCache = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.deepEqual(afterCache.events.find(event => event.id === events[1].id),
        JSON.parse(originalCache).events.find(event => event.id === events[1].id));
    assert.ok(afterCache.cursor.offset > cache.cursor.offset);
});

test("handover refuses missing permission, stale reviewed state and a changed verification range", async t => {
    const app = await collected(t), { policy, options } = app;
    let observed = 0;
    const guarded = { ...options, observeWsl: async request => { observed++; return options.observeWsl(request); } };
    await assert.rejects(prepareHostHandover(app.context, policy, { ...guarded, authorize: () => false }),
        { code: "HOST_HANDOVER_REFUSED" });
    assert.equal(observed, 0);
    const plan = await prepareHostHandover(app.context, policy, guarded);
    const forged = structuredClone(plan);
    forged.before = [];
    await assert.rejects(applyHostHandover(app.context, forged, { ...guarded, reviewedPlanHash: plan.planHash }),
        { code: "HOST_HANDOVER_REFUSED" });
    assert.equal(observed, 1, "An altered plan must fail before original-source verification.");
    const sourceFile = path.join(app.directory, "events.jsonl"), original = await readFile(sourceFile);
    const altered = Buffer.from(original);
    altered[altered.length - 2] ^= 1;
    await writeFile(sourceFile, altered);
    await assert.rejects(applyHostHandover(app.context, plan, { ...guarded, reviewedPlanHash: plan.planHash }),
        { code: "HOST_HANDOVER_REFUSED" });
    assert.equal(observed, 1, "A changed Windows anchor must stop before WSL verification.");
    assert.equal((await hostHandoverStatus(app.context, plan)).outcome, "not-applied");
});

test("inactive indexed sources are explicitly retained-only without original history access", async t => {
    const app = await collected(t);
    const db = new DatabaseSync(app.config.appDbPath);
    try { db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), app.sessionId); }
    finally { db.close(); }
    await rm(path.join(app.directory, "events.jsonl"));
    const plan = await prepareHostHandover(app.context, app.policy, {
        ...app.options, observeWsl: request => {
            assert.deepEqual(request.rows, []);
            return app.options.observeWsl(request);
        },
    });
    assert.equal(plan.mapping.rows[0].disposition, "retained-only");
    assert.equal(plan.mapping.rows[0].reason, "archived");
    assert.equal(plan.mapping.rows[0].offset, app.cache.cursor.offset);
});

test("a sealed saved-prefix range is verified even when the primary tail anchor is unchanged", async t => {
    const app = await collected(t), sourceFile = path.join(app.directory, "events.jsonl");
    const bytes = await readFile(sourceFile);
    const boundary = Buffer.byteLength(app.events.slice(0, 2).map(event => JSON.stringify(event) + "\n").join(""));
    assert.ok(boundary < bytes.length - 128);
    const anchor = digest(bytes.subarray(Math.max(0, boundary - 128), boundary));
    const checkpoint = validateBackfillCheckpoint({
        schemaVersion: 1, backfillSource: app.sessionId,
        cursor: { ...app.cache.cursor, offset: boundary, logBytes: boundary, backlogBytes: 0, partialBytes: 0, anchor },
        events: [], diagnostics: {},
        backfill: { version: 1, fingerprint: app.policy.sourceFingerprint, deletionVersion: 0, activeSource: null,
            sources: [{ sessionId: app.sessionId, identity: app.cache.cursor.identity, endOffset: boundary,
                anchor, offset: boundary, phase: "visited", boundaryGap: false }], bytesRead: boundary },
    });
    const folder = path.join(app.context.dataDir, "collector", BACKFILL_DIRECTORY);
    await mkdir(folder);
    await writeFile(path.join(folder, `${app.sessionId}.json`), JSON.stringify(checkpoint));
    const plan = await prepareHostHandover(app.context, app.policy, app.options);
    assert.deepEqual(plan.mapping.rows[0].verificationRanges, [{ offset: boundary, anchor }]);
    const altered = Buffer.from(bytes);
    altered[boundary - 2] ^= 1;
    assert.equal(digest(altered.subarray(bytes.length - 128)), app.cache.cursor.anchor);
    await writeFile(sourceFile, altered);
    await assert.rejects(applyHostHandover(app.context, plan, { ...app.options, reviewedPlanHash: plan.planHash }),
        { code: "HOST_HANDOVER_REFUSED" });
    assert.equal((await hostHandoverStatus(app.context, plan)).outcome, "not-applied");
});

test("a lost handover response is resolved by reading the single committed mapping without a recovery write", async t => {
    const app = await collected(t);
    let observed = 0;
    const options = { ...app.options, observeWsl: request => { observed++; return app.options.observeWsl(request); } };
    const plan = await prepareHostHandover(app.context, app.policy, options);
    await assert.rejects(applyHostHandover(app.context, plan, { ...options, reviewedPlanHash: plan.planHash,
        afterMappingWrite: () => { throw new Error("Invented lost response."); } }),
    { code: "HOST_HANDOVER_OUTCOME_UNKNOWN" });
    const directory = path.join(app.context.dataDir, "collector"), file = path.join(directory, "host-handover.json");
    const bytes = await readFile(file), before = await stat(file), entries = await readdir(directory);
    assert.equal((await hostHandoverStatus(app.context, plan)).outcome, "applied");
    assert.equal((await hostHandoverStatus(app.context, plan)).outcome, "applied");
    assert.equal(observed, 2, "Status must not repeat original-source verification.");
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readdir(directory), entries);
    assert.equal(entries.includes("host-handover-receipt.json"), false);
    await assert.rejects(applyHostHandover(app.context, plan, { ...options, reviewedPlanHash: plan.planHash }),
        { code: "HOST_HANDOVER_REFUSED" });
    assert.equal(observed, 2);
    assert.equal((await inWsl(app, "mapped-collect")).oldVersion, 5);
    const corrupt = JSON.parse(bytes);
    corrupt.planHash = "0".repeat(64);
    await writeFile(file, JSON.stringify(corrupt));
    await assert.rejects(hostHandoverStatus(app.context, plan), { code: "source_host_mapping_stale" });
});

test("native WSL opens Windows-registered frozen files without weakening ownership or integrity", async t => {
    const app = await setup(t), record = fixture("invented-cross-host-report");
    record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    await replaceEvidence(app.context, () => ({ records: [record], importCoverage: null }));
    const exports = createExportController(app.context), state = await loadBoardState(app.context);
    const preview = await exports.preview("cross-host-fixture", undefined, { promptMode: "none", formats: ["html", "json"] },
        { kind: "all", revision: state.revision });
    await exports.review("cross-host-fixture", preview.previewId, true);
    const { bundle } = await exports.confirm("cross-host-fixture", preview.previewId, true);
    const html = await readFile(bundle.files["product-report.html"]), json = await readFile(bundle.files["product-report.json"]);
    const stateFile = path.join(app.context.dataDir, "workiq-evidence-board-v1.state.json"), stateBytes = await readFile(stateFile);
    const opened = await inWsl(app, "report");
    assert.equal(opened.htmlHash, digest(html));
    assert.equal(opened.jsonHash, digest(json));
    assert.deepEqual(await readFile(stateFile), stateBytes, "Host access must not rewrite frozen registrations.");
    await writeFile(bundle.files["product-report.html"], Buffer.concat([html, Buffer.from("\n<!-- altered fixture -->")]));
    assert.equal((await inWsl(app, "corrupt-report")).refusedAlteredBytes, true);
});

test("native WSL cannot reclaim a live Windows writer whose PID is absent from Linux", async t => {
    const app = await setup(t), release = await acquireCollectorLock(app.context.dataDir);
    const lockFile = path.join(app.context.dataDir, "collector.lock"), before = await readFile(lockFile);
    try {
        const result = await inWsl(app, "lock", String(process.pid));
        assert.equal(result.acquired, false, "A foreign PID namespace must not turn a live writer into a dead owner.");
        assert.equal(result.status, 409);
        assert.deepEqual(await readFile(lockFile), before);
    } finally {
        try { await release(); }
        catch (error) {
            if (await readFile(lockFile).catch(readError => readError.code === "ENOENT" ? null : Promise.reject(readError))) throw error;
        }
    }
});

test("Windows refuses the live native Linux writer and can acquire only after its graceful release", async t => {
    const app = await setup(t);
    const child = spawn("wsl.exe", wslArguments(app, "hold"), { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code));
    });
    let ready, output = "", stderr = "", timer;
    child.stderr.on("data", bytes => { stderr += bytes; });
    try {
        ready = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Native holder did not become ready: " + stderr)), 10000);
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Native holder exited early: " + stderr)));
            child.stdout.on("data", bytes => {
                output += bytes;
                if (output.includes("\n")) resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
            });
        });
        clearTimeout(timer);
        assert.equal(ready.platform, "linux");
        assert.equal(ready.holding, true);
        const lock = path.join(app.context.dataDir, "collector.lock"), before = await readFile(lock);
        await assert.rejects(acquireCollectorLock(app.context.dataDir), { code: "COLLECTOR_OWNER_FOREIGN", status: 409 });
        assert.deepEqual(await readFile(lock), before);
    } finally {
        clearTimeout(timer);
        if (ready?.pid) {
            await execute("wsl.exe", ["--distribution", distro, "--exec", node, "-e",
                'const fs=require("node:fs");const pid=Number(process.argv[1]),args=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").split("\\0");if(!args.includes("hold")||!args.includes(process.argv[2])||!args.includes(process.argv[3]))throw Error("Fixture holder identity changed");process.kill(pid,"SIGTERM");',
                String(ready.pid), app.native, app.nonce]);
        }
        assert.equal(await exited, 0, stderr);
    }
    const release = await acquireCollectorLock(app.context.dataDir);
    await release();
});
