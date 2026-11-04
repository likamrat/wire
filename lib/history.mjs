import { DatabaseSync } from "node:sqlite";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { promptRecord, observeFirstPrompt, promptCapture } from "./prompt-authorship.mjs";
import { recordedResponseTiming } from "./response-timing.mjs";
import { textFindings } from "./privacy.mjs";
import { completionResult } from "./graph-history-io.mjs";
import { recordedInteractionModels } from "./interaction-model.mjs";
import { sourcePromptCreation } from "./source-discovery.mjs";
import { historyGap, isHistoryGap, unavailablePrompt, createPromptLinks, validEventEnvelope } from "./prompt-linkage.mjs";
import { TAIL_LIMITS } from "./collector-io.mjs";
import { errorDiagnostic, retainedErrorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";
import { workIqErrorEnvelope, WORKIQ_ERROR_INSPECTION_BYTES } from "./workiq-error-envelope.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPS = new Set(["ask", "list_agents", "retrieve", "search_paths", "get_schema", "fetch", "fetch_blob", "call_function", "do_action", "create_entity", "update_entity", "delete_entity"]);
const credentialLiteral = /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})|"(?:(?:access|refresh)[_-]?token|authorization|password|client_secret)"\s*:\s*"[^"]+")/i;
const digest = (text) => createHash("sha256").update(text).digest("hex");

export async function readEventWindow(file, maxBytes = 64 * 1024 * 1024) {
    const handle = await open(file, "r");
    try {
        const size = (await handle.stat()).size;
        const prefix = Buffer.alloc(Math.min(size, 65536));
        await handle.read(prefix, 0, prefix.length, 0);
        const firstLine = prefix.toString("utf8").split("\n")[0];
        let startup;
        try { startup = JSON.parse(firstLine); } catch { return { events: [], failure: "invalid-startup-event", size }; }
        const offset = Math.max(0, size - maxBytes);
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        const lines = buffer.toString("utf8").split("\n");
        if (offset) {
            const boundary = Buffer.alloc(1);
            await handle.read(boundary, 0, 1, offset - 1);
            if (boundary[0] !== 10) lines.shift();
        }
        const events = [];
        const gap = (reason, index) => {
            if (!isHistoryGap(events.at(-1))) events.push(historyGap(`wire-gap-${digest(`${startup.id}:${offset}:${index}:${reason}`)}`, reason, offset));
        };
        if (offset) gap("initial-window", 0);
        let malformedLines = 0, oversizedLines = 0, unsupportedEvents = 0;
        let firstPromptEventId = offset === 0 && startup?.type === "session.start" && startup.data?.version === 1 ? undefined : null;
        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue;
            if (Buffer.byteLength(line) > TAIL_LIMITS.maxLineBytes) {
                oversizedLines++; firstPromptEventId = observeFirstPrompt(firstPromptEventId, null); gap("oversized-line", index); continue;
            }
            let event;
            try { event = JSON.parse(line); }
            catch { malformedLines++; firstPromptEventId = observeFirstPrompt(firstPromptEventId, null); gap("malformed-line", index); continue; }
            if (!validEventEnvelope(event) && !(offset === 0 && index === 0 && event?.type === "session.start")) {
                unsupportedEvents++; firstPromptEventId = observeFirstPrompt(firstPromptEventId, null); gap("malformed-line", index); continue;
            }
            firstPromptEventId = observeFirstPrompt(firstPromptEventId, event);
            if (event?.type === "user.message") event = { ...event, data: { ...event.data, wirePromptCapture: promptCapture(event) } };
            events.push(event);
        }
        return { events, startup, size, tailTruncated: offset > 0, malformedLines, oversizedLines, unsupportedEvents, firstPromptEventId: firstPromptEventId ?? null };
    } finally { await handle.close(); }
}

function resultObject(result) {
    return completionResult(result).structured;
}
const safeErrorCode = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value)
    && !textFindings(value).some(finding => finding.mandatory || finding.category === "opaque_identifiers") ? value : null;
