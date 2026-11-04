import * as contract from "./assessment-contract.mjs";
import { freezeEvaluationFacts, evaluationMetricFacts } from "./report-facts.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { escapeReportText, reportBrandHeader, reportBrandStyles, reportDocumentTokens, reportPrintPaginationStyles, reportTimingPresentation, reportTextCell } from "./report-presentation.mjs";
import { tokens } from "../web/tokens.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { promptAuthorStyles } from "../web/prompt-author-styles.mjs";
import { fontFaceStyles } from "./typeface.mjs";
import { validateNativeReportEvidence } from "./native-report-shape.mjs";

const escape = escapeReportText;
const formatter = createReportComparison();

export function microsoftReportContent(evidence) {
    validateNativeReportEvidence(evidence);
    const copyLabel = copy => `${copy.author === "unknown" ? "Author unknown" : copy.author} / ${copy.kind === "native-message"
        ? copy.representationKind ?? "message unavailable" : copy.kind} / ${copy.representation}`;
    return {
        boundary: evidence.conversations.length
            ? "Selected retained Microsoft evidence, not complete source history. Calls, returned results, message representations, parts and task states use separate units. Repeated captures and variants do not add calls."
            : "No Microsoft conversations matched the selected report scope. This does not establish that Microsoft history is empty or complete.",
        limitations: evidence.conversations.length
            ? "Service targets and response latency are not qualified. Activity dates appear only in a separately qualified period comparison; capture dates are not activity dates. Input and result bodies are withheld. A task state or a successful call does not prove the user's task was completed."
            : null,
        sources: ["microsoft-365-chat", "microsoft-365-cowork"].flatMap(sourceId => {
            const selected = evidence.conversations.filter(conversation => conversation.sourceId === sourceId);
            if (!selected.length) return [];
            const measured = selected.filter(conversation => !evidence.selection.contextOnlyRefs.includes(conversation.ref));
            const calls = measured.flatMap(conversation => conversation.calls), results = measured.flatMap(conversation => conversation.results);
            return [{
                name: sourceId === "microsoft-365-chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork",
                counts: `${selected.length} retained conversations${selected.length !== measured.length ? ` (${selected.length - measured.length} context-only, excluded from measured populations)` : ""}; ${calls.length} native calls; ${results.length} returned-result observations; ${measured.reduce((n, item) => n + item.messages.filter(message => message.unit === "message-representation-observation").length, 0)} message representations; ${measured.reduce((n, item) => n + item.messages.filter(message => message.unit === "message-representation-part").length, 0)} message parts; ${measured.reduce((n, item) => n + item.taskStates.length, 0)} task-state observations.`,
                outcomes: `${calls.filter(call => call.outcome === "succeeded").length} calls have a recorded successful outcome; ${calls.filter(call => call.outcome === "failed").length} failed; ${calls.filter(call => call.outcome === "unknown").length} have an unknown or conflicting outcome.`,
                conversations: selected.map(conversation => ({
                    ref: conversation.ref,
                    calls: conversation.calls.map(call => `${call.names.join(" / ") || "Tool name unavailable"}: ${call.outcome}; ${call.qualification}. Input: ${[...new Set(call.inputAvailability)].join(", ")}; body withheld.`),
                    results: conversation.results.map(result => `Result position ${result.index}: ${result.statusCode === null ? "status unavailable" : `status ${result.statusCode}`}${result.errorCode ? `; ${result.errorCode}` : ""}. Intermediary-reported, not independently observed HTTP.`),
                    missingResults: conversation.resultCoverage.filter(item => item.availability !== "recorded").map(item =>
                        `Returned results: ${item.availability}; ${item.declaredRequestCount === null ? "declared request count unavailable" : `${item.declaredRequestCount} declared requests, not a success denominator`}.`),
                    tasks: conversation.taskStates.map(task => `Recorded task state: ${task.state}; not an aggregate tool outcome.`),
                    measurements: conversation.measurements.map(item => item.milliseconds === null
                        ? `Call elapsed time: ${item.availability}.`
                        : `Recorded call elapsed time: ${item.milliseconds} ms; source-defined boundary, not user-response latency.`),
                    references: conversation.resultReferences.map(item => item.cardinality === null
                        ? `Result references: ${item.availability}.`
                        : `${item.cardinality} source result-reference entries; not unique entities, requests or outcomes. Reference values withheld.`),
                    updates: conversation.sourceFacts.map(fact => `Recorded source update: ${fact.kind}; not an additional executed call.`),
                    copies: evidence.disclosure.copies.filter(copy => copy.scenarioRef === conversation.ref)
                        .map(copy => ({ key: copy.key, label: copyLabel(copy),
                            text: copy.text, unavailable: copy.omitted ? "Text omitted from this report." : `Text unavailable: ${copy.availability}.` })),
                })),
            }];
        }),
    };
}

