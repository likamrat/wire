import { tokens } from "../web/tokens.mjs";
import { resultComparisonHtml, resultComparisonMarkdown, comparisonResultTextHtml, comparisonResultTextMarkdown } from "./report-result-output.mjs";
import { createReportComparison, reportComparisonStyles } from "../web/report-comparison.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, brandMark, brandDarkMark, brandV1Mark, brandV1DarkMark, brandLockup, brandDarkLockup } from "./branding.mjs";
import { fontFaceStyles } from "./typeface.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { createTimingPresentation } from "../web/assessment-presentation.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import legacyAuthorIcons from "../assets/report-author-icons-v1.json" with { type: "json" };
import reactAuthorIcons from "../assets/report-author-icons-v2.json" with { type: "json" };
import { validateComparisonIdentity, comparisonSourceWindow } from "./comparison-presentation-contract.mjs";

export const escapeReportText = value => String(value ?? "").replace(/[&<>"'|]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "|": "&#124;" })[character]);
export const escapeReportMarkdown = value => escapeReportText(value).replace(/[\\`*_#[\]{}]/g, "\\$&").replace(/\r?\n/g, " ");
export const reportTextCell = value => `<div class="report-cell-text" align="left">${escapeReportText(value)}</div>`;
export const reportValueCell = (value, numeric, note = "") =>
    (numeric ? escapeReportText(value) : reportTextCell(value)) + (note ? reportTextCell(note) : "");
export const reportFieldsHtml = fields => `<dl class="report-facts">\n${fields.map(([label, value]) =>
    `<div><dt>${escapeReportText(label)}</dt> <dd>${escapeReportText(value)}</dd></div>`).join("\n")}\n</dl>`;
const formatter = createReportComparison();
export const reportPresentation = formatter.presentation;
const legacyReportPresentation = Object.freeze({ schemaVersion: 3 });
const originV1ReportPresentation = Object.freeze({ schemaVersion: 3, originExplanationVersion: 1 });
const brandV1ReportPresentation = Object.freeze({ schemaVersion: 3, originExplanationVersion: 1, brandVersion: 1 });
const brandV2ReportPresentation = Object.freeze({ schemaVersion: 3, originExplanationVersion: 1, brandVersion: 2 });
const priorProductPresentation = Object.freeze({ ...brandV2ReportPresentation, productVersion: 1 });
const humanLabelPresentation = Object.freeze({ ...brandV2ReportPresentation, authorLabelVersion: 1 });
const humanLabelProductPresentation = Object.freeze({ ...humanLabelPresentation, productVersion: 1 });
export const currentReportPresentation = Object.freeze({ ...humanLabelPresentation, iconVersion: 2 });
const iconProductPresentation = Object.freeze({ ...currentReportPresentation, productVersion: 1 });
const originalFindingPresentation = Object.freeze({ ...iconProductPresentation, findingVersion: 1 });
export const currentProductReportPresentation = Object.freeze({ ...iconProductPresentation, findingVersion: 2 });
export const currentComparisonPresentation = Object.freeze({ ...brandV2ReportPresentation, comparisonVersion: 1 });
export const hasCurrentReportPresentation = snapshot => JSON.stringify(snapshot?.presentation) === JSON.stringify(
    snapshot?.kind === "comparison" ? currentComparisonPresentation
        : snapshot?.kind === "report" && snapshot.reportPopulation?.version === 1 ? currentProductReportPresentation : currentReportPresentation);
export const hasSupportedReportPresentation = snapshot => hasCurrentReportPresentation(snapshot)
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(currentReportPresentation)
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(humanLabelPresentation)
    || snapshot?.kind === "report" && snapshot.reportPopulation?.version === 1 && [priorProductPresentation, humanLabelProductPresentation, iconProductPresentation, originalFindingPresentation]
        .some(presentation => JSON.stringify(snapshot.presentation) === JSON.stringify(presentation))
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(brandV2ReportPresentation)
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(brandV1ReportPresentation)
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(originV1ReportPresentation)
    || JSON.stringify(snapshot?.presentation) === JSON.stringify(legacyReportPresentation);
export function reportAuthorMark(prompt, snapshot) {
    if (snapshot?.presentation?.authorLabelVersion !== 1) return "";
    const role = promptAuthorship.iconRole(promptAuthorship.read(prompt).actor);
    const icons = snapshot.presentation.iconVersion === 2 ? reactAuthorIcons.icons : legacyAuthorIcons;
    return `<span aria-hidden="true" style="display:inline-flex;vertical-align:-.1em;margin-inline-end:.35em">${icons[role]}</span>`;
}
export const reportIconNotice = snapshot => snapshot?.presentation?.iconVersion === 2
    ? `<template id="wireIconLicense">${escapeReportText(reactAuthorIcons.notice)}</template>` : "";
// Saved schema-3 wording cannot follow later screen explanations.
const legacyOriginReasons = Object.freeze({
    "system-source": "The host recorded this as system-supplied context, not a verified User or Agent prompt.",
    "missing-source": "The host did not record the author; the user.message role alone is not authorship.",
    "unsupported-source": "The recorded source does not identify a supported User or Agent author.",
    "conflicting-source": "Recorded author evidence conflicts.",
    "legacy-missing": "This older record did not retain verifiable author metadata.",
    "invalid-source": "WIRE could not verify the recorded host message format or author fields.",
});
const originReasonsV1 = Object.freeze({
    ...legacyOriginReasons,
    "conflicting-source": "WIRE could not reconcile the recorded origin evidence.",
});
const originIssueReasonsV1 = Object.freeze({
    "body-boundary-v1": "WIRE could not match the original prompt to a supported host message layout.",
    "host-wrapper-v1": "WIRE does not recognize the host-added context before the original prompt.",
    "workspace-origin-v1": "Copilot recorded workspace details, but WIRE could not verify who sent this message.",
    "source-value-v1": "Copilot recorded a sender value that WIRE does not recognize.",
});
export function reportPromptOriginReason(prompt, snapshot) {
    const author = promptAuthorship.read(prompt);
    if (snapshot?.presentation?.originExplanationVersion === 1) {
        if (author.basis === "missing-source" && promptAuthorship.capture(prompt)?.reason) {
            return "WIRE could not establish the originating prompt from the available message context.";
        }
        const reason = author.issue ? originIssueReasonsV1[author.issue] : originReasonsV1[author.basis];
        if (typeof reason !== "string") throw new TypeError("Unsupported frozen prompt-origin explanation.");
        return reason;
    }
    return legacyOriginReasons[author.basis];
}
const millisecondsTiming = createTimingPresentation(undefined, { compact: true });
const millisecondsFormatter = createReportComparison(undefined, millisecondsTiming.duration);
export const reportTimingPresentation = snapshot => snapshot?.presentation?.schemaVersion === 3 ? millisecondsTiming : createTimingPresentation();
const reportFormatter = snapshot => snapshot?.presentation?.schemaVersion === 3 ? millisecondsFormatter : formatter;
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
function recordedOutcomeFields(totals, layer, includeSuccess = true) {
    const names = layer === "tool-call" || !layer
        ? { success: "Succeeded", failure: "Failed", partial: "Partial", unknown: "Unknown", other: "Other", transport: "No response" }
        : { success: "Recorded 2xx", failure: "Recorded error", partial: "Partial", unknown: "No status", other: "Other status", transport: "No response" };
    return Object.entries(names).filter(([key]) => totals[key] > 0 && (includeSuccess || key !== "success"))
        .map(([key, label]) => [label, totals[key]]);
}
const recordedBreakdown = (totals, layer, includeSuccess) => recordedOutcomeFields(totals, layer, includeSuccess).map(([label, value]) => `${label}: ${value}`).join("; ");
function presentedView(view, numeric) {
    return `<strong class="comparison-metric-value ${view.tone}${numeric ? "" : " report-cell-text"}">${escapeReportText(view.value.replace(/ (?=(?:ms|s)(?:\)|$))/g, "\u00a0"))}</strong><span class="comparison-meta report-cell-text">${escapeReportText(view.note)}</span>`;
}
export function reportBrandHeader(title = "Activity report", snapshot) {
    const version = snapshot?.presentation?.brandVersion;
    if (version !== undefined && version !== 1 && version !== 2) throw new TypeError("Unsupported frozen report brand.");
    const marks = version === 2 ? brandLockup + brandDarkLockup
        : version === 1 ? brandV1Mark + brandV1DarkMark : brandMark + brandDarkMark;
    return `<header class="report-brand" aria-label="${PRODUCT_NAME}"><h1>${escapeReportText(title)}</h1><div class="report-mark" aria-hidden="true">${marks}</div></header>`;
}
export const reportBrandStyles = `
.report-brand{display:flex;align-items:flex-start;justify-content:space-between;gap:1.5rem;margin:0 0 1rem;break-inside:avoid}
.report-brand h1{min-width:0;margin:0;font-size:var(--type-title);line-height:1.25;font-weight:var(--weight-strong);text-wrap:balance}
.report-facts{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;margin:.5rem 0 1rem;font-size:var(--type-small);line-height:1.5}
.report-facts>div{display:flex;flex-wrap:wrap;gap:.25rem .5rem;min-width:0;max-width:100%;break-inside:avoid}
.report-facts dt{color:var(--muted)}.report-facts dd{margin:0;overflow-wrap:anywhere}
.report-negative{color:var(--danger)}.report-numeric{text-align:right;font-variant-numeric:tabular-nums}
.report-cell-text{text-align:left}
.report-mark{flex:none;padding-top:.15rem}.report-brand .brand-logo{display:block;width:7rem;height:auto}
.report-brand .brand-logo[data-brand-theme=dark]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=light]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=dark]{display:block}
@media screen and (max-width:40rem){.report-brand{flex-direction:column;gap:.5rem}.report-brand .brand-logo{width:5.5rem}}
`;
export const reportDocumentTokens = `
:root,:root[data-evidence-theme=light]{
 --font:"Asta Sans","Segoe UI",sans-serif;--weight-strong:600;--tracking-heading:0;
 --type-title:1.75rem;--type-small:.875rem;--type-caption:.8125rem;
 --page:#fff;--paper:#fff;--canvas:#f3f3f3;--hover:#ececec;--ink:#202020;--muted:#565656;--rule:#e3e3e3;
 --accent:#303030;--accent-soft:#ececec;--accent-pressed:#dedede;--focus:#303030;
 --danger:#b3261e;--performance-red:#b3261e;--chart-failure:#b3261e;
}
:root[data-evidence-theme=dark]{
 --page:#101010;--paper:#191919;--canvas:#242424;--hover:#2b2b2b;--ink:#f2f2f2;--muted:#b8b8b8;--rule:#353535;
 --accent:#e0e0e0;--accent-soft:#2b2b2b;--accent-pressed:#3b3b3b;--focus:#e0e0e0;
 --danger:#f28b82;--performance-red:#f28b82;--chart-failure:#f28b82;--unknown:#b8b8b8;
}
`;
export const reportPrintPaginationStyles = `
@media print {
 .prompt-record{margin:.25em 0;padding:.25em 0}
 .prompt-record>summary{margin:0 0 .35em;break-inside:avoid;break-after:avoid}
 .prompt-record .ref{font-size:10pt;line-height:1.35}
 .prompt-record>summary .ref{display:inline;margin-inline-start:.5em}
 .prompt{break-inside:avoid}
 .prompt h4{margin:.4em 0 .25em}
 .prompt>p:not(.removal){margin:.25em 0;break-after:avoid}
 .prompt pre{margin:.25em 0 .4em;padding:4px 8px}
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
.comparison-document{box-sizing:border-box;background:var(--paper);color:var(--ink);max-width:64rem;margin:0 auto;padding:32px}
.comparison-document .comparison-meta{font-size:var(--type-caption);line-height:var(--leading-caption)}
.comparison-document .comparison-metric-value{font-size:1rem;line-height:1.5;font-weight:var(--weight-medium)}
.comparison-document .comparison-metrics thead,.comparison-document .comparison-patterns thead{background:transparent}
.comparison-document :is(.comparison-metrics,.comparison-patterns) :is(th,td){padding:10px 12px}
.comparison-document :is(.comparison-metrics,.comparison-patterns) tr>:first-child{padding-left:0}
.comparison-document :is(.comparison-metrics,.comparison-patterns) tr>:last-child{padding-right:0}
.comparison-document :is(.comparison-metrics,.comparison-patterns) tbody th{font-weight:var(--weight-medium)}
.comparison-document :is(th,td).report-numeric{text-align:right;font-variant-numeric:tabular-nums}
.comparison-document h2{font-size:var(--type-section);font-weight:600;margin:1.5rem 0 .75rem}
.comparison-document .report-summary{max-width:72ch;margin:1rem 0;line-height:var(--leading-reading)}
.comparison-document .comparison-score-pair{gap:1.5rem;border:0;border-block:1px solid var(--rule);border-radius:0;padding:1rem 0}
.comparison-document .comparison-score{border:0;border-radius:0;background:transparent;padding:0;box-shadow:none}
.comparison-document .comparison-score-value{font-size:1.5rem}
.comparison-document .comparison-outcome-failure{--column-label:var(--danger)}
.comparison-document .comparison-outcome-strip>span{background:var(--column-label)}
.comparison-document .reading-notes{margin-top:1.5rem;padding:.5rem 0;border:0;border-top:1px solid var(--rule);border-radius:0}
.comparison-document .reading-notes p{max-width:75ch}
.comparison-document summary{min-height:44px;cursor:pointer;padding:.65rem 0}
.comparison-document :is(summary,a):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
@media(max-width:420px){.comparison-document{padding:16px}}
@media print{
 :root,body{background:white!important;color:#172333}body{font-size:10pt}.report-accessible-name{display:none}
 .comparison-document .comparison-meta,.comparison-metrics,.comparison-patterns{font-size:10pt;line-height:1.45}
 .comparison-document .comparison-metric-value{font-size:10pt;line-height:1.4}
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
 .comparison-document summary{min-height:0;padding:.25em 0}
 .comparison-document :is(.comparison-metrics,.comparison-patterns) :is(th,td){padding:5px 8px}
 .comparison-document :is(h2,h3,summary,caption,thead){break-after:avoid}
 .comparison-document :is(h2,h3,summary)+p:not(:last-child){break-after:avoid}
 .comparison-document tbody>tr:first-child{break-before:avoid}
 .comparison-document .report-footer{break-before:avoid;break-inside:avoid}
}
`;
const comparisonReadingStyles = `
.comparison-reading-v1{container-type:inline-size}
.comparison-reading-v1 .comparison-source-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:0 0 1.5rem}
.comparison-reading-v1 .comparison-source-pair h2{margin:0 0 .35rem;font-size:1rem}
.comparison-reading-v1 .comparison-source-pair p{margin:.25rem 0}
.comparison-reading-v1 :is(th,td,h2,h3,.comparison-mobile-label){overflow-wrap:normal;word-break:normal}
.comparison-reading-v1 .comparison-meta{overflow-wrap:anywhere}
.comparison-reading-v1 .comparison-score-pair{grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.comparison-reading-v1 .comparison-score-value{white-space:nowrap}
.comparison-reading-v1 #result-comparison section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1rem}
.comparison-reading-v1 #result-comparison section>:is(h3,p:last-child:not(:nth-child(3))){grid-column:1/-1}
.comparison-reading-v1 #result-comparison section p{margin:.25rem 0}
@container (max-width:38rem){
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns),
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) tbody{display:block}
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) thead{display:none}
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;padding:1rem 0;border-bottom:1px solid var(--rule)}
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) tr>:is(th,td){display:block;width:auto!important;padding:0!important;border:0;min-width:0}
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) tbody th,
 .comparison-reading-v1 :is(.comparison-metrics,.comparison-patterns) tbody td:last-child,
 .comparison-reading-v1 .comparison-patterns tbody td:nth-child(2){grid-column:1/-1}
 .comparison-reading-v1 .comparison-mobile-label{display:block;font:inherit;color:var(--muted);margin-bottom:.35rem}
}
@media print{
 .comparison-reading-v1{container-type:normal}
 .comparison-reading-v1 .comparison-source-pair{break-inside:avoid}
}
`;
function sourceIdentityHtml(identities) {
    return `<section class="comparison-source-pair" aria-label="Compared reports">${identities.map((side, index) =>
        `<div><h2>${index ? "Later" : "Earlier"}: ${escapeReportText(side.title ?? "Title not recorded")}</h2>
        <p>${escapeReportText(comparisonSourceWindow(side))}</p><p class="comparison-meta">${escapeReportText(side.timeContext?.timeZone ?? "Time zone not recorded")}; ${side.sourceCount === null ? "included interaction count not recorded" : `${side.sourceCount} included ${side.sourceCount === 1 ? "interaction" : "interactions"}`}</p></div>`).join("")}</section><p class="comparison-meta">Selected windows are report choices, not verified per-call coverage.</p>`;
}
const operationFailureLabel = layer => layer === "tool-call" || !layer ? "tool calls failed"
    : layer === "owned-http" ? "HTTP records showed errors"
        : layer === "graph-request-site" ? "request sites recorded error statuses" : "returned API entries recorded errors";
export function comparisonBodyHtml(model, snapshot) {
    const identities = validateComparisonIdentity(model), current = identities !== null;
    const formatter = reportFormatter(snapshot);
    const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
    const evidence = model.primaryEvidence ?? { heading: "Recorded tool outcomes", unitLabel: "calls", successVerb: "succeeded", note: "Tool outcomes are not verified task completion." };
    const { available, unavailable, unavailableLabel } = formatter.metricGroups(model.metrics);
    const metricTable = (metrics, label) => `<table class="comparison-metrics"><caption>${escapeReportText(label)}</caption><thead><tr><th>Measure</th><th class="report-numeric">Earlier</th><th class="report-numeric">Later</th><th class="report-numeric">Change</th></tr></thead><tbody>${metrics.map(metric => {
        const reading = reportMeasurePresentation(metric);
        const change = metric.delta ? metric.delta.value === 0 ? "Unchanged"
            : formatter.formatChange(metric.delta.value, metric.delta.unit)
            : metric.status === "incompatible" ? "Different definitions" : "Not comparable";
        return `<tr><th scope="row">${escapeReportText(reading.label)}${reading.definition ? `<span class="comparison-meta">${escapeReportText(reading.definition)}</span>` : ""}</th>
            <td class="report-numeric"><span class="comparison-mobile-label">Earlier</span>${presentedView(formatter.comparisonSidePresentation(metric, "baseline"), metric.baseline?.state === "available")}</td><td class="report-numeric"><span class="comparison-mobile-label">Later</span>${presentedView(formatter.comparisonSidePresentation(metric, "later"), metric.later?.state === "available")}</td><td class="report-numeric"><span class="comparison-mobile-label">Change</span>${metric.delta && metric.delta.value !== 0 ? escapeReportText(change) : reportTextCell(change)}</td></tr>`;
    }).join("")}</tbody></table>`;
    const displays = new Map((model.patternDisplays ?? []).map(pattern => [pattern.patternId, pattern]));
    const patterns = primary?.patterns.map(pattern => {
        const display = displays.get(pattern.patternId);
        const label = display?.available ? display.workload : "Pattern unavailable";
        const counts = total => total.count ? `${formatter.formatValue(total.failureRate.percent, "percent")}<span class="comparison-meta report-cell-text">${total.failure} of ${total.count} ${escapeReportText(current ? operationFailureLabel(model.primaryLayer) : `${evidence.unitLabel} recorded errors`)}</span>` : reportTextCell("Not present");
        const change = pattern.change.failure;
        return `<tr><th scope="row">${escapeReportText(label)}${(display?.endpoints ?? []).map(endpoint => `<span class="comparison-meta">${escapeReportText(endpoint.pathTemplate)}</span>`).join("")}</th>
            <td><span class="comparison-mobile-label">Tool</span>${escapeReportText(display?.available ? display.tool : "Unavailable")}</td>
            <td class="report-numeric"><span class="comparison-mobile-label">Earlier</span>${counts(pattern.baseline)}</td><td class="report-numeric"><span class="comparison-mobile-label">Later</span>${counts(pattern.later)}</td><td class="report-numeric"><span class="comparison-mobile-label">Change</span>${change === null ? reportTextCell("Not comparable") : change === 0 ? reportTextCell("Unchanged") : escapeReportText(`${change > 0 ? "+" : "−"}${formatter.formatValue(Math.abs(change), "percentage-points")}`)}</td></tr>`;
    }).join("") ?? "";
    const scores = primary ? [["Earlier", primary.raw.baseline], ["Later", primary.raw.later]].map(([label, total]) => {
        const score = !total.count ? `No ${evidence.unitLabel}` : total.success + total.failure === 0 ? model.metricProjectionVersion === 4 ? "Success rate unavailable" : "Not scored"
            : formatter.formatValue(total.successRate.percent, "percent");
        const strip = ["success", "failure", "partial", "unknown", "other", "transport"].filter(outcome => total[outcome])
            .map(outcome => `<span class="comparison-outcome-${outcome} dimensional-tone-${formatter.outcomeTone(outcome)}" style="flex-grow:${total[outcome]}"></span>`).join("");
        const remaining = recordedOutcomeFields(total, model.primaryLayer, false);
        return `<article class="comparison-score"><h3>${label}</h3><strong class="comparison-score-value">${escapeReportText(score)}</strong>
            ${total.count ? `<p>${total.success} of ${total.count} ${escapeReportText(evidence.unitLabel)} ${escapeReportText(evidence.successVerb)}</p><div class="comparison-outcome-strip" aria-hidden="true">${strip}</div>` : ""}${remaining.length ? reportFieldsHtml(remaining) : ""}</article>`;
    }).join("") : "";
    const native = model.nativeComparison ? `<section><h2>Microsoft activity</h2><p class="comparison-meta">${escapeReportText(model.nativeComparison.qualification)}</p>
        <table class="comparison-metrics"><thead><tr><th>Source and measure</th><th class="report-numeric">Earlier</th><th class="report-numeric">Later</th><th class="report-numeric">Change</th></tr></thead><tbody>
        ${formatter.nativeRows(model).map(row => `<tr><th scope="row"${row.failure ? ' class="report-negative"' : ""}>${escapeReportText(row.label)}<span class="comparison-meta">${escapeReportText(row.source)}</span></th>
            ${[row.earlier, row.later, row.change].map((value, index) => `<td class="${row.numeric[index + 1] ? "report-numeric" : "report-cell-text"}"><span class="comparison-mobile-label">${["Earlier", "Later", "Change"][index]}</span>${escapeReportText(value)}</td>`).join("")}</tr>`).join("")}
        </tbody></table></section>` : "";
    const narrative = model.narrative ? `<p class="report-summary"><strong>${escapeReportText(model.narrative.heading)}</strong> ${escapeReportText(model.narrative.detail)}</p>` : "";
    const application = resultComparisonHtml(model.resultComparison) + comparisonResultTextHtml(model.resultTextSources ?? (model.resultProjectionVersion === 1 ? null : undefined));
    return `<div class="report-comparison${current ? " comparison-reading-v1" : ""}">${current ? sourceIdentityHtml(identities) : narrative}
        ${native}
        ${current ? "" : resultComparisonHtml(model.resultComparison)}
        ${current ? "" : comparisonResultTextHtml(model.resultTextSources ?? (model.resultProjectionVersion === 1 ? null : undefined))}
        ${primary ? `<section class="comparison-tool-results"><h2>${escapeReportText(evidence.heading)}</h2>${model.resultProjectionVersion === 1 && !evidence.note ? "" : `<p class="comparison-meta">${escapeReportText(model.resultProjectionVersion === 1 ? evidence.note : model.metricProjectionVersion === 4 && model.primaryLayer === "tool-call" ? "Successful calls do not establish task completion." : evidence.note)}</p>`}<div class="comparison-score-pair">${scores}</div></section>` : ""}
        ${available.length ? metricTable(available, "Recorded measures") : ""}
        ${current ? narrative + application : ""}
        ${unavailable.length ? `<details class="comparison-unavailable"><summary>Measures without a result (${unavailable.length})<span class="comparison-meta">${escapeReportText(unavailableLabel)}</span></summary>${metricTable(unavailable, "Unavailable measures and coverage")}</details>` : ""}
        ${patterns ? `<section><h2>Operations</h2>${current ? `<p class="comparison-meta">${escapeReportText(operationFailureLabel(model.primaryLayer))}; each rate uses that operation's selected population.</p>` : ""}<table class="comparison-patterns" aria-label="Operations present in either report"><thead><tr><th>Activity category</th><th>Tool</th><th class="report-numeric">Earlier failures</th><th class="report-numeric">Later failures</th><th class="report-numeric">Change</th></tr></thead><tbody>${patterns}</tbody></table></section>` : ""}
        <details class="reading-notes"><summary>Coverage and sources</summary>${[...formatter.scopeNotes(model), ...formatter.readingNotesFor(model), formatter.comparisonNote].map(text => `<p>${escapeReportText(text)}</p>`).join("")}
        ${snapshot ? `<p>Comparison: ${escapeReportText(snapshot.bundleId)}.</p>${snapshot.sourceReports.map((source, index) => `<p>${index ? "Later" : "Earlier"} source: ${escapeReportText(source.bundleId)}.</p>`).join("")}<p>Deleting a source does not rewrite this reviewed copy.</p>` : ""}</details></div>`;
}
export function renderComparisonHtml(model, snapshot) {
    const current = validateComparisonIdentity(model) !== null;
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
        <title>${PRODUCT_NAME} - ${escapeReportText(snapshot.title || "report comparison")}</title><style>${reportPresentationStyles}${current ? comparisonReadingStyles : ""}@page{size:A4;margin:16mm}</style></head>
        <body class="comparison-document"><main>${reportBrandHeader(snapshot.title || "Report comparison", snapshot)}${current ? "" : `<p>${escapeReportText(snapshot.preparedAtDisplay)}</p>`}
        ${comparisonBodyHtml(model, snapshot)}${current ? `<p class="comparison-meta">Prepared ${escapeReportText(snapshot.preparedAtDisplay)}</p>` : ""}<p class="report-footer">${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}</p></main></body></html>`;
}
export function renderComparisonMarkdown(model, snapshot) {
    const identities = validateComparisonIdentity(model), current = identities !== null;
    const formatter = reportFormatter(snapshot);
    const lines = [snapshot.title ? `# ${escapeReportMarkdown(snapshot.title)}` : `# ${PRODUCT_NAME} - report comparison`, "",
        ...(current ? [] : [snapshot.preparedAtDisplay, ""])];
    if (current) for (const [index, side] of identities.entries()) lines.push(
        `## ${index ? "Later" : "Earlier"}: ${escapeReportMarkdown(side.title ?? "Title not recorded")}`, "",
        escapeReportMarkdown(comparisonSourceWindow(side)), "",
        `${escapeReportMarkdown(side.timeContext?.timeZone ?? "Time zone not recorded")}; ${side.sourceCount === null ? "included interaction count not recorded" : `${side.sourceCount} included ${side.sourceCount === 1 ? "interaction" : "interactions"}`}`, "");
    if (current) lines.push("Selected windows are report choices, not verified per-call coverage.", "");
    function interpretation() {
        if (model.narrative) lines.push(`**${model.narrative.heading}** ${model.narrative.detail}`, "");
        lines.push(...resultComparisonMarkdown(model.resultComparison));
        lines.push(...comparisonResultTextMarkdown(model.resultTextSources ?? (model.resultProjectionVersion === 1 ? null : undefined)));
    }
    if (!current) interpretation();
    if (model.nativeComparison) {
        lines.push("## Microsoft activity", "", model.nativeComparison.qualification, "",
            "| Source and measure | Earlier | Later | Change |", "|---|---:|---:|---:|");
        for (const row of formatter.nativeRows(model)) lines.push(`| ${escapeReportMarkdown(`${row.source}: ${row.label}`)} | ${reportValueCell(row.earlier, row.numeric[1])} | ${reportValueCell(row.later, row.numeric[2])} | ${reportValueCell(row.change, row.numeric[3])} |`);
        lines.push("");
    }
    const { available, unavailable } = formatter.metricGroups(model.metrics);
    function measures(metrics, heading) {
        if (!metrics.length) return;
        lines.push("", `## ${heading}`, "", "| Measure | Earlier | Later | Change |", "|---|---:|---:|---:|");
        for (const metric of metrics) {
            const a = formatter.comparisonSidePresentation(metric, "baseline"), b = formatter.comparisonSidePresentation(metric, "later");
            const reading = reportMeasurePresentation(metric), origin = reading.definition;
            const change = metric.delta?.value === 0 ? "Unchanged" : metric.delta ? snapshot.presentation?.schemaVersion === 3 && metric.delta.unit === "ms"
                ? formatter.formatChange(metric.delta.value, metric.delta.unit)
                : formatter.formatValue(metric.delta.value, metric.delta.unit) : "Not comparable";
            lines.push(`| ${escapeReportText(reading.label)}${origin ? `<br>${escapeReportText(origin)}` : ""} | ${reportValueCell(a.value, metric.baseline?.state === "available", a.note)} | ${reportValueCell(b.value, metric.later?.state === "available", b.note)} | ${metric.delta && metric.delta.value !== 0 ? escapeReportText(change) : reportTextCell(change)} |`);
        }
    }
    const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
    const evidence = model.primaryEvidence ?? { heading: "Recorded tool outcomes", unitLabel: "calls", successVerb: "succeeded", note: "Tool outcomes do not establish task completion." };
    if (primary) {
        lines.push("", `## ${evidence.heading}`, "",
            model.resultProjectionVersion === 1 ? evidence.note : model.metricProjectionVersion === 4 && model.primaryLayer === "tool-call" ? "Successful calls do not establish task completion." : evidence.note,
            "", `| Period | ${escapeReportText(evidence.successVerb[0].toUpperCase() + evidence.successVerb.slice(1))} / ${escapeReportText(evidence.unitLabel)} | Other recorded outcomes |`, "|---|---:|---|",
            ...[["Earlier", primary.raw.baseline], ["Later", primary.raw.later]].map(([name, total]) =>
                `| ${name} | ${total.success} / ${total.count} | ${escapeReportText(recordedBreakdown(total, model.primaryLayer, false) || "None")} |`));
    }
    measures(available, "Recorded measures");
    if (current) interpretation();
    if (primary) {
        lines.push("", "## Operations", "", ...(current ? [operationFailureLabel(model.primaryLayer), ""] : []),
            `| Activity category | Tool${current ? " and operation" : ""} | Earlier ${current ? "failures" : "errors"} / ${evidence.unitLabel} | Later ${current ? "failures" : "errors"} / ${evidence.unitLabel} | Change (percentage points) |`, "|---|---|---:|---:|---:|");
        const displays = new Map((model.patternDisplays ?? []).map(pattern => [pattern.patternId, pattern]));
        for (const pattern of primary.patterns) {
            const display = displays.get(pattern.patternId);
            const operation = current ? [display?.available ? display.tool : "Unavailable", ...(display?.endpoints ?? []).map(endpoint => endpoint.pathTemplate)].map(escapeReportMarkdown).join("<br>") : escapeReportText(display?.available ? display.tool : "Unavailable");
            lines.push(`| ${escapeReportText(display?.available ? display.workload : "Pattern unavailable")} | ${operation} | ${pattern.baseline.failure}/${pattern.baseline.count} | ${pattern.later.failure}/${pattern.later.count} | ${pattern.change.failure === null ? reportTextCell("Not comparable") : escapeReportText(formatter.formatValue(pattern.change.failure, "percentage-points"))} |`);
        }
    }
    measures(unavailable, "Unavailable measures and coverage");
    return [...lines, "", "## Scope and coverage", "", ...formatter.scopeNotes(model).flatMap(text => [text, ""]), ...formatter.readingNotesFor(model).flatMap(text => [text, ""]), formatter.comparisonNote, "",
        `Frozen comparison: ${snapshot.bundleId}`, ...snapshot.sourceReports.map(source => `Source: ${source.bundleId} (${source.snapshotHash})`), "", "Deleting a source report does not rewrite this reviewed comparison copy.", "",
        ...(current ? [`Prepared ${snapshot.preparedAtDisplay}`, ""] : []), `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`, ""].join("\n");
}
