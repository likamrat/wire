import { open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { BoardError, writeExclusive } from "./store.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export async function readJson(file, missing = null) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return missing; throw error; }
}
export async function atomicJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeExclusive(temp, JSON.stringify(value));
        await rename(temp, file);
    } catch (error) {
        try { await unlink(temp); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw new AggregateError([error, cleanup], "Atomic write cleanup failed."); }
        throw error;
    }
}

export async function acquireCollectorLock(dataDir) {
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "collector.lock");
    const owner = { pid: process.pid, token: randomUUID() };
    async function claim() { await writeExclusive(file, JSON.stringify(owner)); }
    try { await claim(); }
    catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Only one process may reclaim a dead owner. A live/reused PID fails closed.
        const recovery = `${file}.recovery`;
        let handle;
        try { handle = await open(recovery, "wx", 0o600); }
        catch (error) { if (error.code === "EEXIST") throw new BoardError("Collector lock recovery is in progress. Retry after its owner exits.", 409); throw error; }
        try {
            const previous = await readJson(file);
            if (previous) {
                if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new BoardError("Collector lock is invalid. Inspect the private lock before recovery.", 409);
                let alive = true;
                try { process.kill(previous.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
                if (alive) throw new BoardError("Another runtime owns this private collection. No second writer was started.", 409);
                await unlink(file);
            }
            await claim();
        } finally { await handle.close(); await unlink(recovery); }
    }
    return async () => {
        const current = await readJson(file);
        if (current?.token !== owner.token) throw new Error("Collector writer lock ownership changed.");
        await unlink(file);
    };
}

export const TAIL_LIMITS = Object.freeze({
    initialFileBytes: 64 * 1024 ** 2, chunkBytes: 4 * 1024 ** 2,
    cycleBytes: 32 * 1024 ** 2, maxLineBytes: 1024 ** 2,
    maxContextBytes: 512 * 1024, maxContextEvents: 2000,
});

export async function readTail(file, sessionId, previous, budget = TAIL_LIMITS.chunkBytes, { startAtBeginning = false } = {}) {
    if (typeof startAtBeginning !== "boolean") throw new TypeError("Invalid event-read window.");
    const handle = await open(file, "r");
    try {
        const stat = await handle.stat();
        const prefix = Buffer.alloc(Math.min(stat.size, 65536));
        await handle.read(prefix, 0, prefix.length, 0);
        let startup;
        try { startup = JSON.parse(prefix.subarray(0, prefix.indexOf(10) < 0 ? prefix.length : prefix.indexOf(10)).toString("utf8")); }
        catch { throw Object.assign(new BoardError("Local log startup is incomplete or invalid; source not consumed.", 422), { code: "HISTORY_STARTUP_INVALID" }); }
        if (startup.type !== "session.start" || startup.data?.sessionId !== sessionId || startup.data.version !== 1) throw Object.assign(new BoardError("Local log startup identity/schema does not match the mapped chat.", 422), { code: "HISTORY_IDENTITY_UNSUPPORTED" });
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${startup.id}`;
        let reset = Boolean(previous && (previous.identity !== identity || stat.size < previous.offset));
        if (previous && !reset && previous.offset) {
            const anchor = Buffer.alloc(Math.min(previous.offset, 128));
            await handle.read(anchor, 0, anchor.length, previous.offset - anchor.length);
            reset = hash(anchor) !== previous.anchor;
        }
        const initialOffset = startAtBeginning ? 0 : Math.max(0, stat.size - TAIL_LIMITS.initialFileBytes);
        let cursor = !previous || reset ? {
            identity, offset: initialOffset,
            droppedBytes: initialOffset, rotations: (previous?.rotations ?? 0) + Number(reset),
            malformedLines: 0, oversizedLines: 0, skipping: initialOffset > 0,
        } : { ...previous };
        const length = Math.min(stat.size - cursor.offset, budget, TAIL_LIMITS.chunkBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
        const bytes = buffer.subarray(0, bytesRead);
        const events = [];
        let start = 0, end;
        while ((end = bytes.indexOf(10, start)) !== -1) {
            const line = bytes.subarray(start, end);
            if (cursor.skipping) cursor.skipping = false;
            else if (line.length > TAIL_LIMITS.maxLineBytes) cursor.oversizedLines++;
            else if (line.length) {
                try { events.push(JSON.parse(line.toString("utf8"))); }
                catch { cursor.malformedLines++; }
            }
            start = end + 1;
        }
        const remaining = bytes.length - start;
        if (remaining > TAIL_LIMITS.maxLineBytes || cursor.skipping) {
            if (!cursor.skipping) cursor.oversizedLines++;
            cursor.skipping = true;
            start = bytes.length;
        }
        // Never checkpoint raw unfinished JSON/UTF-8. Re-read that bounded tail after append/restart.
        cursor.offset += start;
        cursor.partialBytes = cursor.skipping ? 0 : remaining;
        cursor.logBytes = stat.size;
        cursor.backlogBytes = stat.size - cursor.offset;
        const anchor = Buffer.alloc(Math.min(cursor.offset, 128));
        await handle.read(anchor, 0, anchor.length, cursor.offset - anchor.length);
        cursor.anchor = hash(anchor);
        return { cursor, events, bytesRead, reset, startupEventId: startup.id };
    } finally { await handle.close(); }
}
