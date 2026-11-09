import { createHash } from "node:crypto";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { OFFICE_WORKLOADS } from "./graph-history.mjs";
import { projectReportResultObservation, reportObservationHasError } from "./report-result-facts.mjs";
import { reportContextRef } from "./report-ref.mjs";
import { BoardError } from "./store.mjs";
import { time } from "./time.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";

const OUTCOMES = ["all", "errors", "completed", "unknown"];
const PRESETS = ["all", "errors", "completed", "mine", "agent", "custom"];
const LAYERS = ["tool", "reported-api", "http", "direct-request", "code-reference"];
const plain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const ref = value => typeof value === "string" && /^scenario-[a-f0-9]{16}$/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function resolveReportView(records, input, options, resolveSemantic) {
    if (!plain(input) || Object.keys(input).some(key => !["analytics", "withinServices", "withinScenarioIds", "semanticSelection"].includes(key))
        || !Array.isArray(input.withinServices) || input.withinServices.some(service => !OFFICE_WORKLOADS.includes(service))
        || input.withinScenarioIds !== undefined && (!Array.isArray(input.withinScenarioIds)
            || input.withinScenarioIds.some(id => typeof id !== "string" || !records.some(record => record.scenarioId === id)))
        || input.semanticSelection !== undefined && (!plain(input.semanticSelection)
            || Object.keys(input.semanticSelection).length !== 1 || !Object.hasOwn(input.semanticSelection, "receipt"))) {
        throw new BoardError("The report's Analyze filters are unavailable. Read the current view again.", 422);
    }
    const analytics = validateAnalyticsInput(input.analytics), { from, to, ...filters } = analytics.filters ?? {};
    const selection = time.selection(options.dateSelection), timeContext = time.normalize(options.timeContext);
    const rows = buildActivityAnalytics(records, { ...analytics, timeContext, filters: {
        ...filters, ...(selection.from ? { from: selection.from } : {}), ...(selection.to ? { to: selection.to } : {}),
    } }).rows;
    let membership;
    if (input.semanticSelection !== undefined) {
        if (typeof resolveSemantic !== "function") throw new BoardError("Search membership is unavailable. Search again before preparing this report.", 409);
        membership = resolveSemantic(input.semanticSelection.receipt, analytics.layer ?? "tool");
        if (!membership || ["scenarioIds", "actionIds", "parentScenarioIds"].some(key => !Array.isArray(membership[key]))) {
            throw new BoardError("Search membership is unavailable. Search again before preparing this report.", 409);
        }
    }
    const ids = new Set(membership?.scenarioIds), actions = new Set(membership?.actionIds);
    const narrowed = input.withinScenarioIds === undefined ? null : new Set(input.withinScenarioIds);
    return [...new Set(rows.filter(row => (!membership || ids.has(row.scenarioId) || actions.has(row.id))
        && (!narrowed || narrowed.has(row.scenarioId))
        && input.withinServices.every(service => row.serviceAssociation?.services.includes(service)))
        .map(row => row.scenarioId))];
}

export function normalizeReportFocus(value) {
    if (!plain(value) || Object.keys(value).some(key => !["version", "preset", "outcome", "services"].includes(key))
        || value.version !== 1 || !PRESETS.includes(value.preset) || !OUTCOMES.includes(value.outcome)
        || !Array.isArray(value.services) || value.services.length > OFFICE_WORKLOADS.length
        || new Set(value.services).size !== value.services.length || value.services.some(service => !OFFICE_WORKLOADS.includes(service))) {
        throw new BoardError("Choose a supported report and Work IQ service.", 422);
    }
    return { version: 1, preset: value.preset, outcome: value.outcome, services: [...value.services].sort() };
}

function callReportedError(call) {
    const observation = projectReportResultObservation("report-population", {
        resultEvidence: call.resultEvidence, diagnostic: call.failureEvidence?.diagnostic,
        legacyFailure: call.failureEvidence, returnedEntries: call.apiResults ?? null,
    });
    return reportObservationHasError(observation);
}

function matches(entry, outcome) {
    return outcome === "all" || outcome === "errors" && entry.hasError
        || outcome === "completed" && entry.completedCallsOnly
        || outcome === "unknown" && entry.hasUnknownCalls;
}

