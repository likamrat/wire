import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { mountPersonalFeedback } from "../web/assessment-control-views.mjs";
import { contract, samples } from "./assessment-ui-fixtures.mjs";

const controls = createAssessmentControls(contract);
const mutation = n => samples.id("mutation", n);
const source = () => ({
    adapter: "copilot-local-events-v1", sourceRevision: 7,
    sourceConfigRef: samples.id("config"), sourceConfigRevision: 1,
});
const consent = () => controls.consent(contract.defaultConsent(), source());
const answerConsent = () => ({ ...samples.enabledConsent(), categories: ["answer"] });
test("disposed response-saving controls drop private state without claiming the dispatched update was cancelled", () => {
    const edit = controls.consent(answerConsent(), source());
    edit.edit({ enabled: false, categories: [] });
    const packet = edit.begin(mutation(94), "c".repeat(64));
    edit.dispose();
    edit.dispose();
    assert.equal(edit.snapshot().applied, null);
    assert.equal(edit.snapshot().draft, null);
    assert.equal(edit.snapshot().mutationRef, packet.input.mutationRef);
    assert.equal(edit.snapshot().phase, "stale");
    assert.equal(edit.accept(packet.token, answerConsent()), false);
    assert.equal(edit.uncertain(packet.token, "PRIVATE_LATE_ERROR"), false);
    edit.invalidate("PRIVATE_LATE_CONTEXT");
    assert.doesNotMatch(JSON.stringify(edit.snapshot()), /PRIVATE_LATE|sourceConfigRef|categories/);
    assert.throws(() => edit.edit({ enabled: true, categories: ["answer"] }));
    assert.throws(() => edit.begin(mutation(95), "d".repeat(64)));
    assert.throws(() => edit.check());
});

test("recovery presentation matches only the retained uncertain operation and full receipt", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(92), "a".repeat(64));
    const recovery = { action: packet.action, mutationRef: packet.input.mutationRef, receiptToken: packet.input.receiptToken };
    assert.equal(edit.matchesRecovery(recovery), false);
    edit.uncertain(packet.token, "The result is unknown.");
    const before = edit.snapshot();
    assert.equal(edit.matchesRecovery(recovery), true);
    for (const value of [null, {}, { ...recovery, action: "set_personal_assessment" },
        { ...recovery, mutationRef: mutation(93) }, { ...recovery, receiptToken: "b".repeat(64) },
        { ...recovery, receiptToken: undefined }]) assert.equal(edit.matchesRecovery(value), false);
    assert.deepEqual(edit.snapshot(), before, "Presentation identity reads do not change state.");
    edit.check();
    assert.equal(edit.matchesRecovery(recovery), true);
    edit.invalidate("The source changed.");
    assert.equal(edit.matchesRecovery(recovery), false);
});

test("response-saving controls distinguish unsent choices from pending, uncertain and invalidated operations", () => {
    const edit = consent();
    assert.equal(edit.hasUnsentDraft(), false);
    edit.edit({ enabled: true, categories: ["answer"] });
    assert.equal(edit.hasUnsentDraft(), true);
    const packet = edit.begin(mutation(91));
    assert.equal(edit.hasUnsentDraft(), false);
    edit.uncertain(packet.token, "The result is not yet known.");
    assert.equal(edit.hasUnsentDraft(), false);
    edit.invalidate("The evidence is no longer current.");
    assert.equal(edit.hasUnsentDraft(), false);
});

