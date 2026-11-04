import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument } from "../lib/native-retention-contract.mjs";
import { NATIVE_RETENTION_POLICY_ID } from "../lib/native-retention-state.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";

export const nativeReportKey = "7".repeat(64);
export function nativeReportFrame(envelopes = [...chatFixture(), ...coworkFixture()]) {
    const account = { partition: "c".repeat(64), issuer: "https://invented.invalid",
        tenantId: "invented-tenant", subjectId: "invented-subject" };
    const capture = encodeNativeRetainedCapture(account, envelopes);
    const { document } = mergeNativeRetainedCapture(null, capture);
    const retained = validateNativeRetainedDocument(document);
    const projected = projectRetainedNativeRecords(retained);
    return { records: projected.records, source: { schemaVersion: 1, contractVersion: retained.contractVersion,
        policy: NATIVE_RETENTION_POLICY_ID, sourceSnapshotRef: "a".repeat(64), sourceRevisionRef: "b".repeat(64),
        configurationRevision: 1, privacyRevision: 1, deletionVersion: 0, definitions: projected.definitions } };
}
