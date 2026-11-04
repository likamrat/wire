import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chatFixture, coworkFixture, imageFixture } from "./native-read-model-fixtures.mjs";
import { encodeNativeRetainedCapture, mergeNativeRetainedCapture, validateNativeRetainedDocument,
    nativeRetentionHash, nativeRetentionJson, restoreNativeRetainedObservation } from "../lib/native-retention-contract.mjs";
import { nativeConversationIdentity, NATIVE_READ_LIMITS, NATIVE_RETAINED_CONTRACT } from "../lib/native-read-model.mjs";
import { projectRetainedNativeRecords, projectRetainedNativeEntries } from "../lib/retained-population.mjs";
import { NATIVE_SEGMENTED_LIMITS, nativeSegmentedEnvelope, nativeSegmentedRowKey,
    nativeObservationReference, nativeSourceId, nativeVariantUnits,
    encodeNativeSegmentedBlock, decodeNativeSegmentedBlock, describeNativeSegmentedBlock } from "../lib/native-segmented-codec.mjs";
import { openNativeSegmentedReader } from "../lib/native-segmented-read.mjs";
import { stageNativeSegmentedTree } from "../lib/native-segmented-stage.mjs";
import { nativeV1SegmentedRows, stageNativeV1Segments } from "../lib/native-segmented-v1.mjs";
import { stageNativeSegmentedCapture } from "../lib/native-segmented-merge.mjs";
import { stageNativeSegmentedDeletion } from "../lib/native-segmented-delete.mjs";
import { nativeObservationDeletionIdentity } from "../lib/deletion-identities.mjs";
import { filterNativeRetainedDocument } from "../lib/native-retention-contract.mjs";
import { DELETION_LIMITS } from "../lib/deletion-storage.mjs";
import { inspectNativeSegmentedInventory } from "../lib/native-segmented-inventory.mjs";

function retainedFixture() {
    const source = [...chatFixture(), ...coworkFixture()];
    const account = { partition: "a".repeat(64), issuer: "https://example.invalid",
        tenantId: source[0].scope.account.tenantId, subjectId: source[0].scope.account.subjectId };
    for (const item of source) item.scope.account = { tenantId: account.tenantId, subjectId: account.subjectId, verification: "verified" };
    return { account, document: mergeNativeRetainedCapture(null, encodeNativeRetainedCapture(account, source)).document };
}

function rowsFromDocument(document) {
    const rows = [], captures = new Map(document.captures.map(item => [item.key, item.value])), witnesses = new Map(), units = new Map();
    let inputOrdinal = 0;
    for (const observation of document.observations) {
        const firstOrdinal = inputOrdinal, observationRef = nativeObservationReference(observation.key);
        for (const variant of observation.variants) {
            const record = restoreNativeRetainedObservation(variant.content, variant.provenance[0], captures.get(variant.provenance[0].captureKey));
            rows.push({ kind: "variant", observationRef, contentHash: variant.hash, content: variant.content,
                seedCapture: record.capture, seedProvenance: variant.provenance[0] },
                { kind: "variant-index", observationRef, contentHash: variant.hash, inputOrdinal },
                { kind: "record", observationRef, contentHash: variant.hash, inputOrdinal,
                    sourceId: nativeSourceId(record), conversationKey: nativeConversationIdentity(record.scope) });
            for (const provenance of variant.provenance) {
                rows.push({ kind: "provenance", observationRef, contentHash: variant.hash, provenance });
                witnesses.set(provenance.captureKey, witnesses.get(provenance.captureKey)
                    ?? { observationRef, contentHash: variant.hash, provenanceHash: nativeRetentionHash(provenance) });
            }
            for (const unit of nativeVariantUnits(record)) {
                const value = { kind: "unit", ...unit, witnessOrdinal: inputOrdinal };
                units.set(nativeSegmentedRowKey(value), units.get(nativeSegmentedRowKey(value)) ?? value);
                rows.push({ kind: "membership", ...unit, inputOrdinal });
            }
            inputOrdinal++;
        }
        rows.push({ kind: "observation", identity: observation.key, firstOrdinal, lastOrdinal: inputOrdinal - 1,
            currentVariant: observation.currentVariant });
    }
    for (const [captureKey, capture] of captures) rows.push({ kind: "capture", captureKey, capture, witness: witnesses.get(captureKey) });
    rows.push(...units.values());
    return rows;
}

