import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BoardError, resolveDataDir } from "./store.mjs";
import { validateNativeRetentionState } from "./native-retention-state.mjs";
import { nativeValueHasCredentials } from "./native-read-model.mjs";
import { assertCollectorLockOwned } from "./collector-io.mjs";

const liveLimit = 1024, archiveAt = 128, recentLimit = 64, rowLimit = 16384;
const fail = code => { throw Object.assign(new BoardError("Microsoft collection receipt recovery is unavailable. No source operation was replayed.", 503), { code }); };
const digest = text => createHash("sha256").update(text).digest("hex");
const archiveFile = (context, archive) => path.join(resolveDataDir(context), "collector", "native-receipts", `${archive.id}.sqlite`);

function removable(retention, active) {
    const pinned = new Set([...active, ...retention.partitions.map(item => item.lastOperationId),
        ...retention.receipts.slice(-recentLimit).map(item => item.operationId)]);
    return retention.receipts.filter(item => item.status === "committed" && !pinned.has(item.operationId));
}

export function nativeReceiptCapacityAvailable(retention, active = []) {
    return retention.receipts.length < liveLimit || removable(retention, active).length > 0;
}

export function nativeReceiptsNeedArchival(retention, active = []) {
    return retention.receipts.length >= archiveAt && removable(retention, active).length > 0;
}

function configure(database) {
    database.exec("PRAGMA cache_size=-512; PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;");
}

function assertArchive(database, archive) {
    const identity = database.prepare("SELECT schema_version, archive_id FROM archive_info WHERE singleton=1").get();
    if (identity?.schema_version !== 1 || identity.archive_id !== archive.id) fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
}

async function recoverExistingArchive(context, file, archive) {
    let journal;
    try { journal = await lstat(file + "-journal"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!journal.isFile() || journal.isSymbolicLink()) fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
    if (!journal.size) return;
    const resolved = await realpath(file), before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || path.relative(path.resolve(file), resolved) !== "") {
        fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
    }
    await assertCollectorLockOwned(resolveDataDir(context));
    const existing = pathToFileURL(resolved);
    existing.searchParams.set("mode", "rw");
    // SQLite owns rollback and journal retirement; mode=rw cannot create a missing archive.
    const database = new DatabaseSync(existing.href);
    try { configure(database); assertArchive(database, archive); }
    finally { database.close(); }
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
        fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
    }
    await assertCollectorLockOwned(resolveDataDir(context));
}

// Only confirmed historical metadata moves here. The board remains authoritative
// until its atomic save publishes the archive marker and the compacted live window.
export async function compactNativeReceipts(context, retention, active, check, publishArchive) {
    if (retention.receipts.length < archiveAt) return retention;
    const candidates = removable(retention, active);
    if (!candidates.length) {
        if (retention.receipts.length >= liveLimit) fail("NATIVE_RETENTION_RECEIPT_LIMIT");
        return retention;
    }
    const archive = retention.receiptArchive ?? { schemaVersion: 1, id: randomUUID() };
    const file = archiveFile(context, archive);
    let database, transaction = false;
    try {
        check();
        if (!retention.receiptArchive) {
            await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            check();
            const handle = await open(file, "wx", 0o600);
            await handle.close();
        }
        check();
        database = new DatabaseSync(file);
        configure(database);
        database.exec("PRAGMA synchronous=FULL;");
        if (!retention.receiptArchive) {
            database.exec("CREATE TABLE archive_info(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,archive_id TEXT NOT NULL);"
                + "CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL) WITHOUT ROWID;");
            database.prepare("INSERT INTO archive_info VALUES(1,1,?)").run(archive.id);
        }
        assertArchive(database, archive);
        database.close();
        database = new DatabaseSync(file, { readOnly: true });
        configure(database);
        assertArchive(database, archive);
        database.close(); database = null;
        if (!retention.receiptArchive) await publishArchive(archive);
        check();
        database = new DatabaseSync(file);
        configure(database);
        database.exec("PRAGMA synchronous=FULL;");
        assertArchive(database, archive);
        database.exec("BEGIN IMMEDIATE");
        transaction = true;
        const insert = database.prepare("INSERT OR IGNORE INTO receipts(operation_id,receipt_json,receipt_hash) VALUES(?,?,?)");
        const verify = database.prepare(`SELECT CASE WHEN length(receipt_json)<=${rowLimit} THEN receipt_json END AS body,receipt_hash FROM receipts WHERE operation_id=?`);
        for (const receipt of candidates) {
            check();
            const text = JSON.stringify(receipt), hash = digest(text);
            if (Buffer.byteLength(text) > rowLimit || nativeValueHasCredentials(receipt)) fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
            insert.run(receipt.operationId, text, hash);
            const saved = verify.get(receipt.operationId);
            if (saved?.body !== text || saved.receipt_hash !== hash) fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
        }
        check();
        database.exec("COMMIT");
        transaction = false;
        database.close();
        database = new DatabaseSync(file, { readOnly: true });
        configure(database);
        assertArchive(database, archive);
        const readback = database.prepare(`SELECT CASE WHEN length(receipt_json)<=${rowLimit} THEN receipt_json END AS body,receipt_hash FROM receipts WHERE operation_id=?`);
        for (const receipt of candidates) {
            check();
            const text = JSON.stringify(receipt), saved = readback.get(receipt.operationId);
            if (saved?.body !== text || saved.receipt_hash !== digest(text)) fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
        }
        check();
        const archived = new Set(candidates.map(item => item.operationId));
        return { ...retention, receiptArchive: archive, receipts: retention.receipts.filter(item => !archived.has(item.operationId)) };
    } catch (error) {
        if (transaction) {
            try { database.exec("ROLLBACK"); }
            catch { console.error("[workiq-runtime] receipt archive rollback failed", { code: "NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE" }); }
        }
        if (error instanceof BoardError) throw error;
        fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE");
    } finally { database?.close(); }
}

export async function readArchivedNativeReceipt(context, retention, operationId) {
    if (!retention?.receiptArchive) return null;
    let database;
    try {
        const file = archiveFile(context, retention.receiptArchive);
        await recoverExistingArchive(context, file, retention.receiptArchive);
        database = new DatabaseSync(file, { readOnly: true });
        configure(database);
        assertArchive(database, retention.receiptArchive);
        const row = database.prepare(`SELECT CASE WHEN length(receipt_json)<=${rowLimit} THEN receipt_json END AS body,receipt_hash FROM receipts WHERE operation_id=?`).get(operationId);
        if (!row) return null;
        if (typeof row.body !== "string" || Buffer.byteLength(row.body) > rowLimit || digest(row.body) !== row.receipt_hash) {
            fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
        }
        const receipt = JSON.parse(row.body);
        validateNativeRetentionState({ ...retention, receipts: [receipt] });
        if (receipt.status !== "committed" || receipt.operationId !== operationId || nativeValueHasCredentials(receipt)) {
            fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_INVALID");
        }
        return receipt;
    } catch (error) {
        if (error instanceof BoardError) throw error;
        fail("NATIVE_RETENTION_RECEIPT_ARCHIVE_UNAVAILABLE");
    } finally { database?.close(); }
}
