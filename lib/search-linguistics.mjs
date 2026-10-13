import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SearchError } from "./search-model-assets.mjs";
import { searchModelEnvironment } from "./search-model.mjs";
import { SEARCH_INTENT_POLICY_ID } from "./search-linguistics-assets.mjs";
import { validSearchIntent } from "./search-intent.mjs";

export function createSearchLinguistics({ directory, onActivity = () => {} } = {}) {
    if (directory !== undefined && typeof directory !== "string" || typeof onActivity !== "function") throw new TypeError("Invalid linguistic options.");
    let child, pending, closing = Promise.resolve(), ready = false, closed = false, version = 0, active = 0;
    let info = { state: directory === undefined ? "disabled" : "uninitialized", policyId: SEARCH_INTENT_POLICY_ID,
        loadMs: null, operationMs: null, rss: null, peakRss: null };
    function kill() {
        ready = false;
        if (child) { const owned = child; child = null; owned.kill(); }
        return closing;
    }
    function cancel() {
        version++;
        if (directory !== undefined) info = { ...info, state: closed ? "closed" : "cancelled" };
        if (pending) { const reject = pending.reject; pending = null; reject(new SearchError("linguistics-cancelled")); }
        return kill();
    }
    function spawn() {
        const owned = fork(fileURLToPath(new URL("./search-linguistics-worker.mjs", import.meta.url)), [], {
            execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"], serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"], env: searchModelEnvironment(),
        });
        child = owned;
        closing = new Promise(resolve => owned.once("close", () => {
            if (child === owned) {
                child = null; ready = false;
                if (pending) { pending.reject(new SearchError("linguistics-process-failed")); pending = null; }
            }
            resolve();
        }));
        owned.on("error", () => {
            if (child === owned && pending) { pending.reject(new SearchError("linguistics-process-failed")); pending = null; }
            owned.kill();
        });
        owned.on("message", message => {
            if (child !== owned || !pending) return;
            if (!message || typeof message !== "object" || Array.isArray(message)
                || message.policyId !== SEARCH_INTENT_POLICY_ID) {
                pending.reject(new SearchError("linguistics-protocol")); pending = null; kill(); return;
            }
            if (["computing", "computed"].includes(message.kind)) { onActivity(Object.freeze({ state: message.kind })); return; }
            const job = pending; pending = null;
            if (message.ok !== true) {
                job.reject(new SearchError(message.ok === false && typeof message.code === "string"
                    && /^linguistics-[a-z-]+$/.test(message.code) ? message.code : "linguistics-protocol"));
                kill();
            } else if (!Number.isFinite(message.ms) || message.ms < 0
                || !Number.isSafeInteger(message.rss) || message.rss < 0
                || !Number.isSafeInteger(message.peakRss) || message.peakRss < message.rss) {
                job.reject(new SearchError("linguistics-protocol")); kill();
            } else job.resolve(message);
        });
        onActivity(Object.freeze({ state: "starting" }));
    }
    const request = message => new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.send(message, error => {
            if (error && pending?.resolve === resolve) { pending = null; reject(new SearchError("linguistics-process-failed")); kill(); }
        });
    });
    async function perform(message, signal) {
        if (directory === undefined || closed || signal?.aborted) throw new SearchError("linguistics-unavailable");
        if (active) cancel();
        const token = ++version; active = token;
        const ensure = () => { if (closed || signal?.aborted || token !== version) throw new SearchError("linguistics-cancelled"); };
        const abort = () => { if (token === version) cancel(); };
        signal?.addEventListener("abort", abort, { once: true });
        let ownedExit = closing;
        try {
            if (!child) { await closing; ensure(); spawn(); }
            ownedExit = closing;
            ensure();
            if (!ready) {
                info = { ...info, state: "loading" };
                const loaded = await request({ kind: "initialize", directory });
                ensure();
                if (loaded.kind !== "ready") throw new SearchError("linguistics-protocol");
                ready = true; info = { ...info, loadMs: loaded.ms, rss: loaded.rss, peakRss: loaded.peakRss };
            }
            info = { ...info, state: "computing" };
            const result = await request(message);
            ensure();
            info = { ...info, state: "ready", code: undefined, operationMs: result.ms, rss: result.rss,
                peakRss: Math.max(info.peakRss ?? 0, result.peakRss) };
            return result;
        } catch (error) {
            if (token === version) {
                kill(); info = { ...info, state: "unavailable", code: error instanceof SearchError ? error.code : "linguistics-failed" };
            }
            await ownedExit;
            throw error instanceof SearchError ? error : new SearchError("linguistics-failed");
        } finally {
            signal?.removeEventListener("abort", abort);
            if (active === token) active = 0;
        }
    }
    return {
        enabled: directory !== undefined,
        status: () => Object.freeze({ ...info }),
        cancel,
        close() { closed = true; return cancel(); },
        async prepare(items, { signal } = {}) {
            const result = await perform({ kind: "prepare", items }, signal);
            if (result.kind !== "prepared" || !Array.isArray(result.items) || result.items.length !== items.length
                || result.items.some((item, i) => !item || item.id !== items[i].id || item.revision !== items[i].revision
                    || !validSearchIntent(item.intent, items[i].text))) {
                await cancel(); throw new SearchError("linguistics-protocol");
            }
            return result.items;
        },
        async match(query, items, { signal } = {}) {
            const result = await perform({ kind: "match", query, items }, signal);
            const admitted = new Map(items.map(item => [item.id, item.revision]));
            if (result.kind !== "matched" || !Array.isArray(result.hits)
                || result.hits.some(hit => !hit || !admitted.has(hit.id) || admitted.get(hit.id) !== hit.revision)
                || new Set(result.hits.map(hit => hit.id)).size !== result.hits.length) {
                await cancel(); throw new SearchError("linguistics-protocol");
            }
            return result.hits;
        },
    };
}
