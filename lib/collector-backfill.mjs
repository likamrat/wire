import path from "node:path";
import { contextFits, hash, readTail, TAIL_LIMITS } from "./collector-io.mjs";
import { DISCOVERY_LIMITS } from "./source-discovery.mjs";

export const BACKFILL_LIMITS = Object.freeze({
    sources: DISCOVERY_LIMITS.maxSessions,
    progressBytes: 4 * 1024 ** 2,
});
export const BACKFILL_DIRECTORY = hash("wire:single-global-backfill-context:v1");
const sourceId = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const generation = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,1024}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const phases = new Set(["pending", "reading", "visited", "invalidated", "suppressed", "unavailable"]);
const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));

function validateProgress(progress) {
    if (!only(progress, ["version", "fingerprint", "deletionVersion", "activeSource", "sources", "bytesRead"])
        || progress.version !== 1 || !digest(progress.fingerprint) || !count(progress.deletionVersion)
        || !Array.isArray(progress.sources) || progress.sources.length > BACKFILL_LIMITS.sources
        || !count(progress.bytesRead) || progress.activeSource !== null && !sourceId(progress.activeSource)
        || Buffer.byteLength(JSON.stringify(progress)) > BACKFILL_LIMITS.progressBytes) {
        throw new TypeError("Unsupported or excessive backfill progress.");
    }
    const ids = new Set();
    for (const row of progress.sources) {
        if (!only(row, ["sessionId", "identity", "endOffset", "anchor", "offset", "phase", "boundaryGap"])
            || !sourceId(row.sessionId) || ids.has(row.sessionId) || !generation(row.identity)
            || !Number.isSafeInteger(row.endOffset) || row.endOffset < 1 || !count(row.offset) || row.offset > row.endOffset
            || row.anchor !== null && !digest(row.anchor) || !phases.has(row.phase) || typeof row.boundaryGap !== "boolean") {
            throw new TypeError("Invalid fixed-prefix backfill identity or progress.");
        }
        if (row.phase === "pending" && (row.offset !== 0 || row.anchor !== null || row.boundaryGap)
            || row.phase === "reading" && (row.offset >= row.endOffset || row.anchor === null || row.boundaryGap)
            || row.phase === "visited" && (row.offset !== row.endOffset || row.anchor === null)) {
            throw new TypeError("Backfill phase contradicts its committed prefix progress.");
        }
        ids.add(row.sessionId);
    }
    const active = progress.sources.filter(row => row.phase === "reading");
    if (active.length > 1 || (active[0]?.sessionId ?? null) !== progress.activeSource) {
        throw new TypeError("Backfill supports only one global active context.");
    }
    return progress;
}

export function validateBackfillCheckpoint(checkpoint) {
    if (!only(checkpoint, ["schemaVersion", "backfillSource", "cursor", "events", "diagnostics", "backfill"])
        || checkpoint.schemaVersion !== 1 || !sourceId(checkpoint.backfillSource)
        || !Array.isArray(checkpoint.events) || !contextFits(checkpoint.events)
        || !only(checkpoint.diagnostics, ["credentialExclusions", "contextEvictions", "unsupportedPromptContents"])
        || !Object.values(checkpoint.diagnostics).every(count)) {
        throw new TypeError("Invalid bounded backfill checkpoint.");
    }
    const cursor = checkpoint.cursor;
    if (!only(cursor, ["identity", "offset", "droppedBytes", "rotations", "malformedLines", "oversizedLines",
        "skipping", "skipReason", "partialBytes", "logBytes", "backlogBytes", "anchor", "host"])
        || !generation(cursor.identity) || !digest(cursor.anchor) || typeof cursor.skipping !== "boolean"
        || !["offset", "droppedBytes", "rotations", "malformedLines", "oversizedLines", "partialBytes", "logBytes", "backlogBytes"]
            .every(key => count(cursor[key]))
        || cursor.offset > cursor.logBytes || cursor.partialBytes > TAIL_LIMITS.maxLineBytes
        || cursor.backlogBytes !== cursor.logBytes - cursor.offset
        || cursor.partialBytes > cursor.backlogBytes || cursor.skipping && cursor.partialBytes !== 0
        || cursor.skipReason !== undefined && !["oversized-line", "initial-window", "unavailable"].includes(cursor.skipReason)
        || cursor.host !== undefined && (!only(cursor.host, ["platform", "machine"])
            || typeof cursor.host.platform !== "string" || !digest(cursor.host.machine))) {
        throw new TypeError("Invalid bounded backfill cursor.");
    }
    const progress = validateProgress(checkpoint.backfill);
    const active = progress.sources.find(row => row.sessionId === progress.activeSource);
    if (active && (checkpoint.backfillSource !== active.sessionId || checkpoint.cursor?.identity !== active.identity
        || checkpoint.cursor?.offset !== active.offset || !digest(checkpoint.cursor?.anchor)
        || checkpoint.cursor?.logBytes !== active.endOffset || !count(checkpoint.cursor?.partialBytes)
        || checkpoint.cursor.partialBytes > TAIL_LIMITS.maxLineBytes)
        || !active && checkpoint.events.length) throw new TypeError("Backfill context does not match its fixed generation.");
    return checkpoint;
}

