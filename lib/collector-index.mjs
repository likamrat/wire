import path from "node:path";
import { atomicJson, readJson } from "./collector-io.mjs";

export const emptyCollectorIndex = () => ({ schemaVersion: 1, sources: {},
    metrics: { totalBytesRead: 0, cycles: 0 }, lastCheckedAt: null, lastNewDataAt: null });

export function validateCollectorIndex(index) {
    if (![1, 2, 3].includes(index?.schemaVersion) || index.schemaVersion >= 2 && index.boundedHistoryVersion !== 1
        || index.schemaVersion === 3 && !index.ownerHost) {
        throw new Error("Unsupported collector checkpoint version.");
    }
    if (index.ownerHost !== undefined && (!index.ownerHost || typeof index.ownerHost.platform !== "string"
        || !/^[a-f0-9]{64}$/.test(index.ownerHost.machine ?? "")
        || Object.keys(index.ownerHost).some(key => !["platform", "machine"].includes(key)))) {
        throw new Error("Unsupported collection owner host.");
    }
    return index;
}

export const withCollectorIndexBarrier = index => ({ ...index, schemaVersion: index.ownerHost ? 3 : 2, boundedHistoryVersion: 1 });

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
