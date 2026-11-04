import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, readFile, readdir, writeFile, rm, link, unlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { acquireCollectorLock, atomicJson, hash } from "../lib/collector-io.mjs";
import { installCollectorIndexBarrier } from "../lib/collector-index.mjs";
import { BACKFILL_DIRECTORY, backfillCheckpointPath } from "../lib/collector-backfill.mjs";
import { loadBackfillCheckpoint, publishBackfillCheckpoint, BACKFILL_CHECKPOINT_BYTES } from "../lib/collector-backfill-store.mjs";

const check = () => {};
function checkpoint(source = randomUUID(), text = "PRIVATE_PREFIX_A") {
    return { schemaVersion: 1, backfillSource: source,
        cursor: { identity: "1:2:3:startup", offset: 100, logBytes: 200, backlogBytes: 100, partialBytes: 0,
            droppedBytes: 0, rotations: 0, malformedLines: 0, oversizedLines: 0, skipping: false, anchor: hash("cursor") },
        events: [{ id: "prompt", type: "user.message", timestamp: "2026-10-23T12:00:00Z", data: { content: text } }],
        diagnostics: {},
        backfill: { version: 1, fingerprint: hash("source/window"), deletionVersion: 0, activeSource: source,
            bytesRead: 100, sources: [{ sessionId: source, identity: "1:2:3:startup", endOffset: 200,
                offset: 100, anchor: hash("fence"), phase: "reading", boundaryGap: false }] } };
}
async function fixture(t, barrier = true) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "wire-backfill-store-")), root = path.join(dataDir, "collector");
    const release = await acquireCollectorLock(dataDir);
    t.after(async () => { await release(); await rm(dataDir, { recursive: true, force: true }); });
    if (barrier) await installCollectorIndexBarrier(root, check);
    return { dataDir, root, directory: path.join(root, BACKFILL_DIRECTORY) };
}

test("storage primitive requires the durable index2 barrier and publishes one canonical bounded cache", async t => {
    const { root, directory } = await fixture(t, false), next = checkpoint(), before = structuredClone(next);
    await assert.rejects(publishBackfillCheckpoint(root, null, next, { assertCurrent: check }), { code: "BACKFILL_INDEX_BARRIER_REQUIRED" });
    assert.equal(await loadBackfillCheckpoint(root), null);
    await installCollectorIndexBarrier(root, check);
    const index = await readFile(path.join(root, "index.json"));
    const saved = await publishBackfillCheckpoint(root, null, next, { assertCurrent: check });
    assert.deepEqual(saved.checkpoint, next);
    assert.equal(saved.hash, hash(await readFile(saved.file)));
    assert.deepEqual(await readdir(directory), [next.backfillSource + ".json"]);
    assert.deepEqual(next, before);
    assert.deepEqual(await readFile(path.join(root, "index.json")), index);
});

test("stale cache membership/hash cannot overwrite a concurrent checkpoint", async t => {
    const { root } = await fixture(t), original = checkpoint();
    const saved = await publishBackfillCheckpoint(root, null, original, { assertCurrent: check });
    const external = checkpoint(original.backfillSource, "PRIVATE_CONCURRENT_PREFIX");
    await atomicJson(saved.file, external);
    const bytes = await readFile(saved.file);
    await assert.rejects(publishBackfillCheckpoint(root, saved, original, { assertCurrent: check }), { code: "BACKFILL_CHECKPOINT_CHANGED" });
    await assert.rejects(publishBackfillCheckpoint(root, null, original, { assertCurrent: check }), { code: "BACKFILL_CHECKPOINT_CHANGED" });
    assert.deepEqual(await readFile(saved.file), bytes);
});

test("publication cannot roll back a stored deletion epoch and relative roots are rejected", async t => {
    const { root } = await fixture(t), cp = checkpoint();
    cp.backfill.deletionVersion = 2;
    const saved = await publishBackfillCheckpoint(root, null, cp, { assertCurrent: check });
    const stale = structuredClone(cp); stale.backfill.deletionVersion = 1;
    await assert.rejects(publishBackfillCheckpoint(root, saved, stale, { assertCurrent: check }), { code: "BACKFILL_CHECKPOINT_CHANGED" });
    assert.equal((await loadBackfillCheckpoint(root)).hash, saved.hash);
    await assert.rejects(loadBackfillCheckpoint("collector"), TypeError);
});

