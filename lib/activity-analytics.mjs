import { buildAnalytics as buildCoreAnalytics, OUTCOMES } from "./analytics.mjs";
import { classifyWorkload, OFFICE_WORKLOADS, validateGraphActivity, normalizeGraphEndpoint } from "./graph-history.mjs";
import { time } from "./time.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { serviceCategories } from "./service-categories.mjs";

const EXTRA_LAYERS = ["direct-request", "recorded-http", "code-reference"];
const LABELS = {
    tool: "Work IQ activity", "reported-api": "Results reported by Work IQ", http: "Live captured Graph responses",
    "direct-request": "Recorded direct Graph requests", "recorded-http": "Graph status visible in recorded output", "code-reference": "Graph code references (not executions)",
};
const validStatus = (v) => Number.isInteger(v) && v >= 100 && v <= 599;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const identity = (kind, values) => `${kind}:${JSON.stringify(values)}`;
const dateValue = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const outcome = (s) => !validStatus(s) ? "unknown" : s >= 200 && s < 300 ? "success" : s >= 400 ? "failure" : "other";
const unique = (items) => [...new Set(items)];

export function summarizeActivityRows(rows) {
    const t = { count: rows.length, total: rows.length, ...Object.fromEntries(OUTCOMES.map((o) => [o, 0])) };
    for (const row of rows) {
        if (!OUTCOMES.includes(row.outcome)) throw new TypeError("Unknown activity outcome.");
        t[row.outcome]++;
    }
    const durations = rows.map((r) => r.durationMs).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    const quantile = (p) => durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)] : null;
    return {
        ...t, successRate: { numerator: t.success, denominator: t.count, percent: t.count ? t.success * 100 / t.count : null },
        duration: { sampleCount: durations.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95), method: "nearest-rank; available samples only" },
        statusBreakdown: unique(rows.map((r) => r.status).filter(validStatus)).sort((a, b) => a - b).map((s) => ({ status: s, count: rows.filter((r) => r.status === s).length })),
    };
}

function coverage(rows) {
    const dates = rows.map((r) => r.startedAt).filter(Boolean).sort();
    const size = (key) => unique(rows.map((r) => r[key]).filter(Boolean)).length;
    return {
        sessionCount: size("sourceSessionId"), projectCount: size("projectId"), scenarioCount: size("scenarioId"),
        unscopedSessionCount: unique(rows.filter((r) => !r.projectId).map((r) => r.sourceSessionId).filter(Boolean)).length,
        archiveVerifiedSessionCount: unique(rows.filter((r) => r.archiveVerified).map((r) => r.sourceSessionId).filter(Boolean)).length,
        unknownSessionRows: rows.filter((r) => !r.sourceSessionId).length,
        datedRows: dates.length, undatedRows: rows.length - dates.length, firstAt: dates[0] ?? null, lastAt: dates.at(-1) ?? null,
    };
}

function groupRows(rows, by) {
    const groups = new Map();
    for (const r of rows) {
        const label = ["service", "workload"].includes(by) ? r.workload : by === "tool" ? r.tool : r.endpoint.label;
        const id = by === "endpoint" ? r.endpoint.id : identity(by === "service" ? "workload" : by, [label]);
        if (!groups.has(id)) groups.set(id, { id, label, rows: [] });
        groups.get(id).rows.push(r);
    }
    return [...groups.values()].map((g) => ({
        id: g.id, key: g.id, label: g.label, ...summarizeActivityRows(g.rows),
        sessionCount: unique(g.rows.map((r) => r.sourceSessionId).filter(Boolean)).length,
        sharePercent: rows.length ? g.rows.length * 100 / rows.length : 0,
        drilldownIds: g.rows.map((r) => r.id),
        queryShapes: unique(g.rows.map((r) => r.endpoint.queryShape.join(", "))).filter(Boolean).sort(),
    })).sort((a, b) => b.total - a.total || compare(a.label, b.label));
}

