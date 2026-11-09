import { lstat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BoardError, resolveDataDir } from "./store.mjs";
import { buildAnalytics } from "./analytics.mjs";
import { classifyWorkload } from "./graph-history.mjs";
import { inspectSavedReportSnapshot } from "./saved-report-snapshot.mjs";
import { adaptEvaluationReport, freezeEvaluationFacts } from "./report-facts.mjs";
import { inspectReportResultFacts } from "./report-result-facts.mjs";
import { inspectReportResultText, validateComparisonResultText } from "./report-result-text-shape.mjs";
import { artifactDeletionKey } from "./deletion-identities.mjs";
import { restoreOneSidedMetricDisplay } from "./report-comparison-compatibility.mjs";
import { validatePeriodReport } from "./period-report.mjs";
import { reportIdentity } from "./report-identity.mjs";
import { inspectNativeReportNamespace } from "./native-report-shape.mjs";
import { assertNativeArtifactMutation } from "./native-artifact-mutation.mjs";
import { hostPaths } from "./host-paths.mjs";
import { hasReportSaveAuthorization, assertReportSaveAuthorization } from "./report-save-consent.mjs";
import { inspectReportPopulation } from "./report-population.mjs";
import { inspectReportNotes } from "./report-notes.mjs";
import { inspectReportPatterns } from "./report-patterns.mjs";
import { renderHtmlReport } from "./product-report.mjs";
import { renderPeriodReportHtml } from "./period-report-output.mjs";
import { renderComparisonHtml, hasCurrentReportPresentation } from "./report-presentation.mjs";
import { nativeReportStyles } from "./native-report-output.mjs";
import { marked } from "marked";

export const reportHash = value => createHash("sha256").update(value).digest("hex");
export const SAVED_REPORT_MAX_BYTES = 32 * 1024 * 1024;
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validId = value => typeof value === "string" && /^export-[a-f0-9-]{36}$/.test(value);
const samePath = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export const artifactKind = entry => entry.kind ?? "report";
const isDeleted = (state, entry) => state.artifactDeletion?.identities?.includes(artifactDeletionKey(artifactKind(entry), entry.bundleId)) === true;
function assertReadableEntry(entry) {
    if (Object.hasOwn(entry, "nativeSourceBinding")) {
        throw new BoardError("This native report requires a current account-authorized saved-report read.", 403);
    }
}
function assertSavedAuthorization(manifest, entry) {
    try {
        assertReportSaveAuthorization(manifest, entry);
        if (entry.savePolicy !== manifest.savePolicy) throw new TypeError("Saved report policy differs from its manifest.");
        const population = inspectReportPopulation(manifest);
        if (population && (entry.reportPurpose !== population.focus.preset
            || JSON.stringify(entry.reportPeriod) !== JSON.stringify(manifest.dateSelection))
            || !population && (entry.reportPurpose !== undefined || entry.reportPeriod !== undefined)) {
            throw new TypeError("Saved report purpose or period differs from its manifest.");
        }
        inspectReportNotes(manifest);
        inspectReportPatterns(manifest);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new BoardError("This report's save confirmation or frozen contents could not be verified.", 422);
    }
}
export function savedArtifact(state, bundleId, kind) {
    if (!validId(bundleId)) throw new BoardError("Choose a saved report by its report ID.", 422);
    const entry = state.exports?.find(item => item.bundleId === bundleId);
    if (!entry || isDeleted(state, entry) || kind && artifactKind(entry) !== kind) throw new BoardError("This saved report is no longer available.", 404);
    return entry;
}
export function artifactIndexFingerprint(entry) {
    return reportHash(JSON.stringify({
        bundleId: entry.bundleId, kind: artifactKind(entry), files: entry.files,
        formats: entry.formats, snapshotHash: entry.snapshotHash ?? null, manifestHash: entry.manifestHash ?? null,
        ...(entry.nativeEvidenceHash !== undefined ? { nativeEvidenceHash: entry.nativeEvidenceHash } : {}),
        ...(entry.nativeComparisonHash !== undefined ? { nativeComparisonHash: entry.nativeComparisonHash } : {}),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
        ...(entry.reportPurpose !== undefined ? { reportPurpose: entry.reportPurpose, reportPeriod: entry.reportPeriod } : {}),
        ...(entry.reportType !== undefined || entry.periodComparisonHash !== undefined
            ? { reportType: entry.reportType, periodComparisonHash: entry.periodComparisonHash } : {}),
    }));
}
export function assertSavedReportDependencies(sources, state) {
    if (!Array.isArray(sources) || sources.length !== 2 || new Set(sources.map(source => source?.bundleId)).size !== 2) {
        throw new BoardError("Choose two different saved reports.", 422);
    }
    for (const source of sources) {
        if (!validHash(source.snapshotHash)) throw new BoardError("Saved report snapshot identity is unavailable.", 422);
        const entry = savedArtifact(state, source.bundleId, "report");
        if (entry.snapshotHash && entry.snapshotHash !== source.snapshotHash
            || source.indexFingerprint && artifactIndexFingerprint(entry) !== source.indexFingerprint) {
            throw new BoardError("A comparison source changed or was deleted. Prepare a fresh comparison.", 409);
        }
    }
    return true;
}
export const validateSavedSources = (state, sources) => assertSavedReportDependencies(sources, state);
export function assertArtifactWritable(state, bundleId, kind) {
    if (!state || !Array.isArray(state.exports)) throw new BoardError("Export requires the current serialized store state.", 428);
    if (!validId(bundleId) || !["report", "comparison"].includes(kind)) throw new BoardError("Invalid report artifact identity.", 422);
    if (state.artifactDeletion?.identities?.includes(artifactDeletionKey(kind, bundleId))
        || state.exports.some(entry => entry.bundleId === bundleId)) {
        throw new BoardError("This artifact identity is already saved or deleted. Nothing written.", 409);
    }
}
const nativeArtifact = entry => Object.hasOwn(entry, "nativeEvidenceHash") || Object.hasOwn(entry, "nativeSourceBinding") || Object.hasOwn(entry, "nativeComparisonHash");
const nativeArtifactDependency = (entry, state) => state.exports.some(item => artifactKind(item) === "comparison"
    && item.sourceReports?.some(source => source.bundleId === entry.bundleId) && nativeArtifact(item));

