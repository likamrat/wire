import { createHash } from "node:crypto";
import { NATIVE_READ_LIMITS, NATIVE_RETAINED_CONTRACT, nativeValueHasCredentials,
    validateNativeRetainedObservation, nativeConversationIdentity } from "./native-read-model.mjs";
import { NATIVE_RETENTION_POLICY_ID } from "./native-retention-state.mjs";
import { nativeRetentionHash, nativeRetentionJson, validateNativeRetainedAccount,
    nativeRetainedObservationIdentity, nativeRetainedObservationParts, restoreNativeRetainedObservation } from "./native-retention-contract.mjs";
import { nativeObservationReference } from "./deletion-identities.mjs";
export { nativeObservationReference } from "./deletion-identities.mjs";

export const NATIVE_SEGMENTED_CONTRACT = "m365-native-screened-segments-v2";
export const NATIVE_SEGMENTED_LIMITS = Object.freeze({
    bytes: NATIVE_READ_LIMITS.bytes, segmentEntries: 128, pageChildren: 128, treeDepth: 64,
    queryIds: NATIVE_READ_LIMITS.records, resultEntries: 128, cacheBytes: NATIVE_READ_LIMITS.bytes,
});
export const NATIVE_SEGMENTED_SOURCES = Object.freeze(["microsoft-365-chat", "microsoft-365-cowork"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= NATIVE_READ_LIMITS.textBytes;
const common = ["schemaVersion", "contractVersion", "dataContract", "policy", "account", "kind"];
const numericKey = value => String(value).padStart(16, "0");
const sourceCode = value => {
    if (!NATIVE_SEGMENTED_SOURCES.includes(value)) segmentedFailure("source-invalid");
    return value === "microsoft-365-chat" ? "chat" : "cowork";
};
const freeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

export class NativeSegmentedError extends TypeError {
    constructor(code) {
        super(`Native segmented retention: ${code}.`);
        this.name = "NativeSegmentedError";
        this.code = code;
    }
}
export const segmentedFailure = code => { throw new NativeSegmentedError(code); };
const fail = segmentedFailure;
export const nativeCaptureReference = captureKey => nativeRetentionHash(["native-capture-index-v2", captureKey]);
export const nativeUnitReference = unitKey => nativeRetentionHash(["native-unit-index-v2", unitKey]);
export const nativeSourceId = record => `microsoft-365-${record.scope.surface}`;
export const nativeCallKey = (scope, id) => JSON.stringify([
    "m365-native-v0", scope.surface, scope.account.tenantId, scope.account.subjectId, scope.conversationId, "tool-call", id,
]);
export const nativeCallKeys = record => record.identity.callIds.map(id => nativeCallKey(record.scope, id));
export const nativeSegmentedRowsDigest = () => createHash("sha256").update("wire-native-segmented-rows-v2\0");
export function updateNativeSegmentedRowsDigest(hash, row) {
    const json = nativeRetentionJson(row);
    hash.update(String(Buffer.byteLength(json))).update(":").update(json);
}

export function nativeSegmentedRowKey(row) {
    switch (row.kind) {
    case "capture": return `c/${nativeCaptureReference(row.captureKey)}`;
    case "observation": return `o/${nativeObservationReference(row.identity)}`;
    case "variant": return `v/${row.observationRef}/${row.contentHash}`;
    case "variant-index": return `i/${row.observationRef}/${row.contentHash}`;
    case "record": return `r/${numericKey(row.inputOrdinal)}`;
    case "provenance": return `p/${row.observationRef}/${row.contentHash}/${nativeCaptureReference(row.provenance.captureKey)}/${nativeRetentionHash(row.provenance)}`;
    case "unit": return unitPrefix(row.sourceId, row.conversationKey, row.unitKind, row.unitKey, "u");
    case "membership": return `${unitPrefix(row.sourceId, row.conversationKey, row.unitKind, row.unitKey, "m")}/${numericKey(row.inputOrdinal)}`;
    default: return fail("row-kind-invalid");
    }
}

export function unitPrefix(sourceId, conversationKey, unitKind, unitKey, prefix = "m") {
    return `${prefix}/${sourceCode(sourceId)}/${nativeUnitReference(conversationKey)}/${unitKind}`
        + (unitKind === "call" ? unitKey === null ? "/" : `/${nativeUnitReference(unitKey)}` : "");
}

function captureShape(captureKey, capture) {
    if (!text(captureKey) || !object(capture)) fail("capture-invalid");
    let parts;
    try { parts = JSON.parse(captureKey); } catch { fail("capture-invalid"); }
    if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== "microsoft-365-copilot"
        || !["chat", "cowork"].includes(parts[1]) || parts[2] !== capture.captureId
        || nativeRetentionJson(parts) !== captureKey
        || !["captureId", "capturedAt", "generation", "parserVersion", "sourceSchema", "operation"].every(key => Object.hasOwn(capture, key))
        || Object.keys(capture).some(key => !["captureId", "capturedAt", "generation", "parserVersion", "sourceSchema", "operation", "origin", "bodyDigest"].includes(key))
        || !["captureId", "parserVersion", "sourceSchema", "operation"].every(key => text(capture[key]) && Buffer.byteLength(capture[key]) <= 1024)
        || typeof capture.capturedAt !== "string" || !Number.isFinite(Date.parse(capture.capturedAt))
        || !integer(capture.generation) || capture.bodyDigest !== undefined && !hash(capture.bodyDigest)) fail("capture-invalid");
    if (capture.origin !== undefined) {
        let origin;
        try { origin = new URL(capture.origin); } catch { fail("capture-invalid"); }
        if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
            || !["", "/"].includes(origin.pathname)) fail("capture-invalid");
    }
}

