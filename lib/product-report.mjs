import { buildAnalytics, OUTCOMES } from "./analytics.mjs";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { time } from "./time.mjs";
import { classifyWorkload } from "./graph-history.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "./dimensional-report.mjs";
import { createDimensionalCharts } from "./dimensional-charts.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "./branding.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { promptAuthorStyles } from "../web/prompt-author-styles.mjs";
import { evaluationSummaryHtml, evaluationSummaryMarkdown, reportBrandHeader, reportPresentationStyles, recordedToolScoreHtml } from "./report-presentation.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";

const TITLES = { tool: "Work IQ tool calls", "reported-api": "Tool-returned API results", http: "Owned Graph HTTP records", "direct-request": "Recorded Graph request sites", "recorded-http": "Graph request sites with visible status", "code-reference": "Graph code references (not executions)" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const escapeMarkdown = (value) => escapeHtml(value).replace(/[\\`*_[\]{}|]/g, "\\$&").replace(/\r?\n/g, " ");
const short = (value, max = 180) => value.length > max ? `${value.slice(0, max - 3)}...` : value;
const resultCues = createRecordedResults(), categoryCues = createDimensionalCharts();
const promptDisplayLabel = prompt => prompt.kind === "origin" ? promptAuthorship.label(prompt, { ownerVoice: false })
    : prompt.kind === "tool" ? `Recorded tool argument · ${prompt.label}` : `${prompt.label} / ${promptAuthorship.label(prompt, { ownerVoice: false })}`;
const categoryFor = (row, layer) => row.workload ?? (layer === "tool" ? serviceCategories.operation(row.tool)?.category : null)
    ?? classifyWorkload(row.endpoint, row.tool, row.targets ?? []);

function privacySummary(privacy) {
    if (!privacy) return "Original text is withheld. Disclosure review is required before writing; privacy findings and transformations remain in the manifest.";
    const counts = Object.values(privacy.categories ?? {});
    if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TypeError("Privacy summary requires nonnegative category counts.");
    const total = counts.reduce((a, b) => a + b, 0);
    return `Privacy scan: ${total} category matches across ${counts.filter((n) => n > 0).length} categories (not a count of unique secrets). ${privacy.promptMode ? "Prompt inclusion follows the selected mode below; detected credentials are always removed." : "Original prose is withheld and identifiers are pseudonymized."} Disclosure review: required before writing; attestation is recorded separately in the manifest. Scanning is not privacy certification.`;
}

function reportModel(records, options) {
    if (!Array.isArray(records) || records.some((r) => !(r?.projectionVersion === 3 && ["none", "masked", "original"].includes(r.promptMode) && Array.isArray(r.prompts)) && (r?.userPrompt?.exportRepresentation !== "technical-summary-not-original" || typeof r.userPrompt.text !== "string"))) {
        throw new TypeError("Report rendering requires records from the existing sanitized projection, not canonical/raw evidence.");
    }
    const representativeLimit = options.representativeLimit ?? 4;
    if (!Number.isSafeInteger(representativeLimit) || representativeLimit < 0 || representativeLimit > 12) throw new TypeError("representativeLimit must be an integer from 0 to 12.");
    const timeContext = options.snapshot?.timeContext ?? options.timeContext;
    const layers = ["tool", "reported-api", "http"].map((layer) => buildAnalytics(records, { layer, timeContext, groupBy: options.groupBy ?? "endpoint", limit: options.limit ?? 8, filters: { scope: "all", ...options.filters } }));
    if (records.some((record) => record.graphActivities?.length)) {
        for (const layer of ["direct-request", "recorded-http", "code-reference"]) {
            layers.push(buildActivityAnalytics(records, { layer, timeContext, groupBy: "endpoint", limit: options.limit ?? 8, filters: { scope: "all", includeMetadata: true, ...options.filters } }));
        }
    }
    const calls = layers[0].rows;
    const eligible = new Map(records.map((r) => [r.scenarioId, r]));
    const representatives = [];
    const seen = new Set();
    const groups = new Set();
    const priority = { failure: 0, unknown: 1, partial: 2, transport: 3, other: 4, success: 5 };
    const ranked = [...calls].sort((a, b) => priority[a.outcome] - priority[b.outcome] || a.id.localeCompare(b.id));
    for (const row of ranked) {
        if (representatives.length >= representativeLimit) break;
        if (seen.has(row.scenarioId) || groups.has(row.endpoint.id)) continue;
        const record = eligible.get(row.scenarioId);
        if (!record) continue;
        seen.add(row.scenarioId);
        groups.add(row.endpoint.id);
        representatives.push({
            scenarioId: row.scenarioId, tool: row.tool, endpoint: row.endpoint.label,
            outcome: row.outcome, focusId: row.id,
            prompt: record.prompts?.find((p) => p.kind === "origin")?.text ?? record.userPrompt?.text ?? null,
            promptLabel: promptAuthorship.label(record.prompts?.find(p => p.kind === "origin") ?? record.userPrompt, { ownerVoice: false }),
            actions: calls.filter((call) => call.scenarioId === row.scenarioId).sort((a, b) => {
                const position = (call) => {
                    const index = record.toolCalls.findIndex((c) => c.toolCallId === call.toolCallId);
                    return record.toolCalls[index]?.order ?? index + 1;
                };
                return position(a) - position(b);
            }),
        });
    }
    for (const example of representatives) {
        const start = Math.max(0, example.actions.findIndex((call) => call.id === example.focusId) - 3);
        example.hiddenBefore = start;
        example.hiddenAfter = Math.max(0, example.actions.length - start - 8);
        example.actions = example.actions.slice(start, start + 8);
    }
    const services = serviceCategories.used(layers.flatMap(layer => layer.rows.map(row => categoryFor(row, layer.layer))));
    return { layers, representatives, services, selectedRecordCount: records.length, selectedLegacyCount: records.filter((r) => r.isLegacy).length, privacyNote: privacySummary(options.privacy) };
}

export function reportServiceCategories(sanitizedRecords, options = {}) {
    return reportModel(sanitizedRecords, options).services;
}

const scopeLabel = (kind) => ({ all: "All collected activity", current: "Current view", selected: "Selected requests" })[kind] ?? "Selected evidence";
const outcomeLabel = (layer, outcome) => {
    if (layer === "tool") return ({ success: "succeeded", failure: "failed", unknown: "outcome unknown", partial: "partial", other: "other", transport: "transport failure" })[outcome];
    return ({ success: "2xx", failure: "reported failure", unknown: "status unknown", partial: "partial", other: "other status", transport: "no response" })[outcome];
};
const outcomeText = (a) => a.layer === "code-reference" ? "Not executions; no outcome assigned"
    : OUTCOMES.filter((o) => a.totals[o]).map((o) => `${a.totals[o]} ${outcomeLabel(a.layer, o)}`).join(" / ") || "No qualifying records";

export function reportSummary(records, options = {}) {
    const { layers, services } = reportModel(records, options);
    const tool = layers[0], api = layers[1];
    return {
        metrics: layers.map((a) => ({
            layer: a.layer, label: TITLES[a.layer], unit: a.unit, count: a.totals.count,
            outcomes: a.layer === "code-reference" ? null : Object.fromEntries(OUTCOMES.map((o) => [o, a.totals[o]])),
            reading: outcomeText(a),
        })),
        services: services.map((s) => s.label),
        takeaways: [
            ...(tool.totals.count ? [`${chatCopy.count(tool.coverage.sessionCount, true)} / ${chatCopy.relationship(tool.coverage.scenarioCount, tool.totals.count, resultCues.unit("tool", tool.totals.count))}. Counts use this report's frozen selection, not just matching chart calls.`] : []),
            ...(tool.totals.count ? [`${tool.totals.success} of ${tool.totals.count} Work IQ calls succeeded; ${tool.totals.failure} failed and ${tool.totals.unknown} have unknown outcomes${tool.totals.partial + tool.totals.other + tool.totals.transport ? `; ${tool.totals.partial + tool.totals.other + tool.totals.transport} have partial, other or transport outcomes` : ""}. This is tool execution, not task correctness.`] : ["No Work IQ calls in this selection. Read the other evidence layers separately."]),
            ...(api.apiCoverage.eligibleToolCalls ? [`Numeric API status is available for ${api.apiCoverage.callsWithNumericStatus} of ${api.apiCoverage.eligibleToolCalls} Work IQ calls; ${api.apiCoverage.callsWithoutNumericStatus} have no numeric API status. Missing status is not success.`] : []),
            tool.totals.failure ? "Start with the failed-call examples below, then inspect their recorded sequence. The evidence does not establish a root cause or a completed task." : "Use the recorded examples to see operation patterns. Successful calls alone do not establish whether the user's request was fulfilled.",
        ],
    };
}

