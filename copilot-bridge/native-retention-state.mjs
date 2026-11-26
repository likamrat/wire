import { validNativeFailure } from "./microsoft-session-state.mjs";
import { validateNativeBackfill, validateNativeBackfillSummary } from "./native-backfill-state.mjs";

export const NATIVE_RETENTION_POLICY_ID = "native-screened-source-observations-v1";
export const NATIVE_REPORT_STORAGE_POLICY_ID = "native-report-account-bound-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = () => { throw Object.assign(new TypeError("Invalid committed native retention metadata."), { code: "NATIVE_RETENTION_STATE_INVALID" }); };

export function validateNativeReportBinding(value) {
    if (!fields(value, ["schemaVersion", "account"]) || value.schemaVersion !== 1 || !hash(value.account)) {
        throw Object.assign(new TypeError("Invalid native report account binding."), { code: "NATIVE_REPORT_BINDING_INVALID" });
    }
    return value;
}

export function validateNativeReportEntry(value) {
    const comparison = value?.kind === "comparison";
    if (!object(value) || (comparison
        ? !hash(value.nativeComparisonHash) || value.comparisonHash !== value.nativeComparisonHash
            || Object.hasOwn(value, "nativeEvidenceHash") || !Array.isArray(value.sourceReports) || value.sourceReports.length !== 2
            || value.sourceReports.some(source => !fields(source, ["bundleId", "snapshotHash"])
                || !/^export-[a-f0-9-]{36}$/.test(source.bundleId) || !hash(source.snapshotHash))
            || new Set(value.sourceReports.map(source => source.bundleId)).size !== 2
        : !Object.hasOwn(value, "nativeEvidenceHash") || !hash(value.nativeEvidenceHash) || Object.hasOwn(value, "nativeComparisonHash"))
        || !Object.hasOwn(value, "nativeSourceBinding") || Object.hasOwn(value, "evaluationFactsHash")) {
        throw Object.assign(new TypeError("Invalid native report identity and account binding."), { code: "NATIVE_REPORT_STATE_INVALID" });
    }
    validateNativeReportBinding(value.nativeSourceBinding);
    return value;
}

export function validateNativeReportState(state) {
    const native = state.exports.filter(entry => Object.hasOwn(entry, "nativeSourceBinding") || Object.hasOwn(entry, "nativeEvidenceHash") || Object.hasOwn(entry, "nativeComparisonHash"));
    if (state.nativeReportPolicy === undefined && state.stateVersion !== 5 && !native.length) return state;
    if (state.nativeReportPolicy !== NATIVE_REPORT_STORAGE_POLICY_ID || ![5, 6, 7].includes(state.stateVersion) || !state.nativeRetention) {
        throw Object.assign(new TypeError("Native report bindings require their explicit persisted state policy."), { code: "NATIVE_REPORT_STATE_INVALID" });
    }
    for (const entry of native) validateNativeReportEntry(entry);
    return state;
}

export function validateNativeGlobalState(state) {
    const present = Object.hasOwn(state, "globalCollection");
    if (present && (![6, 7].includes(state.stateVersion)
        || !fields(state.globalCollection, ["revision", "paused"])
        || !integer(state.globalCollection.revision) || state.globalCollection.revision < 1
        || typeof state.globalCollection.paused !== "boolean") || state.stateVersion === 6 && !present) {
        throw Object.assign(new TypeError("Invalid explicit global collection policy or persisted version."),
            { code: "GLOBAL_COLLECTION_STATE_INVALID" });
    }
    return state;
}

export function validateNativeStorageState(state) {
    if (![2, 3, 4, 5, 6, 7].includes(state.stateVersion)) fail();
    validateNativeGlobalState(state);
    if (state.nativeRetention !== undefined) {
        if (![4, 5, 6, 7].includes(state.stateVersion)
            || (state.nativeRetention.schemaVersion === 2) !== (state.stateVersion === 7)) fail();
        validateNativeRetentionState(state.nativeRetention);
    } else if ([4, 5, 7].includes(state.stateVersion)) fail();
    validateNativeReportState(state);
    return state;
}

