// Inputs are already scoped outcome facts, not raw report content.
const OUTCOMES = Object.freeze(["success", "failure", "unknown", "partial", "other", "transport"]);
const COHORTS = new Set(["snapshots", "non-overlapping", "later-additions"]);
const IDENTITY_RELATIONS = new Set(["unknown", "same-namespace"]);
const text = value => typeof value === "string" && value.trim().length > 0;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const emptyOutcomes = () => Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
const rate = (numerator, denominator) => ({ numerator, denominator, percent: denominator ? numerator * 100 / denominator : null });
const percentagePointChanges = (baseline, later) =>
    Object.fromEntries(OUTCOMES.map(outcome => [outcome,
        baseline.count && later.count ? (later[outcome] / later.count - baseline[outcome] / baseline.count) * 100 : null,
    ]));

function uniqueRows(rows) {
    if (!Array.isArray(rows)) throw new TypeError("Tool outcome rows must be an array.");
    const byId = new Map();
    let duplicates = 0;
    for (const row of rows) {
        if (!row || !text(row.id)) throw new TypeError("A tool outcome row requires an explicit identity.");
        if (!text(row.patternId)) throw new TypeError("A tool outcome row requires a normalized pattern identity.");
        if (!OUTCOMES.includes(row.outcome)) throw new TypeError("A tool outcome row requires a supported recorded outcome.");
        const previous = byId.get(row.id);
        if (previous) {
            if (previous.outcome !== row.outcome || previous.patternId !== row.patternId) {
                throw new TypeError("Conflicting tool records share an identity.");
            }
            duplicates++;
        } else {
            byId.set(row.id, { id: row.id, patternId: row.patternId, outcome: row.outcome });
        }
    }
    return { rows: [...byId.values()], byId, duplicates };
}

function summarize(rows) {
    const outcomes = emptyOutcomes();
    for (const row of rows) outcomes[row.outcome]++;
    return {
        count: rows.length,
        ...outcomes,
        successRate: rate(outcomes.success, rows.length),
        failureRate: rate(outcomes.failure, rows.length),
        binaryOutcomeCoverage: rate(outcomes.success + outcomes.failure, rows.length),
    };
}

function partition(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.patternId)) groups.set(row.patternId, []);
        groups.get(row.patternId).push(row);
    }
    return groups;
}

function fixedMix(patterns, baselineCount) {
    if (!patterns.length || !baselineCount) return null;
    const baseline = emptyOutcomes(), later = emptyOutcomes();
    const weights = [];
    for (const pattern of patterns) {
        const weight = pattern.baseline.count / baselineCount;
        weights.push({ patternId: pattern.patternId, numerator: pattern.baseline.count, denominator: baselineCount });
        for (const outcome of OUTCOMES) {
            baseline[outcome] += weight * pattern.baseline[outcome] * 100 / pattern.baseline.count;
            later[outcome] += weight * pattern.later[outcome] * 100 / pattern.later.count;
        }
    }
    return {
        basis: "baseline-call-share-within-matched-patterns",
        unit: "percent",
        weights,
        baseline,
        later,
        change: Object.fromEntries(OUTCOMES.map(outcome => [outcome, later[outcome] - baseline[outcome]])),
    };
}

/**
 * Identity relation must be established by the caller, never inferred from matching strings.
 * This pure comparison does not validate snapshot privacy, schema compatibility, scope,
 * time windows or collection coverage. The report boundary must check those separately.
 */