function compactSummary(a) {
    const sources = a.layer === "http"
        ? `${a.coverage.sessionCount} recorder source identit${a.coverage.sessionCount === 1 ? "y" : "ies"}`
        : chatCopy.count(a.coverage.sessionCount, true);
    return `${sources} / ${chatCopy.relationship(a.coverage.scenarioCount, a.totals.count, resultCues.unit(a.layer, a.totals.count), a.layer === "http")}. ${outcomeText(a)}.`;
}

function shownGroups(a) { return [...a.visibleGroups, ...(a.otherGroup ? [a.otherGroup] : [])]; }

function evidenceLayerNotes(a) {
    if (a.layer === "reported-api") {
        const c = a.apiCoverage;
        return [
            `Numeric API status is available for ${c.callsWithNumericStatus} of ${c.eligibleToolCalls} eligible tool calls; ${c.callsWithoutNumericStatus} calls have no numeric API status.`,
            "These are returned intermediary result units, not all requested paths and not observed HTTP. Batch call outcomes are not copied to individual targets.",
        ];
    }
    if (a.layer === "http") return [`${a.httpCoverage.observedResponseCount} observed Graph responses; ${a.httpCoverage.noResponseRecordCount} recorder records without a response. Only explicit non-synthetic owned recorder records appear here. HTTP 2xx, including 202, does not prove business completion. Observed response durations end at response headers, not full body transfer.`];
    if (a.layer === "direct-request") return ["Recorded request sites are not measured wire executions. Dynamic targets, loops and retries are not reconstructed. Output-visible statuses are a subset, not additional requests."];
    if (a.layer === "recorded-http") return ["Status metadata was visible in recorded output, not captured by the owned HTTP recorder. A response does not establish task correctness."];
    if (a.layer === "code-reference") return ["Source reads, code references and tests are not evidence that a Graph request executed. Synthetic references are excluded."];
    return ["Each multi-target fetch is one tool call. Review state, assessed relevance and task correctness are not runtime outcomes."];
}