test("source switching retires and removes the old cache before publishing the next canonical source", async t => {
    const { root, directory } = await fixture(t), a = checkpoint(), b = checkpoint(randomUUID(), "PRIVATE_PREFIX_B");
    const first = await publishBackfillCheckpoint(root, null, a, { assertCurrent: check });
    const rename = fs.rename, unlink = fs.unlink, observations = [];
    t.mock.method(fs, "rename", async (from, to) => {
        observations.push({ from, to, content: JSON.parse(await readFile(from, "utf8")) });
        await rename(from, to);
        assert.equal((await readdir(directory)).filter(name => name.endsWith(".json")).length, 1);
    });
    t.mock.method(fs, "unlink", async file => {
        if (file === first.file) {
            const retired = JSON.parse(await readFile(file));
            assert.deepEqual(retired.events, []);
            assert.equal(retired.backfill.activeSource, null);
            assert.equal(retired.backfillSource + ".json", path.basename(file));
        }
        await unlink(file);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await publishBackfillCheckpoint(root, first, b, { assertCurrent: check });
    assert.equal(observations.length, 2);
    assert.deepEqual(observations[0].content.events, []);
    assert.equal(observations[0].content.backfill.activeSource, null);
    assert.equal(observations[0].content.backfill.sources[0].phase, "invalidated");
    assert.equal(observations[1].to, backfillCheckpointPath(root, b));
    assert.deepEqual(observations[1].content, b);
    assert.deepEqual(result.checkpoint, b);
    assert.deepEqual(await readdir(directory), [b.backfillSource + ".json"]);
});

for (const point of ["before-retire", "after-retire", "before-unlink", "after-unlink", "before-publish", "after-publish"]) {
    test(`source-switch ${point} interruption preserves inventory-safe canonical identities`, async t => {
        const { root, directory } = await fixture(t), a = checkpoint(), b = checkpoint(randomUUID(), "PRIVATE_PREFIX_B");
        const first = await publishBackfillCheckpoint(root, null, a, { assertCurrent: check });
        const rename = fs.rename, unlink = fs.unlink;
        const interrupt = step => {
            if (point === step) throw Object.assign(new Error("SYNTHETIC_SWITCH_INTERRUPTION"), { code: "EIO" });
        };
        t.mock.method(fs, "rename", async (from, to) => {
            const step = to === first.file ? "retire" : "publish";
            interrupt("before-" + step);
            await rename(from, to);
            interrupt("after-" + step);
        });
        t.mock.method(fs, "unlink", async file => {
            if (file === first.file) interrupt("before-unlink");
            await unlink(file);
            if (file === first.file) interrupt("after-unlink");
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        await assert.rejects(publishBackfillCheckpoint(root, first, b, { assertCurrent: check }), { code: "EIO" });
        t.mock.restoreAll(); syncBuiltinESMExports();
        const restarted = await loadBackfillCheckpoint(root);
        const names = await readdir(directory);
        assert.ok(names.length <= 1);
        if (["after-unlink", "before-publish"].includes(point)) assert.equal(restarted, null);
        else {
            assert.equal(restarted.checkpoint.backfillSource + ".json", path.basename(restarted.file));
            if (["after-retire", "before-unlink"].includes(point)) {
                assert.deepEqual(restarted.checkpoint.events, []);
                assert.equal(restarted.checkpoint.backfill.activeSource, null);
                assert.equal(restarted.checkpoint.backfill.sources[0].phase, "invalidated");
                assert.doesNotMatch(await readFile(restarted.file, "utf8"), /PRIVATE_PREFIX_/);
            } else assert.deepEqual(restarted.checkpoint, point === "before-retire" ? a : b);
        }
        const completed = await publishBackfillCheckpoint(root, restarted, b, { assertCurrent: check });
        assert.deepEqual(completed.checkpoint, b);
        assert.deepEqual(await readdir(directory), [b.backfillSource + ".json"]);
    });

}

test("even empty inactive metadata cannot claim a different canonical source filename", async t => {
    const { root } = await fixture(t), cp = checkpoint();
    const saved = await publishBackfillCheckpoint(root, null, cp, { assertCurrent: check });
    const wrong = structuredClone(cp);
    wrong.events = [];
    wrong.backfill.activeSource = null;
    wrong.backfill.sources[0].phase = "invalidated";
    wrong.backfillSource = randomUUID();
    await atomicJson(saved.file, wrong);
    await assert.rejects(loadBackfillCheckpoint(root), { code: "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" });
});

test("post-fsync revocation rejects a replacement and cleans only that failed temporary write", async t => {
    const { root, directory } = await fixture(t), a = checkpoint();
    const first = await publishBackfillCheckpoint(root, null, a, { assertCurrent: check }), prior = await readFile(first.file);
    const replacement = checkpoint(a.backfillSource, "PRIVATE_REPLACEMENT");
    let live = true;
    const open = fs.open;
    t.mock.method(fs, "open", async (file, ...args) => {
        const handle = await open(file, ...args);
        if (String(file).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); live = false; };
        }
        return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(publishBackfillCheckpoint(root, first, replacement, { assertCurrent: () => live }),
        { code: "BACKFILL_PUBLICATION_REVOKED" });
    assert.deepEqual(await readFile(first.file), prior);
    assert.deepEqual(await readdir(directory), [a.backfillSource + ".json"]);
});

test("unrecognized staging is neither adopted nor ignored by cache loading or publication", async t => {
    const { root, directory } = await fixture(t), a = checkpoint();
    const first = await publishBackfillCheckpoint(root, null, a, { assertCurrent: check });
    const staged = first.file + "." + randomUUID() + ".tmp";
    await writeFile(staged, JSON.stringify(a));
    const stagedBytes = await readFile(staged), committedBytes = await readFile(first.file);
    await assert.rejects(loadBackfillCheckpoint(root), { code: "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" });
    await assert.rejects(publishBackfillCheckpoint(root, first, a, { assertCurrent: check }), { code: "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" });
    assert.deepEqual(await readFile(staged), stagedBytes);
    assert.deepEqual(await readFile(first.file), committedBytes);
    assert.equal((await readdir(directory)).length, 2);
});

test("oversized and hard-linked cache files fail closed before a payload is selected", async t => {
    const { root, directory, dataDir } = await fixture(t), cp = checkpoint(), file = backfillCheckpointPath(root, cp);
    await mkdir(directory, { recursive: true });
    const encoded = Buffer.from(JSON.stringify(cp));
    for (const size of [BACKFILL_CHECKPOINT_BYTES - 1, BACKFILL_CHECKPOINT_BYTES]) {
        await writeFile(file, Buffer.concat([Buffer.alloc(size - encoded.length, 32), encoded]));
        assert.deepEqual((await loadBackfillCheckpoint(root)).checkpoint, cp);
    }
    await writeFile(file, Buffer.alloc(BACKFILL_CHECKPOINT_BYTES + 1));
    await assert.rejects(loadBackfillCheckpoint(root), { code: "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" });
    await unlink(file);
    const external = path.join(dataDir, "invented-linked.json");
    await writeFile(external, JSON.stringify(cp));
    await link(external, file);
    await assert.rejects(loadBackfillCheckpoint(root), /linked/i);
    assert.deepEqual(JSON.parse(await readFile(external)), cp);
});

test("invalid UTF-8 in a retained cache is rejected rather than decoded with replacements", async t => {
    const { root } = await fixture(t), cp = checkpoint();
    const saved = await publishBackfillCheckpoint(root, null, cp, { assertCurrent: check });
    const bytes = await readFile(saved.file), index = bytes.indexOf("PRIVATE_PREFIX_A");
    assert.ok(index > 0);
    bytes[index] = 0xff;
    await writeFile(saved.file, bytes);
    await assert.rejects(loadBackfillCheckpoint(root), { code: "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" });
    await writeFile(saved.file, JSON.stringify(cp).slice(0, -1));
    await assert.rejects(loadBackfillCheckpoint(root), error =>
        error.code === "BACKFILL_CHECKPOINT_CLEANUP_REQUIRED" && !error.message.includes("PRIVATE_PREFIX"));
});

test("publisher snapshots its plan and rejects non-synchronous acquisition checks", async t => {
    const { root } = await fixture(t), cp = checkpoint(), expected = structuredClone(cp);
    let calls = 0;
    const saved = await publishBackfillCheckpoint(root, null, cp, { assertCurrent() {
        if (++calls === 2) cp.events[0].data.content = "CHANGED_AFTER_PLAN";
    } });
    assert.deepEqual(saved.checkpoint, expected);
    for (const assertCurrent of [() => false, () => ({}), () => Promise.resolve(true)]) {
        await assert.rejects(publishBackfillCheckpoint(root, saved, expected, { assertCurrent }), { code: "BACKFILL_PUBLICATION_REVOKED" });
    }
});
