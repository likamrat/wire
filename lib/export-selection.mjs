import { buildActivityAnalytics, summarizeActivityRows } from "./activity-analytics.mjs";
import { BoardError } from "./store.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";

const layers = { tool: "workIqActions", "reported-api": "returnedApiResults", "direct-request": "graphRequestSites", "recorded-http": "graphVisibleStatuses", http: "ownedHttpRecords", "code-reference": "graphCodeReferences" };
const synthetic = (s, item) => s.sample === true || s.synthetic === true || item?.synthetic === true || s.evidenceLayer === "synthetic-http-fixture" || item?.classification === "synthetic-http-fixture";
const diagnostic = (s) => s.workloadKind === "public-metadata-demonstration";
const knownSource = (s) => typeof s.sourceSessionId === "string" && s.sourceSessionId.length > 0 && ["copilot-app", "copilot-app-chat"].includes(s.sourceHost);
const emptyCounts = () => Object.fromEntries(Object.values(layers).map((key) => [key, 0]));

// Reuse the chart's canonical identities, but retain the actual selected source
// fields for the separate privacy scan. Never alter the evidence or review state.
export function buildExportCatalog(scenarios) {
    const candidates = scenarios.filter((s) => !synthetic(s) && !diagnostic(s) && knownSource(s))
        .toSorted((a, b) => Number(a.isLegacy === true) - Number(b.isLegacy === true));
    const analytics = Object.fromEntries(Object.keys(layers).map((layer) => [layer, buildActivityAnalytics(candidates, { layer, filters: { scope: "all" } })]));
    const copies = new Map(candidates.map((s) => [s.scenarioId, { ...s, toolCalls: [], graphActivities: [], httpRecords: [] }]));
    const aliases = new Map(candidates.map((s) => [s.scenarioId, new Set([s.scenarioId])]));
    const used = new Set();
    const sourceCount = scenarios.reduce((n, s) => n + (s.toolCalls?.length || 0) + (s.graphActivities?.length || 0) + (s.httpRecords?.length || 0), 0);
    function retain(layer, field, matches) {
        const rows = analytics[layer].rows;
        for (const s of candidates) for (const item of s[field] || []) {
            if (synthetic(s, item)) continue;
            const row = rows.find((r) => matches(r, s, item));
            if (!row) continue;
            aliases.get(row.scenarioId).add(s.scenarioId);
            const key = layer + row.id;
            if (used.has(key) || row.scenarioId !== s.scenarioId) continue;
            used.add(key);
            copies.get(s.scenarioId)[field].push(item);
        }
    }
    retain("tool", "toolCalls", (r, s, item) => r.sourceSessionId === s.sourceSessionId && (item.toolCallId ? r.toolCallId === item.toolCallId : r.id === `event:${JSON.stringify([s.sourceSessionId, item.startEventId])}`));
    retain("direct-request", "graphActivities", (r, s, item) => r.sourceSessionId === s.sourceSessionId && r.activityId === item.activityId);
    retain("code-reference", "graphActivities", (r, s, item) => r.sourceSessionId === s.sourceSessionId && r.activityId === item.activityId);
    retain("http", "httpRecords", (r, s, item) => r.recordId === item.recordId);
    for (const row of analytics.tool.rows) for (const alias of row.scenarioIds) aliases.get(row.scenarioId).add(alias);
    // The owned recorder's call is metadata for the retained HTTP record, not a
    // Work IQ invocation. The privacy boundary expects that exact argument object.
    for (const s of candidates) if (copies.get(s.scenarioId).httpRecords.length) {
        copies.get(s.scenarioId).toolCalls.push(...(s.toolCalls || []).filter((call) => call.tool === "owned-graph-http" && !synthetic(s, call)));
    }
    const records = [...copies.values()].filter((s) => s.toolCalls.length || s.graphActivities.length || s.httpRecords.length);
    const requests = records.map((s) => ({
        scenarioId: s.scenarioId, sourceSessionId: s.sourceSessionId, aliases: [...aliases.get(s.scenarioId)],
        promptAuthor: promptAuthorship.read(s.userPrompt).actor,
        counts: Object.fromEntries(Object.entries(layers).map(([layer, name]) => [name, analytics[layer].rows.filter((r) => r.scenarioId === s.scenarioId).length])),
        results: Object.fromEntries(Object.keys(layers).map(layer => [layer, summarizeActivityRows(analytics[layer].rows.filter(r => r.scenarioId === s.scenarioId))])),
    }));
    const retained = records.reduce((n, s) => n + s.toolCalls.filter((call) => call.tool !== "owned-graph-http").length + s.graphActivities.length + s.httpRecords.length, 0);
    const excluded = {
        syntheticRequestGroups: scenarios.filter((s) => synthetic(s)).length,
        diagnosticRequestGroups: scenarios.filter((s) => !synthetic(s) && diagnostic(s)).length,
        unknownSourceRequestGroups: scenarios.filter((s) => !synthetic(s) && !diagnostic(s) && !knownSource(s)).length,
        requestGroupsWithoutEligibleEvidence: candidates.length - records.length,
        duplicateEvidenceRecords: ["tool", "direct-request", "http", "code-reference"].reduce((n, layer) => n + analytics[layer].exclusions.duplicateRecords, 0),
        unidentifiableEvidenceRecords: ["tool", "direct-request", "http", "code-reference"].reduce((n, layer) => n + analytics[layer].exclusions.unidentifiable, 0),
        platformDiagnosticEvidenceRecords: ["tool", "direct-request", "http", "code-reference"].reduce((n, layer) => n + analytics[layer].exclusions.metadataExcluded, 0),
        excludedOrDuplicateEvidenceRecords: Math.max(0, sourceCount - retained),
    };
    return { records, requests, excluded };
}

