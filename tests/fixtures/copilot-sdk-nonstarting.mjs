import { existsSync } from "node:fs";

export const observed = { moduleLoaded: true, clients: [], sessions: [], sends: 0, disconnects: 0, stops: 0, processesStarted: 0,
    rpc: [], schemaRejections: [] };
let responder;
export function setSyntheticResponder(value) {
    if (typeof value !== "function") throw new TypeError("A synthetic responder is required.");
    responder = value;
}
export const RuntimeConnection = { forStdio: options => ({ kind: "stdio", ...options }) };
// The observed provider requires a primitive type on finite-value schema nodes, not property maps or $ref-only nodes.
export function finiteSchemaTypeIssue(schema, path = []) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
    const values = Object.hasOwn(schema, "const") ? [schema.const] : schema.enum;
    if (Array.isArray(values)) {
        if (!schema.type) return { path, reason: "missing-type" };
        const matches = value => schema.type === "integer" ? Number.isInteger(value)
            : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : schema.type === "null" ? value === null : typeof value === schema.type;
        if (!values.every(matches)) return { path, reason: "finite-value-type-mismatch" };
    }
    for (const keyword of ["properties", "$defs"]) {
        for (const [name, child] of Object.entries(schema[keyword] ?? {})) {
            const issue = finiteSchemaTypeIssue(child, [...path, keyword, name]);
            if (issue) return issue;
        }
    }
    if (schema.items) {
        const issue = finiteSchemaTypeIssue(schema.items, [...path, "items"]);
        if (issue) return issue;
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        for (const [index, child] of (schema[keyword] ?? []).entries()) {
            const issue = finiteSchemaTypeIssue(child, [...path, keyword, String(index)]);
            if (issue) return issue;
        }
    }
    return null;
}
export class CopilotClient {
    constructor(options) {
        this.options = options; observed.clients.push(options);
        this.connection = { async sendRequest(method, params) {
            if (method !== "session.send") throw new Error("Unexpected synthetic SDK method.");
            observed.rpc.push({ method, params, state: "resolved", messageIdReturned: true });
            return { messageId: "synthetic-message" };
        } };
    }
    async createSession(options) {
        // Matches the installed SDK's pre-spawn literal-path check. This fixture never spawns.
        if (!existsSync(this.options.connection.path)) throw new Error(`Copilot CLI not found at ${this.options.connection.path}.`);
        observed.sessions.push(options);
        if (options.sessionLimits?.maxAiCredits < 30) {
            throw Object.assign(new Error("Request session.create failed with message: session construction failed: GenericFailure, Minimum session limit is 30 AI credits."), { code: -32603 });
        }
        const handlers = new Set(options.onEvent ? [options.onEvent] : []);
        const connection = this.connection;
        return {
            on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
            async sendAndWait(message, timeout) {
                observed.sends++;
                if (!responder) throw new Error("Synthetic SDK does not send to a provider.");
                const responseFormat = { type: "json_schema", jsonSchema: { name: "response", strict: true, schema: message.responseSchema } };
                await connection.sendRequest("session.send", { prompt: message.prompt, responseFormat });
                const issue = finiteSchemaTypeIssue(responseFormat.jsonSchema.schema);
                if (issue) {
                    observed.schemaRejections.push(issue);
                    const context = issue.path.map(part => `'${part}'`).join(",");
                    const message = `Invalid schema for response_format 'response': In context=(${context}), `
                        + (issue.reason === "missing-type" ? "schema must have a 'type' key." : "finite values must match the declared type.");
                    const event = { type: "session.error", data: { errorType: "query", statusCode: 400, message } };
                    for (const handler of handlers) handler(event);
                    throw new Error(message);
                }
                return responder({ message, timeout, options, emit: event => { for (const handler of handlers) handler(event); } });
            },
            async abort() {},
            async disconnect() { observed.disconnects++; },
        };
    }
    async stop() { observed.stops++; return []; }
}
