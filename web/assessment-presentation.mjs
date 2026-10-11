import { createActivityProjection } from "../lib/activity-projection.mjs";

// Reuse the canonical nearest-rank calculation, never a percentile of medians.
export function createTimingPresentation(summarize = createActivityProjection(null, null, ["unknown"]).summarize) {
    const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    const definitions = {
        "tool-start-to-completion": ["Tool calls", "calls", "Call start to recorded completion"],
        "recorded-request-to-final-answer": ["Request to final response", "requests", "Recorded request to final response; not tool-call time"],
        "verified-request-to-final-answer": ["Whole-interaction latency", "requests", "Verified request to final answer"],
        "http-dispatch-to-response-headers": ["HTTP response time", "HTTP responses", "Dispatch to response headers"],
        "http-dispatch-to-transport-error": ["Time to HTTP transport error", "HTTP transport errors", "Dispatch to transport error"],
    };
    function duration(milliseconds) {
        if (milliseconds === null) return "Not measured";
        if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("A duration must be nonnegative milliseconds or null.");
        if (milliseconds > 0 && milliseconds < 10) return "<0.01 s";
        const hundredths = Math.round(milliseconds / 10);
        const seconds = number(hundredths % 6000 / 100);
        return hundredths < 6000 ? `${seconds} s`
            : hundredths < 360000 ? `${number(Math.floor(hundredths / 6000))} min ${seconds} s`
                : `${number(Math.floor(hundredths / 360000))} h ${Math.floor(hundredths % 360000 / 6000)} min ${seconds} s`;
    }
    function fromSummary(summary, eligible, boundary) {
        const definition = definitions[boundary];
        if (!definition) throw new TypeError("A supported recorded timing boundary is required.");
        const { sampleCount: timed, p50Ms, p95Ms } = summary;
        if (!Number.isSafeInteger(eligible) || !Number.isSafeInteger(timed) || timed < 0 || timed > eligible
            || (timed === 0 ? p50Ms !== null || p95Ms !== null
                : !Number.isFinite(p50Ms) || p50Ms < 0 || !Number.isFinite(p95Ms) || p95Ms < p50Ms)) {
            throw new TypeError("Timing values must match the measured and eligible population.");
        }
        const [label, unit, boundaryLabel] = definition, notTimed = eligible - timed;
        return {
            kind: "timing", label, timed, eligible, notTimed, boundaryLabel,
            coverage: { count: timed, eligible, unit },
            coverageLabel: `${number(timed)} of ${number(eligible)} ${eligible === 1 ? unit.replace(/s$/, "") : unit} timed`,
            missingLabel: notTimed ? `${number(notTimed)} ${notTimed === 1 ? unit.replace(/s$/, "") : unit} without recorded timing` : eligible ? `All ${unit} timed` : `No eligible ${unit}`,
            measurement: { value: p50Ms, unit: "ms", aggregation: "nearest-rank-p50", boundary },
            distribution: { sampleCount: timed, p50Ms, p95Ms, method: "nearest-rank; available samples only" },
            display: { median: duration(p50Ms), p95: duration(p95Ms), state: timed === 0 ? "missing" : timed === 1 ? "single" : "distribution" },
            resultLabel: timed === 0 ? "Not measured" : timed === 1 ? `${duration(p50Ms)} single measured sample`
                : `Median ${duration(p50Ms)}; P95 ${duration(p95Ms)}`,
            limitation: timed === 1 ? "One sample, not overall performance."
                : notTimed ? `Only timed ${unit} are represented; missing timing is not zero.` : "Recorded samples only, not overall task time.",
        };
    }
    function fromMetric(metric) {
        const summary = summarize(metric.samples.map(sample => ({ durationMs: sample.value, outcome: "unknown" }))).duration;
        if (summary.sampleCount !== metric.coverage.covered || summary.p50Ms !== metric.value) {
            throw new TypeError("Retained timing samples do not match the metric.");
        }
        return fromSummary(summary, metric.coverage.eligible, metric.boundary);
    }
    return { duration, fromSummary, fromMetric };
}