export function describeSavedArtifact(entry, state, { authorization, session } = {}) {
    if (authorization !== undefined) assertNativeArtifactMutation(authorization, session, state, entry.bundleId);
    else assertReadableEntry(entry);
    const kind = artifactKind(entry);
    const paired = entry.reportType === "period-comparison";
    const eligible = kind === "report" && !paired && Boolean(entry.nativeEvidenceHash || entry.evaluationFactsHash || entry.files?.["product-report.json"]);
    return {
        bundleId: entry.bundleId, kind, preparedAt: entry.preparedAt, preparedAtDisplay: entry.preparedAtDisplay,
        ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}),
        formats: [...entry.formats ?? []], promptMode: entry.promptMode,
        ...(entry.reportPurpose === undefined ? {} : { reportPurpose: entry.reportPurpose, reportPeriod: structuredClone(entry.reportPeriod) }),
        ...(entry.timeContext === undefined ? {} : { timeContext: structuredClone(entry.timeContext) }),
        canDelete: authorization !== undefined || !nativeArtifact(entry) && !nativeArtifactDependency(entry, state),
        ...(paired ? { reportType: "period-comparison", population: "Two frozen matching-record cohorts; supporting copies are not a third cohort." } : {}),
        ...(Number.isSafeInteger(entry.selectionScope?.requestGroups) && entry.selectionScope.requestGroups >= 0
            ? { requestGroupCount: entry.selectionScope.requestGroups } : {}),
        ...(Number.isSafeInteger(entry.selectionScope?.nativeConversations) && entry.selectionScope.nativeConversations >= 0
            ? { nativeConversationCount: entry.selectionScope.nativeConversations } : {}),
        comparisonEligibility: eligible ? entry.nativeEvidenceHash ? "native-frozen-evidence" : entry.evaluationFactsHash ? "available" : "legacy-outcomes-only"
            : paired ? "period-report-has-two-cohorts-not-one-source" : kind === "comparison" ? "comparison-is-not-a-source-report" : "structured-facts-not-saved",
        retainedComparisonCount: (state.exports ?? []).filter(item => artifactKind(item) === "comparison" && !isDeleted(state, item)
            && item.sourceReports?.some(source => source.bundleId === entry.bundleId)).length,
        ...(kind === "comparison" ? {
            sourceReports: (entry.sourceReports ?? []).map(source => ({
                bundleId: source.bundleId, snapshotHash: source.snapshotHash,
                available: (state.exports ?? []).some(item => item.bundleId === source.bundleId && artifactKind(item) === "report" && !isDeleted(state, item)),
            })),
        } : {}),
    };
}
async function checkedManagedPath(session, entry, name, assertCurrent = () => {}) {
    assertCurrent();
    const root = path.join(resolveDataDir(session), "exports");
    const bundleRoot = path.join(root, entry.bundleId);
    const registeredTarget = entry.files?.[name];
    if (typeof name !== "string" || !name.length || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)
        || typeof registeredTarget !== "string") throw new BoardError("Saved report file ownership is invalid.", 422);
    const registeredFolder = entry.bundleDir ?? hostPaths.describe(registeredTarget).directory;
    if (typeof registeredFolder !== "string") throw new BoardError("Saved report folder is invalid.", 422);
    const folder = [bundleRoot, path.join(bundleRoot, "files")].find(candidate => hostPaths.same(candidate, registeredFolder));
    if (!folder || !hostPaths.same(path.join(folder, name), registeredTarget)) {
        throw new BoardError("Saved report file is outside its registered bundle.", 422);
    }
    const target = path.join(folder, name);
    for (const directory of new Set([root, bundleRoot, folder])) {
        const info = await lstat(directory);
        assertCurrent();
        if (!info.isDirectory() || info.isSymbolicLink()) throw new BoardError("Linked report folders cannot be read for comparison.", 422);
    }
    const info = await lstat(target);
    assertCurrent();
    if (!info.isFile() || info.isSymbolicLink()) throw new BoardError("Saved report file is linked or unsupported.", 422);
    const realFolder = await realpath(folder);
    assertCurrent();
    const realFile = await realpath(target);
    assertCurrent();
    if (!samePath(path.dirname(realFile), realFolder)) throw new BoardError("Saved report file is outside its owned folder.", 422);
    return { target, info, layout: folder === bundleRoot ? "bundle-root" : "files" };
}
async function readManagedFile(session, entry, name) {
    const { target, info } = await checkedManagedPath(session, entry, name);
    if (info.size > SAVED_REPORT_MAX_BYTES) throw new BoardError("Saved report file is too large to compare.", 422);
    const bytes = await readFile(target);
    if (bytes.length > SAVED_REPORT_MAX_BYTES) throw new BoardError("Saved report file is too large to compare.", 422);
    return bytes;
}
export function createSavedArtifactDescriptor(session) {
    return async (state, { artifactKind: kind, artifactId }, authorization) => {
        if (!["report", "comparison"].includes(kind)) throw new BoardError("Choose a saved report or comparison.", 422);
        const entry = savedArtifact(state, artifactId, kind);
        const assertCurrent = () => {
            if (authorization !== undefined) assertNativeArtifactMutation(authorization, session, state, artifactId);
            else if (nativeArtifact(entry) || nativeArtifactDependency(entry, state)) {
                throw Object.assign(new BoardError("Deleting native or mixed reports requires account-bound artifact admission. Nothing was deleted.", 503),
                    { code: "NATIVE_REPORT_DELETION_UNAVAILABLE" });
            }
        };
        assertCurrent();
        const prefix = kind === "comparison" ? "comparison-report" : "product-report";
        const allowed = new Set(["coverage-and-redaction-manifest.json", ...["html", "pdf", "json", "md"].map(extension => `${prefix}.${extension}`)]);
        const files = [];
        let layout;
        for (const name of Object.keys(entry.files ?? {}).sort()) {
            const checked = await checkedManagedPath(session, entry, name, assertCurrent);
            assertCurrent();
            if (layout && layout !== checked.layout) throw new BoardError("Mixed saved report layouts require review. Nothing deleted.", 422);
            layout = checked.layout;
            if (layout === "files" && !allowed.has(name)) throw new BoardError("This report has an unrecognized file inventory. Nothing deleted.", 422);
            const hash = createHash("sha256");
            for await (const bytes of createReadStream(checked.target)) { assertCurrent(); hash.update(bytes); }
            assertCurrent();
            files.push({ name, sha256: hash.digest("hex") });
        }
        if (!files.length) throw new BoardError("This saved report has no indexed files. Nothing deleted.", 422);
        const manifest = files.find(file => file.name === "coverage-and-redaction-manifest.json");
        if (!manifest && layout !== "bundle-root") throw new BoardError("The saved report manifest is missing. Nothing deleted.", 422);
        assertCurrent();
        return {
            bundleId: entry.bundleId, kind, layout, files, manifestHash: manifest?.sha256 ?? null,
            inventoryHash: reportHash(JSON.stringify({ bundleId: entry.bundleId, kind, layout, files })),
            dependentComparisons: (state.exports ?? []).filter(item => artifactKind(item) === "comparison"
                && item.bundleId !== entry.bundleId && item.sourceReports?.some(source => source.bundleId === entry.bundleId))
                .map(item => ({ bundleId: item.bundleId })),
        };
    };
}
function legacyEnvelope(snapshot, metadata) {
    if (snapshot.records.some(record => !/^session-[a-f0-9]{16}$/.test(record.sourceSessionId)
        || (record.toolCalls ?? []).some(call => call.toolCallId != null && !/^call-[a-f0-9]{16}$/.test(call.toolCallId)
            || call.toolCallId == null && !/^event-[a-f0-9]{16}$/.test(call.startEventId)))) {
        throw new BoardError("Older report identities are not a supported privacy projection.", 422);
    }
    const analytics = buildAnalytics(snapshot.records, { filters: { scope: "all" } });
    const patterns = new Map();
    const toolRows = analytics.rows.map(row => {
        const endpoints = (row.targets?.length ? row.targets : [row.endpoint]).filter(endpoint => endpoint.path !== null).map(endpoint => ({
            pathTemplate: endpoint.path, method: endpoint.method, apiVersion: endpoint.apiVersion, queryKeys: endpoint.queryShape,
        }));
        const shape = { tool: row.tool, endpoints: [...endpoints].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
        const patternId = `legacy-pattern-${reportHash(JSON.stringify(shape)).slice(0, 32)}`;
        patterns.set(patternId, {
            patternId, unitKind: "tool-call", tool: row.tool,
            workload: classifyWorkload(row.endpoint, row.tool, row.targets),
            attribution: endpoints.length > 1 ? "requested-batch-targets" : endpoints.length ? "requested-single-target" : "unavailable",
            targetShape: endpoints.length > 1 ? "multiple" : endpoints.length ? "single" : "unavailable",
            endpoints, available: true,
        });
        return { id: row.id, patternId, outcome: row.outcome };
    });
    return {
        schemaVersion: 1, ...metadata, preparedAt: snapshot.preparedAt, namespace: null, patternVersion: 2,
        metrics: [], toolRows, patterns: [...patterns.values()],
        scope: {
            selectionKind: snapshot.selectionScope?.kind ?? null, timeZone: snapshot.timeContext?.timeZone ?? null,
            collectionDefinition: null, callTimesAvailable: false, historyComplete: false,
        },
    };
}
export async function loadSavedReportSource(session, state, bundleId) {
    const entry = savedArtifact(state, bundleId, "report");
    assertReadableEntry(entry);
    if (entry.reportType === "period-comparison") throw new BoardError("This period report contains two frozen cohorts, not one source report for an ordinary saved-report comparison. Open its frozen comparison directly.", 422);
    if (!hasReportSaveAuthorization(entry.privacyReview)) throw new BoardError("This report has no verified save confirmation.", 422);
    const bytes = await readManagedFile(session, entry, "coverage-and-redaction-manifest.json");
    const manifestHash = reportHash(bytes);
    if (entry.manifestHash && manifestHash !== entry.manifestHash) throw new BoardError("Saved report manifest changed.", 409);
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved report manifest is not readable JSON.", 422);
    }
    if (manifest.bundleId !== bundleId || !hasReportSaveAuthorization(manifest.privacyReview) || !validHash(manifest.snapshotHash)) {
        throw new BoardError("Saved report identity or disclosure approval is invalid.", 422);
    }
    assertSavedTitle(entry, manifest);
    assertSavedAuthorization(manifest, entry);
    const nativeEvidence = await inspectNativeManifest(session, entry, manifest, bytes);
    const resultFacts = inspectReportResultFacts(manifest);
    const resultText = inspectReportResultText(manifest);
    if (nativeEvidence) return {
        reference: { bundleId, snapshotHash: manifest.snapshotHash },
        dependency: { bundleId, snapshotHash: manifest.snapshotHash, indexFingerprint: artifactIndexFingerprint(entry), manifestHash },
        envelope: { schemaVersion: 2, bundleId, snapshotHash: manifest.snapshotHash,
            disclosureReviewed: manifest.privacyReview.reviewerConfirmed === true,
            ...(manifest.privacyReview.localSave ? { localSaveConfirmed: true } : {}),
            nativeEvidence, ...(resultFacts ? { resultFacts } : {}) },
        nativeEvidence, facts: null, resultFacts, resultText, namespaceProvenanceVerified: true,
    };
    if (manifest.periodComparison !== undefined) throw new BoardError("This period report contains two frozen cohorts, not one source report for an ordinary saved-report comparison.", 422);
    const metadata = { bundleId, snapshotHash: manifest.snapshotHash,
        disclosureReviewed: manifest.privacyReview.reviewerConfirmed === true,
        ...(manifest.privacyReview.localSave ? { localSaveConfirmed: true } : {}) };
    let facts = null, envelope;
    if (manifest.evaluationFacts) {
        facts = freezeEvaluationFacts(manifest.evaluationFacts);
        const hash = reportHash(JSON.stringify(facts));
        if (hash !== manifest.evaluationFactsHash || entry.evaluationFactsHash && entry.evaluationFactsHash !== hash) {
            throw new BoardError("Saved evaluation facts changed.", 409);
        }
        envelope = adaptEvaluationReport(facts, metadata);
    } else {
        const snapshotBytes = entry.files?.["product-report.json"] ? await readManagedFile(session, entry, "product-report.json") : undefined;
        let inspected;
        try {
            inspected = inspectSavedReportSnapshot({
                manifestBytes: bytes, snapshotBytes, expectedManifestSha256: entry.manifestHash, expectedBundleId: bundleId,
            });
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new BoardError(error.message, 422);
        }
        if (inspected.status !== "supported") throw new BoardError(`This older report cannot be compared: ${inspected.reason}. Its original files remain available.`, 422);
        envelope = legacyEnvelope(inspected.snapshot, metadata);
    }
    return {
        reference: { bundleId, snapshotHash: manifest.snapshotHash },
        dependency: { bundleId, snapshotHash: manifest.snapshotHash, indexFingerprint: artifactIndexFingerprint(entry), manifestHash },
        envelope: { ...envelope, ...(resultFacts ? { resultFacts } : {}) }, facts, resultFacts, resultText,
        namespaceProvenanceVerified: Boolean(entry.manifestHash && entry.evaluationFactsHash && facts),
    };
}

