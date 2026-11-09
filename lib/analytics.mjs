// Pure metadata aggregation. This is not an export/privacy boundary.
import { time as civilTime } from "./time.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { GRAPH_ORIGIN as GRAPH, graphTargetParts, isSharedDriveItemPath } from "./graph.mjs";

export const OUTCOMES = Object.freeze(["success", "failure", "unknown", "partial", "other", "transport"]);
const TOOLS = new Set(["ask", "list_agents", "retrieve", "search_paths", "get_schema", "fetch", "fetch_blob", "call_function", "do_action", "create_entity", "update_entity", "delete_entity"].map((name) => `workiq-${name}`));
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]);
const VERSIONS = new Set(["v1.0", "beta"]);
const SEGMENTS = new Set(("me users groups teams chats channels messages events calendar calendarView calendars drive drives items children root sites lists members owners attachments planner plans tasks buckets mailFolders inbox sentitems drafts deleteditems manager directReports joinedTeams businessapps connectors tools applications servicePrincipals organization subscriptions contacts contactFolders permissions permissionsDetails worksheets workbook tables rows columns range usedRange tablesOfContents notebooks sections pages onenote outlook people presence authentication methods todo taskLists activities files recent sharedWithMe followedSites onlineMeetings recordings transcripts attendanceReports installedApps operations education classes assignments submissions termStore sets terms contentTypes columns versions insights shared trending used photo photos content thumbnails extensions instances schedule schedulingGroups shifts teamwork solutions virtualEvents webinars sessions transitiveMembers transitiveMemberOf memberOf ownedObjects registeredDevices managedDevices devices reports auditLogs signIns directoryObjects directoryRoles oauth2PermissionGrants roleManagement identity directory recycleBin external connections schema settings $metadata $batch $value $ref $count delta search query").split(" "));
SEGMENTS.add("replies");
const ENTITY_COLLECTIONS = new Set(("users groups teams chats channels messages events calendars drives items sites lists members owners attachments plans tasks buckets mailFolders contacts contactFolders applications servicePrincipals subscriptions notebooks sections pages worksheets tables columns versions onlineMeetings recordings transcripts attendanceReports installedApps classes assignments submissions sets terms devices directoryObjects connections schedulingGroups shifts").split(" "));
const FUNCTIONS = new Set(("delta search getByIds getMemberGroups getMemberObjects getSchedule findMeetingTimes getMailTips getActivitiesByInterval getTotalFileCount getOffice365ActiveUserDetail getOffice365ActiveUserCounts getEmailActivityUserDetail getEmailActivityCounts getTeamsUserActivityUserDetail getTeamsUserActivityCounts getOneDriveUsageAccountDetail getSharePointSiteUsageDetail getYammerActivityUserDetail getMailboxUsageDetail getManagedDevicesWithAppFailures getAllMessages getAllRetainedMessages getAllTranscripts getAllRecordings checkMemberGroups checkMemberObjects validateProperties copy move reply replyAll forward createReply createReplyAll createForward send sendMail accept tentativelyAccept decline cancel dismissReminder snoozeReminder markAsRead markAsUnread archive unarchive add remove complete subscribeToContent unsubscribeFromContent preview invite createLink assignLicense restore permanentDelete checkout checkin refreshSession createSession closeSession calculate addPassword removePassword addKey removeKey validatePermission publish unpublish applySensitivityLabel getSensitivityLabels extractSensitivityLabels").split(" "));
const QUERY_KEYS = new Set(["$select", "$filter", "$search", "$orderby", "$top", "$skip", "$skiptoken", "$expand", "$count", "$format", "$deltatoken", "startDateTime", "endDateTime"]);
const PARAMETERS = new Set(["q", "query", "period", "date", "startDateTime", "endDateTime", "userId", "groupId", "id", "ids", "address", "addresses", "includeHiddenFolders"]);
const key = (prefix, parts) => `${prefix}:${JSON.stringify(parts)}`;
const present = (value) => typeof value === "string" && value.length > 0;
const validStatus = (value) => Number.isInteger(value) && value >= 100 && value <= 599;
const duration = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const time = (value) => present(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function functionShape(part) {
    const match = /^(?:microsoft\.graph\.)?([A-Za-z][A-Za-z0-9]*)(?:\((.*)\))?$/.exec(part);
    if (!match || !FUNCTIONS.has(match[1])) return null;
    const name = `${part.startsWith("microsoft.graph.") ? "microsoft.graph." : ""}${match[1]}`;
    if (match[2] === undefined) return name;
    const names = [...match[2].matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9]*)\s*=/g)].map((m) => PARAMETERS.has(m[1]) ? m[1] : "{argument}");
    return `${name}(${names.length ? [...new Set(names)].sort().map((n) => `${n}={value}`).join(",") : match[2].trim() ? "{value}" : ""})`;
}

