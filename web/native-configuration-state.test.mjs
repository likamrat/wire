import test from "node:test";
import assert from "node:assert/strict";
import { createNativeConfigurationState } from "./native-configuration-state.mjs";

const authority = { generation: 2, authorizationRevision: 4 };
const offer = (extra = {}) => ({
    schemaVersion: 1, kind: "native-configuration-offer", generation: 2, authorizationRevision: 4,
    intent: "enable", available: true, expectedRevision: null, supportedSurfaces: ["chat", "cowork"],
    values: { surfaces: ["chat", "cowork"], windowDays: 30 }, basis: "native-defaults", blockers: [],
    ...extra,
});

test("explicit Enable uses only offered native values and the original seven-field command basis", () => {
    const model = createNativeConfigurationState(), original = offer();
    model.receive(original);
    assert.equal(model.view(authority).canSubmit, true);
    assert.deepEqual(model.command(authority), {
        schemaVersion: 1, intent: "enable", generation: 2, authorizationRevision: 4,
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    });
    model.edit({ surfaces: ["cowork"], windowDays: 7 });
    original.values.windowDays = 90;
    assert.equal(model.view(authority).dirty, true);
    assert.deepEqual(model.command(authority), {
        schemaVersion: 1, intent: "enable", generation: 2, authorizationRevision: 4,
        expectedRevision: null, surfaces: ["cowork"], windowDays: 7,
    });
});

test("schema2 Enable preserves the original absent global policy stamp without inventing a policy", () => {
    const model = createNativeConfigurationState();
    model.receive(offer({ schemaVersion: 2, globalRevision: null }));
    model.edit({ surfaces: ["cowork"], windowDays: 7 });
    assert.deepEqual(model.command(authority), {
        schemaVersion: 2, intent: "enable", generation: 2, authorizationRevision: 4,
        globalRevision: null, expectedRevision: null, surfaces: ["cowork"], windowDays: 7,
    });
});

test("schema2 global policy changes stale a dirty draft rather than rebasing its original offer", () => {
    const model = createNativeConfigurationState(), original = offer({ schemaVersion: 2, globalRevision: null });
    model.receive(original);
    model.edit({ surfaces: ["chat"], windowDays: 7 });
    model.receive({ ...original, globalRevision: 1 });
    assert.equal(model.view(authority).stale, true);
    assert.deepEqual(model.view(authority).values, { surfaces: ["chat"], windowDays: 7 });
    assert.throws(() => model.command(authority), /Current Microsoft configuration/);
    model.cancel();
    assert.equal(model.command(authority).globalRevision, 1);
});

test("schema2 Save retains every original authority stamp and requires the exact schema-specific shape", () => {
    const original = offer({ schemaVersion: 2, globalRevision: 3, intent: "save", expectedRevision: 2,
        basis: "committed-native" });
    for (const change of [
        { schemaVersion: 1 }, { globalRevision: null }, { globalRevision: 4 },
        { generation: 3 }, { authorizationRevision: 5 }, { expectedRevision: 3 },
    ]) {
        const model = createNativeConfigurationState();
        model.receive(original);
        model.edit({ surfaces: ["chat"], windowDays: 7 });
        model.receive(structuredClone(original));
        assert.deepEqual(model.command(authority), {
            schemaVersion: 2, intent: "save", generation: 2, authorizationRevision: 4,
            globalRevision: 3, expectedRevision: 2, surfaces: ["chat"], windowDays: 7,
        });
        const replacement = { ...original, ...change };
        if (replacement.schemaVersion === 1) delete replacement.globalRevision;
        model.receive(replacement);
        assert.equal(model.view(authority).stale, true);
        assert.throws(() => model.command(authority), /Current Microsoft configuration/);
    }
    const model = createNativeConfigurationState();
    for (const globalRevision of [undefined, 0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => model.decode({ ...original, globalRevision }), TypeError);
    }
    const missing = { ...original };
    delete missing.globalRevision;
    assert.throws(() => model.decode(missing), TypeError);
    assert.throws(() => model.decode({ ...original, schemaVersion: 1 }), TypeError);
    assert.throws(() => model.decode({ ...original, schemaVersion: 3 }), TypeError);
    assert.throws(() => model.decode({ ...original, paused: false }), TypeError);
    const serialized = Function(`return (${createNativeConfigurationState.toString()})`)()();
    serialized.receive(original);
    serialized.edit({ surfaces: ["chat"], windowDays: 7 });
    assert.equal(serialized.command(authority).globalRevision, 3);
});

