import { buildActivityAnalytics, buildRequestActivity } from "./activity-analytics.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";
import { OUTCOMES } from "./analytics.mjs";
import * as contract from "./assessment-contract.mjs";
import { assessmentBasis, assessmentOverview, assessmentRef, buildAssessmentModel } from "./assessment-read-model.mjs";
import { projectReportResults } from "./report-result-projection.mjs";
import { compareReportResultFacts } from "./report-result-facts.mjs";
import { comparePeriodCohorts, nativePeriodSummary } from "./period-comparison-math.mjs";
import { BoardError, mergeEvidenceWithState } from "./store.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { time } from "./time.mjs";
import { searchWireContract } from "./search-wire-contract.mjs";
import { retainedSelection, nativeActivityRows } from "./retained-population.mjs";
import { createHmac } from "node:crypto";

const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
const distinct = values => [...new Set(values)].sort();
const fields = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validatePeriodSemanticSelection(value) {
    const receipt = value?.receipt;
    if (!fields(value, ["receipt", ...(value && Object.hasOwn(value, "withinScenarioIds") ? ["withinScenarioIds"] : [])])
        || value.withinScenarioIds !== undefined && (!Array.isArray(value.withinScenarioIds)
            || value.withinScenarioIds.some(id => typeof id !== "string" || !id) || new Set(value.withinScenarioIds).size !== value.withinScenarioIds.length)
        || !searchWireContract.analysisReceipt(receipt)) {
        throw new BoardError("A current v2 strict analysis receipt is required for these comparison periods. Reload search if its protocol changed.", 422);
    }
    return value;
}

export function validatePeriodComparisonInput(input) {
    const semantic = input?.semanticSelection !== undefined;
    if (!fields(input, ["schemaVersion", "expectedRevision", "options", "periods", semantic ? "semanticSelection" : "scenarioIds", "withinServices",
        ...(input?.nativeViewId === undefined ? [] : ["nativeViewId"]),
        ...(input?.nativeViewKind === undefined ? [] : ["nativeViewKind"])])
        || input.schemaVersion !== 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new BoardError("A period comparison requires its accepted stored revision and exact scope.", 422);
    }
    if (input.nativeViewKind !== undefined && (input.nativeViewKind !== "current" || input.nativeViewId === undefined)
        || input.nativeViewId !== undefined && (!/^[a-f0-9]{64}$/.test(input.nativeViewId) || semantic && input.nativeViewKind !== "current")) {
        throw new BoardError("Microsoft periods require the original complete source view without a GitHub Search receipt.", 422);
    }
    validateAnalyticsInput(input.options);
    if (input.options.filters?.from !== undefined || input.options.filters?.to !== undefined) {
        throw new BoardError("Comparison dates belong to Period A and Period B, not the ordinary Analyze date filter.", 422);
    }
    if (semantic) validatePeriodSemanticSelection(input.semanticSelection);
    if ((!semantic && (!Array.isArray(input.scenarioIds) || input.scenarioIds.some(id => typeof id !== "string" || !id)
        || new Set(input.scenarioIds).size !== input.scenarioIds.length))
        || !Array.isArray(input.withinServices) || new Set(input.withinServices).size !== input.withinServices.length
        || input.withinServices.some(id => !serviceCategories.entries.some(service => service.id === id))) {
        throw new BoardError("Choose an exact retained interaction scope and supported service refinements.", 422);
    }
    if (!fields(input.periods, ["baseline", "later"])) throw new BoardError("Choose both comparison periods.", 422);
    for (const period of Object.values(input.periods)) {
        if (!fields(period, ["from", "to"])) throw new BoardError("Choose a start and end date for each period.", 422);
        try {
            time.calendar(period.from); time.calendar(period.to);
            time.range(period, time.normalize(input.options.timeContext).timeZone);
        } catch (error) {
            throw new BoardError(error.message, 422);
        }
    }
    return input;
}

export function selectPeriodApiParents(base, requestRows, selection, withinServices) {
    const semantic = selection.semanticMembership !== undefined;
    const selected = new Set(semantic ? selection.semanticMembership.scenarioIds : selection.scenarioIds);
    const parentScenarios = new Set(semantic
        ? [...selection.semanticMembership.scenarioIds, ...selection.semanticMembership.parentScenarioIds] : selection.scenarioIds);
    let parentCalls = base.apiCoverage.calls.filter(call => parentScenarios.has(call.scenarioId)
        && (selection.withinScenarioIds === undefined || selection.withinScenarioIds.includes(call.scenarioId)));
    if (withinServices.length) {
        const eligible = requestRows.filter(row => (semantic ? parentScenarios : selected).has(row.scenarioId)
            && withinServices.every(service => row.serviceAssociation.services.includes(service)));
        const parents = new Set(eligible.map(row => row.parentCallId));
        parentCalls = parentCalls.filter(call => parents.has(call.id));
    }
    return parentCalls;
}

