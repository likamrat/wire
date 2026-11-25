import { PRODUCT_NAME } from "./branding.mjs";
import { RUNTIME_ORIGIN } from "./runtime-endpoint.mjs";

export { RUNTIME_ORIGIN } from "./runtime-endpoint.mjs";

const SEARCH_SCHEMA_VERSION = 3;

async function* ndjson(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) yield JSON.parse(line);
        }
    }
}

export function createRuntimeClient(origin = RUNTIME_ORIGIN, { requireEnforced = false } = {}) {
    const clients = new Map();
    const pending = new Map();
    const runtimes = new Map();
    const changed = () => Object.assign(new Error(
        "This canvas requires the original access-bound WIRE runtime. Check the printed URL and open a fresh canvas; no action was replayed."),
    { code: "WIRE_CANVAS_BINDING_CHANGED" });
    const readOnly = new Set(["get_state", "reload_snapshot", "get_summary", "get_analytics", "get_snapshot", "get_diagnostic_calls"]);
    async function request(path, input, capability) {
        const response = await fetch(origin + path, {
            redirect: "error",
            method: input === undefined ? "GET" : "POST",
            headers: {
                Origin: origin,
                ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                ...(capability ? { "X-Board-Capability": capability } : {}),
                ...(path === "/api/session" ? { "X-Wire-Session-Protocol": "1" } : {}),
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            signal: AbortSignal.timeout(["refresh_history", "preview_export"].includes(input?.action) ? 120000 : 10000),
        });
        return { response, body: await response.json() };
    }
    async function healthId(instanceId) {
        const health = await request("/health");
        if (!health.response.ok || health.body.service !== "workiq-evidence" || health.body.protocol !== 1) {
            throw new Error(`${origin} is not a compatible ${PRODUCT_NAME} runtime.`);
        }
        const original = runtimes.get(instanceId);
        if (requireEnforced && original && original !== health.body.runtimeId) throw changed();
        return health.body.runtimeId;
    }
    async function connect(instanceId) {
        if (clients.has(instanceId)) return clients.get(instanceId);
        if (!pending.has(instanceId)) {
            const connection = (async () => {
                const observed = await healthId(instanceId);
                const result = await request("/api/session", {});
                if (!result.response.ok && result.body?.code === "WIRE_CLIENT_UPDATE_REQUIRED") {
                    throw Object.assign(new Error(result.body.error), { code: result.body.code });
                }
                if (!result.response.ok || typeof result.body?.capability !== "string"
                    || !/^[a-f0-9]{64}$/.test(result.body.capability)) throw new Error("Local evidence connection could not be opened.");
                if (requireEnforced) {
                    const { runtimeId, capability, accessBootstrap: b } = result.body;
                    if (Object.keys(result.body).sort().join() !== "accessBootstrap,capability,runtimeId"
                        || typeof runtimeId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runtimeId)
                        || observed !== runtimeId || b?.runtimeId !== runtimeId || b.mode !== "enforced"
                        || Object.keys(b).sort().join() !== "collectionMode,freshnessMs,maxWaitMs,mode,runtimeId,schemaVersion"
                        || b.schemaVersion !== 1 || b.maxWaitMs !== 1000 || b.freshnessMs !== 5000
                        || !["copilot-only", "source-aware"].includes(b.collectionMode)) {
                        await request("/api/session/release", {}, capability);
                        throw changed();
                    }
                    runtimes.set(instanceId, runtimeId);
                }
                clients.set(instanceId, result.body.capability);
                return result.body.capability;
            })().finally(() => pending.delete(instanceId));
            pending.set(instanceId, connection);
        }
        return pending.get(instanceId);
    }
    return {
        async open(instanceId) {
            if (requireEnforced && clients.has(instanceId)) await healthId(instanceId);
            await connect(instanceId);
            return { title: PRODUCT_NAME, url: origin + "/" };
        },
        async action(instanceId, action, input) {
            const original = runtimes.get(instanceId);
            const originalPanel = clients.get(instanceId);
            const assertOriginal = () => {
                if (requireEnforced && (!original || original !== runtimes.get(instanceId)
                    || !originalPanel || originalPanel !== clients.get(instanceId))) throw changed();
            };
            assertOriginal();
            const capability = await connect(instanceId);
            assertOriginal();
            let result = await request("/api/canvas", { action, input }, capability);
            assertOriginal();
            if (result.response.status === 403 && result.body.code === "session_expired") {
                if (clients.get(instanceId) === capability) clients.delete(instanceId);
                // A replacement panel cannot inherit even a pending read across access generations.
                if (requireEnforced) throw changed();
                const renewed = await connect(instanceId);
                if (!readOnly.has(action)) throw new Error("Runtime connection changed. The action was not replayed; reread current state and prepare a new preview.");
                result = await request("/api/canvas", { action, input }, renewed);
            }
            if (!result.response.ok) throw new Error(result.body.error || "Local evidence action failed.");
            return result.body;
        },
        async search(instanceId, { query, types, timeoutMs = 60000 }) {
            const capability = await connect(instanceId);
            const headers = { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let attached = false;
            try {
                const stream = await fetch(origin + "/api/search/events", { method: "POST", redirect: "error", headers,
                    body: JSON.stringify({ schemaVersion: SEARCH_SCHEMA_VERSION }), signal: controller.signal });
                if (!stream.ok) {
                    const body = await stream.json().catch(() => ({}));
                    throw Object.assign(new Error(body.error || "Search is unavailable."), { code: body.code });
                }
                attached = true;
                const requestId = 1;
                let results = null;
                for await (const event of ndjson(stream.body)) {
                    if (event.event === "connected") {
                        const sent = await request("/api/search/query", { schemaVersion: SEARCH_SCHEMA_VERSION, purpose: "navigation",
                            query, requestId, ...(types?.length ? { types } : {}) }, capability);
                        if (!sent.response.ok) throw Object.assign(new Error(sent.body.error || "Search was refused."), { code: sent.body.code });
                        if (sent.body.state === "cancelled") return { state: "cancelled", results: null };
                    } else if (event.event === "fence") {
                        // Building the index fences earlier results; the queued query still completes.
                        if (event.reason === "indexing") { results = null; continue; }
                        throw Object.assign(new Error("Search was interrupted because WIRE's evidence changed. Search again."), { code: event.reason });
                    } else if (event.requestId !== requestId) continue;
                    else if (event.event === "results") results = event;
                    else if (event.event === "status" && !["queued", "searching", "building"].includes(event.state)) {
                        return { state: event.state, status: event.status ?? null, results };
                    }
                }
                throw new Error("Search ended before returning a result.");
            } catch (error) {
                if (controller.signal.aborted) throw Object.assign(new Error("Search did not finish in time. No result was returned."), { code: "search-timeout" });
                throw error;
            } finally {
                clearTimeout(timer);
                controller.abort();
                if (attached) await request("/api/search/close", {}, capability).catch(() => {});
            }
        },
        async close(instanceId) {
            if (pending.has(instanceId)) await pending.get(instanceId);
            const capability = clients.get(instanceId);
            clients.delete(instanceId);
            runtimes.delete(instanceId);
            if (!capability) return;
            const result = await request("/api/session/release", {}, capability);
            if (!result.response.ok && result.body.code !== "session_expired") throw new Error("Local panel connection could not be released.");
        },
    };
}
