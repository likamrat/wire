import { BoardError, loadBoardState } from "./store.mjs";
import { assessmentHash } from "./assessment-read-model.mjs";
import { rejectAIReview } from "./ai-review-retirement.mjs";

export async function readAutomaticScoreReceipt(session, owner, input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).some(key => !["schemaVersion", "mutationRef", "receiptToken"].includes(key))
        || input.schemaVersion !== 1 || !/^mutation-[a-f0-9]{32}$/.test(input.mutationRef ?? "")
        || !/^[a-f0-9]{64}$/.test(input.receiptToken ?? "")) {
        throw new BoardError("Invalid score approval receipt.", 422);
    }
    const state = await loadBoardState(session, { readOnly: true });
    const receipt = state.personalEvaluation?.modelEvaluation?.automatic?.receipts.find(value => value.mutationRef === input.mutationRef);
    if (!receipt) return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "not-started" };
    if (receipt.ownerHash !== assessmentHash(owner) && receipt.receiptTokenHash !== assessmentHash(input.receiptToken)) {
        throw new BoardError("This score approval receipt belongs to another panel.", 404);
    }
    return { schemaVersion: 1, mutationRef: receipt.mutationRef, kind: receipt.kind, phase: receipt.phase,
        data: { approvalRevision: receipt.approvalRevision, approvalRef: receipt.approvalRef } };
}

export function createAutomaticScoreController(session) {
    return {
        setup: rejectAIReview, summary: rejectAIReview, approve: rejectAIReview, revoke: rejectAIReview,
        reconcile: rejectAIReview, recover: rejectAIReview,
        status: (owner, input) => readAutomaticScoreReceipt(session, owner, input),
        async close() {},
    };
}
