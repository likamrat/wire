import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence, readNativeCollectionSettings, readGlobalCollectionGate } from "../lib/native-persistence.mjs";

async function setup(t, { configurationIntents = true, sourceAware = false } = {}) {
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const release = await acquireCollectorLock(context.dataDir);
    let persistence, live = true, dispatched = 0, providerCalls = 0, expectedPoison = false, onSettings;
    const transport = createMicrosoftNativeReadTransport({
        async open() { providerCalls++; },
        async verifyAccount() {
            providerCalls++;
            return { tenantId: "configuration-tenant", subjectId: "configuration-subject", knownAccountMatched: true, chat: true, cowork: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: true, windowDays: 7 },
        ...(sourceAware ? { sourceAware: true, globalCollection: await readGlobalCollectionGate(context) } : {}),
        persistCollectionSettings: (settings, token) => { onSettings?.(settings); return persistence.persistCollectionSettings(settings, token); } });
    persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents });
    const owner = "native-configuration-test-owner", admission = { owner,
        check() { return live ? undefined : false; }, dispatched() { dispatched++; } };
    t.after(async () => {
        persistence.close();
        let failure;
        try { await lifecycle.close(); }
        catch (error) { if (!expectedPoison || error.code !== "storage-failed") failure = error; }
        await release();
        for (const cleanup of cleanups) await cleanup();
        if (failure) throw failure;
    });
    const command = async action => lifecycle.command(owner, { action, operationId: randomUUID(),
        generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
    await command("wire-sign-in");
    const offer = () => persistence.configurationOffer(admission);
    const input = value => ({ schemaVersion: value.schemaVersion, intent: value.intent, generation: value.generation,
        authorizationRevision: value.authorizationRevision, expectedRevision: value.expectedRevision,
        ...(sourceAware ? { globalRevision: value.globalRevision } : {}),
        surfaces: [...value.values.surfaces], windowDays: value.values.windowDays });
    const configure = value => lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays,
        ...(sourceAware ? { globalRevision: value.globalRevision } : {}) },
        admission, (token, guarded) => persistence.configureIntent(value, token, guarded));
    const globalInput = async enabled => {
        const value = await lifecycle.globalCollectionStatus();
        return { schemaVersion: 1, enabled, generation: value.generation, authorizationRevision: value.authorizationRevision,
            expectedRevision: value.globalCollection?.revision ?? null };
    };
    const global = async enabled => {
        const value = await globalInput(enabled);
        return lifecycle.admitGlobalCollection(value, admission, (token, guarded) =>
            persistence.setGlobalCollectionGate({ expectedRevision: value.expectedRevision, paused: !enabled }, token, guarded));
    };
    return { context, lifecycle, persistence, admission, command, offer, input, configure, globalInput, global,
        bytes: () => readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`)),
        get dispatched() { return dispatched; }, get providerCalls() { return providerCalls; },
        revoke() { live = false; }, expectPoison() { expectedPoison = true; }, observeSettings(work) { onSettings = work; } };
}

test("native configuration exposure is opt-in and the unavailable offer uses native policy defaults", async t => {
    const strict = await setup(t, { configurationIntents: false });
    assert.equal(Object.hasOwn(strict.persistence, "configurationOffer"), false);
    assert.equal(Object.hasOwn(strict.persistence, "configureIntent"), false);
    const app = await setup(t), value = await app.offer();
    assert.equal(value.kind, "native-configuration-offer");
    assert.equal(value.available, false);
    assert.equal(value.intent, "enable");
    assert.equal(value.expectedRevision, null);
    assert.equal(value.basis, "native-defaults");
    assert.deepEqual(value.values, { surfaces: ["chat", "cowork"], windowDays: 30 });
    assert.deepEqual(value.supportedSurfaces, ["chat", "cowork"]);
    assert.deepEqual(value.blockers, ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED"]);
    assert.deepEqual(Object.keys(value).sort(), ["schemaVersion", "kind", "generation", "authorizationRevision", "intent",
        "available", "expectedRevision", "supportedSurfaces", "values", "basis", "blockers"].sort());
    assert.equal(app.providerCalls, 0);
    assert.equal(app.dispatched, 0);
    for (const key of ["accountRef", "receipt", "paused"]) assert.equal(Object.hasOwn(value, key), false);
});

test("explicit first Enable atomically configures a paused account and adopts its committed settings", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
    const offered = await app.offer(), before = await loadBoardState(app.context);
    assert.equal(offered.available, true);
    const config = await app.configure({ ...app.input(offered), surfaces: ["cowork"], windowDays: 14 });
    assert.deepEqual(config.settings, { paused: false, windowDays: 14 });
    assert.deepEqual(config.surfaces, ["cowork"]);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 14);
    const saved = await loadBoardState(app.context);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(saved.nativeRetention.accounts.length, 1);
    assert.equal(app.dispatched, 1);
    const next = await app.offer();
    assert.equal(next.intent, "save");
    assert.equal(next.basis, "committed-native");
    assert.deepEqual(next.values, { surfaces: ["cowork"], windowDays: 14 });
    assert.equal((await app.persistence.status()).actions.includes("configure"), false);
    await assert.rejects(app.persistence.configure({ expectedRevision: next.expectedRevision, surfaces: ["chat"], windowDays: 30 },
        app.admission), { code: "NATIVE_RETENTION_CONFIGURATION_INTENT_REQUIRED" });
});

test("later Save preserves committed Pause and works under retained authority after provider expiry", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await app.configure(app.input(await app.offer()));
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const offered = await app.offer(), calls = app.providerCalls;
    assert.equal(offered.intent, "save");
    assert.equal(offered.available, true);
    const saved = await app.configure({ ...app.input(offered), surfaces: ["chat"], windowDays: 21 });
    assert.deepEqual(saved.settings, { paused: true, windowDays: 21 });
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await readNativeCollectionSettings(app.context)).windowDays, 21);
    assert.equal(app.providerCalls, calls);
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
});

test("Resume cannot enroll an unconfigured account in normal intent mode", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    const before = await app.bytes();
    await assert.rejects(app.lifecycle.setNativeCollectionEnabled(true,
        (await app.lifecycle.status()).authorizationRevision, app.admission), { code: "NATIVE_RETENTION_NOT_CONFIGURED" });
    assert.deepEqual(await app.bytes(), before);
    assert.equal((await app.lifecycle.status()).collection, "paused");
});

test("configuration rejects copied tokens, foreign owners, stale offers and browser-only fields", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    const value = app.input(await app.offer()), before = await app.bytes();
    await assert.rejects(app.lifecycle.admitNativeConfiguration(value, app.admission, () => {}));
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, (_token, guarded) => app.persistence.configureIntent(value, {}, guarded)));
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, (token, guarded) => app.persistence.configureIntent(value, token, { ...guarded, owner: "another-configuration-owner" })),
    { code: "NATIVE_RETENTION_CONFIGURATION_OWNER" });
    for (const changed of [{ generation: value.generation - 1 }, { authorizationRevision: value.authorizationRevision - 1 },
        { expectedRevision: 10 }, { paused: false }, { accountRef: "0".repeat(64) }, { schemaVersion: 0 },
        { surfaces: [] }, { surfaces: ["chat", "chat"] }, { surfaces: ["teams"] },
        { windowDays: 0 }, { windowDays: 91 }, { windowDays: "30" }]) {
        await assert.rejects(app.configure({ ...value, ...changed }));
    }
    assert.deepEqual(await app.bytes(), before);
    assert.equal(app.dispatched, 0);
});

test("queued status and Pause observe Enable adoption rather than a stale paused no-op", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    const value = { ...app.input(await app.offer()), windowDays: 14 };
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), tokenEntered = Promise.withResolvers();
    const blocker = exclusiveBoard(app.context, async () => { entered.resolve(); await resume.promise; });
    await entered.promise;
    const enabling = app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, (token, guarded) => { tokenEntered.resolve(); return app.persistence.configureIntent(value, token, guarded); });
    await tokenEntered.promise;
    const queuedStatus = app.lifecycle.status();
    resume.resolve(); await blocker; await enabling;
    const status = await queuedStatus;
    assert.equal(status.collection, "enabled");
    await app.lifecycle.setNativeCollectionEnabled(false, status.authorizationRevision, app.admission);
    assert.deepEqual((await readNativeCollectionSettings(app.context)).paused, true);
    assert.equal((await readNativeCollectionSettings(app.context)).windowDays, 14);
});

test("a post-save callback failure preserves durable configuration and poisons stale runtime authority", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    const value = app.input(await app.offer());
    app.expectPoison();
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, async (token, guarded) => {
            await app.persistence.configureIntent(value, token, guarded);
            throw new Error("Test callback failed after durable save.");
        }));
    assert.equal((await readNativeCollectionSettings(app.context)).paused, false);
    const status = await app.lifecycle.status();
    assert.equal(status.authorization.retained, false);
    assert.equal(status.authorization.microsoftAcquisition, false);
});

test("the authoritative Resume check sees account removal while waiting for the actual board admission", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await app.configure(app.input(await app.offer()));
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), settingsEntered = Promise.withResolvers();
    const blocker = exclusiveBoard(app.context, async (state, save) => {
        entered.resolve(); await resume.promise;
        state.nativeRetention.accounts = [];
        state.nativeRetention.configurationRevision++;
        state.nativeRetention.privacyRevision++;
        state.revision++;
        await save(state);
    });
    await entered.promise;
    app.observeSettings(() => settingsEntered.resolve());
    const enabling = app.lifecycle.setNativeCollectionEnabled(true, (await app.lifecycle.status()).authorizationRevision, app.admission);
    await settingsEntered.promise;
    resume.resolve(); await blocker;
    await assert.rejects(enabling, { code: "NATIVE_RETENTION_NOT_CONFIGURED" });
    assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
});

test("pre-account committed settings supply the offer without becoming an account grant", async t => {
    const app = await setup(t);
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const offered = await app.offer();
    assert.equal(offered.basis, "committed-native");
    assert.equal(offered.expectedRevision, 1);
    assert.equal(offered.values.windowDays, 7);
    assert.equal(offered.available, false);
    assert.equal((await loadBoardState(app.context)).nativeRetention.accounts.length, 0);
    await app.command("microsoft-connect");
    const enabled = await app.configure(app.input(await app.offer()));
    assert.equal(enabled.settings.paused, false);
    assert.equal(enabled.settings.windowDays, 7);
    assert.equal(enabled.configurationRevision, 2);
});

test("a released owner cannot enable collection across an asynchronous board lock gap", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    const value = app.input(await app.offer()), before = await app.bytes();
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), tokenEntered = Promise.withResolvers();
    const blocker = exclusiveBoard(app.context, async () => { entered.resolve(); await resume.promise; });
    await entered.promise;
    const rejected = assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, (token, guarded) => { tokenEntered.resolve(); return app.persistence.configureIntent(value, token, guarded); }));
    await tokenEntered.promise;
    app.revoke(); resume.resolve(); await blocker; await rejected;
    assert.deepEqual(await app.bytes(), before);
    assert.equal(app.dispatched, 0);
});

test("Save refuses a stale runtime Pause pair instead of implicitly resuming committed collection", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await app.configure(app.input(await app.offer()));
    await exclusiveBoard(app.context, async (state, save) => {
        state.nativeRetention.settings.paused = true;
        state.nativeRetention.configurationRevision++;
        state.revision++;
        await save(state);
    });
    const value = app.input(await app.offer()), before = await app.bytes();
    await assert.rejects(app.configure({ ...value, windowDays: 14 }), { code: "NATIVE_RETENTION_CONFIGURATION_CHANGED" });
    assert.deepEqual(await app.bytes(), before);
    assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
});

test("unchanged Save has no disk write and a settled configuration token cannot be reused", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await app.configure(app.input(await app.offer()));
    const value = app.input(await app.offer()), before = await app.bytes(), dispatched = app.dispatched;
    let settled;
    const result = await app.lifecycle.admitNativeConfiguration({ intent: value.intent, windowDays: value.windowDays },
        app.admission, (token, guarded) => { settled = token; return app.persistence.configureIntent(value, token, guarded); });
    assert.deepEqual(await app.bytes(), before);
    assert.equal(app.dispatched, dispatched);
    assert.equal(result.settings.paused, false);
    await assert.rejects(app.persistence.configureIntent(app.input(await app.offer()), settled, app.admission));
});

test("a fresh process restores the offline Save offer without provider work or native configuration writes", async t => {
    const app = await setup(t);
    await app.command("microsoft-connect");
    await app.configure(app.input(await app.offer()));
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
    const generation = (await app.lifecycle.status()).generation, before = await app.bytes();
    app.persistence.close();
    await app.lifecycle.close();
    const code = `
        import { createMicrosoftSession } from "./lib/microsoft-session.mjs";
        import { createMicrosoftNativeReadTransport } from "./lib/microsoft-native-transport.mjs";
        import { createNativePersistence, readNativeCollectionSettings } from "./lib/native-persistence.mjs";
        const context = { dataDir: process.argv[1] };
        let providerCalls = 0;
        const forbidden = async () => { providerCalls++; throw new Error("Provider forbidden in metadata restart."); };
        const transport = createMicrosoftNativeReadTransport({ open: forbidden, verifyAccount: forbidden,
            stop: async () => ({ processExited: true, profileReleased: true }) });
        const saved = await readNativeCollectionSettings(context);
        let store;
        const lifecycle = await createMicrosoftSession(context, { transport,
            collection: { paused: saved.paused, windowDays: saved.windowDays },
            persistCollectionSettings: (settings, token) => store.persistCollectionSettings(settings, token) });
        try {
            store = await createNativePersistence(context, { lifecycle, transport,
                preAccount: "metadata-only", configurationIntents: true });
            const status = await lifecycle.status(), capability = await lifecycle.nativeConfigurationStatus();
            const offer = await store.configurationOffer({ owner: "fresh-process-config-owner", check() {}, dispatched() {} });
            console.log(JSON.stringify({ wire: status.wire, retained: status.authorization.retained, connection: status.microsoft.state,
                collection: status.collection, generation: status.generation, authorizationRevision: status.authorizationRevision,
                hasPartition: typeof capability.partition === "string", enable: capability.enable, save: capability.save,
                offer, providerCalls }));
        } finally { store?.close(); await lifecycle.close(); }
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", code, app.context.dataDir],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30000 }));
    assert.equal(result.wire, "signed-in");
    assert.equal(result.retained, true);
    assert.equal(result.collection, "paused");
    assert.equal(result.connection, "reconnect-required");
    assert.equal(result.hasPartition, true);
    assert.equal(result.enable, false);
    assert.equal(result.save, true);
    assert.equal(result.offer.intent, "save");
    assert.equal(result.offer.available, true);
    assert.equal(result.offer.generation, result.generation);
    assert.equal(result.offer.authorizationRevision, result.authorizationRevision);
    assert.ok(result.generation > generation);
    assert.deepEqual(result.offer.values, { surfaces: ["chat", "cowork"], windowDays: 30 });
    assert.deepEqual(result.offer.blockers, []);
    assert.equal(result.providerCalls, 0);
    assert.deepEqual(await app.bytes(), before);
});

