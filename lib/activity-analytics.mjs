import { buildAnalytics as buildCoreAnalytics, buildAnalyticsRows, OUTCOMES } from "./analytics.mjs";
import { classifyWorkload, OFFICE_WORKLOADS, validateGraphActivity, normalizeGraphEndpoint } from "./graph-history.mjs";
import { time } from "./time.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { retainedSourceIds, isNativeConsumerRecord, retainedSourceId, nativeActivityRows, retainedSelection } from "./retained-population.mjs";

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

const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
export const summarizeActivityRows = projection.summarize;

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

function activityRows(scenarios, layer, coreRows, exclusions) {
    const canonicalRows = coreRows ? coreRows.map(r => ({
        ...r, workload: (layer === "tool" ? serviceCategories.operation(r.tool)?.category : null) ?? classifyWorkload(r.endpoint, r.tool, r.targets ?? []),
        activityType: layer === "http" ? "captured-http" : "workiq",
        evidenceLevel: layer === "http" ? "captured-live-http" : "workiq-intermediary",
    })) : graphRows(scenarios.filter(record => !isNativeConsumerRecord(record)), layer, exclusions);
    const owners = new Map(scenarios.map(record => [record.scenarioId, record.userPrompt]));
    const sources = new Map(scenarios.map(record => [record.scenarioId, retainedSourceId(record)]));
    return [...canonicalRows.map(row => ({
        ...row, sourceId: sources.get(row.scenarioId) ?? null, promptAuthor: promptAuthorship.read(owners.get(row.scenarioId)).actor,
        countUnit: row.countUnit ?? (layer === "tool" ? "workiq-tool-call" : layer === "reported-api" ? "workiq-returned-result-entry" : layer),
        serviceAssociation: serviceCategories.associate(row, layer, classifyWorkload),
    })), ...nativeActivityRows(scenarios, layer)];
}

