import * as contract from "./assessment-contract.mjs";
import { compareMetricFacts } from "./report-metric-comparison.mjs";
import { compareToolOutcomeRows } from "./report-outcome-comparison.mjs";
import { createWireMetricAdapter } from "./wire-report-metric-adapter.mjs";

const adaptMetric = createWireMetricAdapter(contract);
const distinct = values => [...new Set(values)].sort();

export function nativePeriodSummary(rows, ranges) {
    const counts = selected => ({ count: selected.length,
        ...Object.fromEntries(["success", "failure", "unknown", "other"].map(outcome =>
            [outcome, selected.filter(row => row.outcome === outcome).length])) });
    return distinct(rows.map(row => JSON.stringify([row.sourceId, row.unit]))).map(key => {
        const [sourceId, unit] = JSON.parse(key), population = rows.filter(row => row.sourceId === sourceId && row.unit === unit);
        const side = range => counts(population.filter(row => row.startedAt !== null && row.startedAt >= range.from && row.startedAt < range.to));
        return { sourceId, unit, undated: population.filter(row => row.startedAt === null).length,
            baseline: side(ranges.baseline), later: side(ranges.later) };
    });
}

export function validateNativePeriods(value, ranges) {
    const shape = (object, keys) => object && Object.getPrototypeOf(object) === Object.prototype
        && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
    if (!shape(value, ["schemaVersion", "rows", "summary", ...(value?.schemaVersion === 2 ? ["refinement"] : [])])
        || ![1, 2].includes(value.schemaVersion) || !Array.isArray(value.rows)
        || new Set(value.rows.map(row => row?.id)).size !== value.rows.length || value.rows.some(row =>
            !shape(row, ["id", "scenarioId", "sourceId", "unit", "startedAt", "outcome"])
            || !/^row-[a-f0-9]{16}$/.test(row.id) || !/^scenario-[a-f0-9]{16}$/.test(row.scenarioId)
            || !["microsoft-365-chat", "microsoft-365-cowork"].includes(row.sourceId)
            || !["native-tool-call", "native-returned-result-observation", "message-representation-observation"].includes(row.unit)
            || !["success", "failure", "unknown", "other"].includes(row.outcome)
            || row.startedAt !== null && (!Number.isFinite(Date.parse(row.startedAt)) || new Date(row.startedAt).toISOString() !== row.startedAt))
        || JSON.stringify(value.summary) !== JSON.stringify(nativePeriodSummary(value.rows, ranges))) {
        throw new TypeError("Microsoft period populations do not match their dated rows.");
    }
    if (value.schemaVersion === 2 && (!shape(value.refinement, ["datePolicy", "predicateRef", "contextConversationRefs", "messageDateMembership"])
        || value.refinement.datePolicy !== "replace-original-dates" || !/^native-predicate-[a-f0-9]{16}$/.test(value.refinement.predicateRef)
        || value.refinement.messageDateMembership !== "context-only-not-qualified"
        || !Array.isArray(value.refinement.contextConversationRefs)
        || new Set(value.refinement.contextConversationRefs).size !== value.refinement.contextConversationRefs.length
        || value.refinement.contextConversationRefs.some(ref => !/^scenario-[a-f0-9]{16}$/.test(ref))
        || value.rows.some(row => row.unit === "message-representation-observation"))) {
        throw new TypeError("Refined native periods require their original predicate and explicit contextual message boundary.");
    }
    return value;
}

function metricComparisons(baseline, later) {
    const facts = metrics => new Map(metrics.filter(metric => ["accuracy", "answer-trust", "action-trust", "speed", "cost"].includes(metric.dimension))
        .map(metric => [contract.metricSlotKey(metric), adaptMetric(metric)]));
    const a = facts(baseline), b = facts(later);
    return distinct([...a.keys(), ...b.keys()]).map(key => ({
        key, baseline: a.get(key) ?? null, later: b.get(key) ?? null,
        status: a.has(key) && b.has(key) ? "paired" : "one-sided",
        result: a.has(key) && b.has(key) ? compareMetricFacts(a.get(key), b.get(key)) : null,
    }));
}

function matchingTiming(analytics) {
    const definition = analytics.layer === "tool" ? contract.DEFINITIONS["tool-duration"] : null;
    if (!definition) return null;
    const duration = analytics.totals.duration;
    const fact = aggregation => ({
        metric: "speed", kind: "duration", definitionId: "tool-duration", definitionVersion: definition.version,
        unit: "ms", basis: "observed", aggregation, boundary: definition.boundary,
        state: duration.sampleCount ? "available" : "unavailable",
        coverage: { count: duration.sampleCount, eligible: analytics.rows.length },
        ...(duration.sampleCount ? { value: aggregation === "median" ? duration.p50Ms : duration.p95Ms } : { reason: "missing-evidence" }),
    });
    return { median: fact("median"), p95: fact("p95") };
}

// Both producer and consumer use this derivation over validated cohorts/metrics.
export function comparePeriodCohorts(baseline, later) {
    // Do not adopt the outcome helper's tool-specific narrative or fixed-mix estimates.
    const outcomeRows = side => side.analytics.rows.map(row => ({ id: row.id, patternId: row.endpoint.id, outcome: row.outcome }));
    const outcomes = compareToolOutcomeRows(outcomeRows(baseline), outcomeRows(later), { identityRelation: "same-namespace" });
    const aTiming = matchingTiming(baseline.analytics), bTiming = matchingTiming(later.analytics);
    return {
        outcomes: { ...outcomes.raw, overlap: outcomes.overlap, unit: baseline.analytics.unit, deltaUnit: "percentage-points" },
        matchingCallTiming: aTiming && bTiming ? { median: compareMetricFacts(aTiming.median, bTiming.median), p95: compareMetricFacts(aTiming.p95, bTiming.p95) } : null,
        metrics: metricComparisons(baseline.assessment.metrics, later.assessment.metrics),
    };
}