// Receives the canonical, author-qualified records from selectExportSnapshot.
// Dates/services admit whole interactions; outcome choices retain their complete evidence.
export function selectReportPopulation(records, options) {
    const focus = normalizeReportFocus(options.reportFocus);
    if (!Array.isArray(records) || records.some(record => typeof record?.scenarioId !== "string"
        || record.recordKind === "native-conversation")
        || new Set(records.map(record => record.scenarioId)).size !== records.length) {
        throw new BoardError("Report presets require a qualified interaction population.", 422);
    }
    const context = time.normalize(options.timeContext), dateSelection = time.selection(options.dateSelection);
    const dateRange = time.range(dateSelection, context.timeZone);
    const selectedIds = new Set(), undatedIds = new Set(), byInteraction = new Map(records.map(record => [record.scenarioId, []]));
    for (const layer of LAYERS) {
        const all = buildActivityAnalytics(records, { layer, timeContext: context, filters: { scope: "all", includeMetadata: true } }).rows;
        if (layer !== "code-reference") for (const row of all) byInteraction.get(row.scenarioId)?.push({ ...row, layer });
        const services = layer === "tool" ? focus.services : focus.services.filter(service => service !== "Discovery");
        if (layer !== "tool" && focus.services.length && !services.length) continue;
        const filters = { scope: "all", includeMetadata: true, ...(services.length ? { services } : {}) };
        const otherwiseEligible = buildActivityAnalytics(records, { layer, timeContext: context, filters }).rows;
        for (const row of otherwiseEligible) if (!row.startedAt) undatedIds.add(row.scenarioId);
        for (const row of buildActivityAnalytics(records, { layer, timeContext: context, filters: { ...filters, ...dateSelection } }).rows) {
            selectedIds.add(row.scenarioId);
        }
    }
    const referenceRecords = records.filter(record => selectedIds.has(record.scenarioId));
    const reference = referenceRecords.map(record => {
        const rows = byInteraction.get(record.scenarioId), calls = rows.filter(row => row.layer === "tool");
        const hasError = rows.some(row => ["failure", "transport"].includes(row.outcome))
            || record.toolCalls.some(callReportedError);
        return {
            scenarioId: record.scenarioId, toolCallCount: calls.length, hasError,
            completedCallsOnly: calls.length > 0 && !hasError && calls.every(row => row.outcome === "success"),
            hasUnknownCalls: calls.some(row => row.outcome === "unknown"),
        };
    });
    const included = new Set(reference.filter(entry => matches(entry, focus.outcome)).map(entry => entry.scenarioId));
    return {
        focus, dateSelection, timeContext: context, dateRange, reference,
        referenceRecords, records: referenceRecords.filter(record => included.has(record.scenarioId)),
        undatedInteractions: undatedIds.size,
    };
}

export function freezeReportPopulation(population, key) {
    const reference = population.reference.map(({ scenarioId, ...entry }) => ({
        ref: reportContextRef(key, "scenario", scenarioId), ...entry,
    })).sort((a, b) => a.ref.localeCompare(b.ref));
    return validateReportPopulation({
        version: 1, definition: "complete-eligible-interactions-v1", focus: population.focus,
        reference, included: reference.filter(entry => matches(entry, population.focus.outcome)).map(entry => entry.ref),
        undatedInteractions: population.undatedInteractions,
    });
}

export function validateReportPopulation(value, records) {
    const fail = () => { throw new TypeError("Invalid frozen report population."); };
    if (!plain(value) || Object.keys(value).length !== 6
        || !["version", "definition", "focus", "reference", "included", "undatedInteractions"].every(key => Object.hasOwn(value, key))
        || value.version !== 1 || value.definition !== "complete-eligible-interactions-v1"
        || !Array.isArray(value.reference) || !Array.isArray(value.included)
        || !Number.isSafeInteger(value.undatedInteractions) || value.undatedInteractions < 0) fail();
    const focus = normalizeReportFocus(value.focus);
    if (JSON.stringify(focus) !== JSON.stringify(value.focus)) fail();
    const seen = new Set();
    for (const entry of value.reference) {
        if (!plain(entry) || Object.keys(entry).length !== 5
            || !["ref", "toolCallCount", "hasError", "completedCallsOnly", "hasUnknownCalls"].every(key => Object.hasOwn(entry, key))
            || !ref(entry.ref) || seen.has(entry.ref) || !Number.isSafeInteger(entry.toolCallCount) || entry.toolCallCount < 0
            || ["hasError", "completedCallsOnly", "hasUnknownCalls"].some(key => typeof entry[key] !== "boolean")
            || entry.completedCallsOnly && (!entry.toolCallCount || entry.hasError || entry.hasUnknownCalls)
            || entry.hasUnknownCalls && !entry.toolCallCount) fail();
        seen.add(entry.ref);
    }
    const expected = value.reference.filter(entry => matches(entry, focus.outcome)).map(entry => entry.ref);
    if (JSON.stringify(expected) !== JSON.stringify(value.included)) fail();
    if (records && JSON.stringify([...records.map(record => record.scenarioId)].sort()) !== JSON.stringify([...value.included].sort())) fail();
    return structuredClone(value);
}

export function inspectReportPopulation(manifest, snapshot) {
    if (!Object.hasOwn(manifest, "reportPopulation") && !Object.hasOwn(manifest, "reportPopulationHash")
        && !Object.hasOwn(snapshot ?? {}, "reportPopulation")) return null;
    const value = validateReportPopulation(manifest.reportPopulation, snapshot?.records);
    if (manifest.reportPopulationHash !== hash(value)
        || snapshot && JSON.stringify(snapshot.reportPopulation) !== JSON.stringify(value)) {
        throw new TypeError("The frozen report population no longer matches its saved binding.");
    }
    return value;
}