// The backend supplies validated facts and retained samples; this factory only presents them.
export function createAssessmentPresentation({ validateMetric, metricSlotKey, validateReviewStatus, validateAssessmentAttempts, timing = createTimingPresentation() }) {
    const bandVersion = "assessed-pass-share-v1";
    const dimensionLabels = { accuracy: "Accuracy", speed: "Speed", "answer-trust": "Answer trust", "action-trust": "Action trust" };
    const checkLabels = {
        "semantic-answer-correctness": "Answer correctness",
        "answer-support-validity": "Answer support",
        "action-authorization-compliance": "Action authorization",
        "recorded-tool-success": "Recorded tool completion",
        "returned-status-2xx": "Tool-returned HTTP status",
        "graph-output-status-2xx": "Output-visible HTTP status",
        "owned-http-status-2xx": "Observed HTTP status",
        "answer-evidence-present": "Retained response availability",
    };
    const speedLabels = {
        "tool-duration": "Median call duration",
        "http-response-duration": "Median HTTP response time",
        "http-error-duration": "Median time to transport error",
        "interaction-latency": "Whole-interaction latency",
        "recorded-response-duration": "Time to recorded final response",
    };
    const personalLabels = {
        "semantic-answer-correctness": { pass: "Correct", fail: "Not correct" },
        "answer-support-validity": { pass: "Supported", fail: "Not supported" },
        "action-authorization-compliance": { pass: "Authorized", fail: "Not authorized" },
    };
    const boundaryLabels = {
        "tool-start-to-completion": "Call start to recorded completion",
        "http-dispatch-to-response-headers": "Dispatch to response headers",
        "http-dispatch-to-transport-error": "Dispatch to transport error",
        "verified-request-to-final-answer": "Verified request to final answer",
        "recorded-request-to-final-answer": "Recorded request to final response; not tool-call time",
        "one-rule-per-eligible-unit": "One check per eligible item",
        "explicit-attributed-usage-scope": "Explicitly attributed usage only",
    };
    const reasonLabels = {
        "missing-evidence": "The saved record does not contain the evidence needed for this result.",
        "missing-completion": "No completion event reference was retained.",
        "nonbinary-outcome": "The recorded outcome is not a pass or fail.",
        "unsupported-check": "Recorded tool outcomes cannot answer this check. See Automatic scores for AI review.",
        "unsupported-adapter": "This source does not provide the required evidence.",
        "capture-disabled": "Optional response capture is off.",
        "category-not-consented": "This evidence category is not enabled.",
        "stale-consent": "Evidence permission changed. This result is no longer current.",
        "stale-source": "The approved source changed. This result is no longer current.",
        "stale-membership": "The interaction's recorded actions changed.",
        "stale-override": "Personal feedback changed. Read the latest result.",
        "deletion-pending": "Local cleanup must finish before these facts can be shown.",
        "deleted-dependency": "Supporting activity was deleted.",
        "credential-excluded": "Text was excluded by credential screening.",
        "capture-limit": "Some evidence was left out because it exceeded the saving limit.",
        "partial-evidence": "Only part of the evidence was retained.",
        "unverified-association": "The record does not confirm that this evidence belongs to this request.",
        "invalid-timing": "The recorded times cannot establish this duration.",
        "usage-unavailable": "No attributed usage or charge was recorded.",
        "pricing-unavailable": "Usage has no compatible price.",
        "no-eligible-units": "There are no items this measure can use in the current selection.",
        "no-assessed-units": "None of the included items has a result for this check.",
        "evaluator-failure": "The check could not run. This is not a failed result.",
        "user-withdrawn": "Personal feedback was withdrawn.",
        "user-verdict": "Your personal feedback, not an automatic check.",
        "not-applicable": "This check does not apply to this recorded interaction.",
    };
    const numbers = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
    const percentages = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, roundingMode: "floor" });
    const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
    const number = value => numbers.format(value);
    function band(value) {
        if (value === null) return "neutral";
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError("Pass share must be a fraction from 0 to 1.");
        return value < 0.5 ? "red" : value < 0.75 ? "orange" : value < 0.9 ? "gold" : "teal";
    }
    function unavailable(metric) {
        if (metric.reason === "not-applicable") return "Not applicable";
        if (metric.status === "evaluator-error") return "Check unavailable";
        if (metric.status === "unpriced") return "Unpriced";
        return metric.unit === "ratio" ? "Unassessed" : "Not measured";
    }
    function reading(metric, personalVerdict) {
        const { covered, eligible } = metric.coverage;
        const quality = ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension);
        if (quality) {
            const label = metric.dimension === "accuracy" ? "Answer correctness"
                : metric.dimension === "answer-trust" ? "Answer support"
                    : metric.origin === "user-personal" ? "Action authorization" : "Actions match request";
            const missing = metric.reason === "not-applicable" ? "Not applicable"
                : metric.status === "evaluator-error" ? "Check could not run"
                    : metric.origin === "model-assessed" && ["missing-evidence", "partial-evidence"].includes(metric.reason) ? "Not enough evidence" : "No result";
            return {
                label, coverage: `Results for ${number(covered)} of ${number(eligible)} ${eligible === 1 ? "request" : "requests"}`,
                value: personalVerdict ?? (metric.value === null ? missing : `${number(metric.numerator)} passed \u00b7 ${number(metric.denominator - metric.numerator)} failed`),
            };
        }
        if (metric.dimension === "speed") {
            const unit = metric.definitionId === "tool-duration" ? "calls" : metric.definitionId === "recorded-response-duration" ? "requests" : "items";
            return {
                value: timing.duration(metric.value),
                coverage: `${number(covered)} of ${number(eligible)} ${unit} timed${covered === 1 ? " \u00b7 Single sample" : covered > 1 ? " \u00b7 Median / P95" : ""}`,
            };
        }
        return null;
    }
    const qualityDimensions = ["accuracy", "answer-trust", "action-trust"];
    const units = (count, unit) => `${number(count)} ${count === 1 ? unit.replace(/s$/, "") : unit}`;
    function coverageHeadline(count, eligible, verb) {
        if (!eligible) return "No eligible requests";
        if (!count && verb === "assessed") return "Quality not assessed";
        return count === eligible ? `All ${units(eligible, "requests")} ${verb}`
            : `${number(count)} of ${units(eligible, "requests")} ${verb}`;
    }
    function evidenceRow(metric) {
        const quality = qualityDimensions.includes(metric.dimension), { covered: count, eligible } = metric.coverage;
        const timingUnits = {
            "tool-duration": "calls", "recorded-response-duration": "requests", "interaction-latency": "requests",
            "http-response-duration": "HTTP responses", "http-error-duration": "HTTP transport errors",
        };
        const unit = quality ? "requests" : metric.dimension === "speed" ? timingUnits[metric.definitionId]
            : metric.checkId === "recorded-tool-success" ? "calls" : "items";
        const provenance = {
            origin: metric.origin,
            label: metric.origin === "model-assessed" ? "Model assessment" : metric.origin === "user-personal" ? "Your feedback" : "Local observation",
            definitionId: metric.definitionId, definitionVersion: metric.definitionVersion,
            checkId: metric.checkId, checkVersion: metric.checkVersion,
            ...(metric.evaluator ? { evaluator: { ...metric.evaluator } } : {}),
        };
        const common = {
            version: 1, metricRef: metric.metricRef, dimension: metric.dimension, status: metric.status,
            label: reading(metric)?.label ?? speedLabels[metric.definitionId] ?? checkLabels[metric.checkId],
            coverage: { count, eligible, unit }, eligible, provenance,
        };
        if (quality) {
            const notAssessed = eligible - count, errors = metric.counts.evaluatorError;
            const reasons = metric.unassessedReasons ?? (metric.counts.unassessed ? [{
                reason: count === 0 && errors === 0 && metric.reason !== "no-assessed-units" ? metric.reason : null,
                count: metric.counts.unassessed,
            }] : []);
            const labels = {
                "missing-evidence": "Insufficient recorded evidence", "partial-evidence": "Insufficient recorded evidence",
                "not-applicable": "Check not applicable", "unsupported-check": "Local rules do not assess quality",
                "no-assessed-units": "No verdict recorded for this assessment",
                "user-verdict": "Personal feedback without a pass or fail verdict",
            };
            return {
                ...common, kind: "quality", assessed: count, notAssessed, counts: { ...metric.counts },
                headline: coverageHeadline(count, eligible, "assessed"),
                coverageLabel: `${number(count)} of ${units(eligible, unit)} assessed`,
                resultLabel: count ? `${number(metric.counts.pass)} passed; ${number(metric.counts.fail)} failed` : "No pass or fail verdicts",
                missingLabel: notAssessed ? `${units(notAssessed, unit)} not assessed${errors ? `; ${units(errors, "evaluator errors")}` : ""}` : "No requests left unassessed",
                passShare: { value: metric.value, label: metric.value === null ? "No pass percentage"
                    : `${metric.value > 0 && metric.value * 100 < 0.01 ? "<0.01" : percentages.format(metric.value * 100)}% of assessed requests passed` },
                unassessedReasons: reasons.map(item => ({
                    ...item, label: labels[item.reason] ?? (item.reason === null ? "Reason not retained for these unassessed requests" : reasonLabels[item.reason]),
                })),
                limitation: (count < eligible ? "Results describe only the assessed requests, not the overall quality of this selection."
                    : "These are recorded assessments, not independent proof of correctness.")
                    + (metric.origin === "model-assessed" ? " AI judgments can be wrong." : "")
                    + (metric.dimension === "action-trust" ? metric.origin === "user-personal"
                        ? " Personal authorization feedback is not an independent permission audit."
                        : " Matching the request does not prove a person gave permission." : ""),
            };
        }
        if (metric.dimension === "speed") {
            return {
                ...common, ...timing.fromMetric(metric),
                headline: `${number(count)} of ${units(eligible, unit)} timed`,
            };
        }
        if (metric.checkId === "recorded-tool-success") return {
            ...common, kind: "execution", counts: { ...metric.counts },
            headline: `${number(metric.counts.pass)} of ${units(eligible, "calls")} succeeded`,
            resultLabel: `${number(metric.counts.pass)} succeeded; ${number(metric.counts.fail)} failed`,
            missingLabel: `${units(eligible - count, "calls")} without a recorded binary outcome`,
            successShare: { value: eligible ? metric.counts.pass / eligible : null, numerator: metric.counts.pass, denominator: eligible },
            limitation: "Recorded tool success uses all included calls, not just binary results. It does not establish answer correctness, support or permission.",
        };
        return {
            ...common, kind: "observation", counts: metric.counts ? { ...metric.counts } : null,
            headline: `${number(count)} of ${units(eligible, unit)} with recorded binary outcomes`,
            resultLabel: metric.counts ? `${number(metric.counts.pass)} positive; ${number(metric.counts.fail)} negative` : "Local observation",
            limitation: "Tool outcomes and evidence availability do not establish answer correctness, support or permission.",
        };
    }
    function attemptEvidence(metrics, attempts) {
        const eligibleRefs = new Set(metrics.filter(metric => qualityDimensions.includes(metric.dimension)).flatMap(metric => metric.eligibleUnitRefs));
        const eligible = eligibleRefs.size;
        const limitation = "Latest recorded attempt status per request. Failed or unfinished evaluator attempts are not failed answer or action verdicts; prior applicable verdicts remain shown.";
        if (attempts == null) return {
            status: "unavailable", coverage: { count: null, eligible: metrics.length ? eligible : null, unit: "requests" },
            counts: null, rows: [], headline: "Assessment attempt history unavailable", limitation,
        };
        validateAssessmentAttempts(attempts);
        if (attempts.some(item => !eligibleRefs.has(item.interactionRef))) throw new TypeError("Assessment attempt outside selected requests.");
        const labels = {
            none: "No assessment attempt recorded", pending: "Assessment pending", failed: "Evaluator attempt failed",
            uncertain: "Evaluator outcome uncertain", unavailable: "Assessment evidence or approval unavailable",
            complete: "Assessment attempt completed", revoked: "Assessment approval withdrawn",
            "not-run": "Request not reached by the recorded assessment run", "not-current": "Earlier attempt is not current",
        };
        const counts = Object.fromEntries(Object.keys(labels).map(state => [state, attempts.filter(item => item.latestAttempt === state).length]));
        return {
            status: attempts.length === eligible ? "available" : "partial",
            coverage: { count: attempts.length, eligible, unit: "requests" }, counts,
            rows: Object.entries(counts).filter(([, count]) => count).map(([state, count]) => ({ state, count, label: labels[state] })),
            headline: `Assessment attempt status recorded for ${number(attempts.length)} of ${units(eligible, "requests")}`,
            limitation,
        };
    }
    function evidenceSummary(metrics, assessmentAttempts) {
        const quality = Object.fromEntries(qualityDimensions.map(dimension => {
            const all = metrics.filter(metric => metric.dimension === dimension);
            const assessedLanes = all.filter(metric => metric.origin !== "automatic-local");
            const eligibleRefs = new Set(all.flatMap(metric => metric.eligibleUnitRefs));
            const coveredRefs = new Set(assessedLanes.flatMap(metric => metric.coveredUnitRefs));
            const eligible = all.length ? eligibleRefs.size : null, assessed = all.length ? coveredRefs.size : null;
            const rows = assessedLanes.map(evidenceRow);
            return [dimension, {
                dimension, eligible, assessed, notAssessed: eligible === null ? null : eligible - assessed,
                coverage: { count: assessed, eligible, unit: "requests" },
                headline: eligible === null ? "Assessment coverage unavailable" : coverageHeadline(assessed, eligible, "assessed"),
                coverageLabel: eligible === null ? "Coverage unavailable" : `${number(assessed)} of ${units(eligible, "requests")} assessed`,
                missingLabel: eligible === null ? "No metric supplied for this scope" : `${units(eligible - assessed, "requests")} not assessed`,
                rows, localObservations: all.filter(metric => metric.origin === "automatic-local").map(evidenceRow),
                overlappingAssessments: assessedLanes.reduce((sum, metric) => sum + metric.coverage.covered, 0) > coveredRefs.size,
                limitation: "Tool outcomes do not establish answer correctness, answer support or permission. "
                    + (rows.length > 1 ? "Assessment rows may cover the same requests; do not add their counts or average their percentages."
                        : assessed ? "Only the assessed requests have quality verdicts; missing verdicts are not failures." : "No pass or fail quality verdict is available."),
            }];
        }));
        return {
            version: 1, quality,
            assessmentAttempts: attemptEvidence(metrics, assessmentAttempts),
            timing: metrics.filter(metric => metric.dimension === "speed").map(evidenceRow),
            execution: metrics.filter(metric => metric.dimension === "execution").map(evidenceRow),
        };
    }
    function present(metric, singleInteraction = false) {
        const ratio = metric.unit === "ratio", cost = metric.unit === "USD";
        const label = ratio ? dimensionLabels[metric.dimension] ?? checkLabels[metric.checkId] : cost
            ? metric.status === "estimated" ? "Estimated cost" : metric.status === "measured" ? "Recorded cost" : "Cost"
            : speedLabels[metric.definitionId];
        const origin = metric.origin === "user-personal" ? "Your feedback" : metric.origin === "model-assessed" ? "Model assessment" : "Automatic local observation";
        const personalVerdict = singleInteraction && metric.origin === "user-personal" && metric.denominator === 1 && metric.coverage.eligible === 1
            ? personalLabels[metric.checkId]?.[metric.numerator === 1 ? "pass" : "fail"] ?? null : null;
        const value = personalVerdict ?? (metric.value === null ? unavailable(metric) : ratio
            ? metric.value > 0 && metric.value * 100 < 0.01 ? "<0.01%" : `${percentages.format(metric.value * 100)}%`
            : cost ? metric.value > 0 && metric.value < 0.000001 ? "<$0.000001" : dollars.format(metric.value)
                : metric.value > 0 && metric.value < 0.01 ? "<0.01 ms" : `${number(metric.value)} ms`);
        const diagnostic = ["execution", "evidence"].includes(metric.dimension);
        const coverage = ratio && diagnostic
            ? `${number(metric.numerator)} / ${number(metric.denominator)} positive; ${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} with a recorded binary result`
            : ratio
            ? metric.denominator === 0 ? `${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} assessed; no pass/fail results`
                : `${number(metric.numerator)} / ${number(metric.denominator)} passed; ${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} assessed`
            : `${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} ${cost ? "priced" : "timed"}`;
        const unsupported = {
            accuracy: "No AI answer review is available here. See Automatic scores; your feedback is optional.",
            "answer-trust": "No AI answer-support review is available here. See Automatic scores.",
            "action-trust": "No AI action review is available here. AI checks whether actions match the request, not whether a person gave permission.",
            speed: "No verified request-to-final-answer timing.",
        };
        const qualification = cost && metric.value !== null
            ? `${metric.status === "estimated" ? "Estimated" : "Recorded"} ${metric.coverage.covered < metric.coverage.eligible ? "subtotal" : "total"} (USD). ${boundaryLabels[metric.boundary]}.`
            : metric.value === null ? metric.reason === "unsupported-check" ? unsupported[metric.dimension] ?? reasonLabels[metric.reason]
                : reasonLabels[metric.reason] : metric.origin === "model-assessed"
                    ? metric.dimension === "action-trust" ? "AI checked whether the actions match the recorded request. This does not prove a person gave permission."
                        : "AI checked the recorded evidence. Its result can be wrong."
                    : boundaryLabels[metric.boundary];
        const details = [
            `${label}. ${origin}.`,
            `${value}. ${coverage}. ${qualification}`,
            `Definition ${metric.definitionId} v${metric.definitionVersion}${metric.checkId ? `; ${metric.checkId} v${metric.checkVersion}` : ""}.`,
            `Boundary: ${boundaryLabels[metric.boundary]}.`,
        ];
        if (metric.counts) details.push(`${number(metric.counts.pass)} passed, ${number(metric.counts.fail)} failed, ${number(metric.counts.unassessed)} unassessed, ${number(metric.counts.evaluatorError)} check errors.`);
        if (metric.pricing) details.push(`${metric.pricing.method === "recorded-charge" ? "Recorded charge" : "Versioned rate card"}, pricing version ${metric.pricing.version}.`);
        if (metric.evaluator) details.push(`Model ${metric.evaluator.model}; rubric ${metric.evaluator.rubricId} v${metric.evaluator.rubricVersion}.`);
        if (metric.dimension === "speed") {
            const row = timing.fromMetric(metric);
            details.push(`${row.timed === 1 ? "Single sample" : "Median"}: ${metric.value === null ? "Not measured" : `${metric.value} ms`}. `
                + `P95: ${row.timed > 1 ? `${row.distribution.p95Ms} ms` : "Not shown without multiple samples"}. Nearest rank; retained samples only.`);
        }
        const timingSummary = {
            "tool-duration": { label: "Tool calls", unit: "calls" },
            "recorded-response-duration": { label: "Request to final response", unit: "requests" },
        }[metric.definitionId];
        return {
            metricRef: metric.metricRef, dimension: metric.dimension, label, value, coverage, qualification, origin, personalVerdict,
            evidence: evidenceRow(metric),
            reading: reading(metric, personalVerdict),
            ...(timingSummary ? { summary: {
                label: timingSummary.label,
                coverage: `${metric.coverage.covered === 1 ? "Single sample \u00b7 " : metric.coverage.covered > 1 ? "Median \u00b7 " : ""}${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} ${timingSummary.unit} timed`,
            } } : {}),
            band: ratio && !["execution", "evidence"].includes(metric.dimension) ? band(metric.value) : "neutral",
            bandVersion, status: metric.status, details, basis: { ...metric.basis },
        };
    }
    function format(metric) {
        validateMetric(metric);
        return present(metric);
    }
    function missing(dimension) {
        return {
            dimension, label: dimensionLabels[dimension], value: ["speed", "cost"].includes(dimension) ? "Not measured" : "Unassessed",
            coverage: "Coverage unavailable", qualification: "No metric was supplied for this scope.", origin: "",
            reading: {
                label: dimension === "accuracy" ? "Answer correctness" : dimension === "answer-trust" ? "Answer support" : dimension === "action-trust" ? "Actions match request" : dimensionLabels[dimension],
                coverage: "Coverage unavailable", value: dimension === "speed" ? "Not measured" : "No result",
            },
            band: "neutral", bandVersion, status: "unavailable", details: [`${dimensionLabels[dimension]}: no metric or coverage was supplied for this scope.`], basis: null,
        };
    }
    function presentReviewStatus(status) {
        validateReviewStatus(status);
        const { execution, assessment } = status;
        const causes = {
            "workiq-sign-in-required": "Work IQ sign-in was required",
            "request-timeout": "The tool reported an MCP request timeout",
            "access-denial": "The recorded error mentions access denial",
            "message-screened": "Error text was excluded by credential screening; its cause is unavailable",
            "message-too-large": "Error text exceeded the inspection limit; its cause is unavailable",
            "message-not-supplied": "The source supplied no typed error message",
            "message-excluded": "Error text was excluded from collection; no specific cause signal was retained",
            "unsupported-error-format": "The recorded error format is not supported",
            "source-error-not-supplied": "The source supplied no supported structured error details",
            unqualified: "Cause unavailable in retained evidence; source omission and earlier collection cannot be distinguished",
        };
        const failure = execution.failed ? `${number(execution.failed)} of ${number(execution.calls)} recorded Work IQ ${execution.calls === 1 ? "call" : "calls"} failed`
            + (execution.succeeded ? `; ${number(execution.succeeded)} succeeded` : "") : "";
        const outcome = failure || (execution.succeeded === execution.calls
            ? `${number(execution.succeeded)} recorded Work IQ ${execution.calls === 1 ? "call completed" : "calls completed"}`
            : "Recorded tool outcomes are incomplete");
        const cause = execution.causes.map(item => causes[item.cause] + (execution.failed > 1 ? ` (${number(item.count)})` : "")).join("; ");
        let quality;
        if (assessment.result === "assessed") quality = "AI quality results are recorded for this attempt.";
        else if (assessment.result === "partial") quality = "AI assessment produced some results; other checks have no quality verdict.";
        else if (assessment.result === "unassessed") quality = assessment.unavailableReason === "not-applicable"
            ? "AI assessment found no applicable quality checks." : assessment.unavailableReason === "missing-evidence"
                ? "AI assessment found insufficient recorded evidence; no quality verdict was produced."
                : "AI assessment produced no supported quality verdict.";
        else quality = ({
            none: "No AI quality assessment is recorded for this attempt.",
            pending: "An AI quality assessment is pending for this attempt.",
            failed: "AI quality assessment could not complete. This is an evaluator failure, not a failed answer or action verdict.",
            uncertain: "The AI assessment's outcome is uncertain; no quality verdict is available.",
            unavailable: "No AI verdict was produced: the assessment's recorded evidence or approval was unavailable.",
            complete: "A prior AI quality result is no longer applicable to this attempt.",
            revoked: "AI assessment approval was withdrawn for this attempt.",
            "not-run": "This attempt was not reached by the recorded AI assessment run.",
            "not-current": "No AI quality result is applicable to the current evidence for this attempt.",
        })[assessment.latestAttempt];
        if (assessment.result !== "none" && assessment.latestAttempt === "failed") quality += " A later evaluator attempt failed; the applicable results remain shown.";
        if (assessment.result === "none" && assessment.latestAttempt === "none") {
            if (!assessment.inAutomaticScope) quality += " It is not included in the current automatic-scoring scope.";
            if (execution.failed) quality += " Reporting a failed lookup can still be correct.";
        }
        if (assessment.personalFeedback) quality += " Personal feedback is shown separately.";
        return {
            execution: `${outcome}.${cause ? ` ${cause}.` : ""}`, assessment: quality,
            nextAction: execution.causes.some(item => item.cause === "workiq-sign-in-required")
                ? "If sign-in is still needed, use the Work IQ/MCP sign-in flow in Copilot (/mcp auth workiq). WIRE does not retry this recorded call."
                : execution.failed ? "Inspect the recorded actions and Technical details below. Missing or screened error text is not recovered by this view." : "",
        };
    }
    function findingsFor(evidence, metrics, { singleInteraction, reviewStatus, reviewStatuses }) {
        const eligible = new Set(metrics.filter(metric => qualityDimensions.includes(metric.dimension)).flatMap(metric => metric.eligibleUnitRefs));
        const statuses = reviewStatus ? [reviewStatus] : [];
        if (reviewStatuses !== null) {
            if (!Array.isArray(reviewStatuses) || reviewStatus) throw new TypeError("Supply either one review status or selected review statuses.");
            const seen = new Set();
            for (const item of reviewStatuses) {
                if (!item || !eligible.has(item.interactionRef) || seen.has(item.interactionRef)) throw new TypeError("Review status outside selected requests or duplicated.");
                validateReviewStatus(item.reviewStatus);
                seen.add(item.interactionRef); statuses.push(item.reviewStatus);
            }
        }
        const operational = [], answers = [], causes = new Map();
        const execution = evidence.execution.find(row => row.kind === "execution");
        const reported = { calls: 0, succeeded: 0, failed: 0, other: 0 };
        const completeStatus = Boolean(reviewStatus) || reviewStatuses !== null && statuses.length === eligible.size;
        for (const status of statuses) for (const key of Object.keys(reported)) reported[key] += status.execution[key];
        for (const status of statuses) for (const { cause, count } of status.execution.causes) {
            causes.set(cause, (causes.get(cause) ?? 0) + count);
        }
        if (execution) {
            const { pass, fail, unassessed, evaluatorError } = execution.counts;
            const unqualified = unassessed + evaluatorError;
            const outsideContext = execution.eligible - reported.calls;
            if (outsideContext < 0 || completeStatus && outsideContext !== 0) {
                throw new TypeError("Review statuses do not match the full selected call population.");
            }
            // Qualified binary checks are a subset of reported outcomes, not the same evidence boundary.
            if (pass > reported.succeeded + outsideContext || fail > reported.failed + outsideContext
                || pass + fail > reported.succeeded + reported.failed + outsideContext
                || reported.succeeded + reported.failed - pass - fail > unqualified) {
                throw new TypeError("Qualified results conflict with reported outcomes in the full selected call population.");
            }
            const succeeded = completeStatus ? reported.succeeded : pass;
            const failed = completeStatus ? reported.failed : fail;
            const other = completeStatus ? reported.other : unqualified;
            const prefix = completeStatus ? "Reported outcomes: " : "Completion-evidence checks: ";
            const failedText = `${number(failed)} of ${units(execution.eligible, "recorded calls")} failed`;
            const parts = [
                { tone: "negative", text: failedText },
                ...(succeeded ? [{ tone: "positive", text: `${number(succeeded)} succeeded` }] : []),
                ...(other ? [{ tone: "neutral", text: `${number(other)} without ${completeStatus ? "a binary reported outcome" : "a qualified result"}` }] : []),
            ];
            operational.push({
                kind: "execution", tone: "neutral",
                boundary: completeStatus ? "reported-outcomes" : "completion-evidence",
                ...(failed ? { prefix, parts, suffix: "." } : {}),
                text: prefix + (failed ? parts.map(part => part.text).join("; ") + "."
                    : succeeded === execution.eligible && succeeded ? `${units(succeeded, "recorded calls")} succeeded.`
                        : `${number(succeeded)} of ${units(execution.eligible, "recorded calls")} succeeded; ${number(other)} without ${completeStatus ? "a binary reported outcome" : "a qualified result"}.`),
            });
            const gap = reported.succeeded + reported.failed - pass - fail;
            if (completeStatus && gap > 0) {
                const metric = metrics.find(metric => metric.origin === "automatic-local" && metric.checkId === "recorded-tool-success");
                const labels = {
                    "missing-completion": "completion event reference not retained",
                    "nonbinary-outcome": "no supported binary completion outcome",
                    "evaluator-failure": "execution-check error",
                };
                const reasons = new Set((metric.unassessedReasons ?? (unassessed ? [{ reason: null }] : []))
                    .map(item => item.reason === null ? "reason not retained" : labels[item.reason] ?? reasonLabels[item.reason]));
                if (evaluatorError) reasons.add("execution-check error");
                operational.push({
                    kind: "execution-gap", tone: "neutral", count: gap,
                    text: `${units(gap, "reported outcomes")} ${gap === 1 ? "lacks" : "lack"} a completion-qualified result. Unassessed-check reasons: ${[...reasons].join("; ")}.`,
                });
            }
        }
        if ([...causes.values()].reduce((sum, count) => sum + count, 0) !== reported.failed) throw new TypeError("Failure reasons do not match reported failures.");
        if (!reviewStatus && (reviewStatuses === null || statuses.length < eligible.size)) operational.push({
            kind: "unavailable", tone: "neutral", text: reviewStatuses === null
                ? "Detailed call-status context is unavailable in this saved summary."
                : `Reported outcome context covers ${number(statuses.length)} of ${units(eligible.size, "requests")}`
                    + (execution ? ` and ${number(reported.calls)} of ${units(execution.eligible, "calls")}` : "")
                    + `: ${number(reported.succeeded)} succeeded, ${number(reported.failed)} failed, ${number(reported.other)} other. Remaining reported outcomes and reasons are unavailable.`,
        });
        const causeLabels = {
            "workiq-sign-in-required": "Work IQ sign-in was required for the recorded call",
            "request-timeout": "The tool reported an MCP request timeout",
            "access-denial": "The recorded error mentions access denial",
            "message-screened": "Error text was screened out; the cause is unavailable",
            "message-too-large": "Error text exceeded the inspection limit; the cause is unavailable",
            "message-not-supplied": "The source supplied no typed error message",
            "message-excluded": "Error text was excluded; no specific cause signal was retained",
            "unsupported-error-format": "The recorded error format is not supported",
            "source-error-not-supplied": "The source supplied no supported structured error details",
            unqualified: "The cause was not retained; source omission and earlier collection cannot be distinguished",
        };
        for (const [cause, count] of causes) operational.push({
            kind: "cause", cause, count, tone: "neutral",
            text: `${causeLabels[cause]}${singleInteraction && count === 1 ? "" : ` (${units(count, "calls")})`}.`,
        });
        const words = {
            accuracy: ["answer correct", "answer not correct"],
            "answer-trust": ["answer supported", "answer not supported"],
            "action-trust": ["actions matching the request", "actions not matching the request"],
        };
        for (const dimension of qualityDimensions) {
            const group = evidence.quality[dimension];
            for (const row of group.rows) {
                const personal = row.provenance.origin === "user-personal";
                const origin = personal ? "Your feedback" : "AI assessment";
                const single = singleInteraction && row.eligible === 1;
                const [positive, negative] = personal && dimension === "action-trust" ? ["actions authorized", "actions not authorized"] : words[dimension];
                const parts = [];
                if (row.counts.pass) parts.push({ tone: "positive", text: `${positive}${single ? "" : ` in ${units(row.counts.pass, "requests")}`}` });
                if (row.counts.fail) parts.push({ tone: "negative", text: `${negative}${single ? "" : ` in ${units(row.counts.fail, "requests")}`}` });
                const reasons = row.unassessedReasons.filter(item => item.reason !== "no-assessed-units");
                if (row.counts.evaluatorError) reasons.push({ count: row.counts.evaluatorError, label: "Evaluator error, not a failed answer or action verdict" });
                const missing = reasons.map(item => `${item.label}${single ? "" : ` (${units(item.count, "requests")})`}`).join("; ");
                if (parts.length || missing) {
                    const prefix = parts.length ? `${origin}: ` : `${origin} / ${row.label}: `;
                    const suffix = parts.length && missing ? `. ${missing}.` : ".";
                    answers.push({
                        kind: parts.length ? "verdict" : "unassessed", dimension, metricRef: row.metricRef, provenance: row.provenance, tone: "neutral",
                        text: prefix + (parts.length ? parts.map(part => part.text).join("; ") + suffix : missing + "."),
                        ...(parts.length ? { prefix, parts, suffix } : {}),
                    });
                }
            }
        }
        const hasVerdicts = answers.some(item => item.kind === "verdict");
        if (!answers.length) answers.push({
            kind: "missing", tone: "neutral",
            text: eligible.size ? "No saved answer or action assessment is available. Tool completion alone does not establish answer quality."
                : "No answer or action assessment coverage was supplied for this scope.",
        });
        const attempts = evidence.assessmentAttempts;
        const attemptRows = reviewStatus ? [{ state: reviewStatus.assessment.latestAttempt, count: 1 }] : attempts.rows;
        const attemptLabels = {
            failed: "The evaluator could not complete; this is not a failed answer or action verdict",
            uncertain: "The evaluator outcome is uncertain",
            unavailable: "Assessment evidence or approval was unavailable",
            pending: "An assessment attempt is pending",
            revoked: "Assessment approval was withdrawn",
            "not-run": "The recorded assessment run did not reach this request",
            "not-current": "The earlier assessment attempt does not apply to the current recorded evidence",
        };
        for (const row of attemptRows) if (attemptLabels[row.state]) answers.push({
            kind: "attempt", state: row.state, count: row.count, tone: "neutral",
            text: `${attemptLabels[row.state]}${singleInteraction ? "" : ` (${units(row.count, "requests")})`}.${hasVerdicts ? " Applicable saved verdicts remain shown." : ""}`,
        });
        return {
            version: 1, singleInteraction, operational, answers,
            recovery: causes.has("workiq-sign-in-required")
                ? "If still needed, sign in through /mcp auth workiq in Copilot. WIRE does not check current access or retry this call." : "",
            scope: singleInteraction ? "These verdicts belong to this original request group, not later changes."
                : "Full selected interaction groups, not only matching calls.",
            rationale: hasVerdicts ? "Specific reasons behind these saved verdicts were not retained." : "",
            qualification: (answers.some(item => item.provenance?.origin === "model-assessed") ? "AI judgments can be wrong. " : "")
                + (hasVerdicts && answers.some(item => item.dimension === "action-trust")
                    ? "Matching the request is not proof of human permission." : ""),
        };
    }
    function summarize(metrics, { membershipStatus = "complete-retained", singleInteraction = false, reviewStatus = null, assessmentAttempts = null, reviewStatuses = null } = {}) {
        if (!Array.isArray(metrics)) throw new TypeError("Metrics must be supplied explicitly.");
        const slots = new Set();
        for (const metric of metrics) {
            const slot = metricSlotKey(metric);
            if (slots.has(slot)) throw new TypeError("Duplicate metric slot: the backend must supply one active pooled fact.");
            if (Object.keys(metric.basis).some(key => metrics[0].basis[key] !== metric.basis[key])) {
                throw new TypeError("Metrics do not share one current basis.");
            }
            slots.add(slot);
        }
        const rows = metrics.filter(metric => metric.dimension !== "cost").map(metric => present(metric, singleInteraction));
        const review = reviewStatus ? presentReviewStatus(reviewStatus) : null;
        const groups = Object.fromEntries(Object.keys(dimensionLabels).map(dimension => [
            dimension, rows.filter(row => row.dimension === dimension),
        ]));
        for (const dimension of Object.keys(groups)) if (!groups[dimension].length) groups[dimension].push(missing(dimension));
        const diagnostics = rows.filter(row => ["execution", "evidence"].includes(row.dimension));
        for (const dimension of ["accuracy", "answer-trust", "action-trust"]) {
            if (!groups[dimension].some(row => row.origin === "Model assessment")) continue;
            const local = groups[dimension].filter(row => row.origin === "Automatic local observation" && row.status === "unassessed");
            diagnostics.push(...local.map(row => ({ ...row, details: row.details.map(text => text.replace(row.qualification,
                "Local rules do not assess this dimension. The separately approved model result is shown above.")) })));
            groups[dimension] = groups[dimension].filter(row => !local.includes(row));
        }
        const failedTools = metrics.find(metric => metric.checkId === "recorded-tool-success" && metric.origin === "automatic-local");
        const personalAccuracy = metrics.find(metric => metric.dimension === "accuracy" && metric.origin === "user-personal" && metric.value !== null);
        const accuracyMeasured = metrics.some(metric => metric.dimension === "accuracy" && metric.value !== null);
        const trustMeasured = metrics.some(metric => ["answer-trust", "action-trust"].includes(metric.dimension) && metric.value !== null);
        const timed = metrics.some(metric => metric.dimension === "speed" && metric.value !== null);
        let takeaway;
        if (membershipStatus !== "complete-retained") takeaway = "Only some recorded actions can be linked to this request. These results cover that saved evidence.";
        else if (personalAccuracy?.counts.fail) takeaway = "Your feedback identifies an incorrect result; recorded tool outcomes remain separate.";
        else if (failedTools?.counts.fail) takeaway = `${number(failedTools.counts.fail)} of ${number(failedTools.denominator)} calls with a recorded success or failure failed. That does not tell us whether the answer was correct.`;
        else if (!accuracyMeasured && !trustMeasured) takeaway = timed
            ? "Timing is available. There are no results yet for answer correctness, answer support or actions matching the request."
            : "There are no results for answer correctness, answer support or actions matching the request. A missing result is not a failure.";
        else if (personalAccuracy) takeaway = "Your accuracy feedback is shown separately from automatic local observations.";
        else if (metrics.some(metric => metric.origin === "model-assessed")) takeaway = "AI checks use the recorded evidence. Read each result with the number of requests it covers; there is no overall grade.";
        else takeaway = "Recorded facts and your feedback are shown separately. There is no overall grade.";
        const modelChecks = metrics.filter(metric => metric.origin === "model-assessed" && ["accuracy", "answer-trust", "action-trust"].includes(metric.dimension));
        const sameUnits = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
        const sharedRequests = modelChecks.length === 3 && new Set(modelChecks.map(metric => metric.dimension)).size === 3
            && modelChecks.every(metric => sameUnits(metric.eligibleUnitRefs, modelChecks[0].eligibleUnitRefs) && sameUnits(metric.coveredUnitRefs, modelChecks[0].coveredUnitRefs));
        const sharedCount = sharedRequests ? modelChecks[0].coverage.covered : 0;
        const readingNote = (sharedCount ? `The three AI checks cover the same ${number(sharedCount)} ${sharedCount === 1 ? "request" : "requests"}.`
            : "Read the request count for each check; they may cover different requests.") + " Missing results do not count as failed checks.";
        const evidence = evidenceSummary(metrics, assessmentAttempts);
        return { groups, diagnostics, takeaway, bandVersion, readingNote, readingWarning: membershipStatus !== "complete-retained" ? takeaway : "", reviewStatus: review,
            evidence, findings: findingsFor(evidence, metrics, { singleInteraction, reviewStatus, reviewStatuses }) };
    }
    return { format, summarize, band, bandVersion };
}

