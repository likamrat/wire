import { normalizeEndpoint } from "./analytics.mjs";
import { promptRecord as recordedPrompt, observeFirstPrompt } from "./prompt-authorship.mjs";
import { isHistoryGap, unavailablePrompt, createPromptLinks } from "./prompt-linkage.mjs";
import { recordedResponseTiming } from "./response-timing.mjs";
import { recordedInteractionModels } from "./interaction-model.mjs";

export const GRAPH_ACTIVITY_LEVELS = Object.freeze(["requested-direct-graph", "output-visible-http", "code-reference"]);
export const OFFICE_WORKLOADS = Object.freeze(["Mail", "Calendar", "Files", "Teams", "People", "Tasks", "Notes", "Directory", "Search", "Discovery", "Multiple workloads", "Platform metadata", "Unknown"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHELL_TOOLS = /^(?:functions[.-])?(?:powershell|bash|shell|python|node|exec|run_command|execute)$/i;
const GRAPH_TOOLS = /^(?:msgraph|microsoft[.-]graph|graph)[._-]/i;
const CODE_TOOLS = /(?:apply_patch|edit_file|create_file|write_file)$/;
const HTTP_STATUS = /(?:HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?)\s+|(?:http[_ -]?status|status[_ -]?code|statusCode|status_code)\s*["']?\s*[:=]\s*["']?)([1-5]\d{2})\b/gi;
const GRAPH_URL = /https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)(?:\/[^\s"'`<>\\]*)?/g;
const WORKIQ_TOOL = /^workiq-(?:ask|list_agents|retrieve|search_paths|get_schema|fetch|fetch_blob|call_function|do_action|create_entity|update_entity|delete_entity)$/;
export function isHistoryTool(data) {
    const tool = data?.toolName ?? data?.mcpToolName ?? "";
    return WORKIQ_TOOL.test(tool) || data?.mcpServerName === "workiq" || data?.mcpConfigServerName === "workiq"
        || SHELL_TOOLS.test(tool) || CODE_TOOLS.test(tool) || GRAPH_TOOLS.test(tool)
        || /^(?:graph|msgraph|microsoft-graph)$/.test(data?.mcpServerName ?? "");
}
const id = (parts) => `graph-history:${JSON.stringify(parts)}`;
const validStatus = (v) => Number.isInteger(v) && v >= 100 && v <= 599;
const credentialSignal = /\b(?:Bearer\s+[A-Za-z0-9._-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|(?:access_token|refresh_token|client_secret|password|api[_-]?key|AccountKey)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{8,}/i;
const syntheticSignal = /\b(?:testTransport|mockFetch|mockTransport|synthetic-http-fixture|fetchMock)\b|\b(?:node\s+--test|vitest|pytest|jest)\b/;
const readSignal = /\b(?:rg|grep|Select-String|Get-Content|ReadAllText|readFileSync|readFile|read_text)\b|\b(?:git|gh)\b[\s\S]{0,300}\b(?:diff|show|log|grep|view)\b/;
const writeSignal = /\b(?:writeFile|writeFileSync|WriteAllText|write_text|Set-Content|Out-File)\b/;
const bound = (v, fallback, max) => {
    const result = v ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError("Invalid extraction bound.");
    return result;
};

export function classifyWorkload(endpoint, tool = null, targets = []) {
    if (targets.length > 1) {
        const workloads = [...new Set(targets.map((t) => classifyWorkload(t, tool)))];
        return workloads.length === 1 ? workloads[0] : "Multiple workloads";
    }
    const path = typeof endpoint === "string" ? normalizeEndpoint(endpoint).path : endpoint?.path ?? "";
    if (path === "/shares/{id}/driveItem") return "Files";
    if (/\$(?:metadata|batch)(?:\/|$)/.test(path)) return "Platform metadata";
    if (/\/(?:teams|chats|channels|onlineMeetings|joinedTeams|teamwork)(?:\/|$)/.test(path)) return "Teams";
    if (/\/(?:calendar|calendarView|calendars|events|getSchedule|findMeetingTimes)(?:\/|$)/.test(path)) return "Calendar";
    if (/\/(?:drive|drives|sites|files|workbook|worksheets|lists)(?:\/|$)/.test(path)) return "Files";
    if (/\/(?:messages|mailFolders|sendMail|mailboxSettings)(?:\/|$)/.test(path)) return "Mail";
    if (/\/(?:planner|todo|tasks|plans|buckets)(?:\/|$)/.test(path)) return "Tasks";
    if (/\/(?:onenote|notebooks|sections|pages)(?:\/|$)/.test(path)) return "Notes";
    if (/\/(?:people|contacts|contactFolders|users|photo|photos|presence)(?:\/|$)/.test(path) || path === "/me") return "People";
    if (/\/(?:groups|directoryObjects|applications|servicePrincipals|organization|directoryRoles)(?:\/|$)/.test(path)) return "Directory";
    if (/\/(?:search|query)(?:\/|$)/.test(path) || tool === "workiq-retrieve") return "Search";
    return "Unknown";
}

function commandText(data) {
    if (typeof data.arguments === "string") return data.arguments;
    const args = data.arguments ?? {};
    for (const key of ["command", "code", "script", "patch", "input"]) if (typeof args[key] === "string") return args[key];
    return "";
}

function outputText(result) {
    // Do not traverse body/data/entity fields. Only the recorded tool's display text.
    if (typeof result === "string") return result;
    if (typeof result?.content === "string") return result.content;
    if (Array.isArray(result?.content)) return result.content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
    return "";
}

function safeMethod(value) { return METHODS.has(value?.toUpperCase()) ? value.toUpperCase() : null; }

function urlsIn(text) {
    return [...text.matchAll(GRAPH_URL)].map((m) => ({ url: m[0].replace(/[),;\]}]+$/, ""), offset: m.index }));
}

function literalVariables(text) {
    const vars = new Map();
    for (const m of text.matchAll(/(?:\b(?:const|let|var)\s+)?(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])(https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)[^'"]*)\2/g)) {
        vars.set(m[1], m[3]);
    }
    return vars;
}

function resolveArgument(argument, vars) {
    const token = argument.trim();
    const literal = /^(['"`])(https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)[^'"`]*)\1$/.exec(token)?.[2];
    return literal ?? vars.get(token) ?? null;
}

/** Static intent inspection only; never evaluates JavaScript, Python or shell. */
export function inspectGraphCommand(text, { kind = "shell" } = {}) {
    if (typeof text !== "string") throw new TypeError("Command text must be a string.");
    const sites = [];
    const exclusions = [];
    if (credentialSignal.test(text)) return { sites, exclusions: ["credential-bearing-command"] };
    const synthetic = syntheticSignal.test(text);
    const sourceOnly = kind === "source" || readSignal.test(text) || writeSignal.test(text) || synthetic;
    const vars = literalVariables(text);
    const push = (url, method, offset, basis, executionAmbiguous = false) => {
        if (!url?.startsWith("https://graph.microsoft.com/")) return;
        // Interpolation/concatenation may be a prefix rather than a resolved endpoint.
        const dynamic = /\$\{|@\{|['"]\s*\+/.test(url);
        sites.push({
            endpoint: normalizeEndpoint(url, { method: dynamic ? null : method }),
            method: dynamic ? null : method, offset, basis,
            evidenceLevel: sourceOnly || executionAmbiguous || dynamic ? "code-reference" : "requested-direct-graph",
            synthetic, confidence: sourceOnly || executionAmbiguous || dynamic ? "low" : "high",
        });
    };
    const conditional = /\b(?:if|for|foreach|while|function|def)\b|=>\s*\{/.test(text);
    // curl and REST command-line invocations: URL must occur in the same statement.
    for (const m of text.matchAll(/\b(curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest|Invoke-MgGraphRequest|az\s+rest)\b([^\r\n;]*)/gi)) {
        const tail = m[2];
        let target = urlsIn(tail)[0]?.url;
        if (!target) {
            const variable = /(?:-Uri|--url|--uri)\s+(\$?[A-Za-z_][A-Za-z0-9_]*)/i.exec(tail)?.[1];
            target = vars.get(variable);
        }
        if (!target && /Invoke-MgGraphRequest/i.test(m[1])) {
            const relative = /-Uri\s+(['"])(\/(?:v1\.0|beta)\/[^'"]*)\1/i.exec(tail)?.[2];
            if (relative) target = `https://graph.microsoft.com${relative}`;
        }
        const explicit = /(?:-Method|--method|--request|-X)\s+['"]?([A-Za-z]+)/i.exec(tail)?.[1];
        const hasBody = /(?:--data|-d\s|-Body\s|--body)/i.test(tail);
        const method = explicit ? safeMethod(explicit) : /(?:-I|--head)\b/.test(tail) ? "HEAD" : hasBody && /curl/i.test(m[1]) ? "POST" : hasBody ? null : "GET";
        push(target, method, m.index, "request-command", conditional);
    }
    // Literal/constant targets in JavaScript and Python request invocations.
    for (const m of text.matchAll(/\b(fetch|requests\.(?:get|post|put|patch|delete|head|request)|httpx\.(?:get|post|put|patch|delete|head|request))\s*\(\s*((?:['"`][^'"`]+['"`])|(?:\$?[A-Za-z_][A-Za-z0-9_]*))/g)) {
        const target = resolveArgument(m[2], vars);
        const window = text.slice(m.index, m.index + 700);
        const suffix = m[1].split(".")[1];
        const explicit = /\bmethod\s*:\s*['"]([A-Z]+)['"]/i.exec(window)?.[1];
        const method = m[1] === "fetch" ? explicit ? safeMethod(explicit) : "GET" : suffix === "request" ? null : safeMethod(suffix);
        push(target, method, m.index, m[1] === "fetch" ? "javascript-request" : "python-request", conditional);
    }
    for (const m of text.matchAll(/\b(?:requests|httpx)\.request\s*\(\s*['"]([A-Z]+)['"]\s*,\s*((?:['"][^'"]+['"])|(?:[A-Za-z_][A-Za-z0-9_]*))/gi)) {
        push(resolveArgument(m[2], vars), safeMethod(m[1]), m.index, "python-request", conditional);
    }
    for (const m of text.matchAll(/\b(axios\.(?:get|post|put|patch|delete|head)|urllib\.request\.urlopen|https?\.(?:get|request))\s*\(\s*((?:['"][^'"]+['"])|(?:[A-Za-z_][A-Za-z0-9_]*))/g)) {
        const suffix = m[1].split(".").at(-1);
        push(resolveArgument(m[2], vars), ["request", "urlopen"].includes(suffix) ? null : safeMethod(suffix), m.index, m[1].startsWith("urllib") ? "python-request" : "javascript-request", conditional);
    }
    // SDK chains establish requested resource/method, not a wire observation.
    if (/GraphServiceClient|Microsoft\.Graph|microsoft-graph-client|msgraph/.test(text)) {
        for (const m of text.matchAll(/\.api\(\s*(['"])(\/[^'"]*)\1\s*\)\s*\.\s*(get|post|patch|put|delete)\s*\(/gi)) {
            push(`https://graph.microsoft.com${/^\/(?:v1\.0|beta)\//.test(m[2]) ? "" : "/v1.0"}${m[2]}`, safeMethod(m[3]), m.index, "graph-sdk-call", conditional);
            if (!/^\/(?:v1\.0|beta)\//.test(m[2]) && sites.length) sites.at(-1).endpoint = normalizeEndpoint(m[2], { method: safeMethod(m[3]) });
        }
        const SDK_PATHS = { me: "/me", users: "/users", groups: "/groups", teams: "/teams", chats: "/chats", drives: "/drives", sites: "/sites" };
        for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\.(me|users|groups|teams|chats|drives|sites)((?:\.[A-Za-z_][A-Za-z0-9_]*|\([^()\r\n]*\))*)\.(get|post|patch|put|delete)(?:_as_[A-Za-z_]+)?(?:_async|Async)?\s*\(/gi)) {
            const navigations = [...m[2].matchAll(/\.(messages|calendar_view|calendarView|events|drive|items|children|channels|members|photo|content)\b/g)].map((n) => n[1].replace("calendar_view", "calendarView"));
            const requiresId = /by_[a-z_]+_id|By[A-Za-z]+Id/.test(m[2]);
            const route = `${SDK_PATHS[m[1]]}${requiresId ? "/{id}" : ""}${navigations.length ? `/${navigations.join("/")}` : ""}`;
            push(`https://graph.microsoft.com/v1.0${route}`, safeMethod(m[3]), m.index, "graph-sdk-static-analysis", true);
            if (sites.length) sites.at(-1).endpoint = normalizeEndpoint(route, { method: safeMethod(m[3]) });
        }
    }
    const mgRoutes = {
        "Get-MgUserMessage": ["/users/{id}/messages", "GET"], "Get-MgUserEvent": ["/users/{id}/events", "GET"],
        "Get-MgUserCalendarView": ["/users/{id}/calendarView", "GET"], "Get-MgUserDrive": ["/users/{id}/drive", "GET"],
        "Get-MgTeamChannelMessage": ["/teams/{id}/channels/{id}/messages", "GET"], "Get-MgChatMessage": ["/chats/{id}/messages", "GET"],
        "Get-MgUser": ["/users", "GET"], "Send-MgUserMail": ["/users/{id}/sendMail", "POST"],
    };
    for (const [name, [route, method]] of Object.entries(mgRoutes)) {
        const match = new RegExp(`\\b${name}\\b(?![A-Za-z])`, "i").exec(text);
        if (match) push(`https://graph.microsoft.com/v1.0${route}`, method, match.index, "graph-sdk-call", conditional);
    }
    if (/\bm365\s+request\b/i.test(text)) {
        const match = /\bm365\s+request\b([^\r\n;]*)/i.exec(text);
        const target = urlsIn(match[1])[0]?.url;
        const method = safeMethod(/--method\s+['"]?([A-Za-z]+)/i.exec(match[1])?.[1]);
        if (target) push(target, method, match.index, "request-command", conditional);
    }
    // Remaining URL mentions stay searchable as code intent, never execution counts.
    if (!sites.length) for (const target of urlsIn(text)) push(target.url, null, target.offset, "graph-url-reference", true);
    if (/Invoke-MgGraphRequest|GraphServiceClient|\b(?:Get|New|Update|Remove|Send)-Mg[A-Za-z]+|\bm365\s+(?:request|outlook|teams|spo|planner)/i.test(text) && !sites.length) exclusions.push("unresolved-sdk-or-cli-target");
    if (/Invoke-(?:RestMethod|WebRequest)|\bcurl\b|requests\.(?:get|post)|fetch\(/i.test(text) && !sites.length) exclusions.push("unresolved-network-target");
    if (sourceOnly && sites.length) exclusions.push(synthetic ? "synthetic-source-only" : "source-reference-not-execution");
    return { sites, exclusions };
}

function visibleStatus(completion, siteCount, eligible) {
    if (!eligible || siteCount !== 1) return { status: null, basis: "none" };
    const result = completion?.data?.result;
    const structured = result?.structuredContent;
    // HTTP-specific numeric fields only; success booleans and arbitrary status fields are not HTTP.
    const structuredStatus = structured?.httpStatus ?? structured?.statusCode;
    const text = outputText(result);
    if (credentialSignal.test(text) || text.includes("[Credential-bearing output excluded]")) return { status: null, basis: "none" };
    if (/^\s*(?:diff --git|@@|\+\+\+|---)|\b(?:testTransport|mockFetch|fixture)\b/m.test(text)) return { status: null, basis: "none" };
    const statuses = [...text.matchAll(HTTP_STATUS)].map((m) => Number(m[1]));
    if (validStatus(structuredStatus)) statuses.push(structuredStatus);
    const unique = [...new Set(statuses)];
    return unique.length === 1 ? { status: unique[0], basis: "explicit-output-status" } : { status: null, basis: "none" };
}

export function completeGraphActivity(activity, completion, siteCount) {
    const result = visibleStatus(completion, siteCount, activity.outputStatusEligible === true);
    const reference = activity.evidenceLevel === "code-reference";
    return {
        ...activity, completionEventId: completion.id,
        evidenceLevel: reference ? "code-reference" : result.status !== null ? "output-visible-http" : activity.evidenceLevel,
        httpStatus: reference ? null : result.status ?? activity.httpStatus,
        statusBasis: result.status !== null ? result.basis : activity.statusBasis,
        evidenceRefs: [...activity.evidenceRefs.filter(r => r.role !== "response"), { eventId: completion.id, role: "response" }],
    };
}

function promptRecord(event, context) {
    const prompt = recordedPrompt(event, context);
    return credentialSignal.test(prompt.text ?? "") ? { ...prompt, text: null, status: "unavailable",
        ...(prompt.capture ? { capture: { ...prompt.capture, original: "unavailable", reason: "credential-excluded" } } : {}) } : prompt;
}

function explicitTransition(text) {
    return /\b(?:fall(?:ing)?\s*back|fallback|instead|switch(?:ing)?)\b[\s\S]{0,160}\b(?:Graph|REST|SDK|curl)\b/i.test(text)
        && /\b(?:Work\s?IQ|workiq)\b/i.test(text);
}

/** Bounded event-array extraction. Private prompt stays on the scenario, never an activity. */
export function extractGraphActivities(events, source, options = {}) {
    if (!Array.isArray(events) || !source?.sessionId) throw new TypeError("Events and a mapped source chat are required.");
    const maxEvents = bound(options.maxEvents, 100000, 500000);
    const maxTextChars = bound(options.maxTextChars, 256000, 4 * 1024 ** 2);
    const maxActivities = bound(options.maxActivities, 5000, 50000);
    if (events.length > maxEvents) throw new RangeError("Event bound exceeded; use bounded source reader.");
    const since = options.since ? Date.parse(options.since) : -Infinity;
    const until = options.until ? Date.parse(options.until) : Infinity;
    if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new TypeError("Invalid extraction time window.");
    const unique = new Map();
    for (const e of events) if (e?.id && !unique.has(e.id)) unique.set(e.id, e);
    const rows = [...unique.values()];
    const explicitPrompt = createPromptLinks(rows);
    const firstPromptEventId = options.firstPromptEventId !== undefined ? options.firstPromptEventId
        : !options.partialWindow && events[0]?.type === "session.start"
            && events[0].data?.sessionId === source.sessionId && events[0].data.version === 1
            ? events.reduce(observeFirstPrompt, undefined) ?? null : null;
    const completions = new Map(rows.filter((e) => e.type === "tool.execution_complete").map((e) => [e.data?.toolCallId, e]));
    const scenarios = new Map();
    const exclusions = {};
    const exclude = (reason) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
    let prompt, gap;
    let workIq = [];
    let previousWorkIq = [];
    let transitionEvent = null;
    let activityCount = 0;
    const seenCalls = new Set();
    const scriptSources = new Map();
    const nested = new Set();
    for (const event of rows) {
        const data = event.data ?? {};
        if (isHistoryGap(event)) { prompt = undefined; gap = event; previousWorkIq = []; workIq = []; transitionEvent = null; continue; }
        if (event.type === "user.message") { prompt = event; gap = undefined; previousWorkIq = workIq; workIq = []; transitionEvent = null; continue; }
        if (event.type === "assistant.message" && typeof data.content === "string" && data.content.length <= maxTextChars && explicitTransition(data.content)) { transitionEvent = event; continue; }
        if (event.type === "subagent.started" && data.toolCallId) nested.add(data.toolCallId);
        if (event.type !== "tool.execution_start") continue;
        if (!data.toolCallId) { exclude("missing-tool-call-identity"); continue; }
        if (seenCalls.has(data.toolCallId)) continue;
        seenCalls.add(data.toolCallId);
        const tool = data.toolName ?? data.mcpToolName ?? "";
        const completed = completions.get(data.toolCallId);
        if (WORKIQ_TOOL.test(tool) || data.mcpServerName === "workiq") {
            workIq.push({ toolCallId: data.toolCallId, succeeded: completed?.data?.success ?? null, startedAt: event.timestamp, completedAt: completed?.timestamp ?? null });
            continue;
        }
        const stamp = Date.parse(event.timestamp);
        if (!Number.isFinite(stamp) || stamp < since || stamp > until) continue;
        const isShell = SHELL_TOOLS.test(tool);
        const isCode = CODE_TOOLS.test(tool);
        const isGraph = GRAPH_TOOLS.test(tool) || /^(?:graph|msgraph|microsoft-graph)$/.test(data.mcpServerName ?? "");
        if (!isShell && !isCode && !isGraph) continue;
        const text = commandText(data);
        if (text.length > maxTextChars) { exclude("command-text-bound"); continue; }
        if (credentialSignal.test(text)) { exclude("credential-bearing-command"); continue; }
        let inspected = inspectGraphCommand(text, { kind: isCode ? "source" : "shell" });
        let sourceKind = isCode ? "source-reference" : "inline-command";
        let scriptRef = null;
        if (isCode) {
            // Full Add File snapshots only. Update hunks do not establish a whole executable file.
            for (const match of text.matchAll(/\*\*\* Add File: ([^\r\n]+)\r?\n([\s\S]*?)(?=\r?\n\*\*\* (?:Add File|Update File|Delete File|End Patch)|$)/g)) {
                const code = match[2].split(/\r?\n/).filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");
                if (code.length <= maxTextChars) scriptSources.set(match[1].trim().replaceAll("\\", "/").toLowerCase(), { eventId: event.id, code });
            }
        }
        if (isShell && !inspected.sites.length && !readSignal.test(text)) {
            for (const [filename, script] of scriptSources) {
                const normalizedCommand = text.replaceAll("\\", "/").toLowerCase();
                if (!normalizedCommand.includes(filename) || !/\b(?:node|python|pwsh|powershell|bash)\b/.test(text)) continue;
                const analyzed = inspectGraphCommand(script.code, { kind: "source" });
                if (analyzed.sites.length) {
                    inspected = analyzed; sourceKind = "recorded-script"; scriptRef = script.eventId;
                    // Source-to-invocation link is static code analysis, never proof each branch ran.
                    for (const site of inspected.sites) site.basis = "recorded-script-invocation";
                    break;
                }
            }
        }
        if (isGraph) {
            const args = data.arguments ?? {};
            const target = args.url ?? args.uri ?? args.path;
            const url = typeof target === "string" && target.startsWith("/") ? `https://graph.microsoft.com${target}` : target;
            if (typeof url === "string" && /^https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)\//.test(url)) {
                const method = safeMethod(args.method);
                inspected = { sites: [{ endpoint: normalizeEndpoint(url, { method }), method, offset: 0, basis: "graph-mcp-request", evidenceLevel: "requested-direct-graph", synthetic: false, confidence: "medium" }], exclusions: [] };
                sourceKind = "graph-mcp";
            } else exclude("unresolved-graph-mcp-target");
        }
        for (const reason of inspected.exclusions) exclude(reason);
        if (!inspected.sites.length) continue;
        const link = explicitPrompt(event, prompt), selectedPrompt = link ? link.event : prompt;
        const scenarioId = `history-${source.sessionId}-${selectedPrompt?.id ?? event.id}`;
        if (!scenarios.has(scenarioId)) scenarios.set(scenarioId, {
            scenarioId, title: "Recorded Office API evidence", sourceSessionId: source.sessionId,
            sourceAppId: source.appId ?? null, sourceSessionUrl: source.appUrl ?? null,
            sourceHost: "copilot-app", projectId: source.projectId ?? null, project: source.project ?? "(unscoped chat)",
            capturedAt: event.timestamp, userPrompt: selectedPrompt ? promptRecord(selectedPrompt, {
                agentCreatedFirstMessage: source.promptCreation?.actor === "agent"
                    && (!firstPromptEventId || selectedPrompt?.id === firstPromptEventId),
            }) : unavailablePrompt(link?.reason ?? gap?.data.reason ?? "unlinked", gap),
            promptAssociationEvidence: { version: 1, method: link?.method ?? (selectedPrompt ? "recorded-order" : "unavailable") }, followUpPrompts: [], toolCalls: [], graphActivities: [],
            family: "reads_functions", workloadKind: "recorded-history", sample: false, evidenceLayer: "recorded-graph-history",
            promptAssociation: "Nearest preceding recorded user message. Association is temporal, not proven causality.",
            sourceEligibility: { checkedAt: source.checkedAt ?? null, archivedAt: null, basis: source.adapter ?? "explicit-inventory-source" },
            taskCorrectness: "unknown",
        });
        const scenario = scenarios.get(scenarioId);
        if (scenario.promptAssociationEvidence.method !== link?.method) scenario.promptAssociationEvidence.method = selectedPrompt ? "recorded-order" : "unavailable";
        const requestSites = inspected.sites.filter((s) => s.evidenceLevel === "requested-direct-graph");
        const literalStatusEcho = /\b(?:echo|Write-Output|print|console\.log)\s*\(?\s*['"][^'"]*(?:HTTP\/[123]|status(?:Code|_code)?\s*[:=])[^'"]*[1-5]\d{2}/i.test(text);
        const status = visibleStatus(completed, requestSites.length, !literalStatusEcho && (isShell && sourceKind === "inline-command" || isGraph));
        const transition = selectedPrompt === prompt && (explicitTransition(prompt?.data?.content ?? "") || transitionEvent !== null);
        const preceding = (selectedPrompt !== prompt ? [] : workIq.length ? workIq : transition ? previousWorkIq : []).filter((c) => Date.parse(c.startedAt) < stamp && stamp - Date.parse(c.startedAt) <= 30 * 60 * 1000);
        const failures = preceding.filter((c) => c.succeeded === false && c.completedAt && Date.parse(c.completedAt) <= stamp);
        const association = transition && preceding.length ? "explicit-transition" : failures.length ? "same-prompt-after-failure" : preceding.length ? "same-prompt-sequence" : "none";
        for (let i = 0; i < inspected.sites.length; i++) {
            if (activityCount >= maxActivities) { exclude("activity-bound"); break; }
            const site = inspected.sites[i];
            const httpStatus = site.evidenceLevel === "requested-direct-graph" ? status.status : null;
            const evidenceLevel = httpStatus === null ? site.evidenceLevel : "output-visible-http";
            const activity = {
                activityId: id([source.sessionId, data.toolCallId, site.offset, i]),
                sourceSessionId: source.sessionId, scenarioId, toolCallId: data.toolCallId,
                startEventId: event.id, completionEventId: completed?.id ?? null,
                startedAt: event.timestamp, tool: isGraph ? "graph-mcp" : scriptRef ? "script-reference" : isCode ? "script-reference" : "shell",
                parentToolCallId: data.parentToolCallId ?? null,
                evidenceLevel, endpoint: site.endpoint, workload: classifyWorkload(site.endpoint), method: site.method,
                httpStatus, statusBasis: httpStatus === null ? "none" : status.basis,
                outputStatusEligible: !literalStatusEcho && (isShell && sourceKind === "inline-command" || isGraph),
                requestCount: null, countUnit: "recorded-request-site", confidence: site.confidence,
                synthetic: site.synthetic, sourceKind, requestBasis: site.basis,
                fallback: { association: evidenceLevel === "code-reference" ? "none" : association, precedingWorkIqCallIds: evidenceLevel === "code-reference" ? [] : preceding.map((c) => c.toolCallId), causeProven: false },
                evidenceRefs: [
                    { eventId: event.id, role: "request" },
                    ...(completed ? [{ eventId: completed.id, role: "response" }] : []),
                    ...(scriptRef ? [{ eventId: scriptRef, role: "script-source" }] : []),
                    ...(selectedPrompt?.id ? [{ eventId: selectedPrompt.id, role: "prompt" }] : []),
                    ...(transition && transitionEvent ? [{ eventId: transitionEvent.id, role: "transition" }] : []),
                ],
            };
            scenario.graphActivities.push(activity); activityCount++;
        }
    }
    return {
        scenarios: [...scenarios.values()].map(record => {
            const originalModelEvidence = recordedInteractionModels(options.modelEvents ?? events, record, {
                partialWindow: options.partialWindow === true || Boolean(options.modelEvents && Date.parse(record.userPrompt?.sourceTimestamp) < since),
            });
            return { ...record, responseTiming: recordedResponseTiming(rows, record.userPrompt),
                ...(originalModelEvidence ? { originalModelEvidence } : {}) };
        }), exclusions,
        coverage: {
            scannedEvents: rows.length, duplicateEvents: events.length - rows.length,
            graphActivities: activityCount, nestedAgentLaunches: nested.size,
            nestedVisibility: "Only tool events actually present in this source stream; subagent summaries are not replayed or promoted to requests.",
        },
    };
}

/** Pseudonymization seam for the existing export projection; no free-form source text. */
export function projectGraphActivity(activity, mapId) {
    if (typeof mapId !== "function") throw new TypeError("Existing export ID mapper is required.");
    validateGraphActivity(activity);
    const endpoint = normalizeGraphEndpoint(activity);
    const allowedAssociation = ["same-prompt-after-failure", "explicit-transition", "same-prompt-sequence", "none"];
    return {
        activityId: mapId("graph-activity", activity.activityId),
        sourceSessionId: mapId("session", activity.sourceSessionId), scenarioId: mapId("scenario", activity.scenarioId),
        toolCallId: mapId("call", activity.toolCallId), startEventId: mapId("event", activity.startEventId),
        completionEventId: mapId("event", activity.completionEventId), parentToolCallId: mapId("call", activity.parentToolCallId),
        tool: ["shell", "graph-mcp", "script-reference"].includes(activity.tool) ? activity.tool : "script-reference",
        evidenceLevel: activity.evidenceLevel, endpoint, workload: classifyWorkload(endpoint), method: endpoint.method,
        httpStatus: activity.evidenceLevel === "output-visible-http" && validStatus(activity.httpStatus) ? activity.httpStatus : null,
        statusBasis: activity.evidenceLevel === "output-visible-http" && validStatus(activity.httpStatus) ? "explicit-output-status" : "none",
        requestCount: null, countUnit: "recorded-request-site",
        confidence: ["high", "medium", "low"].includes(activity.confidence) ? activity.confidence : "low",
        synthetic: activity.synthetic === true,
        sourceKind: ["inline-command", "recorded-script", "graph-mcp", "source-reference"].includes(activity.sourceKind) ? activity.sourceKind : "source-reference",
        requestBasis: ["request-command", "javascript-request", "python-request", "graph-sdk-call", "graph-sdk-static-analysis", "graph-url-reference", "recorded-script-invocation", "graph-mcp-request"].includes(activity.requestBasis) ? activity.requestBasis : "graph-url-reference",
        fallback: {
            association: allowedAssociation.includes(activity.fallback?.association) ? activity.fallback.association : "none",
            precedingWorkIqCallIds: (activity.fallback?.precedingWorkIqCallIds ?? []).map((v) => mapId("call", v)),
            causeProven: false,
        },
        evidenceRefs: (activity.evidenceRefs ?? []).map((r) => ({ eventId: mapId("event", r.eventId), role: r.role })),
    };
}

export function normalizeGraphEndpoint(activity) {
    return normalizeEndpoint({
        path: activity.endpoint?.path,
        query: (activity.endpoint?.queryShape ?? []).map((key) => ({ key })),
    }, { method: activity.method, apiVersion: activity.endpoint?.apiVersion });
}

export function validateGraphActivity(a) {
    if (!a || typeof a !== "object" || !GRAPH_ACTIVITY_LEVELS.includes(a.evidenceLevel)
        || !["shell", "graph-mcp", "script-reference"].includes(a.tool)
        || !["inline-command", "recorded-script", "graph-mcp", "source-reference"].includes(a.sourceKind)
        || !["high", "medium", "low"].includes(a.confidence)
        || !["none", "explicit-output-status"].includes(a.statusBasis)
        || !["request-command", "javascript-request", "python-request", "graph-sdk-call", "graph-sdk-static-analysis", "graph-url-reference", "recorded-script-invocation", "graph-mcp-request"].includes(a.requestBasis)
        || !OFFICE_WORKLOADS.includes(a.workload)
        || a.countUnit !== "recorded-request-site" || a.requestCount !== null || typeof a.synthetic !== "boolean"
        || !a.endpoint || typeof a.endpoint.path !== "string"
        || !["activityId", "sourceSessionId", "scenarioId", "toolCallId", "startEventId"].every((k) => typeof a[k] === "string" && a[k].length > 0)
        || a.method !== null && !METHODS.has(a.method)
        || a.httpStatus !== null && (!validStatus(a.httpStatus) || a.evidenceLevel !== "output-visible-http")
        || a.evidenceLevel === "output-visible-http" && (!validStatus(a.httpStatus) || a.statusBasis !== "explicit-output-status")
        || !Array.isArray(a.evidenceRefs) || !a.evidenceRefs.every((r) => r && typeof r.eventId === "string" && ["request", "response", "script-source", "prompt", "transition"].includes(r.role))
        || !a.fallback || !["none", "same-prompt-after-failure", "explicit-transition", "same-prompt-sequence"].includes(a.fallback.association)
        || a.fallback.causeProven !== false || !Array.isArray(a.fallback.precedingWorkIqCallIds) || !a.fallback.precedingWorkIqCallIds.every((v) => typeof v === "string")) {
        throw new TypeError("Unsupported or incomplete Graph activity schema.");
    }
    return a;
}

export function assertSourceSession(source) {
    if (!source?.eligible || !UUID.test(source.sessionId) || source.archiveEvidence?.archived_at != null || source.archiveEvidence?.workspaces?.some((w) => w.archived_at != null)) {
        throw new TypeError("An explicit eligible unarchived source mapping is required.");
    }
}