function retainedFailureMetadata(value) {
    if (value?.version !== 1 || !["error-code-recorded", "error-details-excluded", "result-content-excluded", "no-structured-error", "unsupported-error-format"].includes(value.reason)) return null;
    const code = safeErrorCode(value.code);
    const messageStatus = ["not-supplied", "unsupported-format", "size-excluded", "sensitive-excluded", "text-excluded"].includes(value.messageStatus) ? value.messageStatus : "unqualified";
    const workIqFailure = messageStatus === "text-excluded" && ["mcp-server-path-not-found", "response-processing-error"].includes(value.messageSignal)
        && value.messageSource === "workiq-error-json";
    const diagnostic = retainedErrorDiagnostic(value.diagnostic);
    return { version: 1, reason: value.reason === "error-code-recorded" && !code ? "error-details-excluded" : value.reason,
        code: value.reason === "error-code-recorded" ? code : null, messageStatus,
        messageSignal: workIqFailure ? value.messageSignal
            : messageStatus === "text-excluded" && ["access-denial", "request-timeout", "workiq-sign-in-required"].includes(value.messageSignal) ? value.messageSignal : null,
        ...(workIqFailure ? { messageSource: "workiq-error-json" } : {}), ...(diagnostic ? { diagnostic } : {}) };
}

function workIqPathFailure(message) {
    const read = workIqErrorEnvelope(message), value = read?.partial ? null : read?.value;
    if (!value || Object.keys(value).some(key => !["error", "requestId"].includes(key))
        || typeof value.error !== "string" || value.requestId != null && typeof value.requestId !== "string") return false;
    if (textFindings(value.error).some(finding => finding.mandatory)) return false;
    return /^Error: Error executing tool: No MCP server was found for path '[^'\r\n]{1,512}'\. Use search to discover valid MCP server paths\.(?:\r?\nCorrelationId: [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}, TimeStamp: \d{4}-\d{2}-\d{2}_\d{2}:\d{2}:\d{2})?$/.test(value.error);
}

function workIqErrorResults(data, { completeOnly = false } = {}) {
    if (data?.success !== false || data.result != null) return null;
    const read = workIqErrorEnvelope(data.error?.message), value = completeOnly && read?.partial ? null : read?.value;
    if (!value || Object.keys(value).some(key => !["results", "note", "requestId"].includes(key))
        || !Array.isArray(value.results)
        || value.note != null && typeof value.note !== "string"
        || value.requestId != null && typeof value.requestId !== "string") return null;
    // Error envelopes can mix failures with private successful responses. Keep positions, never data or innerError.
    return value.results.map(result => ({
        statusCode: Number.isInteger(result?.statusCode) && result.statusCode >= 100 && result.statusCode <= 599 ? result.statusCode : null,
        error: result?.error?.error ?? result?.error,
    }));
}

export function completionResultMetadata(data) {
    return data?.result != null ? resultMetadata(data.result)
        : resultMetadata({ structuredContent: { results: workIqErrorResults(data) } }, "workiq-error-json");
}

function completionDiagnostic(data, structured) {
    const error = data.error ?? structured?.error;
    if (error != null) {
        const message = error?.message;
        if (typeof message === "string" && /^MCP server ['"]workiq['"]:\s*\{/.test(message.trim())) {
            const envelope = workIqErrorEnvelope(message)?.value;
            if (envelope?.error != null) {
                const nested = envelope.error?.error ?? envelope.error;
                const diagnostic = errorDiagnostic(nested, "workiq-error-json");
                const status = envelope.statusCode;
                return Number.isInteger(status) && status >= 100 && status <= 599 && diagnostic.statusCode == null
                    ? { ...diagnostic, status: diagnostic.status === "not-supplied" ? "recorded" : diagnostic.status, statusCode: status }
                    : diagnostic;
            }
            if (workIqErrorResults(data)) return null;
            if (envelope) return errorDiagnostic({ statusCode: envelope.statusCode }, "workiq-error-json");
            if (!envelope && Buffer.byteLength(message) <= WORKIQ_ERROR_INSPECTION_BYTES) {
                const excluded = textFindings(message).some(finding => finding.mandatory || finding.category === "sensitivity_markings");
                return { ...errorDiagnostic({ code: error.code }, "completion-error"),
                    status: excluded ? "sensitive-excluded" : "unsupported-format" };
            }
        }
        return errorDiagnostic(error, data.error != null ? "completion-error" : "result-error");
    }
    if (data.result?.isError === true) {
        const content = data.result.content;
        if (typeof content === "string") return errorDiagnostic(content, "mcp-result-text");
        if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
            return errorDiagnostic(content[0].text, "mcp-result-text");
        }
        return errorDiagnostic(content, "mcp-result-text");
    }
    return null;
}

