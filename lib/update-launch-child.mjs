import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { armChild, assertChildClosed, privateError } from "./update-launch-state.mjs";

const closedError = () => privateError("The owned WIRE runtime did not confirm the requested operation.");
const deferred = () => Promise.withResolvers();
function deadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(closedError()), ms); })])
        .finally(() => clearTimeout(timer));
}
function send(child, message) {
    return new Promise((resolve, reject) => {
        if (!child.connected) { reject(closedError()); return; }
        child.send(message, error => error ? reject(closedError()) : resolve());
    });
}

export function spawnOwned({ directory, location, commit, port, request, onExit }) {
    const id = armChild(directory);
    const child = fork(path.join(location, "scripts", "start.mjs"), ["--port", String(port)], {
        cwd: location, stdio: ["inherit", "inherit", "inherit", "ipc"], execArgv: [],
        // A non-detached Windows spawn is in libuv's kill-on-parent-exit
        // job. Allow the child to handle IPC disconnect and finish its writer
        // receipt instead. The launcher still owns and awaits this fork:
        // no unref, daemon, extra window, or independently managed service.
        detached: process.platform === "win32", windowsHide: true,
        env: { ...process.env, WIRE_UPDATE_DIRECTORY: directory, WIRE_UPDATE_CHILD: id, WIRE_UPDATE_BUILD: commit, WIRE_UPDATE_LAUNCHER: "1" },
    });
    const announced = deferred(), ended = deferred();
    let closed, intentional = false, waiter, stopPromise;
    child.on("error", () => announced.reject(closedError()));
    child.once("close", (code, signal) => {
        closed = { code, signal };
        announced.reject(closedError());
        waiter?.reject(closedError());
        ended.resolve(closed);
        onExit(owned, intentional);
    });
    child.on("message", async message => {
        if (message?.type === "wire-update-ready") announced.resolve(message);
        else if (message?.type === "wire-update-quiesced" && waiter && message.id === waiter.id) waiter.resolve(message);
        else if (message?.type === "wire-update-request" && !intentional) {
            let response;
            try { response = { value: await request(owned, message.request) }; }
            catch (error) { response = { error: error.code === "WIRE_LAUNCH" ? error.message : "The update request could not be completed." }; }
            await send(child, { type: "wire-update-response", id: message.id, ...response }).catch(() => {});
        }
    });
    const owned = {
        async ready() {
            const ready = await deadline(announced.promise, 90000);
            const url = new URL(ready.url);
            if (!/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})\/$/.test(ready.url)
                || port !== 0 && Number(url.port || 80) !== port || commit !== ready.build || typeof ready.runtimeId !== "string"
                || !/^\/assets\/client\/[\w-]+-[\w-]{8,}\.js$/.test(ready.clientEntry)) throw closedError();
            const fetchLocal = dest => fetch(new URL(dest, url), { redirect: "error", signal: AbortSignal.timeout(5000) });
            const health = await fetchLocal("/health");
            const body = await health.json();
            if (!health.ok || body.service !== "workiq-evidence" || body.protocol !== 1 || body.runtimeId !== ready.runtimeId
                || body.build !== commit || body.clientEntry !== ready.clientEntry) throw closedError();
            const client = await fetchLocal(ready.clientEntry);
            await client.body?.cancel();
            if (closed || !client.ok || !/javascript/.test(client.headers.get("content-type"))) throw closedError();
            return { port: Number(url.port || 80), clientEntry: ready.clientEntry };
        },
        async quiesce() {
            waiter = { ...deferred(), id: randomUUID() };
            try {
                const [, result] = await deadline(Promise.all([
                    send(child, { type: "wire-update-quiesce", id: waiter.id }), waiter.promise,
                ]), 30000);
                if (result.ok !== true) throw privateError("WIRE is busy or access changed. Finish the current operation, then try updating again.");
            } finally { waiter = undefined; }
        },
        resume() { return send(child, { type: "wire-update-resume" }); },
        stop() {
            intentional = true;
            return stopPromise ??= (async () => {
                if (!closed && child.connected) await send(child, { type: "wire-update-stop" }).catch(() => {});
                const result = await deadline(ended.promise, 45000);
                const state = assertChildClosed(directory, id);
                if (result.signal || result.code !== (state === "closed" ? 0 : 1)) throw closedError();
            })();
        },
    };
    return owned;
}