test("global policy remains UNSET until an admitted action and never enrolls a source", async t => {
    const app = await setup(t, { sourceAware: true }), before = await app.bytes();
    const prior = await loadBoardState(app.context);
    assert.equal(await readGlobalCollectionGate(app.context), null);
    const offer = await app.offer();
    assert.equal(offer.schemaVersion, 2);
    assert.equal(offer.globalRevision, null);
    assert.deepEqual(await app.bytes(), before);
    const paused = await app.global(false);
    assert.deepEqual(paused, { revision: 1, paused: true });
    const state = await loadBoardState(app.context);
    assert.equal(state.stateVersion, 6);
    assert.equal(state.nativeRetention, undefined);
    assert.equal(state.evidenceRevision, prior.evidenceRevision);
    assert.deepEqual(state.cards, prior.cards);
    assert.deepEqual(state.exports, prior.exports);
    assert.equal(await readNativeCollectionSettings(app.context), null);
    const saved = await app.bytes(), dispatched = app.dispatched;
    assert.deepEqual(await app.global(false), paused);
    assert.deepEqual(await app.bytes(), saved);
    assert.equal(app.dispatched, dispatched);
    assert.deepEqual(await app.global(true), { revision: 2, paused: false });
    assert.equal(await readNativeCollectionSettings(app.context), null);
    assert.equal(app.providerCalls, 0);
});

