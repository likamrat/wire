"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");
const Module = require("node:module");
const threads = require("node:worker_threads");
const http = require("node:http"), https = require("node:https");
const net = require("node:net"), dns = require("node:dns"), dgram = require("node:dgram");
let state, failure, SearchError, preloadError;
const ENTRY = 0, FAILURE = 1, THREAD = 2;
function markFailure(code) {
    failure ??= code;
    if (state) Atomics.compareExchange(state, FAILURE, 0, 1);
}
function terminateOwner(code) {
    markFailure(code);
    process.kill(process.pid, "SIGTERM");
}
function fail(code) {
    markFailure(code);
    if (!threads.isMainThread) terminateOwner(code);
    const error = SearchError ? new SearchError(code) : Object.assign(new Error(`Local search unavailable (${code}).`), { code });
    if (threads.isMainThread) preloadError = error;
    throw error;
}
function preloadFailure(error) {
    if (error !== preloadError || !process.connected || typeof process.send !== "function") {
        process.exit(1);
        return;
    }
    // An uncaught preload failure cannot continue into the helper entry point.
    try { process.send({ ok: false, code: error.code }, () => process.exit(1)); }
    catch { process.exit(1); }
}
if (threads.isMainThread) process.once("uncaughtException", preloadFailure);
const deny = () => fail("network-denied");
globalThis.fetch = globalThis.WebSocket = globalThis.EventSource = deny;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny;
net.Socket.prototype.connect = dns.lookup = dns.resolve = dgram.createSocket = deny;
Module.syncBuiltinESMExports();
console.log = console.warn = console.error = console.info = console.debug = () => {};
if (!threads.isMainThread) {
    process.once("uncaughtExceptionMonitor", () => terminateOwner("runtime-worker-error"));
    process.once("exit", () => terminateOwner("runtime-worker-exited"));
}
const assets = require("./search-model-assets.mjs");
SearchError = assets.SearchError;
const { SEARCH_RUNTIME } = assets;
const flags = ["--disallow-code-generation-from-strings", "--require", fs.realpathSync(__filename)];
if (Number(process.versions.node.split(".")[0]) < 24 || JSON.stringify(process.execArgv) !== JSON.stringify(flags)
    || SEARCH_RUNTIME.threads !== 2) fail("runtime-guard-launch");