function graph(account, input, { segmentEntries = 3, fanout = 2 } = {}) {
    assert.ok(segmentEntries <= NATIVE_SEGMENTED_LIMITS.segmentEntries && fanout <= NATIVE_SEGMENTED_LIMITS.pageChildren);
    const blocks = new Map(), descriptions = [];
    const rows = input.toSorted((a, b) => {
        const first = nativeSegmentedRowKey(a), second = nativeSegmentedRowKey(b);
        return first < second ? -1 : first > second ? 1 : 0;
    });
    function put(block) {
        const value = encodeNativeSegmentedBlock(block);
        blocks.set(value.hash, Buffer.from(value.json));
        return block.kind === "root" ? value.hash : describeNativeSegmentedBlock(block, value.hash);
    }
    for (let index = 0; index < rows.length; index += segmentEntries) {
        descriptions.push(put(nativeSegmentedEnvelope(account, "segment", { entries: rows.slice(index, index + segmentEntries) })));
    }
    let level = descriptions;
    while (level.length > 1) {
        const next = [];
        for (let index = 0; index < level.length; index += fanout) {
            const children = level.slice(index, index + fanout);
            next.push(put(nativeSegmentedEnvelope(account, "page", { level: children[0].level + 1, children })));
        }
        level = next;
    }
    const rootHash = put(nativeSegmentedEnvelope(account, "root", { tree: level[0] ?? null }));
    return { rootHash, blocks, async readBlock(hash, { maxBytes }) {
        assert.equal(maxBytes, NATIVE_READ_LIMITS.bytes);
        const bytes = blocks.get(hash);
        if (!bytes) throw new Error("Missing fixture block.");
        return bytes;
    } };
}

async function collect(reader, selection) {
    const events = [];
    for await (const event of reader.iterate(selection)) events.push(event);
    return events;
}

test("closed v2 blocks traverse separate segments with complete source/call/fact membership and original ordinals", async () => {
    const fixture = retainedFixture(), rows = rowsFromDocument(fixture.document), storage = graph(fixture.account, rows);
    const reader = await openNativeSegmentedReader({ ...storage, assertCurrent() {} });
    try {
        const selection = await reader.select({ sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: null });
        const events = await collect(reader, selection), entries = events.filter(event => event.kind === "conversation-part").flatMap(event => event.entries);
        const expected = validateNativeRetainedDocument(fixture.document).records;
        assert.equal(events[0].kind, "selection-start");
        assert.equal(events.at(-1).kind, "selection-end");
        assert.equal(entries.length, expected.length);
        assert.deepEqual(entries.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal).map(entry => entry.record), expected);
        assert.deepEqual(entries.map(entry => entry.inputOrdinal).toSorted((a, b) => a - b), expected.map((_, index) => index));
        assert.equal(selection.expected.provenanceEntries, fixture.document.observations.reduce((sum, row) =>
            sum + row.variants.reduce((count, variant) => count + variant.provenance.length, 0), 0));
        assert.ok(selection.expected.calls > 0);
        assert.equal(selection.expected.callMemberships, expected.reduce((sum, row) => sum + row.identity.callIds.length, 0));
        assert.deepEqual(events.at(-1).observed, selection.expected);
        assert.ok(events.filter(event => event.kind === "conversation-part").every(event =>
            Buffer.byteLength(nativeRetentionJson(event)) <= NATIVE_SEGMENTED_LIMITS.bytes));
    } finally { reader.close(); }
});