export function microsoftEvidenceHtml(evidence) {
    const content = microsoftReportContent(evidence);
    const lines = values => values.map(value => `<p>${escape(value)}</p>`).join("");
    return `<section id="microsoft-evidence"><h2>Microsoft evidence</h2><p>${escape(content.boundary)}</p>
${content.sources.map(source => `<section><h3>${escape(source.name)}</h3><p>${escape(source.counts)}</p><p>${escape(source.outcomes)}</p>
${source.conversations.map((conversation, index) => `<section id="${escape(conversation.ref)}" class="example"><h4>Retained conversation ${index + 1}</h4>
${lines([...conversation.calls, ...conversation.results, ...conversation.missingResults, ...conversation.tasks, ...conversation.measurements, ...conversation.references, ...conversation.updates])}
${conversation.copies.map(copy => `<div id="${escape(copy.key)}" class="prompt"><p>${escape(copy.label)}</p>${copy.text === null
        ? `<p class="reading-note">${escape(copy.unavailable)}</p>` : `<pre>${escape(copy.text)}</pre>`}</div>`).join("")}</section>`).join("")}</section>`).join("")}
${content.limitations ? `<p class="reading-note">${escape(content.limitations)}</p>` : ""}</section>`;
}

export function microsoftEvidenceMarkdown(evidence) {
    const content = microsoftReportContent(evidence);
    const markdown = value => escape(value).replace(/[\\`*_#[\]{}|]/g, "\\$&");
    return ["## Microsoft evidence", "", content.boundary, "", ...content.sources.flatMap(source => [
        `### ${source.name}`, "", source.counts, "", source.outcomes, "",
        ...source.conversations.flatMap((conversation, index) => [
            `#### Retained conversation ${index + 1}`, "",
            ...[...conversation.calls, ...conversation.results, ...conversation.missingResults, ...conversation.tasks, ...conversation.measurements, ...conversation.references, ...conversation.updates]
                .flatMap(line => [markdown(line), ""]),
            ...conversation.copies.flatMap(copy => [markdown(copy.label), "", markdown(copy.text ?? copy.unavailable), ""]),
        ]),
    ]), ...(content.limitations ? [content.limitations, ""] : [])];
}

