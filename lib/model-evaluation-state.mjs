export { evaluationRecordFingerprint } from "./evaluation-fingerprint.mjs";
import { validateAssessment, validateDependencies, validateBasis, ContractError } from "./assessment-contract.mjs";
import { validateAutomaticScoreState } from "./automatic-score-store.mjs";
import { validateEvaluationDiagnostic } from "./evaluation-diagnostics.mjs";

const ref = value => typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
function requireThat(condition, code) { if (!condition) throw new ContractError(code); }
function shape(value, fields) {
    requireThat(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key)), "invalid-model-evaluation-state");
}
export function defaultModelEvaluationState() {
    return { schemaVersion: 1, revision: 0, grants: [], runs: [], records: [] };
}
export function validateEvaluatorCost(value) {
    shape(value, ["aiCredits", "modelCalls", "attribution", "status"]);
    requireThat(value.attribution === "evaluation-overhead-only"
        && ["recorded", "partial", "unavailable"].includes(value.status)
        && (value.aiCredits === null || Number.isFinite(value.aiCredits) && value.aiCredits >= 0)
        && (value.modelCalls === null || Number.isSafeInteger(value.modelCalls) && value.modelCalls >= 0)
        && (value.status === "unavailable" ? value.aiCredits === null : value.aiCredits !== null), "invalid-evaluator-overhead");
    return value;
}
export function validateModelEvaluationState(value) {
    shape(value, ["schemaVersion", "revision", "grants", "runs", "records", ...(Object.hasOwn(value, "automatic") ? ["automatic"] : [])]);
    if (value.automatic !== undefined) validateAutomaticScoreState(value.automatic);
    requireThat(value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0, "invalid-model-evaluation-version");
    requireThat([value.grants, value.runs, value.records].every(items => Array.isArray(items) && items.length <= 10000), "invalid-model-evaluation-inventory");
    const grants = new Set(), runs = new Set(), records = new Set();
    for (const grant of value.grants) {
        shape(grant, ["grantRef", "state", "sourceConfigRef", "sourceConfigRevision", "interactionRefs", "model",
            "maxCalls", "maxAiCredits", "grantedAt", "revokedAt", "origin",
            ...(Object.hasOwn(grant, "automaticApprovalRef") ? ["automaticApprovalRef"] : [])]);
        requireThat(ref(grant.grantRef) && !grants.has(grant.grantRef) && ref(grant.sourceConfigRef)
            && Number.isSafeInteger(grant.sourceConfigRevision) && grant.sourceConfigRevision >= 0
            && Array.isArray(grant.interactionRefs) && (grant.interactionRefs.length > 0 || grant.state === "revoked") && grant.interactionRefs.length <= 6
            && grant.interactionRefs.every(ref) && new Set(grant.interactionRefs).size === grant.interactionRefs.length
            && typeof grant.model === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(grant.model)
            && Number.isSafeInteger(grant.maxCalls) && grant.maxCalls > 0 && grant.maxCalls <= 6
            && Number.isFinite(grant.maxAiCredits) && grant.maxAiCredits > 0 && instant(grant.grantedAt)
            && (grant.origin === "explicit-in-app-evaluation" ? !Object.hasOwn(grant, "automaticApprovalRef")
                : grant.origin === "approved-chat-automatic" && ref(grant.automaticApprovalRef))
            && ["enabled", "revoked"].includes(grant.state)
            && (grant.state === "enabled" ? grant.revokedAt === null
                : instant(grant.revokedAt) || grant.revokedAt === null && grant.interactionRefs.length === 0), "invalid-evaluation-grant");
        grants.add(grant.grantRef);
    }
    for (const run of value.runs) {
        shape(run, ["runRef", "grantRef", "ownerHash", "inputHash", "receiptTokenHash", "phase", "startedAt", "completedAt",
            "callsReserved", "spentAiCredits", "costUnknown", "results", "scope", "basis", "error",
            ...(Object.hasOwn(run, "automatic") ? ["automatic"] : [])]);
        if (run.automatic !== undefined) {
            shape(run.automatic, ["approvalRef", "approvalRevision", "attemptKey", "interactionKey"]);
            requireThat(ref(run.automatic.approvalRef) && hash(run.automatic.attemptKey) && hash(run.automatic.interactionKey)
                && Number.isSafeInteger(run.automatic.approvalRevision) && run.automatic.approvalRevision >= 1
                && value.grants.find(grant => grant.grantRef === run.grantRef)?.automaticApprovalRef === run.automatic.approvalRef, "invalid-automatic-run");
        }
        requireThat(ref(run.runRef) && !runs.has(run.runRef) && grants.has(run.grantRef) && hash(run.ownerHash)
            && hash(run.inputHash) && hash(run.receiptTokenHash)
            && ["queued", "running", "complete", "partial", "failed", "uncertain", "revoked", "purged"].includes(run.phase)
            && instant(run.startedAt) && (run.completedAt === null || instant(run.completedAt))
            && Number.isSafeInteger(run.callsReserved) && run.callsReserved >= 0 && run.callsReserved <= 6
            && Number.isFinite(run.spentAiCredits) && run.spentAiCredits >= 0 && typeof run.costUnknown === "boolean"
            && Array.isArray(run.results) && run.results.length <= 6
            && (run.error === null || ["source-changed", "evaluation-failed", "budget-exhausted", "session-credit-minimum", "permission-revoked", "runtime-restarted"].includes(run.error)),
        "invalid-evaluation-run");
        validateBasis(run.basis);
        requireThat(Array.isArray(run.scope) && run.scope.length <= 6, "invalid-evaluation-run-scope");
        for (const item of run.scope) {
            shape(item, ["interactionRef", "recordFingerprint", "dependencies"]);
            requireThat(ref(item.interactionRef) && hash(item.recordFingerprint), "invalid-evaluation-run-scope");
            validateDependencies(item.dependencies);
        }
        for (const result of run.results) {
            shape(result, ["interactionRef", "status", "reason", ...(Object.hasOwn(result, "diagnostic") ? ["diagnostic"] : [])]);
            if (result.diagnostic !== undefined) validateEvaluationDiagnostic(result.diagnostic);
            requireThat(ref(result.interactionRef) && ["assessed", "unavailable", "failed"].includes(result.status)
                && (result.reason === null || typeof result.reason === "string" && /^[a-z-]{1,80}$/.test(result.reason)), "invalid-evaluation-result-status");
        }
        runs.add(run.runRef);
    }
    for (const record of value.records) {
        shape(record, ["recordRef", "runRef", "grantRef", "interactionRef", "recordFingerprint", "packetHash",
            "createdAt", "dependencies", "assessments", "criteria", "evaluatorCost"]);
        requireThat(ref(record.recordRef) && !records.has(record.recordRef) && runs.has(record.runRef) && grants.has(record.grantRef)
            && ref(record.interactionRef) && hash(record.recordFingerprint) && hash(record.packetHash) && instant(record.createdAt)
            && Array.isArray(record.assessments) && record.assessments.length === 3, "invalid-model-assessment-record");
        validateDependencies(record.dependencies);
        for (const assessment of record.assessments) {
            validateAssessment(assessment);
            requireThat(assessment.origin === "model-assessed" && assessment.interactionRef === record.interactionRef, "invalid-model-assessment-record");
        }
        requireThat(new Set(record.assessments.map(assessment => assessment.dimension)).size === 3, "duplicate-model-dimension");
        requireThat(Array.isArray(record.criteria) && record.criteria.length === 3, "invalid-model-criteria-counts");
        for (const criteria of record.criteria) {
            shape(criteria, ["dimension", "counts"]);
            requireThat(["accuracy", "answer-trust", "action-trust"].includes(criteria.dimension), "invalid-model-criteria-counts");
            shape(criteria.counts, ["met", "notMet", "insufficient", "notApplicable"]);
            requireThat(Object.values(criteria.counts).every(count => Number.isSafeInteger(count) && count >= 0 && count <= 100), "invalid-model-criteria-counts");
        }
        validateEvaluatorCost(record.evaluatorCost);
        records.add(record.recordRef);
    }
    return value;
}
