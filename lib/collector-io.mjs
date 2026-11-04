import { open, mkdir, readFile, rename, unlink, stat as fileStat } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { BoardError, writeExclusive } from "./store.mjs";
import { historyGap, isHistoryGap, validEventEnvelope } from "./prompt-linkage.mjs";

const ownedCollectorLocks = new Map();
export const hash = value => createHash("sha256").update(value).digest("hex");
export const sourceFileStamp = value => [value.dev, value.ino, value.birthtimeMs, value.size, value.mtimeMs, value.ctimeMs].join(":");
export async function readJson(file, missing = null) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return missing; throw error; }
}
export async function atomicJson(file, value, { assertCurrent } = {}) {
    if (assertCurrent !== undefined && typeof assertCurrent !== "function") throw new TypeError("Invalid atomic-write guard.");
    assertCurrent?.();
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeExclusive(temp, JSON.stringify(value));
        assertCurrent?.();
        await rename(temp, file);
    } catch (error) {
        try { await unlink(temp); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw new AggregateError([error, cleanup], "Atomic write cleanup failed."); }
        throw error;
    }
}

export async function acquireCollectorLock(dataDir) {
    await mkdir(dataDir, { recursive: true });
    const key = path.resolve(dataDir);
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
    ownedCollectorLocks.set(key, owner);
    return async () => {
        try {
            const current = await readJson(file);
            if (current?.token !== owner.token) throw new Error("Collector writer lock ownership changed.");
            await unlink(file);
        } finally {
            if (ownedCollectorLocks.get(key) === owner) ownedCollectorLocks.delete(key);
        }
    };
}

export async function assertCollectorLockOwned(dataDir) {
    const owned = typeof dataDir === "string" ? ownedCollectorLocks.get(path.resolve(dataDir)) : undefined;
    if (!owned) throw Object.assign(new BoardError("The existing collector must own the private writer lock.", 409),
        { code: "COLLECTOR_LOCK_REQUIRED" });
    const current = await readJson(path.join(dataDir, "collector.lock"));
    if (current?.token !== owned.token || current?.pid !== owned.pid) {
        throw Object.assign(new BoardError("Collector writer lock ownership changed; no write was admitted.", 409),
            { code: "COLLECTOR_LOCK_CHANGED" });
    }
}

export const TAIL_LIMITS = Object.freeze({
    initialFileBytes: 64 * 1024 ** 2, chunkBytes: 4 * 1024 ** 2,
    cycleBytes: 32 * 1024 ** 2, maxLineBytes: 1024 ** 2,
    maxContextBytes: 512 * 1024, maxContextEvents: 2000,
    // One accepted original must survive until its first call, independently of general correlation context.
    maxPendingPromptBytes: 1024 ** 2 + 2048,
});

export function tailReadBudget(cursor, availableBytes) {
    const partial = cursor?.partialBytes ?? 0;
    if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > TAIL_LIMITS.cycleBytes
        || !Number.isSafeInteger(partial) || partial < 0 || partial >= TAIL_LIMITS.chunkBytes) {
        throw new TypeError("Invalid pending-tail read budget.");
    }
    const budget = Math.min(availableBytes, TAIL_LIMITS.chunkBytes);
    return partial && partial >= budget ? 0 : budget;
}

export function contextFits(events) {
    const latest = events.findLast(event => event.type === "user.message" || isHistoryGap(event));
    const pending = isHistoryGap(latest) || latest?.data?.wirePromptCapture?.version === 1 ? latest : undefined;
    return events.length <= TAIL_LIMITS.maxContextEvents
        && (!pending || Buffer.byteLength(JSON.stringify(pending)) <= TAIL_LIMITS.maxPendingPromptBytes)
        && Buffer.byteLength(JSON.stringify(events.filter(event => event !== pending))) <= TAIL_LIMITS.maxContextBytes;
}

