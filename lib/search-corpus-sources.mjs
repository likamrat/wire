import { lstat } from "node:fs/promises";
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
import { promptAuthorship } from "./prompt-authorship.mjs";
import { createRequestContext } from "../web/request-context.mjs";
import { createCallInvestigation } from "../web/call-investigation.mjs";
import { createSettingsNavigation } from "../web/settings-navigation.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { corpusHash, corpusId, corpusText, comparisonDocumentText, freezeCorpus } from "./search-corpus-content.mjs";

const settings = createSettingsNavigation();
const context = createRequestContext(), calls = createCallInvestigation();
const hashPattern = /^[a-f0-9]{64}$/;
const artifactPattern = /^export-[a-f0-9-]{36}$/;
const cleanIdentity = value => typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\\/?#]/.test(value)
    && !/^(?:[a-z]:|https?:|file:)/i.test(value)
    && !textFindings(value).some(item => item.mandatory);
const route = (view, parameters = {}) => `#${view}${Object.keys(parameters).length ? "?" + new URLSearchParams(parameters) : ""}`;

export class CorpusSourceError extends Error {
    constructor(code) { super(`Search corpus unavailable (${code}).`); this.code = code; }
}

export function corpusErrorCode(error) {
    if (error instanceof CorpusSourceError || error instanceof ReportContentError || error instanceof PdfCorpusError) return error.code;
    if (["ENOENT", "ENOTDIR"].includes(error.code) || error.status === 404) return "missing";
    if (["EACCES", "EPERM"].includes(error.code)) return "inaccessible";
    if (error.status === 403) return "unauthorized";
    if (error.status === 503) return "cleanup-pending";
    if (error.status === 409 || /^stale-/.test(error.code ?? "")) return "stale-or-integrity";
    if (error instanceof SyntaxError || error instanceof TypeError || error.status === 422) return "corrupt-or-unsupported";
    return "read-failed";
}

