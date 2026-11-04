import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as collectorIo from "../lib/collector-io.mjs";

test("retained writes require the existing collector lock owned by this process", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "wire-collector-lock-"));
    let release;
    t.after(async () => {
        if (release) await release();
        await rm(directory, { recursive: true, force: true });
    });
    assert.equal(typeof collectorIo.assertCollectorLockOwned, "function");
    await assert.rejects(collectorIo.assertCollectorLockOwned(directory), { code: "COLLECTOR_LOCK_REQUIRED" });
    release = await collectorIo.acquireCollectorLock(directory);
    await collectorIo.assertCollectorLockOwned(directory);
    await assert.rejects(collectorIo.acquireCollectorLock(directory), /Another runtime owns/);
    await release();
    release = null;
    await assert.rejects(collectorIo.assertCollectorLockOwned(directory), { code: "COLLECTOR_LOCK_REQUIRED" });
});
