import { validatePeriodReport } from "./period-report.mjs";
import { nativeReportHeader, nativeReportStyles, nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown, microsoftEvidenceHtml, microsoftEvidenceMarkdown } from "./native-report-output.mjs";
import { escapeReportText, escapeReportMarkdown, reportMeasurePresentation, reportFieldsHtml, reportTextCell, reportValueCell } from "./report-presentation.mjs";
import { PRODUCT_TITLE } from "./branding.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { reportResultHtml, reportResultMarkdown, resultComparisonHtml, resultComparisonMarkdown,
    resultTextHtml, resultTextMarkdown } from "./report-result-output.mjs";
import { periodResultTextFacts } from "./report-result-facts.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { time } from "./time.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { normalizeMetricFact } from "./report-metric-comparison.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { promptCopyHtml, promptCopyMarkdown } from "./product-report.mjs";
import { metricSlotKey } from "./assessment-contract.mjs";
import { createTimingPresentation } from "../web/assessment-presentation.mjs";

const periodReportStyles = `
.period-comparison-document{background:var(--paper)}
.comparison-periods{display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;margin-top:1rem}
.comparison-periods p{margin:0;display:flex;gap:.6rem;align-items:center;font-size:.875rem}
.comparison-identity{display:inline-block;flex:none;color:var(--ink);font-size:inherit;font-weight:var(--weight-strong)}
.comparison-visuals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem;margin:1rem 0}
.comparison-visuals>section{min-width:0}.comparison-visuals h2{margin:0 0 .5rem}
.comparison-finding{font-size:1.125rem}.comparison-finding>span{font-size:1.5rem}
.comparison-negative{color:var(--danger)}.comparison-positive{color:var(--success)}.comparison-missing{color:var(--muted)}
.comparison-pair-line{display:flex;justify-content:space-between;gap:.5rem;align-items:baseline;font-size:.875rem}
.comparison-outcome-period{margin-top:1rem}
.comparison-outcome-strip{display:flex;width:100%;height:.75rem;background:var(--canvas);margin:.45rem 0}
.comparison-outcome-success{background:var(--success)}.comparison-outcome-failure{background:var(--danger)}
.comparison-outcome-unknown{background:var(--unknown)}.comparison-outcome-partial{background:var(--chart-partial)}
.comparison-outcome-other{background:var(--warning)}.comparison-outcome-transport{background:var(--danger)}
.comparison-outcome-values{margin:.8rem 0}
.comparison-outcome-value{display:grid;grid-template-columns:minmax(0,1fr) 7rem 7rem;gap:.75rem;padding:.25rem 0;font-size:.875rem}
.comparison-outcome-value>:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
.comparison-outcome-value i{display:inline-block;width:.5rem;height:.5rem;margin-right:.4rem}
.comparison-outcome-value.headings{color:var(--muted)}
.comparison-timing-metric{margin-top:1rem}.comparison-timing-metric h3{margin:0}
.comparison-timing-values{display:flex;justify-content:space-between;gap:.5rem;font-variant-numeric:tabular-nums}
.comparison-timing-values p{margin:.5rem 0;font-size:1rem;display:flex;align-items:center;gap:.5rem}
.comparison-timing-metric+.comparison-timing-metric{border-top:1px solid var(--rule);padding-top:.75rem}
.comparison-whole-measure{border-top:1px solid var(--rule);padding-top:.5rem;margin-top:1rem;break-inside:avoid}
.comparison-whole-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.comparison-whole-values>div{display:flex;gap:.7rem;flex-wrap:wrap;align-items:baseline}
.comparison-whole-numbers{font-variant-numeric:tabular-nums}.comparison-whole-numbers>span{display:block}
.period-evidence-period{margin-top:1.4rem;break-inside:auto}
.period-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:1rem 1.5rem;break-inside:auto}
.period-evidence-group{table-layout:fixed;width:100%;margin:0;align-self:start;break-inside:auto}
.period-evidence-group thead{background:transparent;display:table-header-group}
.period-evidence-group th,.period-evidence-group td{padding:.45rem 0;border:0;text-align:left;overflow-wrap:normal}
.period-evidence-group thead th{border-top:1px solid var(--rule);padding-top:.55rem;break-after:avoid}
.period-evidence-heading{display:flex;flex-wrap:wrap;gap:.2rem .75rem;align-items:baseline;justify-content:space-between}
.period-evidence-heading h4{margin:0;font-size:1rem}
.period-evidence-heading>span{font-weight:var(--weight-regular);color:var(--muted)}
.period-evidence-common{margin:.25rem 0 0;font-weight:var(--weight-regular);color:var(--muted)}
.period-evidence-group tbody tr{break-inside:avoid}.period-evidence-group tbody tr:first-child{break-before:avoid}
.period-evidence-result{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:baseline}
.period-evidence-result>span:first-child{font-weight:var(--weight-medium)}
.period-evidence-duration{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:var(--weight-strong)}
.period-evidence-context{display:flex;flex-wrap:wrap;gap:0 .35rem;margin-top:.15rem;color:var(--muted);font-variant-numeric:tabular-nums}
.period-evidence-context .report-facts,.period-evidence-common .report-facts{margin:.2rem 0;font-size:inherit;gap:.2rem 1rem}
.period-evidence-result-label{color:var(--muted);margin-right:.5rem}
.period-evidence-period-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem 1rem}
.period-evidence-period-title .report-facts{margin:0}
.period-coverage{margin-top:1.5rem}.period-coverage dl{margin:0}
.period-coverage dl>div{display:grid;grid-template-columns:8.5rem minmax(0,1fr);gap:.35rem .8rem;padding:.35rem 0}
.period-coverage dt{font-weight:var(--weight-medium);color:var(--ink)}.period-coverage dd{margin:0}
@media screen and (max-width:700px){.comparison-visuals,.period-evidence-grid{grid-template-columns:minmax(0,1fr)}}
@media screen and (max-width:420px){
 .comparison-outcome-value{grid-template-columns:repeat(2,minmax(0,1fr))}.comparison-outcome-value>:first-child{grid-column:1/-1}
 .comparison-outcome-value.headings{display:none}
 .comparison-outcome-value>:nth-child(2)::before{content:"A ";color:var(--muted)}.comparison-outcome-value>:nth-child(3)::before{content:"B ";color:var(--muted)}
 .comparison-pair-line,.comparison-timing-values{flex-wrap:wrap}.period-coverage dl>div{grid-template-columns:minmax(0,1fr);gap:.1rem}
 .comparison-whole-values{grid-template-columns:minmax(0,1fr);gap:.5rem}
 .comparison-whole-values>div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.25rem .7rem}
 .comparison-whole-values .reading-note{grid-column:2}
}
@media print{
 .comparison-visuals{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;break-inside:avoid}
 .comparison-finding{font-size:11pt}.comparison-finding>span{font-size:15pt}
 .comparison-outcome-value,.comparison-pair-line{font-size:9pt}.comparison-outcome-value{grid-template-columns:minmax(0,1fr) 6rem 6rem;gap:.5rem}
 .comparison-timing-values p{font-size:10pt}
 .period-evidence-grid{display:block;column-count:2;column-gap:16pt;column-fill:balance;break-inside:auto}
 .period-evidence-group{font-size:10pt;line-height:1.4;margin-bottom:10pt;break-inside:auto}
 .period-evidence-group th,.period-evidence-group td{font-size:10pt;padding:4pt 0}.period-evidence-group td{padding:2pt 0}
 .period-evidence-heading h4{font-size:11pt}.period-evidence-group thead{break-inside:avoid;break-after:avoid}
 /* Override the more-specific screen heading padding. */
 .period-evidence-group thead th{padding-top:4pt}
 .period-evidence-period,.period-coverage dl{break-inside:auto}
 .period-coverage{break-inside:avoid}
 .period-coverage{margin-top:0;padding-top:0}.period-coverage dl>div{padding:3pt 0;break-inside:avoid}
}
@media(forced-colors:active){.comparison-outcome-strip>span{border:1px solid CanvasText}.comparison-dot-b{fill:CanvasText}}
`;

