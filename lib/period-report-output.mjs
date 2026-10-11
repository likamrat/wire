import { validatePeriodReport } from "./period-report.mjs";
import { nativeReportHeader, nativeReportStyles, nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown } from "./native-report-output.mjs";
import { escapeReportText } from "./report-presentation.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { time } from "./time.mjs";

const escape = escapeReportText, formatter = createReportComparison(), results = createRecordedResults();
const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const share = (count, total) => `${count} / ${total} (${total ? number(count * 100 / total) + "%" : "Not applicable"})`;
const signed = value => `${value > 0 ? "+" : ""}${number(value)}`;
const delta = comparison => comparison?.delta ? `${signed(comparison.delta.value)} ${comparison.delta.unit}`
    : comparison?.status === "incompatible" ? `Incompatible definitions: ${(comparison.warnings ?? []).join("; ")}` : "Not comparable";
const fact = value => {
    if (!value) return "No compatible saved lane";
    const coverage = `${value.coverage.count} / ${value.coverage.eligible} covered`;
    return `${value.state !== "available" ? value.reason : value.kind === "pass-rate"
        ? `${value.numerator} / ${value.denominator} passed (${number(value.numerator * 100 / value.denominator)}%)`
        : `${number(value.value)} ${value.unit}`}; ${coverage}`;
};

export function periodReportDisplay(value) {
    validatePeriodReport(value);
    const a = value.periods.baseline, b = value.periods.later, labels = results.labels(value.definitions.layer);
    const rows = [
        ["Matching records", String(a.rows.length), String(b.rows.length), signed(b.rows.length - a.rows.length) + " records"],
        ["Full retained interactions", String(a.facts.memberships.length), String(b.facts.memberships.length), signed(b.facts.memberships.length - a.facts.memberships.length) + " interactions"],
        ...Object.entries(labels).map(([key, label]) => [label, share(a.totals[key], a.rows.length), share(b.totals[key], b.rows.length),
            value.comparison.outcomes.change[key] === null ? "Not comparable" : signed(value.comparison.outcomes.change[key]) + " percentage points"]),
    ];
    const timing = value.comparison.matchingCallTiming ? ["median", "p95"].map(key => {
        const item = value.comparison.matchingCallTiming[key];
        const display = side => `${key === "p95" && side.coverage.count < 2 ? "Not shown without multiple samples"
            : side.state === "available" ? number(side.value) + " ms" : "Not measured"}; ${side.coverage.count} / ${side.coverage.eligible} calls timed${side.coverage.count === 1 ? "; single sample" : ""}`;
        return [key === "median" ? "Median call duration" : "P95 call duration", display(item.baseline), display(item.later),
            key === "p95" && Math.min(item.baseline.coverage.count, item.later.coverage.count) < 2 ? "Not comparable" : delta(item)];
    }) : [];
    const metrics = value.comparison.metrics.map(item => [
        `${formatter.dimensionLabel((item.baseline ?? item.later).metric)} / ${formatter.definitionLabel({ baseline: item.baseline, later: item.later })}`,
        fact(item.baseline), fact(item.later), delta(item.result),
    ]);
    const sharedInteractions = a.facts.memberships.filter(item => b.facts.memberships.some(other => item.interactionRef === other.interactionRef)).length;
    const notes = [
        value.scope.population, value.scope.interpretation, value.scope.dates,
        `${value.comparison.outcomes.overlap.sharedCount} matching records and ${sharedInteractions} full retained interactions appear on both sides. Count each once per side; do not add overlapping populations.`,
        "Call duration is call start to recorded completion. Nearest-rank timing uses raw samples, never summed concurrent latency. Final-response timing is a separate full-interaction measure.",
        "Source event timestamps and raw source identifiers are withheld. Explicit local date bounds and keyed membership remain frozen.",
        value.scope.authorPolicy,
        ...(value.selection.withinScenarioRefs === undefined ? [] : ["The existing interaction phrase filter additionally narrowed the accepted search membership. Only its keyed scope is saved; private phrase text is withheld."]),
    ];
    const scope = Object.entries(value.selection.filters).map(([key, values]) => `${key}: ${Array.isArray(values) ? values.join(", ") : values}`).join("; ");
    return { rows, timing, metrics, notes, labels, scope,
        title: "Retained-period comparison report",
        dates: `Period A: ${a.range.from} to ${a.range.to}. Period B: ${b.range.from} to ${b.range.to}. ${time.label(value.timeContext)}.`,
        finding: `${labels.failure}: Period A ${share(a.totals.failure, a.rows.length)}; Period B ${share(b.totals.failure, b.rows.length)} of matching ${value.definitions.unit}. ${value.comparison.outcomes.change.failure === null ? "No failure-share comparison is available." : `The observed difference is ${signed(value.comparison.outcomes.change.failure)} percentage points (B minus A).`}`,
    };
}

