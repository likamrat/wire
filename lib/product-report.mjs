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
    return "Detected credentials are removed. Check names and confidential meaning; masking is not a privacy guarantee or permission to publish or upload.";
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
            promptCopy: record.prompts?.find(p => p.kind === "origin"),
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

const scopeLabel = (kind) => ({ all: "All saved activity", current: "Current Analyze view", selected: "Selected interactions" })[kind] ?? "Selected evidence";
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
    return `${sources} / ${chatCopy.relationship(a.coverage.scenarioCount, a.totals.count, resultCues.unit(a.layer, a.totals.count), a.layer === "http")}.`;
}

function shownGroups(a) { return [...a.visibleGroups, ...(a.otherGroup ? [a.otherGroup] : [])]; }

function evidenceLayerNotes(a) {
    if (a.layer === "reported-api") {
        const c = a.apiCoverage;
        return [
            `Numeric API status is available for ${c.callsWithNumericStatus} of ${c.eligibleToolCalls} eligible ${resultCues.unit("tool", c.eligibleToolCalls)}; ${c.callsWithoutNumericStatus} ${resultCues.columnUnit("tool", c.callsWithoutNumericStatus)} ${c.callsWithoutNumericStatus === 1 ? "has" : "have"} no numeric API status. Missing status is not success.`,
            "These are returned intermediary result units, not all requested paths and not observed HTTP. Batch call outcomes are not copied to individual targets.",
        ];
    }
    if (a.layer === "http") return [`${a.httpCoverage.observedResponseCount} observed Graph responses; ${a.httpCoverage.noResponseRecordCount} recorder records without a response. Only explicit non-synthetic owned recorder records appear here. HTTP 2xx, including 202, does not prove business completion. Observed response durations end at response headers, not full body transfer.`];
    if (a.layer === "direct-request") return ["Recorded request sites are not measured wire executions. Dynamic targets, loops and retries are not reconstructed. Output-visible statuses are a subset, not additional requests."];
    if (a.layer === "recorded-http") return ["Status metadata was visible in recorded output, not captured by the owned HTTP recorder. A response does not establish task correctness."];
    if (a.layer === "code-reference") return ["Source reads, code references and tests are not evidence that a Graph request executed. Synthetic references are excluded."];
    return ["Each multi-target fetch is one tool call."];
}

function layerNotes(a) {
    const reading = serviceCategories.explainRows(a.rows.map(row => ({ ...row, workload: categoryFor(row, a.layer) })), a.layer);
    return [...evidenceLayerNotes(a), ...(reading ? [reading] : [])];
}

function coverageNotes(layers, recordedContext = false) {
    const tool = layers[0];
    return [
        `Tool coverage: ${tool.coverage.sessionCount} chats, ${tool.coverage.projectCount} Copilot project${tool.coverage.projectCount === 1 ? "" : "s"}${tool.coverage.unscopedSessionCount ? `; ${tool.coverage.unscopedSessionCount} chats without a project` : ""}.`,
        "Scope covers full eligible interactions (a prompt and its calls), not whole chats or only matching chart calls.",
        ...tool.warnings.filter((w) => ["unidentifiable-tool-records", "event-identity-fallback", "deduplicated-records", "dates-unavailable", "synthetic-excluded"].includes(w.code)).map((w) => `${w.count}: ${w.message}`),
        recordedContext
            ? "Linked context contains permitted, already-retained prompt and reply copies. Raw tool responses and unrelated argument values are withheld."
            : "Reviewed copies are retained wording, not generated summaries. Source titles, response bodies and unrelated argument values are withheld.",
        "Historical activity bins were not saved; no day-by-day trend is inferred.",
        "Full definitions, transformations and file hashes: coverage-and-redaction-manifest.json.",
    ];
}