test("source selection is exact and a selected later conversation retains its original ordinal mapping", async () => {
    const fixture = retainedFixture(), storage = graph(fixture.account, rowsFromDocument(fixture.document));
    const reader = await openNativeSegmentedReader({ ...storage, assertCurrent: () => true });
    try {
        const records = validateNativeRetainedDocument(fixture.document).records;
        const later = records.find(record => record.scope.surface === "cowork");
        const conversationKey = nativeConversationIdentity(later.scope);
        const selected = await reader.select({ sources: ["microsoft-365-cowork"], scenarioIds: [conversationKey] });
        const events = await collect(reader, selected), parts = events.filter(event => event.kind === "conversation-part");
        assert.ok(parts.every(part => part.sourceId === "microsoft-365-cowork" && part.conversationKey === conversationKey));
        assert.deepEqual(parts.flatMap(part => part.entries.map(entry => entry.inputOrdinal)),
            records.flatMap((record, ordinal) => nativeConversationIdentity(record.scope) === conversationKey ? [ordinal] : []));
        const entries = parts.flatMap(part => part.entries);
        const original = projectRetainedNativeRecords({ contractVersion: NATIVE_RETAINED_CONTRACT, records }).records
            .filter(record => record.scenarioId === conversationKey);
        const projected = projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT, entries }).records;
        assert.deepEqual(projected, original, "Full canonical original views retain their inputOrdinal and call/fact associations.");
        assert.notDeepEqual(projectRetainedNativeRecords({ contractVersion: NATIVE_RETAINED_CONTRACT,
            records: entries.map(entry => entry.record) }).records, original, "Plain subset projection renumbers accepted original views.");
        assert.throws(() => projectRetainedNativeEntries({ contractVersion: NATIVE_RETAINED_CONTRACT,
            entries: [entries[0], entries[0]] }), { code: "duplicate-input-ordinal" });
        await assert.rejects(reader.select({ sources: ["github-copilot"], scenarioIds: null }), { code: "selection-invalid" });
        await assert.rejects(reader.select({ sources: ["microsoft-365-chat"], scenarioIds: [conversationKey] }), { code: "selection-membership-missing" });
        const empty = await reader.select({ sources: ["microsoft-365-cowork"], scenarioIds: [] });
        const emptyEvents = await collect(reader, empty);
        assert.equal(empty.rootHash, selected.rootHash, "An empty selection retains the original source root.");
        assert.equal(empty.expected.conversations, 0);
        assert.equal(empty.expected.variants, 0);
        assert.deepEqual(emptyEvents.map(event => event.kind), ["selection-start", "selection-end"]);
        assert.deepEqual(emptyEvents.at(-1).observed, empty.expected);
        const all = await reader.select({ sources: ["microsoft-365-cowork"], scenarioIds: null });
        assert.notEqual(empty.selectionRef, all.selectionRef, "Explicit none never widens to All.");
    } finally { reader.close(); }
});

test("cross-segment missing and fabricated call memberships fail before a query can be prepared", async () => {
    const fixture = retainedFixture(), original = rowsFromDocument(fixture.document);
    const member = original.find(row => row.kind === "membership" && row.unitKind === "call");
    assert.ok(member);
    const missing = graph(fixture.account, original.filter(row => row !== member));
    await assert.rejects(openNativeSegmentedReader({ ...missing, assertCurrent() {} }), { code: "membership-missing" });
    const changed = structuredClone(original);
    const invalid = changed.find(row => row.kind === "membership" && row.unitKind === "call");
    invalid.unitKey = "not-a-qualified-call";
    const fabricated = graph(fixture.account, changed);
    await assert.rejects(openNativeSegmentedReader({ ...fabricated, assertCurrent() {} }));
});

test("provenance remains complete across segments without adding variants or confusing first capture", async () => {
    const fixture = retainedFixture(), source = [...chatFixture(), ...coworkFixture()];
    for (const row of source) {
        row.scope.account = { tenantId: fixture.account.tenantId, subjectId: fixture.account.subjectId, verification: "verified" };
        row.capture.captureId += "-fresh";
        row.capture.generation++;
        row.ordering.recordOrdinal += 100;
    }
    const repeated = mergeNativeRetainedCapture(fixture.document, encodeNativeRetainedCapture(fixture.account, source)).document;
    const storage = graph(fixture.account, rowsFromDocument(repeated));
    const reader = await openNativeSegmentedReader({ ...storage, assertCurrent() {} });
    try {
        const selection = await reader.select({ sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: null });
        const entries = (await collect(reader, selection)).filter(event => event.kind === "conversation-part").flatMap(event => event.entries);
        assert.equal(entries.length, validateNativeRetainedDocument(fixture.document).records.length);
        assert.ok(entries.every(entry => entry.record.retention.captureCount === 2));
        assert.ok(entries.every(entry => !entry.record.capture.captureId.endsWith("-fresh")));
        assert.equal(selection.expected.provenanceEntries, entries.length * 2);
    } finally { reader.close(); }
});

