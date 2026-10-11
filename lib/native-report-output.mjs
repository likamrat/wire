import * as contract from "./assessment-contract.mjs";
import { freezeEvaluationFacts, evaluationMetricFacts } from "./report-facts.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { escapeReportText, reportPrintPaginationStyles } from "./report-presentation.mjs";
import { tokens } from "../web/tokens.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { promptAuthorStyles } from "../web/prompt-author-styles.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, brandMark, brandDarkMark } from "./branding.mjs";

const escape = escapeReportText;
const presentation = createAssessmentPresentation(contract);
const formatter = createReportComparison();

export function nativeReportEvidence(snapshot) {
    if (!snapshot?.evaluationFacts) return null;
    const facts = freezeEvaluationFacts(snapshot.evaluationFacts);
    return presentation.summarize(facts.metrics, {
        membershipStatus: facts.scope.membership === "exact-retained" ? "complete-retained" : "partial",
        reviewStatuses: facts.reviewStatuses ?? null,
        assessmentAttempts: facts.assessmentAttempts ?? null,
    });
}

function findingItems(model) {
    if (!model) return [{ text: "Assessment facts and operational reasons were not saved. Tool outcomes alone do not establish answer quality." }];
    const { findings } = model;
    return [...findings.operational, ...findings.answers,
        ...[findings.rationale, findings.qualification, model.readingWarning].filter(Boolean).map(text => ({ text }))];
}

function findingOrigin({ provenance }) {
    if (!provenance) return "";
    if (provenance.origin !== "model-assessed") return provenance.label;
    return formatter.definitionLabel({ baseline: {
        basis: "model-assessment", qualifiers: {
            evaluatorModel: provenance.evaluator?.model,
            rubricId: provenance.evaluator?.rubricId,
            rubricVersion: provenance.evaluator?.rubricVersion,
        },
    } });
}

export function nativeFindingsHtml(model) {
    const lines = findingItems(model).map(item => {
        const text = item.parts ? `${escape(item.prefix)}${item.parts.map(part => `<span class="finding-${part.tone}">${escape(part.text)}</span>`).join("; ")}${escape(item.suffix)}`
            : escape(item.text);
        const origin = findingOrigin(item);
        return `${text}${origin ? `<span class="reading-note">${escape(origin)}</span>` : ""}`;
    });
    return `<section id="findings"><h2>What the record shows</h2><ul class="native-findings">${lines.map(line => `<li>${line}</li>`).join("")}</ul>
        <p class="reading-note">These findings describe the selected recorded interactions, not complete history or a newly verified outcome. Known call reasons are historical; missing explanations are not reconstructed.</p></section>`;
}

export function nativeReportHeader() {
    return `<header class="report-brand" aria-label="${PRODUCT_NAME}">${brandMark}${brandDarkMark}<p>${PRODUCT_DESCRIPTION}</p><h1><span class="report-accessible-name">${PRODUCT_NAME} </span>Personal interaction report</h1></header>`;
}

export function nativeFindingsMarkdown(model) {
    return ['<a id="findings"></a>', "## What the record shows", "", ...findingItems(model).map(item => {
        const origin = findingOrigin(item);
        return `- ${escape(item.text)}${origin ? ` ${escape(origin)}` : ""}`;
    }), "",
        "These findings describe the selected recorded interactions, not complete history or a newly verified outcome. Known call reasons are historical; missing explanations are not reconstructed.", ""];
}

export const nativeShare = (count, total) => total ? formatter.formatValue(count * 100 / total, "percent") : "Not applicable";
const timingValue = (row, percentile) => row.timed === 0 ? "Not measured"
    : percentile === "p95" && row.timed === 1 ? "Not shown for one sample"
        : `${percentile === "p95" ? row.display.p95 : row.display.median} (${row.distribution[percentile === "p95" ? "p95Ms" : "p50Ms"]} ms)`;
const timingRows = model => model?.evidence.timing ?? [];
const timingNote = row => `${row.coverageLabel}; ${row.missingLabel}. ${row.boundaryLabel}. ${row.limitation}`;