function layerNotes(a) {
    const reading = serviceCategories.explainRows(a.rows.map(row => ({ ...row, workload: categoryFor(row, a.layer) })), a.layer);
    return [...evidenceLayerNotes(a), ...(reading ? [reading] : [])];
}

function coverageNotes(layers, recordedContext = false) {
    const tool = layers[0];
    return [
        `Selected tool coverage: ${chatCopy.count(tool.coverage.sessionCount, true)}, ${tool.coverage.projectCount} Copilot project${tool.coverage.projectCount === 1 ? "" : "s"}, ${chatCopy.count(tool.coverage.unscopedSessionCount)} without a project, ${chatCopy.groups(tool.coverage.scenarioCount)}.`,
        chatCopy.requestMeaning,
        "Counts reflect supplied selected records, not a claim of complete history. Canonical identifiers and keyed export pseudonyms must not be mixed.",
        ...tool.warnings.filter((w) => ["unidentifiable-tool-records", "event-identity-fallback", "deduplicated-records", "dates-unavailable", "synthetic-excluded"].includes(w.code)).map((w) => `${w.count}: ${w.message}`),
        recordedContext
            ? "Source titles, notes, raw tool response bodies and non-prompt argument literals are withheld. Recorded context contains only permitted already-retained reply and prompt copies, not generated summaries."
            : "Source titles, notes, response bodies and non-prompt argument literals are withheld. Prompt sections, when selected, contain the reviewed report copies, not generated summaries.",
        "Privacy, source coverage, transformations and file hashes: coverage-and-redaction-manifest.json. Every selected format uses the same report snapshot.",
    ];
}

