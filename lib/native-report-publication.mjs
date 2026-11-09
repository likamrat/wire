import { createHash } from "node:crypto";
import { open, opendir } from "node:fs/promises";
import path from "node:path";
import { BoardError, resolveDataDir } from "./store.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { SAVED_REPORT_MAX_BYTES } from "./report-artifacts.mjs";
import { measureNativeJson } from "./native-read-model.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { inspectNativeReportNamespace, projectNativeReportEvidence } from "./native-report-evidence.mjs";
import { reportContextRef } from "./report-context.mjs";
import { nativeComparisonEvidence } from "./frozen-report-comparison.mjs";
import { hasReportSaveAuthorization, assertReportSaveAuthorization, reportSaveAuthorizationSummary } from "./report-save-consent.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const object = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const formats = Object.freeze({ html: "product-report.html", json: "product-report.json", markdown: "product-report.md", pdf: "product-report.pdf" });
const manifestName = "coverage-and-redaction-manifest.json";
const fail = () => { throw Object.assign(new BoardError("Native report publication differs from its reviewed source or file inventory.", 422),
    { code: "NATIVE_REPORT_PUBLICATION_INVALID" }); };
const freeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
};
function bytesOf(value) {
    if (typeof value !== "string" && !(value instanceof Uint8Array)) fail();
    const length = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    if (length > SAVED_REPORT_MAX_BYTES) fail();
    return Buffer.from(value);
}
function stableNativeFacts(evidence) {
    const { disclosure, ...facts } = evidence;
    return { ...facts, copies: disclosure.copies.map(({ text, omitted, changes, representation, ...association }) => association),
        unavailableFacts: disclosure.unavailableFacts };
}