/**
 * A conservative endpoint template, never a raw URL. Query SHAPE is keys only.
 * Canonical string paths and projected {path,query} objects are supported.
 * Unknown navigation/operation names are withheld, not guessed.
 */
export function normalizeEndpoint(value, { method = null, apiVersion = null } = {}) {
    const input = graphTargetParts(value);
    const version = VERSIONS.has(apiVersion) ? apiVersion : input.version;
    const wireMethod = METHODS.has(method) ? method : null;
    const queryShape = [...new Set(input.query.map((q) => QUERY_KEYS.has(q) ? q : "{query-key}"))].sort();
    let path = "[endpoint unavailable]";
    if (input.path !== null) {
        const raw = input.path.replace(/(\/(?:root|items\/[^/]+)):[\s\S]*?:/g, "$1/{path}").split("/").filter(Boolean);
        const parts = [];
        let expectEntity = false;
        for (let part of raw) {
            try { part = decodeURIComponent(part); } catch { part = ""; }
            const keyed = /^([A-Za-z][A-Za-z0-9]*)\((?:'[^']*'|[a-fA-F0-9-]+)\)$/.exec(part);
            const operation = functionShape(part);
            if (operation) {
                parts.push(operation);
                expectEntity = false;
            } else if (expectEntity && !part.startsWith("$")) {
                parts.push("{id}");
                expectEntity = false;
            } else if (keyed && ENTITY_COLLECTIONS.has(keyed[1])) {
                parts.push(keyed[1], "{id}");
                expectEntity = false;
            } else if (/[.(]/.test(part)) {
                parts.push("{segment}");
                expectEntity = false;
            } else if (SEGMENTS.has(part)) {
                parts.push(part);
                expectEntity = ENTITY_COLLECTIONS.has(part);
            } else {
                parts.push(part === "{path}" ? "{path}" : "{id}");
                expectEntity = false;
            }
        }
        path = isSharedDriveItemPath(input.path) ? "/shares/{id}/driveItem" : `/${parts.join("/")}`;
    }
    const label = [wireMethod, version, path].filter(Boolean).join(" ");
    return { id: key("endpoint", [wireMethod, version, path]), label, path, method: wireMethod, apiVersion: version, queryShape };
}

function specialEndpoint(name, label) {
    return { id: `operation:${name}`, label, path: null, method: null, apiVersion: null, queryShape: [] };
}

function targetsOf(tc) {
    const args = tc.requestArgs ?? {};
    if (Array.isArray(args.entityUrls) && args.entityUrls.length) return args.entityUrls;
    const requested = tc.requestedApiPath ?? args.functionUrl ?? args.actionUrl ?? args.entityUrl ?? args.parentUrl ?? args.path;
    return requested == null ? [] : [requested];
}

function toolEndpoint(tc, targets) {
    const operation = serviceCategories.operation(tc.tool);
    if (operation?.category === "Discovery" && !operation.pathLabel) return specialEndpoint(tc.tool, operation.label);
    if (operation?.category === "Discovery" && targets.length === 0) return specialEndpoint(tc.tool, `${operation.label} (schema path not recorded)`);
    if (operation?.category === "Discovery" && targets.length === 1) {
        const endpoint = normalizeEndpoint(targets[0]);
        return { ...endpoint, id: `schema:${endpoint.id}`, label: `${operation.label} - ${operation.pathLabel}: ${endpoint.label}` };
    }
    if (targets.length > 1) return specialEndpoint("multiple-targets", "Multiple targets (batched tool call)");
    if (targets.length === 1) return normalizeEndpoint(targets[0]);
    return specialEndpoint(tc.tool, `${tc.tool} (no endpoint reported)`);
}

function toolOutcome(tc) {
    if (tc.reportedOutcome === "partial") return "partial";
    if (tc.toolSucceeded === true) return "success";
    if (tc.toolSucceeded === false) return "failure";
    return tc.reportedOutcome === "succeeded" ? "success" : tc.reportedOutcome === "failed" ? "failure" : "unknown";
}

function statusOutcome(status, errorCode) {
    if (validStatus(status)) return status >= 200 && status < 300 ? "success" : status >= 400 ? "failure" : "other";
    return present(errorCode) ? "failure" : "unknown";
}

function isSynthetic(s, item) {
    return s.sample === true || s.synthetic === true || item?.synthetic === true || s.evidenceLayer === "synthetic-http-fixture" || item?.classification === "synthetic-http-fixture";
}

function hasResultMetadata(r) {
    return r && typeof r === "object" && (Number.isSafeInteger(r.index) || Object.hasOwn(r, "statusCode") || Object.hasOwn(r, "status") || Object.hasOwn(r, "errorCode"));
}

function baseRow(s, item, id, scope) {
    return {
        id, scenarioId: s.scenarioId ?? null, scenarioIds: present(s.scenarioId) ? [s.scenarioId] : [],
        sourceSessionId: s.sourceSessionId ?? item.correlation?.sessionId ?? null,
        projectId: s.projectId ?? null, scope, toolCallId: item.toolCallId ?? null,
        startedAt: time(item.startedAt ?? s.capturedAt), durationMs: duration(item.durationMs),
    };
}

function collectToolCalls(scenarios, warn, exclusions) {
    const aliases = new Map();
    const calls = [];
    // Full history wins over legacy snapshots of the same invocation.
    const ordered = scenarios.flatMap((s) => (s.toolCalls ?? []).map((tc) => ({ s, tc }))).sort((a, b) =>
        Number(a.s.isLegacy === true) - Number(b.s.isLegacy === true)
        || Number(!present(a.tc.toolCallId)) - Number(!present(b.tc.toolCallId))
        || compare(key("record", [a.s.sourceSessionId, a.tc.toolCallId, a.tc.startEventId, a.s.scenarioId]), key("record", [b.s.sourceSessionId, b.tc.toolCallId, b.tc.startEventId, b.s.scenarioId])));
    for (const { s, tc } of ordered) {
        if (isSynthetic(s, tc)) { exclusions.synthetic++; continue; }
        if (!TOOLS.has(tc.tool)) { exclusions.nonWorkIq++; continue; }
        const session = s.sourceSessionId;
        const identities = present(session) ? [
            present(tc.toolCallId) ? key("call", [session, tc.toolCallId]) : null,
            present(tc.startEventId) ? key("event", [session, tc.startEventId]) : null,
        ].filter(Boolean) : [];
        if (!identities.length) {
            exclusions.unidentifiable++;
            if (s.isLegacy) exclusions.legacyUnidentifiable++;
            continue;
        }
        const previous = identities.map((id) => aliases.get(id)).find(Boolean);
        if (previous) {
            exclusions.duplicateRecords++;
            if (present(s.scenarioId) && !previous.scenarioIds.includes(s.scenarioId)) previous.scenarioIds.push(s.scenarioId);
            for (const id of identities) {
                if (aliases.has(id) && aliases.get(id) !== previous) warn("identity-conflict", "Conflicting call/event identities found; inspect source records.", 1);
                else aliases.set(id, previous);
            }
            continue;
        }
        const targets = targetsOf(tc);
        const row = {
            ...baseRow(s, tc, identities[0], s.isLegacy || s.collectionInactive ? "legacy" : s.workloadKind === "recorded-history" ? "history" : "recorded"),
            tool: tc.tool, endpoint: toolEndpoint(tc, targets), outcome: toolOutcome(tc), status: null,
            targetCount: targets.length, targets: targets.map((target) => normalizeEndpoint(target)),
            identityBasis: present(tc.toolCallId) ? "source-session-and-tool-call" : "source-session-and-start-event",
            archiveVerified: Boolean(s.sourceEligibility) && s.sourceEligibility.archivedAt == null,
            resultMetadata: (tc.apiResults ?? []).filter(hasResultMetadata),
        };
        if (!tc.toolCallId) warn("event-identity-fallback", "Some calls use source chat + start event because a toolCallId is absent.", 1);
        for (const id of identities) aliases.set(id, row);
        calls.push(row);
    }
    if (exclusions.unidentifiable) warn("unidentifiable-tool-records", "Records without source chat + call/start-event identity are excluded, not merged by tool name; this also avoids unprovable legacy overlap.", exclusions.unidentifiable);
    if (exclusions.duplicateRecords) warn("deduplicated-records", "Overlapping call records are counted once; full history takes precedence over legacy snapshots.", exclusions.duplicateRecords);
    return calls;
}

function publicToolRow({ resultMetadata, ...row }) { return row; }

function reportedRows(calls) {
    return calls.flatMap((call) => call.resultMetadata.map((r, offset) => {
        const explicitPath = r.requestedApiPath ?? r.path;
        const discovery = serviceCategories.operation(call.tool)?.category === "Discovery";
        const endpoint = explicitPath != null ? normalizeEndpoint(explicitPath)
            : !discovery && call.targetCount === 1 ? call.endpoint
                : specialEndpoint(call.targetCount > 1 ? "unattributed-batch-result" : `${call.tool}-result`, call.targetCount > 1 ? "Unattributed reported result (multiple targets)" : `${call.tool} result (no endpoint reported)`);
        const status = validStatus(r.statusCode ?? r.status) ? (r.statusCode ?? r.status) : null;
        return {
            ...publicToolRow(call), id: key("result", [call.id, offset]), parentCallId: call.id,
            ...(discovery ? { targets: explicitPath != null ? [endpoint] : [], targetCount: explicitPath != null ? 1 : 0 } : {}),
            endpoint, outcome: statusOutcome(status, r.errorCode), status,
            // A call duration is not a per-result duration.
            durationMs: duration(r.durationMs), resultIndex: Number.isSafeInteger(r.index) ? r.index : null,
        };
    }));
}

function collectHttp(scenarios, warn, exclusions) {
    const rows = new Map();
    for (const s of scenarios) for (const r of s.httpRecords ?? []) {
        if (isSynthetic(s, r)) { exclusions.synthetic++; continue; }
        const observed = r.observedGraphHttp === true && (r.responseOrigin ?? r.origin) === GRAPH;
        const noResponse = r.status == null && r.observedGraphHttp === false;
        if (r.classification !== "direct-graph-http" || r.synthetic !== false || (!observed && !noResponse)) { exclusions.unverifiedHttp++; continue; }
        if (!present(r.recordId)) { exclusions.unidentifiable++; continue; }
        const id = key("http", [r.recordId]);
        if (rows.has(id)) {
            exclusions.duplicateRecords++;
            const previous = rows.get(id);
            if (present(s.scenarioId) && !previous.scenarioIds.includes(s.scenarioId)) previous.scenarioIds.push(s.scenarioId);
            continue;
        }
        const status = observed && validStatus(r.status) ? r.status : null;
        const endpoint = normalizeEndpoint(r.responsePath ?? r.path ?? r.requestedPath ?? r.requestShape?.path, { method: r.method, apiVersion: r.apiVersion });
        rows.set(id, {
            ...baseRow(s, r, id, "direct-http"), recordId: r.recordId, tool: "owned-graph-http",
            toolCallId: r.correlation?.toolCallId ?? null, endpoint,
            outcome: noResponse && r.transportError ? "transport" : statusOutcome(status),
            status, observedGraphHttp: observed, identityBasis: "http-record-id", archiveVerified: false,
            targetCount: 1, targets: [endpoint],
        });
    }
    if (exclusions.unverifiedHttp) warn("unverified-http-records", "Imported, unclassified or unverified HTTP claims are excluded from the owned direct-HTTP layer.", exclusions.unverifiedHttp);
    if (exclusions.unidentifiable) warn("unidentifiable-http-records", "HTTP records lacking recordId are excluded from unique-record counts.", exclusions.unidentifiable);
    if (exclusions.duplicateRecords) warn("deduplicated-records", "Repeated HTTP recordIds are counted once.", exclusions.duplicateRecords);
    return [...rows.values()];
}

function summarize(rows) {
    const result = { count: rows.length, total: rows.length, ...Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) };
    for (const row of rows) result[row.outcome]++;
    const samples = rows.map((r) => r.durationMs).filter((d) => d !== null).sort((a, b) => a - b);
    const percentile = (p) => samples.length ? samples[Math.max(0, Math.ceil(p * samples.length) - 1)] : null;
    return {
        ...result,
        successRate: { numerator: result.success, denominator: rows.length, percent: rows.length ? result.success * 100 / rows.length : null },
        duration: { sampleCount: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), method: "nearest-rank; available samples only" },
        statusBreakdown: [...new Set(rows.map((r) => r.status).filter((v) => v !== null))].sort((a, b) => a - b).map((status) => ({ status, count: rows.filter((r) => r.status === status).length })),
    };
}

