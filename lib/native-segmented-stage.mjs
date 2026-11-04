import { nativeValueHasCredentials, measureNativeJson, NATIVE_JSON_LIMITS } from "./native-read-model.mjs";
import { validateNativeRetainedAccount } from "./native-retention-contract.mjs";
import { NATIVE_SEGMENTED_LIMITS, nativeSegmentedEnvelope, nativeSegmentedRowKey,
    validateNativeSegmentedRow, encodeNativeSegmentedBlock, describeNativeSegmentedBlock,
    nativeSegmentedRowsDigest, updateNativeSegmentedRowsDigest, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { openNativeSegmentedReader } from "./native-segmented-read.mjs";

// Stages immutable blocks only. The existing owner must publish a pointer in its own admitted board transaction.
export async function stageNativeSegmentedTree({ account, rows, writeBlock, readBlock, assertCurrent, signal } = {}) {
    validateNativeRetainedAccount(account);
    if (!rows || typeof rows[Symbol.asyncIterator] !== "function" && typeof rows[Symbol.iterator] !== "function"
        || typeof writeBlock !== "function" || typeof readBlock !== "function" || typeof assertCurrent !== "function") {
        fail("staging-binding-required");
    }
    account = structuredClone(account);
    const pending = Array.from({ length: NATIVE_SEGMENTED_LIMITS.treeDepth + 1 }, () => []);
    const hashedRows = nativeSegmentedRowsDigest();
    let entries = [], entryBytes = 0, entryNodes = 0, lastKey = null, group = null, count = 0, blocks = 0, bytes = 0;
    const envelope = measureNativeJson(nativeSegmentedEnvelope(account, "segment", { entries: [] }));
    function check() {
        if (signal?.aborted) fail("staging-cancelled");
        const result = assertCurrent();
        if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {});
            fail("asynchronous-authority-check");
        }
        if (result !== undefined && result !== true) fail("staging-revoked");
    }
    async function stage(block) {
        check();
        const encoded = encodeNativeSegmentedBlock(block);
        const stored = await writeBlock(encoded, { signal });
        check();
        if (stored !== encoded.hash) fail("staged-address-mismatch");
        blocks++; bytes += Buffer.byteLength(encoded.json);
        if (!Number.isSafeInteger(blocks) || !Number.isSafeInteger(bytes)) fail("count-invalid");
        return block.kind === "root" ? encoded.hash : describeNativeSegmentedBlock(block, encoded.hash);
    }
    async function add(item) {
        check();
        if (item.level > NATIVE_SEGMENTED_LIMITS.treeDepth) fail("tree-depth-bound");
        const bucket = pending[item.level];
        if (bucket.length && bucket.at(-1).lastKey >= item.firstKey) fail("staging-order-invalid");
        bucket.push(item);
        if (bucket.length === NATIVE_SEGMENTED_LIMITS.pageChildren) {
            pending[item.level] = [];
            await add(await stage(nativeSegmentedEnvelope(account, "page", { level: item.level + 1, children: bucket })));
        }
    }
    async function flush() {
        if (!entries.length) return;
        const value = entries;
        entries = []; entryBytes = 0; entryNodes = 0;
        await add(await stage(nativeSegmentedEnvelope(account, "segment", { entries: value })));
    }
    for await (const input of rows) {
        check();
        if (nativeValueHasCredentials(input)) fail("credential-bearing-block");
        validateNativeSegmentedRow(input, account);
        const row = structuredClone(input), key = nativeSegmentedRowKey(row), nextGroup = key.slice(0, 1);
        if (lastKey !== null && key <= lastKey) fail("staging-order-invalid");
        const measured = measureNativeJson(row), size = measured.bytes;
        if (size + envelope.bytes > NATIVE_SEGMENTED_LIMITS.bytes || measured.nodes + envelope.nodes > NATIVE_JSON_LIMITS.nodes
            || measured.height + 2 > NATIVE_JSON_LIMITS.depth) fail("staging-entry-bound");
        if (entries.length && (group !== nextGroup || entries.length === NATIVE_SEGMENTED_LIMITS.segmentEntries
            || entryBytes + size + 1 + envelope.bytes > NATIVE_SEGMENTED_LIMITS.bytes
            || entryNodes + measured.nodes + envelope.nodes > NATIVE_JSON_LIMITS.nodes)) await flush();
        entryBytes += size + (entries.length ? 1 : 0); entryNodes += measured.nodes;
        entries.push(row); lastKey = key; group = nextGroup; count++;
        updateNativeSegmentedRowsDigest(hashedRows, row);
        if (!Number.isSafeInteger(count)) fail("count-invalid");
    }
    await flush();
    let tree = null;
    for (let level = 0; level < pending.length; level++) {
        const bucket = pending[level];
        if (!bucket.length) continue;
        const higher = pending.slice(level + 1).some(values => values.length);
        if (bucket.length === 1 && !higher) { tree = bucket[0]; break; }
        pending[level] = [];
        await add(await stage(nativeSegmentedEnvelope(account, "page", { level: level + 1, children: bucket })));
    }
    if ((tree?.count ?? 0) !== count) fail("staging-count-mismatch");
    const rootHash = await stage(nativeSegmentedEnvelope(account, "root", { tree }));
    const verified = await openNativeSegmentedReader({ rootHash, readBlock, assertCurrent, signal, expectedAccount: account });
    const rowsDigest = hashedRows.digest("hex");
    if (verified.rowsDigest !== rowsDigest) { verified.close(); fail("staging-conservation-mismatch"); }
    const recordCount = verified.recordCount;
    verified.close();
    check();
    return Object.freeze({ schemaVersion: 1, kind: "native-segmented-candidate", rootHash,
        rows: count, recordCount, rowsDigest, blocksStaged: blocks, bytesStaged: bytes });
}
