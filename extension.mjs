import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { BOARD_ID } from "./lib/evidence.mjs";
import { ANALYTICS_SCHEMA, TIME_CONTEXT_SCHEMA } from "./lib/analytics-input.mjs";
import { createRuntimeClient } from "./lib/runtime-client.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "./lib/branding.mjs";
import { createCopilotAccountBridge } from "./lib/copilot-account-snapshot.mjs";

const runtime = createRuntimeClient();
let joinedSession;
const accountBridge = createCopilotAccountBridge(() => joinedSession);
const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const actions = [
    { name: "get_state", description: "Read local evidence and persisted review state.", inputSchema: schema({}) },
    { name: "get_summary", description: "Read coverage and safe bundle paths without original prompts.", inputSchema: schema({}) },
    { name: "get_analytics", description: "Read canonical layer counts and normalized endpoint groups.", inputSchema: ANALYTICS_SCHEMA },
    { name: "refresh_history", description: "Explicit bounded read-only refresh of approved local history.", inputSchema: schema({}) },
    { name: "record_graph_metadata", description: "Opt in to one credential-free Graph metadata GET; never retried.", inputSchema: schema({ confirmed: { const: true } }, ["confirmed"]) },
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
        inputSchema: schema({ boardId: { const: BOARD_ID } }, ["boardId"]),
        open: async ctx => {
            try { return await runtime.open(ctx.instanceId); }
            catch (error) {
                if (error.code === "WIRE_CLIENT_UPDATE_REQUIRED") throw new CanvasError("runtime_update_required", error.message);
                throw new CanvasError("runtime_unavailable", `Start the maintained ${PRODUCT_NAME} project with npm start, then open this canvas. No second server was started.`);
            }
        },
        actions: actions.map(action => ({
            ...action,
            handler: async ctx => {
                try { return await runtime.action(ctx.instanceId, ctx.actionName, ctx.input ?? {}); }
                catch (error) { throw new CanvasError("runtime_action_failed", error.message || "Local runtime unavailable. No action was replayed."); }
            },
        })),
        onClose: ctx => runtime.close(ctx.instanceId),
    })],
});
