import { validatePeriodReport } from "./period-report.mjs";
import { nativeReportHeader, nativeReportStyles, nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown } from "./native-report-output.mjs";
import { escapeReportText } from "./report-presentation.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { time } from "./time.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { normalizeMetricFact } from "./report-metric-comparison.mjs";
import { serviceCategories } from "./service-categories.mjs";

const escape = escapeReportText, formatter = createReportComparison(), results = createRecordedResults();
const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const share = (count, total) => `${count} / ${total} (${total ? number(count * 100 / total) + "%" : "Not applicable"})`;
const signed = value => `${value > 0 ? "+" : ""}${number(value)}`;
const count = (value, singular) => `${number(value)} ${singular}${Math.abs(value) === 1 ? "" : "s"}`;
const delta = comparison => comparison?.delta ? `${signed(comparison.delta.value)} ${comparison.delta.unit === "percentage-points" ? "percentage points" : comparison.delta.unit}`
    : comparison?.status === "incompatible" ? "Different metric definitions; not comparable" : "Not comparable";
const fact = (value, peer) => {
    if (!value) return formatter.absentPeerLabel(peer);
    const view = formatter.metricPresentation(normalizeMetricFact(value), value.metric, { includeOrigin: false });
    const result = value.state !== "available" ? view.value : value.kind === "pass-rate"
        ? `${number(value.numerator * 100 / value.denominator)}%` : `${number(value.value)} ${value.unit}`;
    return `${result}; ${view.note}${value.kind === "duration" && value.coverage.count === 1 ? "; single sample" : ""}`;
};
const sampleNote = "Compare each value with its assessed or timed sample count. Unequal coverage can reflect different subsets; it does not establish overall improvement. Differences are descriptive, not causal.";

function frozenScope(value) {
    const filters = value.selection.filters, services = filters.services ?? [];
    const names = values => values.map(name => serviceCategories.describe(name).label);
    const collection = { history: "the current retained collection (earlier-snapshot records excluded)",
        legacy: "earlier-snapshot retained records only", all: "current and earlier-snapshot retained records" }[filters.scope ?? "history"];
    const clauses = [`Both periods use ${collection}. Matching ${value.definitions.unit} are counted within each frozen date range.`];
    if (services.length) {
        clauses.push(`Service choices: ${names(services).join(" or ")}. A match to any selected choice qualifies (OR).`);
        if (services.includes("Unknown")) {
            clauses.push("Service not shown is explicitly selected: records in that category are selected matches, not evidence of a confirmed service.");
            clauses.push(filters.includeMissingService === true
                ? "Additional records with missing or unusable service details may enter as context, not confirmed matches to a named service. All other filters still apply."
                : "No additional missing-detail context is included; records must match a selected service or category.");
        } else clauses.push(filters.includeMissingService === true
            ? "The service filter allows known matches plus records with missing or unusable service details as context, not confirmed selected-service matches. All other filters still apply."
            : "Strict service matching: missing or unusable details alone do not qualify a record.");
    } else clauses.push("No service filter: records with unknown service details remain in the retained population; this is not an extra context expansion.");
    if (value.selection.withinServices.length) {
        clauses.push(`Also require every named service: ${names(value.selection.withinServices).join(" and ")} (AND). This refinement applies after the service choices and can exclude missing-detail context.`);
    }
    clauses.push(`Authors: ${promptAuthorship.selectionLabel(value.selection.promptAuthors, { ownerVoice: false })}.`);
    clauses.push(filters.tools?.length ? `Tools: ${filters.tools.join(" or ")}.` : "All tools in this evidence layer.");
    const outcomes = results.labels(value.definitions.layer);
    clauses.push(filters.outcomes?.length ? `Outcomes: ${filters.outcomes.map(outcome => outcomes[outcome]).join(" or ")}.` : "All recorded outcomes.");
    clauses.push(`Platform metadata ${filters.includeMetadata === true ? "included" : "excluded"}.`);
    if (filters.workloads?.length) clauses.push(`Activity categories: ${names(filters.workloads).join(" or ")}.`);
    const activity = { workiq: "Work IQ activity", "direct-request": "recorded Graph request sites", "recorded-http": "output-visible Graph statuses",
        "captured-http": "owned HTTP records", "code-reference": "Graph code references" };
    if (filters.activityTypes?.length) clauses.push(`Activity types: ${filters.activityTypes.map(type => activity[type]).join(" or ")}.`);
    for (const [key, label] of [["sourceSessionIds", "chat"], ["projectIds", "project"], ["endpoints", "endpoint"]]) {
        if (filters[key]?.length) clauses.push(`Restricted to ${count(filters[key].length, `frozen ${label} selection`)}${key === "projectIds" && filters[key].includes(null) ? " (including records with no project)" : ""}; references remain in technical filter details.`);
    }
    if (value.selection.semanticMembership) clauses.push("Frozen search membership also restricts these records; private query text is not reconstructed.");
    if (value.selection.withinScenarioRefs !== undefined) clauses.push("An additional frozen interaction selection applies after search membership.");
    return clauses.join(" ");
}