// Canonical membership is established here, before any comparison arithmetic.
// This is a live read model, not a report snapshot or a disclosure approval.
export function buildPeriodComparison(state, input, { scenarios = mergeEvidenceWithState(state), model, semanticMembership, nativeRecords, nativeMembership } = {}) {
    validatePeriodComparisonInput(input);
    if (state.revision !== input.expectedRevision) throw new BoardError("The stored revision changed. Read the current Analyze view before comparing again.", 409);
    if (state.deletion?.pending) throw new BoardError("Local cleanup must finish before comparing retained periods.", 409);
    const records = new Map(scenarios.map(record => [record.scenarioId, record]));
    const semantic = input.semanticSelection !== undefined;
    if (semantic) {
        if (input.semanticSelection.withinScenarioIds?.some(id => !records.has(id))) {
            throw new BoardError("The comparison narrowing contains an interaction outside this retained revision.", 409);
        }
        if (!fields(semanticMembership, ["scenarioIds", "actionIds", "parentScenarioIds"])
            || Object.values(semanticMembership).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length)
            || [...semanticMembership.scenarioIds, ...semanticMembership.parentScenarioIds].some(id => !records.has(id))) {
            throw new BoardError("search-membership-unavailable", 409);
        }
        const all = new Set(buildActivityAnalytics(scenarios, { layer: input.options.layer, filters: { scope: "all", includeMetadata: true } }).rows.map(row => row.id));
        if (semanticMembership.actionIds.some(id => !all.has(id))) throw new BoardError("stale-search-membership", 409);
    } else if (input.scenarioIds.some(id => !records.has(id))) throw new BoardError("The selected interactions are no longer in this stored revision.", 409);
    model ??= buildAssessmentModel(state);
    if (contract.BASIS_KEYS.some(key => model.basis[key] !== assessmentBasis(state)[key])) {
        throw new BoardError("Comparison assessment facts no longer match the accepted stored revision.", 409);
    }
    const selected = new Set(semantic ? semanticMembership.scenarioIds : input.scenarioIds);
    const selectedActions = new Set(semantic ? semanticMembership.actionIds : []);
    const selection = semantic ? { semanticMembership,
        ...(input.semanticSelection.withinScenarioIds === undefined ? {} : { withinScenarioIds: input.semanticSelection.withinScenarioIds }) } : { scenarioIds: input.scenarioIds };
    const requestActivity = input.options.layer === "reported-api" && input.withinServices.length ? buildRequestActivity(scenarios) : null;
    const withinScenario = id => selection.withinScenarioIds === undefined || selection.withinScenarioIds.includes(id);
    const refine = rows => rows.filter(row => (selected.has(row.scenarioId) || selectedActions.has(row.id))
        && withinScenario(row.scenarioId)
        && input.withinServices.every(service => row.serviceAssociation.services.includes(service)));
    const buildSide = range => {
        const options = { ...input.options, filters: { ...input.options.filters, ...range } };
        const base = buildActivityAnalytics(scenarios, options);
        const rows = refine(base.rows), facetRows = refine(base.resultFacet.rows);
        let parentCalls = base.apiCoverage?.calls;
        if (base.layer === "reported-api") {
            parentCalls = selectPeriodApiParents(base, requestActivity?.["reported-api"], selection, input.withinServices);
        }
        const measuredParents = new Set(rows.map(row => row.scenarioId));
        const populationRecords = scenarios.filter(record => measuredParents.has(record.scenarioId)
            || !input.withinServices.length && selected.has(record.scenarioId) && withinScenario(record.scenarioId));
        const analytics = {
            ...base,
            ...projection.project(rows, { ...options, groupBy: base.groupBy, limit: options.limit ?? 10, bucket: base.timeSeries.bucket,
                timeContext: base.timeContext, dateRange: base.dateRange }, scenarios),
            population: retainedSelection(populationRecords, rows, { ...options.filters, ...base.dateRange }, projection, base.layer),
            resultFacet: { ...base.resultFacet, rows: facetRows, totals: projection.summarize(facetRows) },
            apiCoverage: base.layer === "reported-api" ? projection.apiCoverage(parentCalls, rows) : base.apiCoverage,
            httpCoverage: base.layer === "http" ? { observedResponseCount: rows.filter(row => row.observedGraphHttp).length,
                noResponseRecordCount: rows.filter(row => !row.observedGraphHttp).length } : base.httpCoverage,
            revision: state.revision,
        };
        const scenarioIds = distinct(rows.map(row => row.scenarioId));
        const associations = scenarioIds.map(id => model.catalog.find(item => item.scenarioId === id));
        const interactionRefs = distinct(associations.filter(item => item?.status === "retained" && item.interactionRef).map(item => item.interactionRef));
        const unmappedScenarioIds = scenarioIds.filter((id, index) => !associations[index]?.interactionRef || associations[index].status !== "retained");
        const assessment = assessmentOverview(state, model, interactionRefs);
        return {
            range: { ...range }, dateRange: base.dateRange, analytics, rowIds: rows.map(row => row.id), scenarioIds,
            interactionRefs, unmappedScenarioIds, assessment,
            reviewStatusRevisions: associations.filter(item => item?.interactionRef).map(item => ({
                scenarioId: item.scenarioId, interactionRef: item.interactionRef, revision: item.reviewStatusRevision ?? null,
            })),
            interactionCoverage: assessment.metrics.map(metric => ({
                metricRef: metric.metricRef, slot: contract.metricSlotKey(metric),
                eligibleUnitRefs: [...metric.eligibleUnitRefs], coveredUnitRefs: [...metric.coveredUnitRefs],
            })),
        };
    };
    const baseline = buildSide(input.periods.baseline), later = buildSide(input.periods.later);
    const resultRef = (kind, value) => `${kind}-${createHmac("sha256", state.pseudonymKey).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
    const nativeResultMembers = { baseline: [], later: [] };
    let nativePeriods;
    if (nativeRecords !== undefined) {
        const ref = (kind, value) => `${kind}-${createHmac("sha256", state.pseudonymKey).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
        const filters = input.options.filters ?? {};
        if ((input.nativeViewKind === "current") !== (nativeMembership !== undefined)) {
            throw new BoardError("The original refined period membership is unavailable.", 409);
        }
        if (nativeMembership && input.withinServices.length) {
            throw new BoardError("A local service refinement is not part of this Microsoft source receipt. Clear it before comparing periods.", 422);
        }
        if (nativeMembership && (!fields(nativeMembership, ["rowIds", "contextScenarioIds", "datePolicy", "predicateRef"])
            || !fields(nativeMembership.rowIds, ["baseline", "later", "undated"])
            || [...Object.values(nativeMembership.rowIds), nativeMembership.contextScenarioIds].some(ids =>
                !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id))
            || nativeMembership.datePolicy !== "replace-original-dates" || !/^[a-f0-9]{64}$/.test(nativeMembership.predicateRef)
            || nativeMembership.contextScenarioIds.some(id => !nativeRecords.some(record => record.scenarioId === id)))) {
            throw new BoardError("The producer's refined period membership is invalid.", 409);
        }
        const matching = nativeMembership ? new Set(Object.values(nativeMembership.rowIds).flat()) : null;
        const candidates = nativeActivityRows(nativeRecords, input.options.layer ?? "tool").filter(row =>
            matching ? matching.has(row.id) : projection.selected(row, filters)
                && input.withinServices.every(service => row.serviceAssociation.services.includes(service)));
        if ((input.options.layer ?? "tool") === "tool") for (const [name, side] of Object.entries({ baseline, later })) {
            nativeResultMembers[name] = candidates.filter(row => row.countUnit === "native-tool-call" && row.startedAt !== null
                && row.startedAt >= side.dateRange.from && row.startedAt < side.dateRange.to).map(row => ({
                rowRef: resultRef("row", row.id), memberRef: resultRef("native-call", row.id),
            }));
        }
        if (nativeMembership) {
            for (const [side, range] of [["baseline", baseline.dateRange], ["later", later.dateRange], ["undated", null]]) {
                const actual = candidates.filter(row => range ? row.startedAt !== null && row.startedAt >= range.from && row.startedAt < range.to
                    : row.startedAt === null).map(row => row.id).sort();
                if (JSON.stringify(actual) !== JSON.stringify([...nativeMembership.rowIds[side]].sort())) {
                    throw new BoardError("The captured source differs from the original period row membership or clocks.", 409);
                }
            }
        }
        const rows = candidates.map(row => ({ id: ref("row", row.id),
            scenarioId: ref("scenario", row.scenarioId), sourceId: row.sourceId,
            unit: row.countUnit, startedAt: row.startedAt, outcome: row.outcome }));
        const callFilters = ["tools", "outcomes", "services", "workloads", "endpoints", "activityTypes"];
        if (!nativeMembership && (input.options.layer ?? "tool") === "tool" && !input.withinServices.length && !callFilters.some(key => filters[key]?.length)
            && (!filters.promptAuthors?.length || filters.promptAuthors.includes("unknown"))) {
            for (const record of nativeRecords.filter(record => record.sourceId === "microsoft-365-chat"
                && (!filters.sources?.length || filters.sources.includes(record.sourceId))
                && (!filters.sourceSessionIds?.length || filters.sourceSessionIds.includes(record.sourceSessionId))
                && !filters.projectIds?.length && (!filters.scope || ["all", "history"].includes(filters.scope)))) {
                for (const observation of record.nativeConversation.observations) {
                    if (!record.nativeConversation.messages.some(message => (message.parentObservationKey ?? message.observationKey) === observation.observationKey)) continue;
                    const created = observation.fields.messageCreatedAt;
                    rows.push({ id: ref("row", observation.observationKey),
                        scenarioId: ref("scenario", record.scenarioId), sourceId: record.sourceId,
                        unit: "message-representation-observation", startedAt: created?.availability === "recorded" ? created.calendarInstant ?? null : null,
                        outcome: "unknown" });
                }
            }
        }
        nativePeriods = { schemaVersion: nativeMembership ? 2 : 1, rows,
            summary: nativePeriodSummary(rows, { baseline: baseline.dateRange, later: later.dateRange }),
            ...(nativeMembership ? { refinement: { datePolicy: nativeMembership.datePolicy,
                predicateRef: ref("native-predicate", nativeMembership.predicateRef),
                contextConversationRefs: nativeMembership.contextScenarioIds.map(id => ref("scenario", id)),
                messageDateMembership: "context-only-not-qualified" } } : {}) };
    }
    for (const [name, side] of Object.entries({ baseline, later })) {
        side.resultMembership = (input.options.layer ?? "tool") === "tool"
            ? [...side.analytics.rows.map(row => ({ rowRef: resultRef("row", row.id), memberRef: assessmentRef(state, "record", row.id) })),
                ...nativeResultMembers[name]] : [];
        side.resultFacts = (input.options.layer ?? "tool") === "tool" ? projectReportResults(scenarios.filter(record => record.recordKind !== "native-conversation"), state.pseudonymKey, {
            memberRefs: side.resultMembership.map(member => member.memberRef),
            ...(nativeRecords ? { nativeSelection: { records: nativeRecords, memberRefs: nativeResultMembers[name].map(member => member.memberRef) } } : {}),
        }).facts : null;
    }
    return {
        kind: "retained-period-comparison", schemaVersion: 1, revision: state.revision,
        assessmentBasis: { ...model.basis }, source: structuredClone(model.source), timeContext: baseline.analytics.timeContext,
        options: structuredClone(input.options),
        selection: { ...structuredClone(selection), withinServices: [...input.withinServices] },
        definitions: { activitySchemaVersion: baseline.analytics.schemaVersion, layer: baseline.analytics.layer, unit: baseline.analytics.unit,
            serviceInvolvement: structuredClone(serviceCategories.involvementDefinition), metricProjectionVersion: contract.METRIC_PROJECTION_VERSION,
            resultProjectionVersion: 1 },
        scope: {
            membership: "Matching canonical records across all pages, selected by each record's retained start time.",
            findings: "Full retained interactions selected by matching records; their recorded timings can include calls outside the period or filters.",
            dates: "Both local calendar dates included. Undated records cannot be placed in either period. Retained history gaps remain gaps.",
            interpretation: "Observed differences only. Unequal periods, shared records, different activity and timing coverage do not establish causal improvement.",
        },
        periods: { baseline, later },
        comparison: comparePeriodCohorts(baseline, later),
        resultComparison: (input.options.layer ?? "tool") === "tool" ? compareReportResultFacts(baseline.resultFacts, later.resultFacts)
            : { version: 1, status: "unavailable", reason: "not-tool-call-cohort", groups: [] },
        ...(nativePeriods ? { nativeViewId: input.nativeViewId, nativePeriods,
            ...(input.nativeViewKind ? { nativeViewKind: input.nativeViewKind } : {}) } : {}),
    };
}