const escape = escapeReportText, formatter = createReportComparison(), results = createRecordedResults();
const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const exactNumber = value => Number.isSafeInteger(value) ? number(value) : String(value);
const timingPresentation = createTimingPresentation();
const millisecondsTiming = createTimingPresentation(undefined, { compact: true });
const millisecondsFormatter = createReportComparison(undefined, millisecondsTiming.duration);
const duration = (value, snapshot) => snapshot?.presentation?.schemaVersion === 3
    ? millisecondsTiming.duration(value) : value === null ? "Not measured" : `${exactNumber(value)} ms`;
const durationChange = value => millisecondsFormatter.formatChange(value, "ms");
const share = (count, total) => `${count} / ${total} (${total ? number(count * 100 / total) + "%" : "Not applicable"})`;
const signed = value => `${value > 0 ? "+" : ""}${number(value)}`;
const count = (value, singular) => `${number(value)} ${singular}${Math.abs(value) === 1 ? "" : "s"}`;
const delta = (comparison, snapshot) => comparison?.delta ? comparison.delta.unit === "ms" && snapshot?.presentation?.schemaVersion === 3
    ? durationChange(comparison.delta.value) : `${signed(comparison.delta.value)} ${comparison.delta.unit === "percentage-points" ? "percentage points" : comparison.delta.unit}`
    : comparison?.status === "incompatible" ? "Different metric definitions; not comparable" : "Not comparable";
const factPresentation = (value, peer, snapshot) => {
    if (!value) return { value: formatter.absentPeerLabel(peer), numeric: false, note: "" };
    const view = formatter.metricPresentation(normalizeMetricFact(value), value.metric, { includeOrigin: false });
    const result = value.state !== "available" ? view.value : value.kind === "pass-rate"
        ? `${number(value.numerator * 100 / value.denominator)}%` : value.unit === "ms" && snapshot?.presentation?.schemaVersion === 3
            ? duration(value.value, snapshot) : `${number(value.value)} ${value.unit}`;
    const note = snapshot?.presentation?.schemaVersion === 3 ? view.note.replaceAll(" · ", "; ") : view.note;
    return { value: result, numeric: value.state === "available",
        note: note + (value.kind === "duration" && value.coverage.count === 1 ? "; single sample" : "") };
};
const fact = (value, peer, snapshot) => {
    const presented = factPresentation(value, peer, snapshot);
    return presented.value + (presented.note ? "; " + presented.note : "");
};
const matchingTimingPresentation = (side, key, snapshot) => ({
    value: key === "p95" && side.coverage.count < 2 ? "Not shown without multiple samples"
        : side.state === "available" ? snapshot?.presentation?.schemaVersion === 3 ? duration(side.value, snapshot) : number(side.value) + " ms" : "Not measured",
    numeric: side.state === "available" && (key !== "p95" || side.coverage.count >= 2),
    note: `${side.coverage.count} / ${side.coverage.eligible} ${results.columnUnit("tool", side.coverage.eligible)} timed${side.coverage.count === 1 ? "; single sample" : ""}`,
});
const sampleNote = "Compare each value with its assessed or timed sample count. Unequal coverage can reflect different subsets; it does not establish overall improvement. Differences are descriptive, not causal.";
const sampleNoteFor = value => value.definitions.metricProjectionVersion === 4
    ? "Recorded timings keep their own request or call counts. Different coverage does not establish overall improvement. Differences are descriptive, not causal."
    : sampleNote;

