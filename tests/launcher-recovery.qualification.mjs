import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { storeIdentity } from "../lib/update-launch-state.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture } from "./helpers.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const supported = process.platform === "win32" || process.platform === "linux" && /microsoft/i.test(release());
test("recover a killed v1 writer in its original standalone installation", { skip: !supported, timeout: 180000 }, async t => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "wire-crash-")));
    const root = path.join(temp, "installed"), store = path.join(temp, "store"), plan = path.join(temp, "custody.json");
    const active = new Set();
    t.after(async () => {
        try {
            for (const app of active) { if (app.child.connected) app.child.disconnect(); await app.done; }
        } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    });
    await mkdir(root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|OS|WINDIR|SystemRoot|ComSpec|SystemDrive|NUMBER_OF_PROCESSORS)$/i.test(key)));
    Object.assign(env, { HOME: temp, USERPROFILE: temp, LOCALAPPDATA: temp, APPDATA: temp, TMP: temp, TEMP: temp,
        COPILOT_HOME: path.join(temp, "empty-copilot"), GH_CONFIG_DIR: path.join(temp, "empty-gh"),
        WORKIQ_EVIDENCE_DATA_DIR: store, GIT_CONFIG_GLOBAL: path.join(temp, "empty-git"), GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" });
    const git = async (cwd, ...args) => (await execute("git", args, { env, cwd })).stdout.trim();
    const target = await git(project, "rev-parse", "HEAD");
    const original = process.env.WIRE_RECOVERY_BASE || target;
    assert.match(original, /^[a-f0-9]{40}$/);
    await git(root, "init", "-qb", "main");
    await git(root, "fetch", "--quiet", "--no-tags", project, target);
    await git(root, "merge", "--ff-only", original);
    // Only local Git transport is allowed. No origin fetch or provider is used.
    await git(root, "remote", "add", "origin", "https://github.com/likamrat/wire.git");
    await symlink(path.join(project, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const build = () => execute(process.execPath, [process.env.npm_execpath, "run", "build"], { cwd: root, env });
    await build();
    const context = { dataDir: store };
    await replaceEvidence(context, () => ({ records: [fixture("crash-test")], importCoverage: null }));
    const reports = createExportController(context);
    const preview = await reports.preview("fixture", undefined, { formats: ["html"], promptMode: "masked" },
        { kind: "all", revision: (await loadBoardState(context)).revision });
    await reports.review("fixture", preview.previewId, true);
    await reports.confirm("fixture", preview.previewId, true);
    const board = await loadBoardState(context), evidence = path.join(store, "private-evidence", board.evidenceFile);
    const retained = await Promise.all([evidence, ...Object.values(board.exports[0].files)].map(async file => [file, await readFile(file)]));
    // Independent, pre-crash observation of the real fork. No substituted
    // server, port, Git implementation, launcher decision or storage owner.
    const witness = path.join(temp, "witness.mjs"), observed = path.join(temp, "observed.json");
    await writeFile(witness, `import{writeFileSync}from'node:fs';if(process.env.WIRE_UPDATE_CHILD)writeFileSync(${JSON.stringify(observed)},
        JSON.stringify({childId:process.env.WIRE_UPDATE_CHILD,writerPid:process.pid,launcherPid:process.ppid}),{flag:'wx'});`);
    function start(args, observe = false) {
        const child = fork(path.join(root, "scripts", "launch.mjs"), args, { cwd: root, execArgv: [],
            env: { ...env, ...(observe && { NODE_OPTIONS: "--import=" + pathToFileURL(witness).href }) }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        const app = { child, out: "", err: "", done: new Promise(resolve => child.once("exit", resolve)) };
        child.stdout.on("data", b => { app.out += b; }); child.stderr.on("data", b => { app.err += b; });
        active.add(app); app.done.then(() => active.delete(app)); return app;
    }
    async function ready(app, expected) {
        for (let i = 0; i < 300 && !app.out.includes("ready at"); i++) {
            assert.equal(app.child.exitCode, null, app.err); await delay(100);
        }
        const url = app.out.match(/ready at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
        assert.ok(url, app.err);
        const health = await (await fetch(url + "health")).json();
        assert.equal(health.build, expected);
        assert.equal((await fetch(new URL(health.clientEntry, url))).status, 200);
        return { url, id: health.runtimeId };
    }
    const first = start(["--port", "0"], true), before = await ready(first, original);
    const port = Number(new URL(before.url).port), args = ["--port", String(port)];
    const recoveryArgs = ["--recover-launch", plan, ...args];
    const receipt = JSON.parse(await readFile(observed, "utf8"));
    assert.equal(receipt.launcherPid, first.child.pid);
    const files = ["collector.lock", path.join("microsoft-session", "collector.lock")].map(name => path.join(store, name));
    const leases = await Promise.all(files.map(file => readFile(file, "utf8")));
    const [collector, session] = leases.map(text => JSON.parse(text));
    assert.equal(collector.pid, receipt.writerPid); assert.equal(session.pid, receipt.writerPid);
    assert.deepEqual(collector.host, session.host);
    const custody = { version: 1, installation: root, interruptedBuild: original, targetBuild: target, store: await storeIdentity(store),
        port, host: collector.host, ...receipt, collectorToken: collector.token, sessionToken: session.token, operationsReviewed: true };
    await writeFile(plan, JSON.stringify(custody));
    const competing = start(args);
    assert.equal(await competing.done, 1); assert.match(competing.err, /already has a launcher/);
    process.kill(receipt.writerPid, "SIGKILL");
    assert.equal(await first.done, 1);
    const childRow = key => {
        const db = new DatabaseSync(path.join(root, ".git", "wire-updates", "child.sqlite"), { readOnly: true });
        try { const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key); return row && JSON.parse(row.value); }
        finally { db.close(); }
    };
    const prior = { id: receipt.childId, state: "running" };
    const ordinary = start(args);
    assert.equal(await ordinary.done, 1); assert.match(ordinary.err, /clean close/);
    assert.deepEqual(childRow("child"), prior);
    await git(root, "merge", "--ff-only", target); await build();
    async function refuse(change, reason) {
        await writeFile(plan, JSON.stringify({ ...custody, ...change }));
        const app = start(recoveryArgs);
        assert.equal(await app.done, 1); assert.match(app.err, reason);
        assert.deepEqual(childRow("child"), prior); assert.equal(childRow("interrupted:" + receipt.childId), undefined);
        assert.deepEqual(await Promise.all(files.map(file => readFile(file, "utf8"))), leases);
    }
    await refuse({ childId: randomUUID() }, /clean close/);
    await refuse({ operationsReviewed: false }, /accounted for/);
    await refuse({ sessionToken: randomUUID() }, /leases/);
    // A lost Save after exclusive staging must not be cleaned up or retried.
    const unfinished = path.join(store, "exports", ".pending-invented-save");
    await mkdir(unfinished);
    await refuse({}, /unresolved/);
    await rm(unfinished, { recursive: true }); // Remove only this test's injected refusal case.
    const restored = start(recoveryArgs), after = await ready(restored, target);
    assert.equal(after.url, before.url); assert.notEqual(after.id, before.id);
    for (const [file, bytes] of retained) assert.deepEqual(await readFile(file), bytes);
    restored.child.disconnect(); assert.equal(await restored.done, 0, restored.err);
    const closed = childRow("child");
    assert.equal(closed.state, "closed"); assert.notEqual(closed.id, receipt.childId);
    assert.deepEqual(childRow("interrupted:" + receipt.childId), { ...prior, state: "interrupted", successor: closed.id,
        build: original, store: custody.store, port });
    const replay = start(recoveryArgs);
    assert.equal(await replay.done, 1); assert.deepEqual(childRow("child"), closed);
    // Restore the old code only in this disposable clone. No store rollback or
    // fabricated close: the old launcher reads the genuine successor close.
    await git(root, "switch", "--detach", original);
    await git(root, "branch", "-f", "main", original); await git(root, "switch", "main");
    await build();
    const rollback = start(args); assert.equal((await ready(rollback, original)).url, before.url);
    rollback.child.disconnect(); assert.equal(await rollback.done, 0);
    for (const [file, bytes] of retained) assert.deepEqual(await readFile(file), bytes);
    t.diagnostic(`Original ${original}; recovery ${target}; same installation, store and port; compatible original reopened.`);
});