export function nativeReportEvidence(snapshot) {
    if (!snapshot?.evaluationFacts) return null;
    const facts = freezeEvaluationFacts(snapshot.evaluationFacts);
    const presentation = createAssessmentPresentation({ ...contract, timing: reportTimingPresentation(snapshot) });
    const model = presentation.summarize(facts.metrics, {
        membershipStatus: facts.scope.membership === "exact-retained" ? "complete-retained" : "partial",
        reviewStatuses: facts.reviewStatuses ?? null,
        assessmentAttempts: facts.assessmentAttempts ?? null,
    });
    model.presentationVersion = snapshot.presentation?.schemaVersion;
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
    if (model?.metricProjectionVersion === 4 && context) {
        return context.patterns.length ? `<p id="findings" class="report-summary">${escape(context.patterns.join(" "))}</p>` : "";
    }
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

export const nativeReportHeader = reportBrandHeader;

export function nativeFindingsMarkdown(model, context) {
    if (model?.metricProjectionVersion === 4 && context) return context.patterns.length ? [escape(context.patterns.join(" ")), ""] : [];
    if (!findingItems(model, Boolean(context)).length && !context) return [];
    return ['<a id="findings"></a>', context ? "## At a glance" : "## What the record shows", "",
        ...(context ? [escape(context.lead), "", escape(context.patterns.join(" ")), ""] : []), ...findingItems(model, Boolean(context)).map(item => {
        const origin = findingOrigin(item);
        return `- ${escape(item.text)}${origin ? ` ${escape(origin)}` : ""}`;
    }), "",
        "These are saved observations, not complete history or proof of task completion. Missing explanations are not reconstructed.", ""];
}

export const nativeShare = (count, total) => total ? formatter.formatValue(count * 100 / total, "percent") : "Not applicable";
const timingValue = (row, percentile, model) => row.timed === 0 ? "Not measured"
    : percentile === "p95" && row.timed === 1 ? "Not shown for one sample"
        : model.presentationVersion === 3 ? percentile === "p95" ? row.display.p95 : row.display.median
            : `${percentile === "p95" ? row.display.p95 : row.display.median} (${row.distribution[percentile === "p95" ? "p95Ms" : "p50Ms"]} ms)`;
const timingRows = model => (model?.evidence.timing ?? []).map(row =>
    row.provenance?.definitionId === "tool-duration" ? { ...row, label: "Tool latency" } : row);
const timingNote = row => `${row.coverageLabel}${row.notTimed ? `; ${row.missingLabel}` : ""}. ${row.boundaryLabel}.${row.timed === 1 ? ` ${row.limitation}` : ""}`;
const untimedNote = row => `${row.label}: Not measured (${row.coverageLabel}${row.eligible ? "" : `; ${row.missingLabel}`}). ${row.boundaryLabel}.`;
const timingMethod = "Median/P95 use nearest-rank timed samples (lower-middle median for even counts). Missing timing is not zero; concurrent calls are not added together. A final response does not prove task success.";

export function nativeTimingHtml(model) {
    const rows = timingRows(model), measured = rows.filter(row => row.timed > 0);
    return `<section id="timing"><h2>Timing</h2>${measured.length ? `<table class="native-table"><thead><tr><th scope="col">Boundary and coverage</th><th scope="col" class="report-numeric">Median / single sample</th><th scope="col" class="report-numeric">P95</th></tr></thead><tbody>${measured.map(row => `<tr><th scope="row">${escape(row.label)}<span class="reading-note">${escape(timingNote(row))}</span></th><td class="report-numeric" data-label="Median / single sample">${escape(timingValue(row, "median", model))}</td><td class="report-numeric" data-label="P95">${row.timed > 1 ? escape(timingValue(row, "p95", model)) : reportTextCell(timingValue(row, "p95", model))}</td></tr>`).join("")}</tbody></table>` : !rows.length ? "<p>Timing samples were not saved.</p>" : ""}
        ${rows.filter(row => !row.timed).map(row => `<p class="reading-note">${escape(untimedNote(row))}</p>`).join("")}
        ${measured.length ? `<p class="reading-note">${escape(timingMethod)}</p>` : ""}</section>`;
}

export function nativeTimingMarkdown(model) {
    const rows = timingRows(model), measured = rows.filter(row => row.timed > 0);
    return ['<a id="timing"></a>', "## Timing", "",
        ...(measured.length ? ["| Boundary and coverage | Median / single sample | P95 |", "|---|---:|---:|",
            ...measured.map(row => `| ${escape(row.label)}. ${escape(timingNote(row))} | ${escape(timingValue(row, "median", model))} | ${row.timed > 1 ? escape(timingValue(row, "p95", model)) : reportTextCell(timingValue(row, "p95", model))} |`)] : !rows.length ? ["Timing samples were not saved."] : []),
        "", ...rows.filter(row => !row.timed).flatMap(row => [escape(untimedNote(row)), ""]), ...(measured.length ? [timingMethod, ""] : [])];
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
${reportDocumentTokens}
*{box-sizing:border-box}
:root{font-family:var(--font);font-variant-numeric:tabular-nums;background:var(--page);color:var(--ink)}
body{max-width:64rem;margin:0 auto;padding:2rem;font-size:var(--type-reading);line-height:var(--leading-reading)}
main{min-width:0}
h1,h2,h3,h4,summary{font-weight:var(--weight-strong);line-height:var(--leading-heading)}
h1{font-size:var(--type-title);letter-spacing:var(--tracking-heading)}h2{font-size:var(--type-section);line-height:var(--leading-section);margin:1.5rem 0 .65rem}h3,h4{font-size:var(--type-body);line-height:var(--leading-ui);margin:1rem 0 .5rem}
p,li,th,td,summary,h1,h2,h3,h4{overflow-wrap:anywhere}p{margin:.6rem 0}
${reportBrandStyles}
.report-meta{white-space:pre-line;color:var(--muted);font-size:var(--type-small)}
.report-summary{max-width:72ch;margin:1rem 0}
main>section>p,.layer-notes p,.reading-notes>p{max-width:75ch}
.native-findings{padding-left:1.25rem;margin:.5rem 0}.native-findings li{margin:.3rem 0}
.finding-positive{color:var(--success)}.finding-negative{color:var(--danger)}
.reading-note,.reading-notes,.ref,.layer-notes,.report-footer{font-size:var(--type-small);color:var(--muted)}
span.reading-note{display:block;font-weight:var(--weight-regular)}
.report-nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem;border-block:1px solid var(--rule);padding:.4rem 0;margin:1rem 0}
a{color:var(--accent);text-underline-offset:.2em}.report-nav a{padding:.35rem 0;font-size:var(--type-control);text-decoration:none}
.report-nav a:hover{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}.report-nav a:active{background:var(--accent-pressed)}
@media screen{.report-nav a{display:flex;align-items:center;min-height:44px;min-width:44px}}
a:hover{color:var(--ink)}
:is(a,summary,[tabindex]):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.native-counts{display:flex;flex-wrap:wrap;gap:.5rem 2rem;margin:.75rem 0}.native-counts p{margin:0}.native-counts strong{font-size:var(--type-data-value)}
.native-breakdowns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem}
.native-breakdowns section{min-width:0}.native-breakdowns h3{margin-top:0}
.native-bars{list-style:none;margin:0;padding:0}.native-bars li{margin:max(var(--space-lg),1rem) 0;break-inside:avoid}
.native-bar-heading{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 .8rem}
.native-bar-track{display:flex;width:100%;height:.5rem;background:var(--canvas);margin:max(var(--space-sm),.5rem) 0;border-radius:var(--radius-pill);overflow:hidden}
.native-bar{display:block;min-width:0;flex-shrink:0;background:var(--column-label,var(--accent))}
.native-bar-results{display:flex;flex-wrap:wrap;gap:max(var(--space-sm),.5rem);font-size:var(--type-small);color:var(--muted)}
.native-outcome{color:var(--column-label);font-size:var(--type-small);line-height:var(--leading-caption)}
.native-bar[data-outcome=failure],.native-outcome[data-outcome=failure]{--column-label:var(--danger)}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:var(--type-small)}
caption{text-align:left;color:var(--muted);margin:.5rem 0}
th,td{text-align:left;padding:.6rem;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
thead{background:transparent;color:var(--muted)}th{font-weight:var(--weight-medium)}
.native-table th:first-child{width:38%}
#overview .native-table th:nth-child(2){width:12%}
#overview .native-table td[data-label=Count],#overview .native-table thead th:nth-child(2){text-align:right}
#timing .native-table th:first-child{width:46%}
.operation-table th:first-child{width:40%}
.operation-table{table-layout:auto}
.operation-table th{overflow-wrap:normal}
.operation-table tr>:not(:first-child){text-align:right}
.example-calls{table-layout:auto}.example-calls th{overflow-wrap:normal}
.example-calls tr>:first-child{width:4ch;text-align:right}
.example-calls tr>:not(:first-child){text-align:left}
.prompt .report-facts{margin:.25rem 0 .5rem}
.prompt-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1rem;margin:.5rem 0 .3rem}
.prompt-heading :is(h3,h4,.report-facts){margin:0}
@media screen{.operation-table{min-width:40rem}}
.table-wrap{overflow-x:auto;max-width:100%}
details{border:0;border-top:1px solid var(--rule);border-radius:0;background:var(--paper);margin:1.1rem 0;padding:.5rem 0}
summary{cursor:pointer;min-height:44px;padding:.65rem 0;color:var(--ink)}summary:hover{color:var(--accent)}
.example{border-top:1px solid var(--rule);padding:.6rem 0;margin:1rem 0}
.example .example-prompt{font:inherit;margin:.6rem 0}
.example ol{padding-left:1.2rem}.example .ref{display:block}
.prompt-record{margin:.6rem 0}.prompt-record .ref{display:block;font-weight:var(--weight-regular)}
.prompt pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;border:0;border-left:2px solid var(--rule);border-radius:0;background:transparent;padding:.35rem .75rem;margin:.5rem 0;max-width:100%}
.example .prompt pre{font:inherit;border:0;border-left:2px solid var(--rule);border-radius:0;background:transparent;padding:.25rem .75rem}
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
 .native-table caption{display:block;width:100%}
 .native-table tr{display:block;padding:.5rem 0;border-bottom:1px solid var(--rule)}
 .native-table th,.native-table td{display:block;width:100%!important;border:0;padding:.2rem 0}
 .native-table td[data-label]::before{content:attr(data-label) ": ";font-weight:var(--weight-strong)}
 #overview .native-table td[data-label=Count]{text-align:left}
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
 .example-calls{font-size:10pt}.example-calls :is(th,td){padding:4px 6px}
 .prompt-heading{break-inside:avoid;break-after:avoid;margin:.25em 0 .15em}
 .prompt-heading+:is(pre,p){break-before:avoid}
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
 .prompt{break-inside:avoid}.prompt>p:last-child{break-after:auto}
 p,li,.reading-notes ul,.native-breakdowns{break-inside:avoid}
 .period-breakdowns{display:block;break-inside:auto}
 .period-breakdowns>section{break-inside:auto}
 .prompt-record{border:0;border-radius:0;border-top:1px solid var(--rule)}
 caption,thead,:is(h2,h3,h4,summary)+p:not(:last-child),p:has(+table){break-after:avoid}
 tbody>tr:first-child{break-before:avoid}
 .report-footer{break-before:avoid;break-inside:avoid}
}
`;
