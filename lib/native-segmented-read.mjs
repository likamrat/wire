import { setImmediate } from "node:timers/promises";
import { nativeConversationIdentity, validateNativeRetainedObservation, nativeRetainedDefinitions } from "./native-read-model.mjs";
import { nativeRetentionHash, nativeRetainedObservationIdentity,
    nativeRetainedObservationParts, restoreNativeRetainedObservation, validateNativeRetainedAccount } from "./native-retention-contract.mjs";
import { NATIVE_SEGMENTED_LIMITS, decodeNativeSegmentedBlock,
    describeNativeSegmentedBlock, nativeSegmentedRowKey, nativeObservationReference, nativeCaptureReference,
    nativeSourceId, nativeVariantUnits, unitPrefix, nativeSegmentedRowsDigest, updateNativeSegmentedRowsDigest,
    segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { createNativeSelectionQuery } from "./native-selected-read.mjs";
export { updateNativeSelectionDigest } from "./native-selected-read.mjs";

const pad = value => String(value).padStart(16, "0");
const same = (a, b) => nativeRetentionHash(a) === nativeRetentionHash(b);

// This is a codec/query module, not an account or request authorizer.
export async function openNativeSegmentedReader({ rootHash, readBlock, assertCurrent, signal, expectedAccount } = {}) {
    if (typeof rootHash !== "string" || !/^[a-f0-9]{64}$/.test(rootHash)
        || typeof readBlock !== "function" || typeof assertCurrent !== "function") fail("reader-binding-required");
    if (expectedAccount !== undefined) expectedAccount = structuredClone(validateNativeRetainedAccount(expectedAccount));
    let closed = false, account, cachedBytes = 0;
    const cache = new Map();
    function check(localSignal) {
        if (closed || signal?.aborted || localSignal?.aborted) fail("reader-cancelled");
        const value = assertCurrent();
        if (value && typeof value.then === "function") {
            Promise.resolve(value).catch(() => {});
            fail("asynchronous-authority-check");
        }
        if (value !== undefined && value !== true) fail("reader-revoked");
    }
    async function load(hash, expected, localSignal) {
        check(localSignal);
        let held = cache.get(hash);
        if (held) { cache.delete(hash); cache.set(hash, held); }
        else {
            const bytes = await readBlock(hash, { maxBytes: NATIVE_SEGMENTED_LIMITS.bytes, signal: localSignal ?? signal });
            check(localSignal);
            const block = decodeNativeSegmentedBlock(bytes, hash);
            held = { block, bytes: bytes.byteLength,
                descriptor: block.kind === "root" ? null : describeNativeSegmentedBlock(block, hash) };
            while (cachedBytes + held.bytes > NATIVE_SEGMENTED_LIMITS.cacheBytes && cache.size) {
                const first = cache.keys().next().value;
                cachedBytes -= cache.get(first).bytes; cache.delete(first);
            }
            cache.set(hash, held); cachedBytes += held.bytes;
        }
        if (account && !same(held.block.account, account)) fail("account-mismatch");
        if (expected && !same(held.descriptor, expected)) fail("descriptor-mismatch");
        return held.block;
    }
    const root = await load(rootHash);
    if (root.kind !== "root") fail("root-required");
    account = root.account;
    if (expectedAccount && !same(account, expectedAccount)) fail("account-mismatch");

    async function* rows(prefix = "", after = null, localSignal) {
        if (root.tree === null) return;
        const stack = [root.tree], upper = prefix + "\uffff";
        while (stack.length) {
            check(localSignal);
            const item = stack.pop();
            if (item.lastKey < prefix || item.firstKey > upper || after !== null && item.lastKey <= after) continue;
            const block = await load(item.hash, item, localSignal);
            if (block.kind === "page") {
                for (let index = block.children.length - 1; index >= 0; index--) stack.push(block.children[index]);
                if (stack.length > NATIVE_SEGMENTED_LIMITS.pageChildren * NATIVE_SEGMENTED_LIMITS.treeDepth) fail("traversal-bound");
            } else {
                for (const row of block.entries) {
                    const key = nativeSegmentedRowKey(row);
                    if (key.startsWith(prefix) && (after === null || key > after)) yield { key, row };
                }
                await setImmediate();
            }
        }
    }
    async function find(key, localSignal) {
        let item = root.tree;
        while (item) {
            if (key < item.firstKey || key > item.lastKey) return null;
            const block = await load(item.hash, item, localSignal);
            if (block.kind === "segment") return block.entries.find(row => nativeSegmentedRowKey(row) === key) ?? null;
            item = block.children.find(child => child.firstKey <= key && child.lastKey >= key);
        }
        return null;
    }
    async function requireRow(key, kind, localSignal) {
        const value = await find(key, localSignal);
        if (!value || value.kind !== kind) fail("membership-missing");
        return value;
    }
    const variantKey = row => `v/${row.observationRef}/${row.contentHash}`;
    const ordinalKey = ordinal => `r/${pad(ordinal)}`;
    const provenanceKey = (row, captureKey, provenanceHash) =>
        `p/${row.observationRef}/${row.contentHash}/${nativeCaptureReference(captureKey)}/${provenanceHash}`;
    const recordFor = variant => restoreNativeRetainedObservation(variant.content, variant.seedProvenance, variant.seedCapture);

    let rowCount = 0, previousKey = null;
    const hashedRows = nativeSegmentedRowsDigest();
    for await (const { key, row } of rows()) {
        if (previousKey !== null && key <= previousKey) fail("tree-order-invalid");
        previousKey = key; rowCount++;
        updateNativeSegmentedRowsDigest(hashedRows, row);
        if (!Number.isSafeInteger(rowCount)) fail("count-invalid");
    }
    if (rowCount !== (root.tree?.count ?? 0)) fail("tree-count-mismatch");
    let nextOrdinal = 0, variantCount = 0, indexCount = 0;
    const definitionFlags = { messageParts: false, chatSource: false };
    for await (const { row } of rows()) {
        check();
        if (row.kind === "capture") {
            const witness = await requireRow(provenanceKey(row.witness, row.captureKey, row.witness.provenanceHash), "provenance");
            if (witness.provenance.captureKey !== row.captureKey) fail("capture-unreferenced");
        } else if (row.kind === "observation") {
            if (row.lastOrdinal - row.firstOrdinal + 1 > rowCount) fail("observation-range-invalid");
            const reference = nativeObservationReference(row.identity);
            let currentFound = false;
            for (let ordinal = row.firstOrdinal; ordinal <= row.lastOrdinal; ordinal++) {
                const member = await requireRow(ordinalKey(ordinal), "record");
                if (member.observationRef !== reference) fail("observation-range-invalid");
                if (member.contentHash === row.currentVariant) currentFound = true;
            }
            if (!currentFound) fail("current-variant-missing");
        } else if (row.kind === "variant") {
            variantCount++;
            definitionFlags.messageParts ||= Boolean(row.content.messageParts?.length);
            definitionFlags.chatSource ||= Boolean(row.content.chatSource);
            const observation = await requireRow(`o/${row.observationRef}`, "observation");
            if (nativeRetainedObservationIdentity(recordFor(row), account) !== observation.identity) fail("identity-mismatch");
            await requireRow(`i/${row.observationRef}/${row.contentHash}`, "variant-index");
            const capture = await requireRow(`c/${nativeCaptureReference(row.seedProvenance.captureKey)}`, "capture");
            if (!same(capture.capture, row.seedCapture) || capture.captureKey !== row.seedProvenance.captureKey) fail("capture-mismatch");
            const provenance = await requireRow(provenanceKey(row, row.seedProvenance.captureKey, nativeRetentionHash(row.seedProvenance)), "provenance");
            if (!same(provenance.provenance, row.seedProvenance)) fail("seed-provenance-missing");
        } else if (row.kind === "variant-index") {
            indexCount++;
            await requireRow(variantKey(row), "variant");
            const member = await requireRow(ordinalKey(row.inputOrdinal), "record");
            if (member.observationRef !== row.observationRef || member.contentHash !== row.contentHash) fail("variant-index-mismatch");
        } else if (row.kind === "record") {
            if (row.inputOrdinal !== nextOrdinal++) fail("record-ordinal-gap");
            const variant = await requireRow(variantKey(row), "variant");
            const record = recordFor(variant);
            const observation = await requireRow(`o/${row.observationRef}`, "observation");
            const index = await requireRow(`i/${row.observationRef}/${row.contentHash}`, "variant-index");
            if (index.inputOrdinal !== row.inputOrdinal || row.inputOrdinal < observation.firstOrdinal || row.inputOrdinal > observation.lastOrdinal
                || row.sourceId !== nativeSourceId(record)
                || row.conversationKey !== nativeConversationIdentity(record.scope)) fail("record-membership-invalid");
            for (const unit of nativeVariantUnits(record)) {
                await requireRow(nativeSegmentedRowKey({ kind: "membership", ...unit, inputOrdinal: row.inputOrdinal }), "membership");
            }
        } else if (row.kind === "provenance") {
            const variant = await requireRow(variantKey(row), "variant");
            const capture = await requireRow(`c/${nativeCaptureReference(row.provenance.captureKey)}`, "capture");
            if (capture.captureKey !== row.provenance.captureKey) fail("capture-mismatch");
            const restored = restoreNativeRetainedObservation(variant.content, row.provenance, capture.capture);
            validateNativeRetainedObservation(restored);
            if (row.provenance.captureKey !== JSON.stringify([restored.scope.harness, restored.scope.surface, capture.capture.captureId])
                || nativeObservationReference(nativeRetainedObservationIdentity(restored, account)) !== row.observationRef
                || !same(nativeRetainedObservationParts(restored).content, variant.content)) fail("provenance-content-mismatch");
        } else if (row.kind === "unit") {
            await requireRow(`${unitPrefix(row.sourceId, row.conversationKey, row.unitKind, row.unitKey)}/${pad(row.witnessOrdinal)}`, "membership");
        } else if (row.kind === "membership") {
            await requireRow(unitPrefix(row.sourceId, row.conversationKey, row.unitKind, row.unitKey, "u"), "unit");
            const member = await requireRow(ordinalKey(row.inputOrdinal), "record");
            const variant = await requireRow(variantKey(member), "variant");
            if (!nativeVariantUnits(recordFor(variant)).some(unit => unit.unitKind === row.unitKind && unit.unitKey === row.unitKey
                && unit.sourceId === row.sourceId && unit.conversationKey === row.conversationKey)) fail("unit-membership-invalid");
        }
    }
    if (variantCount !== nextOrdinal || indexCount !== nextOrdinal) fail("variant-conservation-failed");

    const { select, iterate, entryAt } = createNativeSelectionQuery({ rootHash, rows, find, check });
    async function lookupRow(key, { signal: localSignal } = {}) {
        check(localSignal);
        if (typeof key !== "string" || !/^[a-z0-9/-]{1,300}$/.test(key)) fail("index-key-invalid");
        const value = await find(key, localSignal);
        check(localSignal);
        return value;
    }
    async function* iterateRows({ prefix = "", after = null, signal: localSignal } = {}) {
        check(localSignal);
        if (typeof prefix !== "string" || !/^[a-z0-9/-]{0,300}$/.test(prefix)
            || after !== null && (typeof after !== "string" || !/^[a-z0-9/-]{1,300}$/.test(after))) fail("index-key-invalid");
        for await (const { row } of rows(prefix, after, localSignal)) {
            check(localSignal);
            yield row;
        }
        check(localSignal);
    }
    async function* iterateBlockReferences({ signal: localSignal } = {}) {
        check(localSignal);
        yield Object.freeze({ hash: rootHash, kind: "root" });
        const stack = root.tree ? [root.tree] : [];
        while (stack.length) {
            check(localSignal);
            const item = stack.pop(), block = await load(item.hash, item, localSignal);
            check(localSignal);
            yield Object.freeze({ hash: item.hash, kind: item.kind });
            if (block.kind === "page") for (let index = block.children.length - 1; index >= 0; index--) stack.push(block.children[index]);
            if (stack.length > NATIVE_SEGMENTED_LIMITS.pageChildren * NATIVE_SEGMENTED_LIMITS.treeDepth) fail("traversal-bound");
        }
        check(localSignal);
    }
    return Object.freeze({ rootHash, account, rowCount, recordCount: nextOrdinal,
        rowsDigest: hashedRows.digest("hex"), definitions: nativeRetainedDefinitions(definitionFlags),
        select, iterate, entryAt, lookupRow, iterateRows, iterateBlockReferences,
        close() { closed = true; cache.clear(); cachedBytes = 0; } });
}