function provenanceShape(value) {
    if (!exact(value, ["captureKey", "ordering", "references"]) || !text(value.captureKey)
        || !object(value.ordering) || !Array.isArray(value.references) || value.references.length > 10000) fail("provenance-invalid");
    const ordering = value.ordering;
    if (!["pageOrdinal", "recordOrdinal", "completeness"].every(key => Object.hasOwn(ordering, key))
        || Object.keys(ordering).some(key => !["pageOrdinal", "frameOrdinal", "recordOrdinal", "completeness", "nativeEventId", "sequence", "sequenceScope"].includes(key))
        || !["pageOrdinal", "recordOrdinal"].every(key => integer(ordering[key]))
        || ["frameOrdinal", "sequence"].some(key => ordering[key] !== undefined && !integer(ordering[key]))
        || ordering.nativeEventId !== undefined && !text(ordering.nativeEventId)
        || ordering.sequenceScope !== undefined && !["conversation", "request", "unknown"].includes(ordering.sequenceScope)
        || !["response-only", "first-page-only", "drained-exposed-history", "gapped-domain-unqualified", "unknown"].includes(ordering.completeness)) {
        fail("provenance-invalid");
    }
    const seen = new Set();
    for (const reference of value.references) {
        if (!exact(reference, ["path", "value"]) || !Array.isArray(reference.path) || !reference.path.length || reference.path.length > 64
            || reference.path.some(key => typeof key !== "string" || ["__proto__", "constructor", "prototype", "value"].includes(key))
            || !["source", "evidence", "path", "subject"].includes(reference.path.at(-1))) fail("provenance-invalid");
        const key = JSON.stringify(reference.path);
        if (seen.has(key)) fail("provenance-invalid");
        seen.add(key);
    }
}

function variantReference(value) {
    return object(value) && hash(value.observationRef) && hash(value.contentHash);
}

