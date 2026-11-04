import { createHash } from "node:crypto";
import { DELETION_LIMITS } from "./deletion-limits.mjs";
import { nativeRetentionHash, validateNativeRetainedAccount } from "./native-retention-contract.mjs";
import { NATIVE_SEGMENTED_CONTRACT, decodeNativeSegmentedBlock, segmentedFailure as fail } from "./native-segmented-codec.mjs";
import { openNativeSegmentedReader } from "./native-segmented-read.mjs";

const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validLocation = value => typeof value.area === "string"
    && /^(data|migration-[a-f0-9-]{36})$/.test(value.area)
    && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash);
const keyFor = value => `${value.area}/${value.hash}`;

// Inventory and reachability only. Neither a list of files nor a root supplied
// here grants authority to read another account, publish, adopt or delete.
export async function inspectNativeSegmentedInventory({ entries, roots, readBlock, assertCurrent, signal } = {}) {
    if (!entries || typeof entries[Symbol.iterator] !== "function" && typeof entries[Symbol.asyncIterator] !== "function"
        || !Array.isArray(roots) || roots.length > DELETION_LIMITS.files
        || typeof readBlock !== "function" || typeof assertCurrent !== "function") fail("inventory-binding-required");
    function check() {
        if (signal?.aborted) fail("inventory-cancelled");
        const value = assertCurrent();
        if (value && typeof value.then === "function") {
            Promise.resolve(value).catch(() => {}); fail("asynchronous-authority-check");
        }
        if (value !== undefined && value !== true) fail("inventory-revoked");
    }
    check();
    const pinned = new Map();
    for (const root of roots) {
        if (!exact(root, ["area", "hash", "account"]) || !validLocation(root) || pinned.has(keyFor(root))) fail("inventory-root-invalid");
        validateNativeRetainedAccount(root.account);
        pinned.set(keyFor(root), { ...root, account: structuredClone(root.account) });
    }
    const locations = new Set(), blocks = new Map(), accounts = new Map();
    let inputBytes = 0, metadataBytes = 2;
    function metadata(value) {
        metadataBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
        if (metadataBytes > DELETION_LIMITS.metadataBytes) fail("inventory-metadata-bound");
    }
    for (const root of pinned.values()) metadata(root);
    async function read(location) {
        check();
        const returned = await readBlock(Object.freeze({ area: location.area, hash: location.hash }),
            { maxBytes: DELETION_LIMITS.fileBytes, signal });
        check();
        if (!(returned instanceof Uint8Array) || returned.byteLength > DELETION_LIMITS.fileBytes) fail("inventory-file-bound");
        const bytes = Buffer.from(returned);
        if (createHash("sha256").update(bytes).digest("hex") !== location.hash) fail("inventory-integrity");
        return bytes;
    }
    for await (const entry of entries) {
        check();
        if (!exact(entry, ["area", "hash"]) || !validLocation(entry) || locations.has(keyFor(entry))) fail("inventory-location-invalid");
        if (locations.size >= DELETION_LIMITS.files) fail("inventory-file-bound");
        const location = { area: entry.area, hash: entry.hash };
        locations.add(keyFor(location));
        const bytes = await read(location);
        inputBytes += bytes.length;
        if (inputBytes > DELETION_LIMITS.totalBytes) fail("inventory-byte-bound");
        let value;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { fail("inventory-json-invalid"); }
        if (value?.contractVersion !== NATIVE_SEGMENTED_CONTRACT) continue;
        const block = decodeNativeSegmentedBlock(bytes, location.hash), accountRef = nativeRetentionHash(block.account);
        if (!accounts.has(accountRef)) { accounts.set(accountRef, block.account); metadata({ accountRef, account: block.account }); }
        const item = { ...location, kind: block.kind, bytes: bytes.length, accountRef, disposition: "unreferenced" };
        metadata(item); blocks.set(keyFor(location), item);
    }
    for (const root of pinned.values()) {
        const block = blocks.get(keyFor(root));
        if (!block || block.kind !== "root" || block.accountRef !== nativeRetentionHash(root.account)) fail("inventory-root-missing");
    }
    // Every complete historical root is validated too. Incomplete non-root
    // staging blocks remain inventoried, never promoted into committed roots.
    for (const root of blocks.values()) {
        if (root.kind !== "root") continue;
        const isCurrent = pinned.has(keyFor(root));
        const reader = await openNativeSegmentedReader({ rootHash: root.hash, expectedAccount: accounts.get(root.accountRef),
            assertCurrent: check, signal, async readBlock(hash) {
                const location = { area: root.area, hash }, item = blocks.get(keyFor(location));
                if (!item || item.accountRef !== root.accountRef) fail("inventory-member-missing");
                return read(location);
            } });
        try {
            for await (const ref of reader.iterateBlockReferences()) {
                const item = blocks.get(keyFor({ area: root.area, hash: ref.hash }));
                if (!item || item.kind !== ref.kind) fail("inventory-member-missing");
                if (isCurrent) item.disposition = ref.kind === "root" ? "current-root" : "current-member";
                else if (item.disposition === "unreferenced") item.disposition = ref.kind === "root" ? "historical-root" : "historical-member";
            }
        } finally { reader.close(); }
    }
    check();
    const result = Object.freeze({ schemaVersion: 1, kind: "native-segmented-inventory", inputFiles: locations.size, inputBytes,
        blocks: Object.freeze([...blocks.values()].map(Object.freeze)),
        accounts: Object.freeze([...accounts].map(([accountRef, account]) => Object.freeze({ accountRef, account }))),
        roots: Object.freeze([...pinned.values()].map(root => Object.freeze({ area: root.area, hash: root.hash,
            accountRef: nativeRetentionHash(root.account) }))) });
    if (Buffer.byteLength(JSON.stringify(result)) > DELETION_LIMITS.metadataBytes) fail("inventory-metadata-bound");
    return result;
}