async function readReportFile(session, entry, name) {
    try { return await readManagedFile(session, entry, name); }
    catch (error) {
        if (error.code === "ENOENT") throw new BoardError("This saved report file is no longer available. Nothing was regenerated.", 404);
        throw error;
    }
}
function assertSavedTitle(entry, manifest) {
    if (manifest.title !== undefined && (typeof manifest.title !== "string" || !manifest.title.trim()
        || /[\u0000-\u001f\u007f]/.test(manifest.title) || manifest.title !== entry.title)) {
        throw new BoardError("Saved report title differs from its reviewed manifest.", 409);
    }
}
async function readReportManifest(session, entry) {
    assertReadableEntry(entry);
    if (!hasReportSaveAuthorization(entry.privacyReview) || !validHash(entry.manifestHash)) {
        throw new BoardError("This report's saved disclosure approval cannot be verified.", 422);
    }
    const manifestBytes = await readReportFile(session, entry, "coverage-and-redaction-manifest.json");
    if (reportHash(manifestBytes) !== entry.manifestHash) throw new BoardError("Saved report manifest changed.", 409);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved report manifest is not readable JSON.", 422);
    }
    if (manifest.bundleId !== entry.bundleId || manifest.kind === "comparison" || !hasReportSaveAuthorization(manifest.privacyReview)) {
        throw new BoardError("Saved report identity or disclosure approval is invalid.", 422);
    }
    assertSavedTitle(entry, manifest);
    assertSavedAuthorization(manifest, entry);
    await inspectNativeManifest(session, entry, manifest, manifestBytes);
    if (manifest.periodComparison !== undefined || manifest.periodComparisonHash !== undefined || entry.reportType === "period-comparison" || entry.periodComparisonHash !== undefined) {
        validatePeriodReport(manifest.periodComparison);
        if (entry.reportType !== "period-comparison" || manifest.kind !== "report" || manifest.evaluationFacts !== undefined
            || reportHash(JSON.stringify(manifest.periodComparison)) !== manifest.periodComparisonHash
            || entry.periodComparisonHash !== manifest.periodComparisonHash) throw new BoardError("Saved period-report facts changed.", 409);
    }
    return { manifest, manifestBytes };
}
async function inspectNativeManifest(session, entry, manifest, manifestBytes) {
    try {
        const native = inspectNativeReportNamespace(manifest, undefined, entry.nativeEvidenceHash);
        if (!native) return null;
        if (!validHash(entry.nativeEvidenceHash) || !validHash(entry.manifestHash) || Object.hasOwn(entry, "evaluationFactsHash")
            || entry.snapshotHash !== manifest.snapshotHash) throw new TypeError("Native report index binding is invalid.");
        const snapshotBytes = manifest.formats.includes("json") ? await readReportFile(session, entry, "product-report.json") : undefined;
        const inspected = inspectSavedReportSnapshot({ manifestBytes, snapshotBytes,
            expectedManifestSha256: entry.manifestHash, expectedBundleId: entry.bundleId });
        if (inspected.status !== "supported" || !inspected.nativeEvidence) throw new TypeError("Native frozen report evidence is unavailable.");
        return inspected.nativeEvidence;
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new BoardError("Saved native report evidence is invalid or differs from its reviewed manifest. Nothing was regenerated.", 422);
    }
}
const reportFiles = Object.freeze({
    html: { name: "product-report.html", mediaType: "text/html", label: "HTML" },
    json: { name: "product-report.json", mediaType: "application/json", label: "JSON" },
    markdown: { name: "product-report.md", mediaType: "text/markdown", label: "Markdown" },
    pdf: { name: "product-report.pdf", mediaType: "application/pdf", label: "PDF" },
});
async function readReportBytes(session, entry, manifest, format) {
    const { name, label } = reportFiles[format];
    const bytes = await readReportFile(session, entry, name);
    const expected = manifest.files?.[name];
    if (!validHash(expected?.sha256) || reportHash(bytes) !== expected.sha256 || expected.bytes !== bytes.length) {
        throw new BoardError(`Saved report ${label} changed. The original saved bundle was not regenerated.`, 409);
    }
    return { bytes, sha256: expected.sha256 };
}

