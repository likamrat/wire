import * as contract from "./assessment-contract.mjs";
import { normalizeEndpoint } from "./analytics.mjs";
import { createWireMetricAdapter } from "./wire-report-metric-adapter.mjs";
import { createWireReportAdapter } from "./wire-report-snapshot-adapter.mjs";
import { normalizeMetricFact } from "./report-metric-comparison.mjs";

export function validateReportEndpoint(endpoint) {
    const normalized = normalizeEndpoint({
        path: endpoint.pathTemplate,
        query: endpoint.queryKeys.map(key => ({ key })),
    }, { method: endpoint.method, apiVersion: endpoint.apiVersion });
    return normalized.path === endpoint.pathTemplate
        && normalized.method === endpoint.method
        && normalized.apiVersion === endpoint.apiVersion
        && JSON.stringify(normalized.queryShape) === JSON.stringify([...endpoint.queryKeys].sort());
}

export function freezeEvaluationFacts(facts) {
    return contract.freezeReportFacts(facts, { validateEndpoint: validateReportEndpoint });
}

export function projectCurrentEvaluationFacts(facts) {
    const frozen = freezeEvaluationFacts(facts);
    const { assessmentAttempts, reviewStatuses, ...retained } = frozen;
    return freezeEvaluationFacts({
        ...retained, metricProjectionVersion: contract.METRIC_PROJECTION_VERSION,
        metrics: frozen.metrics.filter(metric => metric.dimension === "speed" && metric.origin === "automatic-local"
            && (metric.definitionId !== "interaction-latency" || metric.status === "measured")),
        assessments: [],
    });
}

export const adaptReportMetric = createWireMetricAdapter(contract);
export const adaptEvaluationReport = createWireReportAdapter(contract, { validateEndpoint: validateReportEndpoint });

export function evaluationMetricFacts(facts) {
    const frozen = freezeEvaluationFacts(facts);
    const dimensions = frozen.metricProjectionVersion === 4
        ? contract.CURRENT_DIMENSIONS : ["accuracy", "speed", "answer-trust", "action-trust"];
    return frozen.metrics.filter(metric => dimensions.includes(metric.dimension)).map(metric => normalizeMetricFact(adaptReportMetric(metric)));
}

export function evaluationGeneratedHashes(facts) {
    const frozen = freezeEvaluationFacts(facts);
    return frozen.patterns.map(entry => entry.pattern.key);
}
