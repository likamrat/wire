import { lstat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BoardError, resolveDataDir } from "./store.mjs";
import { buildAnalytics } from "./analytics.mjs";
import { classifyWorkload } from "./graph-history.mjs";
import { inspectSavedReportSnapshot } from "./saved-report-snapshot.mjs";
import { adaptEvaluationReport, freezeEvaluationFacts } from "./report-facts.mjs";
import { artifactDeletionKey } from "./deletion-identities.mjs";
import { restoreOneSidedMetricDisplay } from "./report-comparison-compatibility.mjs";

export const reportHash = value => createHash("sha256").update(value).digest("hex");
export const SAVED_REPORT_MAX_BYTES = 32 * 1024 * 1024;
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validId = value => typeof value === "string" && /^export-[a-f0-9-]{36}$/.test(value);
const samePath = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export const artifactKind = entry => entry.kind ?? "report";
const isDeleted = (state, entry) => state.artifactDeletion?.identities?.includes(artifactDeletionKey(artifactKind(entry), entry.bundleId)) === true;
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
export function describeSavedArtifact(entry, state) {
    const kind = artifactKind(entry);
    const eligible = kind === "report" && Boolean(entry.evaluationFactsHash || entry.files?.["product-report.json"]);
    return {
        bundleId: entry.bundleId, kind, preparedAt: entry.preparedAt, preparedAtDisplay: entry.preparedAtDisplay,
        formats: [...entry.formats ?? []], promptMode: entry.promptMode, canDelete: true,
        ...(Number.isSafeInteger(entry.selectionScope?.requestGroups) && entry.selectionScope.requestGroups >= 0
            ? { requestGroupCount: entry.selectionScope.requestGroups } : {}),
        comparisonEligibility: eligible ? entry.evaluationFactsHash ? "available" : "legacy-outcomes-only"
            : kind === "comparison" ? "comparison-is-not-a-source-report" : "structured-facts-not-saved",
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
async function checkedManagedPath(session, entry, name) {
    const root = path.join(resolveDataDir(session), "exports");
    const bundleRoot = path.join(root, entry.bundleId);
    const registeredTarget = entry.files?.[name];
    if (typeof name !== "string" || !name.length || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)
        || typeof registeredTarget !== "string") throw new BoardError("Saved report file ownership is invalid.", 422);
    const registeredFolder = entry.bundleDir ?? path.dirname(registeredTarget);
    if (typeof registeredFolder !== "string") throw new BoardError("Saved report folder is invalid.", 422);
    const folder = [bundleRoot, path.join(bundleRoot, "files")].find(candidate => samePath(candidate, registeredFolder));
    if (!folder || !samePath(registeredTarget, path.join(folder, name))) {
        throw new BoardError("Saved report file is outside its registered bundle.", 422);
    }
    const target = path.join(folder, name);
    for (const directory of new Set([root, bundleRoot, folder])) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new BoardError("Linked report folders cannot be read for comparison.", 422);
    }
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new BoardError("Saved report file is linked or unsupported.", 422);
    const realFolder = await realpath(folder), realFile = await realpath(target);
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
    return async (state, { artifactKind: kind, artifactId }) => {
        if (!["report", "comparison"].includes(kind)) throw new BoardError("Choose a saved report or comparison.", 422);
        const entry = savedArtifact(state, artifactId, kind);
        const prefix = kind === "comparison" ? "comparison-report" : "product-report";
        const allowed = new Set(["coverage-and-redaction-manifest.json", ...["html", "pdf", "json", "md"].map(extension => `${prefix}.${extension}`)]);
        const files = [];
        let layout;
        for (const name of Object.keys(entry.files ?? {}).sort()) {
            const checked = await checkedManagedPath(session, entry, name);
            if (layout && layout !== checked.layout) throw new BoardError("Mixed saved report layouts require review. Nothing deleted.", 422);
            layout = checked.layout;
            if (layout === "files" && !allowed.has(name)) throw new BoardError("This report has an unrecognized file inventory. Nothing deleted.", 422);
            const hash = createHash("sha256");
            for await (const bytes of createReadStream(checked.target)) hash.update(bytes);
            files.push({ name, sha256: hash.digest("hex") });
        }
        if (!files.length) throw new BoardError("This saved report has no indexed files. Nothing deleted.", 422);
        const manifest = files.find(file => file.name === "coverage-and-redaction-manifest.json");
        if (!manifest && layout !== "bundle-root") throw new BoardError("The saved report manifest is missing. Nothing deleted.", 422);
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
    if (entry.privacyReview?.reviewerConfirmed !== true) throw new BoardError("This report has no saved disclosure approval.", 422);
    const bytes = await readManagedFile(session, entry, "coverage-and-redaction-manifest.json");
    const manifestHash = reportHash(bytes);
    if (entry.manifestHash && manifestHash !== entry.manifestHash) throw new BoardError("Saved report manifest changed.", 409);
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved report manifest is not readable JSON.", 422);
    }
    if (manifest.bundleId !== bundleId || manifest.privacyReview?.reviewerConfirmed !== true || !validHash(manifest.snapshotHash)) {
        throw new BoardError("Saved report identity or disclosure approval is invalid.", 422);
    }
    const metadata = { bundleId, snapshotHash: manifest.snapshotHash, disclosureReviewed: true };
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
        envelope, facts,
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
async function readReportManifest(session, entry) {
    if (entry.privacyReview?.reviewerConfirmed !== true || !validHash(entry.manifestHash)) {
        throw new BoardError("This report has no verified saved disclosure manifest. Use its original saved files.", 422);
    }
    const manifestBytes = await readReportFile(session, entry, "coverage-and-redaction-manifest.json");
    if (reportHash(manifestBytes) !== entry.manifestHash) throw new BoardError("Saved report manifest changed.", 409);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved report manifest is not readable JSON.", 422);
    }
    if (manifest.bundleId !== entry.bundleId || manifest.kind === "comparison" || manifest.privacyReview?.reviewerConfirmed !== true) {
        throw new BoardError("Saved report identity or disclosure approval is invalid.", 422);
    }
    return { manifest, manifestBytes };
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
        manifestHash: entry.manifestHash, ...(snapshot ? { snapshot, manifest } : {}) };
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
    return { artifact: describeSavedArtifact(entry, state), html, sha256 };
}