// Undefined format selects a saved representation; a declared broken file never triggers fallback.
export async function readSavedReportFile(session, state, bundleId, format) {
    if (format !== undefined && (typeof format !== "string" || !Object.hasOwn(reportFiles, format))) throw new BoardError("Choose a supported saved report format.", 422);
    const entry = savedArtifact(state, bundleId, "report");
    const { manifest, manifestBytes } = await readReportManifest(session, entry);
    const declared = candidate => {
        const name = reportFiles[candidate].name;
        return Object.hasOwn(entry.files ?? {}, name) || Object.hasOwn(manifest.files ?? {}, name)
            || entry.formats?.includes(candidate) || manifest.formats?.includes(candidate);
    };
    format ??= Object.keys(reportFiles).find(declared);
    if (!format || !declared(format)) throw new BoardError("This report has no supported saved content file.", 404);
    const { name, mediaType } = reportFiles[format];
    for (const formats of [entry.formats, manifest.formats]) {
        if (formats === undefined && format === "html") continue;
        if (!Array.isArray(formats) || !formats.includes(format) || formats.some(value => !Object.hasOwn(reportFiles, value))) {
            throw new BoardError("Saved report format inventory is inconsistent.", 422);
        }
    }
    if (!entry.files?.[name] || !manifest.files?.[name]) throw new BoardError("A declared saved report file is unavailable. Nothing was regenerated.", 404);
    if (entry.promptMode !== undefined && entry.promptMode !== manifest.promptMode) throw new BoardError("Saved report text mode differs from its manifest.", 409);
    const { bytes, sha256 } = await readReportBytes(session, entry, manifest, format);
    let snapshot;
    if (format === "json") {
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const inspected = inspectSavedReportSnapshot({ manifestBytes, snapshotBytes: bytes,
                expectedManifestSha256: entry.manifestHash, expectedBundleId: bundleId });
            if (inspected.status !== "supported") throw new TypeError("Unsupported saved snapshot.");
            snapshot = inspected.snapshot;
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new BoardError("Saved report JSON is invalid or unsupported. Nothing was regenerated.", 422);
        }
    }
    return { artifact: describeSavedArtifact(entry, state), format, mediaType, bytes, sha256,
        manifestHash: entry.manifestHash, ...(manifest.title !== undefined ? { canonicalTitle: manifest.title } : {}),
        ...(snapshot ? { snapshot, manifest } : manifest.nativeEvidence ? { manifest } : {}) };
}