export function validateNativeSegmentedRow(row, account) {
    if (!object(row)) fail("row-invalid");
    switch (row.kind) {
    case "capture":
        if (!exact(row, ["kind", "captureKey", "capture", "witness"])
            || !exact(row.witness, ["observationRef", "contentHash", "provenanceHash"])
            || !variantReference(row.witness) || !hash(row.witness.provenanceHash)) fail("capture-invalid");
        captureShape(row.captureKey, row.capture);
        break;
    case "observation":
        if (!exact(row, ["kind", "identity", "firstOrdinal", "lastOrdinal", "currentVariant"])
            || !text(row.identity) || !integer(row.firstOrdinal) || !integer(row.lastOrdinal)
            || row.firstOrdinal > row.lastOrdinal || !hash(row.currentVariant)) fail("observation-invalid");
        break;
    case "variant": {
        if (!exact(row, ["kind", "observationRef", "contentHash", "content", "seedCapture", "seedProvenance"])
            || !variantReference(row)) fail("variant-invalid");
        provenanceShape(row.seedProvenance);
        captureShape(row.seedProvenance.captureKey, row.seedCapture);
        const record = restoreNativeRetainedObservation(row.content, row.seedProvenance, row.seedCapture);
        validateNativeRetainedObservation(record);
        if (Object.hasOwn(record, "retention") || record.scope.account.tenantId !== account.tenantId
            || record.scope.account.subjectId !== account.subjectId
            || row.seedProvenance.captureKey !== JSON.stringify([record.scope.harness, record.scope.surface, record.capture.captureId])
            || nativeObservationReference(nativeRetainedObservationIdentity(record, account)) !== row.observationRef
            || nativeRetentionHash(row.content) !== row.contentHash
            || nativeRetentionHash(nativeRetainedObservationParts(record).content) !== row.contentHash) fail("variant-invalid");
        break;
    }
    case "variant-index":
        if (!exact(row, ["kind", "observationRef", "contentHash", "inputOrdinal"])
            || !variantReference(row) || !integer(row.inputOrdinal)) fail("variant-index-invalid");
        break;
    case "record":
        if (!exact(row, ["kind", "inputOrdinal", "observationRef", "contentHash", "sourceId", "conversationKey"])
            || !variantReference(row) || !integer(row.inputOrdinal) || !NATIVE_SEGMENTED_SOURCES.includes(row.sourceId)
            || !text(row.conversationKey)) fail("record-invalid");
        break;
    case "provenance":
        if (!exact(row, ["kind", "observationRef", "contentHash", "provenance"]) || !variantReference(row)) fail("provenance-invalid");
        provenanceShape(row.provenance);
        break;
    case "unit":
    case "membership": {
        const position = row.kind === "unit" ? "witnessOrdinal" : "inputOrdinal";
        if (!exact(row, ["kind", "unitKind", "sourceId", "conversationKey", "unitKey", position])
            || !["conversation", "call"].includes(row.unitKind) || !NATIVE_SEGMENTED_SOURCES.includes(row.sourceId)
            || !text(row.conversationKey) || !text(row.unitKey) || !integer(row[position])
            || row.unitKind === "conversation" && row.unitKey !== row.conversationKey) fail("membership-invalid");
        break;
    }
    default: fail("row-kind-invalid");
    }
    return row;
}

function descriptor(value) {
    if (!exact(value, ["hash", "kind", "level", "firstKey", "lastKey", "count"]) || !hash(value.hash)
        || !["page", "segment"].includes(value.kind) || !integer(value.level) || value.level > NATIVE_SEGMENTED_LIMITS.treeDepth
        || (value.kind === "segment") !== (value.level === 0)
        || !/^[a-z0-9/-]{1,300}$/.test(value.firstKey ?? "") || !/^[a-z0-9/-]{1,300}$/.test(value.lastKey ?? "")
        || value.firstKey > value.lastKey || !Number.isSafeInteger(value.count) || value.count < 1) fail("descriptor-invalid");
    return value;
}

