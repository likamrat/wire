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
import { reportFieldsHtml } from "./report-presentation.mjs";
import {
    nativeReportEvidence, nativeFindingsHtml, nativeFindingsMarkdown, nativeTimingHtml, nativeTimingMarkdown,
    nativeQualityHtml, nativeQualityMarkdown, nativeReportStyles, nativeShare, nativeReportHeader,
    microsoftEvidenceHtml, microsoftEvidenceMarkdown,
} from "./native-report-output.mjs";
import { validateNativeReportEvidence } from "./native-report-shape.mjs";
import { reportResultHtml, reportResultMarkdown } from "./report-result-output.mjs";
import { reportPatternOperation, reportPatternError } from "./report-patterns.mjs";

const TITLES = { tool: "Work IQ tool calls", "reported-api": "Tool-returned API results", http: "Owned Graph HTTP records", "direct-request": "Recorded Graph request sites", "recorded-http": "Graph request sites with visible status", "code-reference": "Graph code references (not executions)" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const escapeMarkdown = (value) => escapeHtml(value).replace(/[\\`*_#[\]{}|]/g, "\\$&").replace(/\r?\n/g, " ");
const short = (value, max = 180) => value.length > max ? `${value.slice(0, max - 3)}...` : value;
const resultCues = createRecordedResults(), categoryCues = createDimensionalCharts();
const authorLabel = (prompt, snapshot) => snapshot?.presentation?.schemaVersion === 3
    ? promptAuthorship.display(prompt, { ownerVoice: false }).label : promptAuthorship.label(prompt, { ownerVoice: false });
const promptDisplayLabel = (prompt, snapshot) => prompt.activityState === "automatic"
    ? snapshot?.presentation?.schemaVersion === 3 ? authorLabel(prompt, snapshot) : "Automatic continuation"
    : prompt.kind === "origin" ? authorLabel(prompt, snapshot)
    : prompt.kind === "tool" ? "Recorded tool argument" : prompt.label;
const promptFields = (prompt, snapshot) => [
    ...(prompt.kind === "tool" ? [["Source", prompt.label]] : prompt.kind !== "origin" && prompt.activityState !== "automatic" ? [["Author", authorLabel(prompt, snapshot)]] : []),
    ...(promptRepresentation(prompt, snapshot) ? [["Copy", promptRepresentation(prompt, snapshot)]] : []),
];
const availabilityNotice = (prompt, snapshot) => snapshot?.presentation?.schemaVersion === 3 && prompt.activityState === "automatic"
    ? promptAuthorship.display(prompt, { ownerVoice: false }).notice : prompt.availabilityNote;
const exampleAbsence = (row, snapshot) => row.promptCopy?.activityState && row.promptCopy.availabilityNote
    ? row.promptCopy.omitted ? "Originating prompt omitted from report." : availabilityNotice(row.promptCopy, snapshot)
    : "Originating prompt omitted or unavailable.";
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
            promptLabel: record.prompts?.find(p => p.kind === "origin")?.activityState === "automatic"
                ? promptDisplayLabel(record.prompts.find(p => p.kind === "origin"), options.snapshot)
                : authorLabel(record.prompts?.find(p => p.kind === "origin") ?? record.userPrompt, options.snapshot),
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
    const services = serviceCategories.used(layers.flatMap(layer => layer.rows.map(row => categoryFor(row, layer.layer))))
        .map(entry => (options.snapshot?.presentation ?? options.presentation)?.schemaVersion === 3 ? serviceCategories.display(entry.id) : entry);
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
            reading: options.resultFacts && a.layer === "tool" ? outcomeText(a).replace(/\bsucceeded\b/g, "completed") : outcomeText(a),
        })),
        services: services.map((s) => s.label),
        takeaways: [
            ...(tool.totals.count ? [`${chatCopy.count(tool.coverage.sessionCount, true)} / ${chatCopy.relationship(tool.coverage.scenarioCount, tool.totals.count, resultCues.unit("tool", tool.totals.count))}. Counts use this report's frozen selection, not just matching chart calls.`] : []),
            ...(tool.totals.count ? [`${tool.totals.success} of ${tool.totals.count} Work IQ calls ${options.resultFacts ? "recorded completion" : "succeeded"}; ${tool.totals.failure} failed and ${tool.totals.unknown} have unknown outcomes${tool.totals.partial + tool.totals.other + tool.totals.transport ? `; ${tool.totals.partial + tool.totals.other + tool.totals.transport} have partial, other or transport outcomes` : ""}. This is tool completion, not application or task success.`] : ["No Work IQ calls in this selection. Read the other evidence layers separately."]),
            ...(api.apiCoverage.eligibleToolCalls ? [`Numeric API status in returned-entry metadata is available for ${api.apiCoverage.callsWithNumericStatus} of ${api.apiCoverage.eligibleToolCalls} Work IQ calls; ${api.apiCoverage.callsWithoutNumericStatus} have no numeric status in that metadata. A separately reported tool-result status is not a fabricated API entry. Missing status is not success.`] : []),
            tool.totals.failure ? "Start with the failed-call examples below, then inspect their recorded sequence. The evidence does not establish a root cause or a completed task." : "Use the recorded examples to see operation patterns. Successful calls alone do not establish whether the user's request was fulfilled.",
        ],
    };
}

function shownGroups(a) { return [...a.visibleGroups, ...(a.otherGroup ? [a.otherGroup] : [])]; }

function evidenceLayerNotes(a) {
    if (a.layer === "reported-api") {
        const c = a.apiCoverage;
        return [
            `Numeric API status in returned-entry metadata is available for ${c.callsWithNumericStatus} of ${c.eligibleToolCalls} eligible ${resultCues.unit("tool", c.eligibleToolCalls)}; ${c.callsWithoutNumericStatus} ${resultCues.columnUnit("tool", c.callsWithoutNumericStatus)} ${c.callsWithoutNumericStatus === 1 ? "has" : "have"} no numeric status in that metadata. Separately reported tool-result statuses remain distinct. Missing status is not success.`,
            "These are returned intermediary result units, not all requested paths and not observed HTTP. Batch call outcomes are not copied to individual targets.",
        ];
    }
    if (a.layer === "http") return [`${a.httpCoverage.observedResponseCount} observed Graph responses; ${a.httpCoverage.noResponseRecordCount} recorder records without a response. Only explicit non-synthetic owned recorder records appear here. HTTP 2xx, including 202, does not prove business completion. Observed response durations end at response headers, not full body transfer.`];
    if (a.layer === "direct-request") return ["Recorded request sites are not measured wire executions. Dynamic targets, loops and retries are not reconstructed. Output-visible statuses are a subset, not additional requests."];
    if (a.layer === "recorded-http") return ["Status metadata was visible in recorded output, not captured by the owned HTTP recorder. A response does not establish task correctness."];
    if (a.layer === "code-reference") return ["Source reads, code references and tests are not evidence that a Graph request executed. Synthetic references are excluded."];
    return ["Each multi-target fetch is one tool call."];
}