function setSize(rows, getter) { return new Set(rows.map(getter).filter(present)).size; }

function coverage(rows) {
    const dates = rows.map((r) => r.startedAt).filter(Boolean).sort();
    return {
        sessionCount: setSize(rows, (r) => r.sourceSessionId),
        projectCount: setSize(rows, (r) => r.projectId),
        unscopedSessionCount: setSize(rows.filter((r) => !r.projectId), (r) => r.sourceSessionId),
        scenarioCount: setSize(rows, (r) => r.scenarioId),
        archiveVerifiedSessionCount: setSize(rows.filter((r) => r.archiveVerified), (r) => r.sourceSessionId),
        unknownSessionRows: rows.filter((r) => !present(r.sourceSessionId)).length,
        datedRows: dates.length, undatedRows: rows.length - dates.length,
        firstAt: dates[0] ?? null, lastAt: dates.at(-1) ?? null,
    };
}

function validateOptions(options) {
    const layer = options.layer ?? "tool";
    const groupBy = options.groupBy ?? "endpoint";
    if (!["tool", "reported-api", "http"].includes(layer)) throw new TypeError("Unknown evidence layer.");
    if (!["tool", "endpoint"].includes(groupBy)) throw new TypeError("groupBy must be endpoint or tool.");
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new TypeError("limit must be a positive integer.");
    const filters = { scope: "history", ...options.filters };
    if (filters.scope !== undefined && !["all", "history", "legacy", "recorded", "direct-http"].includes(filters.scope)) throw new TypeError("Unknown source scope.");
    for (const name of ["sourceSessionIds", "projectIds", "tools", "endpoints", "outcomes"]) if (filters[name] !== undefined && !Array.isArray(filters[name])) throw new TypeError(`${name} must be an array.`);
    if (filters.outcomes?.some((v) => !OUTCOMES.includes(v))) throw new TypeError("Unknown outcome filter.");
    try {
        const timeContext = civilTime.normalize(options.timeContext);
        return { layer, groupBy, limit: options.limit ?? 10, filters: { ...filters, ...civilTime.range(filters, timeContext.timeZone) } };
    } catch (error) { throw new TypeError(error.message, { cause: error }); }
}

