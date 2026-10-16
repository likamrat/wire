import { compareToolOutcomeRows, describeToolOutcomeComparison } from "./report-outcome-comparison.mjs";
import { compareMetricFacts, normalizeMetricFact } from "./report-metric-comparison.mjs";

// The report adapter supplies a normalized, reviewed envelope.
const METRIC_KEYS = Object.freeze(["accuracy", "speed", "cost", "answer-trust", "action-trust"]);
const CURRENT_METRIC_KEYS = Object.freeze(["accuracy", "speed", "answer-trust", "action-trust"]);
const EVIDENCE_LAYERS = Object.freeze({
    "returned-api-entry": { unit: "returned API entries", note: "Entries may share a parent tool call. Returned metadata is not independently observed HTTP or independent trials." },
    "owned-http": { unit: "owned HTTP records", note: "Recorded responses and explicit no-response attempts remain distinct. HTTP success does not establish task completion." },
    "graph-request-site": { unit: "recorded Graph request sites", note: "Request sites are not measured wire-execution counts. Visible statuses are recorded evidence only." },
});
const EVIDENCE_PRESENTATION = Object.freeze({
    "tool-call": { heading: "Recorded tool results", scoreLabel: "Recorded tool success", unitLabel: "calls", successVerb: "succeeded", note: "Tool execution is separate from answer accuracy and trust." },
    "owned-http": { heading: "Owned HTTP records", scoreLabel: "Recorded 2xx share", unitLabel: "HTTP records", successVerb: "show 2xx", note: "Observed responses and no-response attempts are separate outcomes; response success is not task completion." },
    "graph-request-site": { heading: "Recorded Graph request sites", scoreLabel: "2xx status recorded", unitLabel: "request sites", successVerb: "have a recorded 2xx status", note: "Request sites are not measured wire executions. Missing output status remains unknown." },
    "returned-api-entry": { heading: "Tool-returned API results", scoreLabel: "Recorded 2xx share", unitLabel: "API entries", successVerb: "report 2xx", note: "Multiple entries may belong to one call. These are returned metadata, not independent HTTP trials." },
});
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validateEnvelope(value) {
    if (!plain(value) || !nonempty(value.bundleId) || !digest(value.snapshotHash)) {
        throw new TypeError("A comparison requires the selected frozen report identity and hash.");
    }
    if (value.disclosureReviewed !== true) throw new TypeError("Only disclosure-reviewed report snapshots can be compared.");
    if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new TypeError("Report facts require a schema version.");
    if (value.schemaVersion !== 1) return;
    if (!(plain(value.metrics) || Array.isArray(value.metrics)) || !Array.isArray(value.toolRows)) throw new TypeError("Report facts require metric and tool-call collections.");
    for (const [key, metric] of Array.isArray(value.metrics) ? value.metrics.map(metric => [metric?.metric, metric]) : Object.entries(value.metrics)) {
        if (!METRIC_KEYS.includes(key) || !plain(metric) || metric.metric !== key) {
            throw new TypeError("Report metric keys and dimension identities must match.");
        }
    }
    if (!Number.isSafeInteger(value.patternVersion) || value.patternVersion < 1) throw new TypeError("Tool patterns require a definition version.");
    if (!plain(value.scope)) throw new TypeError("Report facts require explicit scope metadata.");
}

const reference = value => ({ bundleId: value.bundleId, snapshotHash: value.snapshotHash });