function entry(kind, identity, { title, content, source, target, coverage = {} }) {
    if (!hashPattern.test(source.revision)) throw new CorpusSourceError("invalid-source-revision");
    const text = corpusText(content), safeTitle = corpusText(title);
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

const views = [
    ["analyze", "Analyze", "Recorded activity and interactions", "#analyze"],
    ["calls", "Calls", "Recorded calls and their exact action details", "#analyze?mode=calls"],
    ["compare-periods", "Compare periods", "Compare retained activity across two periods", "#analyze?compare=periods"],
    ["time", "Activity over time", "Recorded activity by day, week or month", "#analyze?chart=time"],
    ["category", "By category", "Recorded tool and service categories", "#analyze?chart=workload"],
    ["endpoint", "By path or operation", "Recorded API paths and operations", "#analyze?chart=endpoint"],
    ["breakdowns", "Tools and Services", "Recorded tool calls and known service involvement", "#analyze", "percentageCharts"],
    ["timing", "Recorded timing", "Compare individual recorded call durations in Calls", "#analyze?mode=calls", "activityView"],
    ["findings", "What got in the way", "Retained findings, recorded failures and known reasons", "#analyze", "homeFindings"],
    ["reports", "Saved reports", "Read approved frozen saved reports and comparisons", "#reports"],
    ["settings", "Settings", "Connection, privacy, AI reviews, display and troubleshooting", "#settings"],
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

function stamp(state, source) {
    return corpusHash([
        state.revision, state.evidenceRevision, state.evidenceFile ?? null, state.evidence ?? [],
        state.deletion ?? null, state.artifactDeletion ?? null, state.exports,
        state.personalEvaluation?.consent ?? null, state.personalEvaluation?.captures ?? [], source,
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

export function createCorpusSources(session, { source: sourceFor }) {
    if (typeof sourceFor !== "function") throw new TypeError("Search requires a current read-only source callback.");

    async function checkStateFile() {
        const file = await safeDeletionFile(resolveDataDir(session), `${BOARD_ID}.state.json`);
        const info = await lstat(file);
        if (!info.isFile()) throw new CorpusSourceError("invalid-private-state");
    }
    async function scan(check = () => {}, signal) {
        check();
        await checkStateFile();
        const state = await loadBoardState(session, { readOnly: true }), source = readSource(sourceFor, state);
        check();
        if (state.deletion?.pending) throw new CorpusSourceError("cleanup-pending");
        const records = mergeEvidenceWithState(state);
        const activity = Object.fromEntries(createRecordedResults().layers.map(layer =>
            [layer, buildActivityAnalytics(records, { layer, filters: { scope: "all", includeMetadata: true } }).rows]));
        const entries = fixedEntries(), issues = [];
        const issue = (kind, identity, code) => issues.push({ sourceId: corpusId("source", [kind, identity]), code });
        const retainedRevision = corpusHash([state.evidenceRevision, records]);
        const retainedSource = record => ({
            kind: "retained-activity", id: corpusId("source", ["interaction", record.scenarioId]),
            label: corpusText(record.sourceSessionName || "Retained local interaction"), revision: retainedRevision,
        });
        for (const record of records) {
            if (!cleanIdentity(record.scenarioId)) { issue("interaction", record.scenarioId, "invalid-target"); continue; }
            const target = { kind: "route", href: route("request", { request: record.scenarioId }) };
            const selected = context.select(records, record.scenarioId), own = selected.messages.filter(message => message.scenarioId === record.scenarioId);
            for (const message of own) {
                let completeness;
                try { completeness = retainedPromptStatus(message.source ?? { status: "unavailable" }); }
                catch (error) { issue("interaction", message.key, corpusErrorCode(error)); continue; }
                if (completeness === "unavailable" || typeof message.source?.text !== "string") {
                    issue("interaction", message.key, "text-unavailable");
                    completeness = "unavailable";
                }
                const author = promptAuthorship.read(message.source);
                entries.push(entry(message.kind === "prompt" ? "interaction" : "context", message.key, {
                    title: message.kind === "prompt" ? "Recorded request" : "Retained follow-up",
                    content: completeness === "unavailable" ? "" : message.source.text, source: retainedSource(record), target,
                    coverage: { completeness, author: author.actor, authorBasis: author.basis,
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
            const content = [tool, layer, row.outcome, row.status === null ? null : row.status,
                endpoint?.method, endpoint?.path, ...(endpoint?.queryShape ?? []),
                ...[failure?.code, failure?.reason, failure?.messageSignal].filter(value => typeof value === "string"),
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
        if (!source.available || model.consent.state !== "enabled") {
            issue("replies", "retained", !source.available ? "source-unavailable" : model.consent.state === "revoked" ? "revoked" : "not-authorized");
        } else {
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
        for (const registered of state.exports) {
            check();
            const kind = registered.kind ?? "report";
            if (!["report", "comparison"].includes(kind) || !artifactPattern.test(registered.bundleId)) {
                issue("artifact", registered.bundleId, "invalid-target"); continue;
            }
            try {
                const artifact = savedArtifact(state, registered.bundleId, kind);
                const document = kind === "report" ? await readSavedReportFile(session, state, artifact.bundleId)
                    : await readSavedComparison(session, state, artifact.bundleId);
                check();
                const revision = artifactRevision(artifact, document);
                const extracted = kind === "report" ? await extractReportFile(document, { signal })
                    : { content: comparisonDocumentText(document.comparison), coverage: {} };
                check();
                const { content } = extracted;
                if (!content.trim()) { issue(kind, artifact.bundleId, "empty-artifact-content"); continue; }
                entries.push(entry(kind, artifact.bundleId, {
                    title: kind === "report" ? "Saved report" : "Saved comparison", content,
                    source: { kind: `saved-${kind}`, id: corpusId("source", [kind, artifact.bundleId]),
                        label: kind === "report" ? "Approved frozen report" : "Approved frozen comparison", revision },
                    target: { kind: kind === "report" ? document.format === "html" ? "open-saved-report" : "open-saved-report-file" : "open-saved-comparison",
                        ...(kind === "report" && document.format !== "html" ? { format: document.format } : {}),
                        bundleId: artifact.bundleId, revision, manifestHash: artifact.manifestHash,
                        documentHash: kind === "report" ? document.sha256 : corpusHash(content) },
                    coverage: { textMode: document.artifact.promptMode ?? "unrecorded", frozen: true, ...extracted.coverage },
                }));
            } catch (error) { issue(kind, registered.bundleId, corpusErrorCode(error)); }
        }
        if (new Set(entries.map(item => item.id)).size !== entries.length) throw new CorpusSourceError("duplicate-canonical-id");
        entries.sort((a, b) => a.id.localeCompare(b.id));
        issues.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.code.localeCompare(b.code));
        return { entries: freezeCorpus(entries), issues: freezeCorpus(issues), stamp: stamp(state, source) };
    }
    async function current(frame, consume) {
        // The final synchronous publication shares the existing board writer queue.
        // Payload reads above deliberately stay outside it: the accepted reply reader owns its own guards.
        await checkStateFile();
        return exclusiveBoard(session, async state => {
            if (state.deletion?.pending || stamp(state, readSource(sourceFor, state)) !== frame.stamp) {
                throw new CorpusSourceError("stale");
            }
            for (const item of frame.entries) if (["report", "comparison"].includes(item.type)) {
                const artifact = savedArtifact(state, item.target.bundleId, item.type);
                const document = item.type === "report" ? await readSavedReportFile(session, state, artifact.bundleId)
                    : await readSavedComparison(session, state, artifact.bundleId);
                if (artifactRevision(artifact, document) !== item.source.revision) throw new CorpusSourceError("stale");
            }
            if (stamp(state, readSource(sourceFor, state)) !== frame.stamp) throw new CorpusSourceError("stale");
            return consume();
        }, { readOnly: true });
    }
    return { scan, current };
}
