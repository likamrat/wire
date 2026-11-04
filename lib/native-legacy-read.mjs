import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { NATIVE_READ_LIMITS, NATIVE_JSON_LIMITS, nativeRetainedDefinitions } from "./native-read-model.mjs";
import { validateNativeRetainedDocument, validateNativeRetainedAccount, nativeRetentionHash,
    filterNativeRetainedDocument } from "./native-retention-contract.mjs";
import { nativeV1SegmentedRows } from "./native-segmented-v1.mjs";
import { nativeSegmentedRowKey, nativeSegmentedRowsDigest, updateNativeSegmentedRowsDigest,
    NATIVE_SEGMENTED_LIMITS, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { createNativeSelectionQuery } from "./native-selected-read.mjs";

function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
}

// Compatibility projection of one bounded committed v1 file. No files or virtual roots are written.
export async function openNativeLegacyReader({ bytes, rootHash, expectedAccount, assertCurrent, signal, deletion } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > NATIVE_READ_LIMITS.bytes
        || typeof rootHash !== "string" || !/^[a-f0-9]{64}$/.test(rootHash)
        || typeof assertCurrent !== "function") fail("reader-binding-required");
    let closed = false;
    function check(localSignal) {
        if (closed || signal?.aborted || localSignal?.aborted) fail("reader-cancelled");
        const result = assertCurrent();
        if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {}); fail("asynchronous-authority-check");
        }
        if (result !== undefined && result !== true) fail("reader-revoked");
    }
    check();
    if (expectedAccount !== undefined) expectedAccount = validateNativeRetainedAccount(expectedAccount);
    const input = Buffer.from(bytes);
    if (createHash("sha256").update(input).digest("hex") !== rootHash) fail("block-integrity");
    let document;
    try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); }
    catch { fail("block-json-invalid"); }
    if (expectedAccount && (!document?.account || nativeRetentionHash(document.account) !== nativeRetentionHash(expectedAccount))) fail("account-mismatch");
    document = filterNativeRetainedDocument(document, deletion);
    let retained = validateNativeRetainedDocument(document);
    const index = new Map(), keys = [], hashed = nativeSegmentedRowsDigest();
    const flags = { messageParts: false, chatSource: false };
    for await (const row of nativeV1SegmentedRows(document, { assertCurrent: check, signal })) {
        check();
        const key = nativeSegmentedRowKey(row);
        if (index.has(key) || keys.length && keys.at(-1) >= key) fail("tree-order-invalid");
        if (keys.length >= NATIVE_JSON_LIMITS.nodes) fail("legacy-index-bound");
        index.set(key, freeze(row)); keys.push(key);
        updateNativeSegmentedRowsDigest(hashed, row);
        if (row.kind === "variant") {
            flags.messageParts ||= Boolean(row.content.messageParts?.length);
            flags.chatSource ||= Boolean(row.content.chatSource);
        }
    }
    function lowerBound(key, exclusive = false) {
        let lower = 0, upper = keys.length;
        while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if (keys[middle] < key || exclusive && keys[middle] === key) lower = middle + 1;
            else upper = middle;
        }
        return lower;
    }
    async function* rows(prefix = "", after = null, localSignal) {
        check(localSignal);
        let start = lowerBound(prefix);
        if (after !== null) start = Math.max(start, lowerBound(after, true));
        for (let position = start; position < keys.length && keys[position].startsWith(prefix); position++) {
            check(localSignal);
            const key = keys[position];
            yield { key, row: index.get(key) };
            if ((position - start) % NATIVE_SEGMENTED_LIMITS.resultEntries === 0) await setImmediate();
        }
        check(localSignal);
    }
    async function find(key, localSignal) { check(localSignal); return index.get(key) ?? null; }
    const { select, iterate } = createNativeSelectionQuery({ rootHash, rows, find, check });
    async function entryAt(inputOrdinal, { signal: localSignal } = {}) {
        check(localSignal);
        if (!Number.isSafeInteger(inputOrdinal) || inputOrdinal < 0) fail("index-key-invalid");
        const row = index.get(`r/${String(inputOrdinal).padStart(16, "0")}`);
        const record = retained.records[inputOrdinal];
        if (!row || row.kind !== "record" || row.inputOrdinal !== inputOrdinal || !record) fail("membership-missing");
        const variant = index.get(`v/${row.observationRef}/${row.contentHash}`);
        const observation = index.get(`o/${row.observationRef}`);
        if (variant?.kind !== "variant" || observation?.kind !== "observation"
            || record.retention.variant !== row.contentHash
            || record.retention.current !== (observation.currentVariant === row.contentHash)) fail("membership-missing");
        // Validation and index construction share the same immutable v1 variant order.
        const entry = Object.freeze({ inputOrdinal, record });
        check(localSignal);
        return entry;
    }
    async function lookupRow(key, { signal: localSignal } = {}) {
        if (typeof key !== "string" || !/^[a-z0-9/-]{1,300}$/.test(key)) fail("index-key-invalid");
        return find(key, localSignal);
    }
    async function* iterateRows({ prefix = "", after = null, signal: localSignal } = {}) {
        if (typeof prefix !== "string" || !/^[a-z0-9/-]{0,300}$/.test(prefix)
            || after !== null && (typeof after !== "string" || !/^[a-z0-9/-]{1,300}$/.test(after))) fail("index-key-invalid");
        for await (const { row } of rows(prefix, after, localSignal)) yield row;
    }
    check();
    return Object.freeze({ rootHash, account: document.account, rowCount: keys.length, recordCount: retained.records.length,
        rowsDigest: hashed.digest("hex"), definitions: nativeRetainedDefinitions(flags), select, iterate, entryAt, lookupRow, iterateRows,
        close() { closed = true; index.clear(); keys.length = 0; retained = null; } });
}