export function compareToolOutcomeRows(baselineRows, laterRows, options = {}) {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw new TypeError("Comparison options must be a plain object.");
    const { identityRelation = "unknown", cohort = "snapshots" } = options;
    if (!IDENTITY_RELATIONS.has(identityRelation)) throw new TypeError("Unsupported identityRelation.");
    if (!COHORTS.has(cohort)) throw new TypeError("Unsupported comparison cohort.");
    const baselineInput = uniqueRows(baselineRows), laterInput = uniqueRows(laterRows);
    const baseline = baselineInput.rows, later = laterInput.rows;
    const rawBaseline = summarize(baseline), rawLater = summarize(later);
    const warnings = new Set();
    if (baselineInput.duplicates || laterInput.duplicates) warnings.add("duplicate-records");

    const verified = identityRelation === "same-namespace";
    const sharedIds = new Set(verified ? baseline.filter(row => laterInput.byId.has(row.id)).map(row => row.id) : []);
    let changedCount = 0;
    for (const id of sharedIds) {
        const a = baselineInput.byId.get(id), b = laterInput.byId.get(id);
        if (a.outcome !== b.outcome || a.patternId !== b.patternId) changedCount++;
    }
    if (!verified) warnings.add("overlap-unverified");
    if (sharedIds.size) warnings.add("shared-records");
    if (changedCount) warnings.add("shared-outcomes-updated");

    const result = {
        schemaVersion: 1,
        metric: "recorded-tool-outcomes",
        unit: "unique-tool-calls",
        cohort,
        status: "unavailable",
        reason: null,
        raw: {
            baseline: rawBaseline,
            later: rawLater,
            change: percentagePointChanges(rawBaseline, rawLater),
        },
        duplicates: { baseline: baselineInput.duplicates, later: laterInput.duplicates },
        overlap: { verified, sharedCount: verified ? sharedIds.size : null, changedCount: verified ? changedCount : null },
        selected: null,
        matched: null,
        patterns: [],
        canDescribeRecordedChange: false,
        warnings: [],
    };
    if (cohort !== "snapshots" && !verified) {
        return { ...result, reason: "overlap-unverified", warnings: [...warnings] };
    }

    const selectedBaseline = cohort === "non-overlapping" ? baseline.filter(row => !sharedIds.has(row.id)) : baseline;
    const selectedLater = cohort === "snapshots" ? later : later.filter(row => !sharedIds.has(row.id));
    if (cohort === "non-overlapping" && sharedIds.size) warnings.add("excluded-shared-records");
    if (cohort === "later-additions") warnings.add("new-membership-not-execution-time");
    result.selected = { baseline: summarize(selectedBaseline), later: summarize(selectedLater) };

    const baselineGroups = partition(selectedBaseline), laterGroups = partition(selectedLater);
    const patternIds = [...new Set([...baselineGroups.keys(), ...laterGroups.keys()])].sort(order);
    result.patterns = patternIds.map(patternId => {
        const a = summarize(baselineGroups.get(patternId) ?? []), b = summarize(laterGroups.get(patternId) ?? []);
        return {
            patternId,
            presence: a.count && b.count ? "matched" : a.count ? "baseline-only" : "later-only",
            baseline: a,
            later: b,
            change: percentagePointChanges(a, b),
        };
    });

    const matchedPatterns = result.patterns.filter(pattern => pattern.presence === "matched");
    const matchedIds = new Set(matchedPatterns.map(pattern => pattern.patternId));
    const matchedBaseline = summarize(selectedBaseline.filter(row => matchedIds.has(row.patternId)));
    const matchedLater = summarize(selectedLater.filter(row => matchedIds.has(row.patternId)));
    const mixChanged = matchedPatterns.some(pattern =>
        pattern.baseline.count / matchedBaseline.count !== pattern.later.count / matchedLater.count);
    result.matched = {
        patternCount: matchedPatterns.length,
        baseline: matchedBaseline,
        later: matchedLater,
        change: percentagePointChanges(matchedBaseline, matchedLater),
        baselineCoverage: rate(matchedBaseline.count, rawBaseline.count),
        laterCoverage: rate(matchedLater.count, rawLater.count),
        mixChanged,
        fixedBaselineMix: fixedMix(matchedPatterns, matchedBaseline.count),
    };
    if (result.patterns.length > matchedPatterns.length) warnings.add("unmatched-patterns");
    if (mixChanged) warnings.add("traffic-mix-changed");
    if (result.matched.change.unknown > 0) warnings.add("unknown-share-increased");
    if (result.matched.change.partial > 0) warnings.add("partial-share-increased");
    const aCoverage = matchedBaseline.binaryOutcomeCoverage.percent, bCoverage = matchedLater.binaryOutcomeCoverage.percent;
    if (aCoverage !== null && bCoverage !== null && bCoverage < aCoverage) warnings.add("binary-outcome-coverage-decreased");
    if (aCoverage === 0 || bCoverage === 0) warnings.add("no-binary-outcomes");

    result.reason = !selectedBaseline.length ? "empty-baseline"
        : !selectedLater.length ? "empty-later"
            : !matchedPatterns.length ? "no-matched-patterns" : null;
    result.status = result.reason ? "unavailable" : "ready";
    result.canDescribeRecordedChange = result.status === "ready"
        && verified
        && (cohort === "non-overlapping" || cohort === "snapshots" && sharedIds.size === 0)
        && aCoverage > 0 && bCoverage > 0
        && !warnings.has("binary-outcome-coverage-decreased")
        && !warnings.has("unknown-share-increased")
        && !warnings.has("partial-share-increased");
    result.warnings = [...warnings];
    return result;
}