// DOM-only; this renderer cannot fetch, assess, save feedback, or enable capture.
export function renderAssessmentSummary(root, model, { onDetails, helpButton, detailsLabel = "Details and feedback", renderTiming = renderRecordedTiming, findingsHost, bindDetails, disclosureKey } = {}) {
    if (typeof onDetails !== "function") throw new TypeError("A details path is required for definitions and unavailable reasons.");
    if (model.evidence?.version !== 1) throw new TypeError("A current quality evidence projection is required.");
    if (model.findings?.version !== 1) throw new TypeError("A current saved-findings projection is required.");
    const doc = root.ownerDocument;
    const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    function el(tag, cls, text) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const section = el("section", "assessment-summary");
    section.setAttribute("aria-label", "Interaction insights");
    const heading = el("div", "assessment-heading");
    heading.append(el("h2", "", "Insights"));
    if (onDetails) {
        const details = el("button", "quiet", detailsLabel);
        details.type = "button";
        details.dataset.insightDetails = "";
        details.setAttribute("aria-haspopup", "dialog");
        details.addEventListener("click", () => onDetails(details));
        heading.append(details);
    }
    section.append(heading);
    const findings = el("section", "assessment-findings");
    findings.setAttribute("aria-label", "What the record shows");
    findings.append(el("h3", "", "What the record shows"));
    const calls = el("ul", "assessment-finding-list");
    for (const item of model.findings.operational) {
        const entry = el("li", item.tone);
        if (item.parts) {
            entry.append(doc.createTextNode(item.prefix));
            item.parts.forEach((part, index) => {
                if (index) entry.append(doc.createTextNode("; "));
                entry.append(el("span", part.tone, part.text));
            });
            entry.append(doc.createTextNode(item.suffix));
        } else entry.textContent = item.text;
        entry.dataset.findingKind = item.kind;
        if (item.cause) entry.dataset.findingCause = item.cause;
        calls.append(entry);
    }
    findings.append(calls);
    if (model.findings.recovery) findings.append(el("p", "assessment-finding-recovery",
        "If still needed: /mcp auth workiq in Copilot. No retry here."));
    const lanes = new Map();
    for (const group of Object.values(model.evidence.quality)) for (const row of group.rows) {
        const key = JSON.stringify([row.provenance.origin, row.provenance.evaluator]);
        if (!lanes.has(key)) lanes.set(key, { provenance: row.provenance, rows: [] });
        lanes.get(key).rows.push(row);
    }
    for (const lane of lanes.values()) {
        const group = el("div", "assessment-finding-group");
        const personal = lane.provenance.origin === "user-personal";
        const title = (personal ? "Your feedback" : "Saved AI review") + (lane.rows.some(row => row.eligible > 1) ? " (requests)" : "");
        group.dataset.findingOrigin = lane.provenance.origin;
        group.append(el("h4", "assessment-cell-label", title));
        if (!personal && [...lanes.values()].filter(item => item.provenance.origin === "model-assessed").length > 1) {
            const evaluator = lane.provenance.evaluator;
            group.append(el("p", "assessment-origin-detail", `${evaluator.model}; ${evaluator.rubricId} v${evaluator.rubricVersion}`));
        }
        const list = el("ul", "assessment-compact-verdicts");
        const reasons = new Set();
        for (const row of lane.rows) {
            const labels = row.dimension === "accuracy" ? ["Answer", "Correct", "Not correct"]
                : row.dimension === "answer-trust" ? ["Support", "Supported", "Not supported"]
                    : personal ? ["Authorization", "Authorized", "Not authorized"] : ["Intent", "Matched", "Not matched"];
            if (row.assessed) {
                const item = el("li"), parts = [];
                item.dataset.findingKind = "verdict";
                item.dataset.findingDimension = row.dimension;
                item.dataset.metricRef = row.metricRef;
                item.append(el("strong", "", labels[0] + ": "));
                for (const [count, label, tone] of [[row.counts.pass, labels[1], "positive"], [row.counts.fail, labels[2], "negative"]]) {
                    if (count) parts.push(el("span", tone, row.eligible === 1 ? label : `${number(count)} ${label.toLowerCase()}`));
                }
                parts.forEach((part, index) => { if (index) item.append(doc.createTextNode(", ")); item.append(part); });
                list.append(item);
            }
            // This lists observed reason types, not a pooled request count or a shared population.
            for (const reason of row.unassessedReasons) if (reason.reason !== "no-assessed-units") reasons.add(reason.label);
            if (row.counts.evaluatorError) reasons.add("Evaluator error (not a failed verdict)");
        }
        if (list.childElementCount) group.append(list);
        if (reasons.size) group.append(el("p", "assessment-finding-status", "Unassessed checks: " + [...reasons].join("; ") + "."));
        else if (!list.childElementCount) group.append(el("p", "assessment-finding-status", "No saved verdicts."));
        findings.append(group);
    }
    if (!lanes.size) findings.append(el("p", "assessment-finding-status",
        Object.values(model.evidence.quality).some(group => group.eligible > 0)
            ? "No saved answer or action assessment is available." : "Assessment coverage unavailable."));
    const attemptLabels = {
        failed: "Evaluator could not complete; not a failed quality verdict",
        uncertain: "Evaluator outcome uncertain", unavailable: "Assessment evidence or approval unavailable",
        pending: "Assessment pending", revoked: "Assessment approval withdrawn",
        "not-run": "Not reached by the recorded assessment run", "not-current": "Earlier assessment attempt is not current",
    };
    for (const item of model.findings.answers.filter(item => item.kind === "attempt")) {
        findings.append(el("p", "assessment-finding-status",
            `${attemptLabels[item.state]}${model.findings.singleInteraction ? "" : ` (${number(item.count)} ${item.count === 1 ? "request" : "requests"})`}.`));
    }
    findings.append(el("p", "assessment-finding-limit",
        (model.findings.rationale ? "Verdict reasons not retained. " : "")
        + (model.findings.singleInteraction ? "Original request group only." : "Full interactions, not just matching calls.")));
    if (findingsHost) findingsHost.replaceChildren(findings);
    else section.append(findings);
    const saved = el("details", "assessment-saved-details");
    saved.append(el("summary", "", "Saved assessment details and counts"));
    if (bindDetails) {
        if (!disclosureKey) throw new TypeError("A stable assessment disclosure key is required.");
        bindDetails(saved, disclosureKey);
    }
    saved.append(el("p", "assessment-finding-limit", [model.findings.rationale, model.findings.qualification, model.findings.scope].filter(Boolean).join(" ")));
    const execution = el("section", "assessment-execution");
    execution.append(el("h3", "", "Saved execution checks"));
    for (const row of model.evidence.execution) {
        const observed = el("div", "assessment-observed-fact");
        observed.dataset.observation = row.provenance.checkId;
        const title = row.kind === "execution" ? `Completion-evidence checks (${number(row.eligible)} ${row.eligible === 1 ? "call" : "calls"})` : row.label;
        observed.append(el("h4", "", title));
        if (row.kind === "execution") {
            const facts = el("dl", "assessment-count-strip");
            for (const [label, count, tone] of [
                ["Succeeded", row.counts.pass, ""], ["Failed", row.counts.fail, "negative"],
                ["No qualified outcome", row.counts.unassessed, ""], ["Check errors", row.counts.evaluatorError, ""],
            ]) {
                if (!count && ["No qualified outcome", "Check errors"].includes(label)) continue;
                const item = el("div"), value = el("dd", count ? tone : "", number(count));
                item.append(value, el("dt", "", label)); facts.append(item);
            }
            observed.append(facts, el("p", "assessment-execution-note",
                "This tool-outcome check requires a retained completion event reference and a supported binary tool outcome. Reported outcomes can be available without that evidence."));
        } else {
            const http = ["returned-status-2xx", "graph-output-status-2xx", "owned-http-status-2xx"].includes(row.provenance.checkId);
            observed.append(el("p", "assessment-observation-result", http
                ? `${number(row.counts.pass)} HTTP 2xx; ${number(row.counts.fail)} HTTP 4xx/5xx`
                    + (row.counts.unassessed ? `; ${number(row.counts.unassessed)} other or missing status` : "")
                    + (row.counts.evaluatorError ? `; ${number(row.counts.evaluatorError)} check errors` : "")
                : row.resultLabel));
        }
        execution.append(observed);
    }
    if (!model.evidence.execution.length) execution.append(el("p", "assessment-unavailable", "No tool execution measure is available for this scope."));
    execution.append(el("p", "assessment-execution-note", "Execution observations do not establish answer correctness."));
    saved.append(execution);
    let reviewStatus;
    if (model.reviewStatus) {
        const status = el("div", "assessment-review-status"), facts = el("dl", "assessment-review-facts");
        status.dataset.reviewStatus = "";
        status.setAttribute("aria-label", "Recorded execution and AI quality assessment");
        for (const [label, text, help] of [
            ["AI quality assessment", model.reviewStatus.assessment, ""],
        ]) {
            const row = el("div"), detail = el("dd");
            row.append(el("dt", "", label), detail);
            detail.append(el("p", "", text));
            if (help) detail.append(el("p", "assessment-review-help", help));
            facts.append(row);
        }
        status.append(facts); reviewStatus = status;
    }
    if (model.readingWarning) findings.append(el("p", "assessment-unavailable", model.readingWarning));
    const help = el("details", "assessment-reading-help");
    help.append(el("summary", "", "How to read these results"),
        el("p", "", "AI reviews the recorded evidence and can be wrong. Your feedback and tool outcomes are separate. Matching the request does not prove a person gave permission."),
        el("p", "", "An unassessed request, insufficient evidence and an evaluator error are different states. None means the answer failed or a review is queued."),
        el("p", "", `One request can have several tool calls. Median timing uses the recorded samples, not the total time spent in calls. Open ${detailsLabel} for exact values, denominators, timing boundaries and assessment provenance.`));
    const grid = el("div", "assessment-grid");
    const qualityHeading = el("div", "assessment-quality-heading");
    qualityHeading.append(el("h3", "", "Saved quality assessments"),
        el("p", "assessment-takeaway", "Each check covers only the assessed requests. Missing assessments are not failed answers."));
    grid.append(qualityHeading);
    function cell(label, value, className) {
        const item = el("div", "assessment-cell");
        item.append(el("span", "assessment-cell-label", label), el("p", className, value));
        return item;
    }
    for (const key of ["accuracy", "answer-trust", "action-trust"]) {
        const group = model.evidence.quality[key], host = el("section", "assessment-dimension");
        host.dataset.qualityDimension = key;
        const rows = group.rows.length ? group.rows : [group];
        for (const row of rows) {
            const raw = model.groups[key].find(item => item.metricRef === row.metricRef);
            const fact = el("div", "assessment-fact assessment-check");
            fact.dataset.dimension = key;
            fact.dataset.band = "neutral";
            fact.dataset.bandVersion = model.bandVersion;
            const label = el("div", "assessment-check-title"), title = el("div", "assessment-dimension-heading");
            title.append(el("h4", "assessment-fact-label", row.label ?? model.groups[key][0].reading.label));
            if (helpButton) title.append(helpButton(key === "accuracy" ? "accuracy" : "trust"));
            label.append(title);
            if (row.provenance) label.append(el("p", "assessment-origin", row.provenance.label));
            if (row.provenance?.evaluator && group.rows.filter(other => other.provenance.origin === "model-assessed").length > 1) {
                label.append(el("p", "assessment-origin-detail", row.provenance.evaluator.model),
                    el("p", "assessment-origin-detail", `${row.provenance.evaluator.rubricId} v${row.provenance.evaluator.rubricVersion}`));
            }
            const coverage = cell("Assessment coverage", row.coverageLabel, "assessment-coverage");
            if (row.coverage.eligible > 0 && row.coverage.count !== null) {
                const meter = el("meter", "assessment-coverage-meter");
                meter.min = 0; meter.max = row.coverage.eligible; meter.value = row.coverage.count;
                meter.setAttribute("aria-label", row.coverageLabel);
                coverage.append(meter);
            }
            const result = cell("Recorded verdicts", raw?.personalVerdict ?? row.resultLabel ?? row.headline, "assessment-value");
            if (row.passShare) result.append(el("p", "assessment-pass-share", row.passShare.label));
            if (row.counts && !raw?.personalVerdict && row.assessed > 0) {
                const value = result.querySelector(".assessment-value");
                value.classList.add("assessment-verdicts");
                value.replaceChildren(el("span", row.counts.pass ? "positive" : "", `${number(row.counts.pass)} passed`),
                    doc.createTextNode(" "), el("span", row.counts.fail ? "negative" : "", `${number(row.counts.fail)} failed`));
            }
            const missing = cell("What is missing", row.missingLabel, "assessment-missing");
            const reasonsToShow = row.unassessedReasons?.filter(reason =>
                reason.reason !== "no-assessed-units" || row.unassessedReasons.length > 1) ?? [];
            if (reasonsToShow.length) {
                const reasons = el("ul", "assessment-reasons");
                for (const reason of reasonsToShow) {
                    const item = el("li");
                    item.append(el("strong", "", number(reason.count)), doc.createTextNode(` ${reason.label}`));
                    reasons.append(item);
                }
                missing.append(reasons);
            }
            if (row.counts?.evaluatorError) missing.append(el("p", "assessment-unavailable-reason",
                `${number(row.counts.evaluatorError)} evaluator errors; not failed verdicts`));
            fact.append(label, coverage, result, missing);
            host.append(fact);
        }
        if (group.overlappingAssessments) host.append(el("p", "assessment-overlap", "Assessment lanes may cover the same requests. Do not add their counts."));
        grid.append(host);
    }
    saved.append(grid);
    const attempts = model.evidence.assessmentAttempts;
    if (!reviewStatus) {
        const status = el("section", "assessment-attempts");
        status.append(el("h3", "", "Assessment activity"));
        if (attempts.rows.length) {
            const list = el("ul", "assessment-attempt-list");
            for (const row of attempts.rows) {
                const item = el("li");
                item.dataset.attemptState = row.state;
                item.append(el("strong", "", `${number(row.count)} ${row.count === 1 ? "request" : "requests"}`), el("span", "", row.label));
                list.append(item);
            }
            status.append(list);
        } else status.append(el("p", "assessment-unavailable", attempts.headline));
        if (attempts.status === "partial") status.append(el("p", "assessment-unavailable", attempts.headline));
        if (attempts.rows.some(row => ["failed", "uncertain", "unavailable", "pending"].includes(row.state))) {
            status.append(el("p", "assessment-execution-note", "An unfinished or failed evaluator attempt is not a failed quality verdict."));
        }
        saved.append(status);
    } else saved.append(reviewStatus);
    section.append(saved);
    const timing = el("div");
    renderTiming(timing, model.evidence.timing.filter(row =>
        row.provenance.definitionId !== "interaction-latency" || row.measurement.value !== null), {
        title: detailsLabel === "Measure definitions" ? "Recorded timing in full interactions" : "Recorded timing",
        helpButton: helpButton ? () => helpButton("speed") : null,
    });
    section.append(timing, help);
    root.replaceChildren(section);
    return section;
}