test("page descriptors, canonical bytes, account association and closed input bounds are enforced", async () => {
    const fixture = retainedFixture(), storage = graph(fixture.account, rowsFromDocument(fixture.document));
    let reads = 0;
    await assert.rejects(openNativeSegmentedReader({ ...storage,
        expectedAccount: { ...fixture.account, partition: "b".repeat(64) }, assertCurrent() {},
        async readBlock(...args) { reads++; return storage.readBlock(...args); } }), { code: "account-mismatch" });
    assert.equal(reads, 1, "A foreign expected account cannot traverse child blocks.");
    const root = JSON.parse(storage.blocks.get(storage.rootHash));
    root.tree.count++;
    const changed = encodeNativeSegmentedBlock(root);
    storage.blocks.set(changed.hash, Buffer.from(changed.json));
    await assert.rejects(openNativeSegmentedReader({ ...storage, rootHash: changed.hash, assertCurrent() {} }), { code: "descriptor-mismatch" });
    const bytes = Buffer.from(JSON.stringify(root, null, 2));
    assert.throws(() => decodeNativeSegmentedBlock(bytes, createHash("sha256").update(bytes).digest("hex")), { code: "block-not-canonical" });
    assert.throws(() => encodeNativeSegmentedBlock({ ...root, extra: true }), { code: "root-invalid" });
    assert.throws(() => encodeNativeSegmentedBlock(nativeSegmentedEnvelope(fixture.account, "segment",
        { entries: Array(NATIVE_SEGMENTED_LIMITS.segmentEntries + 1).fill(rowsFromDocument(fixture.document)[0]) })), { code: "segment-bound" });
    const foreign = { ...root, tree: JSON.parse(storage.blocks.get(storage.rootHash)).tree,
        account: { ...fixture.account, partition: "b".repeat(64) } };
    const foreignRoot = encodeNativeSegmentedBlock(foreign);
    storage.blocks.set(foreignRoot.hash, Buffer.from(foreignRoot.json));
    await assert.rejects(openNativeSegmentedReader({ ...storage, rootHash: foreignRoot.hash, assertCurrent() {} }), { code: "account-mismatch" });
    const variant = structuredClone(rowsFromDocument(fixture.document).find(row => row.kind === "variant"));
    const captureKey = JSON.parse(variant.seedProvenance.captureKey);
    captureKey[1] = captureKey[1] === "chat" ? "cowork" : "chat";
    variant.seedProvenance.captureKey = JSON.stringify(captureKey);
    assert.throws(() => graph(fixture.account, [variant]), { code: "variant-invalid" });
});

test("revocation, cancellation and copied selections cannot produce a completion marker", async () => {
    const fixture = retainedFixture(), storage = graph(fixture.account, rowsFromDocument(fixture.document));
    let current = true;
    const reader = await openNativeSegmentedReader({ ...storage, assertCurrent: () => current });
    const selection = await reader.select({ sources: ["microsoft-365-chat"], scenarioIds: null });
    await assert.rejects(reader.iterate({ ...selection }).next(), { code: "selection-frame-invalid" });
    const iterator = reader.iterate(selection);
    assert.equal((await iterator.next()).value.kind, "selection-start");
    current = false;
    await assert.rejects(iterator.next(), { code: "reader-revoked" });
    current = true;
    const controller = new AbortController(), cancelled = reader.iterate(selection, { signal: controller.signal });
    await cancelled.next();
    controller.abort();
    await assert.rejects(cancelled.next(), { code: "reader-cancelled" });
    reader.close();
    await assert.rejects(reader.select({ sources: ["microsoft-365-chat"], scenarioIds: null }), { code: "reader-cancelled" });
});

