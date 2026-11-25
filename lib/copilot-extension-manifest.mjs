import { BOARD_ID } from "./evidence.mjs";
import { ANALYTICS_SCHEMA, TIME_CONTEXT_SCHEMA } from "./analytics-input.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "./branding.mjs";
import { SEARCH_TYPES } from "./search-text.mjs";

export const CANVAS_ID = "workiq-evidence-board";
const schema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });

export const canvasActions = [
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

export const canvasDeclaration = {
    id: CANVAS_ID,
    displayName: PRODUCT_NAME,
    description: `${PRODUCT_DESCRIPTION}. Opening it starts WIRE inside the Copilot app when no WIRE is already running.`,
    inputSchema: schema({ boardId: { const: BOARD_ID }, runtimePort: { type: "integer", minimum: 1, maximum: 65535,
        description: "Only for a contributor runtime started on another port. Omit to use or start WIRE on 4000." } }),
};

const searchTypes = [...SEARCH_TYPES];

export const agentTools = [
    { name: "wire_status", description: `Read ${PRODUCT_NAME} collection status and evidence coverage: approved source, last check, retained counts and any collection problem. Starts WIRE inside the Copilot app if needed. Read-only.`,
        parameters: schema({}) },
    { name: "wire_analytics", description: `Read ${PRODUCT_NAME} counts for recorded Work IQ activity: prompts, tool calls and returned entries by outcome, service, endpoint and author, including recorded failure reasons. Read-only.`,
        parameters: ANALYTICS_SCHEMA },
    { name: "wire_search", description: `Search ${PRODUCT_NAME}'s retained evidence on this device by literal, case-insensitive text. No AI matching. Returns matching prompts, context, replies, Work IQ actions and saved reports with short excerpts. Read-only.`,
        parameters: schema({
            query: { type: "string", minLength: 1, maxLength: 1000, description: "Exact text to find." },
            types: { type: "array", uniqueItems: true, items: { enum: searchTypes }, description: "Optional result types. Omit to search all." },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results to return. Defaults to 25." },
        }, ["query"]) },
    { name: "wire_diagnostic_calls", description: `Read ${PRODUCT_NAME}'s retained Work IQ tool calls for a UTC window as MCP diagnostic records: host outcome, recorded error code and reason, HTTP and per-entry status, duration. Includes reconciled totals and coverage limits. No prompts, arguments or result bodies. Read-only.`,
        parameters: schema({
            from: { type: "string", maxLength: 64, description: "Inclusive UTC start (ISO 8601)." },
            to: { type: "string", maxLength: 64, description: "Exclusive UTC end (ISO 8601)." },
            tools: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", maxLength: 100 }, description: "Optional Work IQ tool names, e.g. workiq-fetch." },
            sourceSessionIds: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", maxLength: 1000 }, description: "Optional chats." },
        }) },
    { name: "wire_diagnostic_bundle", description: `Prepare an MCP diagnostic report and redacted bundle from ${PRODUCT_NAME}'s retained Work IQ calls for a UTC window. With save false (default) nothing is written: returns the draft report.md, clusters and a verdicts template. With save true, writes the report and zip to ${PRODUCT_NAME}'s private diagnostics folder and returns their paths. Never sends or uploads.`,
        parameters: schema({
            from: { type: "string", maxLength: 64, description: "Inclusive UTC start (ISO 8601)." },
            to: { type: "string", maxLength: 64, description: "Exclusive UTC end (ISO 8601)." },
            tools: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", maxLength: 100 } },
            captureScope: { enum: ["sample", "failures-only", "complete"], description: "complete only when every call in the window is included; WIRE supplies the reconciled totals." },
            profile: { enum: ["internal", "external"], description: "Defaults to internal." },
            verdicts: { type: "object", description: "A filled verdicts template from a previous preparation." },
            reviewedNarrative: { type: "boolean", description: "Include operator narrative from verdicts; only after reviewing it for content that shouldn't be shared." },
            save: { type: "boolean", description: "Write the bundle locally. Ask the user first." },
        }) },
    { name: "wire_inspect_bundle", description: "Check an MCP diagnostic bundle zip without extracting it: layout, schema, checksums and cross-file counts. Returns its summary and clusters, or why it was refused. Read-only.",
        parameters: schema({ path: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path to the .zip." } }, ["path"]) },
];
