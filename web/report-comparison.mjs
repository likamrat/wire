export function createReportComparison() {
    const presentation = Object.freeze({ schemaVersion: 1, performanceBands: Object.freeze({
        id: "assessed-pass-share-v1", unit: "percent", thresholds: Object.freeze([50, 75, 90]), unavailable: "neutral",
    }) });
    const dimensions = { accuracy: "Accuracy", speed: "Speed", cost: "Cost", "answer-trust": "Trust: answers", "action-trust": "Trust: actions" };
    const labels = { success: "Succeeded", failure: "Failed", partial: "Partial", unknown: "Unknown", other: "Other", transport: "No response" };
    const reasons = {
        "unsupported-check": "No supported check for this evidence",
        "missing-evidence": "Not enough recorded evidence",
        "usage-unavailable": "No attributable usage recorded",
        "pricing-unavailable": "Recorded usage has no price",
        "no-assessed-units": "No assessed interactions",
        "evaluator-failure": "Assessment could not be completed",
        "metric-not-saved": "This measure was not saved",
        "baseline-metric-not-saved": "Not saved in the earlier report",
        "later-metric-not-saved": "Not saved in the later report",
        "unverified-association": "The action-to-interaction association is not verified",
        "missing-completion": "No completion was recorded",
        "nonbinary-outcome": "The recorded result is neither a pass nor a fail",
        "capture-disabled": "Optional response capture is off",
        "category-not-consented": "This evidence category is not enabled",
        "no-eligible-units": "No eligible items in this scope",
        "user-verdict": "Your optional personal feedback",
        "user-withdrawn": "Personal feedback was withdrawn",
        "not-applicable": "This check does not apply to this recorded interaction",
    };
    const formatNumber = (value, maximumFractionDigits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
    function formatValue(value, unit) {
        if (!Number.isFinite(value)) throw new TypeError("Comparison values must be finite.");
        if (unit === "percent" || unit === "percentage-points") {
            const suffix = unit === "percent" ? "%" : " pp";
            if (value !== 0 && Math.abs(value) < 0.01) return `${value < 0 ? "−" : ""}<0.01${suffix}`;
            const displayed = unit === "percent" ? Math.floor(value * 100) / 100 : value;
            return `${formatNumber(displayed, 2)}${suffix}`;
        }
        if (unit === "ms") return value > 0 && value < 0.01 ? "<0.01 ms"
            : Math.abs(value) >= 1000 ? `${formatNumber(value / 1000, 2)} s` : `${formatNumber(value, 2)} ms`;
        if (/^[A-Z]{3}$/.test(unit)) {
            const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: unit, minimumFractionDigits: 2, maximumFractionDigits: 6 });
            return value > 0 && value < 0.000001 ? `<${amount.format(0.000001)}` : amount.format(value);
        }
        throw new TypeError("Unsupported comparison display unit.");
    }
    function scoreTone(fact) {
        if (fact?.state !== "available" || fact.kind !== "pass-rate" || fact.unit !== "percent") return "";
        return fact.value < 50 ? "performance-red" : fact.value < 75 ? "performance-orange" : fact.value < 90 ? "performance-gold" : "performance-teal";
    }
    function modelOrigin(fact) {
        const qualifiers = fact.qualifiers ?? {};
        let label = `Model assessment${qualifiers.evaluatorModel ? ` · ${qualifiers.evaluatorModel}` : ""}`;
        if (qualifiers.rubricId != null || qualifiers.rubricVersion != null) {
            label += ` · rubric ${qualifiers.rubricId ?? "ID not saved"}${qualifiers.rubricVersion != null
                ? ` v${qualifiers.rubricVersion}` : " (version not saved)"}`;
        }
        return label;
    }
    function metricPresentation(fact, dimension) {
        let note = "Not saved in this report";
        const timedUnit = fact?.boundary === "tool-start-to-completion" ? "calls"
            : ["recorded-request-to-final-answer", "verified-request-to-final-answer"].includes(fact?.boundary) ? "requests" : "HTTP records";
        if (fact?.state !== "available" && fact) {
            const unsupported = {
                accuracy: "Local observations do not assess answer correctness; model assessment requires separate approval",
                "answer-trust": "Local observations do not assess answer support; model assessment requires separate approval",
                "action-trust": "Local observations do not assess authorization; model assessment checks recorded intent separately",
            };
            note = fact.reason === "unsupported-check" ? unsupported[dimension] ?? reasons[fact.reason]
                : fact.reason === "unverified-association" && fact.boundary === "verified-request-to-final-answer"
                    ? "No verified request-to-final-answer timing"
                    : reasons[fact.reason] ?? `Unavailable: ${fact.reason}`;
            if (fact.basis === "model-assessment") note = `${modelOrigin(fact)} · ${note}`;
            if (fact.coverage) note += ` · ${formatNumber(fact.coverage.count, 0)} of ${formatNumber(fact.coverage.eligible, 0)} ${fact.kind === "pass-rate" ? "assessed" : fact.kind === "cost" ? "units priced" : `${timedUnit} timed`}`;
        }
        if (fact?.state === "available") {
            const covered = fact.coverage.count, eligible = fact.coverage.eligible;
            note = fact.kind === "pass-rate"
                ? `${fact.basis === "user-assessment" ? "Personal assessment" : fact.basis === "model-assessment" ? modelOrigin(fact) : "Recorded check"} · ${formatNumber(fact.numerator, 0)} of ${formatNumber(fact.denominator, 0)} passed · ${formatNumber(covered, 0)} of ${formatNumber(eligible, 0)} assessed · ${formatNumber(eligible - covered, 0)} not assessed${fact.basis === "model-assessment" && dimension === "action-trust" ? " · intent alignment, not proof of authorization" : ""}`
                : `${formatNumber(covered, 0)} of ${formatNumber(eligible, 0)} ${fact.kind === "cost" ? "units priced" : `${timedUnit} timed`}`;
        }
        if (fact?.counts?.evaluatorError) note += ` · ${formatNumber(fact.counts.evaluatorError, 0)} check errors (not failed results)`;
        return {
            value: !fact ? "Not saved" : fact.state === "available" ? formatValue(fact.value, fact.unit) : fact.reason === "not-applicable" ? "Not applicable" : fact.reason === "evaluator-failure" ? "Check unavailable"
                : fact?.kind === "pass-rate" || ["accuracy", "answer-trust", "action-trust"].includes(dimension) ? "Not assessed" : "Not measured",
            note, tone: scoreTone(fact),
        };
    }
    function comparisonSidePresentation(metric, side) {
        const presentSide = metric.reason === "later-metric-not-saved" ? "baseline"
            : metric.reason === "baseline-metric-not-saved" ? "later" : null;
        if (side === presentSide && !Object.hasOwn(metric, side)) return {
            value: "Not preserved",
            note: "This older comparison did not retain the metric summary. No value has been reconstructed.",
            tone: "",
        };
        return metricPresentation(metric[side], metric.metric);
    }
    function metricDefinitionLabel(metric) {
        const fact = metric.baseline ?? metric.later;
        if (!fact) {
            const side = metric.reason === "later-metric-not-saved" ? "baseline" : metric.reason === "baseline-metric-not-saved" ? "later" : null;
            return side && !Object.hasOwn(metric, side) ? "Older comparison summary" : "";
        }
        if (fact.kind === "duration") return ({
            "tool-start-to-completion": "Median tool-call duration",
            "http-dispatch-to-response-headers": "Median HTTP response time",
            "http-dispatch-to-transport-error": "Median time to transport error",
            "verified-request-to-final-answer": "Whole-interaction time",
            "recorded-request-to-final-answer": "Time to recorded final response",
        })[fact.boundary] ?? fact.boundary;
        if (fact.kind === "cost") return fact.basis === "estimated" ? "Estimated attributed subtotal" : fact.basis === "observed" ? "Recorded attributed subtotal" : "Attributed cost";
        return fact.basis === "user-assessment" ? "Your feedback"
            : fact.basis === "model-assessment" ? `${modelOrigin(fact)}${fact.metric === "action-trust" ? " · intent alignment" : ""}`
            : fact.basis === "automatic-assessment" ? fact.reason === "unsupported-check" ? "Local observation (not a model assessment)" : "Automatic local checks"
                : fact.basis === "mixed-assessment" ? "Mixed assessments" : "Recorded checks";
    }
    function metricGroups(metrics) {
        const available = metrics.filter(metric => metric.baseline?.state === "available" || metric.later?.state === "available");
        const unavailable = metrics.filter(metric => !available.includes(metric));
        return { available, unavailable, unavailableLabel: [...new Set(unavailable.map(metric =>
            metric.metric === "speed" ? metricDefinitionLabel(metric) || dimensions.speed : dimensions[metric.metric]))].join(" · ") };
    }
    function render(root, model, { onInspectPattern } = {}) {
        if (!root?.ownerDocument || typeof root.replaceChildren !== "function") throw new TypeError("Comparison rendering requires a document element.");
        if (!model || model.schemaVersion !== 1 || !Array.isArray(model.metrics)) throw new TypeError("Comparison rendering requires a supported model.");
        const document = root.ownerDocument;
        const el = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = String(text);
            return node;
        };
        const panel = el("section", "report-comparison");
        panel.setAttribute("aria-label", "Report comparison");
        if (model.displayCompatibility?.mode === "frozen-source-facts-only") {
            panel.append(el("p", "comparison-notice", model.displayCompatibility.message));
        }
        if (model.reason === "same-snapshot") {
            panel.append(el("p", "comparison-notice", "Choose two different saved reports."));
            root.replaceChildren(panel);
            return;
        }
        if (model.narrative) {
            const narrative = el("div", "comparison-takeaway");
            narrative.append(el("h2", "", model.narrative.heading), el("p", "muted", model.narrative.detail));
            panel.append(narrative);
        } else if (model.status === "unavailable") {
            panel.append(el("p", "comparison-notice", "These report facts are not compatible. The original reports remain unchanged."));
        }
        function metricCell(metric, side) {
            const cell = el("td");
            const sideLabel = el("span", "comparison-mobile-label", side === "baseline" ? "Earlier" : "Later");
            sideLabel.setAttribute("aria-hidden", "true");
            const presentation = comparisonSidePresentation(metric, side);
            const value = el("strong", `comparison-metric-value ${presentation.tone}`, presentation.value);
            cell.append(sideLabel, value, el("span", "comparison-meta", presentation.note));
            return cell;
        }
        function metricTable(metrics, label) {
            const table = el("table", "comparison-metrics");
            const caption = el("caption", "", label);
            table.append(caption);
            const head = el("thead"), header = el("tr");
            for (const title of ["Measure", "Earlier report", "Later report", "Change"]) {
                const cell = el("th", "", title);
                cell.scope = "col";
                header.append(cell);
            }
            head.append(header);
            table.append(head);
            const body = el("tbody");
            for (const metric of metrics) {
                if (!Object.hasOwn(dimensions, metric.metric)) throw new TypeError("Comparison contains an unknown dimension.");
                const row = el("tr");
                const title = el("th", "", dimensions[metric.metric]);
                title.scope = "row";
                const detail = metricDefinitionLabel(metric);
                if (detail) title.append(el("span", "comparison-meta", detail));
                row.append(title, metricCell(metric, "baseline"), metricCell(metric, "later"));
                const change = el("td");
                const mobile = el("span", "comparison-mobile-label", "Change");
                mobile.setAttribute("aria-hidden", "true");
                change.append(mobile);
                if (metric.status === "comparable" && metric.delta) {
                    const delta = metric.delta;
                    change.append(el("strong", "comparison-delta", delta.value === 0 ? "Unchanged" : `${delta.value > 0 ? "+" : "−"}${formatValue(Math.abs(delta.value), delta.unit)}`));
                    if (metric.warnings?.includes("coverage-decreased")) change.append(el("span", "comparison-meta", "Less evidence assessed or measured"));
                    else if (metric.warnings?.includes("total-cost-volume-differs")) change.append(el("span", "comparison-meta", "Different volume; not cost per task"));
                    else if (delta.unit === "percentage-points") change.append(el("span", "comparison-meta", "Percentage points"));
                } else {
                    change.append(el("span", "muted", metric.status === "incompatible" ? "Different definitions" : "Not comparable"));
                    if (metric.reason) change.append(el("span", "comparison-meta", reasons[metric.reason] ?? metric.reason));
                }
                row.append(change);
                body.append(row);
            }
            table.append(body);
            return table;
        }
        let patternTable;
        const tool = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
        const evidence = model.primaryEvidence ?? { heading: "Recorded tool results", scoreLabel: "Recorded tool success", unitLabel: "calls", successVerb: "succeeded", note: "Tool execution is separate from answer accuracy and trust." };
        if (tool) {
            const section = el("section", "comparison-tool-results");
            section.append(el("h2", "", evidence.heading), el("p", "comparison-meta", evidence.note));
            const pair = el("div", "comparison-score-pair");
            for (const [side, totals] of [["Earlier", tool.raw.baseline], ["Later", tool.raw.later]]) {
                const card = el("article", "comparison-score");
                card.append(el("h3", "", side), el("p", "comparison-meta", evidence.scoreLabel));
                card.append(el("strong", "comparison-score-value", !totals.count ? `No ${evidence.unitLabel}`
                    : totals.success + totals.failure === 0 ? "Not scored" : formatValue(totals.successRate.percent, "percent")));
                card.append(el("p", "comparison-meta", `${formatNumber(totals.success, 0)} of ${formatNumber(totals.count, 0)} ${evidence.unitLabel} ${evidence.successVerb}`));
                const strip = el("div", "comparison-outcome-strip");
                strip.setAttribute("aria-hidden", "true");
                for (const outcome of Object.keys(labels)) if (totals[outcome]) {
                    const segment = el("span", `comparison-outcome-${outcome}`);
                    segment.style.flexGrow = String(totals[outcome]);
                    strip.append(segment);
                }
                card.append(strip);
                const counts = el("dl", "comparison-outcome-counts");
                for (const outcome of Object.keys(labels)) {
                    if (["other", "transport"].includes(outcome) && !totals[outcome]) continue;
                    const item = el("div");
                    const label = model.primaryLayer && model.primaryLayer !== "tool-call"
                        ? ({ success: "2xx recorded", failure: "Error result", partial: "Partial", unknown: "Status missing", other: "Other status", transport: "No response" })[outcome] : labels[outcome];
                    item.append(el("dt", "", label), el("dd", "", formatNumber(totals[outcome], 0)));
                    counts.append(item);
                }
                card.append(counts);
                pair.append(card);
            }
            section.append(pair);
            if (tool.patterns.length) {
                const table = el("table", "comparison-patterns");
                table.append(el("caption", "", "The same technical patterns, side by side"));
                const head = el("thead"), header = el("tr");
                for (const title of ["Pattern", "Earlier failures", "Later failures", "Change"]) {
                    const cell = el("th", "", title);
                    cell.scope = "col";
                    header.append(cell);
                }
                head.append(header);
                table.append(head);
                const body = el("tbody"), displays = new Map((model.patternDisplays ?? []).map(item => [item.patternId, item]));
                for (const pattern of tool.patterns) {
                    const row = el("tr"), name = el("th");
                    name.scope = "row";
                    const display = displays.get(pattern.patternId);
                    const label = display?.available ? `${display.workload} · ${display.tool}` : "Pattern details unavailable";
                    const title = el(typeof onInspectPattern === "function" ? "button" : "span", "comparison-pattern-title", label);
                    if (typeof onInspectPattern === "function") {
                        title.type = "button";
                        title.addEventListener("click", () => onInspectPattern(pattern.patternId));
                    }
                    name.append(title);
                    if (display?.endpoints?.length) name.append(el("span", "comparison-meta comparison-endpoint", display.endpoints.map(endpoint => endpoint.pathTemplate).join(" · ")));
                    if (display?.targetShape === "unavailable") name.append(el("span", "comparison-meta", "Tool-level match; endpoint not recorded"));
                    row.append(name);
                    for (const [side, totals] of [["Earlier", pattern.baseline], ["Later", pattern.later]]) {
                        const cell = el("td"), mobile = el("span", "comparison-mobile-label", side);
                        mobile.setAttribute("aria-hidden", "true");
                        cell.append(mobile, el("strong", "", totals.count ? formatValue(totals.failureRate.percent, "percent") : "Not present"));
                        if (totals.count) cell.append(el("span", "comparison-meta", `${formatNumber(totals.failure, 0)} of ${formatNumber(totals.count, 0)} ${evidence.unitLabel}`));
                        row.append(cell);
                    }
                    const delta = el("td"), mobile = el("span", "comparison-mobile-label", "Change");
                    mobile.setAttribute("aria-hidden", "true");
                    delta.append(mobile);
                    const change = pattern.change.failure;
                    delta.append(el("span", "", change === null ? pattern.presence === "baseline-only" ? "Not in later report" : "Only in later report"
                        : change === 0 ? "Unchanged" : `${change < 0 ? "↓" : "↑"} ${formatNumber(Math.abs(change))} pp`));
                    row.append(delta);
                    body.append(row);
                }
                table.append(body);
                patternTable = table;
            }
            panel.append(section);
        }
        const { available, unavailable, unavailableLabel } = metricGroups(model.metrics);
        if (available.length) panel.append(metricTable(available, "Recorded measures"));
        if (unavailable.length) {
            const disclosure = el("details", "comparison-unavailable");
            const summary = el("summary", "", `Measures without a result (${unavailable.length})`);
            summary.append(el("span", "comparison-meta", unavailableLabel));
            disclosure.append(summary, metricTable(unavailable, "Unavailable measures and coverage"));
            panel.append(disclosure);
        }
        if (patternTable) panel.append(patternTable);
        const details = el("details", "comparison-reading");
        details.append(el("summary", "", "Scope, coverage and reading notes"));
        const notes = el("div");
        notes.append(el("p", "", "Percentages keep their exact denominators. Unknown, partial and unassessed evidence are not silently counted as successes or failures."));
        notes.append(el("p", "", "Pass-share colors describe assessed results only: below 50%, 50–74%, 75–89%, and 90%+. They are not a combined quality grade."));
        if (model.scopeDifferences?.length) notes.append(el("p", "", `Scope differences: ${model.scopeDifferences.map(code => code.replaceAll("-", " ")).join("; ")}.`));
        if (tool?.overlap) notes.append(el("p", "", tool.overlap.verified ? `${tool.overlap.sharedCount} calls occur in both snapshots.` : "Repeated calls between these reports could not be verified."));
        for (const [kind, layer] of Object.entries(model.layerComparisons ?? {})) {
            if (kind === "tool-call") continue;
            if (kind === "graph-code-reference") {
                notes.append(el("p", "", `Code references: ${layer.baselineCount ?? "not recorded"} earlier; ${layer.laterCount ?? "not recorded"} later. ${layer.note}`));
            } else if (layer.raw) {
                notes.append(el("p", "", `${layer.unit}: ${layer.raw.baseline.count} earlier; ${layer.raw.later.count} later. ${layer.note}`));
            }
        }
        details.append(notes);
        panel.append(details);
        root.replaceChildren(panel);
    }
    return {
        presentation,
        formatValue,
        metricPresentation,
        comparisonSidePresentation,
        metricGroups,
        definitionLabel: metricDefinitionLabel,
        dimensionLabel(key) {
            if (!Object.hasOwn(dimensions, key)) throw new TypeError("Unknown report dimension.");
            return dimensions[key];
        },
        render,
        clear(root) {
            if (!root || typeof root.replaceChildren !== "function") throw new TypeError("Comparison clearing requires a document element.");
            root.replaceChildren();
        },
    };
}

