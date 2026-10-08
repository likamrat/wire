import test from "node:test";
import assert from "node:assert/strict";
import { projectAttributedUsage, poolAttributedUsage } from "../lib/evaluation-usage.mjs";

const scope = {
    confirmed: true, categories: ["usage"], interactionRef: "interaction-" + "a".repeat(32),
    sourceRef: "source-" + "b".repeat(32), promptMessageId: "prompt-1",
};
const message = () => ({
    type: "assistant.message", id: "answer-1", data: {
        apiCallId: "provider-call-1", originatingMessageId: "prompt-1", model: "model-a",
        content: "PRIVATE ANSWER SHOULD NEVER BE READ OR RETAINED",
    },
});
const usage = () => ({
    type: "assistant.usage", id: "usage-1", ephemeral: true,
    data: { apiCallId: "provider-call-1", model: "model-a", inputTokens: 100, outputTokens: 20,
        cost: 999, copilotUsage: { model: "model-a", totalNanoAiu: 250000000 } },
});

test("per-call Copilot usage binds exact provider call and explicit originating message, not nearest prompt or session totals", () => {
    const result = projectAttributedUsage(usage(), message(), scope);
    assert.equal(result.nanoAiu, 250000000);
    assert.equal(result.value, 0.25);
    assert.equal(result.unit, "AI credits");
    assert.equal(result.origin, "provider-recorded");
    assert.equal(result.boundary, "attributed-model-api-call");
    assert.deepEqual(result.tokens, { input: 100, output: 20, cacheRead: null, cacheWrite: null, reasoning: null });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE ANSWER|provider-call-1|prompt-1/);
});

test("usage category consent and explicit association are required", () => {
    for (const invalid of [null, { ...scope, confirmed: false }, { ...scope, categories: ["answer"] }]) {
        assert.throws(() => projectAttributedUsage(usage(), message(), invalid), /usage-capture-not-approved/);
    }
    const unmatched = message(); delete unmatched.data.originatingMessageId;
    assert.throws(() => projectAttributedUsage(usage(), unmatched, scope), /usage-interaction-unverified/);
    unmatched.data.originatingMessageId = "other-prompt";
    assert.throws(() => projectAttributedUsage(usage(), unmatched, scope), /usage-interaction-unverified/);
});

test("model mismatch, unassociated subagent and multiplier-only events cannot become attributed cost", () => {
    const a = usage(); a.data.model = "other-model";
    assert.throws(() => projectAttributedUsage(a, message(), scope), /usage-model-mismatch/);
    const b = message(); b.agentId = "subagent";
    assert.throws(() => projectAttributedUsage(usage(), b, scope), /subagent-usage-unverified/);
    const c = usage(); delete c.data.copilotUsage;
    assert.throws(() => projectAttributedUsage(c, message(), scope), /attributable-charge-missing/);
});

test("duplicate delivery counts once; conflicting same-call costs never silently win", () => {
    const one = projectAttributedUsage(usage(), message(), scope);
    const pooled = poolAttributedUsage([one, structuredClone(one)], [scope.interactionRef]);
    assert.equal(pooled.value, 0.25);
    assert.equal(pooled.calls, 1);
    const conflict = { ...one, nanoAiu: 260000000, value: 0.26 };
    assert.throws(() => poolAttributedUsage([one, conflict], [scope.interactionRef]), /conflicting-usage-call/);
});

test("partial usage is a subtotal with covered interactions; missing never turns into zero", () => {
    const one = projectAttributedUsage(usage(), message(), scope), other = "interaction-" + "c".repeat(32);
    const pooled = poolAttributedUsage([one], [scope.interactionRef, other]);
    assert.equal(pooled.value, 0.25);
    assert.equal(pooled.status, "measured-subtotal");
    assert.deepEqual(pooled.coverage, { covered: 1, eligible: 2 });
    assert.equal(poolAttributedUsage([], [other]).value, null);
    assert.throws(() => poolAttributedUsage([one], [other]), /usage-outside-membership/);
});

test("genuine recorded zero differs from missing and token fields cannot be fabricated", () => {
    const input = usage(); input.data.copilotUsage.totalNanoAiu = 0; delete input.data.inputTokens;
    const result = projectAttributedUsage(input, message(), scope);
    assert.equal(result.value, 0);
    assert.equal(result.tokens.input, null);
    input.data.outputTokens = -1;
    assert.throws(() => projectAttributedUsage(input, message(), scope), /invalid-usage-count/);
});