function table(caption, headers, rows) {
    return `<table class="native-table"><caption>${escape(caption)}</caption><thead><tr>${headers.map(label => `<th scope="col">${escape(label)}</th>`).join("")}</tr></thead><tbody>${rows.map(cells => `<tr>${cells.map((cell, index) =>
        index ? `<td data-label="${escape(headers[index])}">${escape(cell)}</td>` : `<th scope="row">${escape(cell)}</th>`).join("")}</tr>`).join("")}</tbody></table>`;
}
const markdownTable = (headers, rows) => [`| ${headers.map(escape).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`,
    ...rows.map(cells => `| ${cells.map(escape).join(" | ")} |`), ""];
const headers = ["Measure", "Period A", "Period B", "Observed difference"];
const tools = side => [...new Set(side.rows.map(row => row.tool))].map(tool => [tool, side.rows.filter(row => row.tool === tool).length]);

function sideNotes(side) {
    return [
        `${side.rows.length} matching records in ${side.scenarioRefs.length} request groups; ${side.facts.memberships.length} full retained interactions. ${side.unmappedScenarioRefs.length} groups have no verified interaction association.`,
        `${side.serviceSelection.knownMatchRefs.length} known selected-service matches; ${side.serviceSelection.contextOnlyRefs.length} missing-service context records. Services can overlap, but a record counts once per side.`,
        ...(side.apiCoverage ? [`${side.apiCoverage.selectedResultUnits} matching returned entries; ${side.apiCoverage.eligibleToolCalls} eligible parent calls before entry outcome/endpoint filters. These are separate populations.`] : []),
        `Saved review-status coverage: ${side.facts.reviewStatuses.length} / ${side.facts.memberships.length} full interactions.`,
    ];
}