function matches(row, filters, includeOutcome = true) {
    const includes = (name, value) => !filters[name]?.length || filters[name].includes(value);
    if (!includes("sourceSessionIds", row.sourceSessionId) || !includes("projectIds", row.projectId) || !includes("tools", row.tool)) return false;
    if (includeOutcome && !includes("outcomes", row.outcome)) return false;
    if (filters.scope === "history" && row.scope === "legacy") return false;
    if (filters.scope && !["all", "history"].includes(filters.scope) && row.scope !== filters.scope) return false;
    if (filters.endpoints?.length && !filters.endpoints.includes(row.endpoint.id) && !filters.endpoints.includes(row.endpoint.label)
        && !(row.endpoint.id.startsWith("schema:") && filters.endpoints.includes(row.endpoint.id.slice(7)))) return false;
    if ((filters.from || filters.to) && !row.startedAt) return false;
    if (filters.from && Date.parse(row.startedAt) < Date.parse(filters.from)) return false;
    if (filters.to && (filters.toExclusive ? Date.parse(row.startedAt) >= Date.parse(filters.to) : Date.parse(row.startedAt) > Date.parse(filters.to))) return false;
    return true;
}

function filterOptions(rows) {
    const sorted = (values) => [...new Set(values)].sort((a, b) => compare(String(a), String(b)));
    return {
        tools: sorted(rows.map((r) => r.tool)),
        sourceSessionIds: sorted(rows.map((r) => r.sourceSessionId).filter(present)),
        projectIds: sorted(rows.map((r) => r.projectId)),
        endpoints: [...new Map(rows.map((r) => [r.endpoint.id, { id: r.endpoint.id, label: r.endpoint.label }])).values()].sort((a, b) => compare(a.label, b.label)),
        outcomes: [...OUTCOMES], scopes: ["history", "all", "legacy"],
    };
}

