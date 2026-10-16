import * as contract from "./assessment-contract.mjs";
import { freezeEvaluationFacts, evaluationMetricFacts } from "./report-facts.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { escapeReportText, reportPrintPaginationStyles } from "./report-presentation.mjs";
import { tokens } from "../web/tokens.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { promptAuthorStyles } from "../web/prompt-author-styles.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, brandMark, brandDarkMark } from "./branding.mjs";
import { fontFaceStyles } from "./typeface.mjs";

const escape = escapeReportText;
const presentation = createAssessmentPresentation(contract);
const formatter = createReportComparison();

export function nativeReportEvidence(snapshot) {
    if (!snapshot?.evaluationFacts) return null;
    const facts = freezeEvaluationFacts(snapshot.evaluationFacts);
    const model = presentation.summarize(facts.metrics, {
        membershipStatus: facts.scope.membership === "exact-retained" ? "complete-retained" : "partial",
        reviewStatuses: facts.reviewStatuses ?? null,
        assessmentAttempts: facts.assessmentAttempts ?? null,
    });
    if ([3, 4].includes(facts.metricProjectionVersion)) {
        model.metricProjectionVersion = facts.metricProjectionVersion;
        model.findings = { ...model.findings, operational: [],
            answers: model.findings.answers.filter(item => item.provenance?.origin === "user-personal"),
            rationale: null, qualification: null };
    }
    return model;
}

function findingItems(model, compact = false) {
    if (!model) return [{ text: "Assessment facts and operational reasons were not saved. Tool outcomes alone do not establish answer quality." }];
    const { findings } = model;
    return [...findings.operational, ...findings.answers,
        ...[findings.rationale, findings.qualification, model.readingWarning].filter(Boolean).map(text => ({ text }))]
        .map(item => compact && item.kind === "cause" ? { ...item, text: `${item.label} (${item.count} ${item.count === 1 ? "call" : "calls"}).` }
            : compact && item.kind === "missing" && model.evidence.assessmentAttempts.coverage.eligible > 0
                ? { ...item, text: "No saved answer or tool-use review." } : item);
}

function findingOrigin({ provenance, text, prefix }) {
    if (!provenance) return "";
    if (provenance.origin !== "model-assessed") return (prefix ?? text)?.startsWith(provenance.label + " /") ? "" : provenance.label;
    return formatter.definitionLabel({ baseline: {
        basis: "model-assessment", qualifiers: {
            evaluatorModel: provenance.evaluator?.model,
            rubricId: provenance.evaluator?.rubricId,
            rubricVersion: provenance.evaluator?.rubricVersion,
        },
    } });
}

export function nativeFindingsHtml(model, context) {
    const lines = findingItems(model, Boolean(context)).map(item => {
        const text = item.parts ? `${escape(item.prefix)}${item.parts.map(part => `<span class="finding-${part.tone}">${escape(part.text)}</span>`).join("; ")}${escape(item.suffix)}`
            : escape(item.text);
        const origin = findingOrigin(item);
        return `${text}${origin ? `<span class="reading-note">${escape(origin)}</span>` : ""}`;
    });
    if (!lines.length && !context) return "";
    return `<section id="findings"><h2>${context ? "At a glance" : "What the record shows"}</h2>${context ? `<p>${escape(context.lead)}</p><p>${escape(context.patterns.join(" "))}</p>` : ""}<ul class="native-findings">${lines.map(line => `<li>${line}</li>`).join("")}</ul>
        <p class="reading-note">These are saved observations, not complete history or proof of task completion. Missing explanations are not reconstructed.</p></section>`;
}

export function nativeReportHeader(title = "Activity report") {
    return `<header class="report-brand" aria-label="${PRODUCT_NAME}">${brandMark}${brandDarkMark}<p>${PRODUCT_DESCRIPTION}</p><h1><span class="report-accessible-name">${PRODUCT_NAME} </span>${escape(title)}</h1></header>`;
}