export async function readSavedComparison(session, state, bundleId) {
    const entry = savedArtifact(state, bundleId, "comparison");
    const bytes = await readManagedFile(session, entry, "coverage-and-redaction-manifest.json");
    if (!validHash(entry.manifestHash) || reportHash(bytes) !== entry.manifestHash) {
        throw new BoardError("Saved comparison manifest changed or is unverified.", 409);
    }
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new BoardError("Saved comparison manifest is unreadable.", 422);
    }
    if (manifest.kind !== "comparison" || manifest.bundleId !== bundleId || manifest.privacyReview?.reviewerConfirmed !== true
        || reportHash(JSON.stringify(manifest.comparison)) !== manifest.comparisonHash
        || reportHash(JSON.stringify(manifest.sourceFacts)) !== manifest.sourceFactsHash
        || JSON.stringify(manifest.sourceReports) !== JSON.stringify(entry.sourceReports)) {
        throw new BoardError("Saved comparison integrity or disclosure review is invalid.", 422);
    }
    const display = restoreOneSidedMetricDisplay(manifest.comparison, manifest.sourceFacts, manifest.comparisonHash);
    return {
        ...display,
        artifact: describeSavedArtifact(entry, state),
        sources: entry.sourceReports.map(source => {
            const original = state.exports.find(item => item.bundleId === source.bundleId && artifactKind(item) === "report" && !isDeleted(state, item));
            return original ? { ...describeSavedArtifact(original, state), available: true }
                : { bundleId: source.bundleId, available: false, label: "Original report deleted" };
        }),
    };
}
