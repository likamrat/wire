import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluationFixture, materializeEvaluationSource } from "./evaluation-fixture.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { assessmentHash, assessmentRef, assessmentSource } from "../lib/assessment-read-model.mjs";
import { exclusiveBoard } from "../lib/store.mjs";
import { AUTOMATIC_SCORE_METHOD } from "../lib/automatic-score-policy.mjs";

export async function retirementFixture(t) {
    const fixture = await evaluationFixture(t);
    await exclusiveBoard(fixture.context, async (state, save) => {
        state.pseudonymKey = "a".repeat(64);
        await save(state);
    });
    await materializeEvaluationSource(fixture);
    const receiptToken = "d".repeat(64), mutationRef = "mutation-" + "e".repeat(32);
    const personalMutationRef = "mutation-" + "7".repeat(32);
    await exclusiveBoard(fixture.context, async (state, save) => {
        const historical = qualityDisplayFixture({ records: fixture.inputs.map(input => input.record), judgments: ["pass"] }).state.personalEvaluation;
        historical.source = assessmentSource(state, fixture.config);
        const evaluation = historical.modelEvaluation, grant = evaluation.grants[0], original = evaluation.runs[0];
        Object.assign(grant, historical.source);
        delete grant.available;
        const approvalRef = "approval-" + "f".repeat(32);
        grant.origin = "approved-chat-automatic"; grant.automaticApprovalRef = approvalRef;
        evaluation.runs.push(...["running", "uncertain"].map((phase, index) => ({
            ...structuredClone(original), runRef: "run-" + String(index + 8).repeat(32), phase, results: [],
            completedAt: phase === "running" ? null : original.completedAt,
            spentAiCredits: 0.125, costUnknown: phase === "uncertain",
            error: phase === "uncertain" ? "runtime-restarted" : null,
        })));
        for (const run of evaluation.runs) {
            run.receiptTokenHash = assessmentHash(receiptToken);
            run.automatic = { approvalRef, approvalRevision: 1,
                attemptKey: assessmentHash(run.runRef), interactionKey: assessmentHash(run.scope[0].interactionRef) };
        }
        evaluation.automatic = {
            schemaVersion: 1, revision: 1,
            approval: { schemaVersion: 1, approvalRef, revision: 1, state: "enabled",
                sourceConfigRef: historical.source.sourceConfigRef, sourceConfigRevision: historical.source.sourceConfigRevision,
                windowDays: 30, chatRefs: [assessmentRef(state, "chat", fixture.inputs[0].record.sourceSessionId)],
                method: AUTOMATIC_SCORE_METHOD, evidenceCategories: ["answer", "intent", "prompt", "references"],
                maxCalls: 6, maxAiCredits: 60, approvedAt: grant.grantedAt, origin: "explicit-automatic-score-approval" },
            receipts: [{ mutationRef, kind: "revoke", ownerHash: assessmentHash("original-panel"), inputHash: "b".repeat(64),
                receiptTokenHash: assessmentHash(receiptToken), phase: "pending", createdAt: grant.grantedAt, approvalRevision: 1, approvalRef }],
        };
        const basis = { ...original.basis, overrideRevision: 1 };
        const assessment = {
            schemaVersion: 1, interactionRef: original.scope[0].interactionRef, basis, createdAt: original.startedAt,
            evidenceRefs: original.scope[0].dependencies.evidenceRefs, assessmentRef: "assessment-" + "3".repeat(32),
            checkId: "semantic-answer-correctness", checkVersion: 1, dimension: "accuracy",
            unitRef: original.scope[0].interactionRef, origin: "user-personal", rubricVersion: 1,
            verdict: "pass", reason: "user-verdict", revision: 1, supersedes: null, withdrawn: false,
        };
        const dependencies = { ...structuredClone(original.scope[0].dependencies), basis };
        historical.overrideRevision = 1;
        historical.feedback = { schemaVersion: 1, revision: 1, records: [{ schemaVersion: 1, assessment, dependencies }] };
        historical.mutations[personalMutationRef] = {
            ownerHash: assessmentHash(["assessment-owner", "original-panel"]), inputHash: "c".repeat(64), dependencies,
            receiptTokenHash: assessmentHash(["assessment-receipt", receiptToken]),
            receipt: { schemaVersion: 1, mutationRef: personalMutationRef, phase: "complete", basis, data: { assessment } },
        };
        state.personalEvaluation = historical;
        await save(state);
    });
    const workFile = path.join(fixture.context.dataDir, "evaluation-work", "run-" + "8".repeat(32), "historical-evidence.txt");
    await mkdir(path.dirname(workFile), { recursive: true });
    await writeFile(workFile, "Invented historical work evidence: do not clean on boot.\n");
    return { ...fixture, receiptToken, mutationRef, personalMutationRef, workFile };
}

export async function retirementClient(runtime) {
    const origin = new URL(runtime.url).origin;
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" };
    const response = await fetch(origin + "/api/session", { method: "POST", headers, body: "{}" });
    if (!response.ok) throw new Error("Synthetic panel connection failed.");
    headers["X-Board-Capability"] = (await response.json()).capability;
    return async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
}