export function renderRecordedTiming(root, rows, { title = "Recorded timing", helpButton, action } = {}) {
    const doc = root.ownerDocument;
    function el(tag, cls, text) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const section = el("section", "assessment-timing");
    section.setAttribute("aria-label", title);
    const heading = el("div", "assessment-heading");
    heading.append(el("h3", "", title));
    if (helpButton) heading.append(helpButton());
    if (action) heading.append(action);
    section.append(heading);
    for (const row of rows) {
        const fact = el("div", "assessment-fact recorded-timing-row");
        fact.dataset.dimension = "speed";
        fact.dataset.timingBoundary = row.measurement.boundary;
        fact.dataset.timingState = row.display.state;
        const identity = el("div");
        identity.append(el("h4", "assessment-fact-label", row.label), el("p", "timing-boundary", row.boundaryLabel));
        const values = el("div", "timing-values");
        for (const [label, value] of row.timed > 1 ? [["Median", row.display.median], ["P95", row.display.p95]]
            : [[row.timed ? "Single measured sample" : "No measured samples", row.display.median]]) {
            const item = el("div");
            item.append(el("span", "assessment-cell-label", label), el("p", "assessment-value", value));
            values.append(item);
        }
        const coverage = el("div", "timing-population");
        coverage.append(el("p", "assessment-coverage", row.coverageLabel));
        if (row.notTimed || !row.eligible) coverage.append(el("p", "assessment-unavailable-reason", row.missingLabel));
        coverage.append(el("p", "assessment-unavailable-reason", row.limitation));
        fact.append(identity, values, coverage);
        if (row.timed > 1 && row.distribution.p95Ms > 0) {
            const scale = el("div", "timing-scale");
            scale.setAttribute("role", "img");
            scale.setAttribute("aria-label", `Linear duration scale from 0 to ${row.display.p95}. Dot: median ${row.display.median}. Line: P95 ${row.display.p95}.`);
            const track = el("div", "timing-track"), median = el("span", "timing-median"), p95 = el("span", "timing-p95");
            median.style.left = `${row.distribution.p50Ms / row.distribution.p95Ms * 100}%`;
            track.append(median, p95);
            scale.append(track, el("span", "timing-scale-key", "0 s \u00b7 Dot = median \u00b7 Line = P95"));
            fact.append(scale);
        }
        const details = el("details", "timing-exact");
        details.append(el("summary", "", "Exact timing and boundary"));
        const facts = el("dl", "timing-exact-facts");
        for (const [label, value] of [
            ["Boundary", row.boundaryLabel], ["Boundary ID", row.measurement.boundary],
            [row.timed === 1 ? "Single sample" : "Median", row.measurement.value === null ? "Not measured" : `${row.measurement.value} ms`],
            ["P95", row.timed > 1 ? `${row.distribution.p95Ms} ms` : "Not shown without multiple samples"],
            ["Population", `${row.coverageLabel}; ${row.notTimed} without recorded timing`],
            ["Method", "Nearest rank over retained samples for this boundary. No summed concurrent calls or averaged medians."],
        ]) {
            const item = el("div");
            item.append(el("dt", "", label), el("dd", "", value));
            facts.append(item);
        }
        details.append(facts); fact.append(details); section.append(fact);
    }
    if (!rows.length) section.append(el("p", "assessment-unavailable", "Not measured. No supported timing samples for this scope."));
    root.replaceChildren(section);
    return section;
}