function graphRows(scenarios, layer, exclusions) {
    const found = new Map();
    for (const s of scenarios) for (const a of s.graphActivities ?? []) {
        if (s.sample || s.synthetic || a.synthetic) { exclusions.synthetic++; continue; }
        validateGraphActivity(a);
        if (!a.activityId || !s.sourceSessionId) { exclusions.unidentifiable++; continue; }
        const code = a.evidenceLevel === "code-reference";
        if (layer === "code-reference" ? !code : code) continue;
        if (layer === "recorded-http" && (a.evidenceLevel !== "output-visible-http" || !validStatus(a.httpStatus))) continue;
        const id = identity("graph-activity", [s.sourceSessionId, a.activityId]);
        if (found.has(id)) { exclusions.duplicateRecords++; continue; }
        const endpoint = normalizeGraphEndpoint(a);
        const status = a.evidenceLevel === "output-visible-http" && validStatus(a.httpStatus) ? a.httpStatus : null;
        found.set(id, {
            id, activityId: a.activityId, scenarioId: s.scenarioId, scenarioIds: [s.scenarioId],
            sourceSessionId: s.sourceSessionId, projectId: s.projectId ?? null, toolCallId: a.toolCallId ?? null,
            startedAt: dateValue(a.startedAt), durationMs: null, tool: ["shell", "graph-mcp", "script-reference"].includes(a.tool) ? a.tool : "script-reference",
            endpoint, outcome: outcome(status), status, workload: classifyWorkload(endpoint),
            scope: s.isLegacy || s.collectionInactive ? "legacy" : "history", archiveVerified: Boolean(s.sourceEligibility) && !s.collectionInactive,
            identityBasis: "source-session-and-graph-activity", activityType: code ? "code-reference" : status !== null ? "recorded-http" : "direct-request",
            evidenceLevel: a.evidenceLevel, requestCount: null, countUnit: "recorded-request-site",
            confidence: a.confidence, fallback: a.fallback ?? { association: "none", precedingWorkIqCallIds: [], causeProven: false },
            evidenceRefs: a.evidenceRefs ?? [], targetCount: 1, targets: [endpoint],
        });
    }
    return [...found.values()];
}

function selected(row, filters) {
    const includes = (key, v) => !filters[key]?.length || filters[key].includes(v);
    if (!includes("sourceSessionIds", row.sourceSessionId) || !includes("projectIds", row.projectId) || !includes("tools", row.tool) || !includes("outcomes", row.outcome)) return false;
    if (!includes("promptAuthors", row.promptAuthor)) return false;
    if (!includes("workloads", row.workload) || !includes("services", row.workload) || !includes("activityTypes", row.activityType)) return false;
    if (filters.includeMetadata !== true && row.workload === "Platform metadata") return false;
    const scope = filters.scope ?? "history";
    if (scope === "history" && row.scope === "legacy" || scope === "legacy" && row.scope !== "legacy") return false;
    if (filters.endpoints?.length && !filters.endpoints.includes(row.endpoint.id) && !filters.endpoints.includes(row.endpoint.label)
        && !(row.endpoint.id.startsWith("schema:") && filters.endpoints.includes(row.endpoint.id.slice(7)))) return false;
    if ((filters.from || filters.to) && !row.startedAt) return false;
    if (filters.from && Date.parse(row.startedAt) < Date.parse(filters.from)) return false;
    if (filters.to && (filters.toExclusive ? Date.parse(row.startedAt) >= Date.parse(filters.to) : Date.parse(row.startedAt) > Date.parse(filters.to))) return false;
    return true;
}