export function backfillCheckpointPath(collectorRoot, checkpoint) {
    validateBackfillCheckpoint(checkpoint);
    return path.join(collectorRoot, BACKFILL_DIRECTORY, `${checkpoint.backfillSource}.json`);
}

// Planning is not acquisition authority. The collector must bind these inputs to its current automatic/manual lease.
export function selectBackfillWork(checkpoint, { fingerprint, deletionVersion, sources, availableBytes,
    mode, enabled, globalPaused, automaticAvailable, manualAvailable, backfillAttempted }) {
    if (!digest(fingerprint) || !count(deletionVersion) || !Array.isArray(sources)
        || sources.length > BACKFILL_LIMITS.sources || !count(availableBytes) || availableBytes > TAIL_LIMITS.cycleBytes
        || typeof backfillAttempted !== "boolean" || !["automatic", "manual"].includes(mode)) {
        throw new TypeError("Invalid bounded backfill schedule.");
    }
    if (checkpoint) validateBackfillCheckpoint(checkpoint);
    const admitted = mode === "automatic" ? enabled === true && globalPaused === false && automaticAvailable === true
        : manualAvailable === true;
    if (!admitted) return { kind: "deferred", reason: "acquisition-unavailable", checkpoint };
    if (backfillAttempted) return { kind: "deferred", reason: "cycle-backfill-already-attempted", checkpoint };
    const reset = checkpoint?.backfill.fingerprint !== fingerprint;
    const progress = reset ? { version: 1, fingerprint, deletionVersion, activeSource: null, sources: [], bytesRead: 0 }
        : structuredClone(checkpoint.backfill);
    if (!reset && progress.deletionVersion !== deletionVersion) {
        progress.deletionVersion = deletionVersion;
        progress.activeSource = null;
        progress.sources = progress.sources.map(row => ({ ...row, phase: "suppressed" }));
        return { kind: "state-only", reason: "deletion-changed", progress, clearContext: true };
    }
    const eligible = new Map(), seen = new Set();
    for (const source of sources) {
        if (!sourceId(source.sessionId) || seen.has(source.sessionId)) throw new TypeError("Invalid or duplicate backfill source.");
        seen.add(source.sessionId);
        if (!source.eligible || source.error || !source.scanned || !(source.cursor?.droppedBytes > 0)) continue;
        if (!generation(source.cursor.identity) || !Number.isSafeInteger(source.cursor.droppedBytes)) {
            throw new TypeError("Backfill requires a verified main-reader generation and omitted-prefix fence.");
        }
        eligible.set(source.sessionId, source);
    }
    let clearContext = reset;
    progress.sources = progress.sources.map(row => {
        const source = eligible.get(row.sessionId);
        const phase = !source ? "unavailable" : source.cursor.identity !== row.identity
            || source.cursor.droppedBytes !== row.endOffset ? "invalidated" : row.phase;
        if (phase !== row.phase && row.sessionId === progress.activeSource) {
            progress.activeSource = null; clearContext = true;
        }
        return { ...row, phase };
    });
    const known = new Set(progress.sources.map(row => row.sessionId));
    for (const [sessionId, source] of eligible) if (!known.has(sessionId)) {
        progress.sources.push({ sessionId, identity: source.cursor.identity, endOffset: source.cursor.droppedBytes,
            anchor: null, offset: 0, phase: "pending", boundaryGap: false });
    }
    validateProgress(progress);
    const row = progress.sources.find(row => row.sessionId === progress.activeSource)
        ?? progress.sources.find(row => row.phase === "pending");
    if (!row) return { kind: "state-only", reason: "no-pending-prefix", progress, clearContext };
    if (availableBytes < TAIL_LIMITS.chunkBytes) return {
        kind: "deferred", reason: "insufficient-residual-budget", progress, clearContext,
    };
    return { kind: "read", progress, clearContext, sessionId: row.sessionId,
        fence: { identity: row.identity, endOffset: row.endOffset, anchor: row.anchor },
        cursor: row.phase === "reading" ? checkpoint.cursor : undefined,
        context: row.phase === "reading" ? checkpoint.events : [],
        diagnostics: row.phase === "reading" ? checkpoint.diagnostics : {},
        maxBytes: TAIL_LIMITS.chunkBytes };
}