export function periodReportDisplay(value) {
    validatePeriodReport(value);
    const a = value.periods.baseline, b = value.periods.later, labels = results.labels(value.definitions.layer);
    const rows = [
        ["Matching records", String(a.rows.length), String(b.rows.length), `${b.rows.length > a.rows.length ? "+" : ""}${count(b.rows.length - a.rows.length, "record")}`],
        ["Full retained interactions", String(a.facts.memberships.length), String(b.facts.memberships.length), `${b.facts.memberships.length > a.facts.memberships.length ? "+" : ""}${count(b.facts.memberships.length - a.facts.memberships.length, "interaction")}`],
        ...Object.entries(labels).map(([key, label]) => [label, share(a.totals[key], a.rows.length), share(b.totals[key], b.rows.length),
            value.comparison.outcomes.change[key] === null ? "Not comparable" : signed(value.comparison.outcomes.change[key]) + " percentage points"]),
    ];
    const timing = value.comparison.matchingCallTiming ? ["median", "p95"].map(key => {
        const item = value.comparison.matchingCallTiming[key];
        const display = side => `${key === "p95" && side.coverage.count < 2 ? "Not shown without multiple samples"
            : side.state === "available" ? number(side.value) + " ms" : "Not measured"}; ${side.coverage.count} / ${side.coverage.eligible} ${results.columnUnit("tool", side.coverage.eligible)} timed${side.coverage.count === 1 ? "; single sample" : ""}`;
        return [key === "median" ? "Median call duration" : "P95 call duration", display(item.baseline), display(item.later),
            key === "p95" && Math.min(item.baseline.coverage.count, item.later.coverage.count) < 2 ? "Not comparable" : delta(item)];
    }) : [];
    const metrics = value.comparison.metrics.map(item => {
        const shared = formatter.definitionLabel(item);
        const label = formatter.comparisonLabel(item);
        const side = name => {
            const detail = formatter.sideDefinitionLabel(item, name);
            return (detail ? detail + ". " : "") + fact(item[name], item[name === "baseline" ? "later" : "baseline"]);
        };
        return [shared ? `${label} / ${shared}` : label,
            side("baseline"), side("later"), delta(item.result)];
    });
    const sharedInteractions = a.facts.memberships.filter(item => b.facts.memberships.some(other => item.interactionRef === other.interactionRef)).length;
    const notes = [
        value.scope.population, value.scope.interpretation, value.scope.dates,
        `${count(value.comparison.outcomes.overlap.sharedCount, "matching record")} and ${count(sharedInteractions, "full retained interaction")} appear on both sides. Count each once per side; do not add overlapping populations.`,
        "Source event timestamps and raw source identifiers are withheld. Explicit local date bounds and keyed membership remain frozen.",
        value.scope.authorPolicy,
        ...(value.selection.withinScenarioRefs === undefined ? [] : ["The existing interaction phrase filter additionally narrowed the accepted search membership. Only its keyed scope is saved; private phrase text is withheld."]),
    ];
    const scope = frozenScope(value);
    const technicalScope = Object.entries(value.selection.filters).map(([key, values]) => `${key}: ${Array.isArray(values) ? values.join(", ") : values}`).join("; ");
    return { rows, timing, metrics, notes, labels, scope, technicalScope,
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
        `${count(side.rows.length, "matching record")} in ${chatCopy.groups(side.scenarioRefs.length)}; ${count(side.facts.memberships.length, "full retained interaction")}. ${count(side.unmappedScenarioRefs.length, "group")} ${side.unmappedScenarioRefs.length === 1 ? "has" : "have"} no verified interaction association.`,
        `${side.serviceSelection.knownMatchRefs.length} known selected-service ${side.serviceSelection.knownMatchRefs.length === 1 ? "match" : "matches"}; ${count(side.serviceSelection.contextOnlyRefs.length, "missing-service context record")}. Services can overlap, but a record counts once per side.`,
        ...(side.apiCoverage ? [`${side.apiCoverage.selectedResultUnits} matching returned entries; ${side.apiCoverage.eligibleToolCalls} eligible parent calls before entry outcome/endpoint filters. These are separate populations.`] : []),
        `Saved review-status coverage: ${side.facts.reviewStatuses.length} / ${side.facts.memberships.length} full interactions.`,
    ];
}