test("polling preserves edits and changed offers cannot silently rebase their authority", () => {
    const model = createNativeConfigurationState(), original = offer();
    model.receive(original);
    model.edit({ surfaces: ["cowork"], windowDays: 7 });
    model.receive(structuredClone(original));
    assert.equal(model.command(authority).windowDays, 7);
    model.receive(offer({ intent: "save", authorizationRevision: 5, expectedRevision: 2,
        basis: "committed-native", values: { surfaces: ["chat"], windowDays: 90 } }));
    assert.deepEqual(model.view(authority).values, { surfaces: ["cowork"], windowDays: 7 });
    assert.equal(model.view(authority).stale, true);
    assert.equal(model.view(authority).canSubmit, false);
    assert.throws(() => model.command(authority), /Current Microsoft configuration/);
    model.cancel();
    assert.equal(model.view(authority).stale, false);
    assert.equal(model.view(authority).canSubmit, false, "Unchanged Save must not dispatch.");
    model.edit({ surfaces: ["cowork"], windowDays: 7 });
    assert.deepEqual(model.command({ ...authority, authorizationRevision: 5 }), {
        schemaVersion: 1, intent: "save", generation: 2, authorizationRevision: 5,
        expectedRevision: 2, surfaces: ["cowork"], windowDays: 7,
    });
});

test("closed native offers distinguish unavailable account, identity and configured access", () => {
    const model = createNativeConfigurationState();
    for (const code of ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED", "NATIVE_CONFIGURATION_IDENTITY_REQUIRED"]) {
        model.receive(offer({ available: false, blockers: [code] }));
        assert.equal(model.view(authority).canSubmit, false);
    }
    const saved = offer({ intent: "save", basis: "committed-native", expectedRevision: 3,
        values: { surfaces: ["chat"], windowDays: 45 }, available: false, blockers: ["NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE"] });
    model.receive(saved);
    assert.deepEqual(model.view(authority).values, saved.values);
    for (const alter of [
        value => { value.paused = false; },
        value => { value.accountRef = "not-client-authority"; },
        value => { value.values.windowDays = 90; },
        value => { value.blockers = ["ACCOUNT_REQUIRED"]; value.available = false; },
        value => { value.blockers = ["NATIVE_CONFIGURATION_ACCESS_UNAVAILABLE"]; value.available = false; },
        value => { value.available = false; },
    ]) {
        const invalid = offer();
        alter(invalid);
        assert.throws(() => model.decode(invalid), TypeError);
    }
});

test("withdrawal or newer access removes configure permission without adopting another basis", () => {
    const model = createNativeConfigurationState();
    model.receive(offer());
    assert.equal(model.view({ ...authority, authorizationRevision: 5 }).canSubmit, false);
    assert.equal(model.view({ ...authority, generation: 3 }).canSubmit, false);
    assert.equal(model.view(null).canSubmit, false);
    model.edit({ surfaces: ["chat"], windowDays: 7 });
    model.receive(undefined);
    assert.equal(model.view(authority).canSubmit, false);
    assert.equal(model.view(authority).stale, true);
    assert.equal(model.view(authority).needsRead, true);
    model.withdraw();
    assert.equal(model.view(authority).present, false);
    assert.equal(model.view(authority).values, null);
    assert.equal(model.view(authority).dirty, false);
    assert.throws(() => model.command(authority), /Current Microsoft configuration/);
});

test("incomplete form edits stay visible with explicit validation and never become a command", () => {
    const model = createNativeConfigurationState();
    model.receive(offer());
    model.edit({ surfaces: [], windowDays: 30 });
    assert.equal(model.view(authority).valid, false);
    assert.equal(model.view(authority).canSubmit, false);
    assert.match(model.view(authority).validation, /Select at least one/);
    model.edit({ surfaces: ["chat"], windowDays: 0 });
    assert.match(model.view(authority).validation, /1 to 90/);
    assert.throws(() => model.command(authority));
    model.edit({ surfaces: ["chat"], windowDays: 45 });
    assert.equal(model.view(authority).validation, "");
    assert.equal(model.command(authority).windowDays, 45);
});

test("a malformed replacement offer withdraws the previous command without discarding edits", () => {
    const model = createNativeConfigurationState();
    model.receive(offer());
    model.edit({ surfaces: ["cowork"], windowDays: 7 });
    assert.throws(() => model.receive({ ...offer(), paused: false }), TypeError);
    assert.equal(model.view(authority).canSubmit, false);
    assert.equal(model.view(authority).needsRead, true);
    assert.deepEqual(model.view(authority).values, { surfaces: ["cowork"], windowDays: 7 });
    assert.throws(() => model.command(authority), /Current Microsoft configuration/);
    model.receive(offer());
    assert.equal(model.view(authority).stale, true);
    assert.equal(model.view(authority).canSubmit, false);
    model.cancel();
    assert.equal(model.view(authority).canSubmit, true);
});
