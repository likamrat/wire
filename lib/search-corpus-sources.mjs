import { lstat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { BOARD_ID } from "./evidence.mjs";
import { loadBoardState, exclusiveBoard, mergeEvidenceWithState, resolveDataDir } from "./store.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { buildActivityAnalytics } from "./activity-analytics.mjs";
import { buildAssessmentModel } from "./assessment-read-model.mjs";
import { executeAssessmentAction } from "./assessment.mjs";
import { artifactIndexFingerprint, readSavedReportFile, readSavedComparison, savedArtifact } from "./report-artifacts.mjs";
import { extractReportFile, ReportContentError } from "./search-corpus-report-content.mjs";
import { PdfCorpusError } from "./search-corpus-pdf.mjs";
import { retainedPromptStatus, textFindings } from "./privacy.mjs";
import { promptAuthorship, promptAvailabilityFields } from "./prompt-authorship.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { createCallInvestigation } from "../web/call-investigation.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { corpusHash, corpusId, corpusText, comparisonDocumentText, freezeCorpus, retainedTextTitle } from "./search-corpus-content.mjs";
import { nativeActivityRows } from "./retained-population.mjs";
import { assertNativeReportRuntime, isNativeReportSource } from "./native-persistence.mjs";
import { retainedErrorDiagnostic } from "./failure-details.mjs";
import { normalizeResultEvidence } from "./result-evidence.mjs";

const settings = createSettingsNavigation();
const context = createRequestContext(), calls = createCallInvestigation();
const results = createRecordedResults();
function diagnosticText(value) {
    const diagnostic = retainedErrorDiagnostic(value);
    return diagnostic ? [diagnostic.code, diagnostic.statusCode, diagnostic.message,
        ...(diagnostic.details ?? []).flatMap(detail => [detail.code, detail.statusCode, detail.message])]
        .filter(value => value !== null && value !== undefined).join("\n") : "";
}
const hashPattern = /^[a-f0-9]{64}$/;
const artifactPattern = /^export-[a-f0-9-]{36}$/;
const cleanIdentity = value => typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\\/?#]/.test(value)
    && !/^(?:[a-z]:|https?:|file:)/i.test(value)
    && !textFindings(value).some(item => item.mandatory);
const route = (view, parameters = {}) => `#${view}${Object.keys(parameters).length ? "?" + new URLSearchParams(parameters) : ""}`;

export class CorpusSourceError extends Error {
    constructor(code) { super(`Search corpus unavailable (${code}).`); this.code = code; }
}

export function projectSavedSearchTitle(document, extractedTitle) {
    if (!Object.hasOwn(document, "canonicalTitle")) return extractedTitle;
    const title = document.canonicalTitle;
    if (typeof title !== "string" || !title.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
        throw new CorpusSourceError("invalid-canonical-title");
    }
    return title;
}

export function corpusErrorCode(error) {
    if (error instanceof CorpusSourceError || error instanceof ReportContentError || error instanceof PdfCorpusError) return error.code;
    if (/^(native-read-|native-provenance-|wire_access_)/.test(error.code ?? "")) return error.code;
    if (["ENOENT", "ENOTDIR"].includes(error.code) || error.status === 404) return "missing";
    if (["EACCES", "EPERM"].includes(error.code)) return "inaccessible";
    if (error.status === 403) return "unauthorized";
    if (error.status === 503) return "cleanup-pending";
    if (error.status === 409 || /^stale-/.test(error.code ?? "")) return "stale-or-integrity";
    if (error instanceof SyntaxError || error instanceof TypeError || error.status === 422) return "corrupt-or-unsupported";
    return "read-failed";
}

function entry(kind, identity, { title, content, source, target, coverage = {}, hasCanonicalTitle = false }) {
    if (!hashPattern.test(source.revision)) throw new CorpusSourceError("invalid-source-revision");
    const text = corpusText(content), safeTitle = hasCanonicalTitle && ["report", "comparison"].includes(kind) ? title
        : ["interaction", "context", "reply"].includes(kind) ? retainedTextTitle(text, corpusText(title)) : corpusText(title);
    const item = {
        id: corpusId(kind, identity), type: kind,
        category: ({ interaction: "Interactions", context: "Conversation context", reply: "Retained replies",
            action: "Recorded actions", tool: "Tools", service: "Services", report: "Saved reports",
            comparison: "Saved comparisons", view: "Views", setting: "Settings" })[kind],
        title: safeTitle, content: text, excerpt: text, contentHash: corpusHash(text),
        source, target, coverage,
    };
    item.revision = corpusHash(item);
    return freezeCorpus(item);
}

const sourceFactQualifications = new Set([
    "native-contract-has-no-chat-task-facts", "native-contract-has-no-chat-trigger-facts",
    "task-status-enum-unqualified", "reasoning-event-enum-unqualified",
    "trigger-is-not-execution", "confirmation-is-not-approval-or-execution",
    "original-argument-string-not-json",
    "native-contract-has-no-chat-progress-facts", "provider-progress-not-final-reply-or-tool-outcome",
]);
export const nativeSourceFactComplete = group => group.decoderLimitations.every(item => sourceFactQualifications.has(item.code));
export function sourceFactText(fact) {
    const text = [], textSources = [];
    let incomplete = fact.kind.startsWith("unsupported-") || fact.kind === "trigger-plugin";
    const missing = value => value && !["absent-in-response", "explicit-null", "recorded-empty"].includes(value.availability);
    function append(value, field) {
        if (!value) return;
        if (value.availability === "recorded" && typeof value.value === "string") {
            if (value.value.trim()) {
                text.push(value.value);
                textSources.push({ field, source: value.source });
            }
        } else if (missing(value)) incomplete = true;
    }
    function fields(values, prefix) {
        for (const name of ["name", "stepTitle", "statusLiteral", "actionId", "toolName", "functionName", "text"]) {
            append(values[name], `${prefix}.${name}`);
        }
        // Structured/opaque payloads and technical identities are not a text dump.
        for (const name of ["description", "content", "result", "references", "annotation", "confirmationMetadata",
            "outputFormatsCapabilityList", "input", "invocation"]) if (missing(values[name])) incomplete = true;
        const questions = values.questions;
        if (questions?.availability === "recorded") {
            for (const question of questions.value) {
                if (typeof question === "string") text.push(question);
                else {
                    text.push(question.question);
                    for (const option of question.options) {
                        text.push(option.label, option.submitResponse);
                        if (option.description !== undefined) text.push(option.description);
                    }
                }
            }
            textSources.push({ field: `${prefix}.questions`, source: questions.source });
        } else if (missing(questions)) incomplete = true;
        for (const name of ["steps", "reasoningItems"]) if (values[name]) {
            if (!Array.isArray(values[name])) { incomplete = true; continue; }
            for (const [index, child] of values[name].entries()) {
                if (child.kind === "unsupported-task-child") incomplete = true;
                else fields(child.fields, `${prefix}.${name}[${index}].fields`);
            }
        }
    }
    fields(fact.fields, "fields");
    for (const [index, invocation] of (fact.invocations ?? []).entries()) {
        if (invocation.historicalProjection === "unsupported-entry") incomplete = true;
        else fields(invocation.fields, `invocations[${index}].fields`);
    }
    for (const [index, action] of (fact.submitActions ?? []).entries()) fields(action.fields, `submitActions[${index}].fields`);
    return { content: text.filter(value => value.trim()).join("\n"), textSources, incomplete };
}

const views = [
    ["analyze", "Analyze", "Recorded activity and interactions", "#analyze"],
    ["calls", "Activity", "Recorded calls and their exact action details inside each interaction", "#analyze", "activityView"],
    ["compare-periods", "Compare periods", "Compare retained activity across two periods", "#analyze?compare=periods"],
    ["time", "Activity over time", "Recorded activity by day, week or month", "#analyze?chart=time"],
    ["category", "By category", "Recorded tool and service categories", "#analyze?chart=workload"],
    ["endpoint", "By path or operation", "Recorded API paths and operations", "#analyze?chart=endpoint"],
    ["breakdowns", "Tools and Services", "Recorded tool calls and known service involvement", "#analyze", "percentageCharts"],
    ["timing", "Recorded timing", "Read individual tool latencies inside each interaction", "#analyze", "activityView"],
    ["findings", "Failed calls", "Recorded tool failures and saved error information", "#analyze?result=failure", "activityView"],
    ["reports", "Saved reports", "Read approved frozen saved reports and comparisons", "#reports"],
    ["settings", "Settings", "Connection, privacy, display and troubleshooting", "#settings"],
    ["collection-status", "Collection status", "Retained history coverage and reading issues", "#collection-status"],
];

function fixedEntries() {
    const result = views.map(([id, title, content, href, focus]) => entry("view", id, {
        title, content, target: { kind: "route", href, ...(focus ? { focus } : {}) },
        source: { kind: "fixed-navigation", id: corpusId("source", ["view", id]), label: "WIRE navigation",
            revision: corpusHash([id, title, content, href, focus ?? null]) },
    }));
    for (const setting of settings.entries) {
        const resolved = settings.resolve({ setting: setting.id });
        const category = setting.view === "collection-status" ? "Collection status"
            : settings.categories.find(item => item.id === resolved.section).title;
        const href = resolved.view === "collection-status" ? route("collection-status", { setting: resolved.setting })
            : route("settings", { section: resolved.section, setting: resolved.setting });
        const content = [setting.title, category, setting.context, setting.synonyms].join("\n");
        result.push(entry("setting", setting.id, {
            title: setting.title, content, target: { kind: "route", href },
            source: { kind: "fixed-navigation", id: corpusId("source", ["setting", setting.id]), label: `Settings / ${category}`,
                revision: corpusHash([setting.id, content, href]) },
        }));
    }
    return result;
}

function stamp(state, source, nativeRevision = null) {
    return corpusHash([
        state.revision, state.evidenceRevision, state.evidenceFile ?? null, state.evidence ?? [],
        state.deletion ?? null, state.artifactDeletion ?? null, state.exports,
        state.personalEvaluation?.consent ?? null, state.personalEvaluation?.captures ?? [], source, nativeRevision,
    ]);
}

function readSource(sourceFor, state) {
    const source = sourceFor(state);
    if (!source || typeof source.then === "function" || typeof source.available !== "boolean"
        || !Number.isSafeInteger(source.sourceConfigRevision) || source.sourceConfigRevision < 0
        || source.available && !/^sourceconfig-[a-f0-9]{32}$/.test(source.sourceConfigRef)
        || source.sourceConfigRef !== null && typeof source.sourceConfigRef !== "string") {
        throw new CorpusSourceError("current-source-unavailable");
    }
    return Object.freeze(source.available
        ? { available: true, sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision }
        : { available: false, sourceConfigRef: null, sourceConfigRevision: 0 });
}

function artifactRevision(artifact, document) {
    return corpusHash([artifactIndexFingerprint(artifact), artifact.privacyReview, artifact.promptMode ?? null,
        artifact.manifestHash, artifact.kind === "comparison" ? comparisonDocumentText(document.comparison) : [document.format, document.sha256]]);
}

export function createSavedCorpusEntry(artifact, document, extracted, revision = artifactRevision(artifact, document)) {
    const kind = artifact.kind ?? "report";
    const { content } = extracted;
    const title = projectSavedSearchTitle(document, extracted.title);
    if (!content.trim() && !title?.trim()) throw new CorpusSourceError("empty-artifact-content");
    return entry(kind, artifact.bundleId, {
        title: title || (kind === "report" ? "Saved report" : "Saved comparison"), content,
        hasCanonicalTitle: Object.hasOwn(document, "canonicalTitle"),
        source: { kind: `saved-${kind}`, id: corpusId("source", [kind, artifact.bundleId]),
            label: kind === "report" ? "Approved frozen report" : "Approved frozen comparison", revision },
        target: { kind: kind === "report" ? document.format === "html" ? "open-saved-report" : "open-saved-report-file" : "open-saved-comparison",
            ...(kind === "report" && document.format !== "html" ? { format: document.format } : {}),
            bundleId: artifact.bundleId, revision, manifestHash: artifact.manifestHash,
            documentHash: kind === "report" ? document.sha256 : corpusHash(content) },
        coverage: { textMode: document.artifact.promptMode ?? "unrecorded", frozen: true, ...extracted.coverage },
    });
}

export function createCorpusSources(session, { source: sourceFor, nativeReader, reportContext }) {
    if (typeof sourceFor !== "function") throw new TypeError("Search requires a current read-only source callback.");
    if (reportContext && !isNativeReportSource(reportContext.nativeReportSource, session)) throw new CorpusSourceError("native-report-runtime-required");

    async function checkStateFile() {
        const file = await safeDeletionFile(resolveDataDir(session), `${BOARD_ID}.state.json`);
        const info = await lstat(file);
        if (!info.isFile()) throw new CorpusSourceError("invalid-private-state");
    }
    async function scan(check = () => {}, signal) {
        check();
        await checkStateFile();
        const state = await loadBoardState(session, { readOnly: true }), source = readSource(sourceFor, state);
        assertNativeReportRuntime(state, reportContext?.nativeReportSource, session);
        const native = await nativeReader?.scan();
        if (native) await setImmediate();
        check();
        if (state.deletion?.pending) throw new CorpusSourceError("cleanup-pending");
        const records = mergeEvidenceWithState(state);
        const activity = Object.fromEntries(createRecordedResults().layers.map(layer =>
            [layer, buildActivityAnalytics(records, { layer, filters: { scope: "all", includeMetadata: true } }).rows]));
        const entries = fixedEntries(), issues = [];
        const issue = (kind, identity, code, types = kind === "replies" ? ["reply"] : kind === "artifact" ? ["report", "comparison"] : [kind]) => issues.push({
            sourceId: corpusId("source", [kind, identity]), code,
            types,
        });
        const retainedRevision = corpusHash([state.evidenceRevision, records]);
        const retainedSource = record => ({
            kind: "retained-activity", id: corpusId("source", ["interaction", record.scenarioId]),
            label: corpusText(record.sourceSessionName || "Retained local interaction"), revision: retainedRevision,
        });
        let nativeItems = 0;
        async function yieldNative() {
            if (++nativeItems % 32 !== 0) return;
            await setImmediate();
            check();
            signal?.throwIfAborted();
        }
        for (const record of native?.records ?? []) {
            const conversation = record.nativeConversation;
            const source = { kind: "retained-native", id: corpusId("source", record.scenarioId),
                label: record.sourceSessionName, revision: native.revision };
            const target = { kind: "route", href: route("request", { request: record.scenarioId }) };
            for (const group of conversation.sourceObservations ?? []) {
                const incomplete = !nativeSourceFactComplete(group);
                if (incomplete) issue("context", group.observationKey, "native-source-facts-incomplete");
                for (const fact of group.facts) {
                    await yieldNative();
                    const projected = sourceFactText(fact);
                    if (projected.incomplete) issue("context", fact.key, "native-source-fact-text-unavailable");
                    if (!projected.content) continue;
                    entries.push(entry("context", fact.key, {
                        title: record.sourceSessionName, content: projected.content, source,
                        target: { ...target, focus: `native-source-fact-${encodeURIComponent(fact.key)}` },
                        coverage: { sourceId: record.sourceId, scope: conversation.scope,
                            sourceKey: group.sourceKey, observationKey: group.observationKey,
                            unit: "chat-source-observation", factKey: fact.key, factKind: fact.kind, factSource: fact.source,
                            textSources: projected.textSources, sourceApplicability: group.parserProvenance.applicability,
                            completeness: incomplete || projected.incomplete ? "partial" : "full" },
                    }));
                }
            }
            for (const message of conversation.messages) {
                await yieldNative();
                const type = message.value?.author === "user" ? "interaction" : message.value?.author === "assistant" ? "reply" : "context";
                if (message.availability !== "recorded") {
                    issue(type, message.observationKey, `native-text-${message.availability}`); continue;
                }
                entries.push(entry(type, message.observationKey, {
                    title: record.sourceSessionName, content: message.value.text, source,
                    target: { ...target, focus: `native-message-${encodeURIComponent(message.observationKey)}` },
                    coverage: { sourceId: record.sourceId, scope: conversation.scope, sourceKey: message.sourceKey,
                        observationKey: message.observationKey, representation: message.value.representation,
                        author: message.value.author,
                        unit: message.parentObservationKey ? "message-representation-part" : "message-representation-observation",
                        ...(message.parentObservationKey ? { parentObservationKey: message.parentObservationKey,
                            partSource: message.evidence[0], qualification: message.reason ?? null } : {}) },
                }));
            }
            for (const layer of ["tool", "reported-api"]) for (const row of nativeActivityRows([record], layer)) {
                await yieldNative();
                const call = layer === "tool" ? conversation.calls.find(call => call.key === row.id) : null;
                const inputs = (call?.observations ?? []).flatMap(observation =>
                    ["recorded", "recorded-empty"].includes(observation.fields.input?.availability)
                        ? [typeof observation.fields.input.value === "string" ? observation.fields.input.value : JSON.stringify(observation.fields.input.value)] : []);
                entries.push(entry("action", row.id, {
                    title: row.tool ?? "Native tool name not qualified",
                    content: [...row.nativeToolNames, ...new Set(inputs), row.outcome, row.status, row.errorCode].filter(value => value !== null && value !== undefined).join("\n"),
                    source, target: { kind: "route", href: route("request", { request: record.scenarioId, layer, call: row.id }) },
                    coverage: { sourceId: record.sourceId, scope: conversation.scope, layer,
                        unit: row.countUnit, outcome: row.outcome, attribution: "native-source-observation" },
                }));
            }
        }
        for (const record of records) {
            if (!cleanIdentity(record.scenarioId)) { issue("interaction", record.scenarioId, "invalid-target", ["interaction", "context"]); continue; }
            const target = { kind: "route", href: route("request", { request: record.scenarioId }) };
            const selected = context.select(records, record.scenarioId), own = selected.messages.filter(message => message.scenarioId === record.scenarioId);
            for (const message of own) {
                const type = message.kind === "prompt" ? "interaction" : "context";
                const availability = promptAvailabilityFields(message.source);
                let completeness;
                try { completeness = retainedPromptStatus(message.source ?? { status: "unavailable" }); }
                catch (error) { issue(type, message.key, corpusErrorCode(error)); continue; }
                if (completeness === "unavailable" || typeof message.source?.text !== "string") {
                    if (availability.activityState !== "automatic") issue(type, message.key, "text-unavailable");
                    completeness = "unavailable";
                }
                const author = promptAuthorship.read(message.source);
                const display = promptAuthorship.display(message.source);
                entries.push(entry(type, message.key, {
                    title: display.automatic ? display.label
                        : message.kind === "prompt" ? "Recorded request" : "Retained follow-up",
                    content: completeness === "unavailable" ? "" : message.source.text, source: retainedSource(record), target,
                    coverage: { completeness, ...availability, author: author.actor, authorBasis: author.basis,
                        relation: message.relation, gaps: [...selected.gaps], limitation: selected.limitation,
                        linkedInteractions: selected.groups.map(group => corpusId("interaction", `prompt:${group.scenario.scenarioId}`)) },
                }));
            }
        }
        const toolEntries = new Map(), serviceEntries = new Map();
        for (const [layer, rows] of Object.entries(activity)) for (const row of rows) {
            const record = records.find(item => item.scenarioId === row.scenarioId);
            if (!record || !cleanIdentity(record.scenarioId)) { issue("action", row.id, "invalid-target"); continue; }
            const request = { request: record.scenarioId, layer, call: row.id,
                ...(layer === "reported-api" ? { callRevision: String(state.revision) } : {}) };
            const resolved = calls.resolve(activity, records, request, state.revision);
            if (resolved.status !== "available") { issue("action", [layer, row.id], "invalid-target"); continue; }
            if ([record.sourceSessionId, row.toolCallId, row.activityId, row.recordId, resolved.source.startEventId]
                .some(value => value !== null && value !== undefined && !cleanIdentity(value))) {
                issue("action", [layer, row.id], "invalid-target"); continue;
            }
            const tool = row.tool;
            const endpoint = row.endpoint;
            const failure = layer === "tool" && resolved.source.failureEvidence?.version === 1 ? resolved.source.failureEvidence : null;
            const diagnostics = layer === "tool" ? [failure?.diagnostic, normalizeResultEvidence(resolved.source.resultEvidence)?.diagnostic,
                ...(resolved.source.apiResults ?? []).map(result => result.errorDiagnostic)]
                : layer === "reported-api" ? [results.returnedResult(resolved.source, row)?.errorDiagnostic] : [];
            const content = [tool, layer, row.outcome, row.status === null ? null : row.status,
                endpoint?.method, endpoint?.path, ...(endpoint?.queryShape ?? []),
                ...[failure?.code, failure?.reason, failure?.messageSignal].filter(value => typeof value === "string"),
                ...diagnostics.map(diagnosticText).filter(Boolean),
                ...(row.serviceAssociation?.services ?? []).map(service => typeof service === "string" ? service : service.service),
            ].filter(value => value !== null && value !== undefined).join("\n");
            entries.push(entry("action", [layer, row.id], {
                title: tool || "Recorded action", content, source: retainedSource(record),
                target: { kind: "route", href: route("request", request) },
                coverage: { layer, outcome: row.outcome, attribution: row.serviceAssociation?.status ?? "unavailable" },
            }));
            const listReachable = layer === "http" || row.workload !== "Platform metadata";
            if (listReachable && tool && !toolEntries.has(tool)) toolEntries.set(tool, layer);
            for (const service of listReachable ? row.serviceAssociation?.services ?? [] : []) {
                const name = typeof service === "string" ? service : service.service;
                if (typeof name === "string" && !serviceEntries.has(name)) serviceEntries.set(name, layer);
            }
        }
        for (const [type, names] of [["tool", toolEntries], ["service", serviceEntries]]) for (const [name, layer] of names) {
            if (corpusText(name) !== name) { issue(type, name, "invalid-target"); continue; }
            entries.push(entry(type, name, {
                title: name, content: name,
                source: { kind: "retained-activity", id: corpusId("source", [type, name]), label: "Recorded activity", revision: retainedRevision },
                target: { kind: "route", href: route("analyze", { layer, scope: "all", [type === "tool" ? "tool" : "services"]: name }) },
                coverage: { layer },
            }));
        }
        const model = buildAssessmentModel(state, { source });
        const captures = state.personalEvaluation?.captures ?? [];
        if ((!source.available || model.consent.state !== "enabled") && (records.length || !native)) {
            issue("replies", "retained", !source.available ? "source-unavailable" : model.consent.state === "revoked" ? "revoked" : "not-authorized");
        } else if (source.available && model.consent.state === "enabled") {
            for (const capture of captures) {
                check();
                const { interactionRef, observationRef } = capture.observation;
                const view = model.details.get(interactionRef), internal = model.internals.get(interactionRef);
                const record = internal?.record;
                if (!view?.observations.some(item => item.observationRef === observationRef) || !record || !cleanIdentity(record.scenarioId)) {
                    issue("reply", observationRef, "unauthorized"); continue;
                }
                try {
                    const result = await executeAssessmentAction(session, "search-corpus", "get_interaction_evidence", {
                        schemaVersion: 1, interactionRef, observationRef, expectedBasis: model.basis,
                    }, { source: current => readSource(sourceFor, current), readOnly: true });
                    check();
                    entries.push(entry("reply", observationRef, {
                        title: "Retained Copilot reply", content: result.data.text,
                        source: { kind: "retained-reply", id: corpusId("source", ["reply", observationRef]),
                            label: "Locally retained Copilot reply", revision: corpusHash([capture, model.basis, source]) },
                        target: { kind: "route", href: route("request", { request: record.scenarioId }) },
                        coverage: { completeness: result.data.completeness, finality: result.data.finality, author: "assistant" },
                    }));
                } catch (error) { issue("reply", observationRef, corpusErrorCode(error)); }
            }
            if (!captures.length) issue("replies", "retained", "not-retained");
        }
        let hasNativeArtifacts = false;
        const readArtifacts = async (artifactState, registeredEntries, assertCurrent = () => {}) => {
            if (artifactState.revision !== state.revision) throw new CorpusSourceError("stale");
            for (const registered of registeredEntries) {
                check();
                const kind = registered.kind ?? "report";
                if (!["report", "comparison"].includes(kind) || !artifactPattern.test(registered.bundleId)) {
                    issue("artifact", registered.bundleId, "invalid-target"); continue;
                }
                try {
                    const artifact = savedArtifact(artifactState, registered.bundleId, kind);
                    const document = kind === "report" ? await readSavedReportFile(session, artifactState, artifact.bundleId)
                        : await readSavedComparison(session, artifactState, artifact.bundleId);
                    check();
                    const revision = artifactRevision(artifact, document);
                    const extracted = kind === "report" ? await extractReportFile(document, { signal })
                        : { content: comparisonDocumentText(document.comparison), coverage: {} };
                    check();
                    assertCurrent();
                    if (artifact.nativeEvidenceHash || artifact.nativeComparisonHash) hasNativeArtifacts = true;
                    entries.push(createSavedCorpusEntry(artifact, document, extracted, revision));
                } catch (error) { issue(kind, registered.bundleId, corpusErrorCode(error)); }
            }
            assertCurrent();
        };
        if (reportContext) await reportContext.nativeReportSource.readSaved({ bundleIds: null }, reportContext.nativeReportAdmission, readArtifacts);
        else await readArtifacts(state, state.exports);
        if (new Set(entries.map(item => item.id)).size !== entries.length) throw new CorpusSourceError("duplicate-canonical-id");
        entries.sort((a, b) => a.id.localeCompare(b.id));
        issues.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.code.localeCompare(b.code));
        return { entries: freezeCorpus(entries), issues: freezeCorpus(issues), stamp: stamp(state, source, native?.revision), native, hasNativeArtifacts };
    }
    async function current(frame, consume) {
        // The final synchronous publication shares the existing board writer queue.
        // Payload reads above deliberately stay outside it: the accepted reply reader owns its own guards.
        await checkStateFile();
        if (reportContext || frame.hasNativeArtifacts) {
            if (!reportContext || frame.native && typeof nativeReader?.assertCurrent !== "function") {
                throw new CorpusSourceError("native-report-publication-unavailable");
            }
            const bundleIds = frame.entries.filter(item => ["report", "comparison"].includes(item.type)).map(item => item.target.bundleId);
            return reportContext.nativeReportSource.readSaved({ bundleIds }, reportContext.nativeReportAdmission,
                async (state, entries, assertCurrent, actual) => {
                    if (!actual) throw new CorpusSourceError("native-report-locked-state-unavailable");
                    assertNativeReportRuntime(actual, reportContext.nativeReportSource, session);
                    if (actual.revision !== state.revision || stamp(actual, readSource(sourceFor, actual), frame.native?.revision) !== frame.stamp) {
                        throw new CorpusSourceError("stale");
                    }
                    for (const item of frame.entries) if (["report", "comparison"].includes(item.type)) {
                        const artifact = savedArtifact(state, item.target.bundleId, item.type);
                        const document = item.type === "report" ? await readSavedReportFile(session, state, artifact.bundleId)
                            : await readSavedComparison(session, state, artifact.bundleId);
                        if (artifactRevision(artifact, document) !== item.source.revision) throw new CorpusSourceError("stale");
                    }
                    assertCurrent();
                    if (frame.native) {
                        const checked = nativeReader.assertCurrent(frame.native);
                        if (checked && typeof checked.then === "function") Promise.resolve(checked).catch(() => {});
                        if (checked !== true) throw new CorpusSourceError("native-report-publication-unavailable");
                    }
                    const result = consume();
                    if (result && typeof result.then === "function") {
                        Promise.resolve(result).catch(() => {});
                        throw new CorpusSourceError("native-report-publication-must-be-synchronous");
                    }
                    return result;
                });
        }
        return exclusiveBoard(session, async state => {
            assertNativeReportRuntime(state, reportContext?.nativeReportSource, session);
            if (state.deletion?.pending || stamp(state, readSource(sourceFor, state), frame.native?.revision) !== frame.stamp) {
                throw new CorpusSourceError("stale");
            }
            for (const item of frame.entries) if (["report", "comparison"].includes(item.type)) {
                const artifact = savedArtifact(state, item.target.bundleId, item.type);
                const document = item.type === "report" ? await readSavedReportFile(session, state, artifact.bundleId)
                    : await readSavedComparison(session, state, artifact.bundleId);
                if (artifactRevision(artifact, document) !== item.source.revision) throw new CorpusSourceError("stale");
            }
            if (stamp(state, readSource(sourceFor, state), frame.native?.revision) !== frame.stamp) throw new CorpusSourceError("stale");
            return frame.native ? nativeReader.publish(frame.native, consume) : consume();
        }, { readOnly: true });
    }
    return { scan, current };
}
