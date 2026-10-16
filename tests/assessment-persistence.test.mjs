import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { createExportController } from "../lib/export.mjs";

test("historical personal feedback remains durable and owner-bound without a current writer", async t => {
    const { context, personalMutationRef, receiptToken } = await retirementFixture(t);
    const before = await loadBoardState(context), model = buildAssessmentModel(before);
    const interactionRef = model.overview.interactionRefs[0];
    const input = { schemaVersion: 1, mutationRef: personalMutationRef };
    const result = await executeAssessmentAction(context, "original-panel", "get_mutation_status", input);
    assert.deepEqual(result, before.personalEvaluation.mutations[personalMutationRef].receipt);
    await assert.rejects(executeAssessmentAction(context, "original-panel", "set_personal_assessment", {}),
        error => error.code === "PERSONAL_FEEDBACK_RETIRED");
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.personalEvaluation.feedback.records.length, 1);
    const view = buildAssessmentModel(after).details.get(interactionRef);
    assert.deepEqual(view.assessments, [], "Stored ratings are not applied to current views.");
    assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
    assert.equal((await loadBoardState(context)).revision, after.revision);
    assert.equal(after.evidenceRevision, before.evidenceRevision);
    await assert.rejects(executeAssessmentAction(context, "another-owner", "get_mutation_status", input), error => error.status === 403);
    assert.deepEqual(await executeAssessmentAction(context, "another-owner", "get_mutation_status", { ...input, receiptToken }), result);
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

test("ordinary source updates preserve historical personal records without creating current ratings", async t => {
    const { context } = await retirementFixture(t), before = await loadBoardState(context);
    await replaceEvidence(context, records => {
        const next = structuredClone(records);
        next[0].toolCalls[0].completionEventId = "new-synthetic-completion";
        return { records: next };
    });
    const changed = buildAssessmentModel(await loadBoardState(context));
    assert.ok([...changed.details.values()].every(view => view.assessments.length === 0));
    assert.deepEqual((await loadBoardState(context)).personalEvaluation, before.personalEvaluation);
});
