// Adapters supply reviewed, versioned metric facts.
const METRICS = Object.freeze({
    accuracy: "pass-rate",
    "answer-trust": "pass-rate",
    "action-trust": "pass-rate",
    speed: "duration",
    cost: "cost",
});
const BASES = new Set(["observed", "estimated", "automatic-assessment", "user-assessment", "model-assessment", "mixed-assessment", "not-established"]);
const QUALIFIERS = new Set(["checkId", "checkVersion", "measurementBasis", "pricingMethod", "pricingRef", "pricingVersion", "evaluatorProvider", "evaluatorModel", "rubricId", "rubricVersion"]);
const AGGREGATIONS = Object.freeze({
    "pass-rate": new Set(["pass-rate"]),
    duration: new Set(["median", "p95", "mean"]),
    cost: new Set(["total", "mean-per-interaction"]),
});
const COMPATIBILITY_FIELDS = Object.freeze([
    "metric", "kind", "definitionId", "definitionVersion", "unit", "basis", "aggregation", "boundary",
]);
const text = value => typeof value === "string" && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const absent = value => value === undefined || value === null;

function normalizeQualifiers(value = {}) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Metric qualifiers must be a plain object.");
    const pairs = Object.entries(value).filter(([, item]) => !absent(item)).sort(([a], [b]) => a.localeCompare(b));
    if (pairs.some(([key, item]) => !QUALIFIERS.has(key) || !(text(item) || count(item)))) {
        throw new TypeError("Metric qualifiers require recognized definition or pricing fields.");
    }
    return Object.fromEntries(pairs);
}

export function normalizeMetricFact(fact) {
    if (!fact || Object.getPrototypeOf(fact) !== Object.prototype) throw new TypeError("Metric facts must be a plain object.");
    if (!Object.hasOwn(METRICS, fact.metric) || METRICS[fact.metric] !== fact.kind) throw new TypeError("Unsupported metric or metric kind.");
    if (!text(fact.definitionId) || !Number.isSafeInteger(fact.definitionVersion) || fact.definitionVersion < 1) {
        throw new TypeError("Metric facts require a versioned definition.");
    }
    if (!BASES.has(fact.basis) || !AGGREGATIONS[fact.kind].has(fact.aggregation) || !text(fact.boundary)) {
        throw new TypeError("Metric facts require a supported basis, aggregation, and measurement boundary.");
    }
    if (fact.kind === "pass-rate" ? fact.unit !== "percent"
        : fact.kind === "duration" ? fact.unit !== "ms"
            : typeof fact.unit !== "string" || !/^[A-Z]{3}$/.test(fact.unit)) {
        throw new TypeError("Metric facts require a supported measurement unit.");
    }
    const coverage = fact.coverage;
    if (!coverage || !count(coverage.count) || !count(coverage.eligible) || coverage.count > coverage.eligible) {
        throw new TypeError("Metric coverage requires consistent nonnegative counts.");
    }
    const result = {
        ...Object.fromEntries(COMPATIBILITY_FIELDS.map(key => [key, fact[key]])),
        state: fact.state,
        coverage: { count: coverage.count, eligible: coverage.eligible, missing: coverage.eligible - coverage.count },
        value: null,
        numerator: null,
        denominator: null,
        reason: null,
        counts: null,
        qualifiers: normalizeQualifiers(fact.qualifiers),
    };
    if (fact.counts !== undefined && fact.counts !== null) {
        const names = ["pass", "fail", "unassessed", "evaluatorError"];
        if (!fact.counts || Object.getPrototypeOf(fact.counts) !== Object.prototype
            || Object.keys(fact.counts).length !== names.length || names.some(key => !count(fact.counts[key]))
            || names.reduce((sum, key) => sum + fact.counts[key], 0) !== coverage.eligible
            || fact.counts.pass + fact.counts.fail !== coverage.count) {
            throw new TypeError("Assessment counts do not match metric coverage.");
        }
        result.counts = Object.fromEntries(names.map(key => [key, fact.counts[key]]));
    }
    if (fact.state === "unavailable") {
        if (!text(fact.reason)) throw new TypeError("An unavailable metric requires a reason.");
        if (!absent(fact.value) || !absent(fact.numerator) || !absent(fact.denominator)) {
            throw new TypeError("An unavailable metric cannot carry a hidden value or scored denominator.");
        }
        result.reason = fact.reason;
        return result;
    }
    if (fact.state !== "available" || coverage.count === 0 || fact.basis === "not-established") throw new TypeError("An available metric requires recorded samples and an established basis.");
    if (fact.kind === "pass-rate") {
        if (!count(fact.numerator) || !count(fact.denominator) || fact.denominator !== coverage.count
            || fact.numerator > fact.denominator || !absent(fact.value)) {
            throw new TypeError("A pass rate requires exact assessed counts; an independently supplied value is not accepted.");
        }
        result.numerator = fact.numerator;
        result.denominator = fact.denominator;
        result.value = fact.numerator * 100 / fact.denominator;
        if (result.counts && result.counts.pass !== fact.numerator) throw new TypeError("Assessment pass count differs from its numerator.");
    } else {
        if (!Number.isFinite(fact.value) || fact.value < 0 || !absent(fact.numerator) || !absent(fact.denominator)) {
            throw new TypeError("A duration or cost metric requires a finite nonnegative value.");
        }
        result.value = fact.value;
    }
    return result;
}

export function compareMetricFacts(baselineFact, laterFact) {
    const baseline = normalizeMetricFact(baselineFact), later = normalizeMetricFact(laterFact);
    const mismatches = COMPATIBILITY_FIELDS.filter(key => baseline[key] !== later[key]);
    if (JSON.stringify(baseline.qualifiers) !== JSON.stringify(later.qualifiers)) mismatches.push("qualifiers");
    const warnings = [];
    if (baseline.coverage.missing || later.coverage.missing) warnings.push("partial-coverage");
    const aCoverage = baseline.coverage.eligible ? baseline.coverage.count / baseline.coverage.eligible : null;
    const bCoverage = later.coverage.eligible ? later.coverage.count / later.coverage.eligible : null;
    if (aCoverage !== null && bCoverage !== null && bCoverage < aCoverage) warnings.push("coverage-decreased");
    if (baseline.kind === "cost" && later.kind === "cost" && baseline.aggregation === "total" && later.aggregation === "total"
        && baseline.coverage.eligible !== later.coverage.eligible) warnings.push("total-cost-volume-differs");
    const status = baseline.state !== "available" || later.state !== "available" ? "unavailable"
        : mismatches.length ? "incompatible" : "comparable";
    const value = status === "comparable" ? later.value - baseline.value : null;
    return {
        schemaVersion: 1,
        status,
        metric: baseline.metric === later.metric ? baseline.metric : null,
        boundary: baseline.boundary === later.boundary ? baseline.boundary : null,
        interpretation: status === "comparable" ? baseline.kind === "pass-rate" ? "higher-is-better"
            : baseline.kind === "cost" && baseline.aggregation === "total" ? "total-cost-only" : "lower-is-better" : null,
        baseline,
        later,
        mismatches,
        delta: status === "comparable" ? {
            value,
            unit: baseline.kind === "pass-rate" ? "percentage-points" : baseline.unit,
            direction: value === 0 ? "unchanged" : value < 0 ? "down" : "up",
        } : null,
        warnings,
    };
}
