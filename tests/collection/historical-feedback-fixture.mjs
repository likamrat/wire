import assert from "node:assert/strict";
import { exclusiveBoard } from "../../lib/store.mjs";
import { buildAssessmentModel, assessmentBasis, assessmentDependencies, assessmentRef, assessmentHash } from "../../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation, validatePersonalEvaluation } from "../../lib/personal-evaluation.mjs";

// Invented pre-retirement state, not a current product write path.
export async function seedHistoricalFeedback(context, input) {
    return exclusiveBoard(context, async (state, save) => {
        const view = buildAssessmentModel(state).details.get(input.interactionRef);
        assert.deepEqual(view.basis, input.expectedBasis);
        state.personalEvaluation ??= defaultPersonalEvaluation();
        const personal = state.personalEvaluation;
        const previous = personal.feedback.records.filter(item => item.assessment.interactionRef === input.interactionRef
            && item.assessment.checkId === input.checkId).at(-1)?.assessment;
        personal.overrideRevision++; personal.feedback.revision++;
        const basis = assessmentBasis(state), assessment = {
            schemaVersion: 1, interactionRef: input.interactionRef, basis, createdAt: new Date().toISOString(),
            evidenceRefs: [...new Set(view.observations.flatMap(item => item.evidenceRefs))],
            assessmentRef: assessmentRef(state, "assessment", [input.mutationRef, input.checkId]), checkId: input.checkId, checkVersion: 1,
            dimension: { "semantic-answer-correctness": "accuracy", "answer-support-validity": "answer-trust",
                "action-authorization-compliance": "action-trust" }[input.checkId],
            unitRef: input.interactionRef, origin: "user-personal", rubricVersion: 1, verdict: input.verdict, reason: "user-verdict",
            revision: (previous?.revision ?? 0) + 1, supersedes: previous?.assessmentRef ?? null, withdrawn: false,
        };
        const dependencies = { ...assessmentDependencies(view), basis };
        personal.feedback.records.push({ schemaVersion: 1, assessment, dependencies });
        personal.mutations[input.mutationRef] = {
            ownerHash: assessmentHash(["assessment-owner", "owner"]), inputHash: assessmentHash(["set_personal_assessment", input]), dependencies,
            receipt: { schemaVersion: 1, mutationRef: input.mutationRef, phase: "complete", basis, data: { assessment } },
        };
        validatePersonalEvaluation(personal);
        state.revision++; await save(state);
    });
}
