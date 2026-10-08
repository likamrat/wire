import { createHash } from "node:crypto";

export const evaluationRecordFingerprint = record => createHash("sha256").update(JSON.stringify({
    sourceSessionId: record.sourceSessionId,
    prompt: record.userPrompt ? {
        sourceEventId: record.userPrompt.sourceEventId, sourceTimestamp: record.userPrompt.sourceTimestamp,
        text: record.userPrompt.text, status: record.userPrompt.status,
    } : null,
    calls: record.toolCalls, graph: record.graphActivities, pruned: record.assessmentMembershipPruned === true,
    finalEvidence: record.responseTiming ? {
        status: record.responseTiming.status, reason: record.responseTiming.reason,
        promptEventId: record.responseTiming.promptEventId, finalEventId: record.responseTiming.finalEventId,
        completionEventId: record.responseTiming.completionEventId,
    } : null,
})).digest("hex");
