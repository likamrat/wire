import { createHash } from "node:crypto";
import { TAIL_LIMITS } from "./collector-io.mjs";
import { qualifiedHooks } from "./completion-recovery.mjs";
import { retainEvent } from "./collector.mjs";
import { callIdentity, eventIdentity, filterDeletedRecords, recordUnits } from "./deletion-identities.mjs";
import { isWorkIqTool } from "./graph-history.mjs";
import { completionResult } from "./graph-history-io.mjs";
import { extractScenarios, managedErrorServers } from "./history.mjs";
import { findCredentialFindings } from "./privacy-text.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { BoardError } from "./store.mjs";

// Per selected source. Do not truncate an index or discard an older collision on overflow.
const limits = Object.freeze({ parts: 1024, entries: 20000, candidates: 1024, retainedBytes: 4 * 1024 ** 2,
    memberBytes: 16384, nodes: 4096, depth: 24, requests: 32, indexKeys: 65536,
    checkpointBytes: 2 * 1024 ** 2, markers: 100000, contextKeys: 4096 });
const P = "user.message", A = "assistant.message", S = "tool.execution_start", E = "tool.execution_complete";
const TURN_START = "assistant.turn_start", TURN_END = "assistant.turn_end";
const MODE_CHANGE = "session.mode_changed", PERMISSIONS = "session.permissions_changed", MODE_NOTICE = "session.mode_notice_delivered";
const sessionModes = new Set(["interactive", "plan", "autopilot"]);
const permissionModes = new Set(["manual", "assisted", "allow-all"]);
const rootKeys = ["id", "type", "timestamp", "parentId", "agentId", "data"];
const dataKeys = {
    "session.start": ["sessionId", "version", "startTime", "producer", "copilotVersion", "alreadyInUse", "context",
        "contextTier", "githubMcpToolConfig", "reasoningEffort", "remoteSteerable", "selectedModel"],
    [P]: ["messageId", "turnId", "content", "source", "isAutopilotContinuation", "transformedContent", "delivery", "agentMode"],
    [A]: ["messageId", "originatingMessageId", "turnId", "parentToolCallId", "toolRequests", "content", "model", "phase", "apiCallId"],
    [S]: ["toolCallId", "toolName", "mcpToolName", "mcpServerName", "mcpConfigServerName", "arguments",
        "turnId", "parentToolCallId", "mcpTransport", "model"],
    [E]: ["toolCallId", "success", "turnId", "parentToolCallId", "model", "error", "result"],
    [TURN_START]: ["turnId"], [TURN_END]: ["turnId"],
    [MODE_CHANGE]: ["previousMode", "newMode"],
    [PERMISSIONS]: ["previousMode", "mode"],
    [MODE_NOTICE]: ["mode", "instructionUpdatePersisted"],
    "hook.start": ["hookInvocationId", "hookType", "input"],
    "hook.end": ["hookInvocationId", "hookType", "success"],
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const id = value => typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9_.:-]+$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = text => createHash("sha256").update(text).digest("hex");
const refuse = why => { throw Object.assign(new BoardError(`Cannot verify individual calls: ${why}.`, 422),
    { code: "EXACT_EVIDENCE_UNVERIFIED" }); };
const bound = () => { throw Object.assign(new BoardError("This source exceeds the individual-call proof limit.", 413),
    { code: "EXACT_EVIDENCE_LIMIT" }); };
const credential = text => findCredentialFindings(text).length !== 0;

