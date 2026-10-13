import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildPeriodComparison, validatePeriodComparisonInput, selectPeriodApiParents } from "./period-comparison.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "./activity-analytics.mjs";
import { comparePeriodCohorts } from "./period-comparison-math.mjs";
import { buildAssessmentModel, buildReportFacts } from "./assessment-read-model.mjs";
import { freezeEvaluationFacts } from "./report-facts.mjs";
import { createActivityProjection } from "./activity-projection.mjs";
import { validateAnalyticsInput } from "./analytics-input.mjs";
import { OUTCOMES } from "./analytics.mjs";
import { WORKIQ_TOOLS, metricSlotKey, validateMetric } from "./assessment-contract.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { OFFICE_WORKLOADS } from "./graph-history.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { time } from "./time.mjs";
import { BoardError, mergeEvidenceWithState } from "./store.mjs";

const projection = createActivityProjection(time, serviceCategories, OUTCOMES);
const same = isDeepStrictEqual;
const distinct = values => [...new Set(values)].sort();
const fail = message => { throw new BoardError(`Period report: ${message}`, 422); };
const require = (condition, message) => { if (!condition) fail(message); };
const fields = (value, keys) => require(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "unsupported frozen fields.");
const ref = value => typeof value === "string" && /^(scenario|row|endpoint|session|project)-[a-f0-9]{16}$/.test(value);
const refs = values => Array.isArray(values) && values.every(ref) && new Set(values).size === values.length;
const typedRefs = (values, kind) => refs(values) && values.every(value => value.startsWith(kind + "-"));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const metricValues = metrics => metrics.map(({ createdAt, ...metric }) => metric);
const sourceTimeWithheld = metric => ({ ...structuredClone(metric), observedTime: {
    ...metric.observedTime, state: metric.observedTime.state === "available" ? "withheld" : metric.observedTime.state, firstAt: null, lastAt: null,
} });
export const PERIOD_AUTHOR_POLICY = "Authors and matching records are fixed to this comparison. Change them in Analyze and create a new comparison report.";
export const PERIOD_POPULATION = "Matching records are the measured population on each side. Assessment coverage describes the full retained interactions selected by those records, including calls outside the period or filters. Copies and surrounding context never add measured records.";

export function periodReportInput(value, semanticSelection) {
    require(value?.kind === "retained-period-comparison" && value.schemaVersion === 1, "an accepted retained-period comparison is required.");
    return validatePeriodComparisonInput({
        schemaVersion: 1, expectedRevision: value.revision, options: value.options,
        periods: { baseline: value.periods?.baseline?.range, later: value.periods?.later?.range },
        ...(semanticSelection === undefined ? { scenarioIds: value.selection?.scenarioIds } : { semanticSelection }), withinServices: value.selection?.withinServices,
    });
}

// Only pooled metric preparation instants are ephemeral. Every other supplied
// field, including numeric values and exact membership, must match the producer.
function acceptedComparable(value) {
    const copy = structuredClone(value);
    for (const side of Object.values(copy.periods)) {
        side.assessment.metrics.forEach(validateMetric);
        side.assessment.metrics = metricValues(side.assessment.metrics);
    }
    return copy;
}

export function acceptPeriodReport(state, value, { source, semanticSelection, resolveSemantic } = {}) {
    const input = periodReportInput(value, semanticSelection);
    if (semanticSelection !== undefined && typeof resolveSemantic !== "function") throw new BoardError("search-membership-unavailable", 409);
    const semanticMembership = semanticSelection === undefined ? undefined : resolveSemantic(semanticSelection.receipt, state, input.options.layer ?? "tool");
    const model = buildAssessmentModel(state, { ...(source ? { source } : {}) });
    const current = buildPeriodComparison(state, input, { model, semanticMembership });
    require(same(acceptedComparable(value), acceptedComparable(current)), "the supplied comparison differs from the accepted retained revision. Return to Analyze.");
    return { value: structuredClone(value), input, model };
}

export function periodAssessmentSignature(state, model, interactionRefs) {
    const selected = interactionRefs.map(ref => {
        const view = model.details.get(ref);
        if (!view) throw new BoardError("The comparison interaction is no longer available.", 409);
        // These fields are read-model identities, not source facts. Authority is
        // checked separately by the existing evaluation dependency guard.
        return { interactionRef: ref, reviewStatus: view.reviewStatus,
            metrics: view.metrics.map(({ metricRef, createdAt, basis, ...metric }) => metric) };
    });
    return createHmac("sha256", state.pseudonymKey).update(JSON.stringify(selected)).digest("hex");
}

