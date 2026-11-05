import { lstat, open, readdir, unlink } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { BoardError, preparePublicationCheck } from "./store.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { atomicJson, hash, readJson, TAIL_LIMITS } from "./collector-io.mjs";
import { validateCollectorIndex } from "./collector-index.mjs";
import { BACKFILL_DIRECTORY, BACKFILL_LIMITS, backfillCheckpointPath, validateBackfillCheckpoint } from "./collector-backfill.mjs";

export const BACKFILL_CHECKPOINT_BYTES = BACKFILL_LIMITS.progressBytes
    + TAIL_LIMITS.maxContextBytes + TAIL_LIMITS.maxPendingPromptBytes + 8192;
const canonical = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i;
const fail = (code, message) => Object.assign(new BoardError(message, 409), { code });
const cleanupRequired = () => fail("BACKFILL_CHECKPOINT_CLEANUP_REQUIRED",
    "Backfill storage requires managed cleanup before collection can resume. No cache was selected.");

export async function loadBackfillCheckpoint(collectorRoot) {
    if (typeof collectorRoot !== "string" || !path.isAbsolute(collectorRoot)) throw new TypeError("Backfill storage requires an absolute collector root.");
    const directory = await safeDeletionFile(collectorRoot, BACKFILL_DIRECTORY);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!entries.length) return null;
    // An interrupted atomic-write staging file is not invisible or an invitation to delete it.
    if (entries.length !== 1 || !entries[0].isFile() || !canonical.test(entries[0].name)) throw cleanupRequired();
    const file = await safeDeletionFile(collectorRoot, path.join(BACKFILL_DIRECTORY, entries[0].name));
    if ((await lstat(file)).nlink !== 1) throw cleanupRequired();
    const handle = await open(file, "r");
    let bytes;
    try {
        const before = await handle.stat();
        if (before.size > BACKFILL_CHECKPOINT_BYTES) throw cleanupRequired();
        const buffer = Buffer.alloc(before.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await handle.stat();
        if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || after.ctimeMs !== before.ctimeMs) throw fail("BACKFILL_CHECKPOINT_CHANGED", "Backfill storage changed during reading.");
        bytes = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    if (!isUtf8(bytes)) throw cleanupRequired();
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw cleanupRequired(); throw error; }
    const checkpoint = validateBackfillCheckpoint(value);
    if (entries[0].name !== `${checkpoint.backfillSource}.json`) throw cleanupRequired();
    return { file, hash: hash(bytes), checkpoint };
}

function retiredCheckpoint(checkpoint) {
    return validateBackfillCheckpoint({ ...checkpoint, events: [], diagnostics: {},
        backfill: { ...checkpoint.backfill, activeSource: null,
            sources: checkpoint.backfill.sources.map(row => row.phase === "reading" ? { ...row, phase: "invalidated" } : row) } });
}

// Unwired storage primitive: callers must hold the collector writer/admission and commit evidence first.
export async function publishBackfillCheckpoint(collectorRoot, previous, next, { assertCurrent, preparePublication } = {}) {
    if (typeof assertCurrent !== "function") throw new TypeError("Backfill publication requires the existing acquisition guard.");
    if (preparePublication !== undefined && typeof preparePublication !== "function") throw new TypeError("Invalid backfill publication preparation.");
    const check = () => {
        const result = assertCurrent();
        if (result !== undefined && result !== true) {
            if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
            throw fail("BACKFILL_PUBLICATION_REVOKED", "Backfill publication no longer has its original acquisition.");
        }
    };
    const recheck = () => preparePublicationCheck(check, preparePublication);
    await recheck();
    const planned = structuredClone(validateBackfillCheckpoint(next));
    const plannedHash = hash(JSON.stringify(planned));
    const current = await loadBackfillCheckpoint(collectorRoot);
    await recheck();
    if (Boolean(current) !== Boolean(previous) || current && (current.file !== previous.file || current.hash !== previous.hash)) {
        throw fail("BACKFILL_CHECKPOINT_CHANGED", "Backfill checkpoint membership changed before publication.");
    }
    if (current && planned.backfill.deletionVersion < current.checkpoint.backfill.deletionVersion) {
        throw fail("BACKFILL_CHECKPOINT_CHANGED", "Backfill publication cannot restore an older deletion epoch.");
    }
    const index = await readJson(path.join(collectorRoot, "index.json"));
    await recheck();
    if (![2, 3].includes(index?.schemaVersion) || index.boundedHistoryVersion !== 1) {
        throw fail("BACKFILL_INDEX_BARRIER_REQUIRED", "Backfill progress requires the committed bounded collector index barrier.");
    }
    validateCollectorIndex(index);
    const target = backfillCheckpointPath(collectorRoot, planned);
    await safeDeletionFile(collectorRoot, path.relative(collectorRoot, target));
    await recheck();
    if (current?.file === target && current.hash === plannedHash) return current;
    if (current && current.file !== target) {
        if (current.checkpoint.events.length || current.checkpoint.backfill.activeSource !== null) {
            await atomicJson(current.file, retiredCheckpoint(current.checkpoint), { assertCurrent: check, preparePublication });
        }
        await recheck();
        // A missing cache permits a fresh bounded replay; a mismatched source filename never does.
        await unlink(current.file);
        await recheck();
    }
    await atomicJson(target, planned, { assertCurrent: check, preparePublication });
    await recheck();
    const published = await loadBackfillCheckpoint(collectorRoot);
    await recheck();
    if (published?.file !== target || published.hash !== plannedHash) {
        throw fail("BACKFILL_CHECKPOINT_CHANGED", "Published backfill checkpoint changed before confirmation.");
    }
    return published;
}