export function validateNativeCollectionSettings(value) {
    if (!fields(value, ["paused", "windowDays"]) || typeof value.paused !== "boolean"
        || !Number.isSafeInteger(value.windowDays) || value.windowDays < 1 || value.windowDays > 90) fail();
    return value;
}

function validStorageIntent(value) {
    return fields(value, ["schemaVersion", "kind", "previousSnapshot", "previousFormat", "targetFormat"])
        && value.schemaVersion === 1 && value.targetFormat === "segments-v2" && [null, "screened-v1", "segments-v2"].includes(value.previousFormat)
        && (value.previousFormat === null ? value.previousSnapshot === null : hash(value.previousSnapshot))
        && value.kind === (value.previousFormat === "screened-v1" ? "new-capture-with-v1-adoption" : "new-capture");
}

export function validateNativeRetentionState(value) {
    if (!fields(value, ["schemaVersion", "policy", "configurationRevision", "privacyRevision", "settings", "surfaces", "accounts", "partitions", "receipts",
        ...(Object.hasOwn(value ?? {}, "receiptArchive") ? ["receiptArchive"] : []),
        ...(Object.hasOwn(value ?? {}, "backfill") ? ["backfill"] : [])])
        || ![1, 2].includes(value.schemaVersion) || value.policy !== NATIVE_RETENTION_POLICY_ID
        || !integer(value.configurationRevision) || value.configurationRevision < 1
        || !integer(value.privacyRevision) || value.privacyRevision < 1
        || !Array.isArray(value.surfaces) || !value.surfaces.length || new Set(value.surfaces).size !== value.surfaces.length
        || value.surfaces.some(surface => !["chat", "cowork"].includes(surface))
        || !Array.isArray(value.accounts) || !Array.isArray(value.partitions)
        || !Array.isArray(value.receipts) || value.receipts.length > 1024) fail();
    if (Object.hasOwn(value, "receiptArchive") && (!fields(value.receiptArchive, ["schemaVersion", "id"])
        || value.receiptArchive.schemaVersion !== 1 || !uuid(value.receiptArchive.id))) fail();
    validateNativeCollectionSettings(value.settings);
    const accounts = new Set(), partitions = new Set(), operations = new Set();
    for (const account of value.accounts) {
        if (!fields(account, ["partition", "issuer", "tenantId", "subjectId"]) || !hash(account.partition) || accounts.has(account.partition)
            || ["tenantId", "subjectId"].some(name => typeof account[name] !== "string" || !account[name].trim() || account[name].length > 1024)) fail();
        let issuer;
        try { issuer = new URL(account.issuer); } catch { fail(); }
        if (issuer.protocol !== "https:" || issuer.origin !== account.issuer || issuer.username || issuer.password) fail();
        accounts.add(account.partition);
    }
    if (Object.hasOwn(value, "backfill")) {
        if (!Array.isArray(value.backfill) || value.backfill.length > value.accounts.length
            || value.backfill.some(item => !object(item))
            || new Set(value.backfill.map(item => item.accountRef)).size !== value.backfill.length) fail();
        for (const checkpoint of value.backfill) {
            validateNativeBackfill(checkpoint);
            if (!accounts.has(checkpoint.accountRef)) fail();
        }
    }
    for (const partition of value.partitions) {
        if (!fields(partition, ["partition", "file", "revision", "lastOperationId", ...value.schemaVersion === 2 ? ["format"] : []])
            || value.schemaVersion === 2 && !["screened-v1", "segments-v2"].includes(partition.format) || !accounts.has(partition.partition)
            || partitions.has(partition.partition) || !/^[a-f0-9]{64}\.json$/.test(partition.file)
            || !integer(partition.revision) || !uuid(partition.lastOperationId)) fail();
        partitions.add(partition.partition);
    }
    for (const receipt of value.receipts) {
        const base = ["schemaVersion", "operationId", "partition", "ownerHash", "intent", "intentFingerprint", "status",
            "configurationRevision", "privacyRevision", "generation", "registeredAt"];
        const committed = receipt?.status === "committed";
        const segmented = receipt?.schemaVersion === 2;
        if (!fields(receipt, [...base, ...segmented ? ["storageIntent"] : [],
            ...Object.hasOwn(receipt ?? {}, "firstFailure") ? ["firstFailure"] : [],
            ...Object.hasOwn(receipt ?? {}, "backfill") ? ["backfill"] : [],
            ...committed ? ["fingerprint", "quality", "beforeRevision", "revision", "snapshot", "changes", "committedAt"] : []])
            || ![1, 2].includes(receipt.schemaVersion) || segmented && (value.schemaVersion !== 2 || !validStorageIntent(receipt.storageIntent))
            || !uuid(receipt.operationId) || operations.has(receipt.operationId)
            || !accounts.has(receipt.partition) || !hash(receipt.ownerHash) || receipt.intent !== "native-collect-now"
            || !hash(receipt.intentFingerprint) || !["registered", "committed"].includes(receipt.status)
            || !integer(receipt.generation)
            || ["configurationRevision", "privacyRevision"].some(name => !integer(receipt[name]) || receipt[name] < 1)
            || !Number.isFinite(Date.parse(receipt.registeredAt))) fail();
        if (Object.hasOwn(receipt, "firstFailure") && !validNativeFailure(receipt.firstFailure)) fail();
        if (Object.hasOwn(receipt, "backfill")) validateNativeBackfillSummary(receipt.backfill);
        if (committed && (!hash(receipt.fingerprint) || receipt.quality !== "source-qualified-partial" || !hash(receipt.snapshot)
            || !integer(receipt.beforeRevision) || !integer(receipt.revision) || !Number.isFinite(Date.parse(receipt.committedAt))
            || !fields(receipt.changes, ["addedCaptures", "addedObservations", "addedVariants", "addedProvenance", "reusedObservations", "suppressedObservations"])
            || Object.values(receipt.changes).some(count => !integer(count)))) fail();
        operations.add(receipt.operationId);
    }
    return value;
}

