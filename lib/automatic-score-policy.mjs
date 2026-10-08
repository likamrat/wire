import { createHash } from "node:crypto";
import { evaluationRecordFingerprint } from "./evaluation-fingerprint.mjs";
import { MODEL_EVALUATION_RUBRIC } from "./model-evaluation-rubric.mjs";
import { MINIMUM_SESSION_AI_CREDITS } from "./evaluation-budget.mjs";

export const AUTOMATIC_SCORE_METHOD = Object.freeze({
    provider: "github-copilot", model: "gpt-6-astra",
    rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version,
});
const categories = ["answer", "intent", "prompt", "references"];
const ref = value => typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const phases = new Set(["queued", "running", "complete", "partial", "failed", "uncertain", "revoked", "purged"]);
function requireThat(condition, message) { if (!condition) throw new TypeError(message); }
function fields(value, keys) {
    requireThat(value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "Invalid automatic-score approval.");
}
export function validateAutomaticScoreApproval(value) {
    fields(value, ["schemaVersion", "approvalRef", "revision", "state", "sourceConfigRef", "sourceConfigRevision", "windowDays",
        "chatRefs", "method", "evidenceCategories", "maxCalls", "maxAiCredits", "approvedAt", "origin",
        ...(Object.hasOwn(value, "interactionRefs") ? ["interactionRefs"] : [])]);
    fields(value.method, ["provider", "model", "rubricId", "rubricVersion"]);
    requireThat(value.schemaVersion === 1 && ref(value.approvalRef)
        && Number.isSafeInteger(value.revision) && value.revision >= 1
        && ["enabled", "revoked"].includes(value.state)
        && ref(value.sourceConfigRef) && Number.isSafeInteger(value.sourceConfigRevision) && value.sourceConfigRevision >= 0
        && [7, 30, 90].includes(value.windowDays)
        && Array.isArray(value.chatRefs) && value.chatRefs.length > 0 && value.chatRefs.length <= 6
        && value.chatRefs.every(ref) && new Set(value.chatRefs).size === value.chatRefs.length
        && (value.interactionRefs == null || Array.isArray(value.interactionRefs)
            && value.interactionRefs.length > 0 && value.interactionRefs.length <= 6
            && value.interactionRefs.every(ref) && new Set(value.interactionRefs).size === value.interactionRefs.length)
        && value.method.provider === "github-copilot"
        && typeof value.method.model === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value.method.model)
        && typeof value.method.rubricId === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value.method.rubricId)
        && Number.isSafeInteger(value.method.rubricVersion) && value.method.rubricVersion >= 1
        && Array.isArray(value.evidenceCategories) && JSON.stringify([...value.evidenceCategories].sort()) === JSON.stringify(categories)
        && Number.isSafeInteger(value.maxCalls) && value.maxCalls >= 1 && value.maxCalls <= 6
        && Number.isFinite(value.maxAiCredits) && value.maxAiCredits > 0
        && typeof value.approvedAt === "string" && Number.isFinite(Date.parse(value.approvedAt))
        && value.origin === "explicit-automatic-score-approval", "An explicit chat, source, method, evidence and positive cumulative allowance approval is required.");
    return value;
}
export function automaticScoreAttemptKey(approval, interactionRef, record) {
    validateAutomaticScoreApproval(approval);
    requireThat(ref(interactionRef) && record && typeof record === "object", "Invalid automatic-score interaction.");
    const timing = record.responseTiming;
    const finality = timing ? {
        status: timing.status, reason: timing.reason, promptEventId: timing.promptEventId,
        finalEventId: timing.finalEventId, completionEventId: timing.completionEventId,
    } : null;
    return hash([approval.approvalRef, interactionRef, evaluationRecordFingerprint(record), finality,
        Object.keys(AUTOMATIC_SCORE_METHOD).map(key => approval.method[key])]);
}
export const automaticInteractionKey = (interactionRef, method = AUTOMATIC_SCORE_METHOD) =>
    hash([interactionRef, Object.keys(AUTOMATIC_SCORE_METHOD).map(key => method[key])]);

