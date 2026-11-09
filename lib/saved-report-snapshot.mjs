import { createHash } from "node:crypto";
import { validatePeriodReport } from "./period-report.mjs";
import { inspectNativeReportNamespace } from "./native-report-shape.mjs";
import { inspectReportResultFacts } from "./report-result-facts.mjs";
import { inspectReportResultText } from "./report-result-text-shape.mjs";
import { hasReportSaveAuthorization, assertReportSaveAuthorization } from "./report-save-consent.mjs";
import { inspectReportPopulation } from "./report-population.mjs";
import { inspectReportNotes } from "./report-notes.mjs";
import { inspectReportPatterns } from "./report-patterns.mjs";

// The caller supplies bytes from an explicitly selected artifact.
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hashText = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const bundleId = value => typeof value === "string" && /^export-[A-Za-z0-9-]{1,100}$/.test(value);
const formats = new Set(["html", "pdf", "json", "markdown"]);

function parse(bytes, label) {
    if (typeof bytes !== "string" && !Buffer.isBuffer(bytes)) throw new TypeError(`Report ${label} requires file bytes.`);
    let value;
    try { value = JSON.parse(bytes.toString()); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new TypeError(`Report ${label} contains invalid JSON.`);
    }
    if (!plain(value)) throw new TypeError(`Report ${label} must contain a JSON object.`);
    return value;
}

export function inspectSavedReportSnapshot({ manifestBytes, snapshotBytes, expectedManifestSha256, expectedBundleId } = {}) {
    if (expectedManifestSha256 !== undefined) {
        if (!hashText(expectedManifestSha256)) throw new TypeError("Expected saved manifest hash is invalid.");
        if (typeof manifestBytes !== "string" && !Buffer.isBuffer(manifestBytes)) throw new TypeError("Report manifest requires file bytes.");
        if (hash(manifestBytes) !== expectedManifestSha256.toLowerCase()) throw new TypeError("Saved report manifest hash mismatch.");
    }
    const manifest = parse(manifestBytes, "manifest");
    if (expectedBundleId !== undefined && (!bundleId(expectedBundleId) || manifest.bundleId !== expectedBundleId)) {
        throw new TypeError("The saved report does not match the selected bundle identity.");
    }
    const result = {
        status: "not-comparable",
        reason: null,
        integrity: expectedManifestSha256 ? "matches-saved-manifest-and-file-hashes" : "matches-declared-hashes-only",
        derivedReadOnly: true,
        overlapVerification: "not-established",
        snapshot: null,
    };
    if (manifest.schemaVersion !== 3) return { ...result, reason: "unsupported-snapshot-version", integrity: "not-checked" };
    if (!bundleId(manifest.bundleId)) throw new TypeError("Report manifest requires a valid bundle identity.");
    if (typeof manifest.preparedAt !== "string" || !Number.isFinite(Date.parse(manifest.preparedAt))) {
        throw new TypeError("Report manifest requires a valid preparation time.");
    }
    if (!Array.isArray(manifest.formats) || !manifest.formats.length
        || manifest.formats.some(format => !formats.has(format))
        || new Set(manifest.formats).size !== manifest.formats.length
        || !plain(manifest.files)) throw new TypeError("Report manifest file inventory is invalid.");
    if (!hasReportSaveAuthorization(manifest.privacyReview)) {
        return { ...result, reason: "disclosure-review-not-recorded", integrity: "not-checked" };
    }
    assertReportSaveAuthorization(manifest);
    const nativeEvidence = inspectNativeReportNamespace(manifest);
    inspectReportResultFacts(manifest);
    inspectReportResultText(manifest);
    inspectReportPopulation(manifest);
    inspectReportNotes(manifest);
    inspectReportPatterns(manifest);
    if (nativeEvidence && manifest.periodComparison) {
        try { validatePeriodReport(manifest.periodComparison); }
        catch (error) { throw new TypeError(`Saved Microsoft period report is invalid: ${error.message}`); }
    }
    if (nativeEvidence && !manifest.formats.includes("json")) {
        return { ...result, status: "supported", nativeEvidence };
    }
    if (!manifest.formats.includes("json")) return { ...result, reason: "structured-snapshot-not-saved", integrity: "not-checked" };
    if (snapshotBytes === undefined || snapshotBytes === null) return { ...result, reason: "structured-snapshot-file-missing", integrity: "not-checked" };
    const declared = manifest.files["product-report.json"];
    if (!plain(declared) || !hashText(declared.sha256) || !hashText(manifest.snapshotHash)) {
        throw new TypeError("Saved report file or snapshot hash is missing.");
    }
    if (typeof snapshotBytes !== "string" && !Buffer.isBuffer(snapshotBytes)) throw new TypeError("Report snapshot requires file bytes.");
    if (hash(snapshotBytes) !== declared.sha256.toLowerCase()) throw new TypeError("Saved report file hash mismatch.");
    if (declared.bytes !== undefined && declared.bytes !== Buffer.byteLength(snapshotBytes)) throw new TypeError("Saved report file byte count mismatch.");
    const snapshot = parse(snapshotBytes, "snapshot");
    if (snapshot.schemaVersion !== 3) return { ...result, reason: "unsupported-snapshot-version", integrity: "not-checked" };
    if (hash(JSON.stringify(snapshot)) !== manifest.snapshotHash.toLowerCase()) throw new TypeError("Saved report snapshot hash mismatch.");
    for (const key of [...(Object.hasOwn(manifest, "title") ? ["title"] : []), "bundleId", "promptMode", "formats", "preparedAt", "timeContext", "dateSelection", "dateRange", "selectionScope", "savePolicy"]) {
        if (JSON.stringify(snapshot[key]) !== JSON.stringify(manifest[key])) throw new TypeError(`Saved report ${key} differs from its manifest.`);
    }
    const frozenNative = inspectNativeReportNamespace(manifest, snapshot);
    inspectReportResultFacts(manifest, snapshot);
    inspectReportResultText(manifest, snapshot);
    inspectReportPopulation(manifest, snapshot);
    inspectReportNotes(manifest, snapshot);
    inspectReportPatterns(manifest, snapshot);
    if (!["none", "masked", "original"].includes(snapshot.promptMode) || !Array.isArray(snapshot.records)
        || snapshot.records.filter(record => !frozenNative || record?.recordKind !== "native-conversation").some(record => !record || record.projectionVersion !== 3
            || record.promptMode !== snapshot.promptMode || !Array.isArray(record.prompts))) {
        throw new TypeError("Saved report does not contain supported projected records.");
    }
    if (snapshot.periodComparison !== undefined || manifest.periodComparison !== undefined || manifest.periodComparisonHash !== undefined) {
        try { validatePeriodReport(snapshot.periodComparison, snapshot.records); }
        catch (error) { throw new TypeError(`Saved period report is invalid: ${error.message}`); }
        if (snapshot.kind !== "report" || manifest.kind !== "report" || snapshot.evaluationFacts !== undefined || manifest.evaluationFacts !== undefined
            || JSON.stringify(snapshot.periodComparison) !== JSON.stringify(manifest.periodComparison)
            || hash(JSON.stringify(snapshot.periodComparison)) !== manifest.periodComparisonHash) {
            throw new TypeError("Saved period report differs from its manifest.");
        }
    }
    return { ...result, status: "supported", snapshot, ...(frozenNative ? { nativeEvidence: frozenNative } : {}) };
}