test("opening consent is read-only, off by default, without an implicit draft", () => {
    const edit = consent();
    assert.equal(edit.snapshot().applied.state, "off");
    assert.equal(edit.snapshot().draft, null);
    assert.throws(() => edit.begin(mutation(1)), /explicit draft/);
});
test("editing and cancelling optional consent never changes its applied state", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    assert.equal(edit.snapshot().applied.state, "off");
    edit.cancel();
    assert.equal(edit.snapshot().applied.state, "off");
    assert.equal(edit.snapshot().draft, null);
});
test("unsupported usage/authorization cannot be enabled by this source", () => {
    for (const category of ["usage", "explicit-authorization"]) {
        const edit = consent();
        edit.edit({ enabled: true, categories: [category] });
        assert.throws(() => edit.begin(mutation(1)), /does not support/);
        assert.equal(edit.snapshot().applied.state, "off");
    }
});
test("empty category consent does not dispatch", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: [] });
    assert.throws(() => edit.begin(mutation(1)), /invalid-consent-categories/);
});
test("explicit consent request is contract-valid and preserves prior state while pending", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    contract.validateRequest(packet.action, packet.input);
    assert.equal(edit.snapshot().phase, "pending");
    assert.equal(edit.snapshot().applied.state, "off");
    assert.throws(() => edit.begin(mutation(2)), /explicit draft/);
    assert.throws(() => edit.cancel(), /cannot be cancelled/);
    assert.throws(() => edit.edit({ enabled: false, categories: [] }), /pending result/);
    edit.accept(packet.token, answerConsent());
    assert.equal(edit.snapshot().applied.state, "enabled");
    assert.equal(edit.snapshot().message, "Your choice is saved.");
});
test("returned scope widening is not accepted as successful consent", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    assert.throws(() => edit.accept(packet.token, samples.enabledConsent()), /changed the approved scope/);
    assert.equal(edit.snapshot().phase, "unknown");
    assert.equal(edit.snapshot().applied.state, "off");
    assert.equal(edit.check().action, "get_mutation_status");
});
test("known rejection retains draft and prior applied state for explicit correction", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    edit.rejected(packet.token, "The approved source changed. Review its permission before enabling.");
    assert.equal(edit.snapshot().phase, "error");
    assert.deepEqual(edit.snapshot().draft, { enabled: true, categories: ["answer"] });
    assert.equal(edit.snapshot().applied.state, "off");
    assert.throws(() => edit.begin(mutation(1)), /already used/);
});
test("uncertain transport locks mutations; recovery reads only the original opaque identity", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    edit.uncertain(packet.token, "Connection lost. The update may have completed.");
    assert.throws(() => edit.begin(mutation(2)), /explicit draft/);
    const check = edit.check();
    assert.equal(check.action, "get_mutation_status");
    assert.deepEqual(check.input, { schemaVersion: 1, mutationRef: mutation(1) });
    edit.pending(check.token);
    const recheck = edit.check();
    assert.deepEqual(recheck.input, check.input);
    edit.accept(recheck.token, answerConsent());
    assert.equal(edit.snapshot().applied.state, "enabled");
});
test("failed status read stays unknown without authorizing replay", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    edit.uncertain(packet.token, "Update result unavailable.");
    const check = edit.check();
    edit.uncertain(check.token, "Status is still unavailable.");
    assert.equal(edit.snapshot().phase, "unknown");
    assert.throws(() => edit.begin(mutation(2)));
});
test("a verified uncommitted result permits a fresh explicit request, never identity reuse", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    edit.uncertain(packet.token, "Connection unavailable.");
    const check = edit.check();
    edit.notCommitted(check.token);
    assert.equal(edit.snapshot().phase, "error");
    assert.throws(() => edit.begin(mutation(1)), /already used/);
    edit.cancel();
    assert.equal(edit.snapshot().phase, "view");
});
test("revoke keeps enabled as last applied until exact revised result is confirmed", () => {
    const edit = controls.consent(answerConsent(), source());
    edit.edit({ enabled: false, categories: [] });
    const packet = edit.begin(mutation(1));
    assert.equal(edit.snapshot().applied.state, "enabled");
    const revoked = { ...answerConsent(), revision: 2, state: "revoked", categories: [], revokedAt: samples.at };
    edit.accept(packet.token, revoked);
    assert.equal(edit.snapshot().applied.state, "revoked");
});
test("retired personal control and view factories reject before constructing any editor or packet", () => {
    const original = samples.makeAssessment(true), before = structuredClone(original);
    for (const input of [undefined, {}, { interactionRef: original.interactionRef, basis: original.basis, checkId: original.checkId, latestPersonal: original }]) {
        assert.throws(() => controls.feedback(input), error => error.code === "PERSONAL_FEEDBACK_RETIRED");
    }
    let accessed = false;
    assert.throws(() => mountPersonalFeedback({ get ownerDocument() { accessed = true; return null; } }, {}),
        error => error.code === "PERSONAL_FEEDBACK_RETIRED");
    assert.equal(accessed, false);
    assert.deepEqual(original, before);
});
test("old async result cannot repopulate consent after deletion/source/consent invalidation", () => {
    for (const reason of ["Collected activity was deleted.", "Evidence permission changed.", "The source changed."]) {
        const edit = consent();
        edit.edit({ enabled: true, categories: ["answer"] });
        const packet = edit.begin(mutation(1));
        edit.invalidate(reason);
        assert.equal(edit.accept(packet.token, answerConsent()), false);
        assert.equal(edit.snapshot().applied, null);
        assert.equal(edit.snapshot().draft, null);
        assert.equal(edit.snapshot().phase, "stale");
        assert.match(edit.snapshot().message, /will not be replayed/);
    }
});
test("snapshot and returned packet mutations do not alter internal pending scope", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    packet.input.categories.push("usage");
    edit.snapshot().draft.categories.push("explicit-authorization");
    edit.accept(packet.token, answerConsent());
    assert.deepEqual(edit.snapshot().applied.categories, ["answer"]);
});
test("cancelling a known rejected draft clears its obsolete operation identity", () => {
    const edit = consent();
    edit.edit({ enabled: true, categories: ["answer"] });
    const packet = edit.begin(mutation(1));
    edit.rejected(packet.token, "Validation rejected the request before dispatch.");
    edit.cancel();
    edit.invalidate("This interaction changed.");
    assert.equal(edit.snapshot().mutationRef, null);
    assert.doesNotMatch(edit.snapshot().message, /may still have completed/);
});