test("unqualified async checks fail before block reads and do not leak rejected promises", async () => {
    let reads = 0;
    await assert.rejects(openNativeSegmentedReader({ rootHash: "a".repeat(64),
        readBlock() { reads++; throw new Error("Must not read."); },
        assertCurrent: () => Promise.reject(new Error("Rejected test check.")) }),
    { code: "asynchronous-authority-check" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0);
});

test("authority is rechecked after an asynchronous block read before exposing the root", async () => {
    const fixture = retainedFixture(), storage = graph(fixture.account, rowsFromDocument(fixture.document));
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let current = true;
    const rejected = assert.rejects(openNativeSegmentedReader({ rootHash: storage.rootHash,
        assertCurrent: () => current, async readBlock(hash, options) {
            entered.resolve(); await release.promise;
            return storage.readBlock(hash, options);
        } }), { code: "reader-revoked" });
    await entered.promise;
    current = false; release.resolve();
    await rejected;
});

test("bounded staging validates its complete candidate without publishing a board pointer", async () => {
    const fixture = retainedFixture(), blocks = new Map();
    const rows = rowsFromDocument(fixture.document).toSorted((a, b) => {
        const first = nativeSegmentedRowKey(a), second = nativeSegmentedRowKey(b);
        return first < second ? -1 : first > second ? 1 : 0;
    });
    const readBlock = async hash => blocks.get(hash);
    const candidate = await stageNativeSegmentedTree({ account: fixture.account, rows, assertCurrent() {},
        async writeBlock(value) { blocks.set(value.hash, Buffer.from(value.json)); return value.hash; }, readBlock });
    assert.equal(candidate.kind, "native-segmented-candidate");
    assert.equal(candidate.rows, rows.length);
    assert.equal(Object.hasOwn(candidate, "receipt"), false);
    const reader = await openNativeSegmentedReader({ rootHash: candidate.rootHash, readBlock, assertCurrent() {} });
    try {
        const selected = await reader.select({ sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: null });
        const emitted = (await collect(reader, selected)).filter(event => event.kind === "conversation-part").flatMap(event => event.entries);
        assert.deepEqual(emitted.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal).map(entry => entry.record),
            validateNativeRetainedDocument(fixture.document).records);
    } finally { reader.close(); }
});

test("staging refuses a changed address or retirement after an asynchronous block write", async () => {
    const fixture = retainedFixture(), rows = rowsFromDocument(fixture.document).toSorted((a, b) =>
        nativeSegmentedRowKey(a) < nativeSegmentedRowKey(b) ? -1 : 1);
    await assert.rejects(stageNativeSegmentedTree({ account: fixture.account, rows, assertCurrent() {},
        async writeBlock() { return "0".repeat(64); }, async readBlock() { assert.fail("No candidate readback."); } }),
    { code: "staged-address-mismatch" });
    let current = true;
    await assert.rejects(stageNativeSegmentedTree({ account: fixture.account, rows, assertCurrent: () => current,
        async writeBlock(value) { await Promise.resolve(); current = false; return value.hash; },
        async readBlock() { assert.fail("No candidate readback."); } }), { code: "staging-revoked" });
});

test("legacy staging conserves every existing identity, variant, provenance and ordinal under the exact input hash", async () => {
    const fixture = retainedFixture(), bytes = Buffer.from(JSON.stringify(fixture.document)), blocks = new Map();
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const expected = rowsFromDocument(fixture.document).toSorted((a, b) =>
        nativeSegmentedRowKey(a) < nativeSegmentedRowKey(b) ? -1 : 1);
    const actual = [];
    for await (const row of nativeV1SegmentedRows(fixture.document, { assertCurrent() {} })) actual.push(row);
    assert.deepEqual(actual, expected);
    const binding = { bytes, expectedHash, account: fixture.account, assertCurrent() {},
        async writeBlock(value) { blocks.set(value.hash, Buffer.from(value.json)); return value.hash; },
        async readBlock(hash) { return blocks.get(hash); } };
    const candidate = await stageNativeV1Segments(binding);
    assert.equal(candidate.previousHash, expectedHash);
    const reader = await openNativeSegmentedReader({ ...binding, rootHash: candidate.rootHash });
    assert.equal(candidate.rowsDigest, reader.rowsDigest);
    reader.close();
    const written = blocks.size;
    await assert.rejects(stageNativeV1Segments({ ...binding, expectedHash: "0".repeat(64) }), { code: "adoption-integrity" });
    await assert.rejects(stageNativeV1Segments({ ...binding, account: { ...fixture.account, partition: "b".repeat(64) } }),
        { code: "account-mismatch" });
    assert.equal(blocks.size, written);
});

