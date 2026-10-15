import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createSearchModel } from "../lib/search-model.mjs";
import { SearchError, SEARCH_MODEL, SEARCH_RUNTIME, SEARCH_MODEL_ID, searchHash } from "../lib/search-model-assets.mjs";

// The guard runs only in VM realms whose process, filesystem, module loader and Workers are stubs.
const guardPath = fileURLToPath(new URL("../lib/search-model-guard.cjs", import.meta.url));
const source = await readFile(guardPath, "utf8");
const runtimeRoot = path.join(path.dirname(guardPath), "invented-runtime");
const runtimePath = path.join(runtimeRoot, "dist", "ort-wasm-simd-threaded.mjs");
const runtimeBytes = Buffer.from("invented-runtime-bytes-never-executed");
const runtimeSpec = { name: "dist/ort-wasm-simd-threaded.mjs", bytes: runtimeBytes.length,
    sha256: createHash("sha256").update(runtimeBytes).digest("hex") };
function realm({ main = true, data = new Map(), env, platform = "win32", version = "24.19.0", badHash = false,
    badFlags = false, workerData = "em-pthread", threadId = 17, beforeForward = () => {},
    resolveError, fileError, assetsError, sendError, onMessage = () => {}, onExit = () => {} } = {}) {
    const kills = [], children = [], forwards = [], messages = [], exits = [], process = new EventEmitter();
    Object.assign(process, {
        versions: { node: version }, platform, pid: 424242, connected: main,
        env: env ?? { SystemRoot: "invented-system", TEMP: "invented-temp" },
        argv: main ? ["invented-node", path.join(path.dirname(guardPath), "search-model-worker.mjs")] : ["invented-node"],
        execArgv: ["--disallow-code-generation-from-strings", "--require", guardPath],
        kill: (pid, signal) => { kills.push({ pid, signal }); },
        send(message, callback) {
            if (sendError) throw new Error("Invented IPC failure");
            messages.push(message); onMessage(message);
            queueMicrotask(() => callback?.(null));
        },
        exit(code) { exits.push(code); onExit(code); },
    });
    if (badFlags) process.execArgv.push("--inspect");
    class FakeWorker extends EventEmitter {
        threadId = 17;
        constructor(filename, options) { super(); children.push(this); this.filename = filename; this.options = options; }
    }
    const threads = {
        isMainThread: main, threadId: main ? 0 : threadId, workerData: main ? undefined : workerData, Worker: FakeWorker,
        getEnvironmentData: key => data.get(key), setEnvironmentData: (key, value) => data.set(key, value),
    };
    const result = Object.freeze({ originalReturn: true });
    const nodeModule = {
        syncBuiltinESMExports() {},
        runMain(...args) { beforeForward(); forwards.push({ receiver: this, args }); return result; },
    };
    const modules = {
        "node:fs": {
            realpathSync: value => {
                if (value === runtimePath && fileError?.operation === "realpath") throw Object.assign(new Error("Invented file failure"), { code: fileError.code });
                return path.resolve(value);
            },
            lstatSync: () => {
                if (fileError?.operation === "stat") throw Object.assign(new Error("Invented file failure"), { code: fileError.code });
                return { isFile: () => true, size: runtimeBytes.length };
            },
            readFileSync: () => {
                if (fileError?.operation === "read") throw Object.assign(new Error("Invented file failure"), { code: fileError.code });
                return badHash ? Buffer.from("mismatched") : runtimeBytes;
            },
        },
        "node:path": path, "node:crypto": { createHash }, "node:url": { pathToFileURL, fileURLToPath },
        "node:module": nodeModule, "node:worker_threads": threads,
        "node:http": {}, "node:https": {}, "node:net": { Socket: { prototype: {} } }, "node:dns": {}, "node:dgram": {},
        "./search-model-assets.mjs": { SearchError, SEARCH_RUNTIME: { ...SEARCH_RUNTIME, files: [runtimeSpec] } },
    };
    const require = name => {
        assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`);
        if (name === "./search-model-assets.mjs" && assetsError) throw new Error("Unclassified bootstrap crash");
        return modules[name];
    };
    require.resolve = name => {
        assert.equal(name, "onnxruntime-web");
        if (resolveError) throw Object.assign(new Error("Invented missing dependency"), { code: "MODULE_NOT_FOUND" });
        return path.join(runtimeRoot, "dist", "ort.node.min.js");
    };
    const context = vm.createContext({ require, process, module: { exports: {} }, __filename: guardPath,
        __dirname: path.dirname(guardPath), URL, SharedArrayBuffer, Int32Array, Atomics,
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} } });
    return {
        process, threads, data, modules, context, children, kills, forwards, messages, exits, result, nodeModule,
        load() { vm.runInContext(source, context, { filename: guardPath }); return context.module.exports; },
        preload() {
            try { this.load(); return true; }
            catch (error) {
                if (!process.listenerCount("uncaughtException")) throw error;
                process.emit("uncaughtException", error);
                return false;
            }
        },
        createWorker(expression = '{ type: "module", workerData: "em-pthread", name: "em-pthread" }') {
            context.target = pathToFileURL(runtimePath);
            return vm.runInContext(`new (require("node:worker_threads").Worker)(target, ${expression})`, context);
        },
        enter(receiver = {}) {
            process.argv.push(runtimePath);
            return nodeModule.runMain.call(receiver, runtimePath, "unchanged-extra-argument");
        },
        signal() { return new Int32Array(data.get(`wire-search:${SEARCH_RUNTIME.guard}`)); },
    };
}

test("actual preload source preserves known error IPC and cannot proceed to helper entry", async () => {
    for (const [options, code] of [
        [{ resolveError: true }, "runtime-missing"],
        [{ fileError: { operation: "realpath", code: "ENOENT" } }, "runtime-missing"],
        [{ fileError: { operation: "stat", code: "ENOTDIR" } }, "runtime-missing"],
        [{ fileError: { operation: "read", code: "EACCES" } }, "runtime-unreadable"],
        [{ badHash: true }, "runtime-corrupt"],
        [{ badFlags: true }, "runtime-guard-launch"],
        [{ env: { SystemRoot: "invented", UNEXPECTED: "invented" } }, "runtime-guard-environment"],
    ]) {
        const main = realm(options);
        assert.equal(main.preload(), false);
        assert.equal(JSON.stringify(main.messages), JSON.stringify([{ ok: false, code }]));
        assert.deepEqual(main.exits, [], "IPC write callback must precede terminal exit");
        await Promise.resolve();
        assert.deepEqual(main.exits, [1]);
        assert.equal(main.children.length, 0);
        if (main.data.size) assert.equal(Atomics.load(main.signal(), 1), 1);
    }
    const unknown = realm({ assetsError: true });
    assert.equal(unknown.preload(), false);
    assert.deepEqual(unknown.messages, []);
    assert.deepEqual(unknown.exits, [1]);
    const disconnected = realm({ resolveError: true }); disconnected.process.connected = false;
    assert.equal(disconnected.preload(), false);
    assert.deepEqual(disconnected.messages, []); assert.deepEqual(disconnected.exits, [1]);
    const brokenIpc = realm({ resolveError: true, sendError: true });
    assert.equal(brokenIpc.preload(), false); assert.deepEqual(brokenIpc.exits, [1]);
    const healthy = realm(); healthy.load();
    assert.equal(healthy.process.listenerCount("uncaughtException"), 0, "Do not capture later unrelated exceptions");
});

test("actual preload source rejection reaches the real owner over stubbed IPC and terminal close", async t => {
    let selected, child, preload;
    const mocked = t.mock.method(childProcess, "fork", () => {
        child = new EventEmitter();
        Object.assign(child, { exitCode: null, signalCode: null, killed: false,
            kill() {
                if (child.killed || child.exitCode !== null) return;
                child.killed = true;
                queueMicrotask(() => { child.signalCode = "SIGTERM"; child.emit("close", null); });
            },
            send(message, callback) {
                assert.equal(message.kind, "initialize");
                queueMicrotask(() => {
                    preload = realm({ ...selected,
                        onMessage: result => child.emit("message", result),
                        onExit: code => { if (!child.killed) { child.exitCode = code; child.emit("close", code); } },
                    });
                    assert.equal(preload.preload(), false);
                    callback?.(null);
                });
            },
        });
        return child;
    });
    syncBuiltinESMExports();
    t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
    for (const [options, code] of [
        [{ resolveError: true }, "runtime-missing"],
        [{ badHash: true }, "runtime-corrupt"],
        [{ fileError: { operation: "read", code: "EACCES" } }, "runtime-unreadable"],
        [{ badFlags: true }, "runtime-guard-launch"],
        [{ assetsError: true }, "model-process-failed"],
    ]) {
        selected = options;
        const model = createSearchModel();
        await assert.rejects(model.embed("invented"), { code });
        assert.equal(model.status().code, code);
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(preload.children.length, 0);
        await model.close();
    }
});

test("stubbed entry publishes thread ID before readiness and preserves entry receiver/args/return", () => {
    const main = realm(), guard = main.load(), worker = main.createWorker();
    assert.equal(main.signal().byteLength, 12);
    assert.deepEqual([...main.signal()], [0, 0, 0]);
    const child = realm({ main: false, data: main.data, beforeForward: () => {
        assert.deepEqual([...main.signal()], [1, 0, worker.threadId]);
        guard.assertReady(2);
    } });
    child.load();
    assert.deepEqual([...main.signal()], [0, 0, 0], "Bootstrap is not final entry attestation");
    const receiver = {};
    assert.equal(child.enter(receiver), child.result);
    assert.equal(child.forwards[0].receiver, receiver);
    assert.deepEqual(child.forwards[0].args, [runtimePath, "unchanged-extra-argument"]);
    guard.assertReady(2);
    assert.throws(() => child.nodeModule.runMain(runtimePath), { code: "runtime-entry-repeated" });
    assert.equal(Atomics.load(main.signal(), 1), 1);
    assert.throws(() => guard.assertReady(2), { code: "runtime-isolation-failed" });
    assert.ok(child.kills.every(value => value.pid === 424242 && value.signal === "SIGTERM"));
});

test("stubbed guard rejects bootstrap-only, wrong thread ID, changed entry and single-thread fallback", () => {
    {
        const main = realm(), guard = main.load();
        main.createWorker();
        realm({ main: false, data: main.data }).load();
        assert.throws(() => guard.assertReady(2), { code: "runtime-guard-not-ready" });
    }
    {
        const main = realm(), guard = main.load();
        main.createWorker();
        const child = realm({ main: false, data: main.data, threadId: 99 });
        child.load(); child.enter();
        assert.throws(() => guard.assertReady(2), { code: "runtime-guard-not-ready" });
    }
    {
        const main = realm(); main.load(); main.createWorker();
        const child = realm({ main: false, data: main.data });
        child.load(); child.process.argv.push(runtimePath);
        assert.throws(() => child.nodeModule.runMain(path.join(runtimeRoot, "unapproved.mjs")), { code: "runtime-guard-entry" });
        assert.equal(Atomics.load(main.signal(), 0), 0);
        assert.equal(child.forwards.length, 0);
    }
    {
        const main = realm(), guard = main.load(); main.createWorker();
        const child = realm({ main: false, data: main.data }); child.load(); child.enter();
        assert.throws(() => guard.assertReady(1), { code: "runtime-guard-not-ready" });
    }
});

test("stubbed guard rejects missing state/hooks and wrong main or pthread entry shapes", () => {
    const wrongMain = realm();
    wrongMain.process.argv.push("unexpected");
    assert.throws(() => wrongMain.load(), { code: "runtime-guard-launch" });
    assert.throws(() => realm({ main: false }).load(), { code: "runtime-guard-state" });
    const spent = new SharedArrayBuffer(12), spentState = new Int32Array(spent);
    Atomics.store(spentState, 1, 1);
    assert.throws(() => realm({ data: new Map([[`wire-search:${SEARCH_RUNTIME.guard}`, spent]]) }).load(),
        { code: "runtime-guard-state" });
    assert.equal(Atomics.load(spentState, 1), 1, "Another preload cannot reset an existing failure");
    const main = realm(); main.load(); main.createWorker();
    const missingHook = realm({ main: false, data: main.data });
    missingHook.nodeModule.runMain = undefined;
    assert.throws(() => missingHook.load(), { code: "runtime-entry-hook-missing" });
    const next = realm(); next.load(); next.createWorker();
    const wrongArgv = realm({ main: false, data: next.data });
    wrongArgv.load(); wrongArgv.process.argv.push(path.join(runtimeRoot, "wrong-entry.mjs"));
    assert.throws(() => wrongArgv.nodeModule.runMain(runtimePath), { code: "runtime-guard-entry" });
    assert.equal(wrongArgv.forwards.length, 0);
    assert.equal(Atomics.load(next.signal(), 0), 0);
    const wrongDataParent = realm(); wrongDataParent.load(); wrongDataParent.createWorker();
    assert.throws(() => realm({ main: false, data: wrongDataParent.data, workerData: "unexpected" }).load(),
        { code: "runtime-guard-launch" });
});

test("stubbed guard keeps exact constructor options, one Worker, no nested Worker and module integrity", () => {
    for (const expression of [
        '{ type: "module", workerData: "wrong", name: "em-pthread" }',
        '{ type: "module", workerData: "em-pthread", name: "em-pthread", env: {} }',
    ]) {
        const main = realm(); main.load();
        assert.throws(() => main.createWorker(expression), { code: "runtime-worker-target" });
        assert.equal(main.children.length, 0);
    }
    const main = realm(); main.load(); main.createWorker();
    const child = realm({ main: false, data: main.data }); child.load(); child.enter();
    assert.throws(() => child.createWorker(), { code: "runtime-worker-limit" });
    assert.equal(child.children.length, 0);
    const other = realm(); other.load(); other.createWorker();
    assert.throws(() => other.createWorker(), { code: "runtime-worker-limit" });
    assert.equal(other.children.length, 1);
    assert.throws(() => realm({ badHash: true }).load(), { code: "runtime-corrupt" });
});

test("stubbed cleanup never reads platform values and rejects unknown keys and flags", () => {
    const env = { SystemRoot: "invented-system", TEMP: "invented-temp" };
    for (const key of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "USERPROFILE"]) {
        Object.defineProperty(env, key, { configurable: true, enumerable: true, get() { throw new Error("Value must not be read"); } });
    }
    const main = realm({ env }); main.load();
    assert.deepEqual(Object.keys(env).sort(), ["SystemRoot", "TEMP"]);
    assert.throws(() => realm({ env: { SystemRoot: "invented", UNEXPECTED: "invented" } }).load(), { code: "runtime-guard-environment" });
    assert.throws(() => realm({ badFlags: true }).load(), { code: "runtime-guard-launch" });
    assert.throws(() => realm({ env: {} }).load(), { code: "runtime-guard-launch" });
    assert.doesNotThrow(() => realm({ platform: "linux", env: { TMPDIR: "invented-temp" } }).load());
    assert.doesNotThrow(() => realm({ version: "24.20.0" }).load(), "No patch-version-only availability restriction");
    assert.throws(() => realm({ version: "23.0.0" }).load(), { code: "runtime-guard-launch" });
});

test("stubbed network denial is sticky and pthread failures target only the owned OS process", () => {
    for (const event of ["error", "exit", "terminate"]) {
        const main = realm(), guard = main.load(), worker = main.createWorker();
        const child = realm({ main: false, data: main.data }); child.load(); child.enter();
        if (event === "terminate") assert.throws(() => worker.terminate(), { code: "runtime-worker-termination" });
        else worker.emit(event, event === "error" ? new Error("invented") : 1);
        assert.deepEqual(main.kills, [{ pid: 424242, signal: "SIGTERM" }]);
        assert.equal(Atomics.load(main.signal(), 1), 1);
        assert.throws(() => guard.assertReady(2));
    }
    for (const event of ["uncaughtExceptionMonitor", "exit", "network"]) {
        const main = realm(), guard = main.load(); main.createWorker();
        const child = realm({ main: false, data: main.data }); child.load(); child.enter();
        if (event === "network") assert.throws(() => child.context.fetch(), { code: "network-denied" });
        else child.process.emit(event);
        assert.deepEqual(child.kills, [{ pid: 424242, signal: "SIGTERM" }]);
        assert.throws(() => guard.assertReady(2), { code: "runtime-isolation-failed" });
        assert.equal(Atomics.load(main.signal(), 1), 1);
    }
    const main = realm(), guard = main.load();
    assert.throws(() => main.context.fetch(), { code: "network-denied" });
    assert.throws(() => guard.assert(), { code: "network-denied" });
});

test("execution identity truthfully changes while the fixed model and runtime files do not", t => {
    const { guard, ...controlRuntime } = SEARCH_RUNTIME;
    controlRuntime.threads = 1;
    assert.equal(searchHash(JSON.stringify([SEARCH_MODEL, controlRuntime])),
        "d6e239039bba5370df94f090b3340735bcb4ee7dacab4c8ad35dd6c7a29fff72");
    assert.equal(SEARCH_RUNTIME.threads, 2);
    assert.equal(guard, "fixed-pthread-entry-v1");
    assert.equal(SEARCH_MODEL_ID, searchHash(JSON.stringify([SEARCH_MODEL, SEARCH_RUNTIME])));
    assert.notEqual(SEARCH_MODEL_ID, searchHash(JSON.stringify([SEARCH_MODEL, controlRuntime])));
    t.diagnostic(`Candidate execution identity: ${SEARCH_MODEL_ID}`);
});