export const assessmentPresentationStyles = `
#homeInsights,#activityInsights,.interaction-insights {display:flow-root;min-width:0;margin-block:var(--space-xl)}
#homeInsights>.assessment-summary,#activityInsights>.assessment-summary,.interaction-insights>.assessment-summary {margin-block:0}
.assessment-summary {margin-block:var(--space-xl);min-width:0;container:assessment-summary / inline-size}
.assessment-heading {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-sm) var(--space-lg)}
.assessment-heading h2 {font-size:var(--type-section)}
.assessment-heading button {min-height:44px}
.assessment-findings {min-width:0;margin-block:var(--space-md);font-size:var(--type-reading);line-height:1.5;overflow-wrap:anywhere}
.assessment-findings h3 {font-size:var(--type-section);margin:0 0 var(--space-md)}
.assessment-finding-group {margin-block:var(--space-md)}
.assessment-finding-group h4 {font-weight:var(--weight-medium);margin:0 0 var(--space-xs)}
.assessment-finding-list {list-style:none;margin:0;padding:0;display:grid;gap:var(--space-xs)}
.assessment-compact-verdicts {list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-xs) var(--space-lg)}
.assessment-compact-verdicts li {min-width:0}
.assessment-compact-verdicts strong {font-weight:var(--weight-medium)}
.assessment-finding-status {font-size:var(--type-small);line-height:1.5;margin:var(--space-xs) 0}
.assessment-findings .positive {color:var(--performance-teal)}
.assessment-findings .negative {color:var(--performance-red)}
.assessment-finding-limit,.assessment-finding-recovery {font-size:var(--type-small);margin:var(--space-sm) 0 0;max-width:85ch}
.assessment-finding-limit {color:var(--muted)}
.assessment-saved-details {margin-block:var(--space-md);min-width:0}
.assessment-saved-details>summary {min-height:44px;align-content:center;cursor:pointer;width:fit-content;font-size:var(--type-reading);font-weight:var(--weight-medium)}
.assessment-saved-details>summary:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.assessment-pass-share {font-size:var(--type-small);line-height:1.5;color:var(--muted);margin:var(--space-xs) 0 0}
.assessment-takeaway {margin-block:var(--space-xs) var(--space-lg);max-width:72ch;font-size:var(--type-small);color:var(--muted)}
.assessment-execution {margin-block:var(--space-lg) var(--space-xl);padding:var(--space-lg);background:var(--canvas);border-radius:var(--radius-small)}
.assessment-execution h3,.assessment-attempts h3 {font-size:var(--type-small);font-weight:var(--weight-strong);margin:0 0 var(--space-sm)}
.assessment-observed-fact {display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-sm) var(--space-2xl)}
.assessment-observed-fact h4 {font-size:var(--type-reading);font-weight:var(--weight-medium);margin:0}
.assessment-observed-fact .assessment-execution-note {flex-basis:100%}
.assessment-observed-fact+.assessment-observed-fact {margin-top:var(--space-md);padding-top:var(--space-md);border-top:1px solid var(--rule)}
.assessment-count-strip {display:flex;flex-wrap:wrap;gap:var(--space-lg) var(--space-2xl);margin:0;font-variant-numeric:tabular-nums}
.assessment-count-strip dd {margin:0;font-size:var(--type-data-value);font-weight:var(--weight-strong)}
.assessment-count-strip dt {font-size:var(--type-caption);color:var(--muted)}
.assessment-execution-note,.assessment-observation-result {font-size:var(--type-small);line-height:1.5;margin:var(--space-sm) 0 0;color:var(--muted)}
.assessment-observation-result {margin:0}
.assessment-attempts {margin-top:var(--space-lg);padding-top:var(--space-lg);border-top:1px solid var(--rule)}
.assessment-attempt-list {display:flex;flex-wrap:wrap;gap:var(--space-md) var(--space-2xl);list-style:none;padding:0;margin:0}
.assessment-attempt-list li {display:grid;gap:var(--space-xs);font-size:var(--type-small)}
.assessment-attempt-list span {color:var(--muted)}
.assessment-scoring-status {margin-block:var(--space-sm);font-size:var(--type-caption);line-height:1.5;color:var(--muted)}
.assessment-grid {display:grid;grid-template-columns:1fr;margin-top:var(--space-md)}
.assessment-quality-heading h3,.assessment-timing h3 {font-size:var(--type-section);margin:0}
.assessment-quality-heading .assessment-takeaway {margin-block:var(--space-xs) var(--space-lg)}
.assessment-scope {margin-block:var(--space-md) 0;padding-top:var(--space-md);border-top:1px solid var(--rule);max-width:none;font-size:var(--type-caption);line-height:1.5;color:var(--muted)}
.assessment-dimension {min-width:0;border-top:1px solid var(--rule)}
.assessment-dimension-heading {display:block;font-size:var(--type-reading);line-height:var(--leading-ui)}
.assessment-dimension-heading h3,.assessment-dimension-heading h4 {display:inline;margin:0}
.assessment-dimension-heading>.ux-help {margin-inline-start:var(--help-gap)}
.assessment-fact {display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-md) var(--space-xl);min-width:0;overflow-wrap:anywhere;padding-block:var(--space-lg)}
.assessment-fact + .assessment-fact {border-top:1px solid var(--rule)}
.assessment-fact-label {margin:0;font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-strong);color:var(--ink)}
.assessment-value,.assessment-coverage {font-size:var(--type-reading);font-weight:var(--weight-strong);line-height:1.5;margin:0;font-variant-numeric:tabular-nums}
.assessment-missing {font-size:var(--type-small);font-weight:var(--weight-medium);line-height:1.5;margin:0}
.assessment-reasons {list-style:none;padding:0;margin:var(--space-sm) 0 0;display:grid;gap:var(--space-xs);font-size:var(--type-caption);line-height:1.5;color:var(--muted)}
.assessment-coverage-meter {display:block;width:100%;max-width:15rem;height:6px;margin-top:var(--space-sm);border:0;background:var(--rule);border-radius:3px}
.assessment-coverage-meter::-webkit-meter-bar {background:var(--rule);border:0;border-radius:3px}
.assessment-coverage-meter::-webkit-meter-optimum-value {background:var(--accent)}
.assessment-coverage-meter::-moz-meter-bar {background:var(--accent)}
.assessment-verdicts {display:flex;flex-wrap:wrap;gap:var(--space-xs) var(--space-lg)}
.assessment-verdicts span {white-space:nowrap}
.assessment-summary .positive {color:var(--performance-teal)}
.assessment-summary .negative {color:var(--performance-red)}
.assessment-overlap {font-size:var(--type-small);line-height:1.5;color:var(--muted);margin-block:0 var(--space-md)}
.assessment-cell {min-width:0}
.assessment-cell-label {display:block;font-size:var(--type-caption);line-height:1.5;color:var(--muted);margin-bottom:var(--space-xs)}
.assessment-timing {margin-block:var(--space-xl);padding-top:var(--space-lg);border-top:1px solid var(--rule)}
.assessment-timing .assessment-value {font-size:var(--type-data-value)}
.assessment-timing .assessment-heading>a {display:inline-flex;align-items:center;min-height:44px}
.recorded-timing-row {display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-md) var(--space-xl);padding-block:var(--space-lg);min-width:0;overflow-wrap:anywhere}
.recorded-timing-row+.recorded-timing-row {border-top:1px solid var(--rule)}
.timing-boundary,.timing-scale-key {font-size:var(--type-caption);color:var(--muted);line-height:1.5;margin:var(--space-xs) 0 0}
.timing-values {display:flex;flex-wrap:wrap;gap:var(--space-md) var(--space-xl)}
.timing-values>div {min-width:0}
.timing-scale {grid-column:1/-1;max-width:36rem;min-width:0}
.timing-track {position:relative;height:2px;margin:var(--space-sm) 6px var(--space-md);background:var(--muted)}
.timing-median {position:absolute;top:50%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:var(--ink)}
.timing-p95 {position:absolute;right:0;top:50%;transform:translate(50%,-50%);height:16px;width:3px;background:var(--ink)}
.timing-exact {grid-column:1/-1;min-width:0;font-size:var(--type-small)}
.timing-exact summary {min-height:44px;align-content:center;cursor:pointer;width:fit-content}
.timing-exact summary:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.timing-exact-facts {margin:var(--space-sm) 0;display:grid;gap:var(--space-sm);line-height:1.5}
.timing-exact-facts>div {display:flex;flex-wrap:wrap;gap:var(--space-xs) var(--space-lg)}
.timing-exact-facts dt {font-weight:var(--weight-strong)}
.timing-exact-facts dd {margin:0;min-width:0}
#recordedTiming {container:recorded-timing / inline-size}
@container recorded-timing (min-width:42rem) {
 .recorded-timing-row {grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.3fr)}
}
@container assessment-summary (min-width:42rem) {
 .recorded-timing-row {grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.3fr)}
 .assessment-fact {grid-template-columns:minmax(0,1.15fr) minmax(0,1fr) minmax(0,1.4fr)}
 .assessment-check {grid-template-columns:minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,.8fr) minmax(0,1.3fr)}
 .assessment-check-title {align-self:center}
}
.assessment-origin,.assessment-origin-detail,.assessment-qualification,.assessment-unavailable-reason {font-size:var(--type-caption);line-height:1.5;color:var(--muted);margin:var(--space-xs) 0 0}
.assessment-origin {font-weight:var(--weight-medium)}
.assessment-reading-help {font-size:var(--type-small);color:var(--muted)}
.assessment-reading-help summary {min-height:44px;align-content:center;cursor:pointer;width:fit-content}
.assessment-reading-help p {max-width:80ch;line-height:1.5;margin-block:var(--space-sm)}
.assessment-review-status {margin-block:var(--space-md);font-size:var(--type-small);line-height:1.5}
.assessment-review-facts {margin:0;display:grid;gap:var(--space-md)}
.assessment-review-facts>div {display:grid;grid-template-columns:minmax(0,11rem) minmax(0,1fr);gap:var(--space-md)}
.assessment-review-facts dt {font-weight:var(--weight-strong)}
.assessment-review-facts dd {margin:0;min-width:0}
.assessment-review-facts p {margin:0;max-width:90ch;overflow-wrap:anywhere}
.assessment-review-facts .assessment-review-help {margin-top:var(--space-xs);color:var(--muted)}
@container assessment-summary (max-width:600px) {.assessment-review-facts>div {grid-template-columns:1fr;gap:var(--space-xs)}}
.assessment-fact-unavailable .assessment-value {color:var(--muted)}
.assessment-fact[data-band=red] .assessment-value {color:var(--performance-red)}
.assessment-fact[data-band=orange] .assessment-value {color:var(--performance-orange)}
.assessment-fact[data-band=gold] .assessment-value {color:var(--performance-gold)}
.assessment-fact[data-band=teal] .assessment-value {color:var(--performance-teal)}
.assessment-dialog {width:min(44rem,calc(100% - 24px));max-width:calc(100% - 24px);max-height:calc(100dvh - 24px);overflow:hidden;padding:0;scroll-padding:0}
.assessment-dialog[open] {display:flex;flex-direction:column}
.assessment-dialog>.dialog-head {flex:none;gap:var(--space-sm);padding:var(--space-lg) var(--space-xl);min-width:0}
.assessment-dialog>.dialog-head h2 {min-width:0;overflow-wrap:anywhere}
.assessment-dialog>.dialog-head button {flex:none;min-height:44px}
.assessment-dialog-body {min-height:0;overflow:auto;overscroll-behavior:contain;padding:var(--space-lg) var(--space-xl)}
html:has(.assessment-dialog:modal) {overflow:hidden;scrollbar-gutter:stable}
.assessment-dialog h2 {font-size:var(--type-section)}
.assessment-dialog p {margin-block:var(--space-sm);font-size:var(--type-small)}
.assessment-dialog label {display:flex;flex-direction:column;gap:var(--space-sm);margin-block:var(--space-lg)}
.assessment-definition {padding-block:var(--space-md);border-bottom:1px solid var(--rule)}
.assessment-definition h3 {font-size:var(--type-small)}
.assessment-detail-facts {display:grid;gap:var(--space-sm);padding-left:var(--space-lg);font-size:var(--type-small);line-height:1.5}
.measure-glossary dt {font-size:var(--type-small);font-weight:var(--weight-strong)}
.measure-glossary dd {margin:var(--space-xs) 0 0;font-size:var(--type-small);line-height:1.5;color:var(--muted)}
.assessment-band-note,.assessment-unavailable,.assessment-loading {color:var(--muted);font-size:var(--type-small)}
.assessment-control-actions {display:flex;flex-wrap:wrap;gap:var(--space-sm);margin-block:var(--space-lg)}
.assessment-control-actions button {min-height:44px}
.assessment-applied {font-weight:var(--weight-strong)}
#assessmentSetup label {display:flex;align-items:center;gap:var(--space-sm);min-height:44px}
#assessmentSetup p {margin-block:var(--space-sm)}
.interaction-response {margin-block:var(--space-xl)}
.interaction-response>p {color:var(--muted);font-size:var(--type-small);margin-block:var(--space-sm)}
#comparisonWorkspace {margin-block:var(--space-2xl);padding-block:var(--space-xl);border-top:1px solid var(--rule)}
.comparison-selectors {display:flex;flex-wrap:wrap;gap:var(--space-lg);margin-block:var(--space-lg)}
.comparison-selectors>label {display:flex;flex:1 1 16rem;min-width:0;flex-direction:column;gap:var(--space-sm)}
.comparison-selectors>.select-field {flex:1 1 16rem;min-width:0}
.comparison-selectors select {width:100%;min-width:0}
.comparison-review {margin-top:var(--space-xl)}
.comparison-review fieldset {display:flex;flex-wrap:wrap;gap:var(--space-lg);border:0;padding:0}
.comparison-review label {display:flex;align-items:center;gap:var(--space-sm);min-height:44px}
.comparison-review>button {margin-block:var(--space-sm);margin-right:var(--space-sm)}
@media(max-width:600px) {
 .assessment-grid {gap:var(--space-lg)}
}
`;
