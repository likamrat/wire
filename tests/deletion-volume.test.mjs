import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateFixture, fixture } from "./helpers.mjs";
import { replaceEvidence, loadBoardState } from "../lib/store.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

const scope = { scope: "all", timeContext: { timeZone: "UTC", locale: "en-US" } };

test("over 512 MiB of retained copies previews and cancels without writes, deduplicates accurately, and purges with bounded heap", { timeout: 180000 }, async t => {
    const record = fixture("large-copy");
    const { context } = await privateFixture(t, [record]);
    const padding = "synthetic roster padding ".repeat(Math.ceil(4 * 1024 ** 2 / 25));
    for (let version = 0; version < 132; version++) await replaceEvidence(context, () => ({
        records: [record], importCoverage: { counts: {}, roster: [], padding, version },
    }));
    const directory = path.join(context.dataDir, "private-evidence");
    const names = await readdir(directory);
    let bytes = 0;
    for (const name of names) bytes += (await stat(path.join(directory, name))).size;
    assert.ok(bytes > 512 * 1024 ** 2, `Exercise the failed production threshold, not a small proxy: ${bytes} bytes`);
    const stateFile = path.join(context.dataDir, `${BOARD_ID}.state.json`);
    const before = await readFile(stateFile);
    const controller = createDeletionController(context);
    const first = await controller.preview("panel", scope);
    assert.equal(first.counts.records, 1);
    assert.equal(first.counts.toolCalls, 1);
    assert.equal(first.counts.retainedOnly, 0);
    controller.cancel("panel", first.operationId);
    assert.deepEqual(await readFile(stateFile), before);
    assert.deepEqual(await readdir(directory), names);
    for (const name of names) assert.equal(createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex") + ".json", name);
    const preview = await controller.preview("panel", scope);
    assert.equal(preview.counts.records, 1);
    const result = await controller.confirm("panel", { operationId: preview.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    assert.deepEqual((await loadBoardState(context)).evidence, []);
    const after = await readdir(directory);
    assert.ok(names.every(name => !after.includes(name)), "All original private-content copies were removed");
    for (const name of after) assert.deepEqual(JSON.parse(await readFile(path.join(directory, name))).records, []);
    t.diagnostic(`Synthetic retained input ${bytes} bytes in ${names.length} snapshots; one canonical record deleted. Run also under --max-old-space-size=192.`);
});

test("oversized individual inputs fail explicitly without changing any collected state", async t => {
    const { context } = await privateFixture(t);
    await replaceEvidence(context, records => ({ records, importCoverage: { padding: "x".repeat(17 * 1024 ** 2) } }));
    const before = await readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`));
    await assert.rejects(createDeletionController(context).preview("panel", scope), error => error.status === 413 && /per-file/.test(error.message));
    assert.deepEqual(await readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`)), before);
    assert.equal((await loadBoardState(context)).evidence.length, 1);
});

test("unique-content and compact-context budgets fail closed instead of accumulating an unbounded scan", { timeout: 60000 }, async t => {
    const unique = await privateFixture(t);
    const text = "x".repeat(512 * 1024);
    for (let version = 0; version < 129; version++) {
        const record = fixture(`unique-${version}`);
        record.userPrompt.text = text;
        await replaceEvidence(unique.context, () => ({ records: [record] }));
    }
    const stateFile = path.join(unique.context.dataDir, `${BOARD_ID}.state.json`);
    const before = await readFile(stateFile);
    await assert.rejects(createDeletionController(unique.context).preview("panel", scope), error => error.status === 413 && /64 MiB.*memory budget/.test(error.message));
    assert.deepEqual(await readFile(stateFile), before);

    const contexts = await privateFixture(t);
    const directory = path.join(contexts.context.dataDir, "collector", "c".repeat(64));
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 5; index++) await writeFile(path.join(directory, `source-${index}.json`), JSON.stringify({
        schemaVersion: 1, events: [{ id: "e".repeat(8 * 1024 ** 2), type: "user.message", timestamp: "2026-09-30T12:00:00Z", data: { content: "SYNTHETIC" } }],
    }));
    await assert.rejects(createDeletionController(contexts.context).preview("panel", scope), error => error.status === 413 && /32 MiB.*memory budget/.test(error.message));
    assert.equal((await loadBoardState(contexts.context)).evidence.length, 1);
});
