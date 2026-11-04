import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";

test("staging never commits a pointer to mismatched existing snapshot bytes", async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "wire-snapshot-integrity-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const session = { dataDir };
    await loadBoardState(session);
    const built = { records: [], importCoverage: {} };
    const name = createHash("sha256").update(JSON.stringify(built)).digest("hex") + ".json";
    await mkdir(path.join(dataDir, "private-evidence"));
    await writeFile(path.join(dataDir, "private-evidence", name), "incomplete snapshot");
    await assert.rejects(replaceEvidence(session, () => built), { code: "EVIDENCE_SNAPSHOT_INTEGRITY" });
    const state = await loadBoardState(session, { readOnly: true });
    assert.equal(state.evidenceFile, undefined);
    assert.equal(state.revision, 0);
});

test("staging can reuse the exact committed snapshot bytes", async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "wire-snapshot-reuse-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const session = { dataDir };
    const built = { records: [], importCoverage: {} };
    await replaceEvidence(session, () => built);
    const first = await loadBoardState(session, { readOnly: true });
    await replaceEvidence(session, () => built);
    const second = await loadBoardState(session, { readOnly: true });
    assert.equal(second.evidenceFile, first.evidenceFile);
    assert.deepEqual(second.evidence, []);
});