export function nativeFindingsMarkdown(model, context) {
    if (!findingItems(model, Boolean(context)).length && !context) return [];
    return ['<a id="findings"></a>', context ? "## At a glance" : "## What the record shows", "",
        ...(context ? [escape(context.lead), "", escape(context.patterns.join(" ")), ""] : []), ...findingItems(model, Boolean(context)).map(item => {
        const origin = findingOrigin(item);
        return `- ${escape(item.text)}${origin ? ` ${escape(origin)}` : ""}`;
    }), "",
        "These are saved observations, not complete history or proof of task completion. Missing explanations are not reconstructed.", ""];
}

export const nativeShare = (count, total) => total ? formatter.formatValue(count * 100 / total, "percent") : "Not applicable";
const timingValue = (row, percentile) => row.timed === 0 ? "Not measured"
    : percentile === "p95" && row.timed === 1 ? "Not shown for one sample"
        : `${percentile === "p95" ? row.display.p95 : row.display.median} (${row.distribution[percentile === "p95" ? "p95Ms" : "p50Ms"]} ms)`;
const timingRows = model => model?.evidence.timing ?? [];
const timingNote = row => `${row.coverageLabel}${row.notTimed ? `; ${row.missingLabel}` : ""}. ${row.boundaryLabel}.${row.timed === 1 ? ` ${row.limitation}` : ""}`;
const untimedNote = row => `${row.label}: Not measured (${row.coverageLabel}${row.eligible ? "" : `; ${row.missingLabel}`}). ${row.boundaryLabel}.`;
const timingMethod = "Median/P95 use nearest-rank timed samples (lower-middle median for even counts). Missing timing is not zero; concurrent calls are not added together. A final response does not prove task success.";

export function nativeTimingHtml(model) {
    const rows = timingRows(model), measured = rows.filter(row => row.timed > 0);
    return `<section id="timing"><h2>Recorded timing</h2>${measured.length ? `<table class="native-table"><caption>Separate measured boundaries</caption><thead><tr><th scope="col">Boundary and coverage</th><th scope="col">Median / single sample</th><th scope="col">P95</th></tr></thead><tbody>${measured.map(row => `<tr><th scope="row">${escape(row.label)}<span class="reading-note">${escape(timingNote(row))}</span></th><td data-label="Median / single sample">${escape(timingValue(row, "median"))}</td><td data-label="P95">${escape(timingValue(row, "p95"))}</td></tr>`).join("")}</tbody></table>` : !rows.length ? "<p>Timing samples were not saved.</p>" : ""}
        ${rows.filter(row => !row.timed).map(row => `<p class="reading-note">${escape(untimedNote(row))}</p>`).join("")}
        <p class="reading-note">${escape(timingMethod)}</p></section>`;
}

export function nativeTimingMarkdown(model) {
    const rows = timingRows(model), measured = rows.filter(row => row.timed > 0);
    return ['<a id="timing"></a>', "## Recorded timing", "",
        ...(measured.length ? ["| Boundary and coverage | Median / single sample | P95 |", "|---|---|---|",
            ...measured.map(row => `| ${escape(row.label)}. ${escape(timingNote(row))} | ${escape(timingValue(row, "median"))} | ${escape(timingValue(row, "p95"))} |`)] : !rows.length ? ["Timing samples were not saved."] : []),
        "", ...rows.filter(row => !row.timed).flatMap(row => [escape(untimedNote(row)), ""]), timingMethod, ""];
}

