import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { BOARD_ID } from "../lib/evidence.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { assessmentBasis } from "../lib/assessment-read-model.mjs";
import { privateFixture } from "./helpers.mjs";
import { inventedSource, seedRetainedReply } from "./search-corpus-fixture.mjs";
import { createCorpusSources } from "../lib/search-corpus-sources.mjs";

test("read-only missing and migration-required state leave filesystem unchanged; default reads still initialize and migrate", async t => {
    const { root } = await privateFixture(t);
    const missing = { dataDir: path.join(root, "missing") };
    await assert.rejects(loadBoardState(missing, { readOnly: true }), { status: 404 });
    await assert.rejects(exclusiveBoard(missing, () => {}, { readOnly: true }), { status: 404 });
    await assert.rejects(fs.readdir(missing.dataDir), { code: "ENOENT" });
    assert.equal((await loadBoardState(missing)).stateVersion, 2);
    assert.ok((await fs.readdir(missing.dataDir)).includes("exports"));

    const legacy = { dataDir: path.join(root, "legacy") };
    await fs.mkdir(legacy.dataDir);
    const file = path.join(legacy.dataDir, `${BOARD_ID}.state.json`);
    const before = JSON.stringify({ boardId: BOARD_ID, cards: {}, exports: [] });
    await fs.writeFile(file, before);
    await assert.rejects(loadBoardState(legacy, { readOnly: true }), { status: 422 });
    await assert.rejects(exclusiveBoard(legacy, () => {}, { readOnly: true }), { status: 422 });
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await fs.readdir(legacy.dataDir), [`${BOARD_ID}.state.json`]);
    assert.equal((await loadBoardState(legacy)).stateVersion, 2);
    assert.ok((await fs.readdir(legacy.dataDir)).includes("exports"));
});

test("read-only exclusiveBoard rejects its save callback and does not recreate the exports directory", async t => {
    const { context } = await privateFixture(t);
    const file = path.join(context.dataDir, `${BOARD_ID}.state.json`), before = await fs.readFile(file);
    await fs.rmdir(path.join(context.dataDir, "exports"));
    const options = { readOnly: true };
    await assert.rejects(exclusiveBoard(context, async (state, save) => {
        options.readOnly = false;
        state.continuation = "MUST_NOT_BE_SAVED";
        await save(state);
    }, options), { status: 403 });
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(fs.readdir(path.join(context.dataDir, "exports")), { code: "ENOENT" });
    await loadBoardState(context, { readOnly: true });
    await assert.rejects(fs.readdir(path.join(context.dataDir, "exports")), { code: "ENOENT" });
    await loadBoardState(context);
    assert.deepEqual(await fs.readdir(path.join(context.dataDir, "exports")), []);
});

test("internal readOnly applies to assessment reads and denies mutations without adding a public request field", async t => {
    const { root } = await privateFixture(t), context = { dataDir: path.join(root, "no-assessment-state") };
    const options = { readOnly: true, source: inventedSource };
    await assert.rejects(executeAssessmentAction(context, "fixture", "get_assessment_consent", { schemaVersion: 1 }, options), { status: 404 });
    await assert.rejects(executeAssessmentAction(context, "fixture", "get_mutation_status", {
        schemaVersion: 1, mutationRef: `mutation-${"2".repeat(32)}`,
    }, options), { status: 404 });
    await assert.rejects(executeAssessmentAction(context, "fixture", "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${"2".repeat(32)}`, expectedSourceRevision: 0,
        expectedConsentRevision: 0, policyVersion: 1, enabled: true, categories: ["answer"],
        sourceConfigRef: inventedSource().sourceConfigRef, sourceConfigRevision: 1, confirmed: true,
    }, options), { status: 403 });
    await assert.rejects(executeAssessmentAction(context, "fixture", "get_assessment_consent", {
        schemaVersion: 1, readOnly: true,
    }), { status: 422 });
    await assert.rejects(fs.readdir(context.dataDir), { code: "ENOENT" });
});

test("removal after the real retained payload read never recreates board state or exports", async t => {
    const { context } = await privateFixture(t), reply = await seedRetainedReply(context);
    const state = await loadBoardState(context), capture = state.personalEvaluation.captures[0];
    const stateFile = path.join(context.dataDir, `${BOARD_ID}.state.json`);
    const originalRead = fs.readFile;
    const options = { readOnly: true, source: inventedSource };
    let removed = false;
    const mocked = t.mock.method(fs, "readFile", async (file, ...args) => {
        const bytes = await originalRead(file, ...args);
        if (path.resolve(String(file)) === reply.payloadFile) {
            options.readOnly = false;
            await fs.unlink(stateFile);
            await fs.rmdir(path.join(context.dataDir, "exports"));
            removed = true;
        }
        return bytes;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(executeAssessmentAction(context, "fixture", "get_interaction_evidence", {
            schemaVersion: 1, interactionRef: capture.observation.interactionRef,
            observationRef: capture.observation.observationRef, expectedBasis: assessmentBasis(state),
        }, options), { status: 404 });
    } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
    }
    assert.equal(removed, true, "The controlled fault must run after the actual retained-payload read");
    await assert.rejects(fs.readFile(stateFile), { code: "ENOENT" });
    await assert.rejects(fs.readdir(path.join(context.dataDir, "exports")), { code: "ENOENT" });
});

test("in-place source replacement during a retained payload read cannot rewrite the construction epoch", async t => {
    const { context } = await privateFixture(t), reply = await seedRetainedReply(context);
    const source = inventedSource(), sources = createCorpusSources(context, { source: () => source });
    const originalRead = fs.readFile;
    let replaced = false;
    const mocked = t.mock.method(fs, "readFile", async (file, ...args) => {
        const bytes = await originalRead(file, ...args);
        if (path.resolve(String(file)) === reply.payloadFile) {
            source.sourceConfigRevision++;
            replaced = true;
        }
        return bytes;
    });
    syncBuiltinESMExports();
    let frame;
    try { frame = await sources.scan(); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(replaced, true);
    await assert.rejects(sources.current(frame, () => { assert.fail("A replaced source cannot publish the old reply"); }), /stale/);
});
