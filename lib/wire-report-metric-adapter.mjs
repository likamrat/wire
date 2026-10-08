// The injected contract remains backend-owned. This adapter only prepares report comparison facts.
export function createWireMetricAdapter(contract) {
    if (!contract || typeof contract.validateMetric !== "function" || typeof contract.metricSlotKey !== "function" || !contract.DEFINITIONS) {
        throw new TypeError("The backend metric validator and definitions are required.");
    }
    return function adaptMetric(metric) {
        contract.validateMetric(metric);
        if (!["accuracy", "speed", "cost", "answer-trust", "action-trust"].includes(metric.dimension)) {
            throw new TypeError("Execution and evidence-availability checks are not accuracy or trust dimensions.");
        }
        const definition = contract.DEFINITIONS[metric.definitionId];
        const available = ["measured", "estimated"].includes(metric.status);
        const kind = definition.form === "counts" ? "pass-rate" : definition.form === "cost" ? "cost" : "duration";
        const basis = kind === "pass-rate" ? metric.origin === "user-personal" ? "user-assessment"
            : metric.origin === "model-assessed" ? "model-assessment" : "automatic-assessment"
            : kind === "cost" ? available ? metric.status === "estimated" ? "estimated" : "observed" : "not-established"
                : "observed";
        const qualifiers = {
            checkId: metric.checkId,
            checkVersion: metric.checkVersion,
            measurementBasis: metric.measurementBasis,
        };
        if (metric.pricing) Object.assign(qualifiers, {
            pricingMethod: metric.pricing.method,
            pricingRef: metric.pricing.reference,
            pricingVersion: metric.pricing.version,
        });
        if (metric.evaluator) Object.assign(qualifiers, {
            evaluatorProvider: metric.evaluator.provider, evaluatorModel: metric.evaluator.model,
            rubricId: metric.evaluator.rubricId, rubricVersion: metric.evaluator.rubricVersion,
        });
        return {
            metric: metric.dimension,
            comparisonKey: contract.metricSlotKey(metric),
            kind,
            definitionId: metric.definitionId,
            definitionVersion: metric.definitionVersion,
            unit: kind === "pass-rate" ? "percent" : metric.unit,
            basis,
            aggregation: kind === "pass-rate" ? "pass-rate" : kind === "cost" ? "total" : "median",
            boundary: metric.boundary,
            state: available ? "available" : "unavailable",
            coverage: { count: metric.coverage.covered, eligible: metric.coverage.eligible },
            counts: metric.counts ? { ...metric.counts } : null,
            qualifiers,
            ...(available && kind === "pass-rate" ? { numerator: metric.numerator, denominator: metric.denominator }
                : available ? { value: metric.value } : { reason: metric.reason }),
        };
    };
}