export function validateNativeSegmentedBlock(block) {
    if (!object(block) || block.schemaVersion !== 2 || block.contractVersion !== NATIVE_SEGMENTED_CONTRACT
        || block.dataContract !== NATIVE_RETAINED_CONTRACT || block.policy !== NATIVE_RETENTION_POLICY_ID) fail("contract-invalid");
    if (nativeValueHasCredentials(block)) fail("credential-bearing-block");
    validateNativeRetainedAccount(block.account);
    if (block.kind === "root") {
        if (!exact(block, [...common, "tree"])) fail("root-invalid");
        if (block.tree !== null) descriptor(block.tree);
    } else if (block.kind === "page") {
        if (!exact(block, [...common, "level", "children"]) || !Number.isSafeInteger(block.level) || block.level < 1
            || block.level > NATIVE_SEGMENTED_LIMITS.treeDepth || !Array.isArray(block.children)
            || !block.children.length || block.children.length > NATIVE_SEGMENTED_LIMITS.pageChildren) fail("page-bound");
        let last = null, count = 0;
        for (const child of block.children) {
            descriptor(child);
            if (child.level !== block.level - 1 || last !== null && last >= child.firstKey) fail("page-order-invalid");
            last = child.lastKey;
            count += child.count;
            if (!Number.isSafeInteger(count)) fail("count-invalid");
        }
    } else if (block.kind === "segment") {
        if (!exact(block, [...common, "entries"]) || !Array.isArray(block.entries) || !block.entries.length
            || block.entries.length > NATIVE_SEGMENTED_LIMITS.segmentEntries) fail("segment-bound");
        let last = null;
        for (const row of block.entries) {
            validateNativeSegmentedRow(row, block.account);
            const key = nativeSegmentedRowKey(row);
            if (last !== null && last >= key) fail("segment-order-invalid");
            last = key;
        }
    } else fail("block-kind-invalid");
    return block;
}

export function nativeSegmentedEnvelope(account, kind, content) {
    return { ...content, schemaVersion: 2, contractVersion: NATIVE_SEGMENTED_CONTRACT, dataContract: NATIVE_RETAINED_CONTRACT,
        policy: NATIVE_RETENTION_POLICY_ID, account: structuredClone(account), kind };
}

export function encodeNativeSegmentedBlock(block) {
    validateNativeSegmentedBlock(block);
    const json = nativeRetentionJson(block);
    if (Buffer.byteLength(json) > NATIVE_SEGMENTED_LIMITS.bytes) fail("block-byte-bound");
    return Object.freeze({ hash: createHash("sha256").update(json).digest("hex"), json });
}

export function decodeNativeSegmentedBlock(bytes, expectedHash) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > NATIVE_SEGMENTED_LIMITS.bytes || !hash(expectedHash)) fail("block-byte-bound");
    const input = Buffer.from(bytes);
    if (createHash("sha256").update(input).digest("hex") !== expectedHash) fail("block-integrity");
    let block;
    try { block = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); }
    catch { fail("block-json-invalid"); }
    validateNativeSegmentedBlock(block);
    if (!input.equals(Buffer.from(nativeRetentionJson(block)))) fail("block-not-canonical");
    return freeze(block);
}

export function describeNativeSegmentedBlock(block, hashValue) {
    validateNativeSegmentedBlock(block);
    if (!hash(hashValue) || block.kind === "root") fail("descriptor-invalid");
    const firstKey = block.kind === "segment" ? nativeSegmentedRowKey(block.entries[0]) : block.children[0].firstKey;
    const lastKey = block.kind === "segment" ? nativeSegmentedRowKey(block.entries.at(-1)) : block.children.at(-1).lastKey;
    const count = block.kind === "segment" ? block.entries.length : block.children.reduce((sum, child) => sum + child.count, 0);
    return freeze({ hash: hashValue, kind: block.kind, level: block.kind === "segment" ? 0 : block.level, firstKey, lastKey, count });
}

export function nativeVariantUnits(record) {
    const sourceId = nativeSourceId(record), conversationKey = nativeConversationIdentity(record.scope);
    return [{ unitKind: "conversation", sourceId, conversationKey, unitKey: conversationKey },
        ...nativeCallKeys(record).map(unitKey => ({ unitKind: "call", sourceId, conversationKey, unitKey }))];
}