export function describeToolOutcomeComparison(result) {
    if (!result || result.schemaVersion !== 1 || result.metric !== "recorded-tool-outcomes") {
        throw new TypeError("Narrative requires the recorded tool comparison result.");
    }
    const narrative = (heading, detail, tone = "neutral") => ({ heading, detail, tone });
    if (result.reason === "no-matched-patterns") {
        return narrative("These reports have no matching technical patterns.", "The report totals describe different activity; a matched-pattern change is unavailable.");
    }
    if (["empty-baseline", "empty-later"].includes(result.reason)) {
        return narrative("Not enough recorded calls to compare.", result.reason === "empty-baseline"
            ? "The selected earlier cohort has no calls." : "The selected later cohort has no calls.");
    }
    if (!result.overlap.verified) {
        return narrative("The reports can be read side by side.", "Overlap is unverified, so the difference cannot be described as new activity.");
    }
    if (result.cohort === "snapshots" && result.overlap.sharedCount) {
        return narrative("These snapshots include repeated calls.", `${result.overlap.sharedCount} ${result.overlap.sharedCount === 1 ? "call appears" : "calls appear"} in both reports; ${result.overlap.changedCount} ${result.overlap.changedCount === 1 ? "has" : "have"} changed recorded outcomes or pattern assignments.`);
    }
    const matched = result.matched;
    if (!matched) throw new TypeError("Narrative requires matched comparison facts.");
    const { baseline, later } = matched;
    if (result.warnings.includes("no-binary-outcomes")) {
        return narrative("A recorded success-or-failure comparison is unavailable.", "At least one matched set contains only unknown, partial, other, or transport outcomes.");
    }
    if (result.cohort === "later-additions") {
        return narrative("Comparing earlier calls with newly included calls.", `${baseline.count} earlier calls are compared with ${later.count} later-only calls. Newly included does not establish when a call executed.`);
    }
    if (!result.canDescribeRecordedChange) {
        return narrative("Read the change with its missing and partial outcomes.", `Unknown calls: ${baseline.unknown} of ${baseline.count} earlier, ${later.unknown} of ${later.count} later. Partial calls: ${baseline.partial} earlier, ${later.partial} later.`);
    }
    const patterns = result.patterns.filter(pattern => pattern.presence === "matched");
    const ratesUnchanged = patterns.every(pattern => OUTCOMES.every(outcome => pattern.change[outcome] === 0));
    if (matched.mixChanged) {
        return narrative(ratesUnchanged ? "Traffic mix changed; individual pattern rates did not." : "Traffic mix changed alongside the recorded outcomes.",
            "The overall rate uses different proportions of each pattern. Compare the matched rows rather than reading the overall percentage as a like-for-like improvement.");
    }
    const decreased = patterns.filter(pattern => pattern.change.failure < 0).length;
    const increased = patterns.filter(pattern => pattern.change.failure > 0).length;
    if (decreased && increased) {
        return narrative("Recorded failure rates moved in different directions.",
            `${decreased} matched pattern${decreased === 1 ? "" : "s"} had a lower failure share; ${increased} had a higher share.`, "mixed");
    }
    const failures = `${baseline.failure} of ${baseline.count} matched calls failed earlier; ${later.failure} of ${later.count} failed later.`;
    if (matched.change.failure < 0) return narrative("A smaller share of matched calls failed.", failures, "positive");
    if (matched.change.failure > 0) return narrative("A larger share of matched calls failed.", failures, "warning");
    if (ratesUnchanged) return narrative("Matched pattern outcome rates were unchanged.", failures);
    if (matched.change.success > 0) {
        return narrative("More matched calls have a recorded successful result.",
            `${baseline.success} of ${baseline.count} earlier; ${later.success} of ${later.count} later. Tool results do not establish task correctness.`);
    }
    return narrative("The recorded outcome mix changed.", failures);
}
