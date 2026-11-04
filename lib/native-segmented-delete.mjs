import { nativeObservationDeletionAliases } from "./deletion-identities.mjs";
import { nativeRetentionHash, validateNativeRetainedAccount } from "./native-retention-contract.mjs";
import { nativeCaptureReference, unitPrefix, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { openNativeSegmentedReader } from "./native-segmented-read.mjs";
import { stageNativeSegmentedTree } from "./native-segmented-stage.mjs";
import { DELETION_LIMITS } from "./deletion-limits.mjs";

// Produces screened replacement blocks only. The admitted deletion owner must
// seal tombstones, pointer replacements and its cleanup journal atomically.
export async function stageNativeSegmentedDeletion({ rootHash, account, identities, maxIndexBytes = DELETION_LIMITS.metadataBytes,
    readBlock, writeBlock, assertCurrent, signal } = {}) {
    if (!Array.isArray(identities) || identities.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        || new Set(identities).size !== identities.length || !Number.isSafeInteger(maxIndexBytes) || maxIndexBytes < 1
        || maxIndexBytes > DELETION_LIMITS.metadataBytes
        || Buffer.byteLength(JSON.stringify(identities)) > maxIndexBytes) fail("deletion-index-bound");
    validateNativeRetainedAccount(account);
    const blocked = new Set(identities);
    const reader = await openNativeSegmentedReader({ rootHash, expectedAccount: account, readBlock, assertCurrent, signal });
    try {
        const ranges = [];
        let indexBytes = 2, removedVariants = 0;
        for await (const observation of reader.iterateRows({ prefix: "o/" })) {
            if (!nativeObservationDeletionAliases(observation.identity).some(key => blocked.has(key))) continue;
            const value = { first: observation.firstOrdinal, last: observation.lastOrdinal, removedBefore: 0 };
            indexBytes += Buffer.byteLength(JSON.stringify(value)) + (ranges.length ? 1 : 0);
            if (indexBytes > maxIndexBytes) fail("deletion-index-bound");
            ranges.push(value);
        }
        if (!ranges.length) return Object.freeze({ rootHash, candidate: null, removedObservations: 0, removedVariants: 0 });
        ranges.sort((a, b) => a.first - b.first);
        indexBytes = 2;
        for (const range of ranges) {
            range.removedBefore = removedVariants;
            removedVariants += range.last - range.first + 1;
            if (!Number.isSafeInteger(removedVariants)) fail("count-invalid");
            indexBytes += Buffer.byteLength(JSON.stringify(range)) + 1;
            if (indexBytes > maxIndexBytes) fail("deletion-index-bound");
        }
        function retainedOrdinal(ordinal) {
            let lower = 0, upper = ranges.length;
            while (lower < upper) {
                const middle = Math.floor((lower + upper) / 2);
                if (ranges[middle].first <= ordinal) lower = middle + 1;
                else upper = middle;
            }
            if (!lower) return ordinal;
            const range = ranges[lower - 1];
            return ordinal <= range.last ? null : ordinal - range.removedBefore - (range.last - range.first + 1);
        }
        async function retainedVariant(row) {
            const index = await reader.lookupRow(`i/${row.observationRef}/${row.contentHash}`);
            if (!index) fail("membership-missing");
            return retainedOrdinal(index.inputOrdinal) !== null;
        }
        async function captureWitness(row) {
            if (await retainedVariant(row.witness)) return row.witness;
            const captureRef = nativeCaptureReference(row.captureKey);
            for await (const provenance of reader.iterateRows({ prefix: "p/" })) {
                if (nativeCaptureReference(provenance.provenance.captureKey) !== captureRef) continue;
                if (provenance.provenance.captureKey !== row.captureKey) fail("capture-mismatch");
                if (await retainedVariant(provenance)) return { observationRef: provenance.observationRef,
                    contentHash: provenance.contentHash, provenanceHash: nativeRetentionHash(provenance.provenance) };
            }
            return null;
        }
        let removedRows = 0, visited = 0;
        async function* remainingRows() {
            for await (const row of reader.iterateRows()) {
                visited++;
                let kept = row;
                if (row.kind === "capture") {
                    const witness = await captureWitness(row);
                    kept = witness ? { ...row, witness } : null;
                } else if (row.kind === "observation") {
                    const firstOrdinal = retainedOrdinal(row.firstOrdinal), lastOrdinal = retainedOrdinal(row.lastOrdinal);
                    if ((firstOrdinal === null) !== (lastOrdinal === null)) fail("deletion-range-invalid");
                    kept = firstOrdinal === null ? null : { ...row, firstOrdinal, lastOrdinal };
                } else if (["variant", "provenance"].includes(row.kind)) {
                    if (!await retainedVariant(row)) kept = null;
                } else if (["record", "variant-index", "membership"].includes(row.kind)) {
                    const inputOrdinal = retainedOrdinal(row.inputOrdinal);
                    kept = inputOrdinal === null ? null : { ...row, inputOrdinal };
                } else if (row.kind === "unit") {
                    let witnessOrdinal = retainedOrdinal(row.witnessOrdinal);
                    if (witnessOrdinal === null) {
                        for await (const member of reader.iterateRows({
                            prefix: unitPrefix(row.sourceId, row.conversationKey, row.unitKind, row.unitKey) + "/",
                        })) {
                            witnessOrdinal = retainedOrdinal(member.inputOrdinal);
                            if (witnessOrdinal !== null) break;
                        }
                    }
                    kept = witnessOrdinal === null ? null : { ...row, witnessOrdinal };
                }
                if (kept) yield kept;
                else removedRows++;
            }
        }
        const candidate = await stageNativeSegmentedTree({ account: reader.account, rows: remainingRows(),
            readBlock, writeBlock, assertCurrent, signal });
        if (visited !== reader.rowCount || candidate.rows !== visited - removedRows
            || candidate.recordCount !== reader.recordCount - removedVariants) fail("deletion-conservation-mismatch");
        return Object.freeze({ rootHash: candidate.rootHash, candidate, removedObservations: ranges.length, removedVariants });
    } finally { reader.close(); }
}