export function validateNativeReadback(value) {
    if (!fields(value, ["schemaVersion", "accountRef", "snapshot", "committed", "current"])
        || value.schemaVersion !== 1 || !hash(value.accountRef) || value.snapshot !== null && !hash(value.snapshot)
        || !fields(value.current, ["generation", "configurationRevision", "privacyRevision"]) || !integer(value.current.generation)
        || ["configurationRevision", "privacyRevision"].some(name => value.current[name] !== null
            && (!integer(value.current[name]) || value.current[name] < 1))) fail();
    if (value.committed !== null && (!fields(value.committed, ["operationId", "revision", "generation", "configurationRevision", "privacyRevision",
        ...(Object.hasOwn(value.committed, "committedAt") ? ["committedAt"] : [])])
        || !uuid(value.committed.operationId)
        || Object.hasOwn(value.committed, "committedAt") && (typeof value.committed.committedAt !== "string" || !Number.isFinite(Date.parse(value.committed.committedAt)))
        || !["revision", "generation"].every(name => integer(value.committed[name]))
        || ["configurationRevision", "privacyRevision"].some(name => !integer(value.committed[name]) || value.committed[name] < 1)
        || value.snapshot === null)) fail();
    return value;
}

export function validateNativeArtifactDeletionSeal(operation) {
    const marker = operation?.nativeArtifactAdmission;
    const artifacts = operation?.scope === "all-reports" ? operation.artifacts : [operation?.artifact];
    const bundle = value => typeof value === "string" && /^export-[a-f0-9-]{36}$/.test(value);
    if (operation?.kind !== "artifact-deletion" || !uuid(operation.operationId)
        || !hash(operation.ownerHash) || !hash(operation.receiptHash)
        || !fields(marker, ["schemaVersion", "account", "binding"]) || marker.schemaVersion !== 1
        || marker.account !== null && !hash(marker.account) || !hash(marker.binding)
        || !Array.isArray(artifacts) || !artifacts.length || artifacts.length > 10000
        || artifacts.some(item => !fields(item, ["artifactId", "artifactKind"]) || !bundle(item.artifactId)
            || !["report", "comparison"].includes(item.artifactKind)
            || operation.scope === "all-reports" && item.artifactKind !== "report")
        || new Set(artifacts.map(item => item.artifactId)).size !== artifacts.length) {
        throw Object.assign(new TypeError("Invalid sealed native saved-artifact mutation."), { code: "NATIVE_ARTIFACT_MUTATION_SEAL_INVALID" });
    }
    return operation;
}