const allowedEnv = new Set(["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].map(key => key.toUpperCase()));
const windowsBootstrapEnv = new Set([
    "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "USERPROFILE",
]);
const startupKeys = Object.keys(process.env);
if (startupKeys.some(key => !allowedEnv.has(key.toUpperCase())
    && !(process.platform === "win32" && windowsBootstrapEnv.has(key.toUpperCase())))) fail("runtime-guard-environment");
// libuv adds these Windows keys before the preload; never read or retain their values.
for (const key of startupKeys) if (process.platform === "win32" && windowsBootstrapEnv.has(key.toUpperCase())) {
    if (!delete process.env[key]) fail("runtime-guard-environment");
}
const stateKey = `wire-search:${SEARCH_RUNTIME.guard}`;
const inherited = threads.getEnvironmentData(stateKey);
if (threads.isMainThread) {
    if (inherited !== undefined) fail("runtime-guard-state");
    state = new Int32Array(new SharedArrayBuffer(12));
    threads.setEnvironmentData(stateKey, state.buffer);
} else {
    if (!(inherited instanceof SharedArrayBuffer) || inherited.byteLength !== 12) fail("runtime-guard-state");
    state = new Int32Array(inherited);
}
let runtimeRoot;
try { runtimeRoot = path.dirname(path.dirname(require.resolve("onnxruntime-web"))); }
catch { fail("runtime-missing"); }
const moduleSpec = SEARCH_RUNTIME.files.find(spec => spec.name === "dist/ort-wasm-simd-threaded.mjs");
if (!moduleSpec) fail("runtime-guard-identity");
function runtimeFileFailure(error) {
    if (error instanceof SearchError) throw error;
    fail(["ENOENT", "ENOTDIR"].includes(error.code) ? "runtime-missing" : "runtime-unreadable");
}
let modulePath;
try { modulePath = fs.realpathSync(path.join(runtimeRoot, ...moduleSpec.name.split("/"))); }
catch (error) { runtimeFileFailure(error); }
const moduleUrl = pathToFileURL(modulePath).href;
function verifyModule() {
    try {
        const info = fs.lstatSync(modulePath);
        if (!info.isFile() || info.size !== moduleSpec.bytes
            || createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex") !== moduleSpec.sha256) {
            fail("runtime-corrupt");
        }
    } catch (error) { runtimeFileFailure(error); }
}
verifyModule();
let awaitingPthreadEntry = !threads.isMainThread, entryValidated = false, worker, workerCreated = false;
function assertGuards() {
    if (failure || Atomics.load(state, FAILURE)) fail(failure ?? "runtime-isolation-failed");
    const argvShape = awaitingPthreadEntry
        ? !threads.isMainThread && process.argv.length === 1 && threads.workerData === "em-pthread"
        : process.argv.length === 2;
    if (!argvShape || JSON.stringify(process.execArgv) !== JSON.stringify(flags)
        || Object.keys(process.env).some(key => !allowedEnv.has(key.toUpperCase()))
        || (process.platform === "win32" && !process.env.SystemRoot)) fail("runtime-guard-launch");
    if ([globalThis.fetch, globalThis.WebSocket, globalThis.EventSource, http.request, http.get, https.request,
        https.get, net.connect, net.createConnection, net.Socket.prototype.connect, dns.lookup, dns.resolve,
        dgram.createSocket].some(value => value !== deny)) fail("runtime-isolation-failed");
    if (threads.Worker !== GuardedWorker) fail("runtime-isolation-failed");
}
const NativeWorker = threads.Worker;
class GuardedWorker extends NativeWorker {
    constructor(filename, options) {
        assertGuards();
        if (!threads.isMainThread || workerCreated) fail("runtime-worker-limit");
        if (!(filename instanceof URL) || filename.href !== moduleUrl
            || fs.realpathSync(fileURLToPath(filename)) !== modulePath
            || !options || Object.getPrototypeOf(options) !== Object.prototype
            || JSON.stringify(Reflect.ownKeys(options).sort()) !== JSON.stringify(["name", "type", "workerData"])
            || ["name", "type", "workerData"].some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), "value"))
            || options.type !== "module" || options.workerData !== "em-pthread" || options.name !== "em-pthread") {
            fail("runtime-worker-target");
        }
        verifyModule();
        workerCreated = true;
        super(filename, options);
        worker = this;
        this.once("error", () => terminateOwner("runtime-worker-error"));
        this.once("exit", () => terminateOwner("runtime-worker-exited"));
    }
    terminate() {
        terminateOwner("runtime-worker-termination");
        fail("runtime-worker-termination");
    }
}
threads.Worker = GuardedWorker;
Module.syncBuiltinESMExports();
assertGuards();
const expectedEntry = threads.isMainThread ? path.join(__dirname, "search-model-worker.mjs") : modulePath;
function validateEntry() {
    assertGuards();
    if (awaitingPthreadEntry || entryValidated || typeof process.argv[1] !== "string"
        || fs.realpathSync(process.argv[1]) !== fs.realpathSync(expectedEntry)
        || (threads.isMainThread ? !process.connected : threads.workerData !== "em-pthread")) fail("runtime-guard-entry");
    entryValidated = true;
}
if (threads.isMainThread) {
    validateEntry();
} else {
    const originalRunMain = Module.runMain;
    if (typeof originalRunMain !== "function") fail("runtime-entry-hook-missing");
    let entryInvoked = false;
    Module.runMain = function (...args) {
        if (entryInvoked) fail("runtime-entry-repeated");
        entryInvoked = true;
        awaitingPthreadEntry = false;
        assertGuards();
        if (typeof args[0] !== "string" || fs.realpathSync(args[0]) !== modulePath) fail("runtime-guard-entry");
        verifyModule();
        validateEntry();
        Atomics.store(state, THREAD, threads.threadId);
        Atomics.store(state, ENTRY, 1);
        return Reflect.apply(originalRunMain, this, args);
    };
}
function assertReady(effectiveThreads) {
    assertGuards();
    if (!threads.isMainThread || !entryValidated || effectiveThreads !== SEARCH_RUNTIME.threads
        || !worker || Atomics.load(state, ENTRY) !== 1 || Atomics.load(state, THREAD) !== worker.threadId
        || Atomics.load(state, FAILURE)) fail("runtime-guard-not-ready");
}
module.exports = Object.freeze({ assert: assertGuards, assertReady });
if (threads.isMainThread) process.removeListener("uncaughtException", preloadFailure);