// Check depth before stringify/parser helpers. For checkpoint comparisons use the on-disk JSON
// preimage (object order and JS-only undefined properties aren't retained facts).
function jsonPreimage(value, { sorted = false, visitString, maxChars = TAIL_LIMITS.maxLineBytes } = {}) {
    let nodes = 0, chars = 0;
    function walk(v, depth) {
        if (++nodes > limits.nodes || depth > limits.depth) bound();
        if (typeof v === "number" && !Number.isFinite(v)) refuse("nonfinite JSON value");
        if (typeof v === "string") {
            if ((chars += v.length) > maxChars) bound();
            visitString?.(v);
        }
        if (Array.isArray(v)) {
            if (v.length > limits.nodes) bound();
            return v.map(child => walk(child, depth + 1));
        }
        if (object(v)) {
            const names = Object.keys(v);
            if (names.length > limits.nodes) bound();
            if (sorted) names.sort();
            return Object.fromEntries(names.map(k => {
                if ((chars += k.length) > maxChars) bound();
                return [k, walk(v[k], depth + 1)];
            }));
        }
        return v;
    }
    return JSON.stringify(walk(value, 0));
}

function checkpointIndex(rows, witness) {
    if (!Array.isArray(rows) || rows.length > 2 * TAIL_LIMITS.maxContextEvents) bound();
    const index = new Map();
    let bytes = 0;
    for (const row of rows) {
        // Even a reference/legacy/unknown row can contradict a chain. Look for its aliases
        // before requiring a recognized type or field layout, including nested request IDs.
        const refs = new Set();
        const text = jsonPreimage(row, { sorted: true, visitString: v => { if (id(v)) refs.add(hash(v)); } });
        if ((bytes += Buffer.byteLength(text)) > limits.checkpointBytes) bound();
        const signature = hash(text);
        witness.update(signature);
        for (const ref of refs) {
            const matches = index.get(ref) ?? [];
            if (matches.length <= 4) matches.push(signature);
            index.set(ref, matches);
        }
        if (index.size > limits.indexKeys) bound();
    }
    return index;
}

function markerSet(values) {
    if (!Array.isArray(values) || values.length > limits.markers || !values.every(sha)) bound();
    return new Set(values);
}
function logicalName(d) {
    return d.mcpToolName ?? d.toolName?.replace(/^workiq-/, "");
}
function qualifiedName(d, mapped) {
    const logical = logicalName(d);
    if (!isWorkIqTool({ ...d, wireManagedWorkIq: mapped })) return false;
    const server = d.mcpServerName ?? d.mcpConfigServerName;
    if (server && d.mcpConfigServerName && server !== d.mcpConfigServerName) return false;
    return (!server || server === "workiq") && d.toolName === `workiq-${logical}`
        || server === "workiq" && d.toolName === logical
        || mapped && /^cc-[A-Za-z0-9_-]+$/.test(server ?? "") && [logical, `${server}-${logical}`].includes(d.toolName);
}
function rawRefs(e, causalParent) {
    const d = e.data;
    return [e.id, causalParent ? undefined : e.parentId, e.agentId, d.toolCallId, d.parentToolCallId, d.messageId, d.originatingMessageId, d.apiCallId,
        // Starts in the same turn aren't necessarily the same request. A second response
        // claiming the turn, on the other hand, makes this narrow attribution ambiguous.
        ...([P, A].includes(e.type) ? [d.turnId] : []), ...(d.toolRequests ?? []).map(r => r.toolCallId)].filter(id);
}
function ordinaryEnvelope(e) {
    if (!keys(e, rootKeys) || !id(e.id) || !instant(e.timestamp) || !Object.hasOwn(dataKeys, e.type)
        || !keys(e.data, dataKeys[e.type])) return false;
    const d = e.data;
    return (![S, E].includes(e.type) || id(d.toolCallId)) && (e.type !== S || id(d.toolName))
        && ["agentId", "parentId"].every(k => !Object.hasOwn(e, k) || id(e[k])
            || k === "parentId" && e.type === "session.start" && e.parentId === null)
        && ["messageId", "originatingMessageId", "turnId", "toolCallId", "parentToolCallId", "apiCallId",
            "toolName", "mcpToolName", "mcpServerName", "mcpConfigServerName", "model", "mcpTransport"]
            .every(k => !Object.hasOwn(d, k) || id(d[k]))
        && (!Object.hasOwn(d, "toolRequests") || Array.isArray(d.toolRequests) && d.toolRequests.length <= limits.requests
            && d.toolRequests.every(r => keys(r, ["toolCallId"]) && id(r.toolCallId)));
}

