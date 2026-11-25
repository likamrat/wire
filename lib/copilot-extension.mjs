import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createRuntimeClient } from "./runtime-client.mjs";
import { createHostedRuntime } from "./hosted-runtime.mjs";
import { DEFAULT_RUNTIME_PORT } from "./runtime-endpoint.mjs";
import { createCopilotAccountBridge } from "./copilot-account-snapshot.mjs";
import { canvasDeclaration, canvasActions, agentTools } from "./copilot-extension-manifest.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defaultDataDir } from "./paths.mjs";
import { buildBundle, writeBundle, verdictsTemplate } from "./mcp-diagnostics/collect.mjs";
import { inspectBundle } from "./mcp-diagnostics/inspect.mjs";

const panels = new Map();
const runtimes = new Map();
let joinedSession;
const accountBridge = createCopilotAccountBridge(() => joinedSession);
const runtimeFor = port => {
    if (!runtimes.has(port)) runtimes.set(port, createHostedRuntime({ port }));
    return runtimes.get(port);
};

async function ensureRuntime(port) {
    if (superseded) throw new CanvasError("runtime_update_required", "WIRE was updated. Start a new chat or reload extensions to use the new version.");
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
    async wire_diagnostic_calls(input) {
        return (await agent()).action(AGENT_INSTANCE, "get_diagnostic_calls", input);
    },
    async wire_diagnostic_bundle({ from, to, tools, captureScope = "sample", profile = "internal", verdicts, reviewedNarrative = false, save = false }) {
        const calls = await (await agent()).action(AGENT_INSTANCE, "get_diagnostic_calls",
            { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(tools?.length ? { tools } : {}) });
        if (captureScope === "complete" && !calls.coverage.complete) {
            throw Object.assign(new Error("This window isn't completely covered, so a failure rate can't be stated. Use captureScope sample."), { code: "incomplete-capture" });
        }
        const bundle = buildBundle(calls.records, {
            server: "workiq", org: "wire", adapter: "wire", profile, captureScope,
            ...(captureScope === "complete" ? { expectedCalls: calls.totals.calls, expectedFailures: calls.totals.hostFailures } : {}),
            ...(verdicts ? { verdicts } : {}), reviewedNarrative,
        });
        const clusters = JSON.parse(bundle.files["clusters.json"]).map(({ id, tool, signature_display, count, adjusted_count, sessions, distinct_days, first_seen, last_seen, error_codes, status_codes, verdict }) =>
            ({ id, tool, signature_display, count, adjusted_count, sessions, distinct_days, first_seen, last_seen, error_codes, status_codes, verdict }));
        const result = { totals: calls.totals, coverage: calls.coverage, report: bundle.report, clusters, warnings: bundle.warnings,
            verdictsTemplate: verdictsTemplate() };
        if (!save) return { saved: false, ...result };
        const directory = path.join(path.dirname(process.env.WORKIQ_EVIDENCE_DATA_DIR || defaultDataDir()), "diagnostics");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const archive = writeBundle(bundle, directory);
        const reportPath = archive.replace(/\.zip$/, ".md");
        await writeFile(reportPath, bundle.report, { flag: "wx", mode: 0o600 });
        const { report, ...rest } = result;
        return { saved: true, archive, reportPath, ...rest };
    },
    async wire_inspect_bundle({ path: file }) {
        if (!path.isAbsolute(file) || !file.toLowerCase().endsWith(".zip")) throw new Error("Give the absolute path of a .zip bundle.");
        const { summary: s } = await inspectBundle(file);
        return { accepted: true, bundleId: s.bundle_id, captureScope: s.capture_scope, profile: s.profile, window: s.window,
            volume: s.volume, rateReason: s.rate_reason, reconciliation: s.reconciliation, payloadScan: s.payload_scan,
            limitations: s.limitations, warnings: s.warnings,
            clusters: s.clusters.map(({ id, tool, count, adjusted_count, distinct_days, first_seen, last_seen, error_codes, status_codes, verdict, evidence_track }) =>
                ({ id, tool, count, adjusted_count, distinct_days, first_seen, last_seen, error_codes, status_codes, verdict, evidence_track })) };
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

// A plugin update replaces this bundle on disk. The runtime this process started then
// stops, so the next canvas or tool request starts the updated WIRE instead of reusing this one.
const bundleFile = fileURLToPath(import.meta.url);
const bundleStamp = file => { try { const info = statSync(file); return `${info.size}:${info.mtimeMs}`; } catch { return "missing"; } };
const loadedStamp = bundleStamp(bundleFile);
let superseded = false;
const updateWatch = setInterval(() => {
    if (bundleStamp(bundleFile) === loadedStamp) return;
    superseded = true;
    clearInterval(updateWatch);
    void Promise.allSettled([...runtimes.values()].map(runtime => runtime.close()));
}, 15000);
updateWatch.unref();

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
