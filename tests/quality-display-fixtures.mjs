import { fixture } from "./helpers.mjs";
import { assessmentDependencies, buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { defaultPersonalEvaluation, validatePersonalEvaluation } from "../lib/personal-evaluation.mjs";
import { evaluationRecordFingerprint } from "../lib/model-evaluation-state.mjs";

const at = "2026-10-01T12:00:00.000Z";
const id = (kind, n) => `${kind}-${n.toString(16).padStart(32, "0")}`;
const checks = {
    accuracy: "request-requirements-corroborated",
    "answer-trust": "recorded-answer-support",
    "action-trust": "action-intent-alignment",
};

// Invented source records and historical assessment records, entirely in memory.
// No evaluator, capture, approval, collection, or persistence action runs.
export function qualityDisplayFixture({ requests = 18, calls = 53, judgments = [], timed = calls - 1, finalDuration = 677960, records = null, pseudonymKey = "a".repeat(64) } = {}) {
    const evidence = records ?? Array.from({ length: requests }, (_, index) => {
        const record = fixture(`quality-request-${index}`);
        record.sourceSessionName = "Invented quality display";
        record.userPrompt = { ...record.userPrompt, text: `Invented quality request ${index}`, sourceEventId: `quality-prompt-${index}`, sourceTimestamp: at };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: calls }, (_, call) => call).filter(call => call % requests === index).map(call => ({
            ...record.toolCalls[0], toolCallId: `quality-call-${call}`, startEventId: `quality-start-${call}`,
            completionEventId: `quality-end-${call}`, startedAt: at,
            toolSucceeded: call % 9 !== 0, reportedOutcome: call % 9 === 0 ? "failed" : "succeeded",
            ...(call < timed ? { durationMs: 41100, completedAt: "2026-10-01T12:00:41.100Z" } : {}),
        }));
        if (index === 0 && finalDuration !== null) record.responseTiming = {
            schemaVersion: 1, status: "measured", boundary: "recorded-request-to-final-answer",
            promptEventId: record.userPrompt.sourceEventId, requestedAt: at,
            respondedAt: new Date(Date.parse(at) + finalDuration).toISOString(),
            completedAt: new Date(Date.parse(at) + finalDuration).toISOString(),
            durationMs: finalDuration, finalEventId: "quality-final-0", completionEventId: "quality-turn-0",
            association: "single-recorded-message-interval",
        };
        return record;
    });
    const state = {
        revision: 1, evidenceRevision: 1, pseudonymKey, evidence, exports: [],
        cards: Object.fromEntries(evidence.map(record => [record.scenarioId, { workflowState: "captured", updatedAt: at, history: [] }])),
        personalEvaluation: defaultPersonalEvaluation(),
    };
    state.personalEvaluation.source = { available: true, sourceConfigRef: id("config", 1), sourceConfigRevision: 1 };
    const initial = buildAssessmentModel(state, { createdAt: at });
    const evaluation = { schemaVersion: 1, revision: 1, grants: [], runs: [], records: [] };
    judgments.forEach((judgment, index) => {
        const interactionRef = initial.catalog[index].interactionRef, view = initial.details.get(interactionRef);
        const dependencies = assessmentDependencies(view), fingerprint = evaluationRecordFingerprint(initial.internals.get(interactionRef).record);
        const grantRef = id("grant", index + 1), runRef = id("run", index + 1);
        evaluation.grants.push({
            grantRef, state: "enabled", ...state.personalEvaluation.source, interactionRefs: [interactionRef],
            model: "synthetic-quality-fixture", maxCalls: 1, maxAiCredits: 1, grantedAt: at, revokedAt: null,
            origin: "explicit-in-app-evaluation",
        });
        delete evaluation.grants.at(-1).available;
        evaluation.runs.push({
            runRef, grantRef, ownerHash: "a".repeat(64), inputHash: "b".repeat(64), receiptTokenHash: "c".repeat(64),
            phase: judgment === "error" ? "failed" : "complete", startedAt: at, completedAt: at,
            callsReserved: 1, spentAiCredits: 0, costUnknown: false,
            results: [{ interactionRef, status: judgment === "error" ? "failed" : "assessed", reason: judgment === "error" ? "evaluation-failed" : null }],
            scope: [{ interactionRef, recordFingerprint: fingerprint, dependencies }], basis: view.basis,
            error: judgment === "error" ? "evaluation-failed" : null,
        });
        if (judgment === "error") return;
        const assessments = Object.entries(checks).map(([dimension, checkId], check) => {
            const verdict = typeof judgment === "string" ? judgment : judgment[dimension];
            return {
                schemaVersion: 1, interactionRef, basis: view.basis, createdAt: at, checkId, checkVersion: 1,
                dimension, unitRef: interactionRef, rubricVersion: 1, revision: 1, supersedes: null, withdrawn: false,
                assessmentRef: id("assessment", (index + 1) * 10 + check),
                origin: "model-assessed", verdict, reason: verdict === "unassessed" ? "missing-evidence" : null,
                evidenceRefs: dependencies.evidenceRefs.slice(0, 1),
                evaluator: { provider: "github-copilot", model: "synthetic-quality-fixture", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
            };
        });
        evaluation.records.push({
            recordRef: id("record", index + 1), runRef, grantRef, interactionRef, recordFingerprint: fingerprint,
            packetHash: "d".repeat(64), createdAt: at, dependencies, assessments,
            criteria: assessments.map(item => ({ dimension: item.dimension, counts: {
                met: Number(item.verdict === "pass"), notMet: Number(item.verdict === "fail"),
                insufficient: Number(item.verdict === "unassessed"), notApplicable: 0,
            } })),
            evaluatorCost: { aiCredits: 0, modelCalls: 1, attribution: "evaluation-overhead-only", status: "recorded" },
        });
    });
    state.personalEvaluation.modelEvaluation = evaluation;
    validatePersonalEvaluation(state.personalEvaluation);
    return { state, model: buildAssessmentModel(state, { createdAt: at }) };
}
