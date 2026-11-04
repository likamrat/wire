import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { readTail, tailReadBudget, hash, TAIL_LIMITS } from "../lib/collector-io.mjs";
import { selectBackfillWork, readBackfillChunk, stageBackfillProgress, stageBackfillReset,
    validateBackfillCheckpoint, backfillCheckpointPath, backfillProgressSummary, BACKFILL_DIRECTORY, BACKFILL_LIMITS } from "../lib/collector-backfill.mjs";

const event = (id, type = "user.message", data = { content: "Invented prefix prompt" }) =>
    ({ id, type, timestamp: "2026-10-23T12:00:00Z", data });
const jsonl = events => events.map(value => JSON.stringify(value) + "\n").join("");
async function fixture(t, { large = false, cut = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-backfill-synthetic-")), sessionId = randomUUID();
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "events.jsonl");
    const startup = event("startup", "session.start", { sessionId, version: 1 });
    const middle = large ? Array.from({ length: 6 }, (_, index) =>
        event(`filler-${index}`, "assistant.message", { content: "x".repeat(900000) })) : [];
    const prefix = Buffer.from(jsonl([startup, event("prefix"), ...middle]) + (cut ? '{"id":"cross-boundary",' : ""));
    const suffix = (cut ? '"type":"user.message","timestamp":"2026-10-23T12:00:01Z","data":{"content":"cross-boundary"}}\n' : "")
        + jsonl([event("future-tail")]);
    await writeFile(file, Buffer.concat([prefix, Buffer.from(suffix)]));
    const main = await readTail(file, sessionId);
    const source = { sessionId, eligible: true, scanned: true, error: null,
        cursor: { ...main.cursor, droppedBytes: prefix.length } };
    const options = { fingerprint: hash("source-and-window"), deletionVersion: 0, sources: [source],
        availableBytes: TAIL_LIMITS.chunkBytes, mode: "automatic", enabled: true, globalPaused: false,
        automaticAvailable: true, manualAvailable: false, backfillAttempted: false };
    return { root, file, prefix, source, options, main };
}
async function first(t, options) {
    const f = await fixture(t, options), selected = selectBackfillWork(null, f.options);
    const read = await readBackfillChunk(f.file, selected);
    const checkpoint = stageBackfillProgress(selected, read, {
        events: read.events.filter(event => event.id === "prefix"), diagnostics: { contextEvictions: 0 },
    });
    return { ...f, selected, read, checkpoint };
}

test("automatic/manual selection obeys pause and distinct acquisition availability", async t => {
    const { options } = await fixture(t);
    for (const patch of [{ enabled: false }, { globalPaused: true }, { automaticAvailable: false },
        { mode: "manual", manualAvailable: false }]) {
        const selection = selectBackfillWork(null, { ...options, ...patch });
        assert.equal(selection.kind, "deferred");
        assert.equal(selection.reason, "acquisition-unavailable");
    }
    const selection = selectBackfillWork(null, { ...options, mode: "manual", enabled: false,
        automaticAvailable: false, manualAvailable: true });
    assert.equal(selection.kind, "read");
    assert.equal(selection.maxBytes, TAIL_LIMITS.chunkBytes);
    assert.equal(options.enabled, true, "The planner never changes collection settings");
});

test("tail priority defers once without spending insufficient residual capacity", async t => {
    const { options } = await fixture(t);
    for (const availableBytes of [0, 512 * 1024, TAIL_LIMITS.chunkBytes - 1]) {
        const selection = selectBackfillWork(null, { ...options, availableBytes });
        assert.equal(selection.kind, "deferred");
        assert.equal(selection.reason, "insufficient-residual-budget");
        assert.equal(selection.progress.sources[0].offset, 0);
        assert.equal(selection.progress.bytesRead, 0);
    }
    assert.equal(selectBackfillWork(null, { ...options, availableBytes: TAIL_LIMITS.cycleBytes }).kind, "read");
    assert.equal(selectBackfillWork(null, { ...options, backfillAttempted: true }).reason, "cycle-backfill-already-attempted");
});

