import test from "node:test";
import assert from "node:assert/strict";
import { createAssessmentControls } from "../web/assessment-controls.mjs";
import { contract, samples } from "./assessment-ui-fixtures.mjs";

const controls = createAssessmentControls(contract);
const mutation = n => samples.id("mutation", n);
const source = () => ({
    adapter: "copilot-local-events-v1", sourceRevision: 7,
    sourceConfigRef: samples.id("config"), sourceConfigRevision: 1,
});
const consent = () => controls.consent(contract.defaultConsent(), source());
const feedback = () => controls.feedback({
    interactionRef: samples.id("interaction"), basis: samples.basis(), checkId: "semantic-answer-correctness",
});
const answerConsent = () => ({ ...samples.enabledConsent(), categories: ["answer"] });
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
    const edit = feedback();
    edit.edit({ verdict: "pass", withdraw: false });
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
test("feedback is optional and has no default verdict or required review step", () => {
    const edit = feedback();
    assert.equal(edit.snapshot().applied, null);
    assert.equal(edit.snapshot().draft, null);
    assert.throws(() => edit.begin(mutation(1)), /explicit draft/);
});
test("personal feedback preserves exact context and append-only revision chain", () => {
    const edit = feedback();
    edit.edit({ verdict: "pass", withdraw: false });
    const packet = edit.begin(mutation(1));
    contract.validateRequest(packet.action, packet.input);
    const first = samples.makeAssessment(true);
    edit.accept(packet.token, first);
    edit.edit({ verdict: "fail", withdraw: false });
    const secondPacket = edit.begin(mutation(2));
    const second = { ...first, assessmentRef: samples.id("assessment", 3), revision: 2, supersedes: first.assessmentRef, verdict: "fail" };
    edit.accept(secondPacket.token, second);
    assert.equal(first.verdict, "pass");
    assert.equal(edit.snapshot().applied.verdict, "fail");
    assert.equal(edit.snapshot().applied.revision, 2);
});
test("feedback withdrawal never edits the original evidence or automatic verdict", () => {
    const first = samples.makeAssessment(true);
    const edit = controls.feedback({ interactionRef: first.interactionRef, basis: first.basis, checkId: first.checkId, latestPersonal: first });
    edit.edit({ verdict: "unassessed", withdraw: true });
    const packet = edit.begin(mutation(1));
    const withdrawn = { ...first, assessmentRef: samples.id("assessment", 3), revision: 2, supersedes: first.assessmentRef, verdict: "unassessed", withdrawn: true, reason: "user-withdrawn" };
    edit.accept(packet.token, withdrawn);
    assert.equal(edit.snapshot().applied.withdrawn, true);
    assert.equal(first.withdrawn, false);
});
test("automatic execution checks are not optional personal-feedback targets", () => {
    const edit = controls.feedback({ interactionRef: samples.id("interaction"), basis: samples.basis(), checkId: "recorded-tool-success" });
    edit.edit({ verdict: "pass", withdraw: false });
    assert.throws(() => edit.begin(mutation(1)), /invalid-enum/);
});
test("old async result cannot repopulate feedback after deletion/source/consent invalidation", () => {
    for (const reason of ["Collected activity was deleted.", "Evidence permission changed.", "The source changed."]) {
        const edit = feedback();
        edit.edit({ verdict: "pass", withdraw: false });
        const packet = edit.begin(mutation(1));
        edit.invalidate(reason);
        assert.equal(edit.accept(packet.token, samples.makeAssessment(true)), false);
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
test("unrelated, automatic or stale personal feedback cannot initialize the editor", () => {
    const setup = { interactionRef: samples.id("interaction"), basis: samples.basis(), checkId: "semantic-answer-correctness" };
    for (const latestPersonal of [
        samples.makeAssessment(false),
        { ...samples.makeAssessment(true), interactionRef: samples.id("interaction", 2), unitRef: samples.id("interaction", 2) },
        { ...samples.makeAssessment(true), basis: { ...samples.basis(), consentRevision: 1 } },
    ]) assert.throws(() => controls.feedback({ ...setup, latestPersonal }), /current interaction context/);
});
test("cancelling a known rejected draft clears its obsolete operation identity", () => {
    const edit = feedback();
    edit.edit({ verdict: "pass", withdraw: false });
    const packet = edit.begin(mutation(1));
    edit.rejected(packet.token, "Validation rejected the request before dispatch.");
    edit.cancel();
    edit.invalidate("This interaction changed.");
    assert.equal(edit.snapshot().mutationRef, null);
    assert.doesNotMatch(edit.snapshot().message, /may still have completed/);
});
test("feedback after an unexposed withdrawn revision accepts the backend's next revision", () => {
    const edit = feedback();
    edit.edit({ verdict: "pass", withdraw: false });
    const packet = edit.begin(mutation(3));
    const next = { ...samples.makeAssessment(true), revision: 3, supersedes: samples.id("assessment", 3), assessmentRef: samples.id("assessment", 4) };
    assert.equal(edit.accept(packet.token, next), true);
    assert.equal(edit.snapshot().applied.revision, 3);
});