function collectAnalysisRows(scenarios, options = {}) {
    if (!Array.isArray(scenarios)) throw new TypeError("scenarios must be an array.");
    const { layer, groupBy, limit, filters } = validateOptions(options);
    const warnings = new Map();
    const warn = (code, message, count = 0) => {
        const previous = warnings.get(code);
        warnings.set(code, { code, message, count: (previous?.count ?? 0) + count });
    };
    const exclusions = { synthetic: 0, unidentifiable: 0, legacyUnidentifiable: 0, duplicateRecords: 0, nonWorkIq: 0, unverifiedHttp: 0, filteredOut: 0, missingFilterDate: 0, legacyScenarios: 0 };
    const scopedScenarios = scenarios.filter((s) => filters.scope === "legacy" ? s.isLegacy === true || s.collectionInactive === true : filters.scope === "history" ? s.isLegacy !== true && s.collectionInactive !== true : true);
    if (filters.scope === "history") exclusions.legacyScenarios = scenarios.filter((s) => s.isLegacy === true).length;
    const calls = layer === "http" ? [] : collectToolCalls(scopedScenarios, warn, exclusions);
    const allRows = layer === "http" ? collectHttp(scopedScenarios, warn, exclusions) : layer === "tool" ? calls.map(publicToolRow) : reportedRows(calls);
    const rows = allRows.filter((row) => matches(row, filters)).sort((a, b) => compare(a.id, b.id));
    exclusions.filteredOut = allRows.length - rows.length;
    if (filters.from || filters.to) {
        exclusions.missingFilterDate = allRows.filter((row) => !row.startedAt).length;
        if (exclusions.missingFilterDate) warn("dates-unavailable", "Undated rows cannot satisfy date filters. Current sanitized exports omit timestamps; do not infer their dates.", exclusions.missingFilterDate);
    }
    if (exclusions.synthetic) warn("synthetic-excluded", "Synthetic/sample records are excluded from real evidence totals.", exclusions.synthetic);
    if (exclusions.legacyScenarios) warn("legacy-excluded", "The current collection excludes all legacy scenario cards. Select all or legacy scope to inspect them separately.", exclusions.legacyScenarios);
    return { layer, groupBy, limit, filters, warnings, warn, exclusions, calls, allRows, rows };
}

