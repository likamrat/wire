import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, moveCard, updateBoardState } from "../lib/store.mjs";
import { collectedReportSource } from "./collected-report-fixture.mjs";
import { cachedAssessmentModel } from "../lib/assessment-read-model.mjs";

test("a prepared All report survives a genuine same-chat GitHub append without expanding its reviewed population", async t => {
    const app = await collectedReportSource(t), controller = createExportController(app.context);
    const before = await loadBoardState(app.context);
    assert.equal(before.evidence.length, 1);
    const preview = await controller.preview("collected-report-owner", undefined,
        { promptMode: "none", formats: ["html", "json"] }, { kind: "all", revision: before.revision });
    assert.equal(preview.collectedSourceFrozen, true);
    assert.equal(JSON.stringify(preview).includes(before.evidenceFile), false);
    const reviewed = await controller.review("collected-report-owner", preview.previewId, true);
    await app.append();
    const after = await loadBoardState(app.context);
    assert.equal(after.evidence.length, 2);
    const saved = await controller.confirm("collected-report-owner", preview.previewId, true);
    assert.equal(saved.bundle.selectionScope.requestGroups, 1);
    for (const [name, contents] of Object.entries(reviewed.files)) {
        assert.deepEqual(await readFile(saved.bundle.files[name]), Buffer.from(contents));
    }
    const current = await loadBoardState(app.context);
    assert.equal(cachedAssessmentModel(current).catalog.length, 2, "Pinned validation cannot poison the current source model cache.");
    const next = await controller.preview("collected-report-owner", undefined,
        { promptMode: "none", formats: ["json"] }, { kind: "all", revision: current.revision });
    assert.equal(next.snapshot.selectionScope.requestGroups, 2);
});

for (const change of ["consent", "deletion", "source", "workflow", "expired", "cancelled", "missing-root", "corrupt-root"]) {
    test(`a pinned collected report still refuses ${change} before writing`, async t => {
        const app = await collectedReportSource(t, { recordedAnswers: true });
        const controller = createExportController(app.context, () => assert.fail("An invalidated report must not enter the writer."));
        const before = await loadBoardState(app.context), owner = "protected-collected-owner";
        const preview = await controller.preview(owner, undefined,
            { promptMode: "original", recordedContext: true, formats: ["json"] }, { kind: "all", revision: before.revision });
        await controller.review(owner, preview.previewId, true);
        await app.append();
        if (change === "consent") await updateBoardState(app.context, state => {
            state.personalEvaluation.consent = { ...state.personalEvaluation.consent,
                state: "revoked", revision: 2, categories: [], revokedAt: new Date().toISOString() };
        });
        if (change === "deletion") await updateBoardState(app.context, state => {
            state.deletion = { schemaVersion: 1, epoch: 1, identities: [], events: [], contextCalls: [] };
        });
        if (change === "source") await app.collector.configure({
            appDbPath: path.join(app.root, "data.db"), sessionRoot: path.join(app.root, "session-state"),
            approved: true, enabled: true, windowDays: 7, pollSeconds: 5,
        });
        if (change === "workflow") await moveCard(app.context, before.evidence[0].scenarioId, "reviewing");
        if (change === "expired") {
            const now = Date.now();
            t.mock.method(Date, "now", () => now + 600001);
        }
        if (change === "cancelled") controller.cancel(owner, preview.previewId);
        const root = path.join(app.context.dataDir, "private-evidence", before.evidenceFile);
        if (change === "missing-root") await unlink(root);
        if (change === "corrupt-root") await writeFile(root, "damaged disposable original source");
        await assert.rejects(controller.confirm(owner, preview.previewId, true), error => {
            if (change === "missing-root") assert.equal(error.code, "ENOENT");
            else if (change === "corrupt-root") assert.equal(error.code, "EVIDENCE_SNAPSHOT_INTEGRITY");
            else assert.match(error.message, ["consent", "deletion", "source"].includes(change)
                ? /permission or deletion authority changed/ : change === "workflow"
                    ? /Selected evidence changed/ : change === "expired" ? /expired/ : /Preview not found/);
            return true;
        });
        assert.equal((await loadBoardState(app.context)).exports.length, 0);
    });
}

test("a prepared report keeps its original prompt and recorded reply copies when the same GitHub chat grows", async t => {
    const app = await collectedReportSource(t, { recordedAnswers: true }), controller = createExportController(app.context);
    const before = await loadBoardState(app.context);
    const preview = await controller.preview("collected-context-owner", undefined,
        { promptMode: "original", recordedContext: true, formats: ["html", "json"] }, { kind: "all", revision: before.revision });
    assert.ok(preview.contextReview.some(copy => copy.text?.includes("Recorded reply to Original reviewed request.")));
    await app.append();
    const reviewed = await controller.review("collected-context-owner", preview.previewId, true);
    assert.deepEqual(reviewed.snapshot, preview.snapshot);
    const saved = await controller.confirm("collected-context-owner", preview.previewId, true);
    assert.equal(saved.bundle.selectionScope.requestGroups, 1);
    for (const [name, contents] of Object.entries(reviewed.files)) {
        assert.deepEqual(await readFile(saved.bundle.files[name]), Buffer.from(contents));
    }
});