export function renderMarkdownReport(sanitizedRecords, options = {}) {
    const { layers, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const lines = [`# ${PRODUCT_NAME} - product report`, "", PRODUCT_DESCRIPTION, "", reportIntro(options.snapshot, selectedRecordCount), "",
        ...evaluationSummaryMarkdown(options.snapshot?.evaluationFacts),
        '<a id="overview"></a>', "## At a glance", "", ...summary.takeaways.map((s) => `- ${s}`), "",
        "| Evidence layer (separate units) | Count | Recorded result |", "|---|---:|---|",
        ...summary.metrics.map((m) => `| ${m.label} | ${m.count} | ${m.reading} |`), "",
        `${layers[0].totals.count ? "Activity categories" : "Services"}: ${summary.services.join(", ") || "none attributed"}.`, "",
        "Selected recorded evidence, not complete history. Source event times are withheld. Local export only; not permission to share.", "",
        `[Examples](#examples) · [Operation detail](#operations) · [Prompt appendix](#prompts) · [Coverage](#coverage)${options.snapshot?.formats.includes("json") ? " · [Complete JSON records](product-report.json)" : ""}`, "",
        '<a id="examples"></a>', "## Representative technical scenarios", "", exampleReading(options.snapshot, representatives.length, selectedRecordCount), ""];
    if (!representatives.length) lines.push("No qualifying Work IQ scenarios.");
    for (const r of representatives) lines.push(
        `### ${escapeMarkdown(r.tool)} - ${escapeMarkdown(r.outcome)}`, "",
        ...(r.prompt === null ? ["Originating prompt omitted or unavailable.", ""] : [`Reviewed ${r.promptLabel.toLowerCase()} excerpt: ${escapeMarkdown(short(r.prompt))}`, ""]),
        ...r.actions.map((a, i) => `${i + r.hiddenBefore + 1}. ${escapeMarkdown(a.tool)}: ${escapeMarkdown(a.endpoint.label)} - ${outcomeLabel("tool", a.outcome)}.`),
        ...(r.hiddenBefore || r.hiddenAfter ? [`${r.hiddenBefore} earlier and ${r.hiddenAfter} later calls are outside this bounded example; see complete projected records.`] : []),
        `Request reference: ${escapeMarkdown(r.scenarioId)}. [Prompt copies](#${r.scenarioId})`, "",
    );
    lines.push('<a id="operations"></a>', "## Operation detail", "");
    if (!layers.some((a) => a.totals.count)) lines.push("No qualifying records in this layer.", "");
    for (const a of layers.filter((a) => a.totals.count)) {
        const columns = resultColumns(a);
        lines.push(`### ${TITLES[a.layer]}`, "", `**${compactSummary(a)}**`, "",
            `| Endpoint / operation | Count |${columns.map((o) => ` ${outcomeLabel(a.layer, o)} |`).join("")}`,
            `|---|---:|${columns.map(() => "---:|").join("")}`);
        for (const g of shownGroups(a)) lines.push(`| ${escapeMarkdown(g.label)} | ${g.total} |${columns.map((o) => ` ${g[o]} |`).join("")}`);
        lines.push("", ...layerNotes(a), "");
    }
    lines.push('<a id="prompts"></a>', "## Reviewed prompt copies", "", "Complete included wording is below, not generated summaries. Excerpts above are only navigation aids.", "");
    if (sanitizedRecords.some((r) => r.projectionVersion === 3)) {
        if (options.snapshot?.promptMode === "none") lines.push("No prompt text is included in this report.", "");
        for (const record of sanitizedRecords) {
            lines.push(`<a id="${escapeHtml(record.scenarioId)}"></a>`);
            if (options.snapshot?.promptMode === "none") continue;
            lines.push(`### ${escapeMarkdown(record.scenarioId)}`, "");
            for (const prompt of record.prompts) {
                if (prompt.text === null) lines.push(`- ${escapeMarkdown(promptDisplayLabel(prompt))}: ${prompt.omitted ? "Omitted from report." : "Source text unavailable; not reconstructed."}${prompt.availabilityNote ? ` ${prompt.availabilityNote}` : ""}`, "");
                else {
                    lines.push(`**${escapeMarkdown(promptDisplayLabel(prompt))}** (${escapeMarkdown(prompt.status)}; ${escapeMarkdown(prompt.representation)})`, "");
                    if (prompt.kind !== "tool" && promptAuthorship.read(prompt).actor === "unknown") lines.push(`Author not verified. ${promptAuthorship.reason(prompt)}`, "");
                    if (prompt.status === "partial") lines.push("Only part of the original was recorded. Missing text is not reconstructed.", "");
                    lines.push(...prompt.text.split("\n").map((line) => "    " + line), "");
                    const mandatory = prompt.changes.filter((c) => c.mandatory).length;
                    if (mandatory) lines.push(`${mandatory} mandatory credential removal(s). This is not a byte-identical original.`, "");
                }
            }
        }
    }
    lines.push(...reportContextMarkdown(options.snapshot));
    if (services.length) {
        lines.push(`## ${layers[0].totals.count ? "Activity categories" : "Services"} in this report`, "");
        for (const entry of services) lines.push(`- **${escapeMarkdown(entry.label)}:** ${escapeMarkdown(entry.description)}`);
        if (options.snapshot?.categoryDefinition) lines.push("", `Category definition v${options.snapshot.categoryDefinition.version}: ${options.snapshot.categoryDefinition.description}`);
    }
    lines.push("", '<a id="coverage"></a>', "## Coverage and reading notes", "",
        `Selected export inventory: ${selectedRecordCount} scenario records, including ${selectedLegacyCount} legacy records. Metric identities are deduplicated separately.`, "",
        privacyNote, "", ...(options.snapshot ? snapshotLines(options.snapshot) : []), "",
        ...coverageNotes(layers, Boolean(options.snapshot?.recordedContext)).map((n) => `- ${escapeMarkdown(n)}`), "");
    return lines.join("\n");
}

const modeLabel = (mode) => ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[mode];
function reportIntro(snapshot, count) {
    if (!snapshot) return `${count} selected evidence records. Evidence layers use separate units, never added together.`;
    return `${scopeLabel(snapshot.selectionScope?.kind)}${snapshot.selectionScope?.promptAuthors ? ` · ${promptAuthorship.selectionLabel(snapshot.selectionScope.promptAuthors, { ownerVoice: false })}` : ""} · ${chatCopy.groups(snapshot.selectionScope?.requestGroups ?? count)} · ${modeLabel(snapshot.promptMode)}\nPrepared ${snapshot.preparedAtDisplay} · ${time.label(snapshot.timeContext)}`;
}
function exampleReading(snapshot, count, total) {
    return `${count} representative request examples from ${total} selected records, prioritizing failed and unknown calls. Examples are not additional counts; prompt association is inferred, not proof of intent. ${snapshot?.formats.includes("json") ? "Complete projected records: product-report.json." : "This readable report is not the full record payload. Select JSON when exporting to include complete projected records."}`;
}
function resultColumns(a) { return a.layer === "code-reference" ? [] : OUTCOMES.filter((o) => a.totals[o]); }
function exampleHtml(r) {
    return `<article class="example"><h3>${escapeHtml(r.tool)} - ${escapeHtml(r.outcome)}</h3>${r.prompt === null ? "<p>Originating prompt omitted or unavailable.</p>" : `<p><strong>Reviewed ${escapeHtml(r.promptLabel.toLowerCase())} excerpt:</strong> ${escapeHtml(short(r.prompt))}</p>`}<ol start="${r.hiddenBefore + 1}">${r.actions.map((a) => `<li>${escapeHtml(a.tool)}: ${escapeHtml(a.endpoint.label)} - ${outcomeLabel("tool", a.outcome)}.</li>`).join("")}</ol>${r.hiddenBefore || r.hiddenAfter ? `<p>${r.hiddenBefore} earlier and ${r.hiddenAfter} later calls are outside this bounded example; see complete projected records.</p>` : ""}<a class="ref" href="#${escapeHtml(r.scenarioId)}">Prompt copies · ${escapeHtml(r.scenarioId)}</a></article>`;
}
function snapshotLines(snapshot) {
    const context = time.normalize(snapshot.timeContext);
    const dates = snapshot.dateSelection;
    const boundary = (value) => value?.includes("T") ? time.formatTime(value, context) : time.formatDate(value, context, true);
    return [
        `Prompt mode: **${modeLabel(snapshot.promptMode)}**. Selected formats: ${snapshot.formats.join(", ")}.`,
        ...(snapshot.selectionScope ? [
            `Report scope: ${{ all: "All collected activity", current: "Current view", selected: "Selected requests" }[snapshot.selectionScope.kind]}. ${snapshot.selectionScope.requestGroups} canonical request groups. Complete eligible evidence for those requests, not only the displayed chart actions.`,
            ...(snapshot.selectionScope.promptAuthors ? [`Originating prompt authors: ${promptAuthorship.selectionLabel(snapshot.selectionScope.promptAuthors, { ownerVoice: false })}. ${snapshot.selectionScope.requestGroups} of ${snapshot.selectionScope.baseRequestGroups} request groups in the base scope included; ${snapshot.selectionScope.authorExcludedRequestGroups} excluded by author choice, including their calls and scores. Author is not tool executor or action authorization.`] : []),
            `Scope counts: ${snapshot.selectionScope.workIqActions} Work IQ tool calls; ${snapshot.selectionScope.returnedApiResults} tool-returned API results; ${snapshot.selectionScope.graphRequestSites} recorded Graph request sites (${snapshot.selectionScope.graphVisibleStatuses} with visible status); ${snapshot.selectionScope.ownedHttpRecords} owned HTTP records; ${snapshot.selectionScope.graphCodeReferences} Graph code references. Separate units, never summed.`,
            `Collection exclusions: ${snapshot.selectionScope.exclusions.excludedOrDuplicateEvidenceRecords} evidence records excluded or deduplicated, including ${snapshot.selectionScope.exclusions.duplicateEvidenceRecords} known duplicate records. ${snapshot.selectionScope.exclusions.syntheticRequestGroups} synthetic groups, ${snapshot.selectionScope.exclusions.diagnosticRequestGroups} diagnostic groups, ${snapshot.selectionScope.exclusions.unknownSourceRequestGroups} unknown-source groups. Exclusion categories overlap. ${snapshot.selectionScope.excludedRequestedGroups} requested groups had no eligible evidence. No new chats or hidden calls were discovered.`,
            "Original evidence and user review labels are unchanged by this export. Completed reports have separate history entries; previous files are never overwritten.",
        ] : []),
        `Snapshot: ${snapshot.bundleId}. Prepared: ${snapshot.preparedAtDisplay ?? time.formatTime(snapshot.preparedAt, context)}.`,
        `Report timezone: ${time.label(context)}. Locale: ${context.locale}${context.localeFallback ? " (fallback)" : ""}. Frozen for every format; not reinterpreted when shared.`,
        dates && dates.range !== "capture" ? `View date selection: ${boundary(dates.from)} to ${boundary(dates.to)}. Date-only bounds include full local days; timestamp bounds retain exact instants. Requests are explicitly selected and can include records outside this view.` : "View date selection: recorded period. Requests are explicitly selected.",
        "Source event timestamps remain withheld by the report privacy projection. Timestamps inside included prompt text are original wording, not converted display times.",
        `Prompt coverage: ${snapshot.promptCoverage.included} included, ${snapshot.promptCoverage.omitted} omitted, ${snapshot.promptCoverage.partial} partial, ${snapshot.promptCoverage.unavailable} unavailable; ${snapshot.promptCoverage.mandatoryRemovals} mandatory credential removals.`,
        "Local export only, not permission to publish or upload. Unlabelled names and confidential meaning need human review.",
    ];
}

function promptHtml(records, snapshot) {
    if (!records.some((r) => r.projectionVersion === 3)) return '<section id="prompts"><h2>Reviewed prompt copies</h2><p>No reviewed prompt copies are available in this projection.</p></section>';
    if (snapshot?.promptMode === "none") return `<section id="prompts"><h2>Reviewed prompt copies</h2><p>No prompt text is included in this report.</p>${records.map((r) => `<span id="${escapeHtml(r.scenarioId)}"></span>`).join("")}</section>`;
    return `<section id="prompts"><h2>Reviewed prompt copies</h2><p>Expand a request for complete included wording, not generated summaries. The PDF expands every copy; long prompts can add pages.</p>${records.map((r, i) => `<details class="prompt-record" id="${escapeHtml(r.scenarioId)}"><summary>Request ${i + 1} · ${r.prompts.filter((p) => p.text !== null).length} included copies <span class="ref">${escapeHtml(r.scenarioId)}</span></summary>${r.prompts.map((p) =>
        p.text === null ? `<p class="prompt-empty">${escapeHtml(promptDisplayLabel(p))}: ${p.omitted ? "Omitted from report." : "Source text unavailable; not reconstructed."} ${escapeHtml(p.availabilityNote ?? "")}</p>`
            : `<article class="prompt"><h4${p.kind !== "tool" && promptAuthorship.read(p).actor !== "unknown" ? ` data-prompt-actor="${promptAuthorship.read(p).actor}"` : ""}>${escapeHtml(promptDisplayLabel(p))}</h4><p>${escapeHtml(p.status)} source / ${escapeHtml(p.representation)}</p>${p.kind !== "tool" && promptAuthorship.read(p).actor === "unknown" ? `<p>Author not verified. ${escapeHtml(promptAuthorship.reason(p))}</p>` : ""}${p.status === "partial" ? "<p>Only part of the original was recorded. Missing text is not reconstructed.</p>" : ""}<pre>${escapeHtml(p.text)}</pre>${p.changes.some((c) => c.mandatory) ? `<p class="removal">Mandatory credential removal. This is not a byte-identical original.</p>` : ""}</article>`
    ).join("")}</details>`).join("")}</section>`;
}

function htmlTable(a) {
    const columns = resultColumns(a);
    return `<table><caption>Exact ${escapeHtml(a.unit)} by ${escapeHtml(a.groupBy)}</caption><thead><tr><th scope="col">Endpoint / operation</th><th scope="col">Count</th>${columns.map((o) => `<th scope="col">${outcomeLabel(a.layer, o)}</th>`).join("")}</tr></thead><tbody>${shownGroups(a).map((g) => `<tr><th scope="row">${escapeHtml(g.label)}</th><td>${g.total}</td>${columns.map((o) => `<td>${g[o]}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function renderHtmlReport(sanitizedRecords, options = {}) {
    const { layers, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const chart = createDimensionalReportChart();
    return `<!doctype html>
<html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - product report</title>
<style>
.report-brand{display:flex;align-items:center;gap:12px;margin-bottom:16px;break-inside:avoid}.report-brand .brand-logo{display:block;flex:none;width:72px;height:72px}.report-brand h1,.report-brand p{margin:0}.report-brand p{font-size:.9rem}
:root{font-family:system-ui,sans-serif;color:#172333;background:#f8f9fb}*{box-sizing:border-box}body{max-width:1100px;margin:0 auto;padding:28px}h1{font-size:1.8rem}h2{font-size:1.25rem;margin-top:2rem}p,li{line-height:1.55;overflow-wrap:anywhere}.summary{font-weight:650}.legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.9rem}.swatch{display:inline-block;width:.8rem;height:.8rem;margin-right:.3rem}.chart{margin:1.5rem 0}.chart-row{display:grid;grid-template-columns:minmax(140px,38%) minmax(0,1fr) 3rem;gap:.7rem;align-items:center;margin:.65rem 0}.chart-label{font-size:.85rem;overflow-wrap:anywhere}.track{height:1.3rem;display:flex;border-left:1px solid #6c7583}.segment{display:block;min-width:0}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:.85rem}caption{text-align:left;font-weight:600;margin:.7rem 0}th,td{padding:.45rem;border-bottom:1px solid #c9cfd8;text-align:right;overflow-wrap:anywhere}th:first-child{text-align:left;width:32%}thead{background:#edf0f4}details{border-top:1px solid #c9cfd8;padding-top:1rem;margin-top:2rem}summary{cursor:pointer;font-weight:600}.table-wrap{overflow-x:auto}.example{border-left:3px solid #6c7583;padding-left:1rem;margin:1rem 0}.ref{font-size:.8rem;overflow-wrap:anywhere}.prompt pre{font:14px/1.65 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;border-left:3px solid #6c7583;padding:12px;margin:12px 0;max-width:100%}.prompt h4{margin-bottom:0}.removal{font-weight:600}@media(max-width:600px){body{padding:16px}.chart-row{grid-template-columns:minmax(100px,44%) minmax(0,1fr) 2rem}.chart-label{font-size:.75rem}table{font-size:.7rem}th,td{padding:.3rem}}@page{size:A4;margin:16mm}@media print{html,body{background:white;padding:0;max-width:none;font-size:10pt}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}.prompt pre{font-size:10pt;overflow:visible;max-height:none}.table-wrap{overflow:visible}thead{display:table-header-group}tr,.chart-row{break-inside:avoid}h2,h3,h4{break-after:avoid}p,pre{orphans:3;widows:3}details{display:block}details>*{display:block}}
:root{font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}.prompt pre{font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}.table-wrap:focus-visible{outline:2px solid #255ea8;outline-offset:3px}
@media screen{.prompt pre{font-size:16px;line-height:1.7}table{min-width:640px}.chart-label,table{font-size:.8125rem}}@media print{:root{background:white}table{min-width:0;width:100%}}
.service-glossary{font-size:.875rem}.service-glossary dl{margin:0}.service-glossary dl>div{margin:.5rem 0;break-inside:avoid}.service-glossary dt{font-weight:600}.service-glossary dd{margin:0;line-height:1.55;overflow-wrap:anywhere}
${dimensionalReportStyles}
body{max-width:1060px}h1{margin-bottom:.4rem}h2{margin-top:1.5rem}
a{color:#175da1;text-decoration:none}a:is(:hover,:active){color:#172333}a:focus-visible{outline:2px solid #255ea8;outline-offset:3px}
.report-meta{white-space:pre-line;color:#42556a;margin-top:0}.report-nav{display:flex;gap:1rem;flex-wrap:wrap;padding:1rem 0;border-bottom:1px solid #c9cfd8}.report-nav a{padding:.3rem 0}.overview{background:#edf3f9;border-radius:12px;padding:18px 22px;margin:1.2rem 0}.overview h2{margin-top:0}.overview ul{padding-left:1.2rem}.overview table{min-width:0;font-size:.875rem;table-layout:auto}.overview th:first-child{width:38%}.overview th:last-child,.overview td:last-child{text-align:left}.overview td:nth-child(2){font-weight:700}.overview .reading-note{font-size:.875rem}.example h3{margin-bottom:.4rem}.example ol{padding-left:1.4rem;font-size:.875rem}.example .ref{display:block}.example{break-inside:avoid}.prompt-record{margin:.7rem 0;padding:.8rem 0}.prompt-record .ref{display:block;font-weight:400}.prompt-empty{font-size:.875rem}.reading-notes{font-size:.875rem}.reading-notes p{margin:.65rem 0}.service-glossary dl{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}.layer{margin-top:1.3rem}.layer h3{margin-bottom:.4rem}.layer-notes{font-size:.875rem}.layer .legend{margin:.7rem 0}
@media(max-width:600px){.overview{padding:14px}.overview table{font-size:.875rem}.overview th,.overview td{padding:.35rem .2rem}.service-glossary dl{grid-template-columns:1fr}}
.print-companion{display:none}@media print{.json-records-link{display:none}.print-companion{display:inline}}
@media print{body{font-size:10pt}.report-nav{padding:.4rem 0}.overview{padding:12px 16px;break-inside:avoid}.overview table,.overview .reading-note,.example ol,.layer-notes,.reading-notes,.service-glossary,.prompt-empty{font-size:10pt}.example{break-inside:auto}.example h3,.prompt-record summary{break-after:avoid}.prompt-record{border-top:1px solid #c9cfd8}.reading-notes{break-before:auto}.dimensional-report{margin:16px 0}.layer p{margin:.6rem 0}}
${reportPresentationStyles}
${promptAuthorStyles}
</style></head><body><main>${reportBrandHeader("Personal interaction report")}<section id="overview" aria-label="Report overview"><p class="report-meta">${escapeHtml(reportIntro(options.snapshot, selectedRecordCount))}</p>
${recordedToolScoreHtml(summary)}
${evaluationSummaryHtml(options.snapshot?.evaluationFacts)}
<div class="overview"><h2>At a glance</h2><ul>${summary.takeaways.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
<table><caption>Evidence layers - separate units, never added together</caption><thead><tr><th scope="col">Evidence layer</th><th scope="col">Count</th><th scope="col">Recorded result</th></tr></thead><tbody>${summary.metrics.map((m) => `<tr><th scope="row">${escapeHtml(m.label)}</th><td>${m.count}</td><td>${escapeHtml(m.reading)}</td></tr>`).join("")}</tbody></table>
<p><strong>${layers[0].totals.count ? "Activity categories" : "Services"}:</strong> ${escapeHtml(summary.services.join(", ") || "none attributed")}.</p><p class="reading-note">Selected recorded evidence, not complete history. Source event times are withheld. Local export only; not permission to share.</p></div></section>
<nav class="report-nav" aria-label="Report sections"><a href="#examples">Examples</a><a href="#operations">Operation detail</a><a href="#prompts">Prompt appendix</a><a href="#coverage">Coverage</a>${options.snapshot?.formats.includes("json") ? '<a class="json-records-link" href="product-report.json">Complete JSON records</a><span class="print-companion">Complete records: product-report.json (same folder)</span>' : ""}</nav>
<section id="examples"><h2>Representative technical scenarios</h2><p>${escapeHtml(exampleReading(options.snapshot, representatives.length, selectedRecordCount))}</p>${representatives.length ? representatives.map(exampleHtml).join("") : "<p>No qualifying Work IQ scenarios.</p>"}</section>
<section id="operations"><h2>Operation detail</h2>${layers.filter((a) => a.totals.count).map((a, i) => `<section class="layer"><h3>${TITLES[a.layer]}</h3><p class="summary">${escapeHtml(compactSummary(a))}</p>${i === 0 ? `<div class="legend">${resultColumns(a).map((o) => `<span class="semantic-cue result-tone-${o}" data-outcome="${o}">${uxIcons[resultCues.icon(o)]}<span>${outcomeLabel(a.layer, o)}</span></span>`).join("")}</div>${chart(a)}` : ""}<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(TITLES[a.layer])} exact data; scroll horizontally if needed">${htmlTable(a)}</div><div class="layer-notes">${layerNotes(a).map((n) => `<p>${escapeHtml(n)}</p>`).join("")}${a.totals.duration.sampleCount ? `<p>Duration: p50 ${a.totals.duration.p50Ms} ms / p95 ${a.totals.duration.p95Ms} ms (n=${a.totals.duration.sampleCount}; nearest rank; available durations only).</p>` : ""}</div></section>`).join("\n")}</section>
${promptHtml(sanitizedRecords, options.snapshot)}
${reportContextHtml(options.snapshot)}
${services.length ? `<section class="service-glossary"><h2>${layers[0].totals.count ? "Activity categories" : "Services"} in this report</h2><dl>${services.map((entry) => `<div><dt class="semantic-cue service-cue dimensional-tone-${categoryCues.tone(entry.id)}" data-service="${escapeHtml(entry.id)}">${dimensionalIcons[entry.id]}<span>${escapeHtml(entry.label)}</span></dt><dd>${escapeHtml(entry.description)}</dd></div>`).join("")}</dl>${options.snapshot?.categoryDefinition ? `<p>Category definition v${options.snapshot.categoryDefinition.version}: ${escapeHtml(options.snapshot.categoryDefinition.description)}</p>` : ""}</section>` : ""}
<details id="coverage" class="reading-notes"><summary>Coverage and reading notes</summary><p>Selected export inventory: ${selectedRecordCount} scenario records, including ${selectedLegacyCount} legacy records. Metric identities are deduplicated separately.</p><p>${escapeHtml(privacyNote)}</p>${options.snapshot ? snapshotLines(options.snapshot).map((line) => `<p>${escapeHtml(line.replaceAll("**", ""))}</p>`).join("") : ""}<ul>${coverageNotes(layers, Boolean(options.snapshot?.recordedContext)).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></details>
<p class="report-footer">${PRODUCT_NAME} · Frozen personal interaction report. Original evidence and separately saved reports remain unchanged.</p>
</main></body></html>`;
}