function frozenScope(value, snapshot) {
    const filters = value.selection.filters, services = filters.services ?? [];
    const names = values => values.map(name => (snapshot?.presentation?.schemaVersion === 3 ? serviceCategories.display : serviceCategories.describe)(name).label);
    const collection = { history: "the current retained collection (earlier-snapshot records excluded)",
        legacy: "earlier-snapshot retained records only", all: "current and earlier-snapshot retained records" }[filters.scope ?? "history"];
    const clauses = [`Both periods use ${collection}. Matching ${value.definitions.unit} are counted within each frozen date range.`];
    if (services.length) {
        clauses.push(`Service choices: ${names(services).join(" or ")}. A match to any selected choice qualifies (OR).`);
        if (services.includes("Unknown")) {
            clauses.push(`${names(["Unknown"])[0]} is explicitly selected: records in that category are selected matches, not evidence of a confirmed service.`);
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
    const outcomes = createRecordedResults({ screen: value.definitions.resultProjectionVersion === 1 }).labels(value.definitions.layer);
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

export function periodReportDisplay(value, snapshot) {
    validatePeriodReport(value);
    const a = value.periods.baseline, b = value.periods.later,
        labels = createRecordedResults({ screen: value.definitions.resultProjectionVersion === 1 }).labels(value.definitions.layer);
    const rows = [
        ["Matching records", String(a.rows.length), String(b.rows.length), `${b.rows.length > a.rows.length ? "+" : ""}${count(b.rows.length - a.rows.length, "record")}`],
        ["Full retained interactions", String(a.facts.memberships.length), String(b.facts.memberships.length), `${b.facts.memberships.length > a.facts.memberships.length ? "+" : ""}${count(b.facts.memberships.length - a.facts.memberships.length, "interaction")}`],
        ...Object.entries(labels).filter(([key]) => a.totals[key] || b.totals[key]).map(([key, label]) => [label, share(a.totals[key], a.rows.length), share(b.totals[key], b.rows.length),
            value.comparison.outcomes.change[key] === null ? "Not comparable" : signed(value.comparison.outcomes.change[key]) + " percentage points"]),
    ];
    const timing = value.comparison.matchingCallTiming ? ["median", "p95"].map(key => {
        const item = value.comparison.matchingCallTiming[key];
        const display = side => {
            const presented = matchingTimingPresentation(side, key, snapshot);
            return `${presented.value}; ${presented.note}`;
        };
        return [key === "median" ? "Median tool latency" : "P95 tool latency", display(item.baseline), display(item.later),
            key === "p95" && Math.min(item.baseline.coverage.count, item.later.coverage.count) < 2 ? "Not comparable" : delta(item, snapshot)];
    }) : [];
    const metrics = value.comparison.metrics.map(item => {
        const { label, definition: shared } = reportMeasurePresentation(item);
        const side = name => {
            const detail = formatter.sideDefinitionLabel(item, name);
            return (detail ? detail + ". " : "") + fact(item[name], item[name === "baseline" ? "later" : "baseline"], snapshot);
        };
        return [shared ? `${label} / ${shared}` : label,
            side("baseline"), side("later"), delta(item.result, snapshot)];
    });
    const sharedInteractions = a.facts.memberships.filter(item => b.facts.memberships.some(other => item.interactionRef === other.interactionRef)).length;
    const notes = [
        value.scope.population, value.scope.interpretation, value.scope.dates,
        `${count(value.comparison.outcomes.overlap.sharedCount, "matching record")} and ${count(sharedInteractions, "full retained interaction")} appear on both sides. Count each once per side; do not add overlapping populations.`,
        value.nativePeriods ? "Qualified Microsoft activity instants and keyed membership remain frozen. Raw source identifiers and GitHub event timestamps are withheld."
            : "Source event timestamps and raw source identifiers are withheld. Explicit local date bounds and keyed membership remain frozen.",
        value.scope.authorPolicy,
        ...(value.selection.withinScenarioRefs === undefined ? [] : ["The existing interaction phrase filter additionally narrowed the accepted search membership. Only its keyed scope is saved; private phrase text is withheld."]),
    ];
    const scope = frozenScope(value, snapshot);
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
const markdownTable = (headers, rows, numeric = [], cell = escape) => [`| ${headers.map(escape).join(" | ")} |`, `|${headers.map((_, index) => numeric.includes(index) ? "---:" : "---").join("|")}|`,
    ...rows.map((cells, row) => `| ${cells.map((value, column) => cell(value, row, column)).join(" | ")} |`), ""];
const headers = ["Measure", "Period A", "Period B", "Observed difference"];
const nativePeriodHeaders = ["Source and measure", "Period A", "Period B", "Change", "Undated"];
const nativePeriodNote = "Each source and unit is counted separately. Undated evidence is not assigned to either period. Message dates are not call start times; observed differences do not establish improvement.";
const nativePeriodNotes = value => nativePeriodNote + (value.nativePeriods?.refinement
    ? ` Period A and B replace the original Dates filter; the original Search, group and other source filters are preserved. ${value.nativePeriods.refinement.contextConversationRefs.length} matching conversation${value.nativePeriods.refinement.contextConversationRefs.length === 1 ? " is" : "s are"} context-only; exact message-date cohorts are not established. Predicate commitment: ${value.nativePeriods.refinement.predicateRef}.` : "");
function nativePeriodRows(value) {
    return value.nativePeriods?.summary.flatMap(item => {
        const label = `${item.sourceId === "microsoft-365-chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork"}: ${item.unit === "native-tool-call" ? "native calls" : item.unit === "native-returned-result-observation" ? "returned results" : "message observations"}`;
        const outcomes = item.unit === "message-representation-observation" ? [] : ["success", "failure", "unknown", "other"]
            .filter(key => item.baseline[key] || item.later[key])
            .map(key => [`${label} / ${key}`, item.baseline[key], item.later[key], signed(item.later[key] - item.baseline[key]), "-"]);
        return [[label, item.baseline.count, item.later.count, signed(item.later.count - item.baseline.count), item.undated], ...outcomes];
    }) ?? [];
}
function nativePeriodsHtml(value) {
    if (!value.nativePeriods) return "";
    const rows = nativePeriodRows(value);
    return `<section id="microsoft-periods"><h2>Microsoft activity</h2><p class="reading-note">${escape(nativePeriodNotes(value))}</p>${rows.length
        ? `<table class="native-table"><thead><tr>${nativePeriodHeaders.map((label, index) => `<th${index ? ' class="report-numeric"' : ""}>${escape(label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row =>
            `<tr>${row.map((text, index) => index ? `<td class="report-numeric" data-label="${nativePeriodHeaders[index]}">${escape(text)}</td>` : `<th scope="row"${text.endsWith(" / failure") ? ' class="report-negative"' : ""}>${escape(text)}</th>`).join("")}</tr>`).join("")}</tbody></table>`
        : "<p>No Microsoft observations match this record type and filter selection.</p>"}</section>`;
}
const tools = side => [...new Set(side.rows.map(row => row.tool))].map(tool => [tool, side.rows.filter(row => row.tool === tool).length]);
export function groupPeriodEvidence(side, snapshot) {
    const interactions = new Map(snapshot.records.map((record, index) => [record.scenarioId, index + 1]));
    const ordinals = new Map([...new Set(Object.values(snapshot.periodComparison.periods).flatMap(period => period.rows.map(row => row.id)))]
        .map((id, index) => [id, index + 1]));
    const unmapped = new Set(side.unmappedScenarioRefs), groups = new Map();
    for (const row of side.rows) {
        const interactionOrdinal = unmapped.has(row.scenarioRef) ? undefined : interactions.get(row.scenarioRef);
        const key = interactionOrdinal === undefined ? row.id : row.scenarioRef;
        if (!groups.has(key)) groups.set(key, { interactionOrdinal: interactionOrdinal ?? null, records: [] });
        groups.get(key).records.push({ row, ordinal: ordinals.get(row.id) });
    }
    const serviceKey = row => JSON.stringify([row.services, row.missingService, row.serviceNotApplicable]);
    return [...groups.values()].sort((a, b) => (a.interactionOrdinal ?? Infinity) - (b.interactionOrdinal ?? Infinity)
        || a.records[0].ordinal - b.records[0].ordinal).map(group => {
        const first = group.records[0].row;
        const repeated = group.interactionOrdinal !== null && group.records.length > 1;
        return { ...group,
            commonTool: repeated && group.records.every(({ row }) => row.tool === first.tool) ? first.tool : null,
            commonService: repeated && group.records.every(({ row }) => serviceKey(row) === serviceKey(first))
                ? { services: [...first.services], missingService: first.missingService, serviceNotApplicable: first.serviceNotApplicable } : null,
        };
    });
}
function matchingRows(side, snapshot, labels, separateTools = false) {
    const recordIds = [...new Set(Object.values(snapshot.periodComparison.periods).flatMap(period => period.rows.map(row => row.id)))];
    return side.rows.map(row => {
        const interaction = snapshot.records.findIndex(record => record.scenarioId === row.scenarioRef);
        const services = row.services.join(", ") || (row.serviceNotApplicable ? "Service not applicable" : "Service details missing");
        return [`Record ${recordIds.indexOf(row.id) + 1} / ${interaction < 0 || side.unmappedScenarioRefs.includes(row.scenarioRef) ? "No verified interaction" : `Interaction ${interaction + 1}`}`,
            ...(separateTools ? [row.tool, services] : [`${row.tool}; ${services}`]),
            labels[row.outcome], snapshot?.presentation?.schemaVersion === 3 ? duration(row.durationMs, snapshot) : row.durationMs === null ? "Not measured" : `${row.durationMs} ms`];
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

function renderLegacyPeriodReportHtml(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value, snapshot);
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
        `<details class="prompt-record" id="${escape(record.scenarioId)}"><summary>Interaction ${index + 1}</summary>${record.prompts.map(prompt => promptCopyHtml(prompt, "h4", snapshot)).join("")}</details>`).join("");
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

function periodChangeHtml(value, unit, snapshot) {
    if (value === null) return '<span class="comparison-missing">Not comparable</span>';
    if (unit.startsWith("ms") && snapshot?.presentation?.schemaVersion === 3) return `<span class="${value === 0 ? "" : value > 0 ? "comparison-negative" : "comparison-positive"}">${escape(durationChange(value) + unit.slice(2))}</span>`;
    const smallShare = unit === "pp" && value !== 0 && Math.abs(value) < 0.01;
    if (smallShare) return `<span class="${value > 0 ? "comparison-negative" : "comparison-positive"}">${value > 0 ? "+" : ""}${escape(formatter.formatValue(value, "percentage-points"))}</span>`;
    const text = unit.startsWith("ms") ? `${value > 0 ? "+" : ""}${exactNumber(value)}` : signed(value);
    return `<span class="${value === 0 ? "" : value > 0 ? "comparison-negative" : "comparison-positive"}">${text} ${escape(unit)}</span>`;
}

function periodOutcomesHtml(value, labels) {
    const { baseline: a, later: b } = value.periods;
    const volumeChange = b.rows.length - a.rows.length;
    const keys = Object.keys(labels).filter(key => a.totals[key] || b.totals[key]);
    const percent = (count, total) => total ? `${number(count)} (${(count * 100 / total).toFixed(2)}%)` : `${number(count)} (Not applicable)`;
    const change = value.comparison.outcomes.change.failure;
    const finding = value.definitions.layer === "code-reference" ? "Execution not observed"
        : change === null ? "Failure share is not comparable"
        : `${periodChangeHtml(change, "pp")} ${change > 0 ? "higher failure share" : change < 0 ? "lower failure share" : "failure share unchanged"}`;
    const bars = [a, b].map((side, index) => {
        const name = index ? "B" : "A";
        return `<div class="comparison-outcome-period"><div class="comparison-pair-line"><span class="comparison-identity ${index ? "filled" : ""}">${name}</span>
            <span>${number(side.rows.length)} ${escape(value.definitions.unit)}</span></div>
            <div class="comparison-outcome-strip" role="img" aria-label="${escape(name + ": " + keys.map(key => `${labels[key]} ${side.totals[key]} of ${side.rows.length}`).join("; "))}">
            ${keys.filter(key => side.totals[key]).map(key => `<span class="comparison-outcome-${key}" style="width:${side.totals[key] * 100 / side.rows.length}%"></span>`).join("")}</div>
            ${side.rows.length ? "" : '<p class="reading-note">No matching records.</p>'}</div>`;
    }).join("");
    return `<section class="comparison-outcomes"><h2>Recorded outcomes</h2><p class="comparison-finding">${finding}</p>
        <p class="reading-note">${value.definitions.layer === "tool" ? "Share of matching calls" : escape(value.definitions.unit)}; change in percentage points.</p>
        ${bars}<div class="comparison-outcome-values"><div class="comparison-outcome-value headings"><span>Outcome</span><span>A</span><span>B</span></div>
        ${keys.map(key => `<div class="comparison-outcome-value"><span><i class="comparison-outcome-${key}"></i>${escape(labels[key])}</span>
            <span>${percent(a.totals[key], a.rows.length)}</span><span>${percent(b.totals[key], b.rows.length)}</span></div>`).join("")}</div>
        <p class="reading-note">Volume change: ${volumeChange > 0 ? "+" : ""}${count(volumeChange, "record")}</p></section>`;
}

function periodTimingMetricHtml(item, aggregation, snapshot) {
    const shown = fact => fact.state === "available" && (aggregation !== "p95" || fact.coverage.count > 1);
    const facts = [item.baseline, item.later];
    const text = fact => shown(fact) ? duration(fact.value, snapshot)
        : fact.coverage.count === 1 && aggregation === "p95" ? "Single sample; P95 not shown" : "Not measured";
    const change = item.delta && facts.every(shown) ? item.delta.value : null;
    const label = aggregation === "median" ? "Median tool latency" : "P95 tool latency";
    return `<section class="comparison-timing-metric"><h3>${label}</h3>
        <div class="comparison-timing-values">${facts.map((fact, index) => `<p><span class="comparison-identity">${index ? "B" : "A"}</span> ${escape(text(fact))}</p>`).join("")}</div>
        <p class="reading-note">Change: ${periodChangeHtml(change, "ms" + (change > 0 ? " slower" : change < 0 ? " faster" : ""), snapshot)}</p></section>`;
}

function periodTimingHtml(value, snapshot) {
    const timing = value.comparison.matchingCallTiming;
    const body = timing ? periodTimingMetricHtml(timing.median, "median", snapshot) + periodTimingMetricHtml(timing.p95, "p95", snapshot)
        + reportFieldsHtml([timing.median.baseline, timing.median.later].map((fact, index) => [
            `${index ? "B" : "A"} timed calls`, `${fact.coverage.count}/${fact.coverage.eligible}${
                fact.coverage.count < fact.coverage.eligible ? `; ${fact.coverage.eligible - fact.coverage.count} missing (excluded)` : ""}`,
        ]))
        : "<p>Unavailable for this evidence layer; these records are not timed tool calls.</p>";
    return `<section class="comparison-latency"><h2>Matching tool latency</h2><p class="reading-note">Call start to recorded completion</p>${body}</section>`;
}

function periodWholeTimingHtml(value, snapshot) {
    const sides = Object.values(value.periods);
    const metrics = value.comparison.metrics.map(item => {
        const facts = [item.baseline, item.later];
        const timed = sides.map((side, index) => {
            const metric = side.facts.metrics.find(metric => metricSlotKey(metric) === item.key);
            return metric && facts[index]?.kind === "duration" ? timingPresentation.fromMetric(metric) : null;
        });
        const cells = facts.map((fact, index) => {
            const timing = timed[index];
            const result = fact?.state === "available" && timing
                ? timing.timed > 1 ? `Median ${escape(duration(timing.distribution.p50Ms, snapshot))} <span>P95 ${escape(duration(timing.distribution.p95Ms, snapshot))}</span>`
                    : `${escape(duration(timing.measurement.value, snapshot))} (single sample)`
                : escape(fact ? formatter.metricPresentation(fact, fact.metric, { includeOrigin: false }).value : formatter.absentPeerLabel(facts[1 - index]));
            const definition = formatter.sideDefinitionLabel(item, index ? "later" : "baseline");
            return `<div><span class="comparison-identity ${index ? "filled" : ""}">${index ? "B" : "A"}</span><div class="comparison-whole-numbers">${result}</div>
                ${definition ? `<p class="reading-note">${escape(definition)}</p>` : ""}</div>`;
        }).join("");
        const change = item.result?.delta, warnings = item.result?.warnings?.filter(code => !["partial-coverage", "coverage-decreased"].includes(code)) ?? [];
        const coverage = timed.flatMap((timing, index) => timing ? [[`${index ? "B" : "A"} timed`, `${timing.timed}/${timing.eligible} ${timing.coverage.unit}`]] : []);
        return `<section class="comparison-whole-measure"><h3>${escape(timed.find(Boolean)?.label || formatter.comparisonLabel(item))}</h3>
            <div class="comparison-whole-values">${cells}</div>${coverage.length ? reportFieldsHtml(coverage) : ""}
            <p class="reading-note">Median change: ${item.result?.status === "incompatible" ? "Incompatible definitions" : periodChangeHtml(change?.value ?? null, change?.unit ?? "", snapshot)}</p>
            ${warnings.length ? `<p class="reading-note">${escape(warnings.map(code => formatter.warningLabel(code, item)).join("; "))}</p>` : ""}</section>`;
    }).join("");
    return `<section id="full-interaction"><h2>Whole-interaction timing</h2>
        ${reportFieldsHtml(sides.map((side, index) => [`${index ? "B" : "A"} interactions`, side.facts.memberships.length]))}
        <p class="reading-note">Includes calls outside the selected dates or filters.</p>${metrics}</section>`;
}

function periodEvidenceHtml(value, snapshot, labels) {
    const serviceText = row => row.services.length ? row.services.join(", ") + (row.missingService ? " (some service details missing)" : "")
        : row.serviceNotApplicable ? "Service not applicable" : "Service details missing";
    const groupsHtml = (side, period) => groupPeriodEvidence(side, snapshot).map(group => {
        const title = group.interactionOrdinal === null ? `Record ${group.records[0].ordinal}` : `Interaction ${group.interactionOrdinal}`;
        const common = [...(group.commonTool ? [["Tool", group.commonTool]] : []),
            ...(group.commonService ? [["Services", serviceText(group.commonService)]] : [])];
        return `<table class="period-evidence-group" data-period="${period}" data-interaction-ordinal="${group.interactionOrdinal ?? ""}" aria-label="${escape(title)}">
            <thead><tr><th scope="col"><div class="period-evidence-heading"><h4>${escape(title)}</h4><span>${group.records.length} matching ${group.records.length === 1 ? "record" : "records"}</span></div>
            ${group.interactionOrdinal === null ? '<p class="reading-note">No verified interaction.</p>' : ""}
            ${common.length ? `<div class="period-evidence-common">${reportFieldsHtml(common)}</div>` : ""}</th></tr></thead>
            <tbody>${group.records.map(({ row, ordinal }) => {
                const variable = [["Record", ordinal], ...(!group.commonTool && row.tool ? [["Tool", row.tool]] : []),
                    ...(!group.commonService ? [["Services", serviceText(row)]] : [])];
                const tone = ["failure", "transport"].includes(row.outcome) ? "comparison-negative" : "";
                return `<tr data-record-id="${escape(row.id)}" data-record-ordinal="${ordinal}"><td>
                    <div class="period-evidence-result"><span><span class="period-evidence-result-label">Outcome</span><span class="${tone}">${escape(labels[row.outcome])}</span></span><span class="period-evidence-duration">${escape(duration(row.durationMs, snapshot))}</span></div>
                    <div class="period-evidence-context">${reportFieldsHtml(variable)}</div></td></tr>`;
            }).join("")}</tbody></table>`;
    }).join("");
    return `<section id="evidence"><h2>Exact matching evidence</h2>
        <p class="reading-note">${value.definitions.layer === "tool" ? "Tool latency: call start to recorded completion." : "Recorded duration for this evidence layer."} Grouped by frozen interaction ordinal, not event chronology.</p>
        ${Object.entries(value.periods).map(([key, side], index) => `<section id="${key}" class="period-evidence-period">
            <div class="period-evidence-period-title"><h3>Period ${index ? "B" : "A"}</h3>${reportFieldsHtml([["Records", side.rows.length], ["Interactions", side.facts.memberships.length]])}</div>
            <div class="period-evidence-grid">${groupsHtml(side, index ? "B" : "A") || '<p class="reading-note">No matching records in this period.</p>'}</div></section>`).join("")}</section>`;
}

function periodCoverageHtml(value, snapshot, labels, overlap) {
    const filters = value.selection.filters, services = filters.services ?? [], sides = Object.values(value.periods);
    const names = values => values.map(name => (snapshot?.presentation?.schemaVersion === 3 ? serviceCategories.display : serviceCategories.describe)(name).label);
    const textPolicy = { none: "No prompt text", masked: "Masked supporting text", original: "Original supporting text with mandatory credential removal" };
    const facts = [
        ["Collection", { history: "Current retained; earlier snapshots excluded", legacy: "Earlier snapshot only", all: "Current and earlier snapshots" }[filters.scope ?? "history"]],
        ["Tools", filters.tools?.length ? filters.tools.join(" or ") : "All tools"],
        ["Outcomes", filters.outcomes?.length ? filters.outcomes.map(key => labels[key]).join(" or ") : "All recorded outcomes"],
        ["Authors", promptAuthorship.selectionLabel(value.selection.promptAuthors, { ownerVoice: false })],
        ["Selected services", services.length ? `Any selected service (OR): ${names(services).join(" or ")}` : "No service filter"],
        ["Platform metadata", filters.includeMetadata === true ? "Included" : "Excluded"],
        ["Text policy", `${textPolicy[snapshot.promptMode] ?? "Text-copy policy not recorded"}. Supporting text and context do not add measured records.`],
    ];
    if (services.length) {
        facts.push(["Service matching", (filters.includeMissingService === true
            ? "Missing or unusable service details may enter as context; all other filters still apply."
            : "Selected service/category matches only; no additional missing-detail context.")
            + (services.includes("Unknown") ? ` ${names(["Unknown"])[0]} is a selected category, not a confirmed service.` : "")]);
        facts.push(...sides.map((side, index) => [`Period ${index ? "B" : "A"} service coverage`,
            `${side.serviceSelection.knownMatchRefs.length} known matches; ${count(side.serviceSelection.contextOnlyRefs.length, "missing-service context record")}`]));
    }
    if (value.selection.withinServices.length) facts.push(["Additional services",
        `Every service required (AND): ${names(value.selection.withinServices).join(" and ")}. Applied after service choices; can exclude missing-detail context.`]);
    if (filters.workloads?.length) facts.push(["Activity categories", names(filters.workloads).join(" or ")]);
    if (filters.activityTypes?.length) {
        const types = { workiq: "Work IQ activity", "direct-request": "Recorded Graph request sites", "recorded-http": "Output-visible Graph statuses",
            "captured-http": "Owned HTTP records", "code-reference": "Graph code references" };
        facts.push(["Activity types", filters.activityTypes.map(type => types[type]).join(" or ")]);
    }
    const restricted = [["sourceSessionIds", "chat"], ["projectIds", "project"], ["endpoints", "endpoint"]].filter(([key]) => filters[key]?.length)
        .map(([key, name]) => `${filters[key].length} ${name} selections${key === "projectIds" && filters[key].includes(null) ? " (including no project)" : ""}`);
    if (restricted.length) facts.push(["Restricted sources", restricted.join("; ") + ". Exact keyed references remain in the manifest."]);
    if (value.selection.semanticMembership) facts.push(["Search scope", "Frozen search membership applies; private query text is withheld."]);
    if (value.selection.withinScenarioRefs !== undefined) facts.push(["Additional selection", "A frozen interaction selection narrows the search membership; private phrase text is withheld."]);
    if (!overlap.records && !overlap.interactions) facts.push([value.nativePeriods ? "GitHub overlap" : "Overlap", "No shared matching records or whole interactions"]);
    for (const [index, side] of sides.entries()) {
        if (side.unmappedScenarioRefs.length) facts.push([`Period ${index ? "B" : "A"} associations`, `${side.unmappedScenarioRefs.length} request groups have no verified interaction association.`]);
        if (side.apiCoverage) facts.push([`Period ${index ? "B" : "A"} API coverage`,
            `${side.apiCoverage.selectedResultUnits} matching returned entries; ${side.apiCoverage.eligibleToolCalls} parent calls before entry outcome/path filters. Separate populations.`]);
    }
    facts.push(["History limits", "Retained history only; undated records excluded and history gaps may remain."],
        ["Withheld data", value.nativePeriods ? "Raw IDs and GitHub event timestamps withheld; qualified Microsoft activity instants, local date bounds and keyed membership stay frozen."
            : "Source event timestamps and raw IDs withheld; local date bounds and keyed membership stay frozen."],
        ["Timing method", "Nearest-rank percentiles, timed samples only. Missing timing is not zero; concurrent calls are not summed into task time."],
        ["Interpretation", "Observed differences, not causal improvement. Recorded outcomes are not answer quality."]);
    return `<section id="definitions" class="reading-notes period-coverage"><h2>Scope and coverage</h2>
        <dl>${facts.map(([label, fact]) => `<div><dt>${escape(label)}</dt><dd>${escape(fact)}</dd></div>`).join("")}</dl></section>`;
}

export function renderPeriodReportHtml(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records);
    if (value.definitions.metricProjectionVersion !== 4) return renderLegacyPeriodReportHtml(snapshot);
    const display = periodReportDisplay(value, snapshot), sides = Object.values(value.periods);
    const github = !value.nativePeriods || sides.some(side => side.rows.length);
    const githubRecords = snapshot.records.filter(record => record.recordKind !== "native-conversation");
    const overlap = { records: value.comparison.outcomes.overlap.sharedCount,
        interactions: sides[0].facts.memberships.filter(item => sides[1].facts.memberships.some(peer => peer.interactionRef === item.interactionRef)).length };
    const days = side => Math.round((Date.parse(side.range.to) - Date.parse(side.range.from)) / 86400000) + 1;
    const periods = reportFieldsHtml([...sides.map((side, index) => [`Period ${index ? "B" : "A"}`,
        `${side.range.from} to ${side.range.to} (${count(days(side), "day")})`]),
        ["Timezone", value.timeContext.timeZone], ["Change", "B minus A"], ["Prepared", snapshot.preparedAtDisplay]])
        + '<p class="report-meta">Both dates included.</p>';
    const unequal = days(sides[0]) !== days(sides[1]) ? `<p class="reading-note">Unequal windows: A ${count(days(sides[0]), "day")}; B ${count(days(sides[1]), "day")}. Counts are not normalized per day.</p>` : "";
    const overlapNote = overlap.records || overlap.interactions ? `<p class="reading-note">Overlap: ${count(overlap.records, "matching record")} and ${count(overlap.interactions, "whole interaction")} appear on both sides; count once per period.</p>` : "";
    const copies = snapshot.promptMode === "none" || !githubRecords.length ? "" : `<section id="copies"><h2>Report text</h2><p class="reading-note">${snapshot.promptMode === "masked" ? "Masked copies." : "Original wording."}</p>
        ${githubRecords.map((record, index) => `<details class="prompt-record" id="${escape(record.scenarioId)}"><summary>Interaction ${index + 1}</summary>${record.prompts.map(prompt => promptCopyHtml(prompt, "h4", snapshot)).join("")}</details>`).join("")}</section>`;
    const resultEvidence = value.definitions.resultProjectionVersion === 1
        ? resultComparisonHtml(value.resultComparison) + sides.map((side, index) => reportResultHtml(side.resultFacts, undefined, {
            id: `period-${index ? "b" : "a"}-results`, title: `Period ${index ? "B" : "A"}: recorded tool results`, textSection: false, showBoundary: false,
        })).join("") + resultTextHtml(snapshot.resultText, periodResultTextFacts(value)) : "";
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
        <title>WIRE - ${escape(snapshot.title || display.title)}</title><style>${nativeReportStyles}${periodReportStyles}</style></head><body class="period-comparison-document"><main>
        ${nativeReportHeader(snapshot.title || display.title)}${periods}
        ${nativePeriodsHtml(value)}
        ${resultEvidence}
        <nav class="report-nav" aria-label="Report sections"><a href="${github ? "#numbers" : "#microsoft-periods"}">Comparison</a>${github ? '<a href="#full-interaction">Whole-interaction timing</a><a href="#evidence">Evidence</a>' : ""}${copies ? '<a href="#copies">Report text</a>' : ""}${snapshot.nativeEvidence ? '<a href="#microsoft-evidence">Microsoft evidence</a>' : ""}<a href="#definitions">Coverage</a></nav>
        ${github ? `<section id="numbers">${value.nativePeriods ? "<h2>GitHub activity</h2>" : ""}${unequal}${overlapNote}<div class="comparison-visuals">${periodOutcomesHtml(value, display.labels)}${periodTimingHtml(value, snapshot)}</div></section>
        ${periodWholeTimingHtml(value, snapshot)}${periodEvidenceHtml(value, snapshot, display.labels)}` : '<p class="reading-note">No GitHub records match these periods. Microsoft timing and service targets are not inferred from message dates or tool names.</p>'}
        ${reportContextHtml(snapshot)}${copies}${snapshot.nativeEvidence ? microsoftEvidenceHtml(snapshot.nativeEvidence) : ""}${periodCoverageHtml(value, snapshot, display.labels, overlap)}
        <footer class="report-footer">WIRE - Frozen reviewed local copy. No history collection was performed for this report.</footer></main></body></html>`;
}

export function renderPeriodReportMarkdown(snapshot) {
    const value = validatePeriodReport(snapshot.periodComparison, snapshot.records), display = periodReportDisplay(value, snapshot);
    const resultEvidence = value.definitions.resultProjectionVersion === 1 ? [
        ...resultComparisonMarkdown(value.resultComparison),
        ...Object.values(value.periods).flatMap((side, index) => reportResultMarkdown(side.resultFacts, undefined,
            { title: `Period ${index ? "B" : "A"}: recorded tool results`, textSection: false, showBoundary: false })),
        ...resultTextMarkdown(snapshot.resultText, periodResultTextFacts(value)),
    ] : [];
    if (value.nativePeriods && Object.values(value.periods).every(side => !side.rows.length)) {
        return [`# ${escapeReportMarkdown(snapshot.title || display.title)}`, "", snapshot.preparedAtDisplay, "", display.dates, "",
            "## Microsoft activity", "", nativePeriodNotes(value), "", ...markdownTable(nativePeriodHeaders, nativePeriodRows(value), [1, 2, 3, 4]),
            "No GitHub records match these periods. Microsoft timing and service targets are not inferred from message dates or tool names.", "",
            ...(snapshot.nativeEvidence ? microsoftEvidenceMarkdown(snapshot.nativeEvidence) : []),
            ...resultEvidence, "## Scope and coverage", "", display.scope, "", nativePeriodNotes(value), "", PRODUCT_TITLE, ""].join("\n");
    }
    const outcomeKeys = Object.keys(display.labels).filter(key => value.periods.baseline.totals[key] || value.periods.later.totals[key]);
    const activityCell = (text, row, column) => column === 3 && row >= 2 && value.comparison.outcomes.change[outcomeKeys[row - 2]] === null
        ? reportTextCell(text) : escape(text);
    const timingCell = (text, row, column) => {
        const key = row ? "p95" : "median", item = value.comparison.matchingCallTiming[key];
        if (column === 1 || column === 2) {
            const presented = matchingTimingPresentation(column === 1 ? item.baseline : item.later, key, snapshot);
            return reportValueCell(presented.value, presented.numeric, presented.note);
        }
        return column === 3 && (!item.delta || key === "p95" && Math.min(item.baseline.coverage.count, item.later.coverage.count) < 2)
            ? reportTextCell(text) : escape(text);
    };
    const metricCell = (text, row, column) => {
        const item = value.comparison.metrics[row];
        if (column === 1 || column === 2) {
            const side = column === 1 ? "baseline" : "later", peer = column === 1 ? "later" : "baseline";
            const presented = factPresentation(item[side], item[peer], snapshot), detail = formatter.sideDefinitionLabel(item, side);
            return reportValueCell(presented.value, presented.numeric, [detail, presented.note].filter(Boolean).join(". "));
        }
        return column === 3 && !item.result?.delta ? reportTextCell(text) : escape(text);
    };
    const intro = value.definitions.metricProjectionVersion === 4 ? reportFieldsHtml([
        ...Object.values(value.periods).map((side, index) => [`Period ${index ? "B" : "A"}`, `${side.range.from} to ${side.range.to}`]),
        ["Timezone", value.timeContext.timeZone], ["Prepared", snapshot.preparedAtDisplay],
    ]) : `${display.dates}\n\nPrepared ${snapshot.preparedAtDisplay}.`;
    const lines = [snapshot.title ? `# ${escapeReportMarkdown(snapshot.title)}` : `# WIRE - ${display.title}`, "", intro, "",
        display.finding, "", ...resultEvidence, "## Activity", "", value.scope.population, "", "Matching records and full retained interactions; separate populations.", "", ...markdownTable(headers, display.rows, [1, 2, 3], activityCell)];
    if (value.nativePeriods) lines.push("## Microsoft activity", "", nativePeriodNotes(value), "",
        ...markdownTable(nativePeriodHeaders, nativePeriodRows(value), [1, 2, 3, 4]));
    lines.push(value.definitions.metricProjectionVersion === 4 ? "## Timing" : value.definitions.metricProjectionVersion === 3 ? "## Personal feedback and recorded timing" : "## Full-interaction checks and timing", "",
        ...(display.timing.length ? ["Matching tool latency: call start to recorded completion.", "", ...markdownTable(headers, display.timing, [1, 2, 3], timingCell)] : []),
        value.scope.findings, "", ...markdownTable(headers, display.metrics, [1, 2, 3], metricCell), sampleNoteFor(value), "",
        "## Exact matching evidence", "");
    for (const [index, side] of Object.values(value.periods).entries()) {
        const label = index ? "Period B" : "Period A";
        const separate = value.definitions.metricProjectionVersion === 4;
        lines.push(`### ${label}`, "", ...nativeFindingsMarkdown(nativeReportEvidence({ evaluationFacts: side.facts })).slice(3),
            ...markdownTable(["Tool", "Matching records"], tools(side).map(([tool, count]) => [tool, share(count, side.rows.length)]), [1]),
            ...markdownTable(["Record / interaction", ...(separate ? ["Tool", "Services"] : ["Tool / services"]), "Outcome", value.definitions.layer === "tool" ? "Tool latency" : "Recorded duration"],
                matchingRows(side, snapshot, display.labels, separate), [separate ? 4 : 3],
                (text, row, column) => column === (separate ? 4 : 3) && side.rows[row].durationMs === null ? reportTextCell(text) : escape(text)));
    }
    lines.push(...reportContextMarkdown(snapshot));
    if (snapshot.promptMode !== "none") {
        lines.push("## Report text", "", value.definitions.metricProjectionVersion === 4
            ? snapshot.promptMode === "masked" ? "Masked copies." : "Original wording."
            : "Supporting copies, not a third comparison population.", "");
        for (const [index, record] of snapshot.records.filter(record => record.recordKind !== "native-conversation").entries()) {
            lines.push(`<a id="${record.scenarioId}"></a>`, `### Interaction ${index + 1}`, "");
            for (const prompt of record.prompts) lines.push(...promptCopyMarkdown(prompt, snapshot));
        }
        if (snapshot.nativeEvidence) lines.push(...microsoftEvidenceMarkdown(snapshot.nativeEvidence));
    }
    lines.push("## Coverage and definitions", "", display.scope, "",
        ...Object.values(value.periods).flatMap((side, index) => [`### Period ${index ? "B" : "A"}`, "", ...sideNotes(side), ""]),
        `Within every service: ${value.selection.withinServices.join(", ") || "No additional refinement"}.`, "",
        ...[...display.notes.filter(note => note !== value.scope.population && note !== value.scope.authorPolicy), ...formatter.readingNotesFor(value)].flatMap(note => [note, ""]));
    return [...lines, PRODUCT_TITLE, ""].join("\n");
}