function apiParentSignature(state, dependency) {
    const scenarios = mergeEvidenceWithState(state), requestRows = buildRequestActivity(scenarios)["reported-api"];
    const parents = dependency.ranges.map(range => {
        const base = buildActivityAnalytics(scenarios, { ...dependency.options, filters: { ...dependency.options.filters, ...range } });
        const calls = selectPeriodApiParents(base, requestRows, dependency.selection, dependency.withinServices);
        const ids = new Set(calls.map(call => call.id));
        return { calls, results: requestRows.filter(row => ids.has(row.parentCallId)) };
    });
    return createHmac("sha256", state.pseudonymKey).update(JSON.stringify(parents)).digest("hex");
}

export function assertPeriodApiParents(state, dependency) {
    if (dependency && dependency.signature !== apiParentSignature(state, dependency)) {
        throw new BoardError("Comparison API parent coverage or returned-status evidence changed. Prepare a new comparison report.", 409);
    }
}

const keyId = key => (kind, value) => value === null ? null
    : `${kind}-${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;

function projectedFilters(filters, id) {
    const result = structuredClone(filters ?? {});
    for (const [field, kind] of [["sourceSessionIds", "session"], ["projectIds", "project"], ["endpoints", "endpoint"]]) {
        if (result[field]) result[field] = result[field].map(value => id(kind, value));
    }
    return result;
}

function comparableSide(side, definitions) {
    return { analytics: { layer: definitions.layer, unit: definitions.unit, rows: side.rows, totals: side.totals },
        assessment: { metrics: side.facts.metrics } };
}

export function periodReportComparison(value) {
    return comparePeriodCohorts(comparableSide(value.periods.baseline, value.definitions), comparableSide(value.periods.later, value.definitions));
}

export function freezePeriodReport(state, accepted, preparedAt) {
    const { value, model } = accepted, id = keyId(state.pseudonymKey);
    const periods = {}, dependencies = [];
    for (const [name, side] of Object.entries(value.periods)) {
        const assessed = buildReportFacts(side.interactionRefs.map(ref => model.internals.get(ref).record), state, {
            preparedAt, source: model.source, interactionOrder: side.interactionRefs,
            scope: { kind: "selected", from: side.dateRange.from, untilExclusive: side.dateRange.to, timeZone: value.timeContext.timeZone },
        });
        const metrics = side.assessment.metrics.map(sourceTimeWithheld);
        require(same(metricValues(assessed.facts.metrics), metricValues(metrics))
            && same(assessed.facts.reviewStatuses, side.assessment.reviewStatuses)
            && same(assessed.facts.assessmentAttempts, side.assessment.assessmentAttempts),
        "full-interaction facts cannot be frozen without changing the displayed comparison.");
        const facts = freezeEvaluationFacts({ ...assessed.facts, metrics });
        dependencies.push(assessed.dependencies);
        periods[name] = {
            range: structuredClone(side.range), dateRange: structuredClone(side.dateRange),
            scenarioRefs: side.scenarioIds.map(value => id("scenario", value)),
            unmappedScenarioRefs: side.unmappedScenarioIds.map(value => id("scenario", value)),
            associations: side.reviewStatusRevisions.map(item => ({ scenarioRef: id("scenario", item.scenarioId),
                interactionRef: item.interactionRef, reviewStatusRevision: item.revision })),
            rows: side.analytics.rows.map(row => ({
                id: id("row", row.id), scenarioRef: id("scenario", row.scenarioId), endpoint: { id: id("endpoint", row.endpoint.id) },
                tool: row.tool, workload: row.workload, outcome: row.outcome, status: row.status, durationMs: row.durationMs,
                promptAuthor: row.promptAuthor, services: [...row.serviceAssociation.services],
                missingService: row.serviceAssociation.gaps.length > 0, serviceNotApplicable: row.serviceAssociation.status === "not-applicable",
            })),
            totals: structuredClone(side.analytics.totals),
            serviceSelection: {
                knownMatchRefs: side.analytics.serviceInvolvement.selection.knownMatchIds.map(value => id("row", value)),
                contextOnlyRefs: side.analytics.serviceInvolvement.selection.contextOnlyIds.map(value => id("row", value)),
            },
            facts, interactionCoverage: structuredClone(side.interactionCoverage),
            apiCoverage: side.analytics.apiCoverage ? { ...structuredClone(side.analytics.apiCoverage),
                calls: side.analytics.apiCoverage.calls.map(call => ({
                    id: id("row", call.id), scenarioId: id("scenario", call.scenarioId),
                    resultIds: call.resultIds.map(value => id("row", value)), numericStatusIds: call.numericStatusIds.map(value => id("row", value)),
                })),
            } : null,
        };
    }
    const frozen = {
        kind: "retained-period-report", schemaVersion: 1, revision: value.revision,
        timeContext: structuredClone(value.timeContext), definitions: structuredClone(value.definitions),
        source: { available: value.source.available, revision: value.source.sourceConfigRevision },
        scope: { ...structuredClone(value.scope), population: PERIOD_POPULATION, authorPolicy: PERIOD_AUTHOR_POLICY },
        selection: {
            filters: projectedFilters(value.options.filters, id), withinServices: [...value.selection.withinServices],
            promptAuthors: promptAuthorship.selection(value.options.filters?.promptAuthors),
            ...(value.selection.semanticMembership ? { semanticMembership: {
                scenarioRefs: value.selection.semanticMembership.scenarioIds.map(value => id("scenario", value)),
                rowRefs: value.selection.semanticMembership.actionIds.map(value => id("row", value)),
                parentScenarioRefs: value.selection.semanticMembership.parentScenarioIds.map(value => id("scenario", value)),
            } } : {}),
            ...(value.selection.withinScenarioIds === undefined ? {} : { withinScenarioRefs: value.selection.withinScenarioIds.map(value => id("scenario", value)) }),
        },
        periods, comparison: null,
    };
    frozen.comparison = periodReportComparison(frozen);
    require(same(frozen.comparison, value.comparison), "privacy projection changed a displayed comparison measure.");
    validatePeriodReport(frozen);
    let apiParents;
    if (value.definitions.layer === "reported-api") {
        apiParents = {
            options: structuredClone(value.options), selection: structuredClone(value.selection),
            withinServices: [...value.selection.withinServices],
            ranges: Object.values(value.periods).map(side => ({ ...side.range })),
        };
        apiParents.signature = apiParentSignature(state, apiParents);
    }
    return { frozen, dependencies, apiParents };
}

export function validatePeriodReport(value, records) {
    fields(value, ["kind", "schemaVersion", "revision", "timeContext", "definitions", "source", "scope", "selection", "periods", "comparison"]);
    require(value.kind === "retained-period-report" && value.schemaVersion === 1 && integer(value.revision), "unsupported frozen version.");
    require(same(value.timeContext, time.normalize(value.timeContext)), "invalid time context.");
    fields(value.definitions, ["activitySchemaVersion", "layer", "unit", "serviceInvolvement", "metricProjectionVersion"]);
    const units = { tool: "Work IQ tool calls", "reported-api": "reported API result units", http: "direct HTTP records",
        "direct-request": "recorded Graph request sites", "recorded-http": "recorded Graph request sites", "code-reference": "Graph code references" };
    require(value.definitions.activitySchemaVersion === 2 && Object.hasOwn(units, value.definitions.layer)
        && value.definitions.unit === units[value.definitions.layer] && value.definitions.metricProjectionVersion === 2
        && value.definitions.serviceInvolvement?.id === "wire-service-involvement"
        && value.definitions.serviceInvolvement.version === 1, "unsupported definitions.");
    fields(value.source, ["available", "revision"]);
    require(typeof value.source.available === "boolean" && integer(value.source.revision), "invalid source basis.");
    fields(value.scope, ["membership", "findings", "dates", "interpretation", "population", "authorPolicy"]);
    require(value.scope.population === PERIOD_POPULATION && value.scope.authorPolicy === PERIOD_AUTHOR_POLICY
        && value.scope.membership === "Matching canonical records across all pages, selected by each record's retained start time."
        && value.scope.findings === "Full retained interactions selected by matching records; calls outside the period or filters can remain in these interaction findings and metrics."
        && value.scope.dates === "Both local calendar dates included. Undated records cannot be placed in either period. Retained history gaps remain gaps."
        && value.scope.interpretation === "Observed differences only. Unequal periods, shared records, different activity and assessment coverage do not establish causal improvement.",
    "unsupported population meaning.");
    fields(value.selection, ["filters", "withinServices", "promptAuthors", ...(value.selection.semanticMembership === undefined ? [] : ["semanticMembership"]),
        ...(Object.hasOwn(value.selection, "withinScenarioRefs") ? ["withinScenarioRefs"] : [])]);
    if (Object.hasOwn(value.selection, "withinScenarioRefs")) require(value.selection.semanticMembership !== undefined
        && typedRefs(value.selection.withinScenarioRefs, "scenario"), "invalid frozen interaction narrowing.");
    if (value.selection.semanticMembership !== undefined) {
        fields(value.selection.semanticMembership, ["scenarioRefs", "rowRefs", "parentScenarioRefs"]);
        require(typedRefs(value.selection.semanticMembership.scenarioRefs, "scenario") && typedRefs(value.selection.semanticMembership.rowRefs, "row")
            && typedRefs(value.selection.semanticMembership.parentScenarioRefs, "scenario"), "invalid frozen search membership.");
    }
    validateAnalyticsInput({ layer: value.definitions.layer, filters: value.selection.filters, timeContext: value.timeContext });
    require(!value.selection.filters.tools || value.selection.filters.tools.every(tool =>
        [...WORKIQ_TOOLS, "owned-graph-http", "shell", "graph-mcp", "script-reference"].includes(tool)), "unsupported tool filter.");
    require(value.selection.filters.from === undefined && value.selection.filters.to === undefined
        && same(value.selection.promptAuthors, promptAuthorship.selection(value.selection.filters.promptAuthors)), "author or date scope differs.");
    for (const field of ["sourceSessionIds", "projectIds", "endpoints"]) if (value.selection.filters[field]) {
        require(value.selection.filters[field].every(item => field === "projectIds" && item === null || ref(item)), "raw filter identifiers are not permitted.");
    }
    require(Array.isArray(value.selection.withinServices) && new Set(value.selection.withinServices).size === value.selection.withinServices.length
        && value.selection.withinServices.every(id => serviceCategories.entries.some(service => service.id === id)), "invalid service refinement.");
    fields(value.periods, ["baseline", "later"]);
    for (const side of Object.values(value.periods)) {
        fields(side, ["range", "dateRange", "scenarioRefs", "unmappedScenarioRefs", "associations", "rows", "totals", "serviceSelection", "facts", "interactionCoverage", "apiCoverage"]);
        fields(side.range, ["from", "to"]);
        require(same(side.dateRange, time.range(side.range, value.timeContext.timeZone)), "civil-date bounds changed.");
        const facts = freezeEvaluationFacts(side.facts), interactions = facts.memberships.map(item => item.interactionRef);
        require(same(value.definitions.serviceInvolvement, facts.serviceInvolvement?.definition), "service definitions differ.");
        require(facts.scope.from === side.dateRange.from && facts.scope.untilExclusive === side.dateRange.to
            && facts.scope.timeZone === value.timeContext.timeZone, "assessment scope differs.");
        require(typedRefs(side.scenarioRefs, "scenario") && typedRefs(side.unmappedScenarioRefs, "scenario")
            && side.unmappedScenarioRefs.every(ref => side.scenarioRefs.includes(ref)), "invalid scenario membership.");
        require(Array.isArray(side.associations) && new Set(side.associations.map(item => item.scenarioRef)).size === side.associations.length, "invalid associations.");
        for (const item of side.associations) {
            fields(item, ["scenarioRef", "interactionRef", "reviewStatusRevision"]);
            require(side.scenarioRefs.includes(item.scenarioRef) && interactions.includes(item.interactionRef)
                && (item.reviewStatusRevision === null || /^[a-f0-9]{64}$/.test(item.reviewStatusRevision)), "invalid assessment association.");
        }
        require(same(distinct(side.associations.map(item => item.interactionRef)), distinct(interactions)), "interaction membership differs.");
        require(same(distinct(side.associations.map(item => item.scenarioRef)), distinct(side.scenarioRefs.filter(ref => !side.unmappedScenarioRefs.includes(ref)))), "scenario associations differ.");
        const reviews = facts.reviewStatuses ?? [];
        require(same(distinct(reviews.map(item => item.interactionRef)), distinct(side.associations.filter(item => item.reviewStatusRevision !== null).map(item => item.interactionRef))), "review coverage differs.");
        for (const item of side.associations) if (item.reviewStatusRevision !== null) require(
            createHash("sha256").update(JSON.stringify(reviews.find(review => review.interactionRef === item.interactionRef).reviewStatus)).digest("hex") === item.reviewStatusRevision,
            "review revision differs.");
        require(Array.isArray(side.rows) && typedRefs(side.rows.map(row => row.id), "row"), "invalid canonical record membership.");
        for (const row of side.rows) {
            fields(row, ["id", "scenarioRef", "endpoint", "tool", "workload", "outcome", "status", "durationMs", "promptAuthor", "services", "missingService", "serviceNotApplicable"]);
            fields(row.endpoint, ["id"]);
            require(side.scenarioRefs.includes(row.scenarioRef) && ref(row.endpoint.id) && row.endpoint.id.startsWith("endpoint-") && OUTCOMES.includes(row.outcome)
                && [...WORKIQ_TOOLS, "owned-graph-http", "shell", "graph-mcp", "script-reference"].includes(row.tool)
                && OFFICE_WORKLOADS.includes(row.workload)
                && (row.status === null || Number.isInteger(row.status) && row.status >= 100 && row.status <= 599)
                && (row.durationMs === null || Number.isFinite(row.durationMs) && row.durationMs >= 0)
                && value.selection.promptAuthors.includes(row.promptAuthor)
                && Array.isArray(row.services) && new Set(row.services).size === row.services.length
                && row.services.every(id => serviceCategories.entries.some(service => service.id === id))
                && typeof row.missingService === "boolean" && typeof row.serviceNotApplicable === "boolean"
                && (!row.serviceNotApplicable || !row.missingService && !row.services.length)
                && value.selection.withinServices.every(id => row.services.includes(id)), "invalid canonical row.");
            if (value.selection.semanticMembership) require(value.selection.semanticMembership.scenarioRefs.includes(row.scenarioRef)
                || value.selection.semanticMembership.rowRefs.includes(row.id), "record outside frozen search membership.");
            if (value.selection.withinScenarioRefs !== undefined) require(value.selection.withinScenarioRefs.includes(row.scenarioRef), "record outside frozen interaction narrowing.");
        }
        require(same(distinct(side.rows.map(row => row.scenarioRef)), distinct(side.scenarioRefs))
            && same(side.totals, projection.summarize(side.rows)), "canonical totals differ.");
        fields(side.serviceSelection, ["knownMatchRefs", "contextOnlyRefs"]);
        require(refs(side.serviceSelection.knownMatchRefs) && refs(side.serviceSelection.contextOnlyRefs)
            && [...side.serviceSelection.knownMatchRefs, ...side.serviceSelection.contextOnlyRefs].every(ref => side.rows.some(row => row.id === ref))
            && !side.serviceSelection.knownMatchRefs.some(ref => side.serviceSelection.contextOnlyRefs.includes(ref)), "service selection differs.");
        const services = value.selection.filters.services ?? [];
        const known = row => projection.knownServiceMatch({ workload: row.workload, serviceAssociation: { services: row.services } }, services);
        require(same(side.serviceSelection.knownMatchRefs, services.length ? side.rows.filter(known).map(row => row.id) : [])
            && same(side.serviceSelection.contextOnlyRefs, services.length && value.selection.filters.includeMissingService === true
                ? side.rows.filter(row => !known(row) && row.missingService).map(row => row.id) : []), "service membership differs.");
        require(same(side.interactionCoverage, facts.metrics.map(metric => ({
            metricRef: metric.metricRef, slot: metricSlotKey(metric),
            eligibleUnitRefs: metric.eligibleUnitRefs, coveredUnitRefs: metric.coveredUnitRefs,
        }))), "per-check coverage differs.");
        if (side.apiCoverage !== null) {
            require(value.definitions.layer === "reported-api" && Array.isArray(side.apiCoverage.calls)
                && typedRefs(side.apiCoverage.calls.map(call => call.id), "row"), "invalid API parent membership.");
            for (const call of side.apiCoverage.calls) {
                fields(call, ["id", "scenarioId", "resultIds", "numericStatusIds"]);
                require(ref(call.scenarioId) && call.scenarioId.startsWith("scenario-") && typedRefs(call.resultIds, "row")
                    && typedRefs(call.numericStatusIds, "row") && call.numericStatusIds.every(ref => call.resultIds.includes(ref)), "invalid API parent evidence.");
                if (value.selection.semanticMembership) require(value.selection.semanticMembership.scenarioRefs.includes(call.scenarioId)
                    || value.selection.semanticMembership.parentScenarioRefs.includes(call.scenarioId), "API parent outside frozen search membership.");
                if (value.selection.withinScenarioRefs !== undefined) require(value.selection.withinScenarioRefs.includes(call.scenarioId), "API parent outside frozen interaction narrowing.");
            }
            require(same(side.apiCoverage, projection.apiCoverage(side.apiCoverage.calls, side.rows)), "API population differs.");
        }
    }
    require(same(value.periods.baseline.facts.basis, value.periods.later.facts.basis), "paired assessment bases differ.");
    require(same(value.comparison, periodReportComparison(value)), "frozen comparison values differ.");
    if (records) {
        const included = distinct(Object.values(value.periods).flatMap(side => side.scenarioRefs));
        require(same(distinct(records.map(record => record.scenarioId)), included)
            && records.every(record => !record.toolCalls.length && !record.graphActivities.length && !record.httpRecords.length), "copy records must not introduce analytical members.");
    }
    return value;
}