test("pending-tail budget defers an unchanged-size reread until capacity can make progress", () => {
    for (const partialBytes of [512 * 1024, 1536 * 1024, TAIL_LIMITS.chunkBytes - 1]) {
        assert.equal(tailReadBudget({ partialBytes }, partialBytes - 1), 0);
        assert.equal(tailReadBudget({ partialBytes }, partialBytes), 0);
        assert.equal(tailReadBudget({ partialBytes }, TAIL_LIMITS.cycleBytes), TAIL_LIMITS.chunkBytes);
        assert.equal(tailReadBudget({ partialBytes }, partialBytes + 1), partialBytes + 1);
    }
    assert.equal(tailReadBudget(undefined, 0), 0);
    assert.equal(tailReadBudget(undefined, 100), 100);
    assert.throws(() => tailReadBudget({ partialBytes: TAIL_LIMITS.chunkBytes }, TAIL_LIMITS.cycleBytes), TypeError);
});

test("fixed fence never follows appends, changes main context or retires the original gap", async t => {
    const f = await fixture(t), before = structuredClone(f.source), sourceBytes = await readFile(f.file);
    const selection = selectBackfillWork(null, f.options);
    await appendFile(f.file, jsonl([event("new-append")]));
    const read = await readBackfillChunk(f.file, selection);
    assert.deepEqual(read.events.map(event => event.id), ["startup", "prefix"]);
    assert.equal(read.cursor.offset, f.prefix.length);
    assert.equal(read.cursor.logBytes, f.prefix.length);
    assert.ok(read.bytesRead > f.prefix.length, "Startup/fence/anchor reads are charged in addition to payload");
    assert.ok(read.bytesRead <= TAIL_LIMITS.chunkBytes);
    assert.deepEqual(f.source, before);
    const checkpoint = stageBackfillProgress(selection, read, { events: [], diagnostics: {} });
    assert.equal(checkpoint.backfill.sources[0].phase, "visited");
    assert.equal(f.source.cursor.droppedBytes, f.prefix.length);
    assert.equal(selectBackfillWork(checkpoint, f.options).kind, "state-only");
    assert.deepEqual((await readFile(f.file)).subarray(0, sourceBytes.length), sourceBytes);
});

test("partial entry at fixed fence stays an explicit boundary gap, never extends the prefix", async t => {
    const f = await first(t, { cut: true });
    assert.equal(f.read.fenceTruncated, true);
    assert.ok(f.read.events.some(event => event.type === "wire.history_gap" && event.data.reason === "initial-window"));
    assert.equal(f.read.events.some(event => event.id === "cross-boundary"), false);
    assert.equal(f.read.cursor.partialBytes, 0);
    assert.equal(f.checkpoint.backfill.sources[0].boundaryGap, true);
    assert.equal(f.checkpoint.backfill.sources[0].phase, "visited");
});

test("one prefix context resumes across restart with charged rereads and no main-tail contamination", async t => {
    const f = await first(t, { large: true });
    assert.equal(f.checkpoint.backfill.activeSource, f.source.sessionId);
    assert.equal(f.checkpoint.backfill.sources[0].phase, "reading");
    assert.deepEqual(f.checkpoint.events.map(event => event.id), ["prefix"]);
    assert.ok(f.read.cursor.partialBytes > 0);
    assert.ok(f.read.bytesRead <= TAIL_LIMITS.chunkBytes);
    const persisted = JSON.parse(JSON.stringify(f.checkpoint));
    const selection = selectBackfillWork(persisted, f.options);
    assert.strictEqual(selection.context, persisted.events);
    const second = await readBackfillChunk(f.file, selection);
    const done = stageBackfillProgress(selection, second, { events: selection.context, diagnostics: selection.diagnostics });
    assert.equal(done.backfill.activeSource, null);
    assert.deepEqual(done.events, []);
    assert.equal(done.backfill.sources[0].offset, f.prefix.length);
    assert.equal(done.backfill.sources[0].phase, "visited");
    assert.equal(done.backfill.bytesRead, f.read.bytesRead + second.bytesRead);
    assert.ok(done.backfill.bytesRead > f.prefix.length);
    assert.ok(done.backfill.bytesRead <= 2 * TAIL_LIMITS.chunkBytes);
    assert.deepEqual(f.main.events.some(event => event.id === "future-tail"), false, "Main's first bounded read is independently limited");
    assert.equal(f.source.cursor.droppedBytes, f.prefix.length);
});

