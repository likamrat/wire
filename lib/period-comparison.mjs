import { buildActivityAnalytics, buildRequestActivity } from "./activity-analytics.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";
import { OUTCOMES } from "./analytics.mjs";
import * as contract from "./assessment-contract.mjs";
import { assessmentBasis, assessmentOverview, buildAssessmentModel } from "./assessment-read-model.mjs";
import { comparePeriodCohorts } from "./period-comparison-math.mjs";
import { BoardError, mergeEvidenceWithState } from "./store.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { time } from "./time.mjs";

const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
const distinct = values => [...new Set(values)].sort();
const fields = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validatePeriodComparisonInput(input) {
    if (!fields(input, ["schemaVersion", "expectedRevision", "options", "periods", "scenarioIds", "withinServices"])
        || input.schemaVersion !== 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new BoardError("A period comparison requires its accepted stored revision and exact scope.", 422);
    }
    validateAnalyticsInput(input.options);
    if (input.options.filters?.from !== undefined || input.options.filters?.to !== undefined) {
        throw new BoardError("Comparison dates belong to Period A and Period B, not the ordinary Analyze date filter.", 422);
    }
    if (!Array.isArray(input.scenarioIds) || input.scenarioIds.some(id => typeof id !== "string" || !id)
        || new Set(input.scenarioIds).size !== input.scenarioIds.length
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

// Canonical membership is established here, before any comparison arithmetic.
// This is a live read model, not a report snapshot or a disclosure approval.
export function buildPeriodComparison(state, input, { scenarios = mergeEvidenceWithState(state), model } = {}) {
    validatePeriodComparisonInput(input);
    if (state.revision !== input.expectedRevision) throw new BoardError("The stored revision changed. Read the current Analyze view before comparing again.", 409);
    if (state.deletion?.pending) throw new BoardError("Local cleanup must finish before comparing retained periods.", 409);
    const records = new Map(scenarios.map(record => [record.scenarioId, record]));
    if (input.scenarioIds.some(id => !records.has(id))) throw new BoardError("The selected interactions are no longer in this stored revision.", 409);
    model ??= buildAssessmentModel(state);
    if (contract.BASIS_KEYS.some(key => model.basis[key] !== assessmentBasis(state)[key])) {
        throw new BoardError("Comparison assessment facts no longer match the accepted stored revision.", 409);
    }
    const selected = new Set(input.scenarioIds);
    const requestActivity = input.options.layer === "reported-api" && input.withinServices.length ? buildRequestActivity(scenarios) : null;
    const refine = rows => rows.filter(row => selected.has(row.scenarioId)
        && input.withinServices.every(service => row.serviceAssociation.services.includes(service)));
    const buildSide = range => {
        const options = { ...input.options, filters: { ...input.options.filters, ...range } };
        const base = buildActivityAnalytics(scenarios, options);
        const rows = refine(base.rows), facetRows = refine(base.resultFacet.rows);
        let parentCalls = base.apiCoverage?.calls;
        if (base.layer === "reported-api") {
            parentCalls = parentCalls.filter(call => selected.has(call.scenarioId));
            if (input.withinServices.length) {
                const parents = new Set(refine(requestActivity["reported-api"]).map(row => row.parentCallId));
                parentCalls = parentCalls.filter(call => parents.has(call.id));
            }
        }
        const analytics = {
            ...base,
            ...projection.project(rows, { ...options, groupBy: base.groupBy, limit: options.limit ?? 10, bucket: base.timeSeries.bucket,
                timeContext: base.timeContext, dateRange: base.dateRange }, scenarios),
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
    return {
        kind: "retained-period-comparison", schemaVersion: 1, revision: state.revision,
        assessmentBasis: { ...model.basis }, source: structuredClone(model.source), timeContext: baseline.analytics.timeContext,
        options: structuredClone(input.options),
        selection: { scenarioIds: [...input.scenarioIds], withinServices: [...input.withinServices] },
        definitions: { activitySchemaVersion: baseline.analytics.schemaVersion, layer: baseline.analytics.layer, unit: baseline.analytics.unit,
            serviceInvolvement: structuredClone(serviceCategories.involvementDefinition), metricProjectionVersion: contract.METRIC_PROJECTION_VERSION },
        scope: {
            membership: "Matching canonical records across all pages, selected by each record's retained start time.",
            findings: "Full retained interactions selected by matching records; calls outside the period or filters can remain in these interaction findings and metrics.",
            dates: "Both local calendar dates included. Undated records cannot be placed in either period. Retained history gaps remain gaps.",
            interpretation: "Observed differences only. Unequal periods, shared records, different activity and assessment coverage do not establish causal improvement.",
        },
        periods: { baseline, later },
        comparison: comparePeriodCohorts(baseline, later),
    };
}
