import { createHmac } from "node:crypto";
import { BoardError } from "./store.mjs";
import { nativeRetentionHash } from "./native-retention-contract.mjs";
import { nativeValueHasCredentials, NativeReadModelError, NATIVE_READ_LIMITS } from "./native-read-model.mjs";

const invalid = () => { throw new BoardError("Native report selection has unsupported identities or definitions.", 422); };
const object = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

// Optimistic view dependencies only; a matching fingerprint is never source authority.
export function nativeReportSelectionExpectations(records, definitions, key) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !Array.isArray(records) || records.length > NATIVE_READ_LIMITS.records
        || !object(definitions) || Object.values(definitions).some(value => typeof value !== "string" || !value || value.length > 4000)
        || new Set(records.map(record => record?.scenarioId)).size !== records.length
        || records.some(record => record?.recordKind !== "native-conversation" || typeof record.scenarioId !== "string"
            || !record.scenarioId || !object(record.nativeConversation))) invalid();
    try {
        if (nativeValueHasCredentials(records)) invalid();
    } catch (error) {
        if (!(error instanceof NativeReadModelError)) throw error;
        throw new BoardError("Native report selection exceeds its supported source contract. Narrow the selection.", 422);
    }
    const sorted = records.toSorted((a, b) => a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0);
    return Object.freeze(sorted.map(record => Object.freeze({
        scenarioId: record.scenarioId,
        fingerprint: createHmac("sha256", key).update("wire-native-report-selection-v1:")
            .update(nativeRetentionHash({ record, definitions })).digest("hex"),
    })));
}

export function assertNativeReportSelection(expected, records, definitions, key) {
    if (!Array.isArray(expected) || expected.length > NATIVE_READ_LIMITS.records
        || expected.some(item => !object(item) || Object.keys(item).length !== 2
            || typeof item.scenarioId !== "string" || !item.scenarioId
            || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint))
        || new Set(expected.map(item => item.scenarioId)).size !== expected.length) invalid();
    const originals = new Map(expected.map(item => [item.scenarioId, item.fingerprint]));
    const actual = nativeReportSelectionExpectations(records, definitions, key);
    if (actual.length !== expected.length || actual.some(item => originals.get(item.scenarioId) !== item.fingerprint)) {
        throw new BoardError("Selected native evidence or its interpretation changed. Prepare a fresh report preview.", 409);
    }
    return true;
}
