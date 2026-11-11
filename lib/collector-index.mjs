import path from "node:path";
import { atomicJson, readJson } from "./collector-io.mjs";

export const emptyCollectorIndex = () => ({ schemaVersion: 1, sources: {},
    metrics: { totalBytesRead: 0, cycles: 0 }, lastCheckedAt: null, lastNewDataAt: null });

export function validateCollectorIndex(index) {
    if (![1, 2, 3, 4].includes(index?.schemaVersion) || index.schemaVersion >= 2 && index.boundedHistoryVersion !== 1
        || index.schemaVersion >= 3 && !index.ownerHost
        || index.schemaVersion === 4 && (index.completionReferenceVersion !== 1 || !/^[a-f0-9]{64}$/.test(index.completionReferenceStore ?? ""))
        || index.schemaVersion !== 4 && (index.completionReferenceVersion !== undefined || index.completionReferenceStore !== undefined)) {
        throw new Error("Unsupported collector checkpoint version.");
    }
    if (index.ownerHost !== undefined && (!index.ownerHost || typeof index.ownerHost.platform !== "string"
        || !/^[a-f0-9]{64}$/.test(index.ownerHost.machine ?? "")
        || Object.keys(index.ownerHost).some(key => !["platform", "machine"].includes(key)))) {
        throw new Error("Unsupported collection owner host.");
    }
    if (index.schemaVersion === 4 && (!Array.isArray(index.completionReferenceSources) || index.completionReferenceSources.length > 64
        || index.completionReferenceSources.some(source => !source || Object.keys(source).length !== 2
            || !/^[a-f0-9]{64}$/.test(source.fingerprint ?? "")
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(source.sourceSessionId ?? ""))
        || new Set(index.completionReferenceSources.map(source => JSON.stringify([source.fingerprint, source.sourceSessionId]))).size !== index.completionReferenceSources.length)
        || index.schemaVersion !== 4 && index.completionReferenceSources !== undefined) {
        throw new Error("Unsupported completion-reference source registry.");
    }
    if (index.completionReferenceMaintenance !== undefined && (index.schemaVersion !== 4
        || !index.completionReferenceMaintenance || Object.keys(index.completionReferenceMaintenance).length !== 2
        || !/^[a-f0-9-]{36}$/i.test(index.completionReferenceMaintenance.operationId ?? "")
        || !/^[a-f0-9]{64}$/.test(index.completionReferenceMaintenance.planSha256 ?? ""))) {
        throw new Error("Unsupported completion-reference maintenance fence.");
    }
    return index;
}

export const withCollectorIndexBarrier = index => ({ ...index, schemaVersion: index.schemaVersion === 4 ? 4 : index.ownerHost ? 3 : 2, boundedHistoryVersion: 1 });

// Only committed disk state belongs in the early barrier. Prospective offsets remain in the caller until evidence commits.
export async function installCollectorIndexBarrier(root, assertCurrent, ownerHost) {
    if (typeof assertCurrent !== "function") throw new TypeError("Collector index migration requires its current acquisition guard.");
    assertCurrent();
    const file = path.join(root, "index.json");
    const committed = validateCollectorIndex(await readJson(file, emptyCollectorIndex()));
    assertCurrent();
    if (ownerHost && committed.ownerHost && (committed.ownerHost.platform !== ownerHost.platform
        || committed.ownerHost.machine !== ownerHost.machine)) throw new Error("Collector owner host changed.");
    if (committed.schemaVersion >= (ownerHost ? 3 : 2)) return committed;
    const barrier = validateCollectorIndex(withCollectorIndexBarrier({ ...committed, ...(ownerHost ? { ownerHost } : {}) }));
    await atomicJson(file, barrier, { assertCurrent });
    return barrier;
}
