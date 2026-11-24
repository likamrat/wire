import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { BOARD_ID } from "./lib/evidence.mjs";
import { ANALYTICS_SCHEMA, TIME_CONTEXT_SCHEMA } from "./lib/analytics-input.mjs";
import { createRuntimeClient } from "./lib/runtime-client.mjs";
import { DEFAULT_RUNTIME_PORT } from "./lib/runtime-endpoint.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "./lib/branding.mjs";
import { createCopilotAccountBridge } from "./lib/copilot-account-snapshot.mjs";

const panels = new Map();
let joinedSession;
const accountBridge = createCopilotAccountBridge(() => joinedSession);
const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const actions = [
    { name: "get_state", description: "Read local evidence and persisted review state.", inputSchema: schema({}) },
    { name: "get_summary", description: "Read coverage and safe bundle paths without original prompts.", inputSchema: schema({}) },
    { name: "get_analytics", description: "Read canonical layer counts and normalized endpoint groups.", inputSchema: ANALYTICS_SCHEMA },
    { name: "reload_snapshot", description: "Reread the existing local snapshot without collecting new evidence.", inputSchema: schema({}) },
    { name: "move_card", description: "Change local review state without changing measured outcome.", inputSchema: schema({ scenarioId: { type: "string" }, toState: { enum: ["captured", "reviewing", "ready_to_export"] } }, ["scenarioId", "toState"]) },
    { name: "preview_export", description: "Prepare an isolated agent-owned local preview; no files written. Defaults to masked prompts and HTML. Browser disclosure is a separate owner and cannot be bypassed. Never attest to real disclosure for a user.", inputSchema: schema({
        scenarioIds: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: { type: "string" } },
        selection: schema({
            kind: { enum: ["all", "current", "selected"] },
            revision: { type: "integer", minimum: 0 },
            scenarioIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
            promptAuthors: ANALYTICS_SCHEMA.properties.filters.properties.promptAuthors,
        }, ["kind", "revision"]),
        options: schema({
            timeContext: TIME_CONTEXT_SCHEMA,
            dateSelection: schema({ range: { enum: ["capture", "custom", "7", "30"] }, from: { type: "string", maxLength: 80 }, to: { type: "string", maxLength: 80 } }),
            promptMode: { enum: ["none", "masked", "original"] },
            formats: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: ["html", "pdf", "json", "markdown"] } },
            manualTerms: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 1000 } },
            overrides: { type: "array", maxItems: 3000, items: schema({ key: { type: "string", maxLength: 200 }, omit: { type: "boolean" }, text: { type: "string" } }, ["key"]) },
        }),
    }) },
    { name: "confirm_export", description: "Confirm only this owner’s already reviewed preview; browser disclosure cannot be forged or shared across owners.", inputSchema: schema({ previewId: { type: "string" }, confirmed: { const: true }, timeContext: TIME_CONTEXT_SCHEMA }, ["previewId", "confirmed"]) },
];

joinedSession = await joinSession({
    tools: [accountBridge.tool],
    canvases: [createCanvas({
        id: "workiq-evidence-board",
        displayName: PRODUCT_NAME,
        description: `${PRODUCT_DESCRIPTION}. Start its project runtime before opening; closing this canvas never stops collection storage or the server.`,
        inputSchema: schema({ boardId: { const: BOARD_ID }, runtimePort: { type: "integer", minimum: 1, maximum: 65535,
            description: "Port printed by the intended WIRE runtime. Defaults to 4000." } }, ["boardId"]),
        open: async ctx => {
            const previous = panels.get(ctx.instanceId);
            const port = ctx.input?.runtimePort === undefined ? previous?.port ?? DEFAULT_RUNTIME_PORT : ctx.input.runtimePort;
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CanvasError("invalid_port", "Use the port printed by WIRE.");
            if (previous && port !== previous.port) throw new CanvasError("runtime_changed", "Use a separate canvas for another WIRE runtime.");
            const panel = previous ?? { port, runtime: createRuntimeClient(`http://127.0.0.1:${port}`, { requireEnforced: true }) };
            panels.set(ctx.instanceId, panel);
            try {
                const result = await panel.runtime.open(ctx.instanceId);
                if (panels.get(ctx.instanceId) !== panel) throw new CanvasError("runtime_changed", "This WIRE canvas was closed.");
                panel.ready = true;
                return result;
            }
            catch (error) {
                if (error instanceof CanvasError) throw error;
                if (!previous && panels.get(ctx.instanceId) === panel) panels.delete(ctx.instanceId);
                if (error.code === "WIRE_CLIENT_UPDATE_REQUIRED") throw new CanvasError("runtime_update_required", error.message);
                if (error.code === "WIRE_CANVAS_BINDING_CHANGED") throw new CanvasError("runtime_changed", error.message);
                throw new CanvasError("runtime_unavailable", `Could not connect to WIRE on port ${port}. Check the URL printed by the intended checkout. No other runtime was tried.`);
            }
        },
        actions: actions.map(action => ({
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
    })],
});
