import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBoardState, mergeEvidenceWithState, moveCard, updateBoardState } from "../lib/store.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { privateFixture, fixture } from "./helpers.mjs";

test("private evidence survives a new context without session workspace dependence", async (t) => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    await moveCard(context, "test-scenario", "reviewing");
    const reopened = await loadBoardState({ dataDir: context.dataDir });
    assert.equal(reopened.pseudonymKey, before.pseudonymKey);
    assert.equal(mergeEvidenceWithState(reopened)[0].userPrompt.text, fixture().userPrompt.text);
    assert.equal(reopened.cards["test-scenario"].workflowState, "reviewing");
    assert.equal(reopened.cards["test-scenario"].history.length, 2);
});

test("serialized review writes preserve every update and recover after a failed write", async (t) => {
    const { context } = await privateFixture(t);
    await assert.rejects(updateBoardState(context, () => { throw new Error("synthetic write error"); }), /synthetic write error/);
    await Promise.all(Array.from({ length: 12 }, (_, i) => moveCard(context, "test-scenario", i % 2 ? "reviewing" : "captured")));
    const state = await loadBoardState(context);
    assert.equal(state.revision, 13);
    assert.equal(state.cards["test-scenario"].history.length, 13);
});

test("no-prompts scan counts findings without retaining private prose, args or identifiers", async () => {
    const bundle = await buildSanitizedBundle([fixture()], "a".repeat(64), { promptMode: "none", formats: ["html", "json", "markdown"] });
    const output = JSON.stringify(bundle.files);
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE|SYNTHETIC_LITERAL|email@example|Example Person|test-session|test-project/);
    assert.ok(bundle.privacy.categories.email_identifiers > 0);
    assert.equal(bundle.privacy.allSelectedFieldsScanned, true);
    assert.equal(bundle.privacy.reviewerConfirmed, false);
    assert.equal(bundle.privacy.reviewerIdentityVerified, false);
    const partial = await buildSanitizedBundle([{ ...fixture(), userPrompt: { status: "partial", text: "truncated" } }], "a".repeat(64));
    assert.equal(partial.snapshot.promptCoverage.partial, 1);
    assert.equal(partial.records[0].prompts[0].status, "partial");
});

test("synthetic disclosure review is separate, panel-bound, immutable and exact-byte", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context);
    const draft = await controller.preview("synthetic-panel", ["test-scenario"]);
    await assert.rejects(controller.confirm("synthetic-panel", draft.previewId, true), /disclosure review/);
    await assert.rejects(controller.review("another-panel", draft.previewId, true), /not found/);
    await assert.rejects(controller.review("synthetic-panel", draft.previewId, false), /attestation/);
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
    const reviewed = await controller.review("synthetic-panel", draft.previewId, true);
    const result = await controller.confirm("synthetic-panel", draft.previewId, true);
    for (const [name, bytes] of Object.entries(reviewed.files)) {
        assert.equal(await readFile(result.bundle.files[name], "utf8"), bytes);
    }
    assert.equal(result.state.cards["test-scenario"].workflowState, "ready_to_export");
    await assert.rejects(controller.confirm("synthetic-panel", draft.previewId, true), /not found/);
});

test("review changes invalidate a previously reviewed export", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context);
    const draft = await controller.preview("synthetic-panel");
    await controller.review("synthetic-panel", draft.previewId, true);
    await moveCard(context, "test-scenario", "reviewing");
    await assert.rejects(controller.confirm("synthetic-panel", draft.previewId, true), /changed|expired/);
    assert.deepEqual(await readdir(path.join(context.dataDir, "exports")), []);
});

test("failed bundle write leaves ready cards and does not report a successful export", async (t) => {
    const { context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context, async () => { throw new Error("synthetic disk full"); });
    const draft = await controller.preview("synthetic-panel");
    await controller.review("synthetic-panel", draft.previewId, true);
    await assert.rejects(controller.confirm("synthetic-panel", draft.previewId, true), /synthetic disk full/);
    const state = await loadBoardState(context);
    assert.equal(state.cards["test-scenario"].workflowState, "ready_to_export");
    assert.equal(state.exports.length, 0);
});

test("corrupted private evidence cannot silently fall back to an empty collection", async (t) => {
    const { context } = await privateFixture(t);
    const state = await loadBoardState(context);
    await writeFile(path.join(context.dataDir, "private-evidence", state.evidenceFile), '{"records":[]}');
    await assert.rejects(loadBoardState(context), /integrity check failed/);
});