// The controller owns save authorization and mixed/GitHub dependency checks;
// file hashes alone never grant permission to publish.
export function pinNativeReportPublication(bundle, originalFrame, key) {
    const comparison = bundle?.kind === "comparison";
    const fileFormats = comparison ? Object.fromEntries(Object.entries(formats).map(([format, name]) => [format, name.replace("product-", "comparison-")])) : formats;
    if (!object(bundle) || !object(bundle.snapshot) || !object(bundle.files)
        || !["report", "comparison"].includes(bundle.kind) || !hasReportSaveAuthorization(bundle.privacy)) fail();
    measureNativeJson(bundle.snapshot);
    const snapshot = JSON.parse(JSON.stringify(bundle.snapshot));
    if (snapshot.schemaVersion !== 3 || snapshot.kind !== bundle.kind || snapshot.bundleId !== bundle.bundleId
        || !/^export-[a-f0-9-]{36}$/.test(snapshot.bundleId ?? "")
        || !Array.isArray(snapshot.formats) || !snapshot.formats.length || snapshot.formats.length > 4
        || snapshot.formats.some(format => !Object.hasOwn(formats, format))
        || new Set(snapshot.formats).size !== snapshot.formats.length || !same(snapshot.formats, bundle.formats)) fail();
    const names = [...snapshot.formats.map(format => fileFormats[format]), manifestName].sort();
    if (!same(Object.keys(bundle.files).sort(), names)) fail();
    const files = names.map(name => {
        const bytes = bytesOf(bundle.files[name]);
        return { name, sha256: sha(bytes), bytes: bytes.length };
    });
    const manifestBytes = bytesOf(bundle.files[manifestName]);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
    catch { fail(); }
    measureNativeJson(manifest);
    if (!object(manifest) || !hasReportSaveAuthorization(manifest.privacyReview)
        || !same(manifest.privacyReview, bundle.privacy)
        || !Number.isFinite(Date.parse(manifest.privacyReview.confirmedAt))) fail();
    assertReportSaveAuthorization(manifest);
    for (const field of ["bundleId", "title", "preparedAt", "promptMode", "formats", "timeContext", "preparedAtDisplay",
        "dateSelection", "dateRange", "selectionScope", "presentation", "savePolicy"]) {
        if (!same(manifest[field], snapshot[field])) fail();
    }
    if (manifest.snapshotHash !== sha(JSON.stringify(snapshot)) || !exact(manifest.files, names.filter(name => name !== manifestName))) fail();
    for (const file of files.filter(file => file.name !== manifestName)) {
        if (!exact(manifest.files[file.name], ["sha256", "bytes"]) || !same(manifest.files[file.name], { sha256: file.sha256, bytes: file.bytes })) fail();
    }
    if (snapshot.formats.includes("json")) {
        let stored;
        try { stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytesOf(bundle.files[fileFormats.json]))); }
        catch { fail(); }
        if (!same(stored, snapshot)) fail();
    }
    if (comparison) {
        if (snapshot.promptMode !== "none" || snapshot.records.length || !snapshot.comparison?.nativeComparison
            || !Array.isArray(snapshot.sourceFacts) || snapshot.sourceFacts.length !== 2
            || !same(snapshot.sourceReports, manifest.sourceReports) || !same(snapshot.sourceFacts, manifest.sourceFacts)
            || !same(snapshot.comparison, manifest.comparison) || !same(snapshot.comparison, bundle.comparison)
            || manifest.comparisonHash !== sha(JSON.stringify(snapshot.comparison))
            || manifest.sourceFactsHash !== sha(JSON.stringify(snapshot.sourceFacts))) fail();
        let native = false;
        for (const source of snapshot.sourceFacts) if (source.legacyFacts?.nativeEvidence) {
            native = true;
            if (!same(nativeComparisonEvidence(source.legacyFacts.nativeEvidence), source.legacyFacts.nativeEvidence)) fail();
        }
        if (!native) fail();
        return freeze({ kind: "comparison", bundleId: snapshot.bundleId, snapshotHash: manifest.snapshotHash,
            nativeComparisonHash: manifest.comparisonHash, sourceReports: snapshot.sourceReports,
            manifestHash: sha(manifestBytes), formats: [...snapshot.formats], files,
            title: snapshot.title ?? null, preparedAt: snapshot.preparedAt, promptMode: snapshot.promptMode,
            confirmedAt: manifest.privacyReview.confirmedAt,
            ...(manifest.privacyReview.localSave ? { localSave: reportSaveAuthorizationSummary(manifest.privacyReview).localSave } : {}),
            timeContext: snapshot.timeContext,
            preparedAtDisplay: snapshot.preparedAtDisplay, selectionScope: null });
    }
    const evidence = inspectNativeReportNamespace(manifest, snapshot, manifest.nativeEvidenceHash);
    if (!evidence) fail();
    const contextOnly = originalFrame.records.filter(record =>
        evidence.selection.contextOnlyRefs.includes(reportContextRef(key, "scenario", record.scenarioId))).map(record => record.scenarioId);
    const expected = projectNativeReportEvidence(originalFrame, key, {
        promptMode: evidence.disclosure.promptMode, recordedContext: evidence.disclosure.recordedContext,
    }, {
        githubRecords: snapshot.records.filter(record => record.recordKind !== "native-conversation"),
        githubEvaluationFacts: evidence.githubEvaluationFacts,
        contextOnlyScenarioIds: contextOnly,
    }).nativeEvidence;
    if (nativeRetentionHash(stableNativeFacts(expected)) !== nativeRetentionHash(stableNativeFacts(evidence))) fail();
    return freeze({ bundleId: snapshot.bundleId, snapshotHash: manifest.snapshotHash, nativeEvidenceHash: manifest.nativeEvidenceHash,
        periodComparisonHash: manifest.periodComparisonHash ?? null,
        manifestHash: sha(manifestBytes), formats: [...snapshot.formats], files,
        title: snapshot.title ?? null, preparedAt: snapshot.preparedAt, promptMode: snapshot.promptMode,
        confirmedAt: manifest.privacyReview.confirmedAt,
        ...(manifest.privacyReview.localSave ? { localSave: reportSaveAuthorizationSummary(manifest.privacyReview).localSave } : {}),
        timeContext: snapshot.timeContext,
        preparedAtDisplay: snapshot.preparedAtDisplay, selectionScope: snapshot.selectionScope ?? null });
}

