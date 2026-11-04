import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
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

test("unknown and foreign writer namespaces are never reclaimed by a local PID probe", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "wire-foreign-lock-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "collector.lock"), release = await collectorIo.acquireCollectorLock(directory);
    const owned = JSON.parse(await readFile(file, "utf8"));
    await release();
    for (const [previous, code] of [
        [{ pid: process.pid, token: randomUUID() }, "COLLECTOR_OWNER_UNQUALIFIED"],
        [{ ...owned, host: { ...owned.host, machine: "a".repeat(64) } }, "COLLECTOR_OWNER_FOREIGN"],
    ]) {
        const bytes = JSON.stringify(previous);
        await writeFile(file, bytes);
        await assert.rejects(collectorIo.acquireCollectorLock(directory), { code, status: 409 });
        assert.equal(await readFile(file, "utf8"), bytes);
    }
});

test("an exited same-host owner can still be recovered without changing namespace", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "wire-exited-lock-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const module = new URL("../lib/collector-io.mjs", import.meta.url).href;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
        `import { acquireCollectorLock } from ${JSON.stringify(module)}; await acquireCollectorLock(process.argv[1]);`, directory]);
    let release = await collectorIo.acquireCollectorLock(directory);
    await collectorIo.assertCollectorLockOwned(directory);
    const file = path.join(directory, "collector.lock"), owned = JSON.parse(await readFile(file, "utf8"));
    await release();
    if (process.platform === "linux") {
        await writeFile(file, JSON.stringify({ ...owned, host: { ...owned.host, bootId: randomUUID() } }));
        release = await collectorIo.acquireCollectorLock(directory);
        await collectorIo.assertCollectorLockOwned(directory);
        await release();
    }
});