export function buildActivityAnalytics(scenarios, options = {}) {
    if (!Array.isArray(scenarios)) throw new TypeError("scenarios must be an array.");
    const layer = options.layer ?? "tool";
    const by = options.groupBy ?? "workload";
    const bucket = options.bucket ?? "day";
    const filters = options.filters ?? {};
    if (filters.sources !== undefined && (!Array.isArray(filters.sources) || filters.sources.length > 3
        || new Set(filters.sources).size !== filters.sources.length || filters.sources.some(value => !retainedSourceIds().includes(value)))) throw new TypeError("Unknown source selection.");
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
    if (filters.includeMissingService !== undefined && typeof filters.includeMissingService !== "boolean") throw new TypeError("includeMissingService must be boolean.");
    for (const k of ["workloads", "services", "activityTypes", "sourceSessionIds", "projectIds", "tools", "outcomes", "endpoints"]) if (filters[k] !== undefined && !Array.isArray(filters[k])) throw new TypeError(`${k} must be an array.`);
    if (filters.workloads?.some((w) => !OFFICE_WORKLOADS.includes(w)) || filters.services?.some((w) => !OFFICE_WORKLOADS.includes(w))) throw new TypeError("Unknown workload filter.");
    if (layer !== "tool" && (filters.workloads?.includes("Discovery") || filters.services?.includes("Discovery"))) throw new TypeError("Discovery applies only to Work IQ tool calls, not API-service evidence.");
    if (filters.outcomes?.some((v) => !OUTCOMES.includes(v)) || filters.activityTypes?.some((v) => !["workiq", "direct-request", "recorded-http", "captured-http", "code-reference"].includes(v))) throw new TypeError("Unknown activity/result filter.");
    if (!promptAuthorship.validSelection(filters.promptAuthors)) throw new TypeError("Choose at least one supported prompt author.");
    const exclusions = { synthetic: 0, unidentifiable: 0, duplicateRecords: 0, filteredOut: 0, metadataExcluded: 0 };
    const legacy = scenarios.filter(record => !isNativeConsumerRecord(record));
    const core = EXTRA_LAYERS.includes(layer) ? null : buildCoreAnalytics(legacy, { layer, groupBy: "endpoint", filters: { scope: filters.scope ?? "history" }, limit });
    const allRows = activityRows(scenarios, layer, core?.rows, exclusions);
    const rows = allRows.filter((r) => projection.selected(r, { ...filters, ...dateRange })).sort((a, b) => compare(a.id, b.id));
    const facetRows = allRows.filter((r) => projection.selected(r, { ...filters, ...dateRange, outcomes: undefined }));
    const resultFacet = {
        scope: "before-outcome",
        totals: summarizeActivityRows(facetRows), rows: facetRows,
    };
    const warnings = [...(core?.warnings ?? [])];
    if (scenarios.some(isNativeConsumerRecord)) warnings.push({
        code: "native-consumer-coverage", count: scenarios.filter(isNativeConsumerRecord).length,
        message: "Native call dates and service targets are unqualified. Recorded message creation dates can place conversation context, not calls. Capture time is not activity time; task states, message representations and result references are not tool calls. Native elapsed measurements are not response latency.",
    });
    if (EXTRA_LAYERS.includes(layer)) warnings.push({ code: "recorded-sites-not-wire-counts", count: rows.length, message: "Counts are distinct recorded request sites, not measured HTTP executions. Loops, retries, dynamic targets and unlogged scripts are not reconstructed. Recorded-status is a subset of direct-request; never add the layers." });
    if (rows.some((r) => !r.startedAt)) warnings.push({ code: "undated-activity", count: rows.filter((r) => !r.startedAt).length, message: "Undated records are omitted from the time chart; no timestamp is invented." });
    exclusions.filteredOut = allRows.length - rows.length;
    exclusions.metadataExcluded = filters.includeMetadata === true ? 0 : allRows.filter((r) => r.workload === "Platform metadata").length;
    if (exclusions.metadataExcluded) warnings.push({ code: "metadata-excluded", count: exclusions.metadataExcluded, message: "Platform metadata demonstrations are hidden from the personal Office view. Enable metadata to inspect them." });
    const nativeSelected = rows.some(row => row.countUnit.startsWith("native-"));
    const unit = nativeSelected ? layer === "tool" ? "source-qualified tool calls" : "source-qualified returned-result observations"
        : core?.unit ?? (layer === "code-reference" ? "Graph code references" : "recorded Graph request sites");
    // Recompute API coverage with the same selected source/tool/date filters, not result outcome.
    let apiCoverage = core?.apiCoverage ?? null;
    if (layer === "reported-api") {
        const toolSlice = buildActivityAnalytics(scenarios, { ...options, layer: "tool", groupBy: "workload",
            filters: { ...filters, workloads: undefined, services: undefined, outcomes: undefined, endpoints: undefined, activityTypes: undefined } });
        const resultsByCall = new Map();
        for (const row of allRows) {
            if (!resultsByCall.has(row.parentCallId)) resultsByCall.set(row.parentCallId, []);
            resultsByCall.get(row.parentCallId).push(row);
        }
        const eligibleIds = new Set(toolSlice.rows.filter(row => {
            const results = resultsByCall.get(row.id) ?? [];
            const categoryMatch = candidate => !filters.workloads?.length || filters.workloads.includes(candidate.workload);
            const candidates = row.workload === "Discovery" ? results.length ? results : [{
                ...row, workload: "Unknown",
                serviceAssociation: serviceCategories.associate({ tool: row.tool }, "reported-api", classifyWorkload),
            }] : [row, ...results];
            return candidates.some(candidate => categoryMatch(candidate) && projection.serviceSelected(candidate, filters));
        }).map(row => row.id));
        apiCoverage = projection.apiCoverage(toolSlice.rows.filter(row => eligibleIds.has(row.id)).map(row => {
            const results = resultsByCall.get(row.id) ?? [];
            return { id: row.id, scenarioId: row.scenarioId, resultIds: results.map(result => result.id),
                numericStatusIds: results.filter(result => validStatus(result.status)).map(result => result.id) };
        }), rows);
    }
    return {
        ...core, schemaVersion: 2, layer, label: nativeSelected ? layer === "tool" ? "Recorded tool calls" : "Recorded returned results" : LABELS[layer], unit, groupBy: by,
        ...projection.project(rows, { groupBy: by, limit, bucket, filters, timeContext, dateRange }, scenarios),
        resultFacet, apiCoverage,
        population: retainedSelection(scenarios, rows, { ...filters, ...dateRange }, projection, layer),
        httpCoverage: layer === "http" ? { observedResponseCount: rows.filter((r) => r.observedGraphHttp).length, noResponseRecordCount: rows.filter((r) => !r.observedGraphHttp).length } : null,
        timeContext, dateRange,
        filterOptions: {
            sources: retainedSourceIds(),
            tools: unique(allRows.map((r) => r.tool).filter(Boolean)).sort(), sourceSessionIds: unique([
                ...allRows.map((r) => r.sourceSessionId), ...scenarios.filter(isNativeConsumerRecord).map(record => record.sourceSessionId),
            ].filter(Boolean)).sort(),
            projectIds: unique(allRows.map((r) => r.projectId)),
            workloads: OFFICE_WORKLOADS.filter(value => layer === "tool" || value !== "Discovery"),
            services: OFFICE_WORKLOADS.filter(value => layer === "tool" || value !== "Discovery"),
            activityTypes: ["workiq", "direct-request", "recorded-http", "captured-http", "code-reference"],
            endpoints: unique(allRows.map((r) => r.endpoint.id)).map((id) => { const e = allRows.find((r) => r.endpoint.id === id).endpoint; return { id, label: e.label }; }),
            outcomes: [...OUTCOMES], scopes: ["history", "all", "legacy"],
            promptAuthors: [...promptAuthorship.actors],
        },
        warnings, exclusions: core ? { ...core.exclusions, filteredOut: exclusions.filteredOut, metadataExcluded: exclusions.metadataExcluded } : exclusions,
        denominatorNote: nativeSelected ? "Source-qualified call identities and returned-result observations have separate unit populations. Message representations, task states and result references are not tool calls; native timing is not pooled."
            : core?.denominatorNote ?? "Unique source chat + recorded request site. Code references and unknown wire executions are separate; no cross-layer sum.",
    };
}