function readingContext(records, layers, tools, snapshot) {
    const knownChats = records.every(record => typeof record.sourceSessionId === "string" && record.sourceSessionId.trim());
    const chats = knownChats ? new Set(records.map(record => record.sourceSessionId)).size : null;
    const tool = layers[0], patterns = [];
    const leadingTool = [...tools].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))[0];
    if (leadingTool) patterns.push(`${leadingTool.label} accounts for ${leadingTool.total} of ${tool.totals.count} recorded Work IQ ${tool.totals.count === 1 ? "call" : "calls"}.`);
    const involvement = snapshot?.evaluationFacts?.serviceInvolvement;
    if (involvement?.groups.length) {
        const leading = [...involvement.groups].sort((a, b) => b.count - a.count || a.service.localeCompare(b.service)).slice(0, 3);
        patterns.push(`Services and operations: ${leading.map(group => `${serviceCategories.describe(group.service).label} (${group.count})`).join(", ")} across ${involvement.denominator} covered ${involvement.denominator === 1 ? "call" : "calls"}.`);
    }
    const failures = new Set(tool.rows.filter(row => row.outcome === "failure").map(row => row.scenarioId)).size;
    if (failures) patterns.push(`Failed Work IQ calls appear in ${failures} of ${records.length} selected ${records.length === 1 ? "interaction" : "interactions"}.`);
    return {
        lead: `${records.length} saved ${records.length === 1 ? "interaction" : "interactions"}${chats === null ? ". Chat count was not retained" : ` across ${chats} ${chats === 1 ? "chat" : "chats"}`}.`,
        patterns,
    };
}
const remainingCopies = (record, inlineCopies) => record.prompts?.filter(prompt => !inlineCopies.has(record.scenarioId) || prompt.kind !== "origin") ?? [];