export async function readTail(file, sessionId, previous, budget = TAIL_LIMITS.chunkBytes,
    { startAtBeginning = false, fence, completionMetadata = false } = {}) {
    if (typeof startAtBeginning !== "boolean" || typeof completionMetadata !== "boolean" || fence && completionMetadata) {
        throw new TypeError("Invalid event-read window.");
    }
    if (fence && (typeof fence.identity !== "string" || !fence.identity || fence.identity.length > 1024
        || !Number.isSafeInteger(fence.endOffset) || fence.endOffset < 1
        || fence.anchor !== null && !/^[a-f0-9]{64}$/.test(fence.anchor ?? "")
        || !Number.isSafeInteger(budget) || budget < 65536 + 512)) throw new TypeError("Invalid bounded prefix read.");
    const projector = completionMetadata ? (await import("./completion-projection.mjs")).projectOversizedCompletion : null;
    const handle = await open(file, "r");
    let chargedBytes = 0, payloadBytesRead = 0;
    const read = async (buffer, length, position) => {
        const result = await handle.read(buffer, 0, length, position);
        chargedBytes += result.bytesRead;
        return result;
    };
    const invalidated = () => Object.assign(new BoardError("Backfill source generation or boundary changed. Prior evidence retained.", 409),
        { code: "BACKFILL_GENERATION_CHANGED" });
    try {
        const stat = await handle.stat();
        if (fence && stat.size < fence.endOffset) throw invalidated();
        const prefix = Buffer.alloc(Math.min(stat.size, 65536, fence?.endOffset ?? Infinity));
        await read(prefix, prefix.length, 0);
        let startup;
        try { startup = JSON.parse(prefix.subarray(0, prefix.indexOf(10) < 0 ? prefix.length : prefix.indexOf(10)).toString("utf8")); }
        catch { throw Object.assign(new BoardError("Local log startup is incomplete or invalid; source not consumed.", 422), { code: "HISTORY_STARTUP_INVALID" }); }
        if (startup.type !== "session.start" || startup.data?.sessionId !== sessionId || startup.data.version !== 1) throw Object.assign(new BoardError("Local log startup identity/schema does not match the mapped chat.", 422), { code: "HISTORY_IDENTITY_UNSUPPORTED" });
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${startup.id}`;
        let fenceAnchor;
        const readFenceAnchor = async () => {
            const anchor = Buffer.alloc(Math.min(fence.endOffset, 128));
            const result = await read(anchor, anchor.length, fence.endOffset - anchor.length);
            if (result.bytesRead !== anchor.length) throw invalidated();
            return hash(anchor);
        };
        if (fence) {
            if (identity !== fence.identity || previous && (previous.identity !== identity || previous.offset > fence.endOffset)) throw invalidated();
            fenceAnchor = await readFenceAnchor();
            if (fence.anchor !== null && fenceAnchor !== fence.anchor) throw invalidated();
        }
        let reset = Boolean(previous && (previous.identity !== identity || stat.size < previous.offset));
        if (previous && !reset && previous.offset) {
            const anchor = Buffer.alloc(Math.min(previous.offset, 128));
            await read(anchor, anchor.length, previous.offset - anchor.length);
            reset = hash(anchor) !== previous.anchor;
        }
        if (fence && reset) throw invalidated();
        const initialOffset = startAtBeginning || fence ? 0 : Math.max(0, stat.size - TAIL_LIMITS.initialFileBytes);
        let cursor = !previous || reset ? {
            identity, offset: initialOffset,
            droppedBytes: initialOffset, rotations: (previous?.rotations ?? 0) + Number(reset),
            malformedLines: 0, oversizedLines: 0, skipping: initialOffset > 0,
        } : { ...previous };
        if ((!previous || reset) && initialOffset > 0) {
            const boundary = Buffer.alloc(1);
            await read(boundary, 1, initialOffset - 1);
            cursor.skipping = boundary[0] !== 10;
            if (cursor.skipping) cursor.skipReason = "initial-window";
        }
        const endOffset = fence?.endOffset ?? stat.size;
        const available = fence ? Math.min(budget, TAIL_LIMITS.chunkBytes) - chargedBytes - 256 : budget;
        const length = Math.max(0, Math.min(endOffset - cursor.offset, available, TAIL_LIMITS.chunkBytes));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await read(buffer, length, cursor.offset);
        payloadBytesRead = bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        const readStart = cursor.offset, original = [], projected = [];
        const events = [];
        const gap = (reason, at) => {
            if (events.at(-1)?.type === "wire.history_gap") return;
            const offset = cursor.offset + at;
            events.push(historyGap(`wire-gap-${hash(`${identity}:${offset}:${reason}`)}`, reason, offset));
        };
        if ((!previous || reset) && initialOffset > 0) gap("initial-window", 0);
        if (cursor.skipping) gap(cursor.skipReason ?? (!previous || reset ? "initial-window" : "unavailable"), 0);
        let start = 0, end;
        while ((end = bytes.indexOf(10, start)) !== -1) {
            const line = bytes.subarray(start, end);
            if (cursor.skipping) { cursor.skipping = false; delete cursor.skipReason; }
            else if (line.length > TAIL_LIMITS.maxLineBytes) {
                cursor.oversizedLines++; gap("oversized-line", start);
                if (completionMetadata) {
                    const projection = projector(bytes.subarray(start, end + 1), {
                        maxInputBytes: TAIL_LIMITS.chunkBytes, maxOutputBytes: TAIL_LIMITS.maxLineBytes,
                    });
                    if (projection.kind === "projected") projected.push({
                        offset: readStart + start, endOffset: readStart + end + 1, event: projection.event,
                    });
                }
            }
            else if (line.length) {
                try {
                    const event = JSON.parse(line.toString("utf8"));
                    if (!validEventEnvelope(event) && !(cursor.offset + start === 0 && event?.type === "session.start")) {
                        throw new TypeError("Invalid event envelope.");
                    }
                    events.push(event);
                    if (completionMetadata && isUtf8(line)) original.push({ offset: readStart + start, endOffset: readStart + end + 1, event });
                } catch { cursor.malformedLines++; gap("malformed-line", start); }
            }
            start = end + 1;
        }
        const remaining = bytes.length - start;
        const pendingLimit = completionMetadata ? TAIL_LIMITS.chunkBytes - 1 : TAIL_LIMITS.maxLineBytes;
        if (remaining > pendingLimit || cursor.skipping) {
            if (!cursor.skipping) { cursor.oversizedLines++; cursor.skipReason = "oversized-line"; gap("oversized-line", start); }
            cursor.skipping = true;
            start = bytes.length;
        }
        const fenceTruncated = Boolean(fence && cursor.offset + bytes.length === fence.endOffset && remaining);
        if (fenceTruncated && start < bytes.length) {
            gap("initial-window", start);
            start = bytes.length;
        }
        // Never checkpoint raw unfinished JSON/UTF-8. Re-read that bounded tail after append/restart.
        cursor.offset += start;
        cursor.partialBytes = cursor.skipping || fenceTruncated ? 0 : remaining;
        cursor.logBytes = endOffset;
        cursor.backlogBytes = endOffset - cursor.offset;
        const anchor = Buffer.alloc(Math.min(cursor.offset, 128));
        await read(anchor, anchor.length, cursor.offset - anchor.length);
        cursor.anchor = hash(anchor);
        let completedStamp = sourceFileStamp(stat);
        if (fence) {
            const current = await fileStat(file);
            if (`${current.dev}:${current.ino}:${current.birthtimeMs}` !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
                || current.size < fence.endOffset || await readFenceAnchor() !== fenceAnchor) throw invalidated();
            completedStamp = sourceFileStamp(current);
        } else if (projected.length || cursor.partialBytes > TAIL_LIMITS.maxLineBytes) {
            if (sourceFileStamp(await fileStat(file)) !== completedStamp) {
                throw Object.assign(new BoardError("Source history changed during bounded metadata reading. No progress was admitted.", 409),
                    { code: "HISTORY_SOURCE_CHANGED" });
            }
        }
        return { cursor, events, bytesRead: fence ? chargedBytes : bytesRead, reset, startupEventId: startup.id,
            ...(fence ? { fenceAnchor, fenceTruncated, sourceStamp: completedStamp } : {}),
            ...(completionMetadata ? { recovery: { sourceIdentity: identity, readStart, readEnd: readStart + bytes.length,
                original, projected, sourceStamp: completedStamp } } : {}) };
    } catch (error) {
        if (fence) error.bytesRead = chargedBytes;
        else if (completionMetadata) error.bytesRead = payloadBytesRead;
        throw error;
    } finally { await handle.close(); }
}