function layerNotes(a, serviceInvolvement) {
    const reading = a.layer === "tool" && serviceInvolvement ? ""
        : serviceCategories.explainRows(a.rows.map(row => ({ ...row, workload: categoryFor(row, a.layer) })), a.layer);
    return [...evidenceLayerNotes(a), ...(reading ? [reading] : [])];
}

function coverageNotes(layers, recordedContext = false, localSave = false) {
    const tool = layers[0];
    return [
        `Tool coverage: ${tool.coverage.sessionCount} ${tool.coverage.sessionCount === 1 ? "chat" : "chats"}, ${tool.coverage.projectCount} Copilot project${tool.coverage.projectCount === 1 ? "" : "s"}${tool.coverage.unscopedSessionCount ? `; ${tool.coverage.unscopedSessionCount} ${tool.coverage.unscopedSessionCount === 1 ? "chat" : "chats"} without a project` : ""}.`,
        "Scope covers full eligible interactions (a prompt and its calls), not whole chats or only matching chart calls.",
        ...tool.warnings.filter((w) => ["unidentifiable-tool-records", "event-identity-fallback", "deduplicated-records", "dates-unavailable", "synthetic-excluded"].includes(w.code)).map((w) => `${w.count}: ${w.message}`),
        recordedContext
            ? "Linked context contains permitted, already-retained prompt and reply copies. Raw tool responses and unrelated argument values are withheld."
            : `${localSave ? "Included" : "Reviewed"} copies are retained wording, not generated summaries. Source titles, response bodies and unrelated argument values are withheld.`,
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
        patterns.push(`Most frequent services include ${leading.map(group => `${serviceCategories.describe(group.service).label} (${group.count})`).join(", ")} across ${involvement.denominator} covered ${involvement.denominator === 1 ? "call" : "calls"}.`);
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
    if (options.snapshot?.reportPopulation) return renderFocusedMarkdown(sanitizedRecords, options);
    if (options.snapshot?.nativeEvidence) {
        validateNativeReportEvidence(options.snapshot.nativeEvidence, sanitizedRecords);
        const github = sanitizedRecords.filter(record => record.recordKind !== "native-conversation");
        const native = microsoftEvidenceMarkdown(options.snapshot.nativeEvidence);
        if (!github.length) return [`# ${escapeMarkdown(options.snapshot.title)}`, "", `Prepared: ${escapeMarkdown(options.snapshot.preparedAtDisplay)}`, "", ...native,
            ...reportResultMarkdown(options.snapshot.resultFacts, options.snapshot.resultText, { evaluationFacts: options.snapshot.evaluationFacts }),
            privacySummary(options.privacy), "", `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`, ""].join("\n");
        const snapshot = githubReportView(options.snapshot, github);
        return [`# ${escapeMarkdown(options.snapshot.title)}`, "", ...native, ...reportResultMarkdown(options.snapshot.resultFacts, options.snapshot.resultText, { evaluationFacts: options.snapshot.evaluationFacts }), "## GitHub evidence", "",
            renderMarkdownReport(github, { ...options, snapshot }).replace(/^# [^\n]*\n/, "")].join("\n");
    }
    const { layers, tools, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const evidence = nativeReportEvidence(options.snapshot);
    const qualityLabel = [3, 4].includes(options.snapshot?.evaluationFacts?.metricProjectionVersion)
        ? options.snapshot.evaluationFacts.metrics.some(metric => metric.origin === "user-personal") ? "Personal feedback" : "" : "Quality results";
    const inlineCopies = new Set(representatives.filter(inlineExamplePrompt).map(example => example.scenarioId));
    const hasAppendix = sanitizedRecords.some(record => remainingCopies(record, inlineCopies).length);
    const numbers = [
        '<a id="overview"></a>',
        "| Evidence layer (separate units) | Count | Recorded result |", "|---|---:|---|",
        ...summary.metrics.filter(m => m.count).map(m => `| ${m.label} | ${m.count} | ${m.reading} |`), "",
        ...(!layers[1].totals.count && layers[1].apiCoverage.eligibleToolCalls ? [evidenceLayerNotes(layers[1])[0], ""] : []),
    ];
    const lines = [options.snapshot?.title ? `# ${escapeMarkdown(options.snapshot.title)}` : `# ${PRODUCT_NAME} - activity report`, "",
        reportIntro(options.snapshot, selectedRecordCount), "",
        ...nativeFindingsMarkdown(evidence, readingContext(sanitizedRecords, layers, tools, options.snapshot)),
        `[Activity](#overview) [Timing](#timing) [Examples](#examples) [Operations](#operations)${qualityLabel ? ` [${qualityLabel}](#quality)` : ""}${hasAppendix && options.snapshot?.promptMode !== "none" ? " [Report text](#prompts)" : ""} [Coverage](#coverage)${options.snapshot?.formats.includes("json") ? " [Complete records (JSON)](product-report.json)" : ""}`, "",
        "## Activity", "", ...numbers,
        "### Tools", "", "| Tool | Calls / all calls | Share | Recorded outcomes |", "|---|---:|---:|---|",
        ...tools.map(group => `| ${escapeMarkdown(group.label)} | ${group.total} / ${layers[0].totals.count} | ${nativeShare(group.total, layers[0].totals.count)} | ${groupOutcomeText(group)} |`), "",
        ...servicesMarkdown(options.snapshot, layers[0].totals.count),
        ...nativeTimingMarkdown(evidence),
        ...reportResultMarkdown(options.snapshot?.resultFacts, options.snapshot?.resultText, { evaluationFacts: options.snapshot?.evaluationFacts }),
        ...reportContextMarkdown(options.snapshot),
        '<a id="examples"></a>', "## Examples", "", exampleReading(options.snapshot, representatives.length, selectedRecordCount), ""];
    if (!representatives.length) lines.push("No qualifying Work IQ scenarios.");
    for (const r of representatives) lines.push(
        ...(inlineExamplePrompt(r) ? [`<a id="${escapeHtml(r.scenarioId)}"></a>`, ...promptCopyMarkdown(r.promptCopy, options.snapshot)]
            : [`### ${promptHeading(r, sanitizedRecords.findIndex(record => record.scenarioId === r.scenarioId))}`, "",
                ...(r.prompt === null ? options.snapshot?.promptMode === "none" ? [] : [escapeMarkdown(exampleAbsence(r, options.snapshot)), ""]
                    : [escapeMarkdown(short(r.prompt, 110)), ""])]),
        "| Call | Tool | Operation | Outcome |", "|---:|---|---|---|",
        ...r.actions.map((a, i) => `| ${i + r.hiddenBefore + 1} | ${escapeMarkdown(a.tool)} | ${escapeMarkdown(a.endpoint.label)} | ${outcomeLabel("tool", a.outcome)} |`), "",
        ...(r.hiddenBefore || r.hiddenAfter ? [boundedExampleNote(r, options.snapshot), ""] : []),
        ...(!inlineExamplePrompt(r) && options.snapshot?.promptMode !== "none" ? [`[Read included text](#${r.scenarioId})`, ""] : []),
    );
    lines.push('<a id="operations"></a>', "## Operations", "");
    if (!layers.some((a) => a.totals.count)) lines.push("No qualifying records in this layer.", "");
    for (const a of layers.filter((a) => a.totals.count)) {
        const columns = resultColumns(a);
        lines.push(`### ${TITLES[a.layer]}`, "",
            `| Endpoint / operation | Count |${columns.map((o) => ` ${outcomeLabel(a.layer, o)} |`).join("")}`,
            `|---|---:|${columns.map(() => "---:|").join("")}`);
        for (const g of shownGroups(a)) lines.push(`| ${escapeMarkdown(g.label)} | ${g.total} |${columns.map((o) => ` ${g[o]} |`).join("")}`);
        lines.push("", ...layerNotes(a, options.snapshot?.evaluationFacts?.serviceInvolvement), "");
    }

    lines.push(...nativeQualityMarkdown(options.snapshot, evidence));
    if (hasAppendix && options.snapshot?.promptMode !== "none") lines.push('<a id="prompts"></a>', "## Report text", "");
    if (sanitizedRecords.some((r) => r.projectionVersion === 3)) {
        for (const [index, record] of sanitizedRecords.entries()) {
            const copies = remainingCopies(record, inlineCopies);
            if (inlineCopies.has(record.scenarioId) && !copies.length) continue;
            lines.push(`<a id="${escapeHtml(record.scenarioId)}${inlineCopies.has(record.scenarioId) ? "-copies" : ""}"></a>`);
            if (options.snapshot?.promptMode === "none") continue;
            lines.push(`### ${escapeMarkdown(promptHeading(record, index))}`, "");
            for (const prompt of copies) lines.push(...promptCopyMarkdown(prompt, options.snapshot));
        }
    }
    lines.push(...reportNotesMarkdown(options.snapshot), "", '<a id="coverage"></a>', "## Coverage", "");
    if (services.length && !options.snapshot?.evaluationFacts?.serviceInvolvement) {
        lines.push("Activity categories:", "");
        for (const entry of services) lines.push(`- **${escapeMarkdown(entry.label)}:** ${escapeMarkdown(entry.description)}`);
        if (options.snapshot?.categoryDefinition) lines.push("", `Category definition v${options.snapshot.categoryDefinition.version}.`);
    }
    const involvement = options.snapshot?.evaluationFacts?.serviceInvolvement;
    if (involvement) lines.push("", `Service definition: ${involvement.definition.id} v${involvement.definition.version}.`, "");
    lines.push("",
        ...(selectedLegacyCount ? [`Selected export inventory includes ${selectedLegacyCount} legacy ${selectedLegacyCount === 1 ? "record" : "records"}.`, ""] : []),
        privacyNote, "", ...(options.snapshot ? snapshotLines(options.snapshot) : []), "",
        ...coverageNotes(layers, Boolean(options.snapshot?.recordedContext), options.snapshot?.savePolicy === "local-save-v1").map(note => `- ${escapeMarkdown(note)}`), "",
        `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`, "");
    return lines.join("\n");
}

const modeLabel = (mode) => ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[mode];
function reportIntro(snapshot, count) {
    if (!snapshot) return `${count} selected evidence ${count === 1 ? "record" : "records"}. Evidence layers use separate units, never added together.`;
    const included = snapshot.selectionScope?.requestGroups ?? count;
    if (snapshot.reportPopulation) {
        const dates = snapshot.dateSelection;
        const period = dates.range === "capture" ? "All retained dates"
            : `${time.formatDate(dates.from, snapshot.timeContext, true)} to ${time.formatDate(dates.to, snapshot.timeContext, true)}`;
        return reportFieldsHtml([
            ["Activity", snapshot.selectionScope?.kind === "selected" ? "Selected interactions"
                : snapshot.selectionScope?.kind === "current" ? "Based on Analyze filters" : "Retained activity"],
            ["Period", period],
            ["Prompts", promptAuthorship.selectionLabel(snapshot.selectionScope?.promptAuthors, { ownerVoice: false })],
            ...(snapshot.reportPopulation.focus.services.length ? [["Services", snapshot.reportPopulation.focus.services.join(", ")]] : []),
            ["Text", ({ none: "Prompts and replies left out", masked: "Personal details hidden where detected", original: "Chat details kept" })[snapshot.promptMode]],
            ["Prepared", snapshot.preparedAtDisplay], ["Timezone", time.label(snapshot.timeContext)],
        ]);
    }
    return reportFieldsHtml([
        ["Scope", scopeLabel(snapshot.selectionScope?.kind)],
        ...(snapshot.selectionScope?.promptAuthors ? [["Authors", promptAuthorship.selectionLabel(snapshot.selectionScope.promptAuthors, { ownerVoice: false })]] : []),
        ["Interactions", included], ["Text", modeLabel(snapshot.promptMode)],
        ["Prepared", snapshot.preparedAtDisplay], ["Timezone", time.label(snapshot.timeContext)],
    ]);
}
function exampleReading(snapshot, count, total) {
    return `${count} of ${total} interactions; failed or unknown calls first. Prompt-to-call links are inferred, not proof of intent. Examples add no counts.${snapshot?.formats.includes("json") ? "" : " Selected excerpts, not complete records."}`;
}
function boundedExampleNote(example, snapshot) {
    return `${example.hiddenBefore} earlier and ${example.hiddenAfter} later calls are outside this bounded example. ${snapshot?.formats.includes("json")
        ? "Complete projected records: product-report.json." : "Operation detail is an aggregate summary, not the omitted full records."}`;
}
const promptHeading = (_record, index) => `Interaction ${index + 1}`;
const inlineExamplePrompt = example => typeof example.promptCopy?.text === "string" && example.promptCopy.text.length <= 180;
const promptRepresentation = (prompt, snapshot) => (snapshot?.presentation?.schemaVersion === 3
    && (!snapshot.periodComparison || snapshot.periodComparison.definitions?.metricProjectionVersion === 4)
    && (snapshot.promptMode === "masked" && prompt.representation === "masked-copy"
        || snapshot.promptMode === "original" && prompt.representation === "retained-original")) ? "" : ({
    "masked-copy": "Masked copy", "edited-copy": "Edited copy", "retained-original": "Original wording",
    "original-with-mandatory-or-manual-removals": "Original wording with redactions",
})[prompt.representation] ?? (prompt.representation ? "Report copy" : "");
export function promptCopyMarkdown(prompt, snapshot) {
    const fields = promptFields(prompt, snapshot);
    if (prompt.text === null) return [`- ${escapeMarkdown(promptDisplayLabel(prompt, snapshot))}: ${prompt.omitted ? "Omitted from report."
        : prompt.activityState && prompt.availabilityNote ? escapeMarkdown(availabilityNotice(prompt, snapshot))
            : "Source text unavailable; not reconstructed." + (prompt.availabilityNote ? ` ${escapeMarkdown(prompt.availabilityNote)}` : "")}`, "",
        ...(fields.length ? [reportFieldsHtml(fields), ""] : [])];
    const mandatory = prompt.changes.filter(change => change.mandatory).length;
    return [`**${escapeMarkdown(promptDisplayLabel(prompt, snapshot))}**`, "", ...(fields.length ? [reportFieldsHtml(fields), ""] : []),
        ...(prompt.kind !== "tool" && promptAuthorship.read(prompt).actor === "unknown" ? [`Author not verified. ${promptAuthorship.reason(prompt)}`, ""] : []),
        ...(prompt.status === "partial" ? ["Only part of the original was recorded. Missing text is not reconstructed.", ""] : []),
        ...(prompt.activityState && prompt.availabilityNote ? [escapeMarkdown(availabilityNotice(prompt, snapshot)), ""] : []),
        ...prompt.text.split("\n").map(line => "    " + line), "",
        ...(mandatory ? [`${mandatory} mandatory credential removal(s). This is not a byte-identical original.`, ""] : [])];
}
function resultColumns(a) { return a.layer === "code-reference" ? [] : OUTCOMES.filter((o) => a.totals[o]); }
function exampleHtml(r, snapshot, index) {
    const inline = inlineExamplePrompt(r);
    return `<article class="example"${inline ? ` id="${escapeHtml(r.scenarioId)}"` : ""}>${inline ? promptCopyHtml(r.promptCopy, "h3", snapshot) : `<h3>${promptHeading(r, index)}</h3>${r.prompt !== null ? `<p class="example-prompt">${escapeHtml(short(r.prompt))}</p>` : snapshot?.promptMode === "none" ? "" : `<p>${escapeHtml(exampleAbsence(r, snapshot))}</p>`}`}<div class="table-wrap" tabindex="0" role="region" aria-label="Example calls"><table class="example-calls"><thead><tr><th class="report-numeric">Call</th><th>Tool</th><th>Operation</th><th>Outcome</th></tr></thead><tbody>${r.actions.map((a, i) => `<tr><td class="report-numeric">${i + r.hiddenBefore + 1}</td><td>${escapeHtml(a.tool)}</td><td>${escapeHtml(a.endpoint.label)}</td><td${["failure", "transport"].includes(a.outcome) ? ' class="report-negative"' : ""}>${outcomeLabel("tool", a.outcome)}</td></tr>`).join("")}</tbody></table></div>${r.hiddenBefore || r.hiddenAfter ? `<p>${escapeHtml(boundedExampleNote(r, snapshot))}</p>` : ""}${!inline && snapshot?.promptMode !== "none" ? `<a class="ref" href="#${escapeHtml(r.scenarioId)}">Read included text</a>` : ""}</article>`;
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
            ...(snapshot.selectionScope.promptAuthors && !snapshot.reportPopulation ? [`Author coverage: ${snapshot.selectionScope.requestGroups} of ${snapshot.selectionScope.baseRequestGroups} interactions included; ${snapshot.selectionScope.authorExcludedRequestGroups} excluded with their calls${snapshot.evaluationFacts?.metricProjectionVersion === 4 ? "" : " and reviews"}. Authorship is not permission.`] : []),
            ...(exclusionReading(snapshot.selectionScope) === "Collection exclusions: none." ? [] : [exclusionReading(snapshot.selectionScope)]),
        ] : []),
        `Report reference: ${snapshot.bundleId}.`,
        ...(snapshot.formats.includes("json") ? ["Complete records: product-report.json."] : []),
        ...(dates && dates.range !== "capture" ? [`View date selection: ${boundary(dates.from)} to ${boundary(dates.to)}. Date-only bounds include full local days; selected interactions can contain records outside this view.`] : []),
        "Source event timestamps are withheld. Dates inside included text remain in their original wording.",
        ...(snapshot.promptMode === "none" ? [] : [`Prompt coverage: ${snapshot.promptCoverage.included} included${snapshot.promptCoverage.omitted ? `, ${snapshot.promptCoverage.omitted} omitted` : ""}${snapshot.promptCoverage.partial ? `, ${snapshot.promptCoverage.partial} partial` : ""}${snapshot.promptCoverage.unavailable ? `, ${snapshot.promptCoverage.unavailable} unavailable` : ""}${snapshot.promptCoverage.noNewMessage ? `, ${snapshot.promptCoverage.noNewMessage} automatic continuations without a new message` : ""}${snapshot.promptCoverage.mandatoryRemovals ? `; ${snapshot.promptCoverage.mandatoryRemovals} mandatory credential removals` : ""}.`]),
    ];
}

export function promptCopyHtml(p, heading = "h4", snapshot) {
    const fields = promptFields(p, snapshot);
    return p.text === null ? `<p class="prompt-empty">${escapeHtml(promptDisplayLabel(p, snapshot))}: ${p.omitted ? "Omitted from report."
        : p.activityState && p.availabilityNote ? escapeHtml(availabilityNotice(p, snapshot))
            : "Source text unavailable; not reconstructed." + (p.availabilityNote ? ` ${escapeHtml(p.availabilityNote)}` : "")}</p>${fields.length ? reportFieldsHtml(fields) : ""}`
        : `<article class="prompt"><header class="prompt-heading"><${heading}${p.kind !== "tool" && promptAuthorship.read(p).actor !== "unknown" ? ` data-prompt-actor="${promptAuthorship.read(p).actor}"` : ""}>${escapeHtml(promptDisplayLabel(p, snapshot))}</${heading}>${fields.length ? reportFieldsHtml(fields) : ""}</header>${p.kind !== "tool" && promptAuthorship.read(p).actor === "unknown" ? `<p>Author not verified. ${escapeHtml(promptAuthorship.reason(p))}</p>` : ""}${p.status === "partial" ? "<p>Only part of the original was recorded. Missing text is not reconstructed.</p>" : ""}${p.activityState && p.availabilityNote ? `<p>${escapeHtml(availabilityNotice(p, snapshot))}</p>` : ""}<pre>${escapeHtml(p.text)}</pre>${p.changes.some((c) => c.mandatory) ? `<p class="removal">Mandatory credential removal. This is not a byte-identical original.</p>` : ""}</article>`;
}
function promptHtml(records, snapshot, representatives) {
    if (snapshot?.promptMode === "none") return "";
    if (!records.some((r) => r.projectionVersion === 3)) return '<section id="prompts"><h2>Reviewed prompt copies</h2><p>No reviewed prompt copies are available in this projection.</p></section>';
    const inlineCopies = new Set(representatives.filter(inlineExamplePrompt).map(example => example.scenarioId));
    const remaining = records.map((r, i) => {
        const copies = remainingCopies(r, inlineCopies);
        if (!copies.length) return "";
        const included = copies.filter(p => p.text !== null).length;
        return `<details class="prompt-record" id="${escapeHtml(r.scenarioId)}${inlineCopies.has(r.scenarioId) ? "-copies" : ""}"><summary>${escapeHtml(promptHeading(r, i))}<span class="ref">${included} included ${included === 1 ? "copy" : "copies"}</span></summary>${copies.map(p => promptCopyHtml(p, "h4", snapshot)).join("")}</details>`;
    }).join("");
    return remaining ? `<section id="prompts"><h2>Report text</h2>${remaining}</section>` : "";
}

function htmlTable(a) {
    const columns = resultColumns(a);
    return `<table class="operation-table"><thead><tr><th scope="col">Endpoint / operation</th><th scope="col">Count</th>${columns.map((o) => `<th scope="col">${outcomeLabel(a.layer, o)}</th>`).join("")}</tr></thead><tbody>${shownGroups(a).map((g) => `<tr><th scope="row">${escapeHtml(g.label)}</th><td>${g.total}</td>${columns.map((o) => `<td${["failure", "transport"].includes(o) && g[o] > 0 ? ' class="report-negative"' : ""}>${g[o]}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
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
    return `<section><h3>Tools</h3><p class="reading-note">${total} calls overall. Outcomes use each tool's calls.</p>
        ${groups.length ? `<ul class="native-bars">${groups.map(group => `<li><div class="native-bar-heading"><span>${escapeHtml(group.label)}</span><strong>${group.total} / ${total} (${nativeShare(group.total, total)})</strong></div>
            <span class="native-bar-track" aria-hidden="true">${OUTCOMES.filter(outcome => group[outcome]).map(outcome =>
                `<span class="native-bar dimensional-tone-${categoryCues.outcomeTones[outcome]}" data-outcome="${outcome}" data-count="${group[outcome]}" data-denominator="${total}" style="width:${categoryCues.geometryPolicy.span(group[outcome], total, 100)}%"></span>`).join("")}</span>
            <div class="native-bar-results">${groupOutcomes(group).map(item => `<span class="native-outcome dimensional-tone-${categoryCues.outcomeTones[item.outcome]}" data-outcome="${item.outcome}">${escapeHtml(item.text)}</span>`).join("")}</div></li>`).join("")}</ul>` : "<p>No Work IQ tool calls in this selection.</p>"}</section>`;
}

function serviceReading(snapshot, total) {
    const projection = snapshot?.evaluationFacts?.serviceInvolvement;
    if (!projection) return { projection: null, notes: ["Service involvement was not saved. Activity categories are a separate historical definition, not reconstructed service counts."] };
    return { projection, notes: [
        `${projection.denominator} covered ${resultCues.columnUnit("tool", projection.denominator)}. Each call counts once per service; services overlap.`,
        ...(projection.missingDetailRefs.length ? [`${projection.missingDetailRefs.length} ${resultCues.columnUnit("tool", projection.missingDetailRefs.length)} with missing or partial service details.`] : []),
        ...(projection.notApplicableRefs.length ? [`${projection.notApplicableRefs.length} preparation ${resultCues.columnUnit("tool", projection.notApplicableRefs.length)} with no applicable data service.`] : []),
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

function githubReportView(snapshot, records) {
    const { nativeEvidence, resultFacts, resultText, ...github } = snapshot;
    return { ...github, records, evaluationFacts: nativeEvidence.githubEvaluationFacts };
}

export function renderHtmlReport(sanitizedRecords, options = {}) {
    if (options.snapshot?.reportPopulation) return renderFocusedHtml(sanitizedRecords, options);
    const resultFacts = reportResultHtml(options.snapshot?.resultFacts, options.snapshot?.resultText, { evaluationFacts: options.snapshot?.evaluationFacts });
    let microsoft = "";
    if (options.snapshot?.nativeEvidence) {
        validateNativeReportEvidence(options.snapshot.nativeEvidence, sanitizedRecords);
        microsoft = microsoftEvidenceHtml(options.snapshot.nativeEvidence);
        const github = sanitizedRecords.filter(record => record.recordKind !== "native-conversation");
        if (!github.length) return `<!doctype html>
<html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - ${escapeHtml(options.snapshot.title)}</title>
<style>${nativeReportStyles}</style></head><body><main>${nativeReportHeader(options.snapshot.title)}<p class="report-meta">Prepared: ${escapeHtml(options.snapshot.preparedAtDisplay)}</p>${microsoft}${resultFacts}
<p class="reading-note">${escapeHtml(privacySummary(options.privacy))}</p><p class="report-footer">${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}</p></main></body></html>`;
        options = { ...options, snapshot: githubReportView(options.snapshot, github) };
        sanitizedRecords = github;
    }
    const { layers, tools, representatives, services, selectedRecordCount, selectedLegacyCount, privacyNote } = reportModel(sanitizedRecords, options);
    const summary = options.snapshot?.summary ?? reportSummary(sanitizedRecords, options);
    const evidence = nativeReportEvidence(options.snapshot);
    const qualityLabel = [3, 4].includes(options.snapshot?.evaluationFacts?.metricProjectionVersion)
        ? options.snapshot.evaluationFacts.metrics.some(metric => metric.origin === "user-personal") ? "Personal feedback" : "" : "Quality results";
    const promptSection = promptHtml(sanitizedRecords, options.snapshot, representatives);
    const numbers = `<section id="overview" aria-label="Report evidence counts"><h2>Activity</h2>
<table class="native-table"><caption>Evidence layers - separate units, never added together</caption><thead><tr><th scope="col">Evidence layer</th><th scope="col">Count</th><th scope="col">Recorded result</th></tr></thead><tbody>${summary.metrics.filter(m => m.count).map(m => `<tr><th scope="row">${escapeHtml(m.label)}</th><td data-label="Count">${m.count}</td><td data-label="Recorded result">${escapeHtml(m.reading)}</td></tr>`).join("")}</tbody></table>
${!layers[1].totals.count && layers[1].apiCoverage.eligibleToolCalls ? `<p class="reading-note">${escapeHtml(evidenceLayerNotes(layers[1])[0])}</p>` : ""}</section>`;
    return `<!doctype html>
<html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - ${escapeHtml(options.snapshot?.title || "activity report")}</title>
<style>${nativeReportStyles}</style></head><body><main>${nativeReportHeader(options.snapshot?.title)}${microsoft}${microsoft ? "<h2>GitHub evidence</h2>" : ""}${reportIntro(options.snapshot, selectedRecordCount)}
${nativeFindingsHtml(evidence, readingContext(sanitizedRecords, layers, tools, options.snapshot))}
<nav class="report-nav" aria-label="Report sections"><a href="#overview">Activity</a><a href="#timing">Timing</a>${options.snapshot?.recordedContext ? '<a href="#recorded-context">Recorded context</a>' : ""}<a href="#examples">Examples</a><a href="#operations">Operations</a>${qualityLabel ? `<a href="#quality">${qualityLabel}</a>` : ""}${promptSection ? '<a href="#prompts">Report text</a>' : ""}<a href="#coverage">Coverage</a>${options.snapshot?.formats.includes("json") ? '<a class="json-records-link" href="product-report.json">Complete records (JSON)</a><span class="print-companion">Complete records: product-report.json (same folder)</span>' : ""}</nav>
${numbers}
<div id="breakdowns" class="native-breakdowns">${toolBreakdownHtml(tools, layers[0].totals.count)}${servicesHtml(options.snapshot, layers[0].totals.count)}</div>
${nativeTimingHtml(evidence)}
${resultFacts}
${reportContextHtml(options.snapshot)}
<section id="examples"><h2>Examples</h2><p>${escapeHtml(exampleReading(options.snapshot, representatives.length, selectedRecordCount))}</p>${representatives.length ? representatives.map(example => exampleHtml(example, options.snapshot, sanitizedRecords.findIndex(record => record.scenarioId === example.scenarioId))).join("") : "<p>No qualifying Work IQ scenarios.</p>"}</section>
<section id="operations"><h2>Operations</h2>${layers.filter(a => a.totals.count).map(a => `<section class="layer"><h3>${TITLES[a.layer]}</h3><div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(TITLES[a.layer])} exact data; scroll horizontally if needed">${htmlTable(a)}</div><div class="layer-notes">${layerNotes(a, options.snapshot?.evaluationFacts?.serviceInvolvement).map(n => `<p>${escapeHtml(n)}</p>`).join("")}</div></section>`).join("\n")}</section>
${nativeQualityHtml(options.snapshot, evidence)}
${promptSection}${reportNotesHtml(options.snapshot)}
<details id="coverage" class="reading-notes"><summary>Coverage and definitions</summary>${selectedLegacyCount ? `<p>Selected export inventory includes ${selectedLegacyCount} legacy ${selectedLegacyCount === 1 ? "record" : "records"}.</p>` : ""}<p>${escapeHtml(privacyNote)}</p>${options.snapshot ? snapshotLines(options.snapshot).map((line) => `<p>${escapeHtml(line.replaceAll("**", ""))}</p>`).join("") : ""}<ul>${coverageNotes(layers, Boolean(options.snapshot?.recordedContext), options.snapshot?.savePolicy === "local-save-v1").map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
${serviceDefinitionHtml(options.snapshot)}
${services.length && !options.snapshot?.evaluationFacts?.serviceInvolvement ? `<section class="service-glossary"><h3>Activity categories</h3><dl>${services.map(entry => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.description)}</dd></div>`).join("")}</dl>${options.snapshot?.categoryDefinition ? `<p>Category definition v${options.snapshot.categoryDefinition.version}.</p>` : ""}</section>` : ""}</details>
<p class="report-footer">${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}</p>
</main></body></html>`;
}

function populationLead(snapshot) {
    const population = snapshot.reportPopulation;
    return population.focus.outcome === "errors"
        ? `${population.included.length} of ${population.reference.length} interactions had recorded errors.`
        : `${population.included.length} ${population.included.length === 1 ? "interaction" : "interactions"} included.`;
}

function authorCounts(group) {
    return [["user", "Human"], ["agent", "Agent"], ["unknown", "Author not verified"]]
        .filter(([actor]) => group.authors[actor]).map(([actor, label]) => `${label}: ${group.authors[actor]}`).join("; ");
}

function patternSource(group) {
    return [...new Set(group.signals.map(signal => ({
        "call-failure": "Call completion", "application-error": "Work IQ result",
        "result-status": "Reported result status", "conflicting-result-status": "Conflicting reported statuses",
        "recorded-error": "Recorded error code", "returned-api-error": "Returned API result",
        "conflicting-returned-status": "Conflicting returned status", "conflicting-diagnostic-status": "Conflicting diagnostic status",
        "recorded-request-timeout": "Retained timeout signal",
    })[signal.kind]))].join("; ");
}

function patternSections(snapshot) {
    const groups = snapshot.reportPatterns.groups;
    return [
        ...(snapshot.reportPopulation.focus.outcome !== "errors" ? [{ kind: "operation", title: "Recorded operations" }] : []),
        ...(groups.some(group => group.kind === "errors") ? [{ kind: "errors", title: "Recorded error patterns" }] : []),
    ].map(section => ({ ...section, groups: groups.filter(group => group.kind === section.kind) })).filter(section => section.groups.length);
}

function patternsHtml(snapshot) {
    const sections = patternSections(snapshot);
    if (!sections.length) return '<section id="patterns"><h2>Patterns</h2><p>No qualified Work IQ call patterns were retained for these interactions. The included evidence is listed below.</p></section>';
    return `<section id="patterns">${sections.map(section => `<h2>${section.title}</h2><table class="native-table report-pattern-table"><thead><tr><th>Operation${section.kind === "errors" ? " and recorded error" : ""}</th><th>Interactions</th><th>Calls</th><th>Prompt authors</th></tr></thead><tbody>${section.groups.map(group => `<tr><th scope="row">${escapeHtml(reportPatternOperation(group, snapshot.evaluationFacts))}${section.kind === "errors" ? `<span class="report-pattern-detail">${escapeHtml(reportPatternError(group))}</span><span class="report-pattern-source">${escapeHtml(patternSource(group))}</span>` : ""}</th><td data-label="Interactions"><a href="#${escapeHtml(group.interactionRefs[0])}">${group.interactionRefs.length}</a></td><td data-label="Calls">${group.callRefs.length}</td><td data-label="Prompt authors">${escapeHtml(authorCounts(group))}</td></tr>`).join("")}</tbody></table>`).join("")}<p class="reading-note">Patterns use recorded operations and error facts, not inferred prompt meaning or a proven cause. An interaction can appear in more than one pattern.</p></section>`;
}

function patternsMarkdown(snapshot) {
    const sections = patternSections(snapshot), lines = ["## Patterns", ""];
    if (!sections.length) return [...lines, "No qualified Work IQ call patterns were retained for these interactions.", ""];
    for (const section of sections) {
        lines.push(`### ${section.title}`, "", "| Operation | Recorded error | Interactions | Calls | Prompt authors |", "|---|---|---:|---:|---|");
        for (const group of section.groups) lines.push(`| ${escapeMarkdown(reportPatternOperation(group, snapshot.evaluationFacts))} | ${section.kind === "errors" ? escapeMarkdown(reportPatternError(group) + " (" + patternSource(group) + ")") : "Not an error grouping"} | ${group.interactionRefs.length} | ${group.callRefs.length} | ${escapeMarkdown(authorCounts(group))} |`);
        lines.push("");
    }
    return [...lines, "Patterns use recorded operations and error facts, not inferred prompt meaning or a proven cause. Interactions may appear in more than one pattern.", ""];
}

function noteHtml(snapshot, scenarioId) {
    const note = snapshot.reportNotes?.entries.find(entry => entry.scenarioId === scenarioId);
    return note ? `<aside class="report-author-note" data-report-note="${escapeHtml(scenarioId)}"><h4>Report author's note</h4><pre>${escapeHtml(note.text)}</pre></aside>` : "";
}

function noteMarkdown(snapshot, scenarioId) {
    const note = snapshot.reportNotes?.entries.find(entry => entry.scenarioId === scenarioId);
    return note ? ["#### Report author's note", "", ...note.text.split("\n").map(line => "    " + line), ""] : [];
}

export function reportNotesHtml(snapshot) {
    if (!snapshot?.reportNotes?.entries.length) return "";
    return `<section id="report-notes"><h2>Report author's notes</h2>${snapshot.reportNotes.entries.map(note =>
        `<h3>Interaction ${snapshot.records.findIndex(record => record.scenarioId === note.scenarioId) + 1}</h3>${noteHtml(snapshot, note.scenarioId)}`).join("")}</section>`;
}

export function reportNotesMarkdown(snapshot) {
    if (!snapshot?.reportNotes?.entries.length) return [];
    return ["## Report author's notes", "", ...snapshot.reportNotes.entries.flatMap(note => [
        `### Interaction ${snapshot.records.findIndex(record => record.scenarioId === note.scenarioId) + 1}`, "",
        ...noteMarkdown(snapshot, note.scenarioId),
    ])];
}

function interactionRows(record, layer) {
    const rows = layer.rows.filter(row => row.scenarioId === record.scenarioId);
    if (layer.layer !== "tool") return rows;
    const ordinal = row => {
        const index = record.toolCalls.findIndex(call => row.toolCallId ? call.toolCallId === row.toolCallId
            : row.id === `event:${JSON.stringify([record.sourceSessionId, call.startEventId])}`);
        if (index < 0) throw new TypeError("An included call no longer belongs to its interaction.");
        return record.toolCalls[index].order ?? index + 1;
    };
    return rows.sort((a, b) => ordinal(a) - ordinal(b));
}

function includedInteractionsHtml(records, snapshot, layers) {
    return `<section id="examples"><h2>Included interactions</h2>${records.map((record, index) =>
        `<article class="example report-interaction" id="${escapeHtml(record.scenarioId)}" data-report-scenario="${escapeHtml(record.scenarioId)}"><h3>Interaction ${index + 1}</h3>${snapshot.promptMode === "none"
            ? "<p>Prompts and replies were left out of this report.</p>" : record.prompts.map(prompt => promptCopyHtml(prompt, "h4", snapshot)).join("")}${noteHtml(snapshot, record.scenarioId)}${layers.map(layer => {
            const rows = interactionRows(record, layer);
            if (!rows.length) return "";
            return `<h4>${TITLES[layer.layer]}</h4><div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(TITLES[layer.layer])}"><table class="example-calls"><thead><tr><th>Record</th><th>Tool</th><th>Operation</th><th>Recorded outcome</th></tr></thead><tbody>${rows.map((row, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(row.tool || "Not recorded")}</td><td>${escapeHtml(row.endpoint.label)}</td><td>${layer.layer === "code-reference" ? "Not an execution" : escapeHtml(outcomeLabel(layer.layer, row.outcome).replace(/^succeeded$/, "completed"))}</td></tr>`).join("")}</tbody></table></div>`;
        }).join("")}</article>`).join("")}</section>`;
}

function focusedCoverage(snapshot, privacyNote, layers) {
    const notes = [...coverageNotes(layers, Boolean(snapshot.recordedContext), snapshot.savePolicy === "local-save-v1"), ...snapshotLines(snapshot)];
    if (snapshot.reportPopulation.undatedInteractions) notes.push(
        `Before the date filter, ${snapshot.reportPopulation.undatedInteractions} matching interactions had some activity without a recorded date.`);
    return [privacyNote, "A completed call does not always mean the overall task succeeded.",
        "The reference count describes whole eligible interactions. Only the included interactions contribute prompt and reply copies; evidence layers remain separate.", ...notes];
}

function renderFocusedHtml(records, options) {
    const snapshot = options.snapshot, model = reportModel(records, options);
    const coverage = focusedCoverage(snapshot, model.privacyNote, model.layers);
    return `<!doctype html><html lang="en" data-evidence-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${PRODUCT_NAME} - ${escapeHtml(snapshot.title)}</title><style>${nativeReportStyles}</style></head><body><main>
${nativeReportHeader(snapshot.title)}${reportIntro(snapshot, records.length)}
<p class="report-pattern-lead">${escapeHtml(populationLead(snapshot))}</p>
<nav class="report-nav" aria-label="Report sections"><a href="#patterns">Patterns</a><a href="#examples">Interactions</a><a href="#timing">Timing</a><a href="#coverage">Coverage</a></nav>
${patternsHtml(snapshot)}
${includedInteractionsHtml(records, snapshot, model.layers)}
${reportResultHtml(snapshot.resultFacts, snapshot.resultText, { evaluationFacts: snapshot.evaluationFacts })}
${nativeTimingHtml(nativeReportEvidence(snapshot))}
${reportContextHtml(snapshot)}
<section id="overview"><h2>Included evidence</h2><table class="native-table"><caption>Separate evidence units, not a combined total</caption><thead><tr><th>Evidence</th><th>Count</th><th>Recorded result</th></tr></thead><tbody>${snapshot.summary.metrics.filter(metric => metric.count).map(metric => `<tr><th scope="row">${escapeHtml(metric.label)}</th><td data-label="Count">${metric.count}</td><td data-label="Recorded result">${escapeHtml(metric.reading)}</td></tr>`).join("")}</tbody></table></section>
<section id="coverage" class="reading-notes"><h2>Scope and coverage</h2>${coverage.map(note => `<p>${escapeHtml(note)}</p>`).join("")}</section>
<p class="report-footer">${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}</p></main></body></html>`;
}

function renderFocusedMarkdown(records, options) {
    const snapshot = options.snapshot, model = reportModel(records, options);
    const lines = [`# ${escapeMarkdown(snapshot.title)}`, "", reportIntro(snapshot, records.length), "",
        populationLead(snapshot), "", ...patternsMarkdown(snapshot), "## Included interactions", ""];
    for (const [index, record] of records.entries()) {
        lines.push(`<a id="${escapeHtml(record.scenarioId)}"></a>`, `### Interaction ${index + 1}`, "");
        if (snapshot.promptMode === "none") lines.push("Prompts and replies were left out of this report.", "");
        else for (const prompt of record.prompts) lines.push(...promptCopyMarkdown(prompt, snapshot));
        lines.push(...noteMarkdown(snapshot, record.scenarioId));
        for (const layer of model.layers) {
            const rows = interactionRows(record, layer);
            if (!rows.length) continue;
            lines.push(`#### ${TITLES[layer.layer]}`, "", "| Record | Tool | Operation | Recorded outcome |", "|---:|---|---|---|",
                ...rows.map((row, i) => `| ${i + 1} | ${escapeMarkdown(row.tool || "Not recorded")} | ${escapeMarkdown(row.endpoint.label)} | ${layer.layer === "code-reference" ? "Not an execution" : outcomeLabel(layer.layer, row.outcome).replace(/^succeeded$/, "completed")} |`), "");
        }
    }
    lines.push(...reportResultMarkdown(snapshot.resultFacts, snapshot.resultText, { evaluationFacts: snapshot.evaluationFacts }),
        ...nativeTimingMarkdown(nativeReportEvidence(snapshot)), ...reportContextMarkdown(snapshot),
        "## Included evidence", "", "| Evidence (separate units) | Count | Recorded result |", "|---|---:|---|",
        ...snapshot.summary.metrics.filter(metric => metric.count).map(metric => `| ${escapeMarkdown(metric.label)} | ${metric.count} | ${escapeMarkdown(metric.reading)} |`),
        "", "## Scope and coverage", "", ...focusedCoverage(snapshot, model.privacyNote, model.layers).flatMap(note => [escapeMarkdown(note), ""]),
        `${PRODUCT_NAME} - ${PRODUCT_DESCRIPTION}`, "");
    return lines.join("\n");
}