export function renderMarkdownReport(sanitizedRecords, options = {}) {
    const { layers, tools, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const evidence = nativeReportEvidence(options.snapshot);
    const inlineCopies = new Set(representatives.filter(inlineExamplePrompt).map(example => example.scenarioId));
    const hasAppendix = sanitizedRecords.some(record => remainingCopies(record, inlineCopies).length);
    const numbers = [
        '<a id="overview"></a>',
        "| Evidence layer (separate units) | Count | Recorded result |", "|---|---:|---|",
        ...summary.metrics.map(m => `| ${m.label} | ${m.count} | ${m.reading} |`), "",
        ...(!layers[1].totals.count && layers[1].apiCoverage.eligibleToolCalls ? [evidenceLayerNotes(layers[1])[0], ""] : []),
    ];
    const lines = [`# ${PRODUCT_NAME} - activity report`, "", PRODUCT_DESCRIPTION, "", reportIntro(options.snapshot, selectedRecordCount), "",
        ...nativeFindingsMarkdown(evidence, readingContext(sanitizedRecords, layers, tools, options.snapshot)),
        `[Examples](#examples) · [Operation detail](#operations) · [Quality results](#quality) · [Prompt copies](#${hasAppendix ? "prompts" : "examples"}) · [Coverage](#coverage)${options.snapshot?.formats.includes("json") ? " · [Complete JSON records](product-report.json)" : ""}`, "",
        "### Tools", "", "| Tool | Calls / all calls | Share | Recorded outcomes |", "|---|---:|---:|---|",
        ...tools.map(group => `| ${escapeMarkdown(group.label)} | ${group.total} / ${layers[0].totals.count} | ${nativeShare(group.total, layers[0].totals.count)} | ${groupOutcomeText(group)} |`), "",
        ...servicesMarkdown(options.snapshot, layers[0].totals.count),
        ...nativeTimingMarkdown(evidence),
        ...reportContextMarkdown(options.snapshot),
        '<a id="examples"></a>', "## Examples from the recorded work", "", exampleReading(options.snapshot, representatives.length, selectedRecordCount), ""];
    if (!representatives.length) lines.push("No qualifying Work IQ scenarios.");
    for (const r of representatives) lines.push(
        ...(inlineExamplePrompt(r) ? [`<a id="${escapeHtml(r.scenarioId)}"></a>`, ...promptCopyMarkdown(r.promptCopy)]
            : [`### ${escapeMarkdown(r.prompt === null ? `${r.tool} - ${r.outcome}` : short(r.prompt, 110))}`, "",
                ...(r.prompt === null ? ["Originating prompt omitted or unavailable.", ""] : [`*Reviewed ${r.promptLabel.toLowerCase()} excerpt; full copy below.*`, ""])]),
        ...r.actions.map((a, i) => `${i + r.hiddenBefore + 1}. ${escapeMarkdown(a.tool)}: ${escapeMarkdown(a.endpoint.label)} - ${outcomeLabel("tool", a.outcome)}.`), "",
        ...(r.hiddenBefore || r.hiddenAfter ? [boundedExampleNote(r, options.snapshot), ""] : []),
        `Request reference: ${escapeMarkdown(r.scenarioId)}.${inlineExamplePrompt(r) ? "" : ` [Prompt copies](#${r.scenarioId})`}`, "",
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
    lines.push(...nativeQualityMarkdown(options.snapshot, evidence));
    if (hasAppendix) lines.push('<a id="prompts"></a>', "## Additional prompt copies", "");
    if (sanitizedRecords.some((r) => r.projectionVersion === 3)) {
        if (options.snapshot?.promptMode === "none") lines.push("No prompt text is included in this report.", "");
        for (const [index, record] of sanitizedRecords.entries()) {
            const copies = remainingCopies(record, inlineCopies);
            if (inlineCopies.has(record.scenarioId) && !copies.length) continue;
            lines.push(`<a id="${escapeHtml(record.scenarioId)}${inlineCopies.has(record.scenarioId) ? "-copies" : ""}"></a>`);
            if (options.snapshot?.promptMode === "none") continue;
            lines.push(`### ${escapeMarkdown(promptHeading(record, index))}`, "");
            for (const prompt of copies) lines.push(...promptCopyMarkdown(prompt));
        }
    }
    if (services.length) {
        lines.push("## Activity categories in this report", "");
        for (const entry of services) lines.push(`- **${escapeMarkdown(entry.label)}:** ${escapeMarkdown(entry.description)}`);
        if (options.snapshot?.categoryDefinition) lines.push("", `Category definition v${options.snapshot.categoryDefinition.version}.`);
    }
    const involvement = options.snapshot?.evaluationFacts?.serviceInvolvement;
    if (involvement) lines.push("", `Service definition: ${involvement.definition.id} v${involvement.definition.version}.`, "");
    lines.push("", '<a id="coverage"></a>', "## Coverage and reading notes", "",
        ...numbers,
        ...(selectedLegacyCount ? [`Selected export inventory includes ${selectedLegacyCount} legacy ${selectedLegacyCount === 1 ? "record" : "records"}.`, ""] : []),
        privacyNote, "", ...(options.snapshot ? snapshotLines(options.snapshot) : []), "",
        escapeMarkdown(coverageNotes(layers, Boolean(options.snapshot?.recordedContext)).join(" ")), "");
    return lines.join("\n");
}

const modeLabel = (mode) => ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[mode];
function reportIntro(snapshot, count) {
    if (!snapshot) return `${count} selected evidence ${count === 1 ? "record" : "records"}. Evidence layers use separate units, never added together.`;
    const included = snapshot.selectionScope?.requestGroups ?? count;
    return `${scopeLabel(snapshot.selectionScope?.kind)}${snapshot.selectionScope?.promptAuthors ? ` · ${promptAuthorship.selectionLabel(snapshot.selectionScope.promptAuthors, { ownerVoice: false })}` : ""} · ${included} ${included === 1 ? "interaction" : "interactions"} · ${modeLabel(snapshot.promptMode)}\nPrepared ${snapshot.preparedAtDisplay} · ${time.label(snapshot.timeContext)}`;
}
function exampleReading(snapshot, count, total) {
    return `${count} ${count === 1 ? "example" : "examples"} from ${total} selected interactions, prioritizing failed/unknown calls. Prompt association is inferred, not proof of intent; examples add no counts. ${snapshot?.formats.includes("json") ? "Complete projected records: product-report.json." : "Examples are bounded. Operation detail is an aggregate summary, not the full projected records."}`;
}
function boundedExampleNote(example, snapshot) {
    return `${example.hiddenBefore} earlier and ${example.hiddenAfter} later calls are outside this bounded example. ${snapshot?.formats.includes("json")
        ? "Complete projected records: product-report.json." : "Operation detail is an aggregate summary, not the omitted full records."}`;
}
const promptHeading = (_record, index) => `Interaction ${index + 1}`;
const inlineExamplePrompt = example => typeof example.promptCopy?.text === "string" && example.promptCopy.text.length <= 180;
function promptCopyMarkdown(prompt) {
    if (prompt.text === null) return [`- ${escapeMarkdown(promptDisplayLabel(prompt))}: ${prompt.omitted ? "Omitted from report." : "Source text unavailable; not reconstructed."}${prompt.availabilityNote ? ` ${prompt.availabilityNote}` : ""}`, ""];
    const mandatory = prompt.changes.filter(change => change.mandatory).length;
    return [`**${escapeMarkdown(promptDisplayLabel(prompt))}** (${escapeMarkdown(prompt.status)}; ${escapeMarkdown(prompt.representation)})`, "",
        ...(prompt.kind !== "tool" && promptAuthorship.read(prompt).actor === "unknown" ? [`Author not verified. ${promptAuthorship.reason(prompt)}`, ""] : []),
        ...(prompt.status === "partial" ? ["Only part of the original was recorded. Missing text is not reconstructed.", ""] : []),
        ...prompt.text.split("\n").map(line => "    " + line), "",
        ...(mandatory ? [`${mandatory} mandatory credential removal(s). This is not a byte-identical original.`, ""] : [])];
}
function resultColumns(a) { return a.layer === "code-reference" ? [] : OUTCOMES.filter((o) => a.totals[o]); }
function exampleHtml(r, snapshot) {
    const inline = inlineExamplePrompt(r);
    return `<article class="example"${inline ? ` id="${escapeHtml(r.scenarioId)}"` : ""}>${inline ? promptCopyHtml(r.promptCopy, "h3") : r.prompt === null ? `<h3>${escapeHtml(r.tool)} - ${escapeHtml(r.outcome)}</h3><p>Originating prompt omitted or unavailable.</p>` : `<h3 class="example-prompt">${escapeHtml(short(r.prompt))}</h3><p class="reading-note">Reviewed ${escapeHtml(r.promptLabel.toLowerCase())} excerpt; full copy below.</p>`}<ol start="${r.hiddenBefore + 1}">${r.actions.map((a) => `<li>${escapeHtml(a.tool)}: ${escapeHtml(a.endpoint.label)} - ${outcomeLabel("tool", a.outcome)}.</li>`).join("")}</ol>${r.hiddenBefore || r.hiddenAfter ? `<p>${escapeHtml(boundedExampleNote(r, snapshot))}</p>` : ""}${inline ? `<span class="ref">${escapeHtml(r.scenarioId)}</span>` : `<a class="ref" href="#${escapeHtml(r.scenarioId)}">Read included text · ${escapeHtml(r.scenarioId)}</a>`}</article>`;
}
function exclusionReading(scope) {
    const labels = {
        excludedOrDuplicateEvidenceRecords: "excluded or deduplicated evidence records", duplicateEvidenceRecords: "duplicate records",
        syntheticRequestGroups: "synthetic groups", diagnosticRequestGroups: "diagnostic groups", unknownSourceRequestGroups: "unknown-source groups",
    };
    const parts = Object.entries(labels).flatMap(([key, label]) => {
        const value = scope.exclusions?.[key];
        return !Number.isSafeInteger(value) || value < 0 ? [`${label}: count unavailable`] : value ? [`${value} ${label}`] : [];
    });
    if (!Number.isSafeInteger(scope.excludedRequestedGroups) || scope.excludedRequestedGroups < 0) parts.push("requested-group exclusion count unavailable");
    else if (scope.excludedRequestedGroups) parts.push(`${scope.excludedRequestedGroups} requested groups without eligible evidence`);
    return parts.length ? `Collection exclusions: ${parts.join("; ")}. Categories may overlap.` : "Collection exclusions: none.";
}
function snapshotLines(snapshot) {
    const context = time.normalize(snapshot.timeContext);
    const dates = snapshot.dateSelection;
    const boundary = (value) => value?.includes("T") ? time.formatTime(value, context) : time.formatDate(value, context, true);
    return [
        ...(snapshot.selectionScope ? [
            ...(snapshot.selectionScope.promptAuthors ? [`Author coverage: ${snapshot.selectionScope.requestGroups} of ${snapshot.selectionScope.baseRequestGroups} interactions included; ${snapshot.selectionScope.authorExcludedRequestGroups} excluded with their calls and reviews. Authorship is not permission.`] : []),
            exclusionReading(snapshot.selectionScope),
        ] : []),
        `Snapshot: ${snapshot.bundleId}. Files: ${snapshot.formats.join(", ")}. Locale: ${context.locale}${context.localeFallback ? " (fallback)" : ""}.`,
        ...(dates && dates.range !== "capture" ? [`View date selection: ${boundary(dates.from)} to ${boundary(dates.to)}. Date-only bounds include full local days; selected interactions can contain records outside this view.`] : []),
        "Source event timestamps are withheld. Dates inside included text remain in their original wording.",
        `Prompt coverage: ${snapshot.promptCoverage.included} included${snapshot.promptCoverage.omitted ? `, ${snapshot.promptCoverage.omitted} omitted` : ""}${snapshot.promptCoverage.partial ? `, ${snapshot.promptCoverage.partial} partial` : ""}${snapshot.promptCoverage.unavailable ? `, ${snapshot.promptCoverage.unavailable} unavailable` : ""}${snapshot.promptCoverage.mandatoryRemovals ? `; ${snapshot.promptCoverage.mandatoryRemovals} mandatory credential removals` : ""}.`,
    ];
}

function promptCopyHtml(p, heading = "h4") {
    return p.text === null ? `<p class="prompt-empty">${escapeHtml(promptDisplayLabel(p))}: ${p.omitted ? "Omitted from report." : "Source text unavailable; not reconstructed."} ${escapeHtml(p.availabilityNote ?? "")}</p>`
        : `<article class="prompt"><${heading}${p.kind !== "tool" && promptAuthorship.read(p).actor !== "unknown" ? ` data-prompt-actor="${promptAuthorship.read(p).actor}"` : ""}>${escapeHtml(promptDisplayLabel(p))}<span class="prompt-status"> · ${escapeHtml(p.status)} source / ${escapeHtml(p.representation)}</span></${heading}>${p.kind !== "tool" && promptAuthorship.read(p).actor === "unknown" ? `<p>Author not verified. ${escapeHtml(promptAuthorship.reason(p))}</p>` : ""}${p.status === "partial" ? "<p>Only part of the original was recorded. Missing text is not reconstructed.</p>" : ""}<pre>${escapeHtml(p.text)}</pre>${p.changes.some((c) => c.mandatory) ? `<p class="removal">Mandatory credential removal. This is not a byte-identical original.</p>` : ""}</article>`;
}
function promptHtml(records, snapshot, representatives) {
    if (!records.some((r) => r.projectionVersion === 3)) return '<section id="prompts"><h2>Reviewed prompt copies</h2><p>No reviewed prompt copies are available in this projection.</p></section>';
    if (snapshot?.promptMode === "none") return `<section id="prompts"><h2>Reviewed prompt copies</h2><p>No prompt text is included in this report.</p>${records.map((r) => `<span id="${escapeHtml(r.scenarioId)}"></span>`).join("")}</section>`;
    const inlineCopies = new Set(representatives.filter(inlineExamplePrompt).map(example => example.scenarioId));
    const remaining = records.map((r, i) => {
        const copies = remainingCopies(r, inlineCopies);
        if (!copies.length) return "";
        const included = copies.filter(p => p.text !== null).length;
        return `<details class="prompt-record" id="${escapeHtml(r.scenarioId)}${inlineCopies.has(r.scenarioId) ? "-copies" : ""}"><summary>${escapeHtml(promptHeading(r, i))}<span class="ref">${included} included ${included === 1 ? "copy" : "copies"} · ${escapeHtml(r.scenarioId)}</span></summary>${copies.map(p => promptCopyHtml(p)).join("")}</details>`;
    }).join("");
    return remaining ? `<section id="prompts"><h2>Additional prompt copies</h2>${remaining}</section>` : "";
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
    return `<section><h3>Tools</h3><p class="reading-note">Bar lengths and shares use all ${total} selected ${resultCues.columnUnit("tool", total)}. Outcome shares below each bar use that tool's calls.</p>
        ${groups.length ? `<ul class="native-bars">${groups.map(group => `<li><div class="native-bar-heading"><span>${escapeHtml(group.label)}</span><strong>${group.total} / ${total} (${nativeShare(group.total, total)})</strong></div>
            <span class="native-bar-track" aria-hidden="true">${OUTCOMES.filter(outcome => group[outcome]).map(outcome =>
                `<span class="native-bar dimensional-tone-${categoryCues.outcomeTones[outcome]}" data-outcome="${outcome}" data-count="${group[outcome]}" data-denominator="${total}" style="width:${categoryCues.geometryPolicy.span(group[outcome], total, 100)}%"></span>`).join("")}</span>
            <div class="native-bar-results">${groupOutcomes(group).map(item => `<span class="native-outcome dimensional-tone-${categoryCues.outcomeTones[item.outcome]}" data-outcome="${item.outcome}">${escapeHtml(item.text)}</span>`).join("")}</div></li>`).join("")}</ul>` : "<p>No Work IQ tool calls in this selection.</p>"}</section>`;
}

function serviceReading(snapshot, total) {
    const projection = snapshot?.evaluationFacts?.serviceInvolvement;
    if (!projection) return { projection: null, notes: ["Service involvement was not saved. Activity categories are a separate historical definition, not reconstructed service counts."] };
    return { projection, notes: [
        `Work IQ tool-call layer; ${projection.denominator} covered ${resultCues.columnUnit("tool", projection.denominator)}. Calls count once per supported service association. Services overlap; shares are not a 100% composition.`,
        `${projection.missingDetailRefs.length} ${resultCues.columnUnit("tool", projection.missingDetailRefs.length)} with missing or partial service details; ${projection.notApplicableRefs.length} preparation ${resultCues.columnUnit("tool", projection.notApplicableRefs.length)} with no applicable data service.`,
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
    return definition ? `<p class="reading-note">Service definition: ${escapeHtml(definition.id)} v${definition.version}.</p>` : "";
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
    const promptSection = promptHtml(sanitizedRecords, options.snapshot, representatives);
    const numbers = `<section id="overview" aria-label="Report evidence counts">
<table class="native-table"><caption>Evidence layers - separate units, never added together</caption><thead><tr><th scope="col">Evidence layer</th><th scope="col">Count</th><th scope="col">Recorded result</th></tr></thead><tbody>${summary.metrics.map(m => `<tr><th scope="row">${escapeHtml(m.label)}</th><td data-label="Count">${m.count}</td><td data-label="Recorded result">${escapeHtml(m.reading)}</td></tr>`).join("")}</tbody></table>
${!layers[1].totals.count && layers[1].apiCoverage.eligibleToolCalls ? `<p class="reading-note">${escapeHtml(evidenceLayerNotes(layers[1])[0])}</p>` : ""}</section>`;
    return `<!doctype html>
<html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - activity report</title>
<style>${nativeReportStyles}</style></head><body><main>${nativeReportHeader()}<p class="report-meta">${escapeHtml(reportIntro(options.snapshot, selectedRecordCount))}</p>
${nativeFindingsHtml(evidence, readingContext(sanitizedRecords, layers, tools, options.snapshot))}
<nav class="report-nav" aria-label="Report sections"><a href="#overview">Numbers</a><a href="#timing">Timing</a>${options.snapshot?.recordedContext ? '<a href="#recorded-context">Recorded context</a>' : ""}<a href="#examples">Examples</a><a href="#operations">Operation detail</a><a href="#quality">Quality results</a><a href="${promptSection ? "#prompts" : "#examples"}">Prompt copies</a><a href="#coverage">Coverage</a>${options.snapshot?.formats.includes("json") ? '<a class="json-records-link" href="product-report.json">Complete JSON records</a><span class="print-companion">Complete records: product-report.json (same folder)</span>' : ""}</nav>
<section id="breakdowns"><h2>Tools and services</h2><div class="native-breakdowns">${toolBreakdownHtml(tools, layers[0].totals.count)}${servicesHtml(options.snapshot, layers[0].totals.count)}</div></section>
${nativeTimingHtml(evidence)}
${reportContextHtml(options.snapshot)}
<section id="examples"><h2>Examples from the recorded work</h2><p>${escapeHtml(exampleReading(options.snapshot, representatives.length, selectedRecordCount))}</p>${representatives.length ? representatives.map(example => exampleHtml(example, options.snapshot)).join("") : "<p>No qualifying Work IQ scenarios.</p>"}</section>
<section id="operations"><h2>Operation detail</h2>${layers.filter(a => a.totals.count).map(a => `<section class="layer"><h3>${TITLES[a.layer]}</h3><p class="summary">${escapeHtml(compactSummary(a))}</p><div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(TITLES[a.layer])} exact data; scroll horizontally if needed">${htmlTable(a)}</div><div class="layer-notes">${layerNotes(a).map(n => `<p>${escapeHtml(n)}</p>`).join("")}</div></section>`).join("\n")}</section>
${nativeQualityHtml(options.snapshot, evidence)}
${promptSection}
${serviceDefinitionHtml(options.snapshot)}
${services.length ? `<section class="service-glossary"><h2>Activity categories in this report</h2><dl>${services.map(entry => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.description)}</dd></div>`).join("")}</dl>${options.snapshot?.categoryDefinition ? `<p>Category definition v${options.snapshot.categoryDefinition.version}.</p>` : ""}</section>` : ""}
<details id="coverage" class="reading-notes"><summary>Coverage and reading notes</summary>${numbers}${selectedLegacyCount ? `<p>Selected export inventory includes ${selectedLegacyCount} legacy records.</p>` : ""}<p>${escapeHtml(privacyNote)}</p>${options.snapshot ? snapshotLines(options.snapshot).map((line) => `<p>${escapeHtml(line.replaceAll("**", ""))}</p>`).join("") : ""}<p>${escapeHtml(coverageNotes(layers, Boolean(options.snapshot?.recordedContext)).join(" "))}</p></details>
</main></body></html>`;
}