for (const startPaused of [false, true]) {
    test(`schema2 configuration preserves ${startPaused ? "explicit global Pause" : "genuine UNSET"} and global Resume preserves source Pause`, async t => {
        const app = await setup(t, { sourceAware: true });
        if (startPaused) await app.global(false);
        await app.command("microsoft-connect");
        const offer = await app.offer(), globalBefore = await readGlobalCollectionGate(app.context);
        assert.equal(offer.schemaVersion, 2);
        assert.equal(offer.globalRevision, startPaused ? 1 : null);
        assert.equal(Object.keys(app.input(offer)).length, 8);
        const config = await app.configure({ ...app.input(offer), surfaces: ["cowork"], windowDays: 14 });
        assert.deepEqual(config.settings, { paused: false, windowDays: 14 });
        assert.deepEqual(await readGlobalCollectionGate(app.context), globalBefore);
        if (startPaused) {
            await assert.rejects(app.lifecycle.lease("microsoft-read"));
            const status = await app.persistence.status();
            assert.equal(status.actions.includes("collect-now"), false);
            assert.ok(status.blockers.includes("NATIVE_RETENTION_GLOBAL_PAUSED"));
        }
        else {
            const state = await loadBoardState(app.context);
            assert.equal(Object.hasOwn(state, "globalCollection"), false);
            assert.equal(state.stateVersion, 4);
        }
        const stale = app.input(await app.offer());
        await app.global(true);
        const sourceSettings = await readNativeCollectionSettings(app.context), beforeStale = await app.bytes();
        assert.equal(sourceSettings.paused, false);
        assert.equal(sourceSettings.windowDays, 14);
        await assert.rejects(app.configure(stale), { code: "stale-collection-control" });
        assert.deepEqual(await app.bytes(), beforeStale);
        await app.lifecycle.lease("microsoft-read");
        await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.admission);
        const pausedSource = await readNativeCollectionSettings(app.context);
        assert.equal(pausedSource.paused, true);
        assert.equal(pausedSource.windowDays, 14);
        await app.global(false);
        await app.global(true);
        assert.deepEqual(await readNativeCollectionSettings(app.context), pausedSource);
        await assert.rejects(app.lifecycle.lease("microsoft-read"));
    });
}

