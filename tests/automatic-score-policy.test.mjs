import test from "node:test";
import assert from "node:assert/strict";
import { AUTOMATIC_SCORE_METHOD, validateAutomaticScoreApproval, automaticScoreAttemptKey, planAutomaticScore } from "../lib/automatic-score-policy.mjs";
import { fixture } from "./helpers.mjs";
import { sessionCreditLimit } from "../lib/evaluation-budget.mjs";

const ref = (kind, letter) => kind + "-" + letter.repeat(32);
function input() {
    const record = fixture();
    record.userPrompt.sourceTimestamp = "2026-10-01T12:00:00.000Z";
    record.userPrompt.sourceEventId = "synthetic-prompt";
    record.responseTiming = {
        status: "measured", reason: null, promptEventId: "synthetic-prompt",
        finalEventId: "synthetic-final", completionEventId: "synthetic-turn-end",
    };
    return {
        approval: {
            schemaVersion: 1, approvalRef: ref("approval", "a"), revision: 1, state: "enabled",
            sourceConfigRef: ref("sourceconfig", "b"), sourceConfigRevision: 1, windowDays: 30,
            chatRefs: [ref("chat", "c")], method: { ...AUTOMATIC_SCORE_METHOD },
            evidenceCategories: ["prompt", "answer", "references", "intent"], maxCalls: 6, maxAiCredits: 60,
            approvedAt: "2026-10-01T12:00:00.000Z", origin: "explicit-automatic-score-approval",
        },
        source: { available: true, collectionEnabled: true, sourceConfigRef: ref("sourceconfig", "b"), sourceConfigRevision: 1, windowDays: 30 },
        candidates: [{ interactionRef: ref("interaction", "d"), chatRef: ref("chat", "c"), record }],
        attempts: [],
        usage: { callsReserved: 0, spentAiCredits: 0, costUnknown: false, active: false, cleanupPending: false },
        now: "2026-10-07T12:00:00.000Z",
    };
}
test("unreferenced automatic policy requires score-specific approval and a positive explicit allowance", () => {
    assert.equal(sessionCreditLimit(60, 30), 30);
    assert.equal(sessionCreditLimit(30, 60), 30);
    assert.equal(sessionCreditLimit(60, 30.1), 30.1);
    assert.throws(() => sessionCreditLimit(60, 29.999999), error => error.code === "session-credit-minimum");
    assert.deepEqual(planAutomaticScore({ approval: null }), { state: "off", reason: "not-approved", next: null, exclusions: [] });
    const value = input();
    assert.equal(planAutomaticScore(value).next.interactionRef, value.candidates[0].interactionRef);
    for (const field of ["maxCalls", "maxAiCredits"]) assert.throws(() => validateAutomaticScoreApproval({ ...value.approval, [field]: 0 }), /positive cumulative allowance/);
    assert.throws(() => validateAutomaticScoreApproval({ ...value.approval, origin: "collection-approved" }), /explicit/);
    assert.throws(() => validateAutomaticScoreApproval({ ...value.approval, evidenceCategories: ["answer"] }), /evidence/);
});

test("automatic metadata decisions never broaden chat/source/window or method scope", () => {
    const value = input();
    value.candidates[0].chatRef = ref("chat", "e");
    assert.equal(planAutomaticScore(value).next, null);
    value.candidates[0].chatRef = value.approval.chatRefs[0];
    value.candidates[0].record.userPrompt.sourceTimestamp = "2026-09-04T12:00:00.000Z";
    assert.deepEqual(planAutomaticScore(value).exclusions, [{ interactionRef: value.candidates[0].interactionRef, reason: "outside-approved-window" }]);
    assert.equal(planAutomaticScore({ ...value, source: { ...value.source, windowDays: 90 } }).reason, "source-changed");
    assert.equal(planAutomaticScore({ ...value, method: { ...AUTOMATIC_SCORE_METHOD, rubricVersion: 2 } }).reason, "method-changed");
    const fresh = input();
    fresh.candidates.push(value.candidates[0]);
    fresh.candidates[1] = { ...fresh.candidates[1], interactionRef: ref("interaction", "e") };
    const mixed = planAutomaticScore(fresh);
    assert.ok(mixed.next);
    assert.equal(mixed.exclusions[0].reason, "outside-approved-window", "An eligible case cannot hide a later date exclusion.");
});

test("global revisions and allowance changes do not create another attempt, but new final evidence has a new key", () => {
    const value = input(), candidate = value.candidates[0];
    const key = automaticScoreAttemptKey(value.approval, candidate.interactionRef, candidate.record);
    value.approval.revision++;
    value.approval.maxAiCredits = 61;
    value.approval.method = Object.fromEntries(Object.entries(value.approval.method).reverse());
    candidate.record.capturedAt = "2026-10-07T12:00:00.000Z";
    assert.equal(automaticScoreAttemptKey(value.approval, candidate.interactionRef, candidate.record), key);
    value.attempts = [{ attemptKey: key, phase: "complete" }];
    assert.equal(planAutomaticScore(value).state, "ready");
    assert.equal(planAutomaticScore(structuredClone(value)).next, null, "Restarting a planner does not replay completed work.");
    candidate.record.responseTiming.finalEventId = "new-final-evidence";
    assert.notEqual(planAutomaticScore(value).next.attemptKey, key);
});

test("paused collection, missing final evidence, exhausted allowance and unknown effects never dispatch", () => {
    const value = input();
    assert.equal(planAutomaticScore({ ...value, source: { ...value.source, collectionEnabled: false } }).reason, "collection-paused");
    for (const usage of [
        { ...value.usage, callsReserved: 6 }, { ...value.usage, spentAiCredits: 60 },
        { ...value.usage, costUnknown: true }, { ...value.usage, active: true }, { ...value.usage, cleanupPending: true },
    ]) assert.equal(planAutomaticScore({ ...value, usage }).next, null);
    const candidate = value.candidates[0];
    const attemptKey = automaticScoreAttemptKey(value.approval, candidate.interactionRef, candidate.record);
    for (const phase of ["queued", "running", "uncertain", "revoked", "purged", "failed"]) {
        assert.equal(planAutomaticScore({ ...value, attempts: [{ attemptKey, phase }] }).next, null);
    }
    assert.equal(planAutomaticScore({ ...value, attempts: [{ attemptKey: "f".repeat(64), phase: "uncertain" }] }).next, null,
        "An unresolved earlier call cannot be bypassed by choosing another interaction.");
    assert.notEqual(planAutomaticScore({ ...value, attempts: [{ attemptKey, phase: "purged" }] }).state, "ready");
    assert.equal(planAutomaticScore({ ...value, approval: { ...value.approval, state: "revoked" },
        usage: { ...value.usage, cleanupPending: true } }).reason, "stopping");
    assert.equal(planAutomaticScore({ ...value, approval: { ...value.approval, state: "revoked" } }).state, "off");
    candidate.record.responseTiming = { status: "unavailable", reason: "final-response-not-established" };
    assert.equal(planAutomaticScore(value).reason, "final-reply-not-recorded");
});
