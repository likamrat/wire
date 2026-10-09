import { tokens } from "../web/tokens.mjs";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, brandMark } from "./branding.mjs";
import { evaluationMetricFacts } from "./report-facts.mjs";
import { fontFaceStyles } from "./typeface.mjs";

export const escapeReportText = value => String(value ?? "").replace(/[&<>"'|]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "|": "&#124;" })[character]);
const formatter = createReportComparison();
export const reportPresentation = formatter.presentation;
const dimensionOrder = ["accuracy", "speed", "answer-trust", "action-trust"];
function recordedBreakdown(totals, layer) {
    const names = layer === "tool-call" || !layer
        ? { success: "Succeeded", failure: "Failed", partial: "Partial", unknown: "Unknown", other: "Other", transport: "No response" }
        : { success: "Recorded 2xx", failure: "Recorded error", partial: "Partial", unknown: "No status", other: "Other status", transport: "No response" };
    return Object.entries(names).filter(([key]) => !["other", "transport"].includes(key) || totals[key])
        .map(([key, label]) => `${label}: ${totals[key]}`).join(" · ");
}
function presentedView(view) {
    return `<strong class="comparison-metric-value ${view.tone}">${escapeReportText(view.value)}</strong><span class="comparison-meta">${escapeReportText(view.note)}</span>`;
}
function presented(fact, dimension) {
    return presentedView(formatter.metricPresentation(fact, dimension));
}
export function reportBrandHeader(title) {
    return `<header class="report-brand" aria-label="${PRODUCT_NAME}">${brandMark}<p>${PRODUCT_DESCRIPTION}</p><h1><span class="report-accessible-name">${PRODUCT_NAME} </span>${escapeReportText(title)}</h1></header>`;
}
export const reportPrintPaginationStyles = `
@media print {
 .prompt-record{margin:.45em 0;padding:.45em 0}
 .prompt-record>summary{margin:0 0 .35em;break-inside:avoid;break-after:avoid}
 .prompt-record .ref{font-size:10pt;line-height:1.35}
 .prompt{break-inside:avoid}
 .prompt h4{margin:.4em 0 .25em}
 .prompt>p:not(.removal){margin:.25em 0;break-after:avoid}
 .prompt pre{margin:.4em 0 .55em;padding:6px 8px}
 .prompt .removal{margin:.25em 0;break-before:avoid}
 .reading-notes{margin-top:.8em;padding-top:.5em}
 .reading-notes>summary{break-inside:avoid;break-after:avoid}
 .reading-notes p{margin:.35em 0;line-height:1.4}
 .reading-notes ul{margin:.4em 0;padding-left:1.3em}
 .reading-notes li{margin:.2em 0;line-height:1.4}
 .report-footer{margin-top:.75em}
 .report-dimension details{margin-top:.4em;padding-top:.35em}
 .report-dimension summary{min-height:0;padding:.25em 0;font-size:10pt}
}
`;
export const reportScreenHeroStyles = `
@media screen {
 .report-tool-score{flex-wrap:wrap}
 .report-tool-score>div{flex:0 0 auto;max-width:100%}
 .report-tool-score strong{overflow-wrap:anywhere}
 .report-tool-score>.report-tldr{flex:1 1 24rem;min-width:min(100%,24rem)}
}
`;
export const reportPresentationStyles = `
${fontFaceStyles}
${tokens}
${reportComparisonStyles}
:root{font-family:var(--font);font-variant-numeric:tabular-nums}
body{font-size:var(--type-body);line-height:var(--leading-ui)}.prompt pre{font-family:var(--font)}
.report-brand{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:0 0 18px;break-inside:avoid}
.report-brand .brand-logo{display:block;width:177px;height:56px;flex:none}.report-brand p{margin:0;color:var(--muted);font-size:var(--type-small);line-height:var(--leading-ui)}
.report-brand h1{margin:8px 0 0;font-size:var(--type-title);line-height:var(--leading-heading);font-weight:var(--weight-strong)}
.report-accessible-name{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.report-dimensions{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:18px;margin:24px 0}
.report-dimension{min-width:0;padding:16px;background:var(--canvas);border-radius:12px}
.report-dimension h2{margin:0 0 12px;font-size:var(--type-section);line-height:var(--leading-section)}.report-dimension h3{margin:12px 0 4px;font-size:var(--type-body)}
.report-dimension details{margin-top:12px}.report-dimension summary{min-height:44px;padding:10px 0;font-size:var(--type-caption);cursor:pointer}
.report-dimension .comparison-metric-value{font-size:var(--type-data-value);line-height:var(--leading-data-value)}.report-dimension .comparison-meta{font-size:var(--type-caption);line-height:var(--leading-caption)}
.report-tool-score{display:flex;align-items:center;gap:24px;margin:20px 0}.report-tool-score strong{font-size:var(--type-score);line-height:1.2;font-weight:var(--weight-strong);letter-spacing:-.035em}
.report-tool-score p{margin:0;line-height:var(--leading-reading)}.report-tldr{font-size:var(--type-reading);line-height:var(--leading-reading)}
.report-footer{margin-top:24px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption)}
.comparison-document{background:var(--paper);color:var(--ink);max-width:1100px;margin:0 auto;padding:28px}
.comparison-document .comparison-meta{font-size:var(--type-caption);line-height:var(--leading-caption)}
@media(max-width:420px){.report-dimensions{grid-template-columns:1fr}.comparison-document{padding:16px}.report-tool-score{gap:16px}}
@media print{
 :root,body{background:white!important;color:#172333}body{font-size:10pt}.report-accessible-name{display:none}
 .report-dimensions{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;break-inside:avoid}.report-dimension{padding:10px}
 .report-dimension h2,.report-dimension h3,.report-dimension .comparison-meta,.comparison-document .comparison-meta,.comparison-metrics,.comparison-patterns{font-size:10pt;line-height:1.45}
 .report-dimension .comparison-metric-value{font-size:16pt;line-height:1.4}.report-dimension details>*{display:block}
 .report-dimension details{display:block}.comparison-document{padding:0;font-size:10pt}.report-footer{font-size:10pt}
 .comparison-metrics,.comparison-patterns{display:table}.comparison-metrics tbody,.comparison-patterns tbody{display:table-row-group}
 .comparison-metrics tbody tr,.comparison-patterns tbody tr{display:table-row}.comparison-metrics th,.comparison-metrics td,.comparison-patterns th,.comparison-patterns td{display:table-cell;padding:6px}
 .comparison-metrics thead,.comparison-patterns thead{position:static;width:auto;height:auto;clip-path:none;display:table-header-group}
 .comparison-mobile-label{display:none}.comparison-metrics tr,.comparison-patterns tr{break-inside:avoid}
}
${reportPrintPaginationStyles}
${reportScreenHeroStyles}
`;
export function recordedToolScoreHtml(summary) {
    const tool = summary.metrics.find(metric => metric.layer === "tool");
    if (!tool?.count) return "";
    if (tool.outcomes.success + tool.outcomes.failure === 0) return `<p class="report-tldr">No complete success-or-failure results were recorded for these calls. Partial and unknown results remain visible in the evidence breakdown.</p>`;
    const value = formatter.formatValue(tool.outcomes.success * 100 / tool.count, "percent");
    return `<section class="report-tool-score" aria-label="Recorded tool success"><div><p class="comparison-meta">Recorded tool success</p><strong>${escapeReportText(value)}</strong><p class="comparison-meta">${tool.outcomes.success} of ${tool.count} calls</p></div>
        <p class="report-tldr">${escapeReportText(summary.takeaways[1])}</p></section>`;
}
export function evaluationSummaryHtml(facts) {
    if (!facts) return "";
    const metrics = evaluationMetricFacts(facts);
    function one(dimension) {
        const items = metrics.filter(metric => metric.metric === dimension);
        const primary = items.find(metric => metric.state === "available" && metric.definitionId === "tool-duration")
            ?? items.find(metric => metric.state === "available") ?? items[0];
        const rest = items.filter(metric => metric !== primary);
        const label = primary ? formatter.definitionLabel({ baseline: primary }) : "";
        return `${presented(primary, dimension)}${label ? `<span class="comparison-meta">${escapeReportText(label)}</span>` : ""}
            ${rest.length ? `<details><summary>Other recorded measures (${rest.length})</summary>${rest.map(metric => `<p>${escapeReportText(formatter.definitionLabel({ baseline: metric }))}${presented(metric, dimension)}</p>`).join("")}</details>` : ""}`;
    }
    return `<section class="report-dimensions" aria-label="Personal evaluation summary">
        ${["accuracy", "speed"].map(dimension => `<section class="report-dimension"><h2>${formatter.dimensionLabel(dimension)}</h2>${one(dimension)}</section>`).join("")}
        <section class="report-dimension"><h2>Trust</h2><h3>Answers</h3>${one("answer-trust")}<h3>Actions</h3>${one("action-trust")}</section>
    </section><details class="reading-notes"><summary>How to read these results</summary>${formatter.readingNotes.map(text => `<p>${escapeReportText(text)}</p>`).join("")}</details>`;
}
export function evaluationSummaryMarkdown(facts) {
    if (!facts) return [];
    const metrics = evaluationMetricFacts(facts), lines = ["## Personal evaluation", "", "| Measure | Definition / origin | Recorded result | Coverage / basis |", "|---|---|---|---|"];
    for (const dimension of dimensionOrder) {
        const items = metrics.filter(metric => metric.metric === dimension);
        for (const metric of items.length ? items : [null]) {
            const view = formatter.metricPresentation(metric, dimension);
            const definition = metric ? formatter.definitionLabel({ baseline: metric }) : "Not saved";
            lines.push(`| ${formatter.dimensionLabel(dimension)} | ${escapeReportText(definition)} | ${escapeReportText(view.value)} | ${escapeReportText(view.note)} |`);
        }
    }
    return [...lines, "", "### How to read these results", "", ...formatter.readingNotes.flatMap(text => [text, ""])];
}
export function comparisonBodyHtml(model) {
    const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
    const evidence = model.primaryEvidence ?? { heading: "Recorded tool outcomes", unitLabel: "calls", successVerb: "succeeded", note: "Tool outcomes are not verified task completion." };
    const { available, unavailable, unavailableLabel } = formatter.metricGroups(model.metrics);
    const metricTable = (metrics, label) => `<table class="comparison-metrics"><caption>${escapeReportText(label)}</caption><thead><tr><th>Measure</th><th>Earlier</th><th>Later</th><th>Change</th></tr></thead><tbody>${metrics.map(metric => {
        const change = metric.delta ? metric.delta.value === 0 ? "Unchanged"
            : `${metric.delta.value > 0 ? "+" : "−"}${formatter.formatValue(Math.abs(metric.delta.value), metric.delta.unit)}`
            : metric.status === "incompatible" ? "Different definitions" : "Not comparable";
        return `<tr><th scope="row">${formatter.dimensionLabel(metric.metric)}<span class="comparison-meta">${escapeReportText(formatter.definitionLabel(metric))}</span></th>
            <td><span class="comparison-mobile-label">Earlier</span>${presentedView(formatter.comparisonSidePresentation(metric, "baseline"))}</td><td><span class="comparison-mobile-label">Later</span>${presentedView(formatter.comparisonSidePresentation(metric, "later"))}</td><td><span class="comparison-mobile-label">Change</span>${escapeReportText(change)}</td></tr>`;
    }).join("")}</tbody></table>`;
    const displays = new Map((model.patternDisplays ?? []).map(pattern => [pattern.patternId, pattern]));
    const patterns = primary?.patterns.map(pattern => {
        const display = displays.get(pattern.patternId);
        const label = display?.available ? `${display.workload} · ${display.tool}` : "Pattern unavailable";
        const counts = total => total.count ? `${formatter.formatValue(total.failureRate.percent, "percent")}<span class="comparison-meta">${total.failure} of ${total.count} ${escapeReportText(evidence.unitLabel)} recorded errors</span>` : "Not present";
        const change = pattern.change.failure;
        return `<tr><th scope="row">${escapeReportText(label)}<span class="comparison-meta">${escapeReportText(display?.endpoints?.map(endpoint => endpoint.pathTemplate).join(" · ") ?? "")}</span></th>
            <td><span class="comparison-mobile-label">Earlier</span>${counts(pattern.baseline)}</td><td><span class="comparison-mobile-label">Later</span>${counts(pattern.later)}</td><td><span class="comparison-mobile-label">Change</span>${change === null ? "Not comparable" : change === 0 ? "Unchanged" : escapeReportText(`${change > 0 ? "+" : "−"}${formatter.formatValue(Math.abs(change), "percentage-points")}`)}</td></tr>`;
    }).join("") ?? "";
    const scores = primary ? [["Earlier", primary.raw.baseline], ["Later", primary.raw.later]].map(([label, total]) => {
        const score = !total.count ? `No ${evidence.unitLabel}` : total.success + total.failure === 0 ? "Not scored"
            : formatter.formatValue(total.successRate.percent, "percent");
        return `<article class="comparison-score"><h3>${label}</h3><p class="comparison-meta">${escapeReportText(evidence.scoreLabel ?? "Recorded tool success")}</p><strong class="comparison-score-value">${escapeReportText(score)}</strong>
            <p>${total.success} of ${total.count} ${escapeReportText(evidence.unitLabel)} ${escapeReportText(evidence.successVerb)}</p><p class="comparison-meta">${escapeReportText(recordedBreakdown(total, model.primaryLayer))}</p></article>`;
    }).join("") : "";
    return `<div class="report-comparison">${model.narrative ? `<section class="comparison-takeaway"><h2>${escapeReportText(model.narrative.heading)}</h2><p>${escapeReportText(model.narrative.detail)}</p></section>` : ""}
        ${primary ? `<section class="comparison-tool-results"><h2>${escapeReportText(evidence.heading)}</h2><p class="comparison-meta">${escapeReportText(evidence.note)}</p><div class="comparison-score-pair">${scores}</div></section>` : ""}
        ${available.length ? metricTable(available, "Recorded measures") : ""}
        ${unavailable.length ? `<details class="comparison-unavailable"><summary>Measures without a result (${unavailable.length})<span class="comparison-meta">${escapeReportText(unavailableLabel)}</span></summary>${metricTable(unavailable, "Unavailable measures and coverage")}</details>` : ""}
        ${patterns ? `<table class="comparison-patterns"><caption>Matched and unmatched technical patterns</caption><thead><tr><th>Pattern</th><th>Earlier failures</th><th>Later failures</th><th>Change</th></tr></thead><tbody>${patterns}</tbody></table>` : ""}
        <section class="reading-notes"><h2>Reading notes</h2><p>Scope differences: ${escapeReportText(model.scopeDifferences.join("; ") || "none recorded")}.</p>${formatter.readingNotes.map(text => `<p>${escapeReportText(text)}</p>`).join("")}<p>${escapeReportText(formatter.comparisonNote)}</p></section></div>`;
}
export function renderComparisonHtml(model, snapshot) {
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
        <title>${PRODUCT_NAME} - report comparison</title><style>${reportPresentationStyles}@page{size:A4;margin:16mm}</style></head>
        <body class="comparison-document"><main>${reportBrandHeader("Report comparison")}<p>${escapeReportText(snapshot.preparedAtDisplay)}</p>
        ${comparisonBodyHtml(model)}<p class="report-footer">${PRODUCT_NAME} · Frozen comparison ${escapeReportText(snapshot.bundleId)}. Source reports: ${escapeReportText(snapshot.sourceReports.map(source => source.bundleId).join(" / "))}. Source deletion does not rewrite this reviewed copy.</p></main></body></html>`;
}
export function renderComparisonMarkdown(model, snapshot) {
    const lines = [`# ${PRODUCT_NAME} - report comparison`, "", PRODUCT_DESCRIPTION, "", snapshot.preparedAtDisplay, ""];
    if (model.narrative) lines.push(`## ${model.narrative.heading}`, "", model.narrative.detail, "");
    const { available, unavailable } = formatter.metricGroups(model.metrics);
    function measures(metrics, heading) {
        if (!metrics.length) return;
        lines.push("", `## ${heading}`, "", "| Measure | Earlier | Later | Change |", "|---|---|---|---|");
        for (const metric of metrics) {
            const a = formatter.comparisonSidePresentation(metric, "baseline"), b = formatter.comparisonSidePresentation(metric, "later");
            const origin = formatter.definitionLabel(metric);
            lines.push(`| ${formatter.dimensionLabel(metric.metric)}${origin ? ` · ${escapeReportText(origin)}` : ""} | ${escapeReportText(a.value)}; ${escapeReportText(a.note)} | ${escapeReportText(b.value)}; ${escapeReportText(b.note)} | ${metric.delta ? escapeReportText(formatter.formatValue(metric.delta.value, metric.delta.unit)) : "Not comparable"} |`);
        }
    }
    const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
    const evidence = model.primaryEvidence ?? { heading: "Recorded tool outcomes", unitLabel: "calls", successVerb: "succeeded", note: "Tool outcomes do not establish task completion." };
    if (primary) {
        lines.push("", `## ${evidence.heading}`, "", `Earlier: ${primary.raw.baseline.success}/${primary.raw.baseline.count} ${evidence.unitLabel} ${evidence.successVerb}. Later: ${primary.raw.later.success}/${primary.raw.later.count}. ${evidence.note}`, "",
            `Earlier: ${recordedBreakdown(primary.raw.baseline, model.primaryLayer)}`, "", `Later: ${recordedBreakdown(primary.raw.later, model.primaryLayer)}`);
    }
    measures(available, "Recorded measures");
    if (primary) {
        lines.push("", `| Pattern | Earlier errors / ${evidence.unitLabel} | Later errors / ${evidence.unitLabel} | Change (percentage points) |`, "|---|---:|---:|---:|");
        const displays = new Map((model.patternDisplays ?? []).map(pattern => [pattern.patternId, pattern]));
        for (const pattern of primary.patterns) {
            const display = displays.get(pattern.patternId);
            lines.push(`| ${escapeReportText(display?.available ? `${display.workload} / ${display.tool}` : "Pattern unavailable")} | ${pattern.baseline.failure}/${pattern.baseline.count} | ${pattern.later.failure}/${pattern.later.count} | ${pattern.change.failure === null ? "Not comparable" : escapeReportText(formatter.formatValue(pattern.change.failure, "percentage-points"))} |`);
        }
    }
    measures(unavailable, "Unavailable measures and coverage");
    return [...lines, "", "Scope/coverage: " + model.scopeDifferences.join("; "), "", ...formatter.readingNotes.flatMap(text => [text, ""]), formatter.comparisonNote, "",
        `Frozen comparison: ${snapshot.bundleId}`, ...snapshot.sourceReports.map(source => `Source: ${source.bundleId} (${source.snapshotHash})`), "", "Deleting a source report does not rewrite this reviewed comparison copy.", ""].join("\n");
}