test("v2 append streams old history, reuses variant blocks and shifts metadata for an earlier changed variant", async () => {
    const fixture = retainedFixture(), bytes = Buffer.from(JSON.stringify(fixture.document)), blocks = new Map();
    const io = { assertCurrent() {},
        async writeBlock(value) { blocks.set(value.hash, Buffer.from(value.json)); return value.hash; },
        async readBlock(hash) { return blocks.get(hash); } };
    let candidate = await stageNativeV1Segments({ ...io, bytes,
        expectedHash: createHash("sha256").update(bytes).digest("hex"), account: fixture.account });
    const initialVariants = [...blocks].filter(([, bytes]) => {
        const block = JSON.parse(bytes);
        return block.kind === "segment" && block.entries.every(row => row.kind === "variant");
    }).map(([hash]) => hash);
    let expected = fixture.document;
    const fresh = [...chatFixture(), ...coworkFixture()];
    const changed = chatFixture()[0];
    changed.ordering.completeness = "drained-exposed-history";
    const later = [...imageFixture(), changed];
    for (const [index, source] of [fresh, later, later].entries()) {
        for (const row of source) {
            row.scope.account = { tenantId: fixture.account.tenantId, subjectId: fixture.account.subjectId, verification: "verified" };
            if (index < 2) row.capture.captureId += index === 0 ? "-fresh" : "-changed";
        }
        const capture = encodeNativeRetainedCapture(fixture.account, source);
        const expectedMerge = mergeNativeRetainedCapture(expected, capture);
        const before = candidate.rootHash;
        const prepared = await stageNativeSegmentedCapture({ ...io, rootHash: before, capture });
        assert.deepEqual(prepared.changes, expectedMerge.changes);
        expected = expectedMerge.document;
        candidate = prepared.candidate;
        const reader = await openNativeSegmentedReader({ ...io, rootHash: candidate.rootHash });
        try {
            const selection = await reader.select({ sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: null });
            const events = await collect(reader, selection), entries = events.filter(event => event.kind === "conversation-part").flatMap(event => event.entries);
            assert.deepEqual(entries.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal).map(entry => entry.record),
                validateNativeRetainedDocument(expected).records);
            assert.equal(events.at(-1).kind, "selection-end");
            if (index === 0) {
                const reachableVariants = new Set();
                for await (const row of reader.iterateRows()) if (row.kind === "variant") reachableVariants.add(nativeSegmentedRowKey(row));
                assert.ok(initialVariants.every(hash => JSON.parse(blocks.get(hash)).entries.every(row => reachableVariants.has(nativeSegmentedRowKey(row)))));
                const oldVariantSegments = new Set(initialVariants);
                assert.equal([...blocks].filter(([hash, bytes]) => {
                    const block = JSON.parse(bytes);
                    return block.kind === "segment" && block.entries.every(row => row.kind === "variant") && !oldVariantSegments.has(hash);
                }).length, 0);
            }
            if (index === 1) {
                const cowork = entries.filter(entry => entry.record.scope.surface === "cowork");
                assert.ok(cowork.length > 0, "Disappeared source rows remain retained.");
                assert.ok(cowork[0].inputOrdinal > validateNativeRetainedDocument(fixture.document).records.findIndex(row => row.scope.surface === "cowork"));
            }
            if (index === 2) assert.equal(candidate.rootHash, before);
        } finally { reader.close(); }
    }
});