function patternDisplays(baseline, later) {
    const entries = new Map(), signatures = new Map();
    for (const entry of [...baseline.patterns ?? [], ...later.patterns ?? []]) {
        if (!plain(entry) || !nonempty(entry.patternId) || !Array.isArray(entry.endpoints)) throw new TypeError("Pattern display metadata is invalid.");
        const display = {
            patternId: entry.patternId, unitKind: entry.unitKind, tool: entry.tool, workload: entry.workload,
            attribution: entry.attribution, targetShape: entry.targetShape,
            endpoints: structuredClone(entry.endpoints), available: entry.available,
        };
        const signature = JSON.stringify({
            ...display,
            endpoints: display.endpoints.map(endpoint => ({
                pathTemplate: endpoint.pathTemplate, method: endpoint.method, apiVersion: endpoint.apiVersion,
                queryKeys: [...endpoint.queryKeys].sort(),
            })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        });
        if (signatures.has(entry.patternId) && signatures.get(entry.patternId) !== signature) {
            throw new TypeError("The same frozen pattern identity has conflicting display metadata.");
        }
        signatures.set(entry.patternId, signature);
        entries.set(entry.patternId, display);
    }
    return [...entries.values()].sort((a, b) => a.patternId.localeCompare(b.patternId));
}

function metricMap(value, projectionVersion) {
    const result = new Map();
    const metrics = Array.isArray(value.metrics) ? value.metrics : Object.values(value.metrics);
    for (const metric of metrics) {
        compareMetricFacts(metric, metric);
        if (projectionVersion >= 3 && !(projectionVersion === 3 && metric.basis === "user-assessment"
            || metric.metric === "speed" && metric.basis === "observed"
                && (projectionVersion === 3 || metric.boundary !== "verified-request-to-final-answer" || metric.state === "available"))) continue;
        if (!CURRENT_METRIC_KEYS.includes(metric.metric)) continue;
        const key = metric.comparisonKey ?? JSON.stringify([metric.metric, metric.definitionId, metric.qualifiers?.checkId ?? null, metric.basis]);
        if (!nonempty(key)) throw new TypeError("Metric comparison keys must be nonempty.");
        if (result.has(key)) throw new TypeError("Duplicate active metric comparison identity; pool disjoint metric facts before comparing.");
        result.set(key, metric);
    }
    return result;
}

function compareEvidenceLayers(baseline, later, toolComparison, options) {
    const result = { "tool-call": toolComparison };
    for (const [kind, description] of Object.entries(EVIDENCE_LAYERS)) {
        const a = baseline.outcomeLayers?.[kind], b = later.outcomeLayers?.[kind];
        if (a === undefined || b === undefined) {
            result[kind] = { status: "unavailable", reason: "layer-not-saved", unit: description.unit, note: description.note };
            continue;
        }
        const comparison = compareToolOutcomeRows(a, b, options);
        result[kind] = {
            ...comparison, metric: `recorded-${kind}-outcomes`, unitKind: kind,
            unit: description.unit, note: description.note,
        };
    }
    function count(value) {
        if (value === undefined) return null;
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Code-reference inventory must be a nonnegative count.");
        return value;
    }
    result["graph-code-reference"] = {
        status: "not-scored",
        baselineCount: count(baseline.layerCounts?.["graph-code-reference"]),
        laterCount: count(later.layerCounts?.["graph-code-reference"]),
        note: "Code references are not evidence of execution and have no execution outcome score.",
    };
    return result;
}

function scopeDifferences(baseline, later) {
    const differences = [];
    const known = key => baseline.scope[key] !== undefined && baseline.scope[key] !== null
        && later.scope[key] !== undefined && later.scope[key] !== null;
    for (const [key, code] of [
        ["selectionKind", "selection-kind-differs"],
        ["timeZone", "selected-timezone-differs"],
        ["collectionDefinition", "collection-definition-differs"],
    ]) {
        if (!known(key)) differences.push(`${key}-not-recorded`);
        else if (baseline.scope[key] !== later.scope[key]) differences.push(code);
    }
    if (baseline.scope.callTimesAvailable !== true || later.scope.callTimesAvailable !== true) {
        differences.push("per-call-time-windows-unverified");
    }
    if (baseline.scope.historyComplete !== true || later.scope.historyComplete !== true) {
        differences.push("complete-history-not-established");
    }
    return differences;
}

export function compareFrozenReportFacts(baseline, later, options = {}) {
    const projectionVersion = options.metricProjectionVersion ?? 2;
    if (![2, 3, 4].includes(projectionVersion)) throw new TypeError("Unsupported comparison metric projection.");
    validateEnvelope(baseline);
    validateEnvelope(later);
    if (baseline.bundleId === later.bundleId && baseline.snapshotHash !== later.snapshotHash) {
        throw new TypeError("The same frozen report identity has conflicting snapshot hashes.");
    }
    const result = {
        schemaVersion: 1,
        metricProjectionVersion: projectionVersion,
        baseline: reference(baseline),
        later: reference(later),
        status: "unavailable",
        reason: null,
        metrics: [],
        toolComparison: null,
        layerComparisons: {},
        patternDisplays: [],
        scopeDifferences: [],
        narrative: null,
    };
    if (baseline.snapshotHash === later.snapshotHash) return { ...result, reason: "same-snapshot" };
    if (baseline.schemaVersion !== 1 || later.schemaVersion !== 1) return { ...result, reason: "unsupported-facts-version" };
    result.patternDisplays = patternDisplays(baseline, later);
    result.scopeDifferences = scopeDifferences(baseline, later);
    const aMetrics = metricMap(baseline, projectionVersion), bMetrics = metricMap(later, projectionVersion);
    const keys = [...new Set([...aMetrics.keys(), ...bMetrics.keys()])].sort();
    result.metrics = keys.map(comparisonKey => {
        const a = aMetrics.get(comparisonKey), b = bMetrics.get(comparisonKey);
        if (!a || !b) return {
            metric: (a ?? b).metric,
            comparisonKey,
            status: "unavailable",
            reason: !a ? "baseline-metric-not-saved" : "later-metric-not-saved",
            baseline: a ? normalizeMetricFact(a) : null,
            later: b ? normalizeMetricFact(b) : null,
            delta: null,
        };
        return { ...compareMetricFacts(a, b), comparisonKey };
    });
    for (const metric of projectionVersion >= 3 ? [] : CURRENT_METRIC_KEYS) {
        if (!result.metrics.some(item => item.metric === metric)) result.metrics.push({ metric, comparisonKey: null, status: "unavailable", reason: "metric-not-saved", delta: null });
    }
    result.metrics.sort((a, b) => CURRENT_METRIC_KEYS.indexOf(a.metric) - CURRENT_METRIC_KEYS.indexOf(b.metric) || (a.comparisonKey ?? "").localeCompare(b.comparisonKey ?? ""));
    if (baseline.patternVersion !== later.patternVersion) {
        result.reason = "pattern-definition-changed";
        result.narrative = {
            heading: "These reports use different technical-pattern definitions.",
            detail: "Matching pattern deltas are unavailable. Category regrouping is not a workflow improvement; independently compatible metric values remain visible.",
            tone: "neutral",
        };
        return result;
    }
    const { metricProjectionVersion, ...outcomeOptions } = options;
    result.toolComparison = compareToolOutcomeRows(baseline.toolRows, later.toolRows, outcomeOptions);
    result.layerComparisons = compareEvidenceLayers(baseline, later, result.toolComparison, outcomeOptions);
    const kinds = Object.keys(EVIDENCE_PRESENTATION);
    result.primaryLayer = kinds.find(kind => result.layerComparisons[kind]?.status === "ready" && result.layerComparisons[kind]?.matched?.patternCount)
        ?? kinds.find(kind => result.layerComparisons[kind]?.raw && (result.layerComparisons[kind].raw.baseline.count || result.layerComparisons[kind].raw.later.count))
        ?? "tool-call";
    result.primaryEvidence = { ...EVIDENCE_PRESENTATION[result.primaryLayer] };
    const scopeChanged = result.scopeDifferences.some(code => ["selection-kind-differs", "collection-definition-differs"].includes(code));
    result.narrative = scopeChanged ? {
        heading: "These reports cover differently selected activity.",
        detail: "Read the metric values and matching rows with their scope differences; an overall improvement verdict is withheld.",
        tone: "neutral",
    } : describeToolOutcomeComparison(result.toolComparison);
    if (!scopeChanged && result.primaryLayer !== "tool-call") {
        const primary = result.layerComparisons[result.primaryLayer], info = result.primaryEvidence;
        result.narrative = {
            heading: primary.matched?.mixChanged ? `${info.heading}: the pattern mix changed.` : `${info.heading}: compare the recorded outcomes.`,
            detail: `${primary.raw.baseline.success} of ${primary.raw.baseline.count} ${info.unitLabel} ${info.successVerb} earlier; ${primary.raw.later.success} of ${primary.raw.later.count} later. ${info.note}`,
            tone: "neutral",
        };
    }
    result.status = "ready";
    return result;
}
