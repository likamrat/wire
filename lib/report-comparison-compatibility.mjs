import { freezeEvaluationFacts, adaptReportMetric } from "./report-facts.mjs";
import { normalizeMetricFact } from "./report-metric-comparison.mjs";

const dimensions = new Set(["accuracy", "speed", "cost", "answer-trust", "action-trust"]);
const presentSide = metric => metric?.reason === "later-metric-not-saved" ? "baseline"
    : metric?.reason === "baseline-metric-not-saved" ? "later" : null;

function frozenMetrics(source, reference) {
    if (!source?.evaluationFacts || !reference || source.report?.bundleId !== reference.bundleId
        || source.report?.snapshotHash !== reference.snapshotHash) return null;
    try {
        const facts = freezeEvaluationFacts(source.evaluationFacts), metrics = new Map();
        for (const metric of facts.metrics) if (dimensions.has(metric.dimension)) {
            const adapted = adaptReportMetric(metric);
            metrics.set(adapted.comparisonKey, normalizeMetricFact(adapted));
        }
        return metrics;
    } catch (error) {
        if (error.name !== "ContractError" && !(error instanceof TypeError)) throw error;
        return null;
    }
}

// Restore display-only omissions from immutable source copies, never from live activity.
export function restoreOneSidedMetricDisplay(comparison, sourceFacts, storedComparisonHash) {
    if (comparison?.schemaVersion !== 1 || !Array.isArray(comparison.metrics)) return { comparison };
    const eligible = comparison.metrics.filter(metric => {
        const side = presentSide(metric);
        return side && metric.status === "unavailable" && metric.delta === null
            && typeof metric.comparisonKey === "string" && !Object.hasOwn(metric, side);
    });
    if (!eligible.length) return { comparison };
    if (typeof storedComparisonHash !== "string" || !/^[a-f0-9]{64}$/.test(storedComparisonHash)) {
        throw new TypeError("A stored comparison hash is required for a compatibility display.");
    }
    const sourceMaps = Array.isArray(sourceFacts) && sourceFacts.length === 2 ? {
        baseline: frozenMetrics(sourceFacts[0], comparison.baseline),
        later: frozenMetrics(sourceFacts[1], comparison.later),
    } : { baseline: null, later: null };
    const projected = structuredClone(comparison);
    let restored = 0;
    for (const metric of projected.metrics) {
        const side = presentSide(metric), missing = side === "baseline" ? "later" : "baseline";
        if (!side || metric.status !== "unavailable" || metric.delta !== null || Object.hasOwn(metric, side)
            || Object.hasOwn(metric, missing) && metric[missing] !== null) continue;
        const found = sourceMaps[side]?.get(metric.comparisonKey);
        if (!found || found.metric !== metric.metric || !sourceMaps[missing] || sourceMaps[missing].has(metric.comparisonKey)) continue;
        metric[side] = structuredClone(found);
        if (!Object.hasOwn(metric, missing)) metric[missing] = null;
        restored++;
    }
    const displayCompatibility = {
        version: 1,
        mode: "frozen-source-facts-only",
        restoredMetricCount: restored,
        unavailableMetricCount: eligible.length - restored,
        storedComparisonHash,
        savedFilesUnchanged: true,
        message: restored
            ? `${restored} metric ${restored === 1 ? "summary was" : "summaries were"} restored for this view from frozen source facts. Saved comparison files are unchanged.${eligible.length > restored ? " Some older summaries remain unavailable." : ""}`
            : "This older comparison lacks metric summaries that could not be restored from its frozen source facts. Saved comparison files are unchanged.",
    };
    projected.displayCompatibility = displayCompatibility;
    return { comparison: projected, displayCompatibility };
}