export function completionResultEvidence(data) {
    data ??= {};
    const result = data?.result, parsed = completionResult(result);
    const errorEnvelope = data.success === false && result == null ? workIqErrorEnvelope(data.error?.message) : null;
    const structured = parsed.structured ?? errorEnvelope?.value;
    const applicationError = typeof result?.isError === "boolean" ? result.isError : null;
    const rawStatus = structured?.statusCode ?? structured?.status ?? structured?.httpStatus;
    const textStatus = parsed.textStructured?.statusCode ?? parsed.textStructured?.status ?? parsed.textStructured?.httpStatus;
    const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
    let statusCode = validStatus(rawStatus) ? rawStatus : validStatus(textStatus) ? textStatus : null;
    const statusConflict = validStatus(rawStatus) && validStatus(textStatus) && textStatus !== rawStatus
        ? { structured: rawStatus, text: textStatus } : null;
    if (statusConflict) statusCode = null;
    const members = structured?.results ?? structured?.responses;
    const invalidMembers = structured && (Object.hasOwn(structured, "results") || Object.hasOwn(structured, "responses"))
        && !Array.isArray(members);
    const body = structured && Object.hasOwn(structured, "data") ? structured.data
        : structured && Object.hasOwn(structured, "body") ? structured.body
        : result && Object.hasOwn(result, "content") ? result.content : result;
    const unsupported = invalidMembers || result?.isError != null && typeof result.isError !== "boolean"
        || result !== undefined && typeof result !== "string" && typeof result !== "object";
    const contentStatus = errorEnvelope?.partial ? "partial"
        : result === undefined && !errorEnvelope ? "not-supplied" : unsupported ? "unsupported-format" : body === null ? "explicit-null"
        : body === "" || Array.isArray(body) && body.length === 0 ? "recorded-empty"
        : parsed.text.length > 256000 ? "size-excluded"
        : "body-excluded";
    const diagnostic = data?.success !== false ? completionDiagnostic(data, structured) : null;
    return normalizeResultEvidence({ version: 1, source: "sdk-result", applicationError, statusCode,
        resultCount: !errorEnvelope?.partial && Array.isArray(members) ? members.length : null, contentStatus,
        ...(diagnostic ? { diagnostic } : {}), ...(statusConflict ? { statusConflict } : {}) });
}

