import { startServer } from "./server.mjs";
import { createExportController } from "./export.mjs";
import { defaultDataDir } from "./paths.mjs";
import { createCopilotRuntimeAccess } from "./runtime-access.mjs";
import { DEFAULT_RUNTIME_PORT } from "./runtime-endpoint.mjs";

export async function compatibleRuntime(origin) {
    try {
        const response = await fetch(origin + "/health", { redirect: "error", signal: AbortSignal.timeout(2000) });
        const body = await response.json();
        return response.ok && body?.service === "workiq-evidence" && body.protocol === 1;
    } catch { return false; }
}

async function startOwnedRuntime(port) {
    const context = { dataDir: process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir(), sessionId: null };
    let access;
    try {
        const runtime = await startServer(context, createExportController(context), {
            port, frontend: "bundled", sourcePolicy: "copilot-only", collector: { timers: true },
            createAccess: async () => (access = await createCopilotRuntimeAccess(context)),
        });
        return { url: runtime.url, async close() {
            const finished = runtime.close();
            runtime.server.closeIdleConnections();
            await finished;
            await access?.close();
        } };
    } catch (error) {
        await access?.close().catch(() => {});
        throw error;
    }
}

// One process owns the store through the exclusive port bind; other Copilot
// sessions reuse that runtime and take over only after it has gone away.
export function createHostedRuntime({ port = DEFAULT_RUNTIME_PORT, start = startOwnedRuntime, probe = compatibleRuntime } = {}) {
    const origin = `http://127.0.0.1:${port}`;
    let owned, pending, closed = false;
    async function acquire() {
        if (owned) return origin;
        if (await probe(origin)) return origin;
        if (port !== DEFAULT_RUNTIME_PORT) throw Object.assign(new Error(`No WIRE runtime is listening on port ${port}.`), { code: "WIRE_RUNTIME_UNAVAILABLE" });
        try {
            const runtime = await start(port);
            if (closed) { await runtime.close(); throw Object.assign(new Error("WIRE is shutting down."), { code: "WIRE_RUNTIME_UNAVAILABLE" }); }
            owned = runtime;
            return origin;
        } catch (error) {
            if (error.code === "EADDRINUSE" && await probe(origin)) return origin;
            throw error;
        }
    }
    return {
        origin,
        get owner() { return Boolean(owned); },
        ensure() {
            if (closed) return Promise.reject(Object.assign(new Error("WIRE is shutting down."), { code: "WIRE_RUNTIME_UNAVAILABLE" }));
            pending ??= acquire().finally(() => { pending = undefined; });
            return pending;
        },
        async close() {
            closed = true;
            await pending?.catch(() => {});
            const runtime = owned;
            owned = undefined;
            await runtime?.close();
        },
    };
}