export const buildAnalytics = buildActivityAnalytics;

// One unfiltered canonical context per snapshot, never one fetch per request.
// Retain only the attribution fields needed to connect the full journey to a slice.
export function buildRequestActivity(scenarios) {
    const legacy = scenarios.filter(record => !isNativeConsumerRecord(record));
    const filters = { scope: "all", includeMetadata: true };
    return Object.fromEntries(["tool", "reported-api", "direct-request", "recorded-http", "http", "code-reference"].map(layer => {
        const coreRows = EXTRA_LAYERS.includes(layer) ? null : buildAnalyticsRows(legacy, { layer, filters: { scope: "all" } });
        const rows = activityRows(scenarios, layer, coreRows, { synthetic: 0, unidentifiable: 0, duplicateRecords: 0 })
            .filter(row => projection.selected(row, filters)).sort((a, b) => compare(a.id, b.id));
        // Keep full-analytics population validation without computing its unused charts.
        retainedSelection(scenarios, rows, filters, projection, layer);
        return [layer, rows.map(({ id, scenarioId, scenarioIds, sourceSessionId, sourceId, sourceScope, toolCallId, activityId, recordId, parentCallId, observationKey, resultIndex, outcome, status, workload, endpoint, serviceAssociation, countUnit, nativeToolNames, nativeOutcome, nativeConflicts }) =>
            ({ id, scenarioId, scenarioIds, sourceSessionId, sourceId, sourceScope, toolCallId, activityId, recordId, parentCallId, observationKey, resultIndex, outcome, status, workload, endpoint, serviceAssociation, countUnit, nativeToolNames, nativeOutcome, nativeConflicts }))];
    }));
}

export function getActivityDrilldown(analytics, id) {
    const group = id === "group:other" ? analytics.otherGroup : [...analytics.groups, ...analytics.workloadGroups, ...(analytics.serviceInvolvement?.groups ?? [])].find((g) => g.id === id);
    const point = analytics.timeSeries.points.find((p) => p.date === id);
    const journey = analytics.journeys.find((j) => j.id === id);
    const slice = group ?? point ?? journey;
    if (!slice) throw new RangeError("Unknown activity slice.");
    const ids = new Set(slice.drilldownIds);
    return analytics.rows.filter((r) => ids.has(r.id));
}
