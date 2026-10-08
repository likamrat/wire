import { PRODUCT_NAME } from "./branding.mjs";

export const RUNTIME_ORIGIN = "http://127.0.0.1:47831";

export function createRuntimeClient(origin = RUNTIME_ORIGIN) {
    const clients = new Map();
    const pending = new Map();
    const readOnly = new Set(["get_state", "reload_snapshot", "get_summary", "get_analytics", "get_snapshot"]);
    async function request(path, input, capability) {
        const response = await fetch(origin + path, {
            method: input === undefined ? "GET" : "POST",
            headers: {
                Origin: origin,
                ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                ...(capability ? { "X-Board-Capability": capability } : {}),
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            signal: AbortSignal.timeout(["refresh_history", "preview_export"].includes(input?.action) ? 120000 : 10000),
        });
        return { response, body: await response.json() };
    }
    async function connect(instanceId) {
        if (clients.has(instanceId)) return clients.get(instanceId);
        if (!pending.has(instanceId)) {
            const connection = (async () => {
                const health = await request("/health");
                if (!health.response.ok || health.body.service !== "workiq-evidence" || health.body.protocol !== 1) throw new Error(`Port 47831 is not a compatible ${PRODUCT_NAME} runtime.`);
                const result = await request("/api/session", {});
                if (!result.response.ok || !/^[a-f0-9]{64}$/.test(result.body.capability ?? "")) throw new Error("Local evidence connection could not be opened.");
                clients.set(instanceId, result.body.capability);
                return result.body.capability;
            })().finally(() => pending.delete(instanceId));
            pending.set(instanceId, connection);
        }
        return pending.get(instanceId);
    }
    return {
        async open(instanceId) {
            await connect(instanceId);
            return { title: PRODUCT_NAME, url: origin + "/" };
        },
        async action(instanceId, action, input) {
            const capability = await connect(instanceId);
            let result = await request("/api/canvas", { action, input }, capability);
            if (result.response.status === 403 && result.body.code === "session_expired") {
                if (clients.get(instanceId) === capability) clients.delete(instanceId);
                const renewed = await connect(instanceId);
                if (!readOnly.has(action)) throw new Error("Runtime connection changed. The action was not replayed; reread current state and prepare a new preview.");
                result = await request("/api/canvas", { action, input }, renewed);
            }
            if (!result.response.ok) throw new Error(result.body.error || "Local evidence action failed.");
            return result.body;
        },
        async close(instanceId) {
            if (pending.has(instanceId)) await pending.get(instanceId);
            const capability = clients.get(instanceId);
            clients.delete(instanceId);
            if (!capability) return;
            const result = await request("/api/session/release", {}, capability);
            if (!result.response.ok && result.body.code !== "session_expired") throw new Error("Local panel connection could not be released.");
        },
    };
}
