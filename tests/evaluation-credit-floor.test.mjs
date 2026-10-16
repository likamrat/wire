import test from "node:test";
import assert from "node:assert/strict";
import { sessionCreditLimit } from "../lib/evaluation-budget.mjs";
import { createEvaluationController } from "../lib/evaluation-controller.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { retirementFixture } from "./ai-review-retirement-fixture.mjs";

test("historical effective session limits are never rounded up and exact30 remaining stays supported", () => {
    assert.equal(sessionCreditLimit(60, 30), 30);
    assert.equal(sessionCreditLimit(30, 60), 30);
    assert.equal(sessionCreditLimit(60, 30.1), 30.1);
    assert.throws(() => sessionCreditLimit(60, 29.999999), error => error.code === "session-credit-minimum");
});

test("retirement rejects every new budget before reads or reservations and never settles an existing unknown charge", async t => {
    const f = await retirementFixture(t), before = await loadBoardState(f.context);
    let reads = 0;
    const forbidden = () => { reads++; throw new Error("No source or provider access."); };
    const controller = createEvaluationController(f.context, { getSourceConfig: forbidden, readSource: forbidden, evaluatorFactory: forbidden });
    for (const maxAiCredits of [0, 1, 10, 29.999, 30, 60]) {
        assert.throws(() => controller.start("panel", { ...f.input, maxAiCredits }), error => error.code === "AI_REVIEW_RETIRED");
    }
    const run = before.personalEvaluation.modelEvaluation.runs.find(run => run.phase === "uncertain");
    const receipt = await controller.status("reconnected-panel", { runRef: run.runRef, receiptToken: f.receiptToken });
    assert.equal(receipt.costUnknown, true);
    assert.equal(receipt.spentAiCredits, 0.125);
    assert.equal(receipt.phase, "uncertain");
    assert.equal(reads, 0);
    assert.deepEqual(await loadBoardState(f.context), before);
});