test("same-size fence and cursor-anchor rewrites invalidate without advancing progress", async t => {
    for (const which of ["fence", "cursor"]) {
        const f = await first(t, { large: true }), snapshot = structuredClone(f.checkpoint);
        const offset = which === "fence" ? f.prefix.length - 20 : f.checkpoint.cursor.offset - 20;
        const file = await open(f.file, "r+");
        try { await file.write(Buffer.from("y"), 0, 1, offset); } finally { await file.close(); }
        const selection = selectBackfillWork(f.checkpoint, f.options);
        await assert.rejects(readBackfillChunk(f.file, selection), error =>
            error.code === "BACKFILL_GENERATION_CHANGED" && error.bytesRead > 0 && error.bytesRead <= selection.maxBytes);
        assert.deepEqual(f.checkpoint, snapshot);
    }
});

test("rotation/truncation reject the old generation instead of reusing its prefix context", async t => {
    const f = await first(t, { large: true }), snapshot = structuredClone(f.checkpoint);
    await rename(f.file, path.join(f.root, "old-events.jsonl"));
    await writeFile(f.file, jsonl([event("new-startup", "session.start", { sessionId: f.source.sessionId, version: 1 })]));
    await assert.rejects(readBackfillChunk(f.file, selectBackfillWork(f.checkpoint, f.options)),
        error => error.code === "BACKFILL_GENERATION_CHANGED");
    assert.deepEqual(f.checkpoint, snapshot);
    const changed = structuredClone(f.source);
    changed.cursor.identity += "-new";
    const plan = selectBackfillWork(f.checkpoint, { ...f.options, sources: [changed] });
    assert.equal(plan.kind, "state-only");
    assert.equal(plan.clearContext, true);
    assert.equal(plan.progress.sources[0].phase, "invalidated");
    assert.deepEqual(stageBackfillReset(f.checkpoint, plan).events, []);
});

test("missing/unapproved sources are not backfill candidates and cannot allocate per-chat caches", async t => {
    const { options, source } = await fixture(t);
    const sources = Array.from({ length: 19 }, () => ({ ...source, sessionId: randomUUID(), error: "missing", errorCode: "ENOENT" }));
    const noFiles = selectBackfillWork(null, { ...options, sources });
    assert.equal(noFiles.kind, "state-only");
    assert.deepEqual(noFiles.progress.sources, []);
    const two = selectBackfillWork(null, { ...options, sources: [source, { ...source, sessionId: randomUUID() }] });
    assert.equal(two.kind, "read");
    assert.equal(two.sessionId, source.sessionId);
    assert.equal(two.progress.sources.length, 2);
    assert.equal(Object.hasOwn(two.progress.sources[1], "events"), false);
    assert.deepEqual(two.context, []);
});

test("deletion epoch suppresses existing fences and clears the only context before any reread", async t => {
    const f = await first(t, { large: true });
    const selection = selectBackfillWork(f.checkpoint, { ...f.options, deletionVersion: 1 });
    assert.equal(selection.kind, "state-only");
    assert.equal(selection.reason, "deletion-changed");
    assert.equal(selection.progress.sources[0].phase, "suppressed");
    const checkpoint = stageBackfillReset(f.checkpoint, selection);
    assert.deepEqual(checkpoint.events, []);
    assert.equal(checkpoint.backfill.activeSource, null);
    assert.equal(selectBackfillWork(checkpoint, { ...f.options, deletionVersion: 1 }).kind, "state-only");
    const summary = backfillProgressSummary(checkpoint);
    assert.deepEqual(summary, { pendingSources: 0, remainingBytes: 0, visitedSources: 0, blockedSources: 1 });
    assert.equal(JSON.stringify(summary).includes(f.source.sessionId), false);
});

test("config/window change creates a new explicit generation with empty context", async t => {
    const f = await first(t, { large: true }), fingerprint = hash("different-approved-window");
    const selection = selectBackfillWork(f.checkpoint, { ...f.options, fingerprint });
    assert.equal(selection.kind, "read");
    assert.equal(selection.clearContext, true);
    assert.equal(selection.cursor, undefined);
    assert.deepEqual(selection.context, []);
    assert.equal(selection.progress.fingerprint, fingerprint);
    assert.equal(selection.progress.sources[0].offset, 0);
    assert.equal(f.checkpoint.backfill.fingerprint, f.options.fingerprint);
});