export function summarizeExportSelection(catalog, scenarioIds) {
    const requested = scenarioIds === undefined ? null : new Set(scenarioIds);
    const requests = catalog.requests.filter((r) => !requested || r.aliases.some((id) => requested.has(id)));
    const counts = requests.reduce((total, r) => {
        for (const key of Object.keys(total)) total[key] += r.counts[key];
        return total;
    }, emptyCounts());
    return { requestGroups: requests.length, ...counts };
}

export function selectExportSnapshot(scenarios, selection, revision) {
    if (!selection || Object.getPrototypeOf(selection) !== Object.prototype || Object.keys(selection).some((key) => !["kind", "scenarioIds", "revision", "promptAuthors"].includes(key)) || !["all", "current", "selected"].includes(selection.kind)) {
        throw new BoardError("Choose all collected activity, the current view, or selected requests.", 422);
    }
    if (!Number.isSafeInteger(selection.revision) || selection.revision !== revision) throw new BoardError("The collection changed. Refresh the scope counts and prepare a new review.", 409);
    if (!promptAuthorship.validSelection(selection.promptAuthors)) throw new BoardError("Choose at least one supported prompt author for the report.", 422);
    const ids = selection.scenarioIds;
    if (selection.kind === "all" ? ids !== undefined : !Array.isArray(ids) || !ids.length || ids.length > scenarios.length || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
        throw new BoardError("The report selection is invalid. Choose a fresh scope before reviewing.", 422);
    }
    if (ids?.some((id) => !scenarios.some((s) => s.scenarioId === id))) throw new BoardError("A selected request is no longer available. Choose a fresh scope.", 409);
    const catalog = buildExportCatalog(scenarios);
    const requested = ids ? new Set(ids) : null;
    const promptAuthors = promptAuthorship.selection(selection.promptAuthors);
    const baseRequests = catalog.requests.filter(r => !requested || r.aliases.some(id => requested.has(id)));
    const requests = baseRequests.filter(request => promptAuthors.includes(request.promptAuthor));
    const chosenIds = new Set(requests.map(request => request.scenarioId));
    const records = catalog.records.filter((s) => chosenIds.has(s.scenarioId));
    if (!records.length) throw new BoardError(baseRequests.length
        ? "No request groups in this scope match the report's prompt authors. Change the authors or choose another scope."
        : "This scope contains no eligible collected activity. Choose another scope.", 422);
    const excludedRequestedGroups = ids?.filter((id) => !catalog.requests.some((r) => r.aliases.includes(id))).length || 0;
    return {
        records,
        scope: { kind: selection.kind, ...summarizeExportSelection({ ...catalog, requests }),
            promptAuthors, baseRequestGroups: baseRequests.length, authorExcludedRequestGroups: baseRequests.length - requests.length,
            excludedRequestedGroups, exclusions: catalog.excluded },
    };
}