export function renderPeriodReportHtml(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const sides = Object.entries(value.periods).map(([key, side], index) => {
        const label = index ? "Period B" : "Period A", model = nativeReportEvidence({ evaluationFacts: side.facts });
        return `<section id="${key}"><h2>${label}: full-interaction findings</h2><p class="reading-note">${escape(value.scope.findings)}</p>${nativeFindingsHtml(model).replace('id="findings"', `id="${key}-findings"`)}
            ${sideNotes(side).map(note => `<p class="reading-note">${escape(note)}</p>`).join("")}
            <h3>Matching tools and records</h3><ul class="native-bars">${tools(side).map(([tool, count]) =>
                `<li><div class="native-bar-heading"><span>${escape(tool)}</span><strong>${escape(share(count, side.rows.length))}</strong></div><div class="native-bar-track"><span class="native-bar" style="width:${count * 100 / side.rows.length}%"></span></div></li>`).join("")}</ul>
            <details><summary>Exact matching records (${side.rows.length})</summary>${table(`${label}: canonical membership; source timestamps withheld`,
                ["Record / request", "Tool / services", "Outcome", "Duration"], side.rows.map(row => [
                    `${row.id} / ${row.scenarioRef}`, `${row.tool}; ${row.services.join(", ") || (row.serviceNotApplicable ? "Service not applicable" : "Service details missing")}`,
                    display.labels[row.outcome], row.durationMs === null ? "Not measured" : `${row.durationMs} ms`,
                ]))}</details></section>`;
    }).join("");
    const copies = snapshot.records.map(record => `<section id="${record.scenarioId}" class="prompt"><h3>Reviewed copies: ${escape(record.scenarioId)}</h3>${record.prompts.map(prompt =>
        `<h4>${escape(prompt.label ?? promptAuthorship.label(prompt, { ownerVoice: false }))}</h4><p>${escape(prompt.status)} source / ${escape(prompt.representation)}</p>${prompt.text === null ? "<p>Omitted or unavailable; not reconstructed.</p>" : `<pre>${escape(prompt.text)}</pre>`}`).join("")}</section>`).join("");
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WIRE - ${display.title}</title><style>${nativeReportStyles}h1,h2,h3{overflow-wrap:anywhere}</style></head><body>
        ${nativeReportHeader().replace("Personal interaction report", display.title)}<main><p class="report-meta">${escape(display.dates)}<br>Prepared ${escape(snapshot.preparedAtDisplay)} from stored revision ${value.revision}.</p>
        <section><h2>What differs</h2><p>${escape(display.finding)}</p><p class="reading-note">${escape(value.scope.interpretation)}</p></section>
        <section id="numbers"><h2>Exact two-side numbers</h2>${table(`Matching ${value.definitions.unit}; B minus A`, headers, display.rows)}
        ${display.timing.length ? table("Matching calls only: call start to recorded completion", headers, display.timing) : "<p>Matching-call duration comparison is unavailable for this evidence layer.</p>"}</section>
        ${sides}
        <section id="full-interaction"><h2>Full-interaction checks and timing</h2><p>${escape(value.scope.findings)}</p>${table("Each check, origin, model and rubric is a separate lane", headers, display.metrics)}</section>
        ${reportContextHtml(snapshot)}<details id="copies"><summary>Reviewed prompt copies (${snapshot.records.length} groups)</summary><p>Copies explain these results; they do not form a third analytical cohort.</p>${copies}</details>
        <details id="definitions"><summary>Scope, definitions and reading notes</summary><p>${escape(display.scope || "All retained scope choices")}</p><p>Within every service: ${escape(value.selection.withinServices.join(", ") || "No additional refinement")}.</p>
        ${[...display.notes, ...formatter.readingNotes].map(note => `<p>${escape(note)}</p>`).join("")}</details></main><footer class="report-footer">Frozen reviewed local copy. No history collection or new assessment was performed for this report.</footer></body></html>`;
}

export function renderPeriodReportMarkdown(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const lines = [`# WIRE - ${display.title}`, "", display.dates, "", `Prepared ${snapshot.preparedAtDisplay} from stored revision ${value.revision}.`, "",
        "## What differs", "", display.finding, "", value.scope.interpretation, "",
        "## Exact two-side numbers", "", `Matching ${value.definitions.unit}; B minus A.`, "", ...markdownTable(headers, display.rows),
        "## Matching call timing", "", ...(display.timing.length ? markdownTable(headers, display.timing) : ["Not available for this evidence layer.", ""])];
    for (const [index, side] of Object.values(value.periods).entries()) {
        const label = index ? "Period B" : "Period A";
        lines.push(`## ${label}: full-interaction findings`, "", value.scope.findings, "", ...nativeFindingsMarkdown(nativeReportEvidence({ evaluationFacts: side.facts })).slice(2),
            ...sideNotes(side).flatMap(note => [note, ""]), "### Matching tools and records", "",
            ...markdownTable(["Tool", "Matching records"], tools(side).map(([tool, count]) => [tool, share(count, side.rows.length)])),
            ...markdownTable(["Record / request", "Tool / services", "Outcome", "Duration"], side.rows.map(row => [
                `${row.id} / ${row.scenarioRef}`, `${row.tool}; ${row.services.join(", ") || (row.serviceNotApplicable ? "Service not applicable" : "Service details missing")}`,
                display.labels[row.outcome], row.durationMs === null ? "Not measured" : `${row.durationMs} ms`,
            ])));
    }
    lines.push("## Full-interaction checks and timing", "", value.scope.findings, "", ...markdownTable(headers, display.metrics),
        ...reportContextMarkdown(snapshot), "## Reviewed prompt copies", "", "Copies explain these results; they do not form a third analytical cohort.", "");
    for (const record of snapshot.records) {
        lines.push(`<a id="${record.scenarioId}"></a>`, `### ${record.scenarioId}`, "");
        for (const prompt of record.prompts) lines.push(`**${escape(prompt.label ?? promptAuthorship.label(prompt, { ownerVoice: false }))}**`,
            `${prompt.status} source / ${prompt.representation}`, "", ...(prompt.text === null ? ["Omitted or unavailable; not reconstructed."]
                : prompt.text.split("\n").map(line => "    " + line)), "");
    }
    lines.push("## Scope, definitions and reading notes", "", display.scope, "",
        `Within every service: ${value.selection.withinServices.join(", ") || "No additional refinement"}.`, "",
        ...[...display.notes, ...formatter.readingNotes].flatMap(note => [note, ""]));
    return lines.join("\n") + "\n";
}