test("checkpoint remains one canonical managed file with bounded closed progress metadata", async t => {
    const f = await first(t);
    assert.equal(backfillCheckpointPath("collector", f.checkpoint),
        path.join("collector", BACKFILL_DIRECTORY, `${f.source.sessionId}.json`));
    for (const mutate of [
        cp => { cp.backfill.version = 2; },
        cp => { cp.backfill.privateText = "not progress"; },
        cp => { cp.backfill.sources[0].events = ["not metadata"]; },
        cp => { cp.cursor.privateText = "not cursor"; },
        cp => { cp.diagnostics.error = "private prose"; },
        cp => { cp.events = [event("too-large", "user.message", { content: "x".repeat(TAIL_LIMITS.maxContextBytes + 1) })]; },
        cp => { cp.backfill.sources.push({ ...cp.backfill.sources[0] }); },
    ]) {
        const copy = structuredClone(f.checkpoint); mutate(copy);
        assert.throws(() => validateBackfillCheckpoint(copy), TypeError);
    }
    assert.throws(() => selectBackfillWork(null, { ...f.options, sources: Array(BACKFILL_LIMITS.sources + 1).fill(f.source) }), TypeError);
});

test("corrupt progress cannot claim a visited prefix or resume with inconsistent cursor state", async t => {
    const complete = await first(t), active = await first(t, { large: true });
    for (const [checkpoint, mutate] of [
        [complete.checkpoint, cp => { cp.backfill.sources[0].offset--; }],
        [complete.checkpoint, cp => { cp.cursor.partialBytes = 1; }],
        [active.checkpoint, cp => { cp.backfill.sources[0].anchor = null; }],
        [active.checkpoint, cp => {
            cp.backfill.sources[0].phase = "pending"; cp.backfill.activeSource = null; cp.events = [];
        }],
        [active.checkpoint, cp => { cp.cursor.skipping = true; cp.cursor.partialBytes = 1; }],
        [complete.checkpoint, cp => {
            cp.backfill.sources[0].phase = "pending"; cp.backfill.sources[0].offset = 0;
        }],
    ]) {
        const corrupt = structuredClone(checkpoint); mutate(corrupt);
        assert.throws(() => validateBackfillCheckpoint(corrupt), TypeError);
    }
});

test("serialized progress budget accepts its exact boundary and rejects the next byte", async t => {
    const { checkpoint } = await first(t), bounded = structuredClone(checkpoint);
    const template = bounded.backfill.sources[0];
    bounded.backfill.sources = Array.from({ length: 5000 }, (_, index) => ({
        ...template, sessionId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`, identity: "g",
    }));
    let remaining = BACKFILL_LIMITS.progressBytes - Buffer.byteLength(JSON.stringify(bounded.backfill));
    assert.ok(remaining > 0);
    for (const row of bounded.backfill.sources) {
        const extra = Math.min(remaining, 1023);
        row.identity += "g".repeat(extra);
        remaining -= extra;
    }
    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(bounded.backfill)), BACKFILL_LIMITS.progressBytes);
    assert.doesNotThrow(() => validateBackfillCheckpoint(bounded));
    const below = structuredClone(bounded);
    const reduced = below.backfill.sources.find(row => row.identity.length > 1);
    reduced.identity = reduced.identity.slice(0, -1);
    assert.equal(Buffer.byteLength(JSON.stringify(below.backfill)), BACKFILL_LIMITS.progressBytes - 1);
    assert.doesNotThrow(() => validateBackfillCheckpoint(below));
    const expanded = bounded.backfill.sources.find(row => row.identity.length < 1024);
    expanded.identity += "g";
    assert.equal(Buffer.byteLength(JSON.stringify(bounded.backfill)), BACKFILL_LIMITS.progressBytes + 1);
    assert.throws(() => validateBackfillCheckpoint(bounded), TypeError);
});

test("ordinary reader retains its original byte accounting and incomplete-entry policy", async t => {
    const { file, source } = await fixture(t), bytes = await readFile(file);
    const read = await readTail(file, source.sessionId);
    assert.equal(read.bytesRead, bytes.length);
    assert.equal(Object.hasOwn(read, "fenceAnchor"), false);
    assert.ok(read.events.some(event => event.id === "future-tail"));
    await appendFile(file, '{"id":"unfinished"');
    const partial = await readTail(file, source.sessionId, read.cursor);
    assert.equal(partial.cursor.offset, read.cursor.offset);
    assert.equal(partial.cursor.partialBytes, Buffer.byteLength('{"id":"unfinished"'));
});