export async function readBackfillChunk(file, selection, reader = readTail) {
    if (selection?.kind !== "read" || selection.maxBytes !== TAIL_LIMITS.chunkBytes) {
        throw new TypeError("A single admitted backfill selection is required.");
    }
    return reader(file, selection.sessionId, selection.cursor, selection.maxBytes, {
        startAtBeginning: true, fence: selection.fence,
    });
}

// Retained events must already have passed normal privacy/deletion filtering, in a separate prefix context.
export function stageBackfillProgress(selection, read, { events, diagnostics }) {
    if (selection?.kind !== "read" || !Array.isArray(events) || !contextFits(events)
        || !diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)
        || !count(read?.bytesRead) || read.bytesRead > selection.maxBytes || !digest(read.fenceAnchor)
        || read.cursor?.identity !== selection.fence.identity || read.cursor?.offset < (selection.cursor?.offset ?? 0)
        || read.cursor?.offset > selection.fence.endOffset || read.cursor?.logBytes !== selection.fence.endOffset) {
        throw new TypeError("Backfill progress must match the admitted bounded read and retained context.");
    }
    const progress = structuredClone(selection.progress);
    const row = progress.sources.find(row => row.sessionId === selection.sessionId);
    row.offset = read.cursor.offset;
    row.anchor = read.fenceAnchor;
    row.boundaryGap ||= read.fenceTruncated;
    row.phase = row.offset === row.endOffset ? "visited" : "reading";
    progress.bytesRead += read.bytesRead;
    progress.activeSource = row.phase === "reading" ? row.sessionId : null;
    const checkpoint = { schemaVersion: 1, backfillSource: row.sessionId,
        cursor: { ...read.cursor }, events: progress.activeSource ? events : [], diagnostics: { ...diagnostics }, backfill: progress };
    return validateBackfillCheckpoint(checkpoint);
}

export function stageBackfillReset(checkpoint, selection) {
    validateBackfillCheckpoint(checkpoint);
    if (!selection?.progress || !selection.clearContext) throw new TypeError("An explicit backfill context reset is required.");
    return validateBackfillCheckpoint({ ...checkpoint, events: [], diagnostics: {}, backfill: selection.progress });
}

export function backfillProgressSummary(checkpoint) {
    if (!checkpoint) return { pendingSources: 0, remainingBytes: 0, visitedSources: 0, blockedSources: 0 };
    const { sources } = validateBackfillCheckpoint(checkpoint).backfill;
    const pending = sources.filter(row => ["pending", "reading"].includes(row.phase));
    const remainingBytes = pending.reduce((sum, row) => sum + row.endOffset - row.offset, 0);
    if (!Number.isSafeInteger(remainingBytes)) throw new RangeError("Backfill byte summary exceeds the supported integer range.");
    return { pendingSources: pending.length, remainingBytes,
        visitedSources: sources.filter(row => row.phase === "visited").length,
        blockedSources: sources.filter(row => ["invalidated", "suppressed", "unavailable"].includes(row.phase)).length };
}
