import { rm } from "node:fs/promises";
import path from "node:path";
import { BoardError, loadBoardState, resolveDataDir } from "./store.mjs";
import { assessmentHash } from "./assessment-read-model.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { rejectAIReview } from "./ai-review-retirement.mjs";

export async function readEvaluationReceipt(session, owner, input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).some(key => !["runRef", "receiptToken"].includes(key))
        || !/^[a-z]+-[a-f0-9]{32}$/.test(input.runRef ?? "")
        || input.receiptToken !== undefined && !/^[a-f0-9]{64}$/.test(input.receiptToken)) {
        throw new BoardError("Invalid evaluation receipt.", 422);
    }
    const state = await loadBoardState(session, { readOnly: true });
    const run = state.personalEvaluation?.modelEvaluation?.runs.find(run => run.runRef === input.runRef);
    if (!run || run.ownerHash !== assessmentHash(owner)
        && run.receiptTokenHash !== assessmentHash(input.receiptToken ?? "")) {
        throw new BoardError("This evaluation receipt is not available to this panel.", 404);
    }
    return { runRef: run.runRef, phase: run.phase, callsReserved: run.callsReserved, spentAiCredits: run.spentAiCredits,
        costUnknown: run.costUnknown, results: structuredClone(run.results), error: run.error };
}

// Only the existing sealed, explicitly confirmed activity-deletion path calls this.
export async function cleanupDeletedEvaluationWork(session, state) {
    for (const run of state.personalEvaluation?.modelEvaluation?.runs ?? []) if (run.phase === "purged") {
        await rm(await safeDeletionFile(resolveDataDir(session), path.join("evaluation-work", run.runRef)), { recursive: true, force: true });
    }
}

export function createEvaluationController(session) {
    return {
        setup: rejectAIReview, start: rejectAIReview, revoke: rejectAIReview, recover: rejectAIReview,
        status: (owner, input) => readEvaluationReceipt(session, owner, input),
        lifecycleStatus: () => ({ active: false, cleanupPending: false }),
        sealSourceDeletion: rejectAIReview,
        async settle() {},
        async close() {},
    };
}