export function nativeTimingHtml(model) {
    const rows = timingRows(model);
    return `<section id="timing"><h2>Recorded timing</h2>${rows.length ? `<table class="native-table"><caption>Separate measured boundaries; nearest-rank median and P95</caption><thead><tr><th scope="col">Boundary and coverage</th><th scope="col">Median / single sample</th><th scope="col">P95</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escape(row.label)}<span class="reading-note">${escape(timingNote(row))}</span></th><td data-label="Median / single sample">${escape(timingValue(row, "median"))}</td><td data-label="P95">${escape(timingValue(row, "p95"))}</td></tr>`).join("")}</tbody></table>` : "<p>Timing samples were not saved.</p>"}
        <p class="reading-note">Concurrent call durations are never added into task latency. A recorded final response is not proof that the task succeeded.</p></section>`;
}

export function nativeTimingMarkdown(model) {
    const rows = timingRows(model);
    return ['<a id="timing"></a>', "## Recorded timing", "", "Separate measured boundaries; nearest-rank median and P95.", "",
        ...(rows.length ? ["| Boundary and coverage | Median / single sample | P95 |", "|---|---|---|",
            ...rows.map(row => `| ${escape(row.label)}. ${escape(timingNote(row))} | ${escape(timingValue(row, "median"))} | ${escape(timingValue(row, "p95"))} |`)] : ["Timing samples were not saved."]),
        "", "Concurrent call durations are never added into task latency. A recorded final response is not proof that the task succeeded.", ""];
}

function measureRows(snapshot) {
    if (!snapshot?.evaluationFacts) return [];
    return evaluationMetricFacts(snapshot.evaluationFacts).filter(metric => metric.metric !== "speed").map(metric => ({
        label: formatter.dimensionLabel(metric.metric),
        origin: formatter.definitionLabel({ baseline: metric }),
        ...formatter.metricPresentation(metric, metric.metric),
    }));
}

const completionChecks = model => (model?.evidence.execution ?? []).filter(row => row.kind === "execution");

export function nativeQualityHtml(snapshot, model) {
    const rows = measureRows(snapshot);
    return `<details id="quality" class="reading-notes"><summary>Quality results and definitions</summary>
        <p>Each row keeps its own assessment origin and coverage. Overlapping assessments are not added together; percentages are not averaged.</p>
        ${rows.length ? `<table class="native-table"><caption>Saved quality measures, not an overall grade</caption><thead><tr><th scope="col">Measure / origin</th><th scope="col">Result</th><th scope="col">Counts and coverage</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escape(row.label)}<span class="reading-note">${escape(row.origin)}</span></th><td data-label="Result" class="${row.tone}">${escape(row.value)}</td><td data-label="Counts and coverage">${escape(row.note)}</td></tr>`).join("")}</tbody></table>` : "<p>Quality measures were not saved.</p>"}
        ${completionChecks(model).map(row => `<p>Completion-evidence checks: ${row.counts.pass} passed; ${row.counts.fail} failed; ${row.counts.unassessed} unassessed; ${row.counts.evaluatorError} evaluator errors. ${row.eligible} eligible Work IQ calls. These checks require completion evidence and can differ from reported operational outcomes.</p>`).join("")}
        ${formatter.readingNotes.map(note => `<p>${escape(note)}</p>`).join("")}</details>`;
}

export function nativeQualityMarkdown(snapshot, model) {
    const rows = measureRows(snapshot);
    return ['<a id="quality"></a>', "## Quality results and definitions", "",
        "Each row keeps its own assessment origin and coverage. Overlapping assessments are not added together; percentages are not averaged.", "",
        ...(rows.length ? ["| Measure / origin | Result | Counts and coverage |", "|---|---|---|",
            ...rows.map(row => `| ${escape(row.label)} / ${escape(row.origin)} | ${escape(row.value)} | ${escape(row.note)} |`)] : ["Quality measures were not saved."]), "",
        ...completionChecks(model).map(row => `Completion-evidence checks: ${row.counts.pass} passed; ${row.counts.fail} failed; ${row.counts.unassessed} unassessed; ${row.counts.evaluatorError} evaluator errors. ${row.eligible} eligible Work IQ calls. These checks require completion evidence and can differ from reported operational outcomes.`), "",
        ...formatter.readingNotes.flatMap(note => [note, ""])];
}

