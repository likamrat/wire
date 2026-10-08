// The backend supplies validated, already-pooled facts; this factory only presents them.
export function createAssessmentPresentation({ validateMetric, metricSlotKey }) {
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
        "missing-evidence": "The required evidence was not retained.",
        "missing-completion": "No completion was recorded.",
        "nonbinary-outcome": "The recorded outcome is not a pass or fail.",
        "unsupported-check": "Local observations do not assess this. Review Automatic scores for model assessment.",
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
        "capture-limit": "Only bounded evidence could be retained.",
        "partial-evidence": "Only part of the evidence was retained.",
        "unverified-association": "Association with this interaction is unverified.",
        "invalid-timing": "The recorded times cannot establish this duration.",
        "usage-unavailable": "No attributed usage or charge was recorded.",
        "pricing-unavailable": "Usage has no compatible price.",
        "no-eligible-units": "No eligible items in this scope.",
        "no-assessed-units": "No eligible items have an assessed result.",
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
            accuracy: "No current answer assessment. Review Automatic scores; feedback is optional.",
            "answer-trust": "No current answer-support assessment. Review Automatic scores.",
            "action-trust": "No current action assessment. Model scores check intent alignment, not authorization.",
            speed: "No verified request-to-final-answer timing.",
        };
        const qualification = cost && metric.value !== null
            ? `${metric.status === "estimated" ? "Estimated" : "Recorded"} ${metric.coverage.covered < metric.coverage.eligible ? "subtotal" : "total"} (USD). ${boundaryLabels[metric.boundary]}.`
            : metric.value === null ? metric.reason === "unsupported-check" ? unsupported[metric.dimension] ?? reasonLabels[metric.reason]
                : reasonLabels[metric.reason] : metric.origin === "model-assessed"
                    ? metric.dimension === "action-trust" ? "Recorded intent alignment, not proof of authorization."
                        : "Assessed against recorded evidence, not independent ground truth."
                    : boundaryLabels[metric.boundary];
        const details = [
            `${label}. ${origin}.`,
            `${value}. ${coverage}. ${qualification}`,
            `Definition ${metric.definitionId} v${metric.definitionVersion}${metric.checkId ? `; ${metric.checkId} v${metric.checkVersion}` : ""}.`,
            `Boundary: ${boundaryLabels[metric.boundary]}.`,
        ];
        if (metric.counts) details.push(`${number(metric.counts.pass)} passed, ${number(metric.counts.fail)} failed, ${number(metric.counts.unassessed)} unassessed, ${number(metric.counts.evaluatorError)} check errors.`);
        if (metric.pricing) details.push(`${metric.pricing.method === "recorded-charge" ? "Recorded charge" : "Versioned rate card"}, pricing version ${metric.pricing.version}.`);
        if (metric.evaluator) details.push(`Model ${metric.evaluator.model}; rubric ${metric.evaluator.rubricId} v${metric.evaluator.rubricVersion}. ${metric.dimension === "action-trust" ? "Intent alignment, not proof of authorization." : "Model-assessed against recorded evidence, not independent ground truth."}`);
        const timingSummary = {
            "tool-duration": { label: "Tool calls", unit: "calls" },
            "recorded-response-duration": { label: "Request to final response", unit: "requests" },
        }[metric.definitionId];
        return {
            metricRef: metric.metricRef, dimension: metric.dimension, label, value, coverage, qualification, origin, personalVerdict,
            ...(timingSummary ? { summary: {
                label: timingSummary.label,
                coverage: `${metric.value !== null ? "Median \u00b7 " : ""}${number(metric.coverage.covered)} / ${number(metric.coverage.eligible)} ${timingSummary.unit} timed`,
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
            band: "neutral", bandVersion, status: "unavailable", details: [`${dimensionLabels[dimension]}: no metric or coverage was supplied for this scope.`], basis: null,
        };
    }
    function summarize(metrics, { membershipStatus = "complete-retained", singleInteraction = false } = {}) {
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
        if (membershipStatus !== "complete-retained") takeaway = "Only part of this interaction can be attributed; the summary covers retained evidence only.";
        else if (personalAccuracy?.counts.fail) takeaway = "Your feedback identifies an incorrect result; recorded tool outcomes remain separate.";
        else if (failedTools?.counts.fail) takeaway = `${number(failedTools.counts.fail)} / ${number(failedTools.denominator)} tool completions with a recorded success/failure result failed. Execution status is separate from model assessment.`;
        else if (!accuracyMeasured && !trustMeasured) takeaway = timed
            ? "Call timing is available; answer correctness and both kinds of trust are unassessed."
            : "Answer correctness and both kinds of trust are unassessed; missing evidence is not a failed result.";
        else if (personalAccuracy) takeaway = "Your accuracy feedback is shown separately from automatic local observations.";
        else if (metrics.some(metric => metric.origin === "model-assessed")) takeaway = "Model assessments use recorded evidence. Each check keeps its own result and coverage; no overall grade is assigned.";
        else takeaway = "Supported facts and personal feedback are shown separately; no overall grade is assigned.";
        return { groups, diagnostics, takeaway, bandVersion };
    }
    return { format, summarize, band, bandVersion };
}

// DOM-only; this renderer cannot fetch, assess, save feedback, or enable capture.
export function renderAssessmentSummary(root, model, { onDetails, helpButton, detailsLabel = "Details and feedback" } = {}) {
    if (typeof onDetails !== "function") throw new TypeError("A details path is required for definitions and unavailable reasons.");
    const doc = root.ownerDocument;
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
    section.append(heading, el("p", "assessment-takeaway", model.takeaway));
    const grid = el("div", "assessment-grid");
    function appendRows(host, rows, title) {
        for (const row of rows) {
            const value = el("div", "assessment-fact");
            const available = ["measured", "estimated"].includes(row.status);
            value.classList.toggle("assessment-fact-unavailable", !available);
            value.classList.toggle("assessment-speed-fact", Boolean(row.summary));
            value.dataset.dimension = row.dimension;
            value.dataset.band = row.band;
            value.dataset.bandVersion = row.bandVersion;
            const pairedPersonal = rows.some(other => other.dimension === row.dimension && other.origin === "Your feedback");
            const originLabel = row.origin === "Model assessment" ? "Model assessment" : row.origin === "Your feedback" ? row.personalVerdict ? "Your feedback:" : "Your feedback"
                : row.origin === "Automatic local observation" && pairedPersonal ? "Automatic" : "";
            const showLabel = row.label !== title && (available || rows.length > 1 || title === "Trust" || row.summary);
            if (showLabel) value.append(el(row.summary ? "h4" : "p", "assessment-fact-label",
                row.summary?.label ?? (!available && originLabel && row.origin !== "Model assessment" ? `${row.label} (${originLabel})` : row.label)));
            if (originLabel && (available || !showLabel || row.origin === "Model assessment")) value.append(el("p", "assessment-origin", originLabel));
            value.append(el("p", "assessment-value", row.value));
            value.append(el("p", "assessment-coverage", row.summary?.coverage ?? row.coverage));
            if (available && !row.summary) value.append(el("p", "assessment-qualification", row.qualification));
            else if (!available) value.append(el("p", "assessment-unavailable-reason", row.qualification));
            host.append(value);
        }
    }
    for (const [key, title] of [["accuracy", "Accuracy"], ["speed", "Speed"], ["trust", "Trust"]]) {
        const group = el("section", "assessment-dimension");
        const heading = el("div", "assessment-dimension-heading");
        heading.append(el("h3", "", title));
        if (helpButton) heading.append(helpButton(key));
        group.append(heading);
        let rows = key === "trust" ? [...model.groups["answer-trust"], ...model.groups["action-trust"]] : model.groups[key];
        if (key === "speed") {
            const available = rows.filter(row => row.status === "measured");
            rows = available.length ? available : rows.slice(0, 1);
        }
        group.dataset.compact = String(rows.length === 1 && !rows[0].summary && !["measured", "estimated"].includes(rows[0].status));
        appendRows(group, rows, title);
        grid.append(group);
    }
    section.append(grid);
    root.replaceChildren(section);
    return section;
}

export const assessmentPresentationStyles = `
#homeInsights,#activityInsights,.interaction-insights {display:flow-root;min-width:0;margin-block:var(--space-xl)}
#homeInsights>.assessment-summary,#activityInsights>.assessment-summary,.interaction-insights>.assessment-summary {margin-block:0}
.assessment-summary {margin-block:var(--space-xl);min-width:0}
.assessment-heading {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-sm) var(--space-lg)}
.assessment-heading h2 {font-size:var(--type-section)}
.assessment-heading button {min-height:44px}
.assessment-takeaway {margin-block:var(--space-xs) var(--space-lg);max-width:72ch;font-size:var(--type-small);color:var(--muted)}
.assessment-scoring-status {margin-block:var(--space-sm);font-size:var(--type-caption);line-height:1.5;color:var(--muted)}
.assessment-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:var(--space-xl);padding-block:var(--space-lg);border-top:1px solid var(--rule)}
.assessment-scope {margin-block:var(--space-md) 0;padding-top:var(--space-md);border-top:1px solid var(--rule);max-width:none;font-size:var(--type-caption);line-height:1.5;color:var(--muted)}
.assessment-dimension {min-width:0}
.assessment-dimension h3 {margin:0 0 var(--space-sm);font-size:var(--type-small);font-weight:var(--weight-strong)}
.assessment-dimension-heading {display:flex;align-items:center;gap:var(--space-xs);margin-bottom:var(--space-sm)}
.assessment-dimension-heading h3 {margin:0}
.assessment-fact {min-width:0}
.assessment-fact + .assessment-fact {margin-top:var(--space-md)}
.assessment-speed-fact {display:block}
.assessment-speed-fact + .assessment-speed-fact {margin-top:var(--space-lg);padding-top:var(--space-lg);border-top:1px solid var(--rule)}
.assessment-speed-fact .assessment-fact-label {margin:0;font-size:var(--type-small);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.assessment-speed-fact .assessment-value {margin-block:var(--space-sm) var(--space-xs)}
.assessment-speed-fact .assessment-coverage {margin:0;line-height:var(--leading-ui)}
.assessment-speed-fact .assessment-unavailable-reason {margin-top:var(--space-xs)}
.assessment-fact-unavailable {display:flex;align-items:baseline;flex-wrap:wrap;gap:var(--space-xs) var(--space-sm)}
.assessment-fact-unavailable .assessment-coverage {flex-basis:100%;margin:0}
.assessment-unavailable-reason {flex-basis:100%;font-size:var(--type-caption);line-height:1.5;color:var(--muted);margin:0}
.assessment-fact-label,.assessment-origin,.assessment-coverage,.assessment-qualification {font-size:var(--type-caption);color:var(--muted)}
.assessment-origin {font-weight:var(--weight-strong)}
.assessment-value {font-size:var(--type-data-value);font-weight:var(--weight-strong);line-height:var(--leading-data-value);margin-block:var(--space-xs)}
.assessment-fact-unavailable .assessment-value {font-size:var(--type-small);font-weight:var(--weight-medium);color:var(--muted);margin:0}
.assessment-speed-fact.assessment-fact-unavailable {display:block}
.assessment-speed-fact.assessment-fact-unavailable .assessment-value {margin-block:var(--space-sm) var(--space-xs)}
.assessment-coverage {color:var(--ink)}
.assessment-qualification {margin-top:var(--space-xs)}
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
 .assessment-dimension[data-compact=true] {display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:var(--space-sm)}
 .assessment-dimension[data-compact=true] h3 {margin:0}
}
`;
