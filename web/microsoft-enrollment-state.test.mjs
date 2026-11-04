import test from "node:test";
import assert from "node:assert/strict";
import { createMicrosoftEnrollmentState } from "./microsoft-enrollment-state.mjs";

const available = generation => ({ schemaVersion: 1, phase: "available", generation, actions: ["prepare"], reason: null });
const prepared = generation => ({ schemaVersion: 1, phase: "prepared", generation, actions: [], reason: "source-already-configured" });
const operationId = "00000000-0000-4000-8000-000000000022";

test("enrollment requires a current offer and explicit intent, not an account guess", () => {
    const state = createMicrosoftEnrollmentState();
    assert.equal(state.view(7).canPrepare, false);
    state.receive(available(7), 7);
    assert.equal(state.view(7).canPrepare, true);
    assert.equal(state.view(8).canPrepare, false);
    assert.throws(() => state.begin(8, operationId), /current Microsoft connection/);
    const command = state.begin(7, operationId);
    assert.deepEqual(command, { schemaVersion: 2, generation: 7, operationId });
    assert.equal(state.view(7).canPrepare, false);
    state.completed(command, prepared(7), 7);
    assert.equal(state.view(7).phase, "prepared");
    assert.equal(state.view(7).canPrepare, false);
});

test("a new generation cannot settle a retired preparation or replay an uncertain write", () => {
    const state = createMicrosoftEnrollmentState();
    state.receive(available(7), 7);
    const command = state.begin(7, operationId);
    assert.equal(state.view(8).canPrepare, false);
    state.withdraw();
    state.receive(available(8), 8);
    assert.equal(state.completed(command, prepared(8), 8), false);
    state.failed(command);
    assert.equal(state.view(8).uncertain, true);
    assert.equal(state.view(8).canPrepare, false);
    state.receive(prepared(8), 8);
    assert.equal(state.view(8).phase, "prepared");
    assert.equal(state.view(8).uncertain, true, "Current prepared status is not the original operation receipt.");
});

test("malformed offers withdraw preparation and known rejection alone permits a fresh deliberate attempt", () => {
    const state = createMicrosoftEnrollmentState();
    state.receive(available(7), 7);
    for (const value of [{ ...available(7), identity: "not-an-authority" },
        { ...prepared(7), actions: ["prepare"] }, { ...available(7), reason: "enrollment-unavailable" }]) {
        assert.throws(() => state.receive(value, 7), TypeError);
        assert.equal(state.view(7).canPrepare, false);
        state.receive(available(7), 7);
    }
    const command = state.begin(7, operationId);
    state.failed(command, { rejected: true });
    assert.equal(state.view(7).uncertain, false);
    assert.equal(state.view(7).canPrepare, true);
});