function measureRows(snapshot) {
    if (!snapshot?.evaluationFacts) return [];
    return evaluationMetricFacts(snapshot.evaluationFacts).filter(metric => metric.metric !== "speed").map(metric => ({
        label: formatter.metricLabel(metric),
        origin: formatter.definitionLabel({ baseline: metric }),
        modelReview: metric.basis === "model-assessment",
        coverage: metric.coverage,
        unsupportedLocal: metric.basis === "automatic-assessment" && metric.reason === "unsupported-check"
            && metric.value === null && metric.coverage?.eligible > 0
            && metric.counts?.pass === 0 && metric.counts.fail === 0 && metric.counts.evaluatorError === 0
            && metric.qualifiers?.checkVersion === 1
            && ["semantic-answer-correctness", "answer-support-validity", "action-authorization-compliance"].includes(metric.qualifiers.checkId),
        ...formatter.metricPresentation(metric, metric.metric, { includeOrigin: false }),
    }));
}

const completionChecks = model => (model?.evidence.execution ?? []).filter(row => row.kind === "execution");
const qualityReadingNotes = formatter.readingNotes.slice(0, 3);
const completionReading = row => `Completion checks: ${row.counts.pass} passed; ${row.counts.fail} failed; ${row.counts.unassessed} unassessed; ${row.counts.evaluatorError} check errors (${row.eligible} eligible Work IQ ${row.eligible === 1 ? "call" : "calls"}). These are not answer reviews.`;

