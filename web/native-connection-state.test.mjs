import test from "node:test";
import assert from "node:assert/strict";
import { createNativeConnectionState } from "./native-connection-state.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const api = createBoardTransport("a".repeat(64), () => {}, {
    schemaVersion: 1, mode: "unbound", runtimeId: id(1),
});
const status = (generation, state, actions) => ({ generation, microsoft: { state, reason: null, actions } });
const receipt = (operation, outcome = "completed", reason = null) => ({
    operationId: operation.id, action: operation.action, generation: operation.generation + 1,
    outcome, reason, revocation: null,
});

test("an explicit advertised connection intent is registered once and requires its own receipt", () => {
    const owner = Object.freeze({});
    const model = createNativeConnectionState({ isOwnerCurrent: value => value === owner,
        decodeReceipt: api.decodeMicrosoftReceipt });
    const current = status(1, "disconnected", ["microsoft-connect"]);
    const expected = model.snapshot(current, owner).intent;
    assert.equal(expected.kind, "command");
    assert.equal(expected.action, "microsoft-connect");
    const operation = model.begin(expected, current, owner, id(2));
    assert.equal(operation.id, id(2));
    assert.equal(model.snapshot(current, owner).phase, "working");
    assert.equal(model.begin(expected, current, owner, id(3)), null);
    assert.equal(model.received(operation, receipt(operation)), true);
    model.finished(operation);
    assert.equal(model.snapshot(status(2, "connected", ["microsoft-connect"]), owner).pending.length, 0);
});

test("advertised Cancel can interrupt Connect without replacing its original receipt identity", () => {
    const owner = Object.freeze({});
    const model = createNativeConnectionState({ isOwnerCurrent: value => value === owner,
        decodeReceipt: api.decodeMicrosoftReceipt });
    const initial = status(1, "disconnected", ["microsoft-connect"]);
    const connect = model.begin(model.snapshot(initial, owner).intent, initial, owner, id(2));
    const signingIn = status(2, "signing-in", ["microsoft-cancel"]);
    const intent = model.snapshot(signingIn, owner).intent;
    assert.equal(intent.action, "microsoft-cancel");
    const cancel = model.begin(intent, signingIn, owner, id(3));
    assert.equal(model.snapshot(signingIn, owner).pending.length, 2);
    assert.equal(model.snapshot(signingIn, owner).intent, null);
    assert.equal(model.received(cancel, receipt(cancel)), true);
    model.finished(cancel);
    assert.equal(model.snapshot(status(3, "disconnected", ["microsoft-connect"]), owner).intent, null);
    assert.equal(model.received(connect, receipt(connect, "cancelled", "cancelled")), true);
    model.finished(connect);
    assert.equal(model.snapshot(status(3, "disconnected", ["microsoft-connect"]), owner).pending.length, 0);
});

test("a received operation generation blocks stale controls but does not leak into a replacement owner", () => {
    const first = Object.freeze({}), second = Object.freeze({});
    let owner = first;
    const model = createNativeConnectionState({ isOwnerCurrent: value => value === owner,
        decodeReceipt: api.decodeMicrosoftReceipt });
    const initial = status(1, "disconnected", ["microsoft-connect"]);
    const operation = model.begin(model.snapshot(initial, owner).intent, initial, owner, id(2));
    model.received(operation, receipt(operation));
    model.finished(operation);
    assert.equal(model.snapshot(initial, owner).intent, null);
    assert.equal(model.snapshot(status(2, "connected", ["microsoft-connect"]), owner).intent.action, "microsoft-connect");
    owner = second;
    assert.equal(model.snapshot(status(0, "disconnected", ["microsoft-connect"]), owner).intent.generation, 0);
});

test("lost or unresolved replies allow only the original owner's receipt read, never another Connect", () => {
    const first = Object.freeze({}), second = Object.freeze({});
    let owner = first;
    const model = createNativeConnectionState({ isOwnerCurrent: value => value === owner,
        decodeReceipt: api.decodeMicrosoftReceipt });
    const initial = status(1, "disconnected", ["microsoft-connect"]);
    const operation = model.begin(model.snapshot(initial, owner).intent, initial, owner, id(2));
    model.failed(operation);
    model.finished(operation);
    const connected = status(2, "connected", ["microsoft-connect"]);
    for (const value of [null, receipt(operation, "pending"), receipt(operation, "ambiguous", "restart-required")]) {
        const intent = model.snapshot(connected, owner).intent;
        assert.deepEqual(intent, { kind: "receipt", id: operation.id, owner });
        assert.equal(model.begin(intent, connected, owner), operation);
        assert.equal(model.received(operation, value), false);
        model.finished(operation);
    }
    assert.throws(() => model.received(operation, { ...receipt(operation), operationId: id(3) }), TypeError);
    owner = second;
    assert.equal(model.snapshot(connected, owner).phase, "owner-lost");
    assert.equal(model.snapshot(connected, owner).intent, null);
    assert.equal(model.received(operation, receipt(operation)), false);
    assert.equal(model.snapshot(connected, owner).pending[0].id, operation.id);
});

test("confirmed pre-dispatch rejection permits a new deliberate UUID, while forged operation handles do not settle", () => {
    const owner = Object.freeze({});
    const model = createNativeConnectionState({ isOwnerCurrent: value => value === owner,
        decodeReceipt: api.decodeMicrosoftReceipt });
    const current = status(1, "disconnected", ["microsoft-connect"]);
    const operation = model.begin(model.snapshot(current, owner).intent, current, owner, id(2));
    assert.equal(model.received({ ...operation }, receipt(operation)), false);
    model.failed(operation, { rejected: true });
    model.finished(operation);
    assert.equal(model.snapshot(current, owner).error.code, "not-started");
    const next = model.begin(model.snapshot(current, owner).intent, current, owner, id(3));
    assert.notEqual(next.id, operation.id);
    assert.equal(model.snapshot(current, owner).pending.length, 1);
});

test("serialized native state rejects a stale gesture instead of changing the requested action", () => {
    const factory = Function(`return (${createNativeConnectionState.toString()});`)();
    const owner = Object.freeze({});
    const model = factory({ isOwnerCurrent: value => value === owner, decodeReceipt: api.decodeMicrosoftReceipt });
    const initial = status(1, "disconnected", ["microsoft-connect"]);
    const expected = model.snapshot(initial, owner).intent;
    assert.equal(model.begin(expected, status(2, "signing-in", ["microsoft-cancel"]), owner, id(2)), null);
    assert.equal(model.snapshot(initial, owner).pending.length, 0);
    assert.equal(model.snapshot(initial, owner).error.code, "changed");
    const asyncOwner = factory({ isOwnerCurrent: async () => true, decodeReceipt: api.decodeMicrosoftReceipt });
    assert.equal(asyncOwner.snapshot(initial, owner).intent, null);
});