export function renderPeriodReportHtml(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const sides = Object.entries(value.periods).map(([key, side], index) => {
        const label = index ? "Period B" : "Period A", model = nativeReportEvidence({ evaluationFacts: side.facts });
        return `<section id="${key}"><h2>${label}: full-interaction findings</h2>${nativeFindingsHtml(model).replace('id="findings"', `id="${key}-findings"`)}
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
        ${nativeReportHeader(display.title)}<main><p class="report-meta">${escape(display.dates)}<br>Prepared ${escape(snapshot.preparedAtDisplay)} from stored revision ${value.revision}.</p>
        <section><h2>What differs</h2><p>${escape(display.finding)}</p><p class="reading-note">${escape(value.scope.interpretation)}</p></section>
        <section id="numbers"><h2>Exact two-side numbers</h2><p class="reading-note">${escape(value.scope.population)}</p>${table(`Matching ${value.definitions.unit}; B minus A`, headers, display.rows)}
        ${display.timing.length ? table("Matching calls only: call start to recorded completion", headers, display.timing) : "<p>Matching-call duration comparison is unavailable for this evidence layer.</p>"}</section>
        ${sides}
        <section id="full-interaction"><h2>Full-interaction checks and timing</h2><p>${escape(value.scope.findings)}</p><p class="reading-note">${sampleNote}</p>${table("Saved reviews and measurements by source and method", headers, display.metrics)}</section>
        ${reportContextHtml(snapshot)}<details id="copies"><summary>Reviewed prompt copies (${snapshot.records.length} groups)</summary><p>Copies explain these results; they do not form a third analytical cohort.</p>${copies}</details>
        <details id="definitions"><summary>Scope, definitions and reading notes</summary><p>${escape(display.scope)}</p>
        <details><summary>Technical frozen filter details</summary><p>${escape(display.technicalScope || "No additional filter keys")}</p><p>Within every service: ${escape(value.selection.withinServices.join(", ") || "No additional refinement")}.</p></details>
        ${[...display.notes, ...formatter.readingNotes].map(note => `<p>${escape(note)}</p>`).join("")}</details></main><footer class="report-footer">Frozen reviewed local copy. No history collection or new assessment was performed for this report.</footer></body></html>`;
}

export function renderPeriodReportMarkdown(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const lines = [`# WIRE - ${display.title}`, "", display.dates, "", `Prepared ${snapshot.preparedAtDisplay} from stored revision ${value.revision}.`, "",
        "## What differs", "", display.finding, "", value.scope.interpretation, "",
        "## Exact two-side numbers", "", value.scope.population, "", `Matching ${value.definitions.unit}; B minus A.`, "", ...markdownTable(headers, display.rows),
        "## Matching call timing", "", ...(display.timing.length ? markdownTable(headers, display.timing) : ["Not available for this evidence layer.", ""])];
    for (const [index, side] of Object.values(value.periods).entries()) {
        const label = index ? "Period B" : "Period A";
        lines.push(`## ${label}: full-interaction findings`, "", ...nativeFindingsMarkdown(nativeReportEvidence({ evaluationFacts: side.facts })).slice(3),
            ...sideNotes(side).flatMap(note => [note, ""]), "### Matching tools and records", "",
            ...markdownTable(["Tool", "Matching records"], tools(side).map(([tool, count]) => [tool, share(count, side.rows.length)])),
            ...markdownTable(["Record / request", "Tool / services", "Outcome", "Duration"], side.rows.map(row => [
                `${row.id} / ${row.scenarioRef}`, `${row.tool}; ${row.services.join(", ") || (row.serviceNotApplicable ? "Service not applicable" : "Service details missing")}`,
                display.labels[row.outcome], row.durationMs === null ? "Not measured" : `${row.durationMs} ms`,
            ])));
    }
    lines.push("## Full-interaction checks and timing", "", value.scope.findings, "", sampleNote, "", ...markdownTable(headers, display.metrics),
        ...reportContextMarkdown(snapshot), "## Reviewed prompt copies", "", "Copies explain these results; they do not form a third analytical cohort.", "");
    for (const record of snapshot.records) {
        lines.push(`<a id="${record.scenarioId}"></a>`, `### ${record.scenarioId}`, "");
        for (const prompt of record.prompts) lines.push(`**${escape(prompt.label ?? promptAuthorship.label(prompt, { ownerVoice: false }))}**`,
            `${prompt.status} source / ${prompt.representation}`, "", ...(prompt.text === null ? ["Omitted or unavailable; not reconstructed."]
                : prompt.text.split("\n").map(line => "    " + line)), "");
    }
    lines.push("## Scope, definitions and reading notes", "", display.scope, "",
        "### Technical frozen filter details", "", display.technicalScope, "",
        `Within every service: ${value.selection.withinServices.join(", ") || "No additional refinement"}.`, "",
        "### Reading notes", "",
        ...[...display.notes, ...formatter.readingNotes].flatMap(note => [note, ""]));
    return lines.join("\n") + "\n";
}
