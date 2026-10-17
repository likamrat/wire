import { tokens } from "../web/tokens.mjs";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, brandMark, brandDarkMark } from "./branding.mjs";
import { fontFaceStyles } from "./typeface.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";

export const escapeReportText = value => String(value ?? "").replace(/[&<>"'|]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "|": "&#124;" })[character]);
export const escapeReportMarkdown = value => escapeReportText(value).replace(/[\\`*_#[\]{}]/g, "\\$&").replace(/\r?\n/g, " ");
const formatter = createReportComparison();
export const reportPresentation = formatter.presentation;
export const currentReportPresentation = Object.freeze({ schemaVersion: 2 });
export function reportMeasurePresentation(metric) {
    const facts = [metric.baseline, metric.later].filter(Boolean);
    const timing = {
        "tool-start-to-completion": "Median tool latency", "http-dispatch-to-response-headers": "Median HTTP response time",
        "http-dispatch-to-transport-error": "Median time to transport error", "verified-request-to-final-answer": "Median whole-interaction time",
        "recorded-request-to-final-answer": "Median time to recorded final response",
    };
    if (facts.length && facts.every(fact => fact.kind === "duration" && timing[fact.boundary])) {
        const labels = [...new Set(facts.map(fact => timing[fact.boundary]))];
        if (labels.length === 1) return { label: labels[0], definition: "" };
    }
    return { label: formatter.comparisonLabel(metric), definition: formatter.definitionLabel(metric) };
}
function recordedBreakdown(totals, layer, includeSuccess = true) {
    const names = layer === "tool-call" || !layer
        ? { success: "Succeeded", failure: "Failed", partial: "Partial", unknown: "Unknown", other: "Other", transport: "No response" }
        : { success: "Recorded 2xx", failure: "Recorded error", partial: "Partial", unknown: "No status", other: "Other status", transport: "No response" };
    return Object.entries(names).filter(([key]) => totals[key] > 0 && (includeSuccess || key !== "success"))
        .map(([key, label]) => `${label}: ${totals[key]}`).join(" · ");
}
function presentedView(view) {
    return `<strong class="comparison-metric-value ${view.tone}">${escapeReportText(view.value)}</strong><span class="comparison-meta">${escapeReportText(view.note)}</span>`;
}
export function reportBrandHeader(title = "Activity report") {
    return `<header class="report-brand" aria-label="${PRODUCT_NAME}"><h1>${escapeReportText(title)}</h1><div class="report-mark" aria-hidden="true">${brandMark}${brandDarkMark}</div></header>`;
}
export const reportBrandStyles = `
.report-brand{display:flex;align-items:flex-start;justify-content:space-between;gap:1.5rem;margin:0 0 1rem;break-inside:avoid}
.report-brand h1{min-width:0;margin:0;font-size:var(--type-title);line-height:var(--leading-heading);font-weight:var(--weight-strong);text-wrap:pretty}
.report-mark{flex:none;padding-top:.15rem}.report-brand .brand-logo{display:block;width:7rem;height:auto}
.report-brand .brand-logo[data-brand-theme=dark]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=light]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=dark]{display:block}
@media screen and (max-width:40rem){.report-brand{flex-direction:column;gap:.5rem}.report-brand .brand-logo{width:5.5rem}}
`;
export const reportDocumentTokens = `
:root,:root[data-evidence-theme=light]{
 --font:"Asta Sans","Segoe UI",sans-serif;--weight-strong:600;--tracking-heading:0;
 --page:#fff;--paper:#fff;--canvas:#f3f3f3;--hover:#ececec;--ink:#202020;--muted:#565656;--rule:#c9c9c9;
 --accent:#303030;--accent-soft:#ececec;--accent-pressed:#dedede;--focus:#303030;
 --danger:#b3261e;--performance-red:#b3261e;--chart-failure:#b3261e;
}
:root[data-evidence-theme=dark]{
 --page:#101010;--paper:#191919;--canvas:#242424;--hover:#2b2b2b;--ink:#f2f2f2;--muted:#b8b8b8;--rule:#444;
 --accent:#e0e0e0;--accent-soft:#2b2b2b;--accent-pressed:#3b3b3b;--focus:#e0e0e0;
 --danger:#f28b82;--performance-red:#f28b82;--chart-failure:#f28b82;--unknown:#b8b8b8;
}
`;
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
}
`;
export const reportPresentationStyles = `
${fontFaceStyles}
${tokens}
${dimensionalColumnStyles}
${reportComparisonStyles}
${reportDocumentTokens}
:root{font-family:var(--font);font-variant-numeric:tabular-nums}
body{font-size:var(--type-body);line-height:var(--leading-ui)}.prompt pre{font-family:var(--font)}
${reportBrandStyles}
.report-footer{margin-top:24px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption)}
.comparison-document{background:var(--paper);color:var(--ink);max-width:1100px;margin:0 auto;padding:28px}
.comparison-document .comparison-meta{font-size:var(--type-caption);line-height:var(--leading-caption)}
.comparison-document h2{font-size:var(--type-section);font-weight:600;margin:1.5rem 0 .75rem}
.comparison-document .report-summary{max-width:72ch;margin:1rem 0;line-height:var(--leading-reading)}
.comparison-document .comparison-score-pair{gap:1.5rem;border:0;border-block:1px solid var(--rule);border-radius:0;padding:1rem 0}
.comparison-document .comparison-score{border:0;border-radius:0;background:transparent;padding:0;box-shadow:none}
.comparison-document .comparison-score-value{font-size:1.5rem}
.comparison-document .comparison-outcome-failure{--column-label:var(--danger)}
.comparison-document .comparison-outcome-strip>span{background:var(--column-label)}
.comparison-document .reading-notes{margin-top:1.5rem;padding:.5rem .75rem;border:1px solid var(--rule);border-radius:var(--radius)}
.comparison-document summary{min-height:44px;cursor:pointer;padding:.65rem 0}
.comparison-document :is(summary,a):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
@media(max-width:420px){.comparison-document{padding:16px}}
@media print{
 :root,body{background:white!important;color:#172333}body{font-size:10pt}.report-accessible-name{display:none}
 .comparison-document .comparison-meta,.comparison-metrics,.comparison-patterns{font-size:10pt;line-height:1.45}
 .comparison-document{padding:0;font-size:10pt;color:var(--ink)}.report-footer{font-size:10pt}
 .comparison-document details,.comparison-document details>*{display:block}.comparison-document details::details-content{content-visibility:visible}
 .comparison-metrics,.comparison-patterns{display:table}.comparison-metrics tbody,.comparison-patterns tbody{display:table-row-group}
 .comparison-metrics tbody tr,.comparison-patterns tbody tr{display:table-row}.comparison-metrics th,.comparison-metrics td,.comparison-patterns th,.comparison-patterns td{display:table-cell;padding:6px}
 .comparison-metrics thead,.comparison-patterns thead{position:static;width:auto;height:auto;clip-path:none;display:table-header-group}
 .comparison-mobile-label{display:none}.comparison-metrics tr,.comparison-patterns tr{break-inside:avoid}
}
${reportPrintPaginationStyles}
@media print{
 .comparison-document .reading-notes p,.comparison-document summary{break-inside:avoid}
 .comparison-document :is(h2,h3,summary,caption,thead){break-after:avoid}
 .comparison-document :is(h2,h3,summary)+p:not(:last-child){break-after:avoid}
 .comparison-document tbody>tr:first-child{break-before:avoid}
 .comparison-document .report-footer{break-before:avoid;break-inside:avoid}
}
`;
export function comparisonBodyHtml(model, snapshot) {
    const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
    const evidence = model.primaryEvidence ?? { heading: "Recorded tool outcomes", unitLabel: "calls", successVerb: "succeeded", note: "Tool outcomes are not verified task completion." };
    const { available, unavailable, unavailableLabel } = formatter.metricGroups(model.metrics);
    const metricTable = (metrics, label) => `<table class="comparison-metrics"><caption>${escapeReportText(label)}</caption><thead><tr><th>Measure</th><th>Earlier</th><th>Later</th><th>Change</th></tr></thead><tbody>${metrics.map(metric => {
        const reading = reportMeasurePresentation(metric);
        const change = metric.delta ? metric.delta.value === 0 ? "Unchanged"
            : `${metric.delta.value > 0 ? "+" : "−"}${formatter.formatValue(Math.abs(metric.delta.value), metric.delta.unit)}`
            : metric.status === "incompatible" ? "Different definitions" : "Not comparable";
        return `<tr><th scope="row">${escapeReportText(reading.label)}${reading.definition ? `<span class="comparison-meta">${escapeReportText(reading.definition)}</span>` : ""}</th>
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
        const score = !total.count ? `No ${evidence.unitLabel}` : total.success + total.failure === 0 ? model.metricProjectionVersion === 4 ? "Success rate unavailable" : "Not scored"
            : formatter.formatValue(total.successRate.percent, "percent");
        const strip = ["success", "failure", "partial", "unknown", "other", "transport"].filter(outcome => total[outcome])
            .map(outcome => `<span class="comparison-outcome-${outcome} dimensional-tone-${formatter.outcomeTone(outcome)}" style="flex-grow:${total[outcome]}"></span>`).join("");
        const remaining = recordedBreakdown(total, model.primaryLayer, false);
        return `<article class="comparison-score"><h3>${label}</h3><strong class="comparison-score-value">${escapeReportText(score)}</strong>
            ${total.count ? `<p>${total.success} of ${total.count} ${escapeReportText(evidence.unitLabel)} ${escapeReportText(evidence.successVerb)}</p><div class="comparison-outcome-strip" aria-hidden="true">${strip}</div>` : ""}${remaining ? `<p class="comparison-meta">${escapeReportText(remaining)}</p>` : ""}</article>`;
    }).join("") : "";
    return `<div class="report-comparison">${model.narrative ? `<p class="report-summary"><strong>${escapeReportText(model.narrative.heading)}</strong> ${escapeReportText(model.narrative.detail)}</p>` : ""}
        ${primary ? `<section class="comparison-tool-results"><h2>${escapeReportText(evidence.heading)}</h2><p class="comparison-meta">${escapeReportText(model.metricProjectionVersion === 4 && model.primaryLayer === "tool-call" ? "Successful calls do not establish task completion." : evidence.note)}</p><div class="comparison-score-pair">${scores}</div></section>` : ""}
        ${available.length ? metricTable(available, "Recorded measures") : ""}
        ${unavailable.length ? `<details class="comparison-unavailable"><summary>Measures without a result (${unavailable.length})<span class="comparison-meta">${escapeReportText(unavailableLabel)}</span></summary>${metricTable(unavailable, "Unavailable measures and coverage")}</details>` : ""}
        ${patterns ? `<section><h2>Operations</h2><table class="comparison-patterns" aria-label="Operations present in either report"><thead><tr><th>Pattern</th><th>Earlier failures</th><th>Later failures</th><th>Change</th></tr></thead><tbody>${patterns}</tbody></table></section>` : ""}
        <details class="reading-notes"><summary>Coverage and sources</summary>${[...formatter.scopeNotes(model), ...formatter.readingNotesFor(model), formatter.comparisonNote].map(text => `<p>${escapeReportText(text)}</p>`).join("")}
        ${snapshot ? `<p>Comparison: ${escapeReportText(snapshot.bundleId)}.</p>${snapshot.sourceReports.map((source, index) => `<p>${index ? "Later" : "Earlier"} source: ${escapeReportText(source.bundleId)}.</p>`).join("")}<p>Deleting a source does not rewrite this reviewed copy.</p>` : ""}</details></div>`;
}
export function renderComparisonHtml(model, snapshot) {
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
        <title>${PRODUCT_NAME} - ${escapeReportText(snapshot.title || "report comparison")}</title><style>${reportPresentationStyles}@page{size:A4;margin:16mm}</style></head>
        <body class="comparison-document"><main>${reportBrandHeader(snapshot.title || "Report comparison")}<p>${escapeReportText(snapshot.preparedAtDisplay)}</p>
        ${comparisonBodyHtml(model, snapshot)}<p class="report-footer">${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}</p></main></body></html>`;
}
export function renderComparisonMarkdown(model, snapshot) {
    const lines = [snapshot.title ? `# ${escapeReportMarkdown(snapshot.title)}` : `# ${PRODUCT_NAME} - report comparison`, "", snapshot.preparedAtDisplay, ""];
    if (model.narrative) lines.push(`**${model.narrative.heading}** ${model.narrative.detail}`, "");
    const { available, unavailable } = formatter.metricGroups(model.metrics);
    function measures(metrics, heading) {
        if (!metrics.length) return;
        lines.push("", `## ${heading}`, "", "| Measure | Earlier | Later | Change |", "|---|---|---|---|");
        for (const metric of metrics) {
            const a = formatter.comparisonSidePresentation(metric, "baseline"), b = formatter.comparisonSidePresentation(metric, "later");
            const reading = reportMeasurePresentation(metric), origin = reading.definition;
            const change = metric.delta ? formatter.formatValue(metric.delta.value, metric.delta.unit) : "Not comparable";
            lines.push(`| ${escapeReportText(reading.label)}${origin ? ` · ${escapeReportText(origin)}` : ""} | ${escapeReportText(a.value)}; ${escapeReportText(a.note)} | ${escapeReportText(b.value)}; ${escapeReportText(b.note)} | ${escapeReportText(change)} |`);
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
        lines.push("", "## Operations", "", `| Pattern | Earlier errors / ${evidence.unitLabel} | Later errors / ${evidence.unitLabel} | Change (percentage points) |`, "|---|---:|---:|---:|");
        const displays = new Map((model.patternDisplays ?? []).map(pattern => [pattern.patternId, pattern]));
        for (const pattern of primary.patterns) {
            const display = displays.get(pattern.patternId);
            lines.push(`| ${escapeReportText(display?.available ? `${display.workload} / ${display.tool}` : "Pattern unavailable")} | ${pattern.baseline.failure}/${pattern.baseline.count} | ${pattern.later.failure}/${pattern.later.count} | ${pattern.change.failure === null ? "Not comparable" : escapeReportText(formatter.formatValue(pattern.change.failure, "percentage-points"))} |`);
        }
    }
    measures(unavailable, "Unavailable measures and coverage");
    return [...lines, "", "## Scope and coverage", "", ...formatter.scopeNotes(model).flatMap(text => [text, ""]), ...formatter.readingNotesFor(model).flatMap(text => [text, ""]), formatter.comparisonNote, "",
        `Frozen comparison: ${snapshot.bundleId}`, ...snapshot.sourceReports.map(source => `Source: ${source.bundleId} (${source.snapshotHash})`), "", "Deleting a source report does not rewrite this reviewed comparison copy.", ""].join("\n");
}
