import test from "node:test";
import assert from "node:assert/strict";
import { createSourceCollectionState } from "./source-collection-state.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { createNativeConfigurationState } from "./native-configuration-state.mjs";

const bootstrap = { schemaVersion: 1, mode: "enforced", runtimeId: "00000000-0000-4000-8000-000000000001",
    maxWaitMs: 1000, freshnessMs: 5000, collectionMode: "source-aware" };
const access = { ...bootstrap, readable: true, state: { generation: 2, authorizationRevision: 4 } };
const create = value => createSourceCollectionState({ bootstrap: value, collectionStatus: createCollectionStatus(),
    createNativeConfigurationState });
// Protocol-only metadata: no conversations, messages, captures or provider records.
const status = () => ({
    schemaVersion: 1, kind: "source-aware-collection", generation: 2, authorizationRevision: 4,
    global: { state: "legacy-compatible", revision: null, actions: ["pause", "resume"] },
    github: { status: { state: "disconnected", connected: false, config: null, configVersion: null, revision: 0,
        deletionVersion: 0, artifactRevision: 0 }, actions: ["configure"] },
    microsoft: { status: {
        schemaVersion: 1, kind: "native-account-unavailable", reason: "microsoft-account-not-configured",
        generation: 2, authorizationRevision: 4, revision: 7, rawWriterAdmission: "withheld",
        configured: false, configuration: null, actions: [], blockers: ["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"],
    }, configurationOffer: {
        schemaVersion: 2, kind: "native-configuration-offer", generation: 2, authorizationRevision: 4,
        globalRevision: null, intent: "enable", available: false, expectedRevision: null,
        supportedSurfaces: ["chat", "cowork"], values: { surfaces: ["chat", "cowork"], windowDays: 30 },
        basis: "native-defaults", blockers: ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED"],
    }, actions: [] },
});

test("Copilot-only controls admit only GitHub and preserved global policy, never native UI or injected grants", () => {
    const descriptor = { ...bootstrap, collectionMode: "copilot-only" }, observed = { ...access, ...descriptor };
    const model = create(descriptor), { microsoft, ...value } = status();
    assert.equal(model.active, false);
    assert.equal(model.controlsActive, true);
    model.receive(value, observed);
    assert.equal(model.view(observed).current, true);
    assert.deepEqual(model.view(observed).actions.microsoft, []);
    for (const endpoint of ["enroll", "configure", "enabled", "now"]) {
        assert.throws(() => model.authorize("/api/collection/microsoft/" + endpoint, {}, observed));
    }
    assert.throws(() => model.receive({ ...value, microsoft }, observed));
    assert.equal(model.view(observed).current, false);
    model.receive(value, observed);
    assert.equal(model.view(access).current, false, "An incubation descriptor cannot replace the release descriptor.");
});

test("only explicit enforced bootstrap activates source-aware collection and starts without authority", () => {
    const state = create(bootstrap);
    assert.equal(state.active, true);
    assert.equal(state.view(access).current, false);
    assert.deepEqual(state.view(access).actions, { global: [], github: [], microsoft: [] });
    const { collectionMode, ...legacy } = bootstrap;
    assert.equal(create(legacy).active, false);
    assert.equal(create({ ...legacy, nativeControl: {} }).active, false);
    for (const invalid of [{ ...bootstrap, mode: "unbound" }, { ...bootstrap, collectionMode: null },
        { ...bootstrap, freshnessMs: 6000 }]) {
        const model = create(invalid);
        assert.equal(model.active, true, "A malformed explicit marker must not become legacy mode.");
        assert.equal(model.view(access).current, false);
        assert.throws(() => model.receive({}, access), /Source-aware collection/);
    }
});

test("composite decoding preserves global absence and independent advertised actions", () => {
    const model = create(bootstrap), input = status();
    model.receive(input, access);
    assert.equal(model.view(access).current, true);
    assert.deepEqual(model.view(access).status, input);
    assert.deepEqual(model.view(access).actions, { global: ["pause", "resume"], github: ["configure"], microsoft: [] });
    input.github.actions.push("collect-now");
    assert.deepEqual(model.view(access).actions.github, ["configure"], "Callers cannot mutate admitted authority.");
    const snapshot = model.view(access);
    snapshot.status.global.paused = false;
    assert.equal(Object.hasOwn(model.view(access).status.global, "paused"), false);
});

test("older composite responses cannot restore authority after a newer status or a failed read", () => {
    const model = create(bootstrap), newer = status();
    newer.authorizationRevision = newer.microsoft.status.authorizationRevision = newer.microsoft.configurationOffer.authorizationRevision = 5;
    model.receive(newer, access);
    assert.throws(() => model.receive(status(), access), /Source-aware collection/);
    assert.equal(model.view(access).current, false);
    model.receive(newer, access);
    model.withdraw();
    assert.throws(() => model.receive(status(), access), /Source-aware collection/);
    model.receive(newer, access);
    const older = structuredClone(newer);
    older.microsoft.status.revision--;
    assert.throws(() => model.receive(older, access), /Source-aware collection/);
    assert.equal(model.view(access).current, false);
});