export const nativeReportStyles = `
${tokens}
${dimensionalColumnStyles}
${promptAuthorStyles}
*{box-sizing:border-box}
:root{font-family:var(--font);font-variant-numeric:tabular-nums;background:var(--page);color:var(--ink)}
body{max-width:68rem;margin:0 auto;padding:2rem;font-size:var(--type-reading);line-height:var(--leading-reading)}
main{min-width:0}
h1,h2,h3,h4,summary{font-weight:var(--weight-strong);line-height:var(--leading-heading)}
h1{font-size:var(--type-title);letter-spacing:var(--tracking-heading)}h2{font-size:var(--type-section);line-height:var(--leading-section);margin:1.5rem 0 .65rem}h3,h4{font-size:var(--type-body);line-height:var(--leading-ui);margin:1rem 0 .5rem}
p,li,th,td,summary{overflow-wrap:anywhere}p{margin:.6rem 0}
.report-brand{margin-bottom:1.2rem}.report-brand .brand-logo{display:block;width:177px;height:56px}.report-brand p{color:var(--muted);font-size:var(--type-small)}
.report-brand .brand-logo[data-brand-theme=dark]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=light]{display:none}
:root[data-evidence-theme=dark] .report-brand .brand-logo[data-brand-theme=dark]{display:block}
.report-brand h1{margin:.65rem 0}.report-accessible-name{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.report-meta{white-space:pre-line;color:var(--muted);font-size:var(--type-small)}
.native-findings{padding-left:1.25rem;margin:.5rem 0}.native-findings li{margin:.3rem 0}
.finding-positive{color:var(--success)}.finding-negative{color:var(--danger)}
.reading-note,.reading-notes,.ref,.layer-notes,.report-footer{font-size:var(--type-small);color:var(--muted)}
span.reading-note{display:block;font-weight:var(--weight-regular)}
.report-nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem;border-block:1px solid var(--rule);padding:.4rem 0;margin:1rem 0}
a{color:var(--accent);text-underline-offset:.2em}.report-nav a{padding:.45rem .7rem;border:1px solid var(--rule);border-radius:var(--radius-control);background:var(--paper);font-size:var(--type-control);text-decoration:none}
.report-nav a:hover{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}.report-nav a:active{background:var(--accent-pressed)}
@media screen{.report-nav a{display:flex;align-items:center;min-height:44px}}
a:hover{color:var(--ink)}
:is(a,summary,[tabindex]):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.native-counts{display:flex;flex-wrap:wrap;gap:.5rem 2rem;margin:.75rem 0}.native-counts p{margin:0}.native-counts strong{font-size:var(--type-data-value)}
.native-breakdowns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem}
.native-breakdowns section{min-width:0}.native-breakdowns h3{margin-top:0;text-transform:uppercase;letter-spacing:.025em}
.native-bars{list-style:none;margin:0;padding:0}.native-bars li{margin:.8rem 0;break-inside:avoid}
.native-bar-heading{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 .8rem}
.native-bar-track{display:flex;width:100%;height:.5rem;background:var(--canvas);margin:.3rem 0;border-radius:var(--radius-pill);overflow:hidden}
.native-bar{display:block;min-width:0;flex-shrink:0;background:var(--column-label,var(--accent));background-image:linear-gradient(90deg,var(--chart-mark-low),var(--chart-mark-high))}
.native-bar-results{display:flex;flex-wrap:wrap;gap:.35rem;font-size:var(--type-small);color:var(--muted)}
.native-outcome{padding:3px 8px;border:1px solid var(--column-label);border-radius:var(--radius-pill);background:color-mix(in srgb,var(--column-label) 8%,var(--paper));color:var(--column-label);font-size:var(--type-caption);line-height:var(--leading-caption)}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:var(--type-small)}
caption{text-align:left;color:var(--muted);margin:.5rem 0}
th,td{text-align:left;padding:.6rem;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
thead{background:var(--canvas)}th{font-weight:var(--weight-strong)}
.native-table th:first-child{width:38%}
.table-wrap{overflow-x:auto;max-width:100%}
details{border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper);margin:1.1rem 0;padding:.5rem .75rem}
summary{cursor:pointer;min-height:44px;padding:.65rem 0;color:var(--ink)}summary:hover{color:var(--accent)}
.example{border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper);padding:.6rem 1rem;margin:1rem 0}
.example ol{padding-left:1.2rem}.example .ref{display:block}
.prompt-record{margin:.6rem 0}.prompt-record .ref{display:block;font-weight:var(--weight-regular)}
.prompt pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--canvas);padding:.6rem .8rem;margin:.5rem 0;max-width:100%}
.prompt h4{margin-bottom:.3rem}.prompt>p{font-size:var(--type-small)}.removal{font-weight:var(--weight-strong)}
#recorded-context>section{margin:1rem 0}#recorded-context ol{padding-left:1.5rem}
.service-glossary dl{margin:0}.service-glossary dl>div{margin:.5rem 0;break-inside:avoid}.service-glossary dt{font-weight:var(--weight-strong)}.service-glossary dd{margin:0}
.report-footer{border-top:1px solid var(--rule);padding-top:1rem;margin-top:1.5rem}
.performance-red{color:var(--performance-red)}.performance-orange{color:var(--performance-orange)}.performance-gold{color:var(--performance-gold)}.performance-teal{color:var(--performance-teal)}
.print-companion{display:none}
@media(max-width:700px){
 body{padding:1rem}.native-breakdowns{grid-template-columns:1fr}
 .native-table,.native-table tbody{display:block}.native-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
 .native-table tr{display:block;padding:.5rem 0;border-bottom:1px solid var(--rule)}
 .native-table th,.native-table td{display:block;width:100%!important;border:0;padding:.2rem 0}
 .native-table td[data-label]::before{content:attr(data-label) ": ";font-weight:var(--weight-strong)}
}
@media(forced-colors:active){.native-bar{background:CanvasText}.native-outcome{background:Canvas;color:CanvasText;border-color:CanvasText}a{color:LinkText}:is(a,summary,[tabindex]):focus-visible{outline-color:Highlight}}
@page{size:A4;margin:16mm}
@media print{
 :root{background:var(--paper);color:var(--ink)}
 body{padding:0;max-width:none;font-size:10pt}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}
 h1{font-size:18pt}h2{font-size:13pt}h3,h4{font-size:11pt}
 p,pre{orphans:3;widows:3}h2,h3,h4,summary{break-after:avoid}
 .report-accessible-name,.json-records-link{display:none}.print-companion{display:inline}
 .native-breakdowns{grid-template-columns:1fr 1fr;gap:12px}
 .native-table{display:table}.native-table tbody{display:table-row-group}.native-table tr{display:table-row}
 .native-table th,.native-table td{display:table-cell;padding:5px;border-bottom:1px solid var(--rule)}
 .native-table th:first-child{width:38%!important}.native-table td{width:auto!important}.native-table td::before{display:none}
 .native-table thead{position:static;width:auto;height:auto;clip-path:none;display:table-header-group}
 table,.reading-note,.reading-notes,.ref,.layer-notes,.report-meta,.native-bar-results,.prompt>p{font-size:10pt;line-height:1.4}
 .table-wrap{overflow:visible}tr{break-inside:avoid}.prompt pre{overflow:visible;max-height:none;font-size:10pt}
 details,details>*{display:block}details::details-content{content-visibility:visible}
 .native-counts strong{font-size:14pt}.report-nav{font-size:10pt}.report-nav a{padding:.1rem 0}
}
${reportPrintPaginationStyles}
`;
