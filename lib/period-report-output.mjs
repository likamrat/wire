import { validatePeriodReport } from "./period-report.mjs";
import { nativeReportHeader, nativeReportStyles, nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown } from "./native-report-output.mjs";
import { escapeReportText, escapeReportMarkdown, reportMeasurePresentation } from "./report-presentation.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { time } from "./time.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { normalizeMetricFact } from "./report-metric-comparison.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { promptCopyHtml, promptCopyMarkdown } from "./product-report.mjs";

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
const sampleNoteFor = value => value.definitions.metricProjectionVersion === 4
    ? "Recorded timings keep their own request or call counts. Different coverage does not establish overall improvement. Differences are descriptive, not causal."
    : sampleNote;

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
        if (filters[key]?.length) clauses.push(`Restricted to ${count(filters[key].length, `${label} selection`)}${key === "projectIds" && filters[key].includes(null) ? " (including records with no project)" : ""}; exact references remain in the accompanying manifest.`);
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
        ...Object.entries(labels).filter(([key]) => a.totals[key] || b.totals[key]).map(([key, label]) => [label, share(a.totals[key], a.rows.length), share(b.totals[key], b.rows.length),
            value.comparison.outcomes.change[key] === null ? "Not comparable" : signed(value.comparison.outcomes.change[key]) + " percentage points"]),
    ];
    const timing = value.comparison.matchingCallTiming ? ["median", "p95"].map(key => {
        const item = value.comparison.matchingCallTiming[key];
        const display = side => `${key === "p95" && side.coverage.count < 2 ? "Not shown without multiple samples"
            : side.state === "available" ? number(side.value) + " ms" : "Not measured"}; ${side.coverage.count} / ${side.coverage.eligible} ${results.columnUnit("tool", side.coverage.eligible)} timed${side.coverage.count === 1 ? "; single sample" : ""}`;
        return [key === "median" ? "Median tool latency" : "P95 tool latency", display(item.baseline), display(item.later),
            key === "p95" && Math.min(item.baseline.coverage.count, item.later.coverage.count) < 2 ? "Not comparable" : delta(item)];
    }) : [];
    const metrics = value.comparison.metrics.map(item => {
        const { label, definition: shared } = reportMeasurePresentation(item);
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
function matchingRows(side, snapshot, labels) {
    const recordIds = [...new Set(Object.values(snapshot.periodComparison.periods).flatMap(period => period.rows.map(row => row.id)))];
    return side.rows.map(row => {
        const interaction = snapshot.records.findIndex(record => record.scenarioId === row.scenarioRef);
        return [`Record ${recordIds.indexOf(row.id) + 1} / ${interaction < 0 || side.unmappedScenarioRefs.includes(row.scenarioRef) ? "No verified interaction" : `Interaction ${interaction + 1}`}`,
            `${row.tool}; ${row.services.join(", ") || (row.serviceNotApplicable ? "Service not applicable" : "Service details missing")}`,
            labels[row.outcome], row.durationMs === null ? "Not measured" : `${row.durationMs} ms`];
    });
}

function sideNotes(side) {
    return [
        `${count(side.rows.length, "matching record")} in ${chatCopy.groups(side.scenarioRefs.length)}; ${count(side.facts.memberships.length, "full retained interaction")}. ${count(side.unmappedScenarioRefs.length, "group")} ${side.unmappedScenarioRefs.length === 1 ? "has" : "have"} no verified interaction association.`,
        `${side.serviceSelection.knownMatchRefs.length} known selected-service ${side.serviceSelection.knownMatchRefs.length === 1 ? "match" : "matches"}; ${count(side.serviceSelection.contextOnlyRefs.length, "missing-service context record")}. Services can overlap, but a record counts once per side.`,
        ...(side.apiCoverage ? [`${side.apiCoverage.selectedResultUnits} matching returned entries; ${side.apiCoverage.eligibleToolCalls} eligible parent calls before entry outcome/endpoint filters. These are separate populations.`] : []),
        ...([3, 4].includes(side.facts.metricProjectionVersion) ? []
            : [side.facts.reviewStatuses
                ? `Saved review-status coverage: ${side.facts.reviewStatuses.length} / ${side.facts.memberships.length} full interactions.`
                : "Saved review-status coverage was not recorded."]),
    ];
}

export function renderPeriodReportHtml(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const title = snapshot.title || display.title;
    const sides = Object.entries(value.periods).map(([key, side], index) => {
        const label = index ? "Period B" : "Period A", model = nativeReportEvidence({ evaluationFacts: side.facts });
        return `<section id="${key}"><h3>${label}</h3>${nativeFindingsHtml(model).replace('id="findings"', `id="${key}-findings"`)}
            <ul class="native-bars">${tools(side).map(([tool, count]) =>
                `<li><div class="native-bar-heading"><span>${escape(tool)}</span><strong>${escape(share(count, side.rows.length))}</strong></div><div class="native-bar-track"><span class="native-bar" style="width:${count * 100 / side.rows.length}%"></span></div></li>`).join("")}</ul>
            <details><summary>Matching records (${side.rows.length})</summary>${table(`${label}: records in the selected date range`,
                ["Record / interaction", "Tool / services", "Outcome", value.definitions.layer === "tool" ? "Tool latency" : "Recorded duration"],
                matchingRows(side, snapshot, display.labels))}</details></section>`;
    }).join("");
    const copies = snapshot.promptMode === "none" ? "" : snapshot.records.map((record, index) =>
        `<details class="prompt-record" id="${escape(record.scenarioId)}"><summary>Interaction ${index + 1}</summary>${record.prompts.map(prompt => promptCopyHtml(prompt)).join("")}</details>`).join("");
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>WIRE - ${escape(title)}</title><style>${nativeReportStyles}</style></head><body><main>
        ${nativeReportHeader(title)}<p class="report-meta">${escape(display.dates)}<br>Prepared ${escape(snapshot.preparedAtDisplay)}</p>
        <p class="report-summary">${escape(display.finding)}</p>
        <nav class="report-nav" aria-label="Report sections"><a href="#numbers">Activity</a><a href="#full-interaction">Timing</a>${copies ? '<a href="#copies">Report text</a>' : ""}<a href="#definitions">Coverage</a></nav>
        <section id="numbers"><h2>Activity</h2><p class="reading-note">${escape(value.scope.population)}</p>${table("Matching records and full retained interactions; separate populations", headers, display.rows)}
        <h3>Matching tools and records</h3><div class="native-breakdowns period-breakdowns">${sides}</div></section>
        <section id="full-interaction"><h2>${value.definitions.metricProjectionVersion === 4 ? "Timing" : value.definitions.metricProjectionVersion === 3 ? "Personal feedback and recorded timing" : "Full-interaction checks and timing"}</h2>
        ${display.timing.length ? table("Matching tool latency: call start to recorded completion", headers, display.timing) : ""}
        <p class="reading-note">${escape(value.scope.findings)}</p>${table("Full retained interactions: recorded measurements", headers, display.metrics)}<p class="reading-note">${sampleNoteFor(value)}</p></section>
        ${reportContextHtml(snapshot)}${copies ? `<section id="copies"><h2>Report text</h2><p class="reading-note">Supporting copies, not a third comparison population.</p>${copies}</section>` : ""}
        <details id="definitions" class="reading-notes"><summary>Coverage and definitions</summary><p>${escape(display.scope)}</p>
        ${Object.entries(value.periods).map(([, side], index) => `<h3>Period ${index ? "B" : "A"}</h3>${sideNotes(side).map(note => `<p>${escape(note)}</p>`).join("")}`).join("")}
        ${[...display.notes.filter(note => note !== value.scope.population && note !== value.scope.authorPolicy), ...formatter.readingNotesFor(value)].map(note => `<p>${escape(note)}</p>`).join("")}</details>
        <footer class="report-footer">WIRE - Frozen reviewed local copy. No history collection${value.definitions.metricProjectionVersion === 4 ? "" : " or new assessment"} was performed for this report.</footer></main></body></html>`;
}

export function renderPeriodReportMarkdown(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value);
    const lines = [snapshot.title ? `# ${escapeReportMarkdown(snapshot.title)}` : `# WIRE - ${display.title}`, "", display.dates, "", `Prepared ${snapshot.preparedAtDisplay}.`, "",
        display.finding, "", "## Activity", "", value.scope.population, "", "Matching records and full retained interactions; separate populations.", "", ...markdownTable(headers, display.rows)];
    for (const [index, side] of Object.values(value.periods).entries()) {
        const label = index ? "Period B" : "Period A";
        lines.push(`### ${label}`, "", ...nativeFindingsMarkdown(nativeReportEvidence({ evaluationFacts: side.facts })).slice(3),
            ...markdownTable(["Tool", "Matching records"], tools(side).map(([tool, count]) => [tool, share(count, side.rows.length)])),
            ...markdownTable(["Record / interaction", "Tool / services", "Outcome", value.definitions.layer === "tool" ? "Tool latency" : "Recorded duration"],
                matchingRows(side, snapshot, display.labels)));
    }
    lines.push(value.definitions.metricProjectionVersion === 4 ? "## Timing" : value.definitions.metricProjectionVersion === 3 ? "## Personal feedback and recorded timing" : "## Full-interaction checks and timing", "",
        ...(display.timing.length ? ["Matching tool latency: call start to recorded completion.", "", ...markdownTable(headers, display.timing)] : []),
        value.scope.findings, "", ...markdownTable(headers, display.metrics), sampleNoteFor(value), "", ...reportContextMarkdown(snapshot));
    if (snapshot.promptMode !== "none") {
        lines.push("## Report text", "", "Supporting copies, not a third comparison population.", "");
        for (const [index, record] of snapshot.records.entries()) {
            lines.push(`<a id="${record.scenarioId}"></a>`, `### Interaction ${index + 1}`, "");
            for (const prompt of record.prompts) lines.push(...promptCopyMarkdown(prompt));
        }
    }
    lines.push("## Coverage and definitions", "", display.scope, "",
        ...Object.values(value.periods).flatMap((side, index) => [`### Period ${index ? "B" : "A"}`, "", ...sideNotes(side), ""]),
        `Within every service: ${value.selection.withinServices.join(", ") || "No additional refinement"}.`, "",
        ...[...display.notes.filter(note => note !== value.scope.population && note !== value.scope.authorPolicy), ...formatter.readingNotesFor(value)].flatMap(note => [note, ""]));
    return lines.join("\n") + "\n";
}