// Keep legacy signals stable; the independently screened diagnostic preserves exact source wording.
export function failureMetadata(data) {
    if (data?.success !== false) return null;
    const structured = resultObject(data.result);
    const error = data.error ?? structured?.error;
    const reportedFailures = (workIqErrorResults(data, { completeOnly: true }) ?? []).filter(result => result.statusCode >= 400);
    const reportedCode = safeErrorCode(reportedFailures[0]?.error?.code);
    const commonCode = reportedCode && reportedFailures.every(result => safeErrorCode(result.error?.code) === reportedCode) ? reportedCode : null;
    const outerCode = safeErrorCode(error?.code);
    const code = outerCode && outerCode !== "failure" ? outerCode : commonCode ?? outerCode;
    const message = error?.message;
    const messageStatus = message == null ? "not-supplied" : typeof message !== "string" ? "unsupported-format"
        : Buffer.byteLength(message) > 8192 ? "size-excluded"
            : textFindings(message).some(finding => finding.mandatory) ? "sensitive-excluded" : "text-excluded";
    const denial = /\b(?:access[ _-]?denied|forbidden|unauthorized|permission denied)\b/i;
    const uncertain = /\b(?:not|no|never|without|isn't|wasn't|may|might|could|possible|whether)\b.{0,64}(?:access[ _-]?denied|forbidden|unauthorized|permission denied)|(?:access[ _-]?denied|forbidden|unauthorized|permission denied).{0,32}\b(?:did not|was not|is not|ruled out|possible|may|might|could)\b/i;
    const timeout = /\bMCP error -32001: Request timed out[.!]?\s*$/i;
    const uncertainTimeout = /\b(?:not|no|never|without|isn't|wasn't|may|might|could|possible|possibly|whether|example|quoted)\b/i;
    const workIqSignIn = /^(?:MCP server ['"]workiq['"]:\s*)?Re-authentication required for MCP server ['"]workiq['"]\. Run \/mcp auth workiq\.?$/;
    const messageSignal = messageStatus !== "text-excluded" ? null
        : workIqPathFailure(message) ? "mcp-server-path-not-found"
        : reportedFailures.length && reportedFailures.every(result => result.statusCode === 500
            && result.error?.code === "InternalServerError" && result.error?.message === "Error while processing response.")
            ? "response-processing-error"
        : /^MCP server ['"]workiq['"]:\s*\{/.test(message.trim()) ? null
        : workIqSignIn.test(message.trim()) ? "workiq-sign-in-required"
            : timeout.test(message) && !uncertainTimeout.test(message) ? "request-timeout"
            : denial.test(message) && !uncertain.test(message) ? "access-denial" : null;
    const unsupported = error != null && (typeof error !== "object" || Array.isArray(error)
        || error.code != null && typeof error.code !== "string" || messageStatus === "unsupported-format");
    const content = data.result?.content;
    const hasContent = typeof data.result === "string" && data.result.length > 0
        || typeof content === "string" && content.length > 0 || Array.isArray(content) && content.length > 0;
    const diagnostic = completionDiagnostic(data, structured);
    return { version: 1, reason: code ? "error-code-recorded" : unsupported ? "unsupported-error-format"
        : error != null || data.result?.isError === true ? "error-details-excluded"
            : hasContent ? "result-content-excluded" : "no-structured-error", code, messageStatus, messageSignal,
        ...(["mcp-server-path-not-found", "response-processing-error"].includes(messageSignal) ? { messageSource: "workiq-error-json" } : {}),
        ...(diagnostic ? { diagnostic } : {}) };
}

export function resultMetadata(result, errorSource = "result-error") {
    const structured = resultObject(result);

    const candidates = structured?.results ?? structured?.responses;
    if (!Array.isArray(candidates)) return [];
    return candidates.slice(0, 100).map((r, index) => {
        const error = r?.error?.error ?? r?.error;
        const diagnostic = retainedErrorDiagnostic(r?.wireErrorDiagnostic)
            ?? (error != null ? errorDiagnostic(error, errorSource) : null);
        return {
        index,
        indexKind: "response-array-position",
        statusCode: Number.isInteger(r?.statusCode ?? r?.status) ? (r.statusCode ?? r.status) : null,
        errorCode: safeErrorCode(error?.code),
        evidenceLevel: "intermediary-reported",
        paginationPresent: typeof r?.body?.["@odata.nextLink"] === "string" ? true : null,
        ...(diagnostic ? { errorDiagnostic: diagnostic } : {}),
    }; });
}

export function completeWorkIqCall(call, end) {
    const duration = end ? Date.parse(end.timestamp) - Date.parse(call.startedAt) : null;
    const sourceError = end?.data?.error ?? resultObject(end?.data?.result)?.error;
    const failureEvidence = end?.data?.success === false ? retainedFailureMetadata(end.data.wireFailureEvidence)
        ?? (sourceError != null || end.data.result?.isError === true ? failureMetadata(end.data) : null) : null;
    const resultEvidence = normalizeResultEvidence(end?.data?.wireResultEvidence)
        ?? (end && !Object.hasOwn(end.data, "wireFailureEvidence")
            && (Object.hasOwn(end.data, "result") || end.data.error != null) ? completionResultEvidence(end.data) : null);
    return {
        ...call, completionEventId: end?.id ?? null,
        reportedOutcome: end?.data?.success === true ? "succeeded" : end?.data?.success === false ? "failed" : "unknown",
        toolSucceeded: typeof end?.data?.success === "boolean" ? end.data.success : null,
        completedAt: end?.timestamp ?? null,
        durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
        model: call.model ?? end?.data?.model ?? null,
        modelSource: call.model ? call.modelSource ?? "start-event" : end?.data?.model ? "completion-event" : "unavailable",
        apiResults: completionResultMetadata(end?.data),
        // Unqualified checkpoints must not gain default fields or a new assessment identity.
        ...(failureEvidence || Object.hasOwn(call, "failureEvidence") ? { failureEvidence } : {}),
        ...(resultEvidence || Object.hasOwn(call, "resultEvidence") ? { resultEvidence } : {}),
    };
}

export function extractScenarios(events, source, since, until, { partialWindow = false, modelEvents = events, firstPromptEventId } = {}) {
    const unique = new Map();
    for (const event of events) if (event?.id && !unique.has(event.id)) unique.set(event.id, event);
    const rows = [...unique.values()];
    const explicitPrompt = createPromptLinks(rows);
    if (firstPromptEventId === undefined) firstPromptEventId = !partialWindow && events[0]?.type === "session.start"
        && events[0].data?.sessionId === source.sessionId && events[0].data.version === 1
        ? events.reduce(observeFirstPrompt, undefined) ?? null : null;
    const sourcePrompt = event => promptRecord(event, {
        agentCreatedFirstMessage: source.promptCreation?.actor === "agent" && (!firstPromptEventId || event?.id === firstPromptEventId),
    });
    const completions = new Map();
    for (const e of rows) if (e.type === "tool.execution_complete" && e.data?.toolCallId) completions.set(e.data.toolCallId, e);
    const scenarios = new Map();
    let prompt, gap;
    let skippedCredentials = 0;
    let missingResults = 0;
    let duplicateCalls = 0;
    let lastScenario;
    const seenCalls = new Set();
    for (const event of rows) {
        if (isHistoryGap(event)) { prompt = undefined; gap = event; lastScenario = undefined; continue; }
        if (event.type === "user.message") {
            if (lastScenario && event.id !== lastScenario.userPrompt?.sourceEventId
                && event.timestamp >= (lastScenario.userPrompt?.sourceTimestamp ?? "")
                && !lastScenario.followUpPrompts.length && event.timestamp >= since && event.timestamp <= until && !credentialLiteral.test(event.data?.content ?? "")) {
                lastScenario.followUpPrompts.push({ ...sourcePrompt(event), association: "Nearest following user message only; follow-up relationship inferred, not confirmed." });
            }
            prompt = event; gap = undefined; continue;
        }
        if (event.type !== "tool.execution_start") continue;
        const data = event.data ?? {};
        const logical = data.mcpToolName ?? data.toolName?.replace(/^workiq-/, "");
        if (!OPS.has(logical) || !(data.mcpServerName === "workiq" || data.mcpConfigServerName === "workiq" || data.toolName === `workiq-${logical}`)) continue;
        if (!event.timestamp || event.timestamp < since || event.timestamp > until) continue;
        if (!data.toolCallId || seenCalls.has(data.toolCallId)) { duplicateCalls++; continue; }
        seenCalls.add(data.toolCallId);
        const link = explicitPrompt(event, prompt), selectedPrompt = link ? link.event : prompt;
        const userPrompt = selectedPrompt ? sourcePrompt(selectedPrompt) : unavailablePrompt(link?.reason ?? gap?.data.reason ?? "unlinked", gap);
        if (credentialLiteral.test(JSON.stringify([userPrompt.text, data.arguments]))) { skippedCredentials++; continue; }
        const end = completions.get(data.toolCallId);
        if (!end) missingResults++;
        const scenarioId = `history-${source.sessionId}-${selectedPrompt?.id ?? event.id}`;
        if (!scenarios.has(scenarioId)) scenarios.set(scenarioId, {
            scenarioId, title: `Recorded ${logical} scenario`, family: ["search_paths", "get_schema"].includes(logical) ? "discovery" : logical === "retrieve" ? "retrieval" : ["ask", "list_agents"].includes(logical) ? "delegation" : ["fetch", "fetch_blob", "call_function"].includes(logical) ? "reads_functions" : "mutations",
            sourceSessionId: source.sessionId, sourceAppId: source.appId, sourceSessionUrl: source.appUrl,
            sourceHost: "copilot-app", project: source.project ?? "(unscoped chat)", projectId: source.projectId,
            sourceSessionName: source.name, capturedAt: event.timestamp, userPrompt,
            promptAssociationEvidence: { version: 1, method: link?.method ?? (selectedPrompt ? "recorded-order" : "unavailable") },
            followUpPrompts: [],
            promptAssociation: "Nearest preceding recorded user.message; association is inferred, not a proven causal link. Follow-ups remain separate prompt-group scenarios.",
            toolCalls: [], sample: false, workloadKind: "recorded-history",
            taskCorrectness: "unknown", evidenceLayer: "workiq-intermediary",
            coverageNote: "Recorded Work IQ invocation, not observed Graph HTTP. Result entity/body content excluded. Missing completions and truncated logs are disclosed in the source roster.",
            sourceEligibility: { checkedAt: source.checkedAt, archivedAt: null, evidence: source.adapter
                ? `${source.adapter}: current read-only app sessions/workspaces mappings and matching session.start`
                : "app-inventory + read-only app sessions/workspaces archive fields + matching session.start" },
        });
        const scenario = scenarios.get(scenarioId);
        if (scenario.promptAssociationEvidence.method !== link?.method) {
            scenario.promptAssociationEvidence.method = selectedPrompt ? "recorded-order" : "unavailable";
        }
        lastScenario = scenario;
        const args = data.arguments ?? {};
        const requested = args.path ?? args.functionUrl ?? args.actionUrl ?? args.entityUrl ?? args.parentUrl ?? args.entityUrls?.[0] ?? null;
        scenario.toolCalls.push(completeWorkIqCall({
            tool: `workiq-${logical}`, toolCallId: data.toolCallId, startEventId: event.id,
            order: scenario.toolCalls.length + 1,
            parentToolCallId: data.parentToolCallId ?? null, parallelGroup: null, requestArgs: args,
            ...(["source-field-absent", "recorded"].includes(data.wireParentInvocation)
                ? { parentInvocationEvidence: data.wireParentInvocation, parallelGroupEvidence: "adapter-not-supported" } : {}),
            requestedApiPath: typeof requested === "string" ? requested : null,
            apiSurfaceNote: "Requested Work IQ path only; hosted internal Graph HTTP is not observable.",
            startedAt: event.timestamp,
            model: data.model ?? null, modelSource: data.model ? "start-event" : "unavailable",
            turnId: data.turnId ?? null,
            mcpTransport: data.mcpTransport ?? null, mcpServerName: data.mcpServerName ?? null,
            observedGraphHttp: false,
        }, end));
    }
    return { scenarios: [...scenarios.values()].map(record => {
        const originalModelEvidence = recordedInteractionModels(modelEvents, record, { partialWindow });
        return { ...record, responseTiming: recordedResponseTiming(rows, record.userPrompt),
            ...(originalModelEvidence ? { originalModelEvidence } : {}) };
    }), skippedCredentials, missingResults, duplicateCalls, deduplicatedEvents: events.length - unique.size };
}

export async function scanHistory({ inventoryPath, appDbPath, sessionRoot, since, until = new Date().toISOString(), maxSessions = 500 }) {
    if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until))) throw new Error("Valid bounded history dates are required.");
    const inventoryBytes = (await readFile(inventoryPath, "utf8")).replace(/^\uFEFF/, "");
    const inventory = JSON.parse(inventoryBytes);
    if (!Array.isArray(inventory) || inventory.length > maxSessions) throw new Error("App inventory exceeds bounded scan limit.");
    const checkedAt = new Date().toISOString();
    const db = new DatabaseSync(appDbPath, { readOnly: true });
    const roster = [];
    const scenarios = [];
    const seenSessions = new Set();
    try {
        const workspaceColumns = db.prepare("PRAGMA main.table_xinfo(workspaces)").all();
        const creatorColumns = ["created_by", "creator_session_id"].every(name =>
            workspaceColumns.some(column => column.name === name && column.type.toUpperCase() === "TEXT" && column.hidden === 0));
        const creatorWorkspaces = creatorColumns
            ? db.prepare("SELECT created_by,creator_session_id,archived_at FROM workspaces WHERE session_id=?") : null;
        for (const item of inventory) {
            const row = { appId: item.id, appUrl: item.app_url, projectId: item.project_id ?? null, project: item.project_name ?? null, name: item.name ?? item.title, checkedAt };
            roster.push(row);
            if (!UUID.test(item.id)) { row.disposition = "unmapped-invalid-id"; continue; }
            const workspaces = db.prepare("SELECT id,session_id,project_id,archived_at FROM workspaces WHERE id=? OR session_id=?").all(item.id, item.id);
            const candidates = [...new Set([item.id, ...workspaces.map((w) => w.session_id)].filter(Boolean))].map((id) => db.prepare("SELECT id,archived_at,execution_location FROM sessions WHERE id=?").get(id)).filter(Boolean);
            if (candidates.length !== 1 || !UUID.test(candidates[0].id)) { row.disposition = "unmapped-or-ambiguous"; continue; }
            const source = candidates[0];
            row.sessionId = source.id;
            row.archiveEvidence = { table: "sessions", id: source.id, archived_at: source.archived_at, workspaces };
            if (source.archived_at || workspaces.some((w) => w.archived_at)) { row.disposition = "archived"; continue; }
            if (source.execution_location !== "local") { row.disposition = "nonlocal-not-read"; continue; }
            if (seenSessions.has(source.id)) { row.disposition = "duplicate-session-mapping"; continue; }
            seenSessions.add(source.id);
            row.eligible = true;
            row.promptCreation = creatorWorkspaces ? sourcePromptCreation(creatorWorkspaces.all(source.id)) : null;
            let window;
            try { window = await readEventWindow(path.join(sessionRoot, source.id, "events.jsonl")); }
            catch (error) { row.disposition = error.code === "ENOENT" ? "missing-local-history" : "history-read-failed"; row.errorCode = error.code ?? "read-error"; continue; }
            row.scanned = true;
            if (window.failure || window.startup?.type !== "session.start" || window.startup.data?.sessionId !== source.id) { row.disposition = "startup-id-unverified"; continue; }
            row.startupEventId = window.startup.id;
            row.logBytes = window.size;
            row.tailTruncated = window.tailTruncated;
            row.malformedLines = window.malformedLines;
            row.oversizedLines = window.oversizedLines;
            row.unsupportedEvents = window.unsupportedEvents;
            const extracted = extractScenarios(window.events, row, since, until, {
                partialWindow: window.tailTruncated || window.malformedLines > 0 || window.oversizedLines > 0 || window.unsupportedEvents > 0,
                firstPromptEventId: window.firstPromptEventId,
            });
            row.scenarioCount = extracted.scenarios.length;
            row.callCount = extracted.scenarios.reduce((n, s) => n + s.toolCalls.length, 0);
            row.skippedCredentials = extracted.skippedCredentials;
            row.missingResults = extracted.missingResults;
            row.duplicateCalls = extracted.duplicateCalls;
            row.deduplicatedEvents = extracted.deduplicatedEvents;
            row.disposition = row.callCount ? "included" : "no-qualifying-calls-in-window";
            if (row.callCount) {
                row.firstCallAt = extracted.scenarios.flatMap((s) => s.toolCalls.map((t) => t.startedAt)).sort()[0];
                row.lastCallAt = extracted.scenarios.flatMap((s) => s.toolCalls.map((t) => t.startedAt)).sort().at(-1);
                scenarios.push(...extracted.scenarios);
            }
        }
    } finally { db.close(); }
    const included = roster.filter((r) => r.disposition === "included");
    return {
        schemaVersion: 1, checkedAt, since, until, inventoryHash: digest(inventoryBytes),
        discoveryMethod: "Supported app inventory, then read-only explicit sessions/workspaces mappings and archive fields. Only mapped local event paths read; no credential/config/repository scans.",
        counts: {
            listed: inventory.length, eligible: roster.filter((r) => r.eligible).length, scanned: roster.filter((r) => r.scanned).length,
            includedSessions: included.length, includedProjects: new Set(included.map((r) => r.projectId).filter(Boolean)).size,
            includedCalls: included.reduce((n, r) => n + r.callCount, 0), includedScenarios: scenarios.length,
            failed: roster.filter((r) => ["missing-local-history", "history-read-failed", "startup-id-unverified"].includes(r.disposition)).length,
            excluded: roster.filter((r) => r.disposition !== "included").length,
            shortfall: Math.max(0, 30 - included.length),
        },
        roster, scenarios,
    };
}
