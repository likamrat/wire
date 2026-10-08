import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { createExportController } from "../lib/export.mjs";

test("synthetic: optional personal feedback is durable, revisioned, owner-bound and never rewrites source outcomes", async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context), model = buildAssessmentModel(before);
    const interactionRef = model.overview.interactionRefs[0];
    const input = {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef,
        expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict: "fail", withdraw: false,
    };
    const result = await executeAssessmentAction(context, "synthetic-owner", "set_personal_assessment", input);
    assert.equal(result.phase, "complete");
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.personalEvaluation.feedback.records.length, 1);
    const view = buildAssessmentModel(after).details.get(interactionRef);
    assert.equal(view.assessments.find(a => a.origin === "user-personal").verdict, "fail");
    assert.equal(view.assessments.find(a => a.dimension === "accuracy" && a.origin === "automatic-local").verdict, "unassessed");
    assert.deepEqual(await executeAssessmentAction(context, "synthetic-owner", "set_personal_assessment", input), result);
    assert.equal((await loadBoardState(context)).revision, after.revision);
    assert.equal(after.evidenceRevision, before.evidenceRevision, "Feedback changes its own generation, not source evidence");
    await assert.rejects(executeAssessmentAction(context, "another-owner", "set_personal_assessment", input), error => error.status === 403);
    await assert.rejects(executeAssessmentAction(context, "synthetic-owner", "set_personal_assessment", { ...input, verdict: "pass" }), error => error.status === 409);
});

test("synthetic: a legacy board's first artifact write preserves the pre-write evidence generation", async t => {
    const { context } = await privateFixture(t);
    const initial = await loadBoardState(context), file = path.join(context.dataDir, `${initial.boardId}.state.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.evidenceRevision;
    await writeFile(file, JSON.stringify(legacy));
    const controller = createExportController(context);
    const preview = await controller.preview("owner", undefined, { promptMode: "none", formats: ["json"] }, { kind: "all", revision: legacy.revision });
    await controller.review("owner", preview.previewId, true);
    await controller.confirm("owner", preview.previewId, true);
    const after = await loadBoardState(context);
    assert.equal(after.revision, legacy.revision + 1);
    assert.equal(after.evidenceRevision, legacy.revision);
    assert.equal(buildAssessmentModel(after).basis.sourceRevision, legacy.revision);
});

test("synthetic: feedback on another interaction does not discard an unchanged personal verdict", async t => {
    const { context } = await privateFixture(t, [fixture("first"), fixture("second")]);
    async function assess(index, verdict) {
        const state = await loadBoardState(context), model = buildAssessmentModel(state);
        await executeAssessmentAction(context, "owner", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: model.catalog[index].interactionRef,
            expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict, withdraw: false,
        });
    }
    await assess(0, "fail"); await assess(1, "pass");
    const model = buildAssessmentModel(await loadBoardState(context));
    assert.deepEqual([...model.details.values()].map(view => view.assessments.find(a => a.origin === "user-personal")?.verdict), ["fail", "pass"]);
    await replaceEvidence(context, records => {
        const next = structuredClone(records);
        next[0].toolCalls[0].completionEventId = "new-synthetic-completion";
        return { records: next };
    });
    const changed = buildAssessmentModel(await loadBoardState(context));
    assert.deepEqual([...changed.details.values()].map(view => view.assessments.find(a => a.origin === "user-personal")?.verdict), [undefined, "pass"]);
});
