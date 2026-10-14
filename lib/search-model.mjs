import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SearchError, SEARCH_MODEL_ID, defaultSearchModelDirectory } from "./search-model-assets.mjs";

export function searchModelEnvironment() {
    return Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]
        .filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]]));
}
export function createSearchModel({ directory = defaultSearchModelDirectory, onActivity = () => {} } = {}) {
    if (typeof directory !== "string" || typeof onActivity !== "function") throw new TypeError("A model directory and activity callback are required.");
    let child, closing = Promise.resolve(), pending, activeInvocation = 0, version = 0, closed = false, initialized = false;
    let info = { state: "uninitialized", modelId: SEARCH_MODEL_ID, coldMs: null, loadMs: null, inferenceMs: null, rss: null, peakRss: null };
    const status = () => Object.freeze({ ...info });
    function kill() {
        initialized = false;
        if (child) {
            const owned = child;
            child = null;
            owned.kill();
        }
        return closing;
    }
    function cancel() {
        version++;
        info = { ...info, state: closed ? "closed" : "cancelled" };
        if (pending) { const reject = pending.reject; pending = null; reject(new SearchError("model-cancelled")); }
        return kill();
    }
    function spawn() {
        const owned = fork(fileURLToPath(new URL("./search-model-worker.mjs", import.meta.url)), [], {
            execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings", "--require",
                fileURLToPath(new URL("./search-model-guard.cjs", import.meta.url))], serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"], env: searchModelEnvironment(),
        });
        child = owned;
        closing = new Promise(resolve => {
            owned.once("close", () => {
                if (child === owned) {
                    child = null; initialized = false;
                    if (pending) { const reject = pending.reject; pending = null; reject(new SearchError("model-process-failed")); }
                }
                resolve();
            });
        });
        owned.on("error", () => {
            if (child === owned && pending) { const reject = pending.reject; pending = null; reject(new SearchError("model-process-failed")); }
            owned.kill();
        });
        owned.on("message", message => {
            if (child !== owned || !pending) return;
            if (["computing", "computed"].includes(message?.kind)) { onActivity(Object.freeze({ state: message.kind })); return; }
            const job = pending;
            pending = null;
            if (message?.ok !== true) {
                const code = typeof message?.code === "string" && /^(?:model|runtime|network)-[a-z-]+$/.test(message.code)
                    ? message.code : "model-protocol";
                job.reject(new SearchError(code));
                kill();
            } else if (message.modelId !== SEARCH_MODEL_ID || !Number.isFinite(message.ms) || !Number.isSafeInteger(message.rss)
                || !Number.isSafeInteger(message.peakRss)) {
                job.reject(new SearchError("model-protocol")); kill();
            } else { job.resolve(message); }
        });
        onActivity(Object.freeze({ state: "starting" }));
    }
    function request(message) {
        return new Promise((resolve, reject) => {
            pending = { resolve, reject };
            child.send(message, error => {
                if (error && pending?.resolve === resolve) {
                    pending = null; reject(new SearchError("model-process-failed")); kill();
                }
            });
        });
    }
    return {
        status,
        cancel,
        close() { closed = true; return cancel(); },
        async embed(text, { signal } = {}) {
            if (typeof text !== "string") throw new TypeError("Search text must be a string.");
            if (closed) throw new SearchError("model-closed");
            if (signal?.aborted) throw new SearchError("model-cancelled");
            // IPC can clear pending before the previous embed continuation resumes.
            if (activeInvocation) cancel();
            const token = ++version;
            activeInvocation = token;
            let ownedExit = closing;
            let coldStarted;
            const ensure = () => { if (closed || signal?.aborted || token !== version) throw new SearchError("model-cancelled"); };
            const abort = () => { if (token === version) cancel(); };
            signal?.addEventListener("abort", abort, { once: true });
            try {
                if (!child) { await closing; ensure(); if (!child) { coldStarted = performance.now(); spawn(); } }
                ownedExit = closing;
                ensure();
                if (!initialized) {
                    coldStarted ??= performance.now();
                    info = { ...info, state: "loading" };
                    const ready = await request({ kind: "initialize", directory });
                    ensure();
                    if (ready.kind !== "ready") throw new SearchError("model-protocol");
                    initialized = true;
                    info = { ...info, coldMs: performance.now() - coldStarted, loadMs: ready.ms, rss: ready.rss,
                        peakRss: Math.max(info.peakRss ?? 0, ready.peakRss) };
                }
                ensure();
                info = { ...info, state: "computing" };
                const result = await request({ kind: "embed", text });
                ensure();
                if (result.kind !== "embedded" || !Array.isArray(result.chunks) || result.chunks.some(chunk =>
                    !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) || chunk.start < 0 || chunk.end > text.length
                    || chunk.start >= chunk.end || !Number.isSafeInteger(chunk.tokens) || chunk.tokens > 256
                    || !(chunk.vector instanceof Float32Array) || chunk.vector.length !== 384 || chunk.vector.some(n => !Number.isFinite(n)))) {
                    throw new SearchError("model-protocol");
                }
                let covered = 0;
                for (const chunk of result.chunks) {
                    if (chunk.start > covered || chunk.end <= covered || chunk.tokens < 2
                        || Math.abs(Math.hypot(...chunk.vector) - 1) > 1e-4) throw new SearchError("model-protocol");
                    covered = chunk.end;
                }
                if (covered !== text.length) throw new SearchError("model-protocol");
                info = { ...info, code: undefined, state: "ready", inferenceMs: result.ms, rss: result.rss,
                    peakRss: Math.max(info.peakRss ?? 0, result.peakRss) };
                return result.chunks;
            } catch (error) {
                if (token === version) {
                    kill();
                    info = { ...info, state: "unavailable", code: error instanceof SearchError ? error.code : "model-process-failed" };
                }
                await ownedExit;
                throw error instanceof SearchError ? error : new SearchError("model-process-failed");
            } finally {
                signal?.removeEventListener("abort", abort);
                if (activeInvocation === token) activeInvocation = 0;
            }
        },
    };
}
