import { createHash } from "node:crypto";
import { nativeValueHasCredentials, measureNativeJson, NATIVE_JSON_LIMITS } from "./native-read-model.mjs";
import { nativeRetentionHash, nativeRetentionJson, restoreNativeRetainedObservation } from "./native-retention-contract.mjs";
import { NATIVE_SEGMENTED_LIMITS, NATIVE_SEGMENTED_SOURCES, nativeCaptureReference,
    unitPrefix, segmentedFailure as fail } from "./native-segmented-codec.mjs";

const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const freeze = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};
const digest = () => createHash("sha256").update("wire-native-selected-entries-v2\0");
const totals = () => ({ conversations: 0, variants: 0, provenanceEntries: 0, calls: 0, callMemberships: 0 });
export function updateNativeSelectionDigest(hash, entry) {
    const json = nativeRetentionJson(entry);
    hash.update(String(Buffer.byteLength(json))).update(":").update(json);
}
export function normalizeNativeSelectionQuery(query) {
    if (!exact(query, ["sources", "scenarioIds"]) || !Array.isArray(query.sources) || !query.sources.length
        || query.sources.length > 2 || new Set(query.sources).size !== query.sources.length
        || query.sources.some(source => !NATIVE_SEGMENTED_SOURCES.includes(source))
        || query.scenarioIds !== null && (!Array.isArray(query.scenarioIds)
            || query.scenarioIds.length > NATIVE_SEGMENTED_LIMITS.queryIds
            || query.scenarioIds.some(id => typeof id !== "string" || !id)
            || new Set(query.scenarioIds).size !== query.scenarioIds.length)) fail("selection-invalid");
    if (nativeValueHasCredentials(query)) fail("selection-invalid");
    return freeze({ sources: query.sources.toSorted(), scenarioIds: query.scenarioIds === null ? null : query.scenarioIds.toSorted() });
}