// Metadata decision only. The runtime must atomically recheck this decision before
// reserving work; this module never reads original histories or invokes a provider.
export function planAutomaticScore({ approval, source, candidates, attempts, usage, now, method = AUTOMATIC_SCORE_METHOD }) {
    const result = (state, reason, next = null, exclusions = []) => ({ state, reason, next, exclusions });
    if (approval === null) return result("off", "not-approved");
    validateAutomaticScoreApproval(approval);
    requireThat(source && typeof source.available === "boolean" && typeof source.collectionEnabled === "boolean"
        && Array.isArray(candidates) && Array.isArray(attempts) && typeof now === "string" && Number.isFinite(Date.parse(now)), "Invalid automatic-score context.");
    requireThat(usage && Number.isSafeInteger(usage.callsReserved) && usage.callsReserved >= 0
        && Number.isFinite(usage.spentAiCredits) && usage.spentAiCredits >= 0
        && typeof usage.costUnknown === "boolean" && typeof usage.active === "boolean" && typeof usage.cleanupPending === "boolean", "Invalid cumulative score allowance.");
    if (approval.state === "revoked") return usage.active || usage.cleanupPending
        ? result("paused", "stopping") : result("off", "revoked");
    if (!source.available || source.sourceConfigRef !== approval.sourceConfigRef
        || source.sourceConfigRevision !== approval.sourceConfigRevision || source.windowDays !== approval.windowDays) return result("paused", "source-changed");
    if (Object.keys(AUTOMATIC_SCORE_METHOD).some(key => method[key] !== approval.method[key])) return result("paused", "method-changed");
    if (!source.collectionEnabled) return result("paused", "collection-paused");
    if (usage.cleanupPending) return result("paused", "cleanup-pending");
    if (usage.active) return result("assessing", "in-progress");
    if (usage.costUnknown) return result("paused", "unknown-billing");
    if (usage.callsReserved >= approval.maxCalls || usage.spentAiCredits >= approval.maxAiCredits) return result("paused", "allowance-used");
    const prior = new Map();
    for (const attempt of attempts) {
        requireThat(attempt && /^[a-f0-9]{64}$/.test(attempt.attemptKey) && phases.has(attempt.phase)
            && !prior.has(attempt.attemptKey), "Invalid or duplicate automatic-score attempt.");
        prior.set(attempt.attemptKey, attempt);
    }
    if (attempts.some(attempt => ["queued", "running", "uncertain"].includes(attempt.phase))) return result("paused", "unresolved-attempt");
    if (attempts.some(attempt => attempt.phase === "failed")) return result("paused", "evaluation-failed");
    if (approval.maxAiCredits - usage.spentAiCredits < MINIMUM_SESSION_AI_CREDITS) return result("paused", "session-credit-minimum");
    const exclusions = [], interactions = new Set();
    let waiting = false, completed = false, next = null;
    for (const candidate of candidates) {
        requireThat(candidate && ref(candidate.interactionRef) && ref(candidate.chatRef)
            && candidate.record && typeof candidate.record === "object"
            && !interactions.has(candidate.interactionRef), "Invalid or duplicate automatic-score candidate.");
        interactions.add(candidate.interactionRef);
        if (!approval.chatRefs.includes(candidate.chatRef)) continue;
        if (approval.interactionRefs && !approval.interactionRefs.includes(candidate.interactionRef)) continue;
        if (candidate.priorUncertain) {
            exclusions.push({ interactionRef: candidate.interactionRef, reason: "earlier-uncertain-assessment" }); continue;
        }
        if (candidate.deletedEvidence || candidate.record.assessmentMembershipPruned) {
            exclusions.push({ interactionRef: candidate.interactionRef, reason: "deleted-evidence" }); continue;
        }
        if (candidate.record.userPrompt?.status !== "full" || typeof candidate.record.userPrompt?.sourceEventId !== "string") {
            exclusions.push({ interactionRef: candidate.interactionRef, reason: "source-prompt-unavailable" }); continue;
        }
        const requestedAt = Date.parse(candidate.record.userPrompt?.sourceTimestamp);
        if (!Number.isFinite(requestedAt)) {
            exclusions.push({ interactionRef: candidate.interactionRef, reason: "source-date-unavailable" }); continue;
        }
        if (requestedAt < Date.parse(now) - approval.windowDays * 86400000 || requestedAt > Date.parse(now)) {
            exclusions.push({ interactionRef: candidate.interactionRef, reason: "outside-approved-window" }); continue;
        }
        const timing = candidate.record.responseTiming;
        if (timing?.status !== "measured" || typeof timing.finalEventId !== "string" || typeof timing.completionEventId !== "string") {
            waiting = true; continue;
        }
        const attemptKey = automaticScoreAttemptKey(approval, candidate.interactionRef, candidate.record);
        const attempted = prior.get(attemptKey);
        if (attempted) {
            completed ||= attempted.phase === "complete";
            if (["purged", "revoked"].includes(attempted.phase)) exclusions.push({
                interactionRef: candidate.interactionRef, reason: "prior-attempt-" + attempted.phase,
            });
            continue;
        }
        next ??= { interactionRef: candidate.interactionRef, attemptKey };
    }
    if (next) return result("waiting", "eligible", next, exclusions);
    return result(waiting || !completed ? "waiting" : "ready", waiting ? "final-reply-not-recorded" : completed ? "processed" : "no-eligible-evidence", null, exclusions);
}