// Only for closed metadata-only shapes whose keys and string values are plain ASCII
// identifiers/timestamps. Their compact JSON is a lower bound on the source bytes.
// Allow LF/CRLF, not enough slack for duplicate keys lost to readTail's JSON.parse.
function compactMetadata(e, span) {
    const bytes = Buffer.byteLength(JSON.stringify(e));
    return span <= limits.memberBytes && (span === bytes + 1 || span === bytes + 2);
}

function sensitiveOriginal(e) {
    // JSON quoting can obscure assignments embedded in a string. Screen both
    // original scalars and serialized key/value pairs.
    let sensitive = false;
    const text = jsonPreimage(e, { visitString: v => { sensitive ||= credential(v); } });
    return sensitive || credential(text);
}

// Protocol-v3 StartData, WorkingDirectoryContext and GitHubMcpToolConfig.
// Only the bounded observed subset is supported; none of it establishes a grant.
function sdkStartup(d) {
    const text = s => typeof s === "string" && s.length > 0 && s.length <= 4096 && s.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(s);
    const flags = (o, names) => names.every(k => !Object.hasOwn(o, k) || typeof o[k] === "boolean");
    const c = d.context, tools = d.githubMcpToolConfig;
    return instant(d.startTime) && id(d.producer) && id(d.copilotVersion)
        && flags(d, ["alreadyInUse", "remoteSteerable"])
        && ["reasoningEffort", "selectedModel"].every(k => !Object.hasOwn(d, k) || id(d[k]))
        && (!Object.hasOwn(d, "contextTier") || [null, "default", "long_context"].includes(d.contextTier))
        && (!Object.hasOwn(d, "context") || keys(c, ["cwd", "gitRoot", "repository", "repositoryHost", "branch", "headCommit", "baseCommit", "hostType", "pendingGitContext"])
            && text(c.cwd) && flags(c, ["pendingGitContext"]) && (!Object.hasOwn(c, "hostType") || ["github", "ado"].includes(c.hostType))
            && ["gitRoot", "repository", "repositoryHost", "branch", "headCommit", "baseCommit"].every(k => !Object.hasOwn(c, k) || text(c[k])))
        && (!Object.hasOwn(d, "githubMcpToolConfig") || keys(tools, ["additionalTools", "additionalToolsets", "enableAllTools", "enableInsidersMode"])
            && flags(tools, ["enableAllTools", "enableInsidersMode"]) && ["additionalTools", "additionalToolsets"].every(k =>
                !Object.hasOwn(tools, k) || Array.isArray(tools[k]) && tools[k].length <= 64 && tools[k].every(id)));
}

function matchesNext(window, e, selected, managed, causalParent) {
    const [p, a, s] = window, d = e.data;
    switch (e.type) {
    case P: return true;
    case A: return window.length === 1 && e.parentId === p.event.id && d.originatingMessageId === p.message
        && id(d.messageId) && id(d.turnId) && (!p.turn || p.turn === d.turnId) && d.toolRequests?.length === 1;
    case S: return window.length === 2 && selected && e.parentId === a.event.id && d.toolCallId === a.request
        && d.turnId === a.turn && qualifiedName(d, managed.has(e.id)) && object(d.arguments);
    case E: return window.length === 3 && e.parentId === (causalParent ?? s.event.id) && d.toolCallId === a.request
        && d.turnId === a.turn && (!Object.hasOwn(d, "success") || typeof d.success === "boolean");
    default: return false;
    }
}