// The caller supplies an already validated index and its own current-access check.
export function createNativeSelectionQuery({ rootHash, rows, find, check }) {
    const selections = new WeakMap();
    async function requireRow(key, kind, localSignal) {
        const value = await find(key, localSignal);
        if (!value || value.kind !== kind) fail("membership-missing");
        return value;
    }
    async function* selectedUnits(query, localSignal) {
        for await (const { row } of rows("u/", null, localSignal)) {
            if (row.unitKind !== "conversation" || !query.sources.includes(row.sourceId)) continue;
            if (query.scenarioIds !== null && !query.scenarioIds.includes(row.unitKey)) continue;
            yield row;
        }
    }
    async function entryFor(member, localSignal) {
        const row = await requireRow(`r/${String(member.inputOrdinal).padStart(16, "0")}`, "record", localSignal);
        const variant = await requireRow(`v/${row.observationRef}/${row.contentHash}`, "variant", localSignal);
        const observation = await requireRow(`o/${row.observationRef}`, "observation", localSignal);
        let provenanceEntries = 0, captureCount = 0, lastCapture = null;
        for await (const { row: provenance } of rows(`p/${row.observationRef}/${row.contentHash}/`, null, localSignal)) {
            provenanceEntries++;
            const capture = nativeCaptureReference(provenance.provenance.captureKey);
            if (capture !== lastCapture) { captureCount++; lastCapture = capture; }
        }
        const record = { ...restoreNativeRetainedObservation(variant.content, variant.seedProvenance, variant.seedCapture), retention: {
            variant: row.contentHash, current: observation.currentVariant === row.contentHash, captureCount,
        } };
        const entry = freeze({ inputOrdinal: row.inputOrdinal, record });
        if (nativeValueHasCredentials(entry)) fail("credential-bearing-result");
        return { entry, provenanceEntries, callMemberships: record.identity.callIds.length };
    }
    async function entryAt(inputOrdinal, { signal: localSignal } = {}) {
        check(localSignal);
        if (!Number.isSafeInteger(inputOrdinal) || inputOrdinal < 0) fail("index-key-invalid");
        const value = await entryFor({ inputOrdinal }, localSignal);
        check(localSignal);
        return value.entry;
    }
    async function select(query, { signal: localSignal } = {}) {
        check(localSignal);
        query = normalizeNativeSelectionQuery(query);
        const expected = totals(), hashed = digest(), found = query.scenarioIds === null ? null : new Set();
        for await (const unit of selectedUnits(query, localSignal)) {
            expected.conversations++;
            found?.add(unit.unitKey);
            for await (const { row } of rows(unitPrefix(unit.sourceId, unit.conversationKey, "call", null, "u"), null, localSignal)) {
                if (row.kind === "unit" && row.unitKind === "call" && row.conversationKey === unit.conversationKey) expected.calls++;
            }
            for await (const { row } of rows(unitPrefix(unit.sourceId, unit.conversationKey, "conversation", unit.unitKey) + "/", null, localSignal)) {
                const value = await entryFor(row, localSignal);
                expected.variants++; expected.provenanceEntries += value.provenanceEntries;
                expected.callMemberships += value.callMemberships;
                updateNativeSelectionDigest(hashed, value.entry);
            }
        }
        if (found && found.size !== query.scenarioIds.length) fail("selection-membership-missing");
        check(localSignal);
        const selectionRef = nativeRetentionHash(["native-selected-query-v2", rootHash, query]);
        const frame = freeze({ schemaVersion: 1, kind: "native-selected-record-stream", rootHash, selectionRef,
            sources: query.sources, expected: { ...expected, entriesDigest: hashed.digest("hex") } });
        selections.set(frame, query);
        return frame;
    }
    async function* iterate(frame, { signal: localSignal } = {}) {
        const query = selections.get(frame);
        if (!query) fail("selection-frame-invalid");
        check(localSignal);
        yield freeze({ schemaVersion: 1, kind: "selection-start", rootHash, selectionRef: frame.selectionRef, expected: frame.expected });
        const observed = totals(), hashed = digest();
        let partIndex = 0;
        for await (const unit of selectedUnits(query, localSignal)) {
            observed.conversations++;
            for await (const { row } of rows(unitPrefix(unit.sourceId, unit.conversationKey, "call", null, "u"), null, localSignal)) {
                if (row.kind === "unit" && row.unitKind === "call" && row.conversationKey === unit.conversationKey) observed.calls++;
            }
            let entries = [], bytes = 0, nodes = 0;
            const envelope = values => ({ schemaVersion: 1, kind: "conversation-part", rootHash, selectionRef: frame.selectionRef, sourceId: unit.sourceId,
                conversationKey: unit.conversationKey, partIndex, entries: values });
            const part = () => {
                const value = envelope(entries);
                if (nativeValueHasCredentials(value)) fail("credential-bearing-result");
                partIndex++;
                return freeze(value);
            };
            for await (const { row } of rows(unitPrefix(unit.sourceId, unit.conversationKey, "conversation", unit.unitKey) + "/", null, localSignal)) {
                const value = await entryFor(row, localSignal), measured = measureNativeJson(value.entry);
                let overhead = measureNativeJson(envelope([]));
                if (entries.length && (entries.length === NATIVE_SEGMENTED_LIMITS.resultEntries
                    || bytes + measured.bytes + 1 + overhead.bytes > NATIVE_SEGMENTED_LIMITS.bytes
                    || nodes + measured.nodes + overhead.nodes > NATIVE_JSON_LIMITS.nodes)) {
                    check(localSignal); yield part(); entries = []; bytes = 0; nodes = 0;
                    overhead = measureNativeJson(envelope([]));
                }
                if (measured.bytes + overhead.bytes > NATIVE_SEGMENTED_LIMITS.bytes
                    || measured.nodes + overhead.nodes > NATIVE_JSON_LIMITS.nodes
                    || measured.height + 2 > NATIVE_JSON_LIMITS.depth) fail("result-entry-bound");
                bytes += measured.bytes + (entries.length ? 1 : 0); nodes += measured.nodes;
                entries.push(value.entry);
                observed.variants++; observed.provenanceEntries += value.provenanceEntries;
                observed.callMemberships += value.callMemberships;
                updateNativeSelectionDigest(hashed, value.entry);
            }
            if (entries.length) { check(localSignal); yield part(); }
        }
        const result = { ...observed, entriesDigest: hashed.digest("hex") };
        if (nativeRetentionHash(result) !== nativeRetentionHash(frame.expected)) fail("selection-completion-mismatch");
        check(localSignal);
        yield freeze({ schemaVersion: 1, kind: "selection-end", rootHash, selectionRef: frame.selectionRef, parts: partIndex, observed: result });
    }
    return Object.freeze({ select, iterate, entryAt });
}
