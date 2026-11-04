import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactEligibilityState } from "./artifact-eligibility-state.mjs";

const target = { artifactKind: "report", artifactId: "export-00000000-0000-4000-8000-000000000001" };
const stamp = () => ({ target, revision: 7, publication: {}, owner: {}, authorizationRevision: 3 });

test("eligibility belongs only to the original displayed target, revision, owner and publication", () => {
    const model = createArtifactEligibilityState(), current = stamp(), ticket = model.begin(current);
    model.receive(ticket, { artifact: { bundleId: target.artifactId, kind: "report", canDelete: true } }, current);
    assert.equal(model.allowed(current), true);
    assert.equal(model.allowed({ ...current, revision: 8 }), false);
    assert.equal(model.allowed(current), false, "Returning to old metadata does not restore a retired hint.");
    for (const change of [{ publication: {} }, { owner: {} }, { authorizationRevision: 4 },
        { target: { ...target, artifactId: "export-00000000-0000-4000-8000-000000000002" } }]) {
        model.receive(model.begin(current), { artifact: { bundleId: target.artifactId, kind: "report", canDelete: true } }, current);
        assert.equal(model.allowed({ ...current, ...change }), false);
    }
});

test("late eligibility cannot erase a newer grant and malformed or negative replies never authorize", () => {
    const model = createArtifactEligibilityState(), current = stamp(), old = model.begin(current), next = model.begin(current);
    const yes = { artifact: { bundleId: target.artifactId, kind: "report", canDelete: true } };
    model.receive(next, yes, current);
    assert.equal(model.receive(old, yes, current), false);
    assert.equal(model.allowed(current), true);
    model.receive(model.begin(current), { artifact: { ...yes.artifact, canDelete: false } }, current);
    assert.equal(model.allowed(current), false);
    assert.throws(() => model.receive(model.begin(current), { artifact: { ...yes.artifact, account: "forbidden" } }, current), TypeError);
    assert.equal(model.allowed(current), false);
});

test("qualified report counts preserve deletion eligibility without treating missing counts as zero", () => {
    const model = createArtifactEligibilityState(), current = stamp();
    const artifact = { bundleId: target.artifactId, kind: "report", canDelete: true, requestGroupCount: 1 };
    for (const nativeConversationCount of [0, 2]) {
        assert.equal(model.receive(model.begin(current), { artifact: { ...artifact, nativeConversationCount } }, current), true);
        assert.equal(model.allowed(current), true);
    }
    assert.equal(model.receive(model.begin(current), { artifact }, current), true);
    for (const nativeConversationCount of [null, -1, 0.5, "2"]) {
        assert.throws(() => model.receive(model.begin(current), { artifact: { ...artifact, nativeConversationCount } }, current), TypeError);
        assert.equal(model.allowed(current), false);
    }
});
