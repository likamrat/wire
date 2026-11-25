import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createRuntimeClient } from "./runtime-client.mjs";
import { createHostedRuntime } from "./hosted-runtime.mjs";
import { DEFAULT_RUNTIME_PORT } from "./runtime-endpoint.mjs";
import { createCopilotAccountBridge } from "./copilot-account-snapshot.mjs";
import { canvasDeclaration, canvasActions, agentTools } from "./copilot-extension-manifest.mjs";

const panels = new Map();
const runtimes = new Map();
let joinedSession;
const accountBridge = createCopilotAccountBridge(() => joinedSession);
const runtimeFor = port => {
    if (!runtimes.has(port)) runtimes.set(port, createHostedRuntime({ port }));
    return runtimes.get(port);
};

async function ensureRuntime(port) {
    const hosted = runtimeFor(port);
    try { await hosted.ensure(); }
    catch (error) {
        if (error.code === "WIRE_COPILOT_STORE_INCOMPATIBLE") throw new CanvasError("runtime_update_required", error.message);
        throw new CanvasError("runtime_unavailable", port === DEFAULT_RUNTIME_PORT
            ? `WIRE could not start inside the Copilot app (${error.code ?? "startup failed"}). Another program may be using port ${port}.`
            : `Could not connect to WIRE on port ${port}. Check the URL printed by the intended checkout. No other runtime was tried.`);
    }
    return hosted;
}

async function bind(instanceId, port) {
    const hosted = await ensureRuntime(port);
    const panel = { port, runtime: createRuntimeClient(hosted.origin, { requireEnforced: true }) };
    panels.set(instanceId, panel);
    try {
        const result = await panel.runtime.open(instanceId);
        if (panels.get(instanceId) !== panel) throw new CanvasError("runtime_changed", "This WIRE canvas was closed.");
        panel.ready = true;
        return result;
    } catch (error) {
        if (panels.get(instanceId) === panel) panels.delete(instanceId);
        throw error;
    }
}

async function openPanel(ctx) {
    const previous = panels.get(ctx.instanceId);
    const port = ctx.input?.runtimePort ?? previous?.port ?? DEFAULT_RUNTIME_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CanvasError("invalid_port", "Use the port printed by WIRE.");
    if (previous && port !== previous.port) throw new CanvasError("runtime_changed", "Use a separate canvas for another WIRE runtime.");
    try {
        if (!previous) return await bind(ctx.instanceId, port);
        await ensureRuntime(port);
        try { return await previous.runtime.open(ctx.instanceId); }
        catch (error) {
            // The runtime that served this panel has gone; reopening binds a new one without replaying anything.
            if (error.code !== "WIRE_CANVAS_BINDING_CHANGED" && !(error instanceof TypeError)) throw error;
            panels.delete(ctx.instanceId);
            await previous.runtime.close(ctx.instanceId).catch(() => {});
            return await bind(ctx.instanceId, port);
        }
    } catch (error) {
        if (error instanceof CanvasError) throw error;
        if (error.code === "WIRE_CLIENT_UPDATE_REQUIRED") throw new CanvasError("runtime_update_required", error.message);
        if (error.code === "WIRE_CANVAS_BINDING_CHANGED") throw new CanvasError("runtime_changed", error.message);
        throw new CanvasError("runtime_unavailable", `Could not connect to WIRE on port ${port}. No other runtime was tried.`);
    }
}

const AGENT_INSTANCE = "copilot-agent-tools";
let agentClient;
async function agent() {
    const hosted = await ensureRuntime(DEFAULT_RUNTIME_PORT);
    agentClient ??= createRuntimeClient(hosted.origin);
    return agentClient;
}

function failure(error) {
    const reason = error.code ? ` (${error.code})` : "";
    return { resultType: "failure", textResultForLlm: `${error.message || "WIRE could not complete this read."}${reason} Nothing was changed.` };
}

const toolHandlers = {
    async wire_status() {
        const client = await agent();
        const [collection, summary] = await Promise.all([
            client.action(AGENT_INSTANCE, "collection_status", {}),
            client.action(AGENT_INSTANCE, "get_summary", {}),
        ]);
        return { collection, summary };
    },
    async wire_analytics(input) {
        return (await agent()).action(AGENT_INSTANCE, "get_analytics", input ?? {});
    },
    async wire_search({ query, types, limit = 25 }) {
        const outcome = await (await agent()).search(AGENT_INSTANCE, { query, types });
        const hits = outcome.results?.matches.hits ?? [];
        return {
            state: outcome.state,
            total: hits.length,
            returned: Math.min(hits.length, limit),
            coverage: outcome.status?.corpus ? { state: outcome.status.corpus.state, issues: outcome.status.corpus.issues ?? [] } : null,
            hits: hits.slice(0, limit).map(hit => ({ type: hit.type, title: hit.title, source: hit.source?.label ?? null, excerpt: hit.excerpt })),
        };
    },
};

joinedSession = await joinSession({
    tools: { definitions: [
        accountBridge.tool,
        ...agentTools.map(tool => ({
            ...tool,
            async handler(input) {
                try { return { resultType: "success", textResultForLlm: JSON.stringify(await toolHandlers[tool.name](input ?? {})) }; }
                catch (error) { return failure(error); }
            },
        })),
    ] },
    canvases: { definitions: [createCanvas({
        ...canvasDeclaration,
        open: openPanel,
        actions: canvasActions.map(action => ({
            ...action,
            handler: async ctx => {
                const panel = panels.get(ctx.instanceId);
                if (!panel?.ready) throw new CanvasError("runtime_unavailable", "Open this WIRE canvas before using its actions.");
                try { return await panel.runtime.action(ctx.instanceId, ctx.actionName, ctx.input ?? {}); }
                catch (error) { throw new CanvasError("runtime_action_failed", error.message || "Local runtime unavailable. No action was replayed."); }
            },
        })),
        onClose: async ctx => {
            const panel = panels.get(ctx.instanceId);
            panels.delete(ctx.instanceId);
            await panel?.runtime.close(ctx.instanceId);
        },
    })] },
});

let stopping;
function stop() {
    stopping ??= (async () => {
        accountBridge.close();
        await Promise.allSettled([...runtimes.values()].map(runtime => runtime.close()));
        process.exit(0);
    })();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
