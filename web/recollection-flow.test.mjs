import test from "node:test";
import assert from "node:assert/strict";
import { describeRecollection } from "./recollection-flow.mjs";

test("receipt presentation uses returned counts without reconstructing an earlier scope", () => {
    const unknown = describeRecollection("uncertain");
    assert.equal(unknown.title, "Result not yet confirmed");
    assert.equal(unknown.scopeAvailable, false);
    assert.equal(unknown.records, null);
    const completed = describeRecollection("complete", { result: { counts: { records: 3, restoredPrompts: 1 } } });
    assert.equal(completed.title, "3 records read again");
    assert.equal(completed.scopeAvailable, false);
    assert.match(completed.resultMessage, /Recollected 3 records/);
    assert.match(completed.resultMessage, /Restored 1 original prompt/);
    const unavailable = describeRecollection("complete", { result: { counts: {} } });
    assert.equal(unavailable.title, "Recollection completed");
    assert.match(unavailable.resultMessage, /record count is unavailable/);
    assert.doesNotMatch(unavailable.resultMessage, /0 records/);
    const blocked = describeRecollection("blocked");
    assert.equal(blocked.title, "Recollection recovery unavailable");
    assert.equal(blocked.decisionPhase, "error");
    assert.equal(blocked.records, null);
    assert.equal(blocked.scopeAvailable, false);
    assert.equal(blocked.canConfirm, false);
    assert.equal(blocked.resultMessage, null);
});

test("only an authoritative nonempty preview offers a commit and unknown busy means receipt reading", () => {
    const preview = { counts: { records: 3 }, scope: { from: "2026-10-01", to: "2026-10-05" } };
    const review = describeRecollection("preview", { preview });
    assert.equal(review.title, "Read these 3 records again?");
    assert.equal(review.decisionPhase, "confirm");
    assert.equal(review.canConfirm, true);
    assert.equal(review.confirmLabel, "Read 3 records again");
    assert.equal(review.scopeAvailable, true);
    for (const records of [0, undefined, -1, "3"]) {
        assert.equal(describeRecollection("preview", { preview: { ...preview, counts: { records } } }).canConfirm, false);
    }
    assert.equal(describeRecollection("preview", { preview: { counts: { records: 3 } } }).canConfirm, false);
    assert.equal(describeRecollection("pending", { preview }).title, "Reading 3 records again...");
    const checking = describeRecollection("uncertain", { busy: true });
    assert.equal(checking.decisionPhase, "checking");
    assert.equal(checking.title, "Checking recollection result...");
    assert.equal(checking.canConfirm, false);
    assert.equal(checking.resultMessage, null);
});
