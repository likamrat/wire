import { nativeRetentionJson } from "./native-retention-contract.mjs";
import { nativeObservationReference, nativeCaptureReference, nativeSegmentedRowKey, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { openNativeSegmentedReader } from "./native-segmented-read.mjs";
import { nativeSegmentedCaptureSource } from "./native-segmented-v1.mjs";
import { stageNativeSegmentedTree } from "./native-segmented-stage.mjs";

const same = (left, right) => nativeRetentionJson(left) === nativeRetentionJson(right);
const variantKey = row => `${row.observationRef}/${row.contentHash}`;

export async function stageNativeSegmentedCapture({ rootHash, capture, readBlock, writeBlock, assertCurrent, signal,
    assertObservationRetained = () => {} } = {}) {
    if (typeof assertObservationRetained !== "function") fail("deletion-check-required");
    const source = nativeSegmentedCaptureSource(capture, { assertCurrent, signal });
    const reader = await openNativeSegmentedReader({ rootHash, readBlock, assertCurrent, signal, expectedAccount: source.plan.account });
    try {
        function checkObservation(identity) {
            const result = assertObservationRetained(identity);
            if (result && typeof result.then === "function") {
                Promise.resolve(result).catch(() => {});
                fail("asynchronous-deletion-check");
            }
            if (result !== undefined && result !== true) fail("deleted-observation");
        }
        const groups = new Map(), insertions = [], knownVariants = new Set(), knownCaptures = new Set();
        const mappings = [], newOrdinals = new Set();
        let localOrdinal = 0, knownVariantCount = 0, additionsWithinOld = 0;
        for (const item of source.plan.captures) {
            const stored = await reader.lookupRow(`c/${nativeCaptureReference(item.key)}`);
            if (stored) {
                if (stored.captureKey !== item.key || !same(stored.capture, item.value)) fail("capture-mismatch");
                knownCaptures.add(item.key);
            }
        }
        for (const observation of source.plan.observations) {
            checkObservation(observation.key);
            const reference = nativeObservationReference(observation.key), old = await reader.lookupRow(`o/${reference}`);
            if (old && old.identity !== observation.key) fail("identity-mismatch");
            const group = { observation, old, values: [], added: 0 };
            for (const variant of observation.variants) {
                const key = `${reference}/${variant.hash}`, index = await reader.lookupRow(`i/${key}`);
                const value = { localOrdinal: localOrdinal++, known: Boolean(index), inputOrdinal: index?.inputOrdinal };
                group.values.push(value);
                if (index) {
                    const stored = await reader.lookupRow(`v/${key}`);
                    if (!stored || !same(stored.content, variant.content)) fail("variant-content-conflict");
                    knownVariants.add(key); knownVariantCount++;
                } else group.added++;
            }
            groups.set(reference, group);
            if (old && group.added) {
                additionsWithinOld += group.added;
                insertions.push({ after: old.lastOrdinal, added: group.added, total: 0 });
            }
        }
        insertions.sort((left, right) => left.after - right.after);
        let total = 0;
        for (const insertion of insertions) {
            total += insertion.added;
            if (!Number.isSafeInteger(total)) fail("count-invalid");
            insertion.total = total;
        }
        function shift(ordinal) {
            let lower = 0, upper = insertions.length;
            while (lower < upper) {
                const middle = Math.floor((lower + upper) / 2);
                if (insertions[middle].after < ordinal) lower = middle + 1;
                else upper = middle;
            }
            const result = ordinal + (lower ? insertions[lower - 1].total : 0);
            if (!Number.isSafeInteger(result)) fail("count-invalid");
            return result;
        }
        let appended = reader.recordCount + additionsWithinOld;
        if (!Number.isSafeInteger(appended)) fail("count-invalid");
        for (const group of groups.values()) {
            let next = group.old ? shift(group.old.lastOrdinal) + 1 : appended;
            for (const value of group.values) {
                if (value.known) value.inputOrdinal = shift(value.inputOrdinal);
                else { value.inputOrdinal = next++; newOrdinals.add(value.inputOrdinal); }
                if (!Number.isSafeInteger(value.inputOrdinal)) fail("count-invalid");
                mappings[value.localOrdinal] = value.inputOrdinal;
            }
            group.firstOrdinal = group.old ? shift(group.old.firstOrdinal) : appended;
            group.lastOrdinal = group.old ? shift(group.old.lastOrdinal) + group.added : next - 1;
            if (!group.old) appended = next;
        }
        if (!Number.isSafeInteger(appended)) fail("count-invalid");
        const changes = { addedCaptures: 0, addedObservations: 0, addedVariants: 0, addedProvenance: 0,
            reusedObservations: source.plan.changes.reusedObservations + knownVariantCount };
        function oldRow(row) {
            if (row.kind === "observation") {
                checkObservation(row.identity);
                const group = groups.get(nativeObservationReference(row.identity));
                return { ...row, firstOrdinal: shift(row.firstOrdinal), lastOrdinal: shift(row.lastOrdinal) + (group?.added ?? 0),
                    currentVariant: group?.observation.currentVariant ?? row.currentVariant };
            }
            if (["record", "variant-index", "membership"].includes(row.kind)) return { ...row, inputOrdinal: shift(row.inputOrdinal) };
            if (row.kind === "unit") return { ...row, witnessOrdinal: shift(row.witnessOrdinal) };
            return row;
        }
        function incomingRow(row) {
            if (row.kind === "observation") {
                const group = groups.get(nativeObservationReference(row.identity));
                return { ...row, firstOrdinal: group.firstOrdinal, lastOrdinal: group.lastOrdinal };
            }
            if (["record", "variant-index", "membership"].includes(row.kind)) return { ...row, inputOrdinal: mappings[row.inputOrdinal] };
            return row;
        }
        async function* incoming() {
            for await (const row of source.iterate(incomingRow)) {
                if (row.kind === "capture" && knownCaptures.has(row.captureKey)
                    || row.kind === "variant" && knownVariants.has(variantKey(row))
                    || ["record", "variant-index", "membership"].includes(row.kind) && !newOrdinals.has(row.inputOrdinal)) continue;
                if (row.kind === "unit" && await reader.lookupRow(nativeSegmentedRowKey(row))) continue;
                yield row;
            }
        }
        let visitedOld = 0, addedRows = 0;
        function added(row) {
            addedRows++;
            if (row.kind === "capture") changes.addedCaptures++;
            else if (row.kind === "observation") changes.addedObservations++;
            else if (row.kind === "variant") changes.addedVariants++;
            else if (row.kind === "provenance") changes.addedProvenance++;
            return row;
        }
        async function* merged() {
            const previous = reader.iterateRows(), current = incoming();
            try {
                let left = await previous.next(), right = await current.next();
                while (!left.done || !right.done) {
                    const a = left.done ? null : oldRow(left.value), b = right.done ? null : right.value;
                    const aKey = a ? nativeSegmentedRowKey(a) : null, bKey = b ? nativeSegmentedRowKey(b) : null;
                    if (a && (!b || aKey < bKey)) {
                        yield a; visitedOld++; left = await previous.next();
                    } else if (b && (!a || bKey < aKey)) {
                        yield added(b); right = await current.next();
                    } else {
                        if (!same(a, b)) fail("merge-row-conflict");
                        yield a; visitedOld++;
                        left = await previous.next(); right = await current.next();
                    }
                }
            } finally { await previous.return(); await current.return(); }
        }
        const candidate = await stageNativeSegmentedTree({ account: reader.account, rows: merged(), readBlock, writeBlock, assertCurrent, signal });
        if (visitedOld !== reader.rowCount || candidate.rows !== reader.rowCount + addedRows || candidate.recordCount !== appended
            || changes.addedVariants !== newOrdinals.size) fail("merge-conservation-mismatch");
        return Object.freeze({ candidate, changes: Object.freeze(changes) });
    } finally { reader.close(); }
}
