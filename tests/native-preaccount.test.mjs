import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { privateFixture } from "./helpers.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRetainedRead } from "../lib/native-retained-read.mjs";
import { NativeReadModelError } from "../lib/native-read-model.mjs";

async function setup(t, { preAccount = "metadata-only", heldConnect = false } = {}) {
    const cleanups = [], { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const releaseLock = await acquireCollectorLock(context.dataDir);
    const entered = Promise.withResolvers(), releaseConnect = Promise.withResolvers();
    let persistence, sourceCalls = 0, revisionCalls = 0, providerCalls = 0, sourceFailure = false;
    const transport = createMicrosoftNativeReadTransport({
        async open() { providerCalls++; },
        async verifyAccount() {
            providerCalls++; entered.resolve();
            if (heldConnect) await releaseConnect.promise;
            return { tenantId: "preaccount-tenant", subjectId: "preaccount-subject", knownAccountMatched: true, chat: true, cowork: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    persistence = await createNativePersistence(context, { lifecycle, transport, ...(preAccount === null ? {} : { preAccount }) });
    const owner = "native-preaccount-test-owner", request = { owner, check() {}, dispatched() {} };
    const command = async action => lifecycle.command(owner, { action, operationId: randomUUID(),
        generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
    await command("wire-sign-in");
    const source = async lease => {
        sourceCalls++; assert.equal(lease.kind, "microsoft-retained");
        if (sourceFailure) throw new NativeReadModelError("test-source-invalid", "$");
        return persistence.readAuthorized(lease);
    };
    source.revision = lease => {
        revisionCalls++; assert.equal(lease.kind, "microsoft-retained");
        return persistence.readAuthorized.revision(lease);
    };
    if (persistence.readAuthorized.preAccount !== undefined) source.preAccount = persistence.readAuthorized.preAccount;
    const reader = createNativeRetainedRead(lifecycle, source);
    t.after(async () => {
        releaseConnect.resolve(); reader.close(); persistence.close(); await lifecycle.close(); await releaseLock();
        for (const cleanup of cleanups) await cleanup();
    });
    return { context, lifecycle, persistence, reader, owner, request, command, entered,
        releaseConnect: () => releaseConnect.resolve(), failSource: () => { sourceFailure = true; },
        get counts() { return { sourceCalls, revisionCalls, providerCalls }; } };
}

test("opt-in first enrollment publishes explicit metadata under global retained authority without native callbacks", async t => {
    const app = await setup(t), global = await app.lifecycle.status();
    assert.equal(global.authorization.microsoftPartition, null);
    const frame = await app.reader.scan();
    assert.deepEqual(Object.keys(frame).sort(), ["authorizationRevision", "generation", "kind", "reason", "records", "revision"]);
    assert.equal(frame.kind, "native-account-unavailable");
    assert.equal(frame.reason, "microsoft-account-not-configured");
    assert.equal(frame.generation, global.generation);
    assert.equal(frame.authorizationRevision, global.authorizationRevision);
    assert.deepEqual(frame.records, []);
    assert.equal(Object.isFrozen(frame.records), true);
    assert.equal(app.reader.assertCurrent(frame), true);
    assert.equal(await app.reader.publish(frame, () => "metadata-only"), "metadata-only");
    const status = await app.persistence.status({}, { owner: app.owner });
    assert.deepEqual(Object.keys(status).sort(), ["actions", "authorizationRevision", "blockers", "configuration", "configured",
        "generation", "kind", "rawWriterAdmission", "reason", "revision", "schemaVersion"]);
    assert.equal(status.kind, frame.kind);
    assert.equal(status.reason, frame.reason);
    assert.equal(status.generation, global.generation);
    assert.equal(status.authorizationRevision, global.authorizationRevision);
    assert.equal(status.configuration, null);
    assert.equal(status.configured, false);
    assert.deepEqual(status.actions, []);
    assert.deepEqual(status.blockers, ["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"]);
    assert.deepEqual(app.counts, { sourceCalls: 0, revisionCalls: 0, providerCalls: 0 });
    await assert.rejects(app.persistence.readAuthorized(await app.lifecycle.lease("retained")),
        { code: "NATIVE_RETENTION_READ_LEASE_REQUIRED" });
});

test("pre-account status can expose committed global settings without inventing account or receipt authority", async t => {
    const app = await setup(t);
    await app.lifecycle.setNativeCollectionEnabled(false, (await app.lifecycle.status()).authorizationRevision, app.request);
    const status = await app.persistence.status({}, { owner: app.owner });
    assert.equal(status.configured, false);
    assert.equal(status.configuration.settings.paused, true);
    assert.equal(status.configuration.settings.windowDays, 30);
    for (const key of ["accountRef", "receipt", "receiptQuery", "readback"]) assert.equal(Object.hasOwn(status, key), false);
    await assert.rejects(app.persistence.status({ operationId: randomUUID() }, { owner: app.owner }));
    await assert.rejects(app.persistence.status({ operationId: undefined }, { owner: app.owner }));
    assert.deepEqual(app.counts, { sourceCalls: 0, revisionCalls: 0, providerCalls: 0 });
});

test("readonly defaults remain strict and signout never becomes unavailable-native success", async t => {
    const strict = await setup(t, { preAccount: null });
    await assert.rejects(strict.reader.scan(), { code: "wire_access_revoked" });
    await assert.rejects(strict.persistence.status({}, { owner: strict.owner }));
    const app = await setup(t), frame = await app.reader.scan();
    await app.command("wire-sign-out");
    assert.throws(() => app.reader.assertCurrent(frame), { code: "wire_access_revoked" });
    await assert.rejects(app.reader.publish(frame, () => "must-not-publish"), { code: "wire_access_revoked" });
    await assert.rejects(app.reader.scan());
    await assert.rejects(app.persistence.status({}, { owner: app.owner }));
    assert.equal(app.counts.sourceCalls, 0);
});

test("first Connect completion invalidates an unavailable frame even without another generation change", async t => {
    const app = await setup(t, { heldConnect: true }), connecting = app.command("microsoft-connect");
    await app.entered.promise;
    const frame = await app.reader.scan();
    assert.equal(app.reader.assertCurrent(frame), true);
    app.releaseConnect();
    assert.equal((await connecting).outcome, "completed");
    const connected = await app.lifecycle.status();
    assert.equal(connected.generation, frame.generation);
    assert.ok(connected.authorizationRevision > frame.authorizationRevision);
    assert.throws(() => app.reader.assertCurrent(frame), { code: "native-read-stale" });
    await assert.rejects(app.reader.publish(frame, () => "must-not-publish"), { code: "native-read-stale" });
    assert.equal(app.counts.sourceCalls, 0);
    const next = await app.reader.scan();
    assert.equal(Object.hasOwn(next, "kind"), false);
    assert.match(next.readback.accountRef, /^[a-f0-9]{64}$/);
    assert.equal(app.counts.sourceCalls, 1);
});

test("known-partition malformed native reads stay errors, never unavailable metadata", async t => {
    const app = await setup(t);
    assert.equal((await app.command("microsoft-connect")).outcome, "completed");
    app.failSource();
    await assert.rejects(app.reader.scan(), { code: "native-read-test-source-invalid" });
    assert.equal(app.counts.sourceCalls, 1);
});

test("pre-account status rejects a first-account transition during its asynchronous metadata read", async t => {
    const app = await setup(t, { heldConnect: true }), connecting = app.command("microsoft-connect");
    await app.entered.promise;
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = filesystem.readFile;
    const file = path.join(app.context.dataDir, `${BOARD_ID}.state.json`);
    const mock = t.mock.method(filesystem, "readFile", async (target, ...args) => {
        if (path.resolve(String(target)) === file) { entered.resolve(); await resume.promise; }
        return original(target, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { resume.resolve(); mock.mock.restore(); syncBuiltinESMExports(); });
    const pending = app.persistence.status({}, { owner: app.owner });
    await entered.promise;
    app.releaseConnect(); await connecting; resume.resolve();
    await assert.rejects(pending, { code: "NATIVE_RETENTION_UNAVAILABLE_STALE" });
    assert.equal(app.counts.sourceCalls, 0);
});