test("segmented deletion removes every variant/provenance and repairs shared witnesses without pruning survivors", async () => {
    const fixture = retainedFixture(), repeated = [...chatFixture(), ...coworkFixture()];
    for (const row of repeated) {
        row.scope.account = { tenantId: fixture.account.tenantId, subjectId: fixture.account.subjectId, verification: "verified" };
        row.capture.captureId += "-cleanup";
    }
    repeated[0].ordering.completeness = "drained-exposed-history";
    fixture.document = mergeNativeRetainedCapture(fixture.document, encodeNativeRetainedCapture(fixture.account, repeated)).document;
    const storage = graph(fixture.account, rowsFromDocument(fixture.document));
    const removed = fixture.document.observations.filter(item => item.variants[0].content.scope.surface === "chat"
        || item.variants[0].content.identity.nativeType === "ts");
    const identities = removed.map(item => nativeObservationDeletionIdentity(item.key));
    const oldBlocks = new Map(storage.blocks);
    const io = { account: fixture.account, maxIndexBytes: DELETION_LIMITS.metadataBytes, assertCurrent() {},
        readBlock: storage.readBlock, async writeBlock(value) { storage.blocks.set(value.hash, Buffer.from(value.json)); return value.hash; } };
    const result = await stageNativeSegmentedDeletion({ ...io, rootHash: storage.rootHash, identities });
    assert.equal(result.removedObservations, removed.length);
    assert.equal(result.removedVariants, removed.reduce((count, row) => count + row.variants.length, 0));
    assert.ok(result.removedVariants > result.removedObservations);
    const reader = await openNativeSegmentedReader({ ...io, rootHash: result.rootHash, expectedAccount: fixture.account });
    try {
        const selection = await reader.select({ sources: ["microsoft-365-chat", "microsoft-365-cowork"], scenarioIds: null });
        const entries = (await collect(reader, selection)).filter(event => event.kind === "conversation-part").flatMap(event => event.entries);
        assert.deepEqual(entries.toSorted((a, b) => a.inputOrdinal - b.inputOrdinal).map(entry => entry.record),
            validateNativeRetainedDocument(filterNativeRetainedDocument(fixture.document, { identities })).records);
        for await (const row of reader.iterateRows({ prefix: "o/" })) {
            assert.equal(identities.includes(nativeObservationDeletionIdentity(row.identity)), false);
        }
    } finally { reader.close(); }
    for (const [hash, bytes] of oldBlocks) assert.deepEqual(storage.blocks.get(hash), bytes, "Staging never mutates or unlinks the old graph.");
    const before = storage.blocks.size;
    const again = await stageNativeSegmentedDeletion({ ...io, rootHash: result.rootHash, identities });
    assert.equal(again.rootHash, result.rootHash);
    assert.equal(again.candidate, null);
    assert.equal(storage.blocks.size, before);
    const all = fixture.document.observations.map(item => nativeObservationDeletionIdentity(item.key));
    const empty = await stageNativeSegmentedDeletion({ ...io, rootHash: result.rootHash, identities: all });
    const emptyReader = await openNativeSegmentedReader({ ...io, rootHash: empty.rootHash });
    try { assert.equal(emptyReader.recordCount, 0); assert.equal(emptyReader.rowCount, 0); }
    finally { emptyReader.close(); }
    const stranded = encodeNativeSegmentedBlock(nativeSegmentedEnvelope(fixture.account, "segment",
        { entries: [rowsFromDocument(fixture.document).find(row => row.kind === "variant")] }));
    storage.blocks.set(stranded.hash, Buffer.from(stranded.json));
    const blockCount = storage.blocks.size;
    const inventoryInput = {
        entries: [...storage.blocks.keys()].map(hash => ({ area: "data", hash })),
        roots: [{ area: "data", hash: empty.rootHash, account: fixture.account }],
        async readBlock({ area, hash }, { maxBytes }) {
            assert.equal(area, "data");
            assert.equal(maxBytes, DELETION_LIMITS.fileBytes);
            return storage.blocks.get(hash);
        },
        assertCurrent() {},
    };
    const inventory = await inspectNativeSegmentedInventory(inventoryInput);
    assert.equal(inventory.blocks.find(item => item.hash === empty.rootHash).disposition, "current-root");
    assert.equal(inventory.blocks.find(item => item.hash === storage.rootHash).disposition, "historical-root");
    assert.equal(inventory.blocks.find(item => item.hash === stranded.hash).disposition, "unreferenced");
    assert.equal(storage.blocks.size, blockCount);
    const missing = inventoryInput.entries.filter(item => item.hash !== JSON.parse(storage.blocks.get(storage.rootHash)).tree.hash);
    await assert.rejects(inspectNativeSegmentedInventory({ ...inventoryInput, entries: missing }), { code: "inventory-member-missing" });
});