export const reportComparisonStyles = `
.report-comparison{color:var(--ink);font-family:var(--font);font-size:var(--type-body,.875rem);line-height:var(--leading-ui,1.43);font-variant-numeric:tabular-nums;min-width:0}
.comparison-takeaway{margin:0 0 24px}.comparison-takeaway h2{font-size:var(--type-section,1.125rem);line-height:var(--leading-section,1.333);margin:0 0 6px}.comparison-takeaway p{margin:0;line-height:var(--leading-reading,1.625)}
.comparison-notice{padding:16px;background:var(--canvas);border:1px solid var(--rule);border-radius:12px}
.comparison-metrics,.comparison-patterns{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 28px;font-size:var(--type-body,.875rem)}
.comparison-metrics caption,.comparison-patterns caption{text-align:left;font-size:var(--type-section,1.125rem);font-weight:var(--weight-strong,600);margin:0 0 14px}
.comparison-metrics th,.comparison-metrics td,.comparison-patterns th,.comparison-patterns td{padding:14px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.comparison-metrics thead,.comparison-patterns thead{background:var(--canvas);color:var(--muted);font-size:var(--type-caption,.75rem)}
.comparison-metrics th:first-child,.comparison-patterns th:first-child{width:30%}.comparison-metrics tbody th,.comparison-patterns tbody th{font-weight:600}
.comparison-metric-value{display:block;font-size:var(--type-data-value,1.375rem);font-weight:var(--weight-strong,600);line-height:var(--leading-data-value,1.35)}.comparison-delta{display:block;font-size:var(--type-section,1.125rem)}
.comparison-meta{display:block;margin:4px 0 0;font-size:var(--type-caption,.75rem);font-weight:var(--weight-regular,400);line-height:var(--leading-caption,1.333);color:var(--muted);overflow-wrap:anywhere}
.comparison-metric-value.performance-red{color:var(--performance-red,var(--ink))}.comparison-metric-value.performance-orange{color:var(--performance-orange,var(--ink))}
.comparison-metric-value.performance-gold{color:var(--performance-gold,var(--ink))}.comparison-metric-value.performance-teal{color:var(--performance-teal,var(--ink))}
.comparison-tool-results{margin-top:26px}.comparison-tool-results h2{font-size:var(--type-section,1.125rem);margin:0}
.comparison-unavailable{margin:0 0 24px;border-block:1px solid var(--rule)}
.comparison-unavailable>summary,.comparison-report-identity>summary{min-height:44px;padding:10px 0;cursor:pointer;font-size:var(--type-small,.875rem)}
.comparison-unavailable>summary:focus-visible,.comparison-report-identity>summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.comparison-unavailable .comparison-metric-value{font-size:var(--type-body,.875rem)}
.comparison-report-choice{flex:1 1 16rem;min-width:0}.comparison-report-choice label{display:flex;flex-direction:column;gap:var(--space-sm)}
.comparison-report-identity{margin:0;font-size:var(--type-caption,.75rem)}.comparison-report-identity p{margin:0 0 8px}
.comparison-score-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));border:1px solid var(--rule);border-radius:20px;background:var(--paper);overflow:hidden;margin:18px 0 26px}
.comparison-score{padding:22px;min-width:0}.comparison-score+.comparison-score{border-left:1px solid var(--rule)}.comparison-score h3{font-size:1rem;margin:0 0 8px}
.comparison-score-value{display:block;font-size:var(--type-score,3rem);letter-spacing:-.04em;line-height:1.2;margin:7px 0;overflow-wrap:anywhere}
.comparison-outcome-strip{display:flex;gap:0;height:10px;border-radius:4px;overflow:hidden;margin:18px 0}.comparison-outcome-strip span{flex-basis:0}
.comparison-outcome-success{background:var(--chart-teal-mid,#18aaa9)}.comparison-outcome-failure,.comparison-outcome-transport{background:var(--chart-pink-mid,#e95b92)}
.comparison-outcome-partial{background:var(--chart-orange-mid,#f58a33)}.comparison-outcome-unknown,.comparison-outcome-other{background:var(--chart-slate-mid,#7a92b0)}
.comparison-outcome-counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,5rem),1fr));gap:12px;margin:0}.comparison-outcome-counts dt{font-size:var(--type-caption,.75rem);color:var(--muted)}
.comparison-outcome-counts dd{font-size:1.25rem;font-weight:600;margin:3px 0 0}
.comparison-pattern-title{display:block;min-height:44px;max-width:100%;border:0;border-radius:var(--radius-small,8px);background:none;padding:5px 0;text-align:left;color:var(--accent);font:inherit;font-weight:var(--weight-strong,600);overflow-wrap:anywhere;cursor:pointer}
span.comparison-pattern-title{cursor:default;color:var(--ink)}
button.comparison-pattern-title:is(:hover,:active){background:transparent;color:var(--ink)}
.comparison-pattern-title:focus-visible,.comparison-reading summary:focus-visible{outline:2px solid var(--focus);outline-offset:4px}
.comparison-endpoint{font-family:var(--mono,monospace);font-size:.75rem}
.comparison-reading{border-top:1px solid var(--rule);margin-top:22px;color:var(--muted);font-size:.875rem}
.comparison-reading summary{min-height:44px;padding:12px 0;cursor:pointer;font-weight:500}.comparison-reading p{line-height:1.65}
.comparison-mobile-label{display:none}
@media(max-width:760px){.comparison-outcome-counts{grid-template-columns:1fr 1fr}.comparison-score{padding:18px}}
@media(max-width:600px){
 .comparison-metrics,.comparison-patterns,.comparison-metrics tbody,.comparison-patterns tbody{display:block}
 .comparison-metrics caption,.comparison-patterns caption{display:block;width:100%}
 .comparison-metrics thead,.comparison-patterns thead{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
 .comparison-metrics tbody tr,.comparison-patterns tbody tr{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,7rem),1fr));gap:12px;padding:14px 0;border-bottom:1px solid var(--rule)}
 .comparison-metrics tbody th,.comparison-patterns tbody th{display:block;grid-column:1/-1;width:auto!important;padding:0 0 12px;border:0}
 .comparison-metrics td,.comparison-patterns td{display:block;padding:0;border:0;min-width:0}
 .comparison-mobile-label{display:block;color:var(--muted);font-size:.75rem;margin-bottom:5px}
 .comparison-metric-value{font-size:1.125rem}.comparison-meta{font-size:.75rem}.comparison-delta{font-size:1rem}
 .comparison-score{padding:15px}.comparison-score-value{font-size:2.5rem}.comparison-score h3{font-size:.9375rem}
 .comparison-outcome-counts{gap:10px}.comparison-outcome-counts dt{font-size:.75rem}.comparison-outcome-counts dd{font-size:1.125rem}
}
@media(forced-colors:active){.comparison-outcome-strip span{border:1px solid CanvasText}.comparison-metric-value{color:CanvasText!important}}
`;