export function nativeQualityHtml(snapshot, model) {
    if (snapshot?.evaluationFacts?.metricProjectionVersion === 4) return "";
    const allRows = measureRows(snapshot), local = allRows.filter(row => row.unsupportedLocal);
    if (snapshot?.evaluationFacts?.metricProjectionVersion === 3) {
        if (!allRows.length) return "";
        return `<section id="quality"><h2>Personal feedback</h2><p>Saved personal opinions do not change recorded outcomes or grant permission.</p>
            <table class="native-table"><caption>Personal feedback over selected requests</caption><thead><tr><th>Feedback</th><th>Result</th><th>Scope</th></tr></thead><tbody>${allRows.map(row =>
            `<tr><th>${escape(row.label)}</th><td>${escape(row.value)}</td><td>${escape(row.note)}</td></tr>`).join("")}</tbody></table></section>`;
    }
    const shared = local.length > 0 && local.every(row => row.origin === local[0].origin);
    const rows = shared ? allRows.filter(row => !row.unsupportedLocal) : allRows;
    return `<details id="quality" class="reading-notes"><summary>Quality results and definitions</summary>
        <p>${shared ? escape(local[0].origin) + ". Tool outcomes cannot establish these judgments." : "Each measure keeps its own review origin and coverage. Percentages are not averaged. Tool outcomes cannot establish the unassessed local judgments."}</p>
        ${shared ? `<p>Not checked automatically:</p><ul>${local.map(row => `<li>${escape(row.label)}: ${row.coverage.count} of ${row.coverage.eligible} assessed</li>`).join("")}</ul>` : ""}
        ${rows.length ? `<table class="native-table"><caption>Saved quality measures, not an overall grade</caption><thead><tr><th scope="col">Measure / origin</th><th scope="col">Result</th><th scope="col">Counts and coverage</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escape(row.label)}<span class="reading-note">${escape(row.origin)}</span></th><td data-label="Result" class="${row.tone}">${escape(row.value)}</td><td data-label="Counts and coverage">${escape(row.unsupportedLocal ? `${row.coverage.count} of ${row.coverage.eligible} assessed` : row.note)}</td></tr>`).join("")}</tbody></table>` : !shared ? "<p>Quality measures were not saved.</p>" : ""}
        ${completionChecks(model).map(row => `<p>${escape(completionReading(row))}</p>`).join("")}
        ${rows.length ? qualityReadingNotes.filter((_, index) => index !== 1 || rows.some(row => row.modelReview)).map(note => `<p>${escape(note)}</p>`).join("") : ""}</details>`;
}

export function nativeQualityMarkdown(snapshot, model) {
    if (snapshot?.evaluationFacts?.metricProjectionVersion === 4) return [];
    const allRows = measureRows(snapshot), local = allRows.filter(row => row.unsupportedLocal);
    if (snapshot?.evaluationFacts?.metricProjectionVersion === 3) {
        if (!allRows.length) return [];
        return ['<a id="quality"></a>', "## Personal feedback", "", "Saved personal opinions do not change recorded outcomes or grant permission.", "",
            "| Feedback | Result | Scope |", "|---|---|---|",
            ...allRows.map(row => `| ${escape(row.label)} | ${escape(row.value)} | ${escape(row.note)} |`), ""];
    }
    const shared = local.length > 0 && local.every(row => row.origin === local[0].origin);
    const rows = shared ? allRows.filter(row => !row.unsupportedLocal) : allRows;
    return ['<a id="quality"></a>', "## Quality results and definitions", "",
        shared ? `${local[0].origin}. Tool outcomes cannot establish these judgments.` : "Each measure keeps its own review origin and coverage. Percentages are not averaged. Tool outcomes cannot establish the unassessed local judgments.", "",
        ...(shared ? ["Not checked automatically:", ...local.map(row => `- ${escape(row.label)}: ${row.coverage.count} of ${row.coverage.eligible} assessed`), ""] : []),
        ...(rows.length ? ["| Measure / origin | Result | Counts and coverage |", "|---|---|---|",
            ...rows.map(row => `| ${escape(row.label)} / ${escape(row.origin)} | ${escape(row.value)} | ${escape(row.unsupportedLocal ? `${row.coverage.count} of ${row.coverage.eligible} assessed` : row.note)} |`)] : !shared ? ["Quality measures were not saved."] : []), "",
        ...completionChecks(model).map(completionReading), "",
        ...(rows.length ? qualityReadingNotes.filter((_, index) => index !== 1 || rows.some(row => row.modelReview)).flatMap(note => [note, ""]) : [])];
}

export const nativeReportStyles = `
${tokens}
${fontFaceStyles}
${dimensionalColumnStyles}
${promptAuthorStyles}
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
*{box-sizing:border-box}
:root{font-family:var(--font);font-variant-numeric:tabular-nums;background:var(--page);color:var(--ink)}
body{max-width:68rem;margin:0 auto;padding:2rem;font-size:var(--type-reading);line-height:var(--leading-reading)}
main{min-width:0}
h1,h2,h3,h4,summary{font-weight:var(--weight-strong);line-height:var(--leading-heading)}
h1{font-size:var(--type-title);letter-spacing:var(--tracking-heading)}h2{font-size:var(--type-section);line-height:var(--leading-section);margin:1.5rem 0 .65rem}h3,h4{font-size:var(--type-body);line-height:var(--leading-ui);margin:1rem 0 .5rem}
p,li,th,td,summary,h1,h2,h3,h4{overflow-wrap:anywhere}p{margin:.6rem 0}
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
.native-bars{list-style:none;margin:0;padding:0}.native-bars li{margin:max(var(--space-lg),1rem) 0;break-inside:avoid}
.native-bar-heading{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 .8rem}
.native-bar-track{display:flex;width:100%;height:.5rem;background:var(--canvas);margin:max(var(--space-sm),.5rem) 0;border-radius:var(--radius-pill);overflow:hidden}
.native-bar{display:block;min-width:0;flex-shrink:0;background:var(--column-label,var(--accent))}
.native-bar-results{display:flex;flex-wrap:wrap;gap:max(var(--space-sm),.5rem);font-size:var(--type-small);color:var(--muted)}
.native-outcome{padding:3px 8px;border:1px solid var(--column-label);border-radius:var(--radius-pill);background:color-mix(in srgb,var(--column-label) 8%,var(--paper));color:var(--column-label);font-size:var(--type-caption);line-height:var(--leading-caption)}
.native-bar[data-outcome=failure],.native-outcome[data-outcome=failure]{--column-label:var(--danger)}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:var(--type-small)}
caption{text-align:left;color:var(--muted);margin:.5rem 0}
th,td{text-align:left;padding:.6rem;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
thead{background:var(--canvas)}th{font-weight:var(--weight-strong)}
.native-table th:first-child{width:38%}
.table-wrap{overflow-x:auto;max-width:100%}
details{border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper);margin:1.1rem 0;padding:.5rem .75rem}
summary{cursor:pointer;min-height:44px;padding:.65rem 0;color:var(--ink)}summary:hover{color:var(--accent)}
.example{border-top:1px solid var(--rule);padding:.6rem 0;margin:1rem 0}
.example .example-prompt{font:600 italic 1rem/1.6 var(--font);margin:.6rem 0}
.example ol{padding-left:1.2rem}.example .ref{display:block}
.prompt-record{margin:.6rem 0}.prompt-record .ref{display:block;font-weight:var(--weight-regular)}
.prompt pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--canvas);padding:.6rem .8rem;margin:.5rem 0;max-width:100%}
.example .prompt pre{font:600 italic 1rem/1.6 var(--font);border:0;background:transparent;padding:0}
.prompt h4{margin-bottom:.3rem}.prompt>p{font-size:var(--type-small)}.removal{font-weight:var(--weight-strong)}
.prompt-status{font-weight:var(--weight-regular);color:var(--muted)}
#recorded-context>section{margin:1rem 0}#recorded-context ol{padding-left:1.5rem}
.service-glossary dl{margin:0}.service-glossary dl>div{margin:.5rem 0;break-inside:avoid}.service-glossary dt{display:inline;font-weight:var(--weight-strong)}.service-glossary dd{display:inline;margin:0}.service-glossary dd::before{content:": "}
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
 body{padding:0;max-width:none;font-size:10pt;line-height:1.4}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}
 h1{font-size:18pt}h2{font-size:13pt}h3,h4{font-size:11pt}
 h2{margin:1em 0 .4em}h3,h4{margin:.6em 0 .3em}
 p{margin:.35em 0}summary{min-height:0;padding:.25em 0}
 .report-brand{margin-bottom:.75em}.report-nav{padding:.2em 0;margin:.5em 0}
 .example{margin:.65em 0;padding:.4em 0}
 p,pre{orphans:3;widows:3}h2,h3,h4,summary{break-after:avoid}
 .report-accessible-name,.json-records-link{display:none}.print-companion{display:inline}
 .native-breakdowns{grid-template-columns:1fr 1fr;gap:12px}
 .native-bars li{margin:.65em 0}
 .native-table{display:table}.native-table tbody{display:table-row-group}.native-table tr{display:table-row}
 .native-table th,.native-table td{display:table-cell;padding:5px;border-bottom:1px solid var(--rule)}
 .native-table th:first-child{width:38%!important}.native-table td{width:auto!important}.native-table td::before{display:none}
 .native-table thead{position:static;width:auto;height:auto;clip-path:none;display:table-header-group}
 table,.reading-note,.reading-notes,.ref,.layer-notes,.report-meta,.native-bar-results,.prompt>p{font-size:10pt;line-height:1.4}
 .table-wrap{overflow:visible}tr{break-inside:avoid}.prompt pre{overflow:visible;max-height:none;font-size:10pt}
 details,details>*{display:block}details::details-content{content-visibility:visible}
 .native-counts strong{font-size:14pt}.report-nav{font-size:10pt}.report-nav a{padding:.1rem 0}
 .report-nav{display:none}
}
${reportPrintPaginationStyles}
@media print {
 .prompt{break-inside:auto}.prompt>p:last-child{break-after:auto}
 p,li,.reading-notes ul,.native-breakdowns{break-inside:avoid}
 caption,thead,:is(h2,h3,h4,summary)+p:not(:last-child),p:has(+table){break-after:avoid}
 tbody>tr:first-child{break-before:avoid}
 .report-footer{break-before:avoid;break-inside:avoid}
}
`;