test("global publication requires the genuine original token, owner and revision", async t => {
    const app = await setup(t, { sourceAware: true }), input = await app.globalInput(false);
    let expired;
    const result = await app.lifecycle.admitGlobalCollection(input, app.admission, async (token, guarded) => {
        expired = token;
        const value = { expectedRevision: input.expectedRevision, paused: true };
        await assert.rejects(app.persistence.setGlobalCollectionGate(value, { ...token }, guarded), { code: "invalid-request" });
        await assert.rejects(app.persistence.setGlobalCollectionGate(value, token, { ...guarded, owner: "different-global-test-owner" }),
            { code: "NATIVE_RETENTION_GLOBAL_ADMISSION_REQUIRED" });
        return app.persistence.setGlobalCollectionGate(value, token, guarded);
    });
    assert.deepEqual(result, { revision: 1, paused: true });
    const before = await app.bytes();
    await assert.rejects(app.persistence.setGlobalCollectionGate({ expectedRevision: null, paused: true }, expired, app.admission),
        { code: "invalid-request" });
    const current = await app.globalInput(true);
    await assert.rejects(app.lifecycle.admitGlobalCollection({ ...current, expectedRevision: null }, app.admission, () => {
        assert.fail("Stale global control cannot enter persistence.");
    }), { code: "stale-collection-control" });
    assert.deepEqual(await app.bytes(), before);
});