test("lost or changed activated access withdraws actions until a fresh composite is admitted", () => {
    for (const change of [
        { collectionMode: undefined }, { collectionMode: "native" }, { mode: "unbound" },
        { runtimeId: "00000000-0000-4000-8000-000000000002" }, { readable: false },
        { state: { generation: 3, authorizationRevision: 5 } }, { state: { generation: 2, authorizationRevision: 5 } },
    ]) {
        const model = create(bootstrap);
        model.receive(status(), access);
        assert.equal(model.view({ ...access, ...change }).current, false);
        assert.equal(model.view(access).current, false, "A recovered access view alone cannot revive old composite authority.");
        model.receive(status(), access);
        assert.equal(model.view(access).current, true);
    }
});

test("missing, malformed and mixed-authority composites fail closed instead of using GitHub defaults", () => {
    const mutations = [
        value => undefined, value => null, value => ({}), value => ({ nativeControl: value.microsoft.status }),
        value => ({ ...value, extra: true }), value => ({ ...value, schemaVersion: 2 }),
        value => ({ ...value, global: { ...value.global, paused: false } }),
        value => ({ ...value, global: { state: "committed", revision: 0, paused: false, actions: [] } }),
        value => ({ ...value, global: { state: "committed", revision: 1, paused: true, actions: ["pause"] } }),
        value => ({ ...value, global: { ...value.global, actions: ["pause", "pause"] } }),
        value => ({ ...value, github: { ...value.github, actions: ["collect-now"] } }),
        value => ({ ...value, github: { ...value.github, status: {} } }),
        value => ({ ...value, microsoft: { ...value.microsoft, actions: ["configure"] } }),
        value => ({ ...value, microsoft: { ...value.microsoft, actions: ["collect-now"] } }),
        value => ({ ...value, microsoft: { ...value.microsoft, actions: ["resume"] } }),
        value => ({ ...value, microsoft: { ...value.microsoft, configurationOffer: {
            ...value.microsoft.configurationOffer, globalRevision: 1 } } }),
        value => ({ ...value, microsoft: { ...value.microsoft, status: { ...value.microsoft.status, generation: 3 } } }),
        value => ({ ...value, microsoft: { ...value.microsoft, status: { ...value.microsoft.status, authorizationRevision: 5 } } }),
        value => ({ ...value, microsoft: { ...value.microsoft, configurationOffer: {
            ...value.microsoft.configurationOffer, authorizationRevision: 5 } } }),
    ];
    for (const mutate of mutations) {
        const model = create(bootstrap);
        model.receive(status(), access);
        assert.throws(() => model.receive(mutate(status()), access), TypeError);
        assert.deepEqual(model.view(access).actions, { global: [], github: [], microsoft: [] });
    }
});

test("global Pause and GitHub interval Pause do not remove explicitly advertised manual GitHub collection", () => {
    const model = create(bootstrap), input = status();
    input.global = { state: "committed", revision: 1, paused: true, actions: ["resume"] };
    input.microsoft.configurationOffer.globalRevision = 1;
    input.github = { status: { ...input.github.status, state: "paused", configVersion: "a".repeat(64),
        config: { approved: true, enabled: false, windowDays: 7, pollSeconds: 5, appDbPath: "", sessionRoot: "" } },
    actions: ["configure", "set-interval", "collect-now"] };
    model.receive(input, access);
    assert.deepEqual(model.view(access).actions.github, input.github.actions);
    assert.deepEqual(model.view(access).actions.microsoft, []);
    const serialized = Function(`return (${createSourceCollectionState.toString()})`)();
    const other = serialized({ bootstrap, collectionStatus: createCollectionStatus(), createNativeConfigurationState });
    other.receive(input, access);
    assert.deepEqual(other.view(access), model.view(access));
});

test("global commands require deliberate advertised intent and the current nullable original stamp", () => {
    const model = create(bootstrap);
    model.receive(status(), access);
    const command = { schemaVersion: 1, enabled: false, generation: 2, authorizationRevision: 4, expectedRevision: null };
    assert.doesNotThrow(() => model.authorize("/api/collection/global/enabled", command, access));
    for (const changed of [{ ...command, expectedRevision: 1 }, { ...command, enabled: 0 },
        { ...command, generation: 3 }, { ...command, authorizationRevision: 3 }, { ...command, paused: true }]) {
        assert.throws(() => model.authorize("/api/collection/global/enabled", changed, access), TypeError);
    }
    model.withdraw();
    assert.throws(() => model.authorize("/api/collection/global/enabled", command, access), TypeError);
});

test("a newly transport-verified source-aware runtime requires fresh status and has independent counters", () => {
    const model = create(bootstrap);
    model.receive(status(), access);
    const restarted = { ...access, runtimeId: "00000000-0000-4000-8000-000000000002",
        state: { generation: 0, authorizationRevision: 0 } };
    assert.equal(model.view(restarted).current, false);
    const input = status();
    input.generation = input.microsoft.status.generation = input.microsoft.configurationOffer.generation = 0;
    input.authorizationRevision = input.microsoft.status.authorizationRevision = input.microsoft.configurationOffer.authorizationRevision = 0;
    model.receive(input, restarted);
    assert.equal(model.view(restarted).current, true);
    assert.throws(() => model.receive(input, { ...restarted, collectionMode: undefined }), TypeError);
});