export function assertNativeReportPublicationIndex(context, pin, entry) {
    const comparison = pin.kind === "comparison";
    const fields = ["bundleId", "kind", "title", "preparedAt", "exportedAt", "bundleDir", "privacyReview", "promptMode", "formats", "savePolicy",
        "timeContext", "preparedAtDisplay", "selectionScope", "snapshotHash", "manifestHash", "nativeEvidenceHash", "files", "scenarioIds",
        ...(comparison ? ["nativeComparisonHash", "comparisonHash", "sourceReports"] : ["reportType", "periodComparisonHash"])];
    if (!object(entry) || Object.keys(entry).some(name => !fields.includes(name))
        || entry.scenarioIds !== undefined && (!Array.isArray(entry.scenarioIds) || entry.scenarioIds.length > 10000
            || entry.scenarioIds.some(id => typeof id !== "string" || !id) || new Set(entry.scenarioIds).size !== entry.scenarioIds.length)
        || entry.bundleId !== pin.bundleId || entry.kind !== (comparison ? "comparison" : "report")
        || comparison && (entry.nativeComparisonHash !== pin.nativeComparisonHash || entry.comparisonHash !== pin.nativeComparisonHash
            || !same(entry.sourceReports, pin.sourceReports))
        || Object.hasOwn(entry, "nativeSourceBinding") || Object.hasOwn(entry, "evaluationFactsHash")
        || entry.nativeEvidenceHash !== pin.nativeEvidenceHash || entry.manifestHash !== pin.manifestHash
        || !comparison && ((entry.periodComparisonHash ?? null) !== pin.periodComparisonHash
            || (entry.reportType ?? null) !== (pin.periodComparisonHash ? "period-comparison" : null))
        || entry.snapshotHash !== pin.snapshotHash || !same(entry.formats, pin.formats)
        || (entry.title ?? null) !== pin.title || entry.preparedAt !== pin.preparedAt || entry.promptMode !== pin.promptMode
        || !same(entry.timeContext, pin.timeContext) || entry.preparedAtDisplay !== pin.preparedAtDisplay
        || !same(entry.selectionScope ?? null, pin.selectionScope)
        || !exact(entry.privacyReview, ["reviewerConfirmed", "reviewerIdentityVerified", "confirmedAt", ...(pin.localSave ? ["localSave"] : [])])
        || !hasReportSaveAuthorization(entry.privacyReview)
        || entry.privacyReview.reviewerConfirmed !== !pin.localSave || entry.privacyReview.reviewerIdentityVerified !== false
        || !same(reportSaveAuthorizationSummary(entry.privacyReview).localSave, pin.localSave)
        || entry.savePolicy !== (pin.localSave ? "local-save-v1" : undefined)
        || entry.privacyReview.confirmedAt !== pin.confirmedAt || !Number.isFinite(Date.parse(entry.exportedAt))) fail();
    const folder = path.join(resolveDataDir(context), "exports", pin.bundleId, "files");
    if (typeof entry.bundleDir !== "string" || path.resolve(entry.bundleDir) !== path.resolve(folder)
        || !exact(entry.files, pin.files.map(file => file.name))) fail();
    for (const file of pin.files) if (typeof entry.files[file.name] !== "string"
        || path.resolve(entry.files[file.name]) !== path.resolve(path.join(folder, file.name))) fail();
}

export async function verifyNativeReportPublicationFiles(context, pin, assertCurrent) {
    const root = resolveDataDir(context), relative = path.join("exports", pin.bundleId, "files");
    assertCurrent();
    const folder = await safeDeletionFile(root, relative);
    assertCurrent();
    const listed = [];
    for await (const item of await opendir(folder)) {
        assertCurrent();
        if (!item.isFile() || listed.length >= pin.files.length) fail();
        listed.push(item.name);
    }
    assertCurrent();
    if (!same(listed.sort(), pin.files.map(file => file.name).sort())) fail();
    for (const file of pin.files) {
        const name = await safeDeletionFile(root, path.join(relative, file.name));
        assertCurrent();
        const handle = await open(name, "r");
        try {
            assertCurrent();
            const stat = await handle.stat();
            assertCurrent();
            if (!stat.isFile() || stat.size !== file.bytes || stat.size > SAVED_REPORT_MAX_BYTES) fail();
            const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(65536, Math.max(1, stat.size)));
            let offset = 0;
            while (offset < stat.size) {
                const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                assertCurrent();
                if (!read.bytesRead) fail();
                hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
            }
            const extra = await handle.read(buffer, 0, 1, offset);
            assertCurrent();
            if (extra.bytesRead || hash.digest("hex") !== file.sha256) fail();
        } finally { await handle.close(); }
        assertCurrent();
    }
}
