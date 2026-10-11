import { buildAnalytics, OUTCOMES } from "./analytics.mjs";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { time } from "./time.mjs";
import { classifyWorkload } from "./graph-history.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { createDimensionalCharts } from "./dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { chatCopy } from "./chat-copy.mjs";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from "./branding.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { reportContextHtml, reportContextMarkdown } from "./report-context-output.mjs";
import {
    nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown, nativeTimingHtml, nativeTimingMarkdown,
    nativeQualityHtml, nativeQualityMarkdown, nativeReportStyles, nativeShare, nativeReportHeader,
} from "./native-report-output.mjs";

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
    if (options.snapshot?.records && JSON.stringify(records) !== JSON.stringify(options.snapshot.records)) {
        throw new TypeError("Report rendering requires the exact frozen record population.");
    }
    const representativeLimit = options.representativeLimit ?? 4;
    if (!Number.isSafeInteger(representativeLimit) || representativeLimit < 0 || representativeLimit > 12) throw new TypeError("representativeLimit must be an integer from 0 to 12.");
    const timeContext = options.snapshot?.timeContext ?? options.timeContext;
    // A prepared snapshot already owns full-interaction membership, independently of browsing filters.
    const filters = options.snapshot ? { scope: "all" } : { scope: "all", ...options.filters };
    const layers = ["tool", "reported-api", "http"].map((layer) => buildAnalytics(records, { layer, timeContext, groupBy: options.groupBy ?? "endpoint", limit: options.limit ?? 8, filters }));
    if (records.some((record) => record.graphActivities?.length)) {
        for (const layer of ["direct-request", "recorded-http", "code-reference"]) {
            layers.push(buildActivityAnalytics(records, { layer, timeContext, groupBy: "endpoint", limit: options.limit ?? 8, filters: { ...filters, includeMetadata: true } }));
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
    const tools = buildAnalytics(records, { layer: "tool", groupBy: "tool", filters }).groups;
    return { layers, tools, representatives, services, selectedRecordCount: records.length, selectedLegacyCount: records.filter((r) => r.isLegacy).length, privacyNote: privacySummary(options.privacy) };
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
    const { layers, tools, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const evidence = nativeReportEvidence(options.snapshot);
    const lines = [`# ${PRODUCT_NAME} - product report`, "", PRODUCT_DESCRIPTION, "", reportIntro(options.snapshot, selectedRecordCount), "",
        ...nativeFindingsMarkdown(evidence),
        '<a id="overview"></a>', "## Recorded numbers", "", `${selectedRecordCount} selected interaction records; ${layers[0].totals.count} Work IQ tool calls.`, "",
        ...summary.takeaways.slice(0, 3).map((s) => `- ${s}`), "",
        "| Evidence layer (separate units) | Count | Recorded result |", "|---|---:|---|",
        ...summary.metrics.map((m) => `| ${m.label} | ${m.count} | ${m.reading} |`), "",
        `Activity categories: ${summary.services.join(", ") || "none attributed"}.`, "",
        "Selected recorded evidence, not complete history. Source event times are withheld. Local export only; not permission to share.", "",
        `[Examples](#examples) · [Operation detail](#operations) · [Quality results](#quality) · [Prompt appendix](#prompts) · [Coverage](#coverage)${options.snapshot?.formats.includes("json") ? " · [Complete JSON records](product-report.json)" : ""}`, "",
        "### Tools", "", "| Tool | Calls / all calls | Share | Recorded outcomes |", "|---|---:|---:|---|",
        ...tools.map(group => `| ${escapeMarkdown(group.label)} | ${group.total} / ${layers[0].totals.count} | ${nativeShare(group.total, layers[0].totals.count)} | ${groupOutcomeText(group)} |`), "",
        ...servicesMarkdown(options.snapshot, layers[0].totals.count),
        "Historical activity bins were not saved. No dates or daily distribution are reconstructed from current data.", "",
        ...nativeTimingMarkdown(evidence),
        ...reportContextMarkdown(options.snapshot),
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
    lines.push(...nativeQualityMarkdown(options.snapshot, evidence),
        '<a id="prompts"></a>', "## Reviewed prompt copies", "", "Complete included wording is below, not generated summaries. Excerpts above are only navigation aids.", "");
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
    if (services.length) {
        lines.push("## Activity categories in this report", "");
        for (const entry of services) lines.push(`- **${escapeMarkdown(entry.label)}:** ${escapeMarkdown(entry.description)}`);
        if (options.snapshot?.categoryDefinition) lines.push("", `Category definition v${options.snapshot.categoryDefinition.version}: ${options.snapshot.categoryDefinition.description}`);
    }
    const involvement = options.snapshot?.evaluationFacts?.serviceInvolvement;
    if (involvement) lines.push("", "## Service definition and scope", "",
        ...[involvement.definition.description, involvement.definition.targetBasis, involvement.definition.purposeBasis, involvement.definition.compatibility].flatMap(note => [note, ""]));
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

function groupOutcomes(group) {
    return OUTCOMES.filter(outcome => group[outcome]).map(outcome => ({
        outcome, text: `${group[outcome]} ${outcomeLabel("tool", outcome)} (${nativeShare(group[outcome], group.total)})`,
    }));
}

function groupOutcomeText(group) {
    return groupOutcomes(group).map(item => item.text).join("; ");
}

function toolBreakdownHtml(groups, total) {
    return `<section><h3>Tools</h3><p class="reading-note">Bar lengths and shares use all ${total} selected calls. Outcome shares below each bar use that tool's calls.</p>
        ${groups.length ? `<ul class="native-bars">${groups.map(group => `<li><div class="native-bar-heading"><span>${escapeHtml(group.label)}</span><strong>${group.total} / ${total} (${nativeShare(group.total, total)})</strong></div>
            <span class="native-bar-track" aria-hidden="true">${OUTCOMES.filter(outcome => group[outcome]).map(outcome =>
                `<span class="native-bar dimensional-tone-${categoryCues.outcomeTones[outcome]}" data-count="${group[outcome]}" data-denominator="${total}" style="width:${categoryCues.geometryPolicy.span(group[outcome], total, 100)}%"></span>`).join("")}</span>
            <div class="native-bar-results">${groupOutcomes(group).map(item => `<span class="native-outcome dimensional-tone-${categoryCues.outcomeTones[item.outcome]}">${escapeHtml(item.text)}</span>`).join("")}</div></li>`).join("")}</ul>` : "<p>No Work IQ tool calls in this selection.</p>"}</section>`;
}

function serviceReading(snapshot, total) {
    const projection = snapshot?.evaluationFacts?.serviceInvolvement;
    if (!projection) return { projection: null, notes: ["Service involvement was not saved. Activity categories are a separate historical definition, not reconstructed service counts."] };
    return { projection, notes: [
        `Work IQ tool-call layer; ${projection.denominator} covered calls. Shares use these calls; service associations can overlap.`,
        `${projection.missingDetailRefs.length} calls have missing service details, including any partially attributed calls; ${projection.notApplicableRefs.length} preparation calls have no applicable data service.`,
        ...(projection.denominator !== total ? [`Service coverage is ${projection.denominator} of ${total} report calls. The remaining calls have no frozen association membership; shares describe only the explicitly covered calls.`] : []),
    ] };
}

function servicesHtml(snapshot, total) {
    const { projection, notes } = serviceReading(snapshot, total);
    if (!projection) return `<section><h3>Services</h3><p class="reading-note">${escapeHtml(notes[0])}</p></section>`;
    return `<section><h3>Services</h3><p class="reading-note">${escapeHtml(notes[0])}</p>
        ${projection?.groups.length ? `<ul class="native-bars">${projection.groups.map(group => `<li><div class="native-bar-heading"><span>${escapeHtml(serviceCategories.describe(group.service).label)}</span><strong>${group.count} / ${projection.denominator} (${nativeShare(group.count, projection.denominator)})</strong></div>
            <span class="native-bar-track" aria-hidden="true"><span class="native-bar dimensional-tone-${categoryCues.tone(group.service)}" data-count="${group.count}" data-denominator="${projection.denominator}" style="width:${categoryCues.geometryPolicy.span(group.count, projection.denominator, 100)}%"></span></span></li>`).join("")}</ul>`
            : "<p>No supported service associations in this tool-call population.</p>"}
        ${notes.slice(1).map(note => `<p class="reading-note">${escapeHtml(note)}</p>`).join("")}</section>`;
}

function serviceDefinitionHtml(snapshot) {
    const definition = snapshot?.evaluationFacts?.serviceInvolvement?.definition;
    return definition ? `<details class="reading-notes"><summary>Service definition and scope</summary>${[definition.description, definition.targetBasis, definition.purposeBasis, definition.compatibility].map(note => `<p>${escapeHtml(note)}</p>`).join("")}</details>` : "";
}

function servicesMarkdown(snapshot, total) {
    const { projection, notes } = serviceReading(snapshot, total);
    return ["### Services", "", ...notes.flatMap(note => [escapeMarkdown(note), ""]),
        ...(projection?.groups.length ? ["| Service | Associated calls / covered tool calls | Share |", "|---|---:|---:|",
            ...projection.groups.map(group => `| ${escapeMarkdown(serviceCategories.describe(group.service).label)} | ${group.count} / ${projection.denominator} | ${nativeShare(group.count, projection.denominator)} |`), ""]
            : projection ? ["No supported service associations in this tool-call population.", ""] : [])];
}

export function renderHtmlReport(sanitizedRecords, options = {}) {
    const { layers, tools, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const evidence = nativeReportEvidence(options.snapshot);
    return `<!doctype html>
<html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - product report</title>
<style>${nativeReportStyles}</style></head><body><main>${nativeReportHeader()}<p class="report-meta">${escapeHtml(reportIntro(options.snapshot, selectedRecordCount))}</p>
${nativeFindingsHtml(evidence)}
<section id="overview" aria-label="Report overview"><h2>Recorded numbers</h2><div class="native-counts"><p><strong>${selectedRecordCount}</strong> selected interaction records</p><p><strong>${layers[0].totals.count}</strong> Work IQ tool calls</p><p><strong>${layers[0].totals.failure} / ${layers[0].totals.count}</strong> calls failed (${nativeShare(layers[0].totals.failure, layers[0].totals.count)})</p></div>
<p class="reading-note">Counts use this report's full frozen interaction selection, not just matching chart calls. Evidence layers have separate units and are never added together.</p>
<table class="native-table"><caption>Evidence layers - separate units, never added together</caption><thead><tr><th scope="col">Evidence layer</th><th scope="col">Count</th><th scope="col">Recorded result</th></tr></thead><tbody>${summary.metrics.map(m => `<tr><th scope="row">${escapeHtml(m.label)}</th><td data-label="Count">${m.count}</td><td data-label="Recorded result">${escapeHtml(m.reading)}</td></tr>`).join("")}</tbody></table>
<p class="reading-note">Selected recorded evidence, not complete history. Source event times are withheld. Local export only; not permission to share.</p></section>
<nav class="report-nav" aria-label="Report sections"><a href="#overview">Numbers</a><a href="#timing">Timing</a>${options.snapshot?.recordedContext ? '<a href="#recorded-context">Recorded context</a>' : ""}<a href="#examples">Examples</a><a href="#operations">Operation detail</a><a href="#quality">Quality results</a><a href="#prompts">Prompt appendix</a><a href="#coverage">Coverage</a>${options.snapshot?.formats.includes("json") ? '<a class="json-records-link" href="product-report.json">Complete JSON records</a><span class="print-companion">Complete records: product-report.json (same folder)</span>' : ""}</nav>
<section id="breakdowns"><h2>Tools and services</h2><div class="native-breakdowns">${toolBreakdownHtml(tools, layers[0].totals.count)}${servicesHtml(options.snapshot, layers[0].totals.count)}</div>
<p class="reading-note">Historical activity bins were not saved. No dates or daily distribution are reconstructed from current data.</p></section>
${nativeTimingHtml(evidence)}
${reportContextHtml(options.snapshot)}
<section id="examples"><h2>Representative technical scenarios</h2><p>${escapeHtml(exampleReading(options.snapshot, representatives.length, selectedRecordCount))}</p>${representatives.length ? representatives.map(exampleHtml).join("") : "<p>No qualifying Work IQ scenarios.</p>"}</section>
<section id="operations"><h2>Operation detail</h2>${layers.filter(a => a.totals.count).map(a => `<section class="layer"><h3>${TITLES[a.layer]}</h3><p class="summary">${escapeHtml(compactSummary(a))}</p><div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(TITLES[a.layer])} exact data; scroll horizontally if needed">${htmlTable(a)}</div><div class="layer-notes">${layerNotes(a).map(n => `<p>${escapeHtml(n)}</p>`).join("")}</div></section>`).join("\n")}</section>
${nativeQualityHtml(options.snapshot, evidence)}
${promptHtml(sanitizedRecords, options.snapshot)}
${serviceDefinitionHtml(options.snapshot)}
${services.length ? `<section class="service-glossary"><h2>Activity categories in this report</h2><dl>${services.map(entry => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.description)}</dd></div>`).join("")}</dl>${options.snapshot?.categoryDefinition ? `<p>Category definition v${options.snapshot.categoryDefinition.version}: ${escapeHtml(options.snapshot.categoryDefinition.description)}</p>` : ""}</section>` : ""}
<details id="coverage" class="reading-notes"><summary>Coverage and reading notes</summary><p>Selected export inventory: ${selectedRecordCount} scenario records, including ${selectedLegacyCount} legacy records. Metric identities are deduplicated separately.</p><p>${escapeHtml(privacyNote)}</p>${options.snapshot ? snapshotLines(options.snapshot).map((line) => `<p>${escapeHtml(line.replaceAll("**", ""))}</p>`).join("") : ""}<ul>${coverageNotes(layers, Boolean(options.snapshot?.recordedContext)).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></details>
<p class="report-footer">${PRODUCT_NAME} · Frozen personal interaction report. Original evidence and separately saved reports remain unchanged.</p>
</main></body></html>`;
}