test("source commands keep GitHub interval, Microsoft configuration and native Pause authorities separate", () => {
    const input = status();
    input.github = { status: { ...input.github.status, state: "paused", configVersion: "a".repeat(64),
        config: { approved: true, enabled: false, windowDays: 7, pollSeconds: 5, appDbPath: "", sessionRoot: "" } },
    actions: ["configure", "set-interval", "collect-now"] };
    input.microsoft.status = {
        schemaVersion: 1, kind: "native-screened-retention", contractVersion: "m365-native-screened-observations-v1",
        rawWriterAdmission: "withheld", configured: true, accountRef: "b".repeat(64),
        generation: 2, revision: 7, configuration: {
            configurationRevision: 1, privacyRevision: 1, policy: "native-screened-source-observations-v1",
            settings: { paused: false, windowDays: 7 }, surfaces: ["chat"],
        }, actions: ["collect-now"], blockers: [], receipt: null, receiptQuery: null,
    };
    input.microsoft.configurationOffer = { ...input.microsoft.configurationOffer, intent: "save", available: true,
        expectedRevision: 1, basis: "committed-native", values: { surfaces: ["chat"], windowDays: 7 }, blockers: [] };
    input.microsoft.actions = ["configure", "collect-now", "pause"];
    const model = create(bootstrap);
    model.receive(input, access);
    const configure = { schemaVersion: 2, intent: "save", generation: 2, authorizationRevision: 4,
        globalRevision: null, expectedRevision: 1, surfaces: ["cowork"], windowDays: 30 };
    const nativeBasis = { generation: 2, accountRef: "b".repeat(64), configurationRevision: 1, privacyRevision: 1, globalRevision: null };
    const githubBasis = { generation: 2, configVersion: "a".repeat(64) };
    const valid = [
        ["/api/collection/configure", { ...input.github.status.config, expectedConfigVersion: "a".repeat(64) }],
        ["/api/collection/enabled", { enabled: true, expectedConfigVersion: "a".repeat(64) }],
        ["/api/collection/now", {}],
        ["/api/collection/now", { expectedBasis: githubBasis }],
        ["/api/collection/microsoft/configure", configure],
        ["/api/collection/microsoft/now", { operationId: bootstrap.runtimeId }],
        ["/api/collection/microsoft/now", { operationId: bootstrap.runtimeId, expectedBasis: nativeBasis }],
        ["/api/collection/microsoft/now", { operationId: bootstrap.runtimeId, deadline: Date.now() + 30000, expectedBasis: nativeBasis }],
        ["/api/collection/microsoft/enabled", { enabled: false, expectedNativeRevision: 4 }],
    ];
    for (const [route, body] of valid) assert.doesNotThrow(() => model.authorize(route, body, access), route);
    for (const deadline of [null, "future", 0, Date.now() - 1, Date.now() + 600000]) {
        assert.throws(() => model.authorize("/api/collection/microsoft/now",
            { operationId: bootstrap.runtimeId, deadline }, access), TypeError);
    }
    for (const [route, body] of [
        ["/api/collection/configure", configure], ["/api/collection/microsoft/configure", { ...configure, schemaVersion: 1 }],
        ["/api/collection/microsoft/configure", { ...configure, globalRevision: 1 }],
        ["/api/collection/microsoft/configure", { ...configure, expectedRevision: 2 }],
        ["/api/collection/microsoft/configure", { ...configure, surfaces: [] }],
        ["/api/collection/microsoft/configure", { ...configure, paused: false }],
        ["/api/collection/microsoft/enabled", { enabled: true, expectedNativeRevision: 4 }],
        ["/api/collection/microsoft/enabled", { enabled: false, expectedNativeRevision: 3 }],
        ["/api/collection/microsoft/now", {}], ["/api/collection/now", { operationId: bootstrap.runtimeId }],
        ["/api/collection/now", { expectedBasis: { ...githubBasis, generation: 1 } }],
        ["/api/collection/now", { expectedBasis: { ...githubBasis, configVersion: "c".repeat(64) } }],
        ["/api/collection/microsoft/now", { operationId: bootstrap.runtimeId, expectedBasis: { ...nativeBasis, configurationRevision: 2 } }],
        ["/api/collection/microsoft/now", { operationId: bootstrap.runtimeId, expectedBasis: { ...nativeBasis, authorizationRevision: 4 } }],
        ["/api/collection/enabled", { enabled: true, expectedNativeRevision: 4 }],
        ["/api/collection/enabled", { enabled: true, expectedConfigVersion: null }],
    ]) assert.throws(() => model.authorize(route, body, access), TypeError, route);
    input.github.actions = [];
    model.receive(input, access);
    assert.throws(() => model.authorize("/api/collection/now", {}, access), TypeError);
    input.microsoft.configurationOffer.values.windowDays = 8;
    assert.throws(() => model.receive(input, access), TypeError, "An offer cannot disagree with its committed configuration.");
});