function timeline(rows, bucket, context, filters, bounds) {
    const map = new Map();
    for (const row of rows) if (row.startedAt) {
        const key = time.bucketDate(row.startedAt, bucket, context.timeZone);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    const keys = [...map.keys()].sort();
    const points = [];
    if (keys.length) {
        let key = keys[0];
        while (key <= keys.at(-1)) {
            if (points.length >= 400) throw new RangeError("Timeline exceeds 400 buckets; narrow dates or choose a coarser bucket.");
            const events = map.get(key) ?? [];
            const next = time.nextBucket(key, bucket), endDate = time.addDays(next, -1);
            const start = time.midnight(key, context.timeZone), end = time.midnight(next, context.timeZone);
            // Keep a partial bucket inside the current slice, including legacy instant routes.
            const from = bounds.from && Date.parse(bounds.from) > Date.parse(start) ? filters.from : key;
            const to = bounds.to && (Date.parse(bounds.to) < Date.parse(end) || bounds.toExclusive && Date.parse(bounds.to) === Date.parse(end)) ? filters.to : endDate;
            points.push({ date: key, endDate, from, to, ...summarizeActivityRows(events), drilldownIds: events.map((r) => r.id) });
            key = next;
        }
    }
    return { bucket, timezone: context.timeZone, points, undatedCount: rows.filter((r) => !r.startedAt).length, gapMeaning: "Zero means no qualifying records in the supplied slice, not proof no activity occurred." };
}

function journeys(rows, scenarios) {
    const grouped = new Map();
    for (const row of rows) {
        if (!row.scenarioId) continue;
        if (!grouped.has(row.scenarioId)) grouped.set(row.scenarioId, []);
        grouped.get(row.scenarioId).push(row);
    }
    const byId = new Map(scenarios.map((s) => [s.scenarioId, s]));
    return [...grouped].map(([scenarioId, selectedRows]) => {
        const s = byId.get(scenarioId);
        const graph = selectedRows.filter((r) => r.activityId);
        const graphData = s?.graphActivities?.filter((a) => !a.synthetic && a.evidenceLevel !== "code-reference") ?? [];
        const strongest = [...graphData].sort((a, b) => (a.fallback?.association === "explicit-transition" ? 0 : a.fallback?.association === "same-prompt-after-failure" ? 1 : 2) - (b.fallback?.association === "explicit-transition" ? 0 : b.fallback?.association === "same-prompt-after-failure" ? 1 : 2))[0];
        const association = strongest?.fallback?.association ?? "none";
        return {
            id: identity("journey", [selectedRows[0].sourceSessionId, scenarioId]),
            scenarioId, sourceSessionId: selectedRows[0].sourceSessionId,
            workIqCallIds: unique(selectedRows.filter((r) => r.activityType === "workiq").map((r) => r.toolCallId).filter(Boolean)),
            graphActivityIds: graph.map((r) => r.activityId),
            relatedGraphActivityIds: graphData.map((a) => a.activityId),
            precedingWorkIqCallIds: unique(graphData.flatMap((a) => a.fallback?.precedingWorkIqCallIds ?? [])),
            association, confidence: association === "explicit-transition" ? "medium" : "low",
            causeProven: false, selectedCount: selectedRows.length, drilldownIds: selectedRows.map((r) => r.id),
            explanation: association === "same-prompt-after-failure" ? "A recorded Graph request followed a Work IQ failure in this prompt group; the cause is not proven."
                : association === "explicit-transition" ? "Recorded text explicitly describes switching from Work IQ to Graph; this is not independent proof of cause."
                    : association === "same-prompt-sequence" ? "Work IQ and a Graph request occur in the same prompt group; fallback intent is unverified."
                        : "No evidence-grounded Work IQ-to-Graph transition was identified.",
        };
    });
}

export function buildActivityAnalytics(scenarios, options = {}) {
    if (!Array.isArray(scenarios)) throw new TypeError("scenarios must be an array.");
    const layer = options.layer ?? "tool";
    const by = options.groupBy ?? "workload";
    const bucket = options.bucket ?? "day";
    const filters = options.filters ?? {};
    let timeContext, dateRange;
    try {
        timeContext = time.normalize(options.timeContext);
        dateRange = time.range(filters, timeContext.timeZone);
    } catch (error) { throw new TypeError(error.message, { cause: error }); }
    const limit = options.limit ?? 10;
    if (!["tool", "reported-api", "http", ...EXTRA_LAYERS].includes(layer)) throw new TypeError("Unsupported activity layer.");
    if (!["endpoint", "tool", "service", "workload"].includes(by)) throw new TypeError("Unsupported activity grouping.");
    if (!["day", "week", "month"].includes(bucket)) throw new TypeError("Unsupported time bucket.");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be positive.");
    if (filters.scope !== undefined && !["history", "all", "legacy", "recorded", "direct-http"].includes(filters.scope)) throw new TypeError("Unknown source scope.");
    if (filters.includeMetadata !== undefined && typeof filters.includeMetadata !== "boolean") throw new TypeError("includeMetadata must be boolean.");
    for (const k of ["workloads", "services", "activityTypes", "sourceSessionIds", "projectIds", "tools", "outcomes", "endpoints"]) if (filters[k] !== undefined && !Array.isArray(filters[k])) throw new TypeError(`${k} must be an array.`);
    if (filters.workloads?.some((w) => !OFFICE_WORKLOADS.includes(w)) || filters.services?.some((w) => !OFFICE_WORKLOADS.includes(w))) throw new TypeError("Unknown workload filter.");
    if (layer !== "tool" && (filters.workloads?.includes("Discovery") || filters.services?.includes("Discovery"))) throw new TypeError("Discovery applies only to Work IQ tool calls, not API-service evidence.");
    if (filters.outcomes?.some((v) => !OUTCOMES.includes(v)) || filters.activityTypes?.some((v) => !["workiq", "direct-request", "recorded-http", "captured-http", "code-reference"].includes(v))) throw new TypeError("Unknown activity/result filter.");
    if (!promptAuthorship.validSelection(filters.promptAuthors)) throw new TypeError("Choose at least one supported prompt author.");
    const exclusions = { synthetic: 0, unidentifiable: 0, duplicateRecords: 0, filteredOut: 0, metadataExcluded: 0 };
    const core = EXTRA_LAYERS.includes(layer) ? null : buildCoreAnalytics(scenarios, { layer, groupBy: "endpoint", filters: { scope: filters.scope ?? "history" }, limit });
    const canonicalRows = core ? core.rows.map((r) => ({
        ...r, workload: (layer === "tool" ? serviceCategories.operation(r.tool)?.category : null) ?? classifyWorkload(r.endpoint, r.tool, r.targets ?? []),
        activityType: layer === "http" ? "captured-http" : "workiq",
        evidenceLevel: layer === "http" ? "captured-live-http" : "workiq-intermediary",
    })) : graphRows(scenarios, layer, exclusions);
    const owners = new Map(scenarios.map(record => [record.scenarioId, record.userPrompt]));
    const allRows = canonicalRows.map(row => ({ ...row, promptAuthor: promptAuthorship.read(owners.get(row.scenarioId)).actor }));
    const rows = allRows.filter((r) => selected(r, { ...filters, ...dateRange })).sort((a, b) => compare(a.id, b.id));
    const resultFacet = {
        scope: "before-outcome",
        totals: summarizeActivityRows(allRows.filter((r) => selected(r, { ...filters, ...dateRange, outcomes: undefined }))),
    };
    const groups = groupRows(rows, by);
    const omitted = groups.slice(limit);
    const omittedIds = new Set(omitted.flatMap((g) => g.drilldownIds));
    const otherRows = rows.filter((r) => omittedIds.has(r.id));
    const otherGroup = omitted.length ? {
        id: "group:other", key: "group:other", label: `Other (${omitted.length} groups)`,
        ...summarizeActivityRows(otherRows), groupCount: omitted.length,
        sharePercent: rows.length ? otherRows.length * 100 / rows.length : 0,
        drilldownIds: otherRows.map((r) => r.id), queryShapes: [],
        sessionCount: unique(otherRows.map((r) => r.sourceSessionId)).length,
    } : null;
    const warnings = [...(core?.warnings ?? [])];
    if (EXTRA_LAYERS.includes(layer)) warnings.push({ code: "recorded-sites-not-wire-counts", count: rows.length, message: "Counts are distinct recorded request sites, not measured HTTP executions. Loops, retries, dynamic targets and unlogged scripts are not reconstructed. Recorded-status is a subset of direct-request; never add the layers." });
    if (rows.some((r) => !r.startedAt)) warnings.push({ code: "undated-activity", count: rows.filter((r) => !r.startedAt).length, message: "Undated records are omitted from the time chart; no timestamp is invented." });
    exclusions.filteredOut = allRows.length - rows.length;
    exclusions.metadataExcluded = filters.includeMetadata === true ? 0 : allRows.filter((r) => r.workload === "Platform metadata").length;
    if (exclusions.metadataExcluded) warnings.push({ code: "metadata-excluded", count: exclusions.metadataExcluded, message: "Platform metadata demonstrations are hidden from the personal Office view. Enable metadata to inspect them." });
    const unit = core?.unit ?? (layer === "code-reference" ? "Graph code references" : "recorded Graph request sites");
    // Recompute API coverage with the same selected source/tool/date filters, not result outcome.
    let apiCoverage = core?.apiCoverage ?? null;
    if (layer === "reported-api") {
        const toolSlice = buildActivityAnalytics(scenarios, { ...options, layer: "tool", groupBy: "workload",
            filters: { ...filters, workloads: undefined, services: undefined, outcomes: undefined, endpoints: undefined, activityTypes: undefined } });
        const resultServices = new Map();
        for (const row of allRows) {
            if (!resultServices.has(row.parentCallId)) resultServices.set(row.parentCallId, new Set());
            resultServices.get(row.parentCallId).add(row.workload);
        }
        const eligibleIds = new Set(toolSlice.rows.filter(row => {
            const services = row.workload === "Discovery" ? resultServices.get(row.id) ?? new Set(["Unknown"]) : new Set([row.workload]);
            return [...services].some(service => (!filters.workloads?.length || filters.workloads.includes(service))
                && (!filters.services?.length || filters.services.includes(service)));
        }).map(row => row.id));
        const relatedResults = allRows.filter((r) => eligibleIds.has(r.parentCallId));
        const withResults = new Set(relatedResults.map((r) => r.parentCallId));
        const withStatus = new Set(relatedResults.filter((r) => validStatus(r.status)).map((r) => r.parentCallId));
        apiCoverage = {
            scope: "source/project/tool/date/service scope before API-result endpoint/outcome filters; discovery uses only returned service evidence, never schema arguments",
            eligibleToolCalls: eligibleIds.size, callsWithReportedResults: withResults.size, callsWithoutReportedResults: eligibleIds.size - withResults.size,
            callsWithNumericStatus: withStatus.size, callsWithoutNumericStatus: eligibleIds.size - withStatus.size,
            returnedResultUnits: relatedResults.length, selectedResultUnits: rows.length,
            selectedResultUnitsWithNumericStatus: rows.filter((r) => validStatus(r.status)).length,
        };
    }
    return {
        ...core, schemaVersion: 2, layer, label: LABELS[layer], unit, groupBy: by,
        totals: summarizeActivityRows(rows), resultFacet, coverage: coverage(rows), apiCoverage,
        httpCoverage: layer === "http" ? { observedResponseCount: rows.filter((r) => r.observedGraphHttp).length, noResponseRecordCount: rows.filter((r) => !r.observedGraphHttp).length } : null,
        groups, visibleGroups: groups.slice(0, limit), otherGroup, rows, calls: rows,
        timeContext, dateRange,
        workloadGroups: groupRows(rows, "workload"), timeSeries: timeline(rows, bucket, timeContext, filters, dateRange), journeys: journeys(rows, scenarios),
        filterOptions: {
            tools: unique(allRows.map((r) => r.tool)).sort(), sourceSessionIds: unique(allRows.map((r) => r.sourceSessionId).filter(Boolean)).sort(),
            projectIds: unique(allRows.map((r) => r.projectId)),
            workloads: OFFICE_WORKLOADS.filter(value => layer === "tool" || value !== "Discovery"),
            services: OFFICE_WORKLOADS.filter(value => layer === "tool" || value !== "Discovery"),
            activityTypes: ["workiq", "direct-request", "recorded-http", "captured-http", "code-reference"],
            endpoints: unique(allRows.map((r) => r.endpoint.id)).map((id) => { const e = allRows.find((r) => r.endpoint.id === id).endpoint; return { id, label: e.label }; }),
            outcomes: [...OUTCOMES], scopes: ["history", "all", "legacy"],
            promptAuthors: [...promptAuthorship.actors],
        },
        warnings, exclusions: core ? { ...core.exclusions, filteredOut: exclusions.filteredOut, metadataExcluded: exclusions.metadataExcluded } : exclusions,
        denominatorNote: core?.denominatorNote ?? "Unique source chat + recorded request site. Code references and unknown wire executions are separate; no cross-layer sum.",
    };
}

export const buildAnalytics = buildActivityAnalytics;

// One unfiltered canonical context per snapshot, never one fetch per request.
// Retain only the attribution fields needed to connect the full journey to a slice.
export function buildRequestActivity(scenarios) {
    return Object.fromEntries(["tool", "reported-api", "direct-request", "recorded-http", "http", "code-reference"].map(layer => {
        const { rows } = buildActivityAnalytics(scenarios, { layer, bucket: "month", filters: { scope: "all", includeMetadata: true } });
        return [layer, rows.map(({ id, scenarioId, scenarioIds, sourceSessionId, toolCallId, activityId, recordId, parentCallId, outcome, status, workload, endpoint }) =>
            ({ id, scenarioId, scenarioIds, sourceSessionId, toolCallId, activityId, recordId, parentCallId, outcome, status, workload, endpoint }))];
    }));
}

export function getActivityDrilldown(analytics, id) {
    const group = id === "group:other" ? analytics.otherGroup : [...analytics.groups, ...analytics.workloadGroups].find((g) => g.id === id);
    const point = analytics.timeSeries.points.find((p) => p.date === id);
    const journey = analytics.journeys.find((j) => j.id === id);
    const slice = group ?? point ?? journey;
    if (!slice) throw new RangeError("Unknown activity slice.");
    const ids = new Set(slice.drilldownIds);
    return analytics.rows.filter((r) => ids.has(r.id));
}