export async function readSavedReportDocument(session, state, bundleId) {
    const entry = savedArtifact(state, bundleId, "report");
    if (!entry.files?.["product-report.html"]) throw new BoardError("HTML was not saved for this report. Its saved downloads remain available.", 404);
    const { manifest } = await readReportManifest(session, entry);
    const { bytes, sha256 } = await readReportBytes(session, entry, manifest, "html");
    let html;
    try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new BoardError("Saved report HTML is not valid UTF-8.", 422);
    }
    return { artifact: describeSavedArtifact(entry, state), html, sha256, ...(manifest.title !== undefined ? { canonicalTitle: manifest.title } : {}) };
}

export async function readSavedReportView(session, state, bundleId, kind = "report", original = false) {
    const entry = original ? legacyOriginalEntry(state, bundleId, kind) : savedArtifact(state, bundleId, kind);
    const { manifest } = original
        ? { manifest: null }
        : kind === "comparison" ? await readComparisonManifest(session, entry) : await readReportManifest(session, entry);
    const prefix = kind === "comparison" ? "comparison-report" : "product-report";
    const sourceFormat = ["html", "json", "markdown", "pdf"].find(format => {
        const name = `${prefix}.${format === "markdown" ? "md" : format}`;
        return Object.hasOwn(entry.files ?? {}, name) || Object.hasOwn(manifest?.files ?? {}, name)
            || entry.formats?.includes(format) || manifest?.formats?.includes(format);
    });
    if (!sourceFormat) throw new BoardError("This report has no supported saved content. Nothing was regenerated.", 404);
    if (!original && kind === "report" && sourceFormat === "html") {
        const value = await readSavedReportDocument(session, state, bundleId);
        return { artifact: value.artifact, format: "html", sourceFormat, text: value.html };
    }
    const value = original ? await readLegacyReportOriginal(session, state, bundleId, kind, sourceFormat)
        : kind === "report" ? await readSavedReportFile(session, state, bundleId, sourceFormat)
            : await readSavedArtifactFile(session, state, bundleId, kind, sourceFormat);
    const identity = { artifact: value.artifact, sourceFormat,
        ...(original ? { source: "legacy-original", verification: "unverified" } : {}) };
    if (sourceFormat === "pdf") return { ...identity, format: "pdf", data: value.bytes.toString("base64") };
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes); }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new BoardError("Saved report text is not valid UTF-8.", 422);
    }
    if (sourceFormat === "markdown") {
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${nativeReportStyles}</style></head><body><main>${marked.parse(text, { gfm: true, async: false })}</main></body></html>`;
        if (Buffer.byteLength(html) > SAVED_REPORT_MAX_BYTES) throw new BoardError("This saved report view is too large.", 422);
        return { ...identity, format: "html", text: html };
    }
    if (sourceFormat !== "json") return { ...identity, format: sourceFormat, text };
    try {
        let snapshot = value.snapshot, privacy = manifest?.privacyReview;
        if (original) {
            const originalManifest = await readReportFile(session, entry, "coverage-and-redaction-manifest.json");
            const inspected = inspectSavedReportSnapshot({ manifestBytes: originalManifest, snapshotBytes: value.bytes,
                expectedBundleId: bundleId });
            if (inspected.status !== "supported") throw new TypeError("Unsupported original report snapshot.");
            snapshot = inspected.snapshot;
            privacy = JSON.parse(originalManifest.toString("utf8")).privacyReview;
            assertLegacyReportOriginalCurrent(state, value.binding);
        } else if (kind === "comparison") {
            snapshot = JSON.parse(text);
            if (snapshot.schemaVersion !== 3 || snapshot.kind !== "comparison" || snapshot.bundleId !== bundleId
                || reportHash(JSON.stringify(snapshot)) !== manifest.snapshotHash
                || JSON.stringify(snapshot.comparison) !== JSON.stringify(manifest.comparison)
                || JSON.stringify(snapshot.sourceFacts) !== JSON.stringify(manifest.sourceFacts)
                || JSON.stringify(snapshot.sourceReports) !== JSON.stringify(manifest.sourceReports)) {
                throw new TypeError("Saved comparison snapshot differs from its manifest.");
            }
        }
        if (!snapshot || !hasCurrentReportPresentation(snapshot)) throw new TypeError("Saved report presentation is unsupported.");
        const html = kind === "comparison" ? renderComparisonHtml(snapshot.comparison, snapshot)
            : snapshot.periodComparison ? renderPeriodReportHtml(snapshot)
                : renderHtmlReport(snapshot.records, { snapshot, privacy });
        if (Buffer.byteLength(html) > SAVED_REPORT_MAX_BYTES) throw new TypeError("Saved report view is too large.");
        return { ...identity, format: "html", text: html };
    } catch (error) {
        if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
        throw new BoardError("This saved JSON cannot be shown as a report. Its original files are unchanged.", 422);
    }
}

function legacyOriginalEntry(state, bundleId, kind) {
    if (kind !== "report") throw new BoardError("Choose a supported legacy report original.", 422);
    const entry = savedArtifact(state, bundleId, "report");
    if (!reportIdentity.legacyCandidate(entry)) {
        throw new BoardError("This item is not a supported legacy original. Its verified-file checks remain unchanged.", 422);
    }
    return entry;
}
function legacyOriginalFingerprint(entry) {
    return reportHash(JSON.stringify([artifactIndexFingerprint(entry), entry.privacyReview,
        entry.preparedAt, entry.preparedAtDisplay, entry.timeContext]));
}
export function assertLegacyReportOriginalCurrent(state, binding) {
    const entry = legacyOriginalEntry(state, binding.bundleId, "report");
    if (legacyOriginalFingerprint(entry) !== binding.fingerprint) throw new BoardError("The saved original changed during this read. Open its current entry again.", 409);
}

export async function readLegacyReportOriginal(session, state, bundleId, kind, format) {
    if (typeof format !== "string" || !Object.hasOwn(reportFiles, format)) throw new BoardError("Choose an HTML, PDF, JSON or Markdown original.", 422);
    const entry = legacyOriginalEntry(state, bundleId, kind), fingerprint = legacyOriginalFingerprint(entry);
    const manifestName = "coverage-and-redaction-manifest.json", names = entry.formats.map(value => reportFiles[value].name).sort();
    if (JSON.stringify(Object.keys(entry.files ?? {}).sort()) !== JSON.stringify([...names, manifestName].sort())) {
        throw new BoardError("The legacy original file inventory is inconsistent.", 422);
    }
    if ((await checkedManagedPath(session, entry, manifestName)).layout !== "files") throw new BoardError("This legacy original layout is unsupported.", 422);
    const manifestBytes = await readReportFile(session, entry, manifestName);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
    catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        throw new BoardError("The legacy original metadata is not readable JSON.", 422);
    }
    if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype || manifest.schemaVersion !== 3
        || ["kind", "manifestHash", "evaluationFactsHash", "evaluationFacts", "nativeEvidence", "nativeEvidenceHash", "fileHashes", "periodComparison", "periodComparisonHash",
            "comparison", "comparisonHash", "sourceReports", "sourceFacts", "sourceFactsHash"].some(key => Object.hasOwn(manifest, key))
        || manifest.bundleId !== bundleId || !validHash(manifest.snapshotHash) || manifest.privacyReview?.reviewerConfirmed !== true
        || Object.getPrototypeOf(manifest.privacyReview) !== Object.prototype || Object.hasOwn(manifest.privacyReview, "reviewedAt")
        || !["none", "masked", "original"].includes(manifest.promptMode) || manifest.promptMode !== entry.promptMode
        || !Array.isArray(manifest.formats) || JSON.stringify([...manifest.formats].sort()) !== JSON.stringify([...entry.formats].sort())
        || !manifest.files || Object.getPrototypeOf(manifest.files) !== Object.prototype
        || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(names)
        || Object.values(manifest.files).some(file => !file || Object.getPrototypeOf(file) !== Object.prototype
            || JSON.stringify(Object.keys(file).sort()) !== JSON.stringify(["bytes", "sha256"])
            || !validHash(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > SAVED_REPORT_MAX_BYTES)) {
        throw new BoardError("This metadata does not match the supported legacy original format.", 422);
    }
    if (!entry.formats.includes(format)) throw new BoardError("That original format was not saved.", 404);
    const { name, mediaType } = reportFiles[format], bytes = await readReportFile(session, entry, name);
    const currentDigest = reportHash(bytes), declared = manifest.files[name];
    if (declared.bytes !== bytes.length || declared.sha256 !== currentDigest) throw new BoardError("The original file differs from its declared legacy metadata. Nothing was regenerated.", 409);
    if (format !== "pdf") {
        try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch (error) {
            if (!(error instanceof TypeError)) throw error;
            throw new BoardError("The original text is not valid UTF-8.", 422);
        }
    }
    const binding = { bundleId, fingerprint };
    assertLegacyReportOriginalCurrent(state, binding);
    return { source: "legacy-original", verification: "unverified", format, name, mediaType, bytes, currentDigest, binding,
        artifact: { bundleId, kind: "report", ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}),
            preparedAt: entry.preparedAt, preparedAtDisplay: entry.preparedAtDisplay } };
}

async function readComparisonManifest(session, entry) {
    const bytes = await readReportFile(session, entry, "coverage-and-redaction-manifest.json");
    if (!validHash(entry.manifestHash) || reportHash(bytes) !== entry.manifestHash) {
        throw new BoardError("Saved comparison manifest changed or is unverified.", 409);
    }
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved comparison manifest is unreadable.", 422);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || manifest.kind !== "comparison" || manifest.bundleId !== entry.bundleId || !hasReportSaveAuthorization(manifest.privacyReview)
        || !validHash(manifest.comparisonHash) || !validHash(manifest.sourceFactsHash)
        || !manifest.comparison || !Array.isArray(manifest.sourceFacts)
        || reportHash(JSON.stringify(manifest.comparison)) !== manifest.comparisonHash
        || reportHash(JSON.stringify(manifest.sourceFacts)) !== manifest.sourceFactsHash
        || JSON.stringify(manifest.sourceReports) !== JSON.stringify(entry.sourceReports)) {
        throw new BoardError("Saved comparison integrity or disclosure review is invalid.", 422);
    }
    if (entry.nativeComparisonHash !== undefined && (!validHash(entry.nativeComparisonHash)
        || entry.nativeComparisonHash !== manifest.comparisonHash || !manifest.comparison.nativeComparison)) {
        throw new BoardError("Saved Microsoft comparison differs from its account-bound index.", 409);
    }
    assertSavedTitle(entry, manifest);
    assertSavedAuthorization(manifest, entry);
    if (manifest.comparison?.resultTextSources) validateComparisonResultText(manifest.comparison.resultTextSources, manifest.sourceFacts, manifest.comparison);
    return { manifest, manifestBytes: bytes };
}

const artifactFormats = Object.freeze({
    html: { extension: "html", mediaType: "text/html" },
    json: { extension: "json", mediaType: "application/json" },
    markdown: { extension: "md", mediaType: "text/markdown" },
    pdf: { extension: "pdf", mediaType: "application/pdf" },
    manifest: { name: "coverage-and-redaction-manifest.json", mediaType: "application/json" },
});
function artifactFileName(kind, format) {
    if (!["report", "comparison"].includes(kind) || !Object.hasOwn(artifactFormats, format)) {
        throw new BoardError("Choose a saved report or comparison and a supported format.", 422);
    }
    return artifactFormats[format].name ?? `${kind === "report" ? "product-report" : "comparison-report"}.${artifactFormats[format].extension}`;
}
function assertFileInventory(entry, manifest) {
    if (!hasReportSaveAuthorization(entry.privacyReview)) throw new BoardError("This saved artifact has no registered save confirmation.", 422);
    assertSavedAuthorization(manifest, entry);
    const kind = artifactKind(entry);
    if (manifest.kind !== undefined && manifest.kind !== kind) throw new BoardError("Saved artifact kind differs from its manifest.", 409);
    const formats = entry.formats;
    if (!Array.isArray(formats) || !formats.length || new Set(formats).size !== formats.length
        || formats.some(format => typeof format !== "string" || format === "manifest" || !Object.hasOwn(artifactFormats, format))
        || !Array.isArray(manifest.formats) || JSON.stringify([...formats].sort()) !== JSON.stringify([...manifest.formats].sort())) {
        throw new BoardError("Saved artifact format inventory is inconsistent. Nothing was regenerated.", 422);
    }
    const names = formats.map(format => artifactFileName(kind, format)).sort();
    if (JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(names)
        || JSON.stringify(Object.keys(entry.files ?? {}).sort()) !== JSON.stringify([...names, artifactFormats.manifest.name].sort())) {
        throw new BoardError("Saved artifact file inventory is inconsistent. Nothing was regenerated.", 422);
    }
    if (entry.promptMode !== manifest.promptMode) throw new BoardError("Saved artifact text mode differs from its manifest.", 409);
}

export async function readSavedComparisonFile(session, state, bundleId, format) {
    return readSavedArtifactFile(session, state, bundleId, "comparison", format);
}

// Caller supplies a closed kind/format, never a path. The caller owns the current-state read gate.
export async function readSavedArtifactFile(session, state, bundleId, kind, format) {
    if (typeof format !== "string") throw new BoardError("Choose a supported saved artifact format.", 422);
    const name = artifactFileName(kind, format), entry = savedArtifact(state, bundleId, kind);
    const { manifest, manifestBytes } = kind === "comparison"
        ? await readComparisonManifest(session, entry) : await readReportManifest(session, entry);
    assertFileInventory(entry, manifest);
    let bytes, sha256;
    if (format === "manifest") {
        bytes = manifestBytes; sha256 = entry.manifestHash;
    } else if (kind === "report") {
        ({ bytes, sha256 } = await readSavedReportFile(session, state, bundleId, format));
    } else {
        if (!entry.formats.includes(format)) throw new BoardError("This format was not saved for this comparison.", 404);
        bytes = await readReportFile(session, entry, name);
        const expected = manifest.files[name];
        if (!validHash(expected?.sha256) || reportHash(bytes) !== expected.sha256 || expected.bytes !== bytes.length) {
            throw new BoardError("Saved comparison file changed. The original saved bundle was not regenerated.", 409);
        }
        if (format === "json" && manifest.title !== undefined) {
            let snapshot;
            try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
            catch (error) {
                if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
                throw new BoardError("Saved comparison JSON is unreadable.", 422);
            }
            if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
                || snapshot.kind !== "comparison" || snapshot.bundleId !== entry.bundleId) {
                throw new BoardError("Saved comparison JSON identity differs from its manifest.", 409);
            }
            assertSavedTitle(snapshot, manifest);
            if (!validHash(manifest.snapshotHash) || reportHash(JSON.stringify(snapshot)) !== manifest.snapshotHash) {
                throw new BoardError("Saved comparison JSON snapshot differs from its manifest.", 409);
            }
        }
        sha256 = expected.sha256;
    }
    return { artifact: describeSavedArtifact(entry, state), format, name, mediaType: artifactFormats[format].mediaType,
        bytes, sha256, manifestHash: entry.manifestHash, indexFingerprint: artifactIndexFingerprint(entry),
        ...(manifest.title !== undefined ? { canonicalTitle: manifest.title } : {}) };
}

export async function readSavedComparison(session, state, bundleId) {
    const entry = savedArtifact(state, bundleId, "comparison");
    const { manifest } = await readComparisonManifest(session, entry);
    const display = restoreOneSidedMetricDisplay(manifest.comparison, manifest.sourceFacts, manifest.comparisonHash);
    return {
        ...display,
        ...(manifest.title !== undefined ? { canonicalTitle: manifest.title } : {}),
        artifact: describeSavedArtifact(entry, state),
        sources: entry.sourceReports.map(source => {
            const original = state.exports.find(item => item.bundleId === source.bundleId && artifactKind(item) === "report" && !isDeleted(state, item));
            return original ? { ...describeSavedArtifact(original, state), available: true }
                : { bundleId: source.bundleId, available: false, label: "Original report deleted" };
        }),
    };
}