export function buildAnalyticsRows(scenarios, options = {}) {
    return collectAnalysisRows(scenarios, options).rows;
}

/** Inputs must share one identifier namespace: canonical OR one sanitized bundle. */
export function buildAnalytics(scenarios, options = {}) {
    const { layer, groupBy, limit, filters, warnings, warn, exclusions, calls, allRows, rows } = collectAnalysisRows(scenarios, options);
    const totals = summarize(rows);
    const groupMap = new Map();
    for (const row of rows) {
        const id = groupBy === "tool" ? key("tool", [row.tool]) : row.endpoint.id;
        if (!groupMap.has(id)) groupMap.set(id, { id, label: groupBy === "tool" ? row.tool : row.endpoint.label, rows: [] });
        groupMap.get(id).rows.push(row);
    }
    const groups = [...groupMap.values()].map((g) => ({
        id: g.id, key: g.id, label: g.label, ...summarize(g.rows),
        sessionCount: setSize(g.rows, (r) => r.sourceSessionId),
        sharePercent: totals.count ? g.rows.length * 100 / totals.count : 0,
        drilldownIds: g.rows.map((r) => r.id),
        queryShapes: [...new Set(g.rows.map((r) => r.endpoint.queryShape.join(", ")))].filter(Boolean).sort(),
    })).sort((a, b) => b.total - a.total || compare(a.label, b.label) || compare(a.id, b.id));
    const visibleGroups = groups.slice(0, limit);
    const omitted = groups.slice(limit);
    const omittedIds = new Set(omitted.flatMap((g) => g.drilldownIds));
    const omittedRows = rows.filter((r) => omittedIds.has(r.id));
    const otherGroup = omitted.length ? {
        id: "group:other", key: "group:other", label: `Other (${omitted.length} groups)`,
        ...summarize(omittedRows), groupCount: omitted.length,
        sessionCount: setSize(omittedRows, (r) => r.sourceSessionId),
        sharePercent: totals.count ? omittedRows.length * 100 / totals.count : 0,
        drilldownIds: omittedRows.map((r) => r.id), queryShapes: [],
    } : null;
    let apiCoverage = null;
    if (layer === "reported-api") {
        // Call coverage is pre-result-outcome; a result failure filter is not a tool-failure filter.
        const scopedCalls = calls.filter((c) => matches(c, { ...filters, endpoints: undefined }, false));
        const withResults = scopedCalls.filter((c) => c.resultMetadata.length);
        const withStatus = scopedCalls.filter((c) => c.resultMetadata.some((r) => validStatus(r.statusCode ?? r.status)));
        apiCoverage = {
            scope: "source/project/tool/date filters; before result outcome and endpoint filters",
            eligibleToolCalls: scopedCalls.length, callsWithReportedResults: withResults.length,
            callsWithoutReportedResults: scopedCalls.length - withResults.length,
            callsWithNumericStatus: withStatus.length, callsWithoutNumericStatus: scopedCalls.length - withStatus.length,
            returnedResultUnits: scopedCalls.reduce((n, c) => n + c.resultMetadata.length, 0),
            selectedResultUnits: rows.length, selectedResultUnitsWithNumericStatus: rows.filter((r) => r.status !== null).length,
        };
        warn("reported-results-only", "Reported API results are intermediary metadata, not HTTP observations. Missing result/status metadata is not success; percentages describe returned units only.", apiCoverage.callsWithoutNumericStatus);
    }
    if (layer === "tool") warn("tool-not-http", "Tool success is a runtime outcome, not Graph HTTP or task correctness. Review state and relevance assessments do not change it.");
    if (layer === "http") warn("http-not-business-completion", "HTTP 2xx (including 202) is response success, not verified business completion. Transport failures have no fabricated status.");
    const unit = layer === "tool" ? "Work IQ tool calls" : layer === "reported-api" ? "reported API result units" : "direct HTTP records";
    return {
        schemaVersion: 1, layer, unit, groupBy, totals, coverage: coverage(rows), apiCoverage,
        httpCoverage: layer === "http" ? { observedResponseCount: rows.filter((r) => r.observedGraphHttp).length, noResponseRecordCount: rows.filter((r) => !r.observedGraphHttp).length } : null,
        groups, visibleGroups, otherGroup, rows, calls: rows,
        filterOptions: filterOptions(allRows), warnings: [...warnings.values()], exclusions,
        denominatorNote: layer === "reported-api" ? "Returned metadata units only; not all requested paths or tool executions." : layer === "http" ? "Unique owned recorder records, including explicitly separate no-response attempts." : "Unique source chat + toolCallId (or start-event fallback); owned HTTP is separate.",
    };
}

export function getDrilldown(analytics, groupId) {
    const group = groupId === "group:other" ? analytics.otherGroup : analytics.groups.find((g) => g.id === groupId);
    if (!group) throw new RangeError("Unknown analytics group.");
    const ids = new Set(group.drilldownIds);
    return analytics.rows.filter((row) => ids.has(row.id));
}