// A synchronous, one-source, one-pass verifier. Caller owns selected-source mapping,
// physical file/EOF and checkpoint fences, access, cancellation, aliases and publication.
export function createExactEvidence(source, scope, { deletion, checkpointEvents } = {}) {
    const { sessionId } = source;
    const { since, until } = scope;
    if (!id(sessionId) || source.eligible !== true || !instant(since) || !instant(until) || since > until) {
        refuse("unsupported selected source or interval");
    }
    const ids = source.managedWorkIqEventIds ?? [];
    if (!Array.isArray(ids) || ids.length > limits.markers || !ids.every(id)) bound();
    const managed = new Set(ids);
    const agentCreated = source.promptCreation?.actor === "agent";
    const parserSource = Object.fromEntries(["sessionId", "appId", "appUrl", "project", "projectId", "name", "checkedAt", "adapter"]
        .map(k => [k, source[k]]));
    if (Object.values(parserSource).some(v => v != null && (typeof v !== "string" || v.length > 4096))
        || credential(JSON.stringify(parserSource))) refuse("unsupported source metadata");
    const deletedEvents = markerSet(deletion?.events ?? []), deletedCalls = markerSet(deletion?.contextCalls ?? []);
    const deletedUnits = markerSet(deletion?.identities ?? []);
    const witness = createHash("sha256").update(JSON.stringify(["wire-exact-v1", sessionId, since, until]));
    for (const eventId of ids) witness.update(JSON.stringify(eventId));
    const checkpoint = checkpointIndex(checkpointEvents, witness);

    const uses = new Map(), turns = new Set(), names = new Set(), hooks = [], proposals = [];
    const contextRefs = new Map();
    let openTurn, lastModeNotice, openHook;
    let window = [], firstPrompt, boot, sourceIdentity, stamp, size, offset = 0, parts = 0, entries = 0, projected = 0;
    let starts = 0, resultBytes = 0, terminal = false;
    let causalChainSeen = false, distinctOriginals = true;
    const used = key => uses.get(key) ?? 0;
    const count = key => {
        uses.set(key, used(key) + 1);
        if (uses.size + contextRefs.size > limits.indexKeys) bound();
    };
    function permittedContextId(value) {
        return value !== sessionId && value !== boot && !managed.has(value) && !credential(value)
            && !deletedEvents.has(eventIdentity(sessionId, value)) && !deletedCalls.has(callIdentity(sessionId, value));
    }
    function contextKey(value) {
        if (!permittedContextId(value)) refuse("context has a reserved, sensitive or suppressed identity");
        return hash(value);
    }
    function claimContext(key, signatures) {
        if (contextRefs.has(key)) refuse("context identities are not unique");
        contextRefs.set(key, signatures);
        if (contextRefs.size > limits.contextKeys || uses.size + contextRefs.size > limits.indexKeys) bound();
    }
    // The root-only turn subset from retainResponseTimingEvent is its own retention
    // preimage. Never use a boundary to supply a parent, time or turn for a member.
    function boundary(e, item) {
        if (e.parentId || e.agentId || !id(e.data.turnId) || !compactMetadata(e, item.endOffset - item.offset)) {
            refuse("unsupported turn boundary");
        }
        const key = contextKey(e.data.turnId), signature = hash(jsonPreimage(e, { sorted: true }));
        claimContext(contextKey(e.id), [signature]);
        if (e.type === TURN_END && openTurn?.endOffset === item.offset && openTurn.key === key) {
            if (e.timestamp < openTurn.timestamp) refuse("reversed turn boundaries");
            contextRefs.get(key).push(signature);
        } else claimContext(key, [signature]);
        openTurn = e.type === TURN_START ? { key, timestamp: e.timestamp, endOffset: item.endOffset } : null;
        window = [];
    }
    // Narrow, text-free subsets of the protocol-v3 SDK's generated session events.
    // These describe the source application. They never convey WIRE authorization.
    function modeBoundary(e, item) {
        const d = e.data;
        const valid = e.type === MODE_CHANGE ? sessionModes.has(d.previousMode) && sessionModes.has(d.newMode)
            : e.type === PERMISSIONS ? permissionModes.has(d.mode) && (!Object.hasOwn(d, "previousMode") || permissionModes.has(d.previousMode))
                : sessionModes.has(d.mode) && (!Object.hasOwn(d, "instructionUpdatePersisted") || typeof d.instructionUpdatePersisted === "boolean");
        const prior = lastModeNotice;
        if (!valid || e.agentId || !compactMetadata(e, item.endOffset - item.offset)
            || e.parentId && e.parentId !== boot && !(prior?.endOffset === item.offset && prior.key === hash(e.parentId)
                && prior.timestamp <= e.timestamp)) refuse("unsupported session mode metadata");
        const key = contextKey(e.id);
        // The collector does not retain these events: a checkpoint claiming their IDs
        // would contradict their proposed role as disjoint session metadata.
        claimContext(key, []);
        lastModeNotice = { key, endOffset: item.endOffset, timestamp: e.timestamp };
        window = [];
    }
    function hook(e, projected, item) {
        const d = e.data, input = d.input;
        if (!boot || e.parentId !== boot || e.agentId || d.hookType !== "postToolUse" || !id(d.hookInvocationId)
            || !keys(input, ["sessionId", "toolCallId", "toolName", "toolArgs", ...(!projected ? ["toolResult"] : [])])
            || input.sessionId !== sessionId || !id(input.toolCallId) || !id(input.toolName) || !keys(input.toolArgs, [])) {
            refuse("an omitted or unsupported hook cannot be classified");
        }
        const refs = [e.id, d.hookInvocationId, input.toolCallId].map(hash);
        if (new Set(refs).size !== refs.length) refuse("ambiguous hook identities");
        for (const key of refs) count(key);
        hooks.push({ refs, name: hash(input.toolName) });
        openHook = !projected && !Object.hasOwn(input, "toolResult") && permittedContextId(input.toolCallId)
            && !credential(input.toolName) && compactMetadata(e, item.endOffset - item.offset)
            ? { refs, timestamp: e.timestamp, endOffset: item.endOffset } : null;
        window = [];
    }
    function closeHook(e, item) {
        const d = e.data;
        if (openHook?.endOffset !== item.offset || e.agentId || !id(e.parentId) || !id(d.hookInvocationId)
            || d.hookType !== "postToolUse" || typeof d.success !== "boolean" || e.timestamp < openHook.timestamp
            || !compactMetadata(e, item.endOffset - item.offset) || contextKey(e.parentId) !== openHook.refs[0]
            || contextKey(d.hookInvocationId) !== openHook.refs[1] || openHook.refs.some(key => checkpoint.has(key))) {
            refuse("the hook end is not uniquely linked to a disjoint original hook");
        }
        claimContext(contextKey(e.id), []);
        openHook = null;
        window = [];
    }
    function member(e, byteLength, selected, refs, causalParent) {
        const d = e.data, [p, a, s] = window;
        if (e.type === P) window = [];
        if (e.timestamp < since || e.timestamp > until || byteLength > limits.memberBytes
            || !matchesNext(window, e, selected, managed, causalParent) || e.agentId || d.parentToolCallId
            || e.type === P && (!id(d.messageId) || e.parentId && e.parentId !== boot
                || typeof d.content !== "string" || !d.content.trim() || firstPrompt === e.id && agentCreated)
            || window.length && window.at(-1).event.timestamp > e.timestamp
            || deletedEvents.has(eventIdentity(sessionId, e.id)) || id(d.toolCallId) && deletedCalls.has(callIdentity(sessionId, d.toolCallId))) {
            window = []; return;
        }
        if (sensitiveOriginal(e) || e.type === P && Object.hasOwn(d, "transformedContent")
            && promptAuthorship.fromEvent({ ...e, data: { ...d, source: undefined } }).basis !== "host-direct-input") {
            window = []; return;
        }
        if (e.type === E) {
            const { structured } = completionResult(d.result);
            const rows = structured?.results ?? structured?.responses;
            if (Array.isArray(rows) && rows.some(r => r && Object.hasOwn(r, "wireErrorDiagnostic"))) {
                window = []; return; // A raw result cannot supply WIRE's retained diagnostic projection.
            }
        }
        const retained = retainEvent(e, { credentialExclusions: 0 }, { managedWorkIqEventIds: managed,
            managedErrorServers: e.type === E ? managedErrorServers([e], [s.event], managed) : undefined });
        if (!retained || credential(JSON.stringify(retained)) || e.type === P && retained.data.wirePromptAuthorship.actor !== "user") {
            window = []; return;
        }
        const signature = hash(jsonPreimage(retained, { sorted: true }));
        // Only retention-approved parser inputs survive a part. Never keep raw input,
        // transformed prompt, reply/fallback text, result body, or an unfinished line.
        if (e.type === A) delete retained.data.content;
        if (e.type === S) retained.data.arguments = structuredClone(retained.data.arguments);
        window.push({ event: retained, signature, refs, message: d.messageId, turn: d.turnId, apiCall: d.apiCallId,
            request: d.toolRequests?.[0]?.toolCallId });
        if (e.type !== E) return;
        const chain = window; window = [];
        const identities = [boot, p.event.id, a.event.id, s.event.id, e.id, p.message, a.message, a.turn, a.request, a.apiCall].filter(id);
        if (new Set(identities).size !== identities.length) return;
        const { scenarios } = extractScenarios(chain.map(x => x.event), parserSource, since, until, { partialWindow: true });
        const record = scenarios[0], call = record?.toolCalls[0];
        if (scenarios.length !== 1 || record.toolCalls.length !== 1 || record.promptAssociationEvidence.method !== "explicit-message"
            || record.userPrompt.sourceEventId !== p.event.id || call.toolCallId !== a.request
            || call.startEventId !== s.event.id || call.completionEventId !== e.id) return;
        if (recordUnits(record).some(u => u.aliases.some(alias => deletedUnits.has(alias)))) return;
        if ((resultBytes += Buffer.byteLength(JSON.stringify(record))) > limits.retainedBytes) bound();
        const bootKey = hash(boot);
        proposals.push({ record, refs: chain.flatMap(x => x.refs).filter(key => key !== bootKey),
            signatures: chain.map(x => x.signature) });
    }
    function observe(item, projectedEntry, part) {
        const e = item.event;
        if (!ordinaryEnvelope(e)) refuse("an event has an unclassified envelope");
        const span = item.endOffset - item.offset;
        const text = projectedEntry ? item.sha256 : hash(jsonPreimage(e));
        if (!projectedEntry && text !== item.originalDigest) distinctOriginals = false;
        witness.update(JSON.stringify([item.offset, item.endOffset, text]));
        if (projectedEntry && e.type !== "hook.start") refuse("an oversized event is not a disjoint hook");
        if (!boot) {
            if (item.offset || e.type !== "session.start" || e.data.sessionId !== sessionId || e.data.version !== 1
                || e.parentId || e.agentId) refuse("unverified startup");
            boot = e.id;
            if (Object.hasOwn(e, "parentId") || Object.keys(e.data).length > 2) {
                if (span > limits.memberBytes || item.originalDigest !== text || sensitiveOriginal(e)
                    || deletedEvents.has(eventIdentity(sessionId, e.id))
                    || Object.keys(e.data).length > 2 && !sdkStartup(e.data)) refuse("unsupported SDK startup header");
                const { sessionId: _session, version: _version, startTime: _time, ...metadata } = e.data;
                const refs = new Set();
                jsonPreimage(metadata, { visitString: v => { if (id(v)) refs.add(contextKey(v)); } });
                for (const key of refs) claimContext(key, []);
            }
        } else if (e.type === "session.start" || e.id === boot) refuse("ambiguous startup");
        let causalParent;
        if (part.hooks.length || e.type === "hook.start" && window.length === 3 && e.parentId === window[2].event.id) {
            const prior = part.hooks.at(-1) ?? part.start;
            if (!part.start || !managed.has(part.start.id) || projectedEntry || e.agentId || e.timestamp < prior.timestamp || e.timestamp > until
                || e.parentId !== prior.id) refuse("incomplete or conflicting causal hook chain");
            if (part.hooks.length < 6) {
                const at = e.data.input?.timestamp;
                if (!["hook.start", "hook.end"].includes(e.type) || span > limits.memberBytes
                    || at !== undefined && (!Number.isSafeInteger(at) || at < Date.parse(since) || at > Date.parse(until))) {
                    refuse("expected a bounded original causal hook");
                }
                if (sensitiveOriginal(e)) refuse("sensitive causal hook");
                part.hooks.push(e);
                return;
            }
            causalParent = prior.id;
            if (e.type !== E || e.data.parentToolCallId || !matchesNext(window, e, false, managed, causalParent)
                || !qualifiedHooks(part.hooks, part.start, sessionId)) refuse("unsupported causal hook chain");
            // These are exclusive internal identities, not additional parser inputs.
            // Exempt only the already verified completion-to-last-hook edge from
            // their EOF disjointness check. The collector does not checkpoint hooks.
            for (const h of part.hooks) {
                claimContext(contextKey(h.id), []);
                if (h.type === "hook.start") claimContext(contextKey(h.data.hookInvocationId), []);
            }
            causalChainSeen = true;
            part.hooks.length = 0;
        }
        part.start = null;
        if (e.type === MODE_CHANGE || e.type === PERMISSIONS || e.type === MODE_NOTICE) { modeBoundary(e, item); return; }
        if (e.type === TURN_START || e.type === TURN_END) { boundary(e, item); return; }
        if (e.type === "hook.start") { hook(e, projectedEntry, item); return; }
        if (e.type === "hook.end") { closeHook(e, item); return; }
        const refs = rawRefs(e, causalParent).map(hash);
        for (const key of refs) count(key);
        if (id(e.data.turnId)) turns.add(hash(e.data.turnId));
        if (e.type === P) firstPrompt ??= e.id;
        // The recognizable-but-unmapped cc shape contributes only to exclusions. A
        // generic method name on some other service isn't even a Work IQ candidate.
        const opaque = /^cc-[A-Za-z0-9_-]+$/.test(e.data.mcpServerName ?? e.data.mcpConfigServerName ?? "");
        const recognizable = e.type === S && isWorkIqTool({ ...e.data, wireManagedWorkIq: opaque || managed.has(e.id) });
        const selected = recognizable && e.timestamp >= since && e.timestamp <= until;
        if (e.type === S) {
            for (const n of [e.data.toolName, logicalName(e.data), recognizable && `workiq-${logicalName(e.data)}`].filter(id)) names.add(hash(n));
        }
        if (selected && ++starts > limits.candidates) bound();
        if (e.type !== "session.start") member(e, span, selected, refs, causalParent);
        if (e.type === S && window.length === 3) part.start = e;
    }
    function consume(tail) {
        if (terminal) refuse("the scan is closed");
        terminal = true;
        const c = tail?.cursor, r = tail?.recovery;
        if (++parts > limits.parts) bound();
        if (!r || !c || tail.reset || c.rotations !== 0 || c.droppedBytes !== 0 || c.skipping || c.malformedLines !== 0
            || tail.fenceTruncated || tail.fenceAnchor !== undefined || r.readStart !== offset
            || ![c.offset, c.logBytes, c.partialBytes, r.readEnd].every(Number.isSafeInteger) || c.partialBytes < 0
            || c.offset < offset || r.readEnd !== c.offset + c.partialBytes || r.readEnd > c.logBytes
            || r.readEnd - offset > TAIL_LIMITS.chunkBytes || c.backlogBytes !== c.logBytes - c.offset
            || typeof r.sourceIdentity !== "string" || !r.sourceIdentity || r.sourceIdentity !== c.identity
            || typeof r.sourceStamp !== "string" || !r.sourceStamp || sourceIdentity !== undefined
                && (r.sourceIdentity !== sourceIdentity || r.sourceStamp !== stamp || c.logBytes !== size)
            || !Array.isArray(r.original) || !Array.isArray(r.projected)) refuse("incomplete or changed source coverage");
        if (c.logBytes > TAIL_LIMITS.initialFileBytes || (entries += r.original.length + r.projected.length) > limits.entries) bound();
        if (sourceIdentity === undefined) {
            witness.update(JSON.stringify([r.sourceIdentity, r.sourceStamp, c.logBytes]));
        }
        sourceIdentity = r.sourceIdentity; stamp = r.sourceStamp; size = c.logBytes;
        // Each stream is in file order. Its union must tile the COMMITTED span, not readEnd:
        // readTail retries [cursor.offset, readEnd) from source on its next call.
        // Raw hook inputs (including toolResult) and the original start belong
        // to this call only. Never carry them into a continuation or checkpoint.
        const part = { start: null, hooks: [] };
        let i = 0, j = 0;
        while (i < r.original.length || j < r.projected.length) {
            const next = r.projected[j], isProjection = next && (!r.original[i] || next.offset < r.original[i].offset);
            const item = isProjection ? r.projected[j++] : r.original[i++];
            if (item.offset !== offset || !Number.isSafeInteger(item.endOffset) || item.endOffset <= offset
                || item.endOffset > c.offset || isProjection && !sha(item.sha256)) refuse("an unclassified byte region was encountered");
            observe(item, Boolean(isProjection), part);
            offset = item.endOffset;
        }
        projected += r.projected.length;
        if (part.hooks.length) refuse("a causal hook chain crosses a read boundary");
        if (offset !== c.offset || c.oversizedLines !== projected) refuse("not all committed bytes were classified");
        terminal = false;
    }
    function finish() {
        if (terminal || !boot || offset !== size) refuse("the complete source was not visited");
        terminal = true;
        if (causalChainSeen && !distinctOriginals) refuse("an original could conceal another causal identity");
        // Check once at EOF: a later, unmapped or out-of-interval event can still
        // claim either alias. A matching checkpoint is corroboration, never a mate.
        for (const [key, signatures] of contextRefs) {
            const matches = checkpoint.get(key) ?? [];
            if (used(key) || turns.has(key) || names.has(key) || new Set(matches).size !== matches.length
                || matches.some(sig => !signatures.includes(sig))) refuse("context is not independently disjoint");
        }
        if (hooks.some(h => h.refs.some(key => used(key) !== 1 || turns.has(key)) || names.has(h.name))) {
            refuse("a hook may refer to another observed invocation");
        }
        const records = [];
        for (const { refs, signatures, record } of proposals) {
            const expected = new Map();
            for (const key of refs) expected.set(key, (expected.get(key) ?? 0) + 1);
            if ([...expected].some(([key, n]) => used(key) !== n)) continue;
            if ([...expected.keys()].some(key => {
                const matches = checkpoint.get(key) ?? [];
                return matches.length > 4 || new Set(matches).size !== matches.length || matches.some(sig => !signatures.includes(sig));
            })) continue;
            records.push(record);
        }
        // All event tombstones (including replacement prompts), context-call and unit aliases
        // were screened before admission. Do not consult restore authorizations in new-only mode.
        const cleaned = filterDeletedRecords(records, { events: deletedEvents, identities: deletedUnits });
        window = []; proposals.length = 0;
        witness.update(JSON.stringify([starts, projected, cleaned.map(r => [r.scenarioId, r.toolCalls[0].startEventId])]));
        return { records: cleaned, excluded: starts - cleaned.length, omittedRegions: projected, witness: witness.digest("hex") };
    }
    return { consume, finish };
}