test("revocation after global temporary-state fsync leaves UNSET and poisons uncertain runtime authority", async t => {
    const app = await setup(t, { sourceAware: true }), before = await app.bytes(), original = filesystem.open;
    app.expectPoison();
    let revoked = false;
    const mock = t.mock.method(filesystem, "open", async (file, ...args) => {
        const handle = await original(file, ...args);
        if (path.basename(String(file)).startsWith(".state-") && String(file).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); revoked = true; app.revoke(); };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(app.global(false), { code: "command-unauthorized" }); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(revoked, true);
    assert.deepEqual(await app.bytes(), before);
    assert.equal(await readGlobalCollectionGate(app.context), null);
    await assert.rejects(app.lifecycle.globalCollectionStatus(), { code: "storage-failed" });
});

test("a post-commit global failure preserves the actual policy without silently adopting runtime state", async t => {
    const app = await setup(t, { sourceAware: true }), input = await app.globalInput(false);
    app.expectPoison();
    await assert.rejects(app.lifecycle.admitGlobalCollection(input, app.admission, async (token, guarded) => {
        await app.persistence.setGlobalCollectionGate({ expectedRevision: null, paused: true }, token, guarded);
        throw new Error("Lost global response.");
    }), /Lost global response/);
    assert.deepEqual(await readGlobalCollectionGate(app.context), { revision: 1, paused: true });
    await assert.rejects(app.lifecycle.globalCollectionStatus(), { code: "storage-failed" });
    assert.equal(app.providerCalls, 0);
});
