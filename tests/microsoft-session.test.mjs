import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createMicrosoftSession, MicrosoftSessionError } from "../lib/microsoft-session.mjs";
import { sessionStorage } from "../lib/microsoft-session-state.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";

const ACCOUNT_A = "a".repeat(64), ACCOUNT_B = "b".repeat(64);
const PANEL_A = "synthetic-panel-owner-a", PANEL_B = "synthetic-panel-owner-b";
const authorizeSynthetic = () => true;
const deferred = () => Promise.withResolvers();
const code = expected => error => error instanceof MicrosoftSessionError && error.code === expected;

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail("Synthetic lifecycle did not reach the expected checkpoint.");
}

function manualClock() {
    let sequence = 0;
    const timers = new Map();
    return {
        set(work, milliseconds) { const id = ++sequence; timers.set(id, { work, milliseconds }); return id; },
        clear(id) { timers.delete(id); },
        fire(milliseconds) {
            const entry = [...timers].find(([, value]) => value.milliseconds === milliseconds);
            assert.ok(entry, "Expected an armed lifecycle deadline.");
            timers.delete(entry[0]);
            entry[1].work();
        },
        count: () => timers.size,
    };
}

function fakeTransport(overrides = {}) {
    const events = [], owners = new Set();
    let maxOwners = 0;
    const transport = {
        qualification: "synthetic-only-v1",
        async open(input) {
            events.push(["open", input.mode, input.ownerId]);
            assert.equal(owners.size, 0, "A second owner must never open.");
            owners.add(input.ownerId);
            maxOwners = Math.max(maxOwners, owners.size);
            await overrides.open?.(input);
        },
        async verify(input) {
            events.push(["verify", input.ownerId]);
            return overrides.verify ? overrides.verify(input) : { partition: input.expectedPartition, chat: true, cowork: true };
        },
        async stop(input) {
            events.push(["stop", input.ownerId]);
            const proof = overrides.stop ? await overrides.stop(input) : { processExited: true, profileReleased: true };
            if (proof.processExited && proof.profileReleased) owners.delete(input.ownerId);
            return proof;
        },
    };
    return { transport, events, owners, maxOwners: () => maxOwners };
}

async function fixture(t, options = {}) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "wire-ms-lifecycle-"));
    const context = { dataDir };
    const fake = fakeTransport(options.overrides);
    const clock = manualClock();
    const instances = [];
    const settings = { paused: false, windowDays: 14 };
    const config = { transport: fake.transport, collection: settings, timeoutMs: 100, cleanupMs: 50, clock, ...options };
    delete config.overrides;
    async function open(extra = {}) {
        const instance = await createMicrosoftSession(context, { ...config, ...extra });
        instances.push(instance);
        return instance;
    }
    t.after(async () => {
        for (const instance of instances.reverse()) {
            try { await instance.close(); }
            catch (error) { assert.ok(["cleanup-failed", "storage-failed", "authorization-listener-failed"].includes(error.code)); }
        }
        await rm(dataDir, { recursive: true, force: true });
    });
    const session = await open();
    return { context, fake, clock, session, open, file: path.join(dataDir, "microsoft-session", "session.json") };
}

async function operation(session, action, extra = {}) {
    return { action, operationId: randomUUID(), generation: (await session.status()).generation, ...extra };
}
async function act(session, action, extra) { return session.command(PANEL_A, await operation(session, action, extra), authorizeSynthetic); }
async function signIn(session) { return act(session, "wire-sign-in"); }
async function connect(session, partition = ACCOUNT_A, replace = false) {
    return act(session, "microsoft-connect", { expectedPartition: partition, replace });
}

for (const observed of [
    { code: "timed-out", stage: "connect", name: "passive-document-path-unqualified" },
    { code: "timed-out", stage: "connect", name: "passive-frame-origin-changed" },
    { code: "timed-out", stage: "connect", name: "passive-bootstrap-uninitialized" },
    { code: "timed-out", stage: "connect", name: "passive-background-bootstrap-loader-unavailable" },
    { code: "NATIVE_FAVICON_UNQUALIFIED", stage: "protocol", name: "favicon-request-epoch" },
    { code: "NATIVE_AUTH_RETURN_UNQUALIFIED", stage: "protocol", name: "auth-return-original-request" },
    { code: "NATIVE_AUTH_RETURN_UNQUALIFIED", stage: "route", name: "auth-continuation-route-pairing" },
    { code: "NATIVE_HISTORY_REQUEST_UNQUALIFIED", stage: "network", name: "history-request-action" },
    { code: "NATIVE_SOURCE_REQUEST_FAILED", stage: "protocol", name: "protocol-stop",
        protocolStop: { reason: "capacity-deadline", phase: "request",
            capacity: { active: 128, reserved: 0, waiting: 1, withoutTerminal: 128, withoutAcknowledgement: 128, redirecting: 0 } } },
    { code: "NATIVE_SOURCE_REQUEST_FAILED", stage: "protocol", name: "protocol-stop",
        protocolStop: { reason: "capacity-unbound", phase: "request",
            capacity: { active: 128, reserved: 0, waiting: 1, withoutTerminal: 128, withoutAcknowledgement: 128, redirecting: 0 },
            binding: { reason: "metadata-missing", retained: 135, limit: 512, capped: false } } },
    { code: "NATIVE_SOURCE_REQUEST_FAILED", stage: "network", name: "protocol-stop",
        protocolStop: { reason: "network-record-missing", phase: "network", terminal: "finished",
            networkRecord: { observation: "original", resourceType: "image", urlClass: "embedded-raster-image",
                frame: "root", document: "matched-at-request", loader: "different-at-request" } } },
])
test(`native Connect persists the first observed predicate through cleanup failure and lifecycle restart: ${observed.name}`, async t => {
    let failCleanup = true, verifications = 0;
    const predicate = { schemaVersion: 1, stage: observed.stage, name: observed.name };
    const transport = createMicrosoftNativeReadTransport({
        async open() {},
        async verifyAccount(operation) {
            verifications++;
            assert.equal(await operation.recordFailure({ code: observed.code, predicate,
                ...(observed.protocolStop ? { protocolStop: observed.protocolStop } : {}) }), true);
            if (observed.protocolStop) {
                for (const capacity of [
                    { ...observed.protocolStop.capacity, active: 129 },
                    { ...observed.protocolStop.capacity, waiting: 385 },
                    { ...observed.protocolStop.capacity, requestId: "PRIVATE_REQUEST_ID" },
                ]) await assert.rejects(async () => operation.recordFailure({ code: observed.code, predicate,
                    protocolStop: { ...observed.protocolStop, capacity } }), code("invalid-request"));
                if (observed.protocolStop.binding) {
                    for (const binding of [
                        { ...observed.protocolStop.binding, reason: "PRIVATE_REASON" },
                        { ...observed.protocolStop.binding, retained: 513 },
                        { ...observed.protocolStop.binding, retained: -1 },
                        { ...observed.protocolStop.binding, limit: 1024 },
                        { ...observed.protocolStop.binding, capped: "false" },
                        { ...observed.protocolStop.binding, reason: "metadata-capped" },
                        { ...observed.protocolStop.binding, url: "PRIVATE_REQUEST_URL" },
                        { reason: "metadata-missing", retained: 0, limit: 512 },
                    ]) await assert.rejects(async () => operation.recordFailure({ code: observed.code, predicate,
                        protocolStop: { ...observed.protocolStop, binding } }), code("invalid-request"));
                    for (const changed of [{ reason: "protocol-cap" }, { phase: "response" }]) {
                        await assert.rejects(async () => operation.recordFailure({ code: observed.code, predicate,
                            protocolStop: { ...observed.protocolStop, ...changed } }), code("invalid-request"));
                    }
                }
            }
            await assert.rejects(async () => operation.recordFailure({ code: observed.code,
                predicate: { ...predicate, name: "auth-return-PRIVATE_ACTION_URL" } }), code("invalid-request"));
            await assert.rejects(async () => operation.recordFailure({ code: observed.code,
                predicate: { ...predicate, name: "history-request-PRIVATE_ACTION" } }), code("invalid-request"));
            await assert.rejects(async () => operation.recordFailure({ code: observed.code,
                predicate: { ...predicate, action: "PRIVATE_ACTION_URL" } }), code("invalid-request"));
            assert.equal(await operation.recordFailure({ code: "NATIVE_SOURCE_REQUEST_FAILED",
                predicate: { schemaVersion: 1, stage: "connect", name: "unobserved" } }), false);
            throw Object.assign(new Error("PRIVATE_EXCEPTION_PROSE"), { code: observed.code });
        },
        async stop() {
            if (failCleanup) throw new Error("PRIVATE_CLEANUP_PROSE");
            return { processExited: true, profileReleased: true };
        },
    });
    const app = await fixture(t, { transport });
    await signIn(app.session);
    const input = await operation(app.session, "microsoft-connect", { replace: false });
    const result = await app.session.command(PANEL_A, input, authorizeSynthetic);
    assert.equal(result.outcome, "failed");
    let state = JSON.parse(await readFile(app.file, "utf8"));
    const original = state.receipts.find(row => row.operationId === input.operationId);
    assert.deepEqual(original.nativeEvidence.firstFailure.predicate, predicate);
    assert.equal(original.nativeEvidence.firstFailure.code, observed.code);
    if (observed.protocolStop) assert.deepEqual(original.nativeEvidence.firstFailure.protocolStop, observed.protocolStop);
    assert.equal(original.nativeEvidence.cleanup.state, "failed");
    assert.equal(result.nativeEvidence, undefined);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_EXCEPTION|PRIVATE_CLEANUP|PRIVATE_ACTION|PRIVATE_REQUEST/);
    failCleanup = false;
    await app.session.close();
    const restarted = await app.open();
    state = JSON.parse(await readFile(app.file, "utf8"));
    assert.deepEqual(state.receipts.find(row => row.operationId === input.operationId).nativeEvidence.firstFailure,
        original.nativeEvidence.firstFailure);
    assert.equal((await restarted.receipt(PANEL_A, input.operationId)).nativeEvidence, undefined);
    const repeated = await restarted.command(PANEL_A, input, authorizeSynthetic);
    assert.equal(repeated.outcome, "failed");
    assert.equal(verifications, 1);
});

test("visible ownership is proved released before headless; both surfaces yield an intent, never data", async t => {
    const { session, fake, file } = await fixture(t);
    assert.equal((await session.status()).wire, "signed-out");
    await signIn(session);
    const result = await connect(session);
    assert.equal(result.outcome, "completed");
    assert.deepEqual(fake.events.map(event => event.slice(0, event[0] === "open" ? 2 : 1)), [
        ["open", "visible"], ["verify"], ["stop"], ["open", "headless"], ["verify"],
    ]);
    assert.equal(fake.maxOwners(), 1);
    const status = await session.status();
    assert.equal(status.microsoft.state, "connected");
    assert.equal(status.microsoft.surfaces.chat.qualification, "production-unqualified");
    const intent = await session.collectionIntent();
    assert.deepEqual(intent.surfaces, ["chat", "cowork"]);
    assert.equal(intent.windowDays, 14);
    assert.equal(await session.assertLease(intent.lease), true);
    assert.deepEqual(Object.keys(fake.transport).sort(), ["open", "qualification", "stop", "verify"]);
    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(state.owner.phase, "headless");
    assert.deepEqual(state.partitions, [ACCOUNT_A]);
});

test("unqualified/missing hooks fail closed without blocking deliberate WIRE sign-in or GitHub", async t => {
    const { session, fake } = await fixture(t, { transport: undefined });
    await signIn(session);
    assert.equal((await session.status()).microsoft.reason, "hooks-unqualified");
    assert.equal((await session.status()).authorization.githubAcquisition, true);
    await assert.rejects(connect(session), code("hooks-unqualified"));
    assert.equal(await session.collectionIntent(), null);
    assert.deepEqual(fake.events, []);
});

test("duplicate operation is no-replay; concurrent Connect is busy and stale requests are fenced", async t => {
    const gate = deferred();
    const { session, fake } = await fixture(t, { overrides: { verify: async input => {
        await gate.promise;
        return { partition: input.expectedPartition, chat: true, cowork: true };
    } } });
    await signIn(session);
    const input = await operation(session, "microsoft-connect", { expectedPartition: ACCOUNT_A, replace: false });
    const first = session.command(PANEL_A, input, authorizeSynthetic);
    await until(() => fake.events.some(event => event[0] === "verify"));
    assert.equal((await session.command(PANEL_A, input, authorizeSynthetic)).outcome, "pending");
    await assert.rejects(connect(session), code("busy"));
    await assert.rejects(session.command(PANEL_A, { ...input, operationId: randomUUID() }, authorizeSynthetic), code("stale-generation"));
    await assert.rejects(session.command(PANEL_A, { ...input, expectedPartition: ACCOUNT_B }, authorizeSynthetic), code("operation-conflict"));
    gate.resolve();
    assert.equal((await first).outcome, "completed");
    assert.deepEqual(await session.command(PANEL_A, input, authorizeSynthetic), await session.receipt(PANEL_A, input.operationId));
    assert.equal(fake.events.filter(event => event[0] === "open").length, 2);
});

test("cancel invalidates an ignored late verification and never opens headless or rewrites the next generation", async t => {
    const gate = deferred();
    let firstVerify = true;
    const { session, fake } = await fixture(t, { overrides: { verify: async input => {
        if (firstVerify) { firstVerify = false; await gate.promise; }
        return { partition: input.expectedPartition, chat: true, cowork: true };
    } } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "verify"));
    await act(session, "microsoft-cancel");
    assert.equal((await pending).outcome, "cancelled");
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
    await connect(session, ACCOUNT_B);
    const before = await session.status();
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await session.status(), before);
    assert.equal(before.microsoft.partition, ACCOUNT_B);
});

test("durable WIRE sign-out survives a fresh instance, preserves opaque partitions/session material and receipts", async t => {
    const { session, fake, file, context, open } = await fixture(t);
    await signIn(session);
    await connect(session);
    const lease = await session.lease("microsoft-read");
    const syntheticProfile = path.join(context.dataDir, "synthetic-browser-material");
    await writeFile(syntheticProfile, "synthetic-cookie-placeholder");
    const input = await operation(session, "wire-sign-out");
    const receipt = await session.command(PANEL_A, input, authorizeSynthetic);
    assert.deepEqual(receipt.revocation, { scope: "wire", partition: null });
    await assert.rejects(session.assertLease(lease), code("lease-invalid"));
    assert.equal(fake.owners.size, 0);
    assert.equal((await session.status()).authorization.retained, false);
    await session.close();
    const opens = fake.events.filter(event => event[0] === "open").length;
    const fresh = await open();
    assert.equal((await fresh.status()).wire, "signed-out");
    assert.equal((await fresh.status()).authorization.githubAcquisition, false);
    assert.equal(await fresh.collectionIntent(), null);
    assert.deepEqual(await fresh.command(PANEL_A, input, authorizeSynthetic), receipt);
    assert.equal(fake.events.filter(event => event[0] === "open").length, opens);
    assert.equal(await readFile(syntheticProfile, "utf8"), "synthetic-cookie-placeholder");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).partitions, [ACCOUNT_A]);
    await signIn(fresh);
    assert.equal((await fresh.status()).authorization.githubAcquisition, true);
    assert.equal((await fresh.status()).authorization.retained, true);
    assert.equal((await fresh.status()).authorization.microsoftAcquisition, false);
    assert.equal(fake.events.filter(event => event[0] === "open").length, opens);
});

test("natural expiry preserves retained authorization and GitHub, Pause preserves reading, neither opens a window", async t => {
    const { session, fake } = await fixture(t);
    await signIn(session);
    await connect(session);
    const lease = await session.lease("microsoft-read");
    await session.expire(lease);
    await assert.rejects(session.assertLease(lease), code("lease-invalid"));
    assert.equal((await session.status()).microsoft.state, "reconnect-required");
    assert.equal((await session.status()).authorization.retained, true);
    assert.equal((await session.status()).authorization.githubAcquisition, true);
    assert.equal(await session.assertLease(await session.lease("microsoft-retained")), true);
    await session.updateCollection({ paused: true, windowDays: 30 });
    assert.equal((await session.status()).authorization.githubAcquisition, false);
    assert.equal((await session.status()).authorization.retained, true);
    await connect(session);
    assert.equal((await session.status()).microsoft.state, "connected");
    assert.equal(await session.collectionIntent(), null);
    await session.updateCollection({ paused: false, windowDays: 30 });
    assert.equal((await session.collectionIntent()).windowDays, 30);
    assert.equal(fake.events.filter(event => event[0] === "open").length, 4);
    await assert.rejects(session.expire(lease), code("lease-invalid"));
});

test("native owner loss needs no acquisition grant and cannot retire a replacement owner", async t => {
    let owner, generation, file, evidenceBeforeCleanup, opens = 0, stops = 0;
    const transport = createMicrosoftNativeReadTransport({
        async open(operation) { owner = operation.ownerId; opens++; },
        async verifyAccount(operation) {
            generation = operation.generation;
            return { tenantId: "fixture-tenant", subjectId: "fixture-subject", knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() {
            stops++;
            if (stops === 1) evidenceBeforeCleanup = JSON.parse(await readFile(file, "utf8")).receipts
                .find(row => row.action === "microsoft-connect").nativeEvidence?.firstFailure;
            return { processExited: true, profileReleased: true };
        },
    });
    const app = await fixture(t, { transport, collection: { paused: true, windowDays: 14 } });
    const { session } = app;
    file = app.file;
    await signIn(session);
    const receipt = await act(session, "microsoft-connect", { replace: false });
    assert.equal(receipt.outcome, "completed");
    const lost = { ownerId: owner, generation, code: "NATIVE_TOOL_TRANSPORT_ENTRY_UNQUALIFIED",
        publicCoworkScript: "coworker.8d98ec00.js" }, retained = await session.lease("microsoft-retained");
    assert.equal(await session.collectionIntent(), null);
    assert.equal(await session.nativeOwnerLost({ ...lost, ownerId: randomUUID() }), false);
    assert.equal(await session.nativeOwnerLost({ ...lost, generation: generation - 1 }), false);
    await assert.rejects(session.nativeOwnerLost({ ...lost, partition: ACCOUNT_A }), code("invalid-request"));
    await assert.rejects(session.nativeOwnerLost({ ...lost, code: "private error body" }), code("invalid-request"));
    await assert.rejects(session.nativeOwnerLost({ ...lost, publicCoworkScript: "https://private.invalid/script.js" }), code("invalid-request"));
    assert.equal((await session.status()).microsoft.state, "connected");
    assert.equal(await session.nativeOwnerLost(lost), true);
    assert.equal(evidenceBeforeCleanup.code, lost.code);
    assert.equal(evidenceBeforeCleanup.publicCoworkScript, lost.publicCoworkScript);
    assert.deepEqual(evidenceBeforeCleanup.predicate, { schemaVersion: 1, stage: "completion", name: "native-owner-lost" });
    const saved = JSON.parse(await readFile(file, "utf8"));
    const original = saved.receipts.find(row => row.operationId === receipt.operationId);
    assert.equal(original.outcome, "completed");
    assert.equal(original.generation, generation);
    assert.equal(original.reason, null);
    assert.deepEqual(original.nativeEvidence.firstFailure, evidenceBeforeCleanup);
    assert.equal(original.nativeEvidence.cleanup.state, "completed");
    assert.equal(await session.nativeOwnerLost({ ownerId: owner, generation, code: "NATIVE_SOURCE_BROWSER_CLOSED" }), false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).receipts.find(row => row.operationId === receipt.operationId)
        .nativeEvidence.firstFailure, evidenceBeforeCleanup);
    assert.equal(stops, 1);
    assert.equal(opens, 1);
    assert.equal((await session.status()).microsoft.state, "reconnect-required");
    assert.equal((await session.status()).authorization.retained, true);
    await assert.rejects(session.assertLease(retained), code("lease-invalid"));
    assert.equal(await session.assertLease(await session.lease("microsoft-retained")), true);
    assert.deepEqual(await session.receipt(PANEL_A, receipt.operationId), receipt);
    assert.equal((await act(session, "microsoft-connect", { replace: false })).outcome, "completed");
    assert.equal(await session.nativeOwnerLost(lost), false);
    assert.equal(stops, 1);
    assert.equal(opens, 2);
    assert.equal((await session.status()).microsoft.state, "connected");
});

test("account replacement is deliberate, retains old partition identity and emits a revocation", async t => {
    const { session, fake, file } = await fixture(t);
    await signIn(session);
    await connect(session);
    const retained = await session.lease("microsoft-retained");
    await assert.rejects(connect(session, ACCOUNT_B), code("wrong-account"));
    const receipt = await connect(session, ACCOUNT_B, true);
    assert.equal(receipt.outcome, "completed");
    assert.deepEqual(receipt.revocation, { scope: "microsoft-account", partition: ACCOUNT_A });
    await assert.rejects(session.assertLease(retained), code("lease-invalid"));
    assert.equal((await session.status()).authorization.microsoftPartition, ACCOUNT_B);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).partitions, [ACCOUNT_A, ACCOUNT_B]);
    await connect(session, ACCOUNT_A, true);
    assert.equal((await session.status()).authorization.microsoftPartition, ACCOUNT_A);
    assert.equal(fake.maxOwners(), 1);
});

for (const reason of ["browser-unavailable", "browser-policy-blocked", "profile-contention", "window-closed"]) {
    test(`${reason} is explicit, sanitized and cannot produce a usable connection`, async t => {
        const { session, fake } = await fixture(t, { overrides: { open: async () => { throw new MicrosoftSessionError(reason); } } });
        await signIn(session);
        const receipt = await connect(session);
        assert.equal(receipt.reason, reason);
        assert.equal(receipt.outcome, reason === "window-closed" ? "cancelled" : "failed");
        assert.equal((await session.status()).authorization.microsoftAcquisition, false);
        assert.equal(await session.collectionIntent(), null);
        assert.equal(fake.owners.size, 0);
    });
}

for (const proof of [
    { partition: ACCOUNT_B, chat: true, cowork: true },
    { partition: ACCOUNT_A, chat: true, cowork: false },
    { partition: ACCOUNT_A, chat: true, cowork: true, token: "SYNTHETIC_SECRET" },
]) {
    test(`wrong identity, missing surface or unexpected proof fields are refused: ${Object.keys(proof).join(",")}`, async t => {
        const { session, file } = await fixture(t, { overrides: { verify: async () => proof } });
        await signIn(session);
        const receipt = await connect(session);
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.reason, proof.partition === ACCOUNT_B ? "wrong-account" : "access-refused");
        assert.equal((await session.status()).authorization.microsoftAcquisition, false);
        assert.doesNotMatch(await readFile(file, "utf8"), /SYNTHETIC_SECRET/);
    });
}

test("timeout fences late authentication and never implicitly retries", async t => {
    const gate = deferred();
    const { session, fake, clock } = await fixture(t, { overrides: { verify: async () => gate.promise } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "verify"));
    clock.fire(100);
    assert.equal((await pending).reason, "timed-out");
    const before = await session.status();
    gate.resolve({ partition: ACCOUNT_A, chat: true, cowork: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await session.status(), before);
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
    assert.equal(clock.count(), 0);
});

test("unsettled launch retains the owner marker even after a stop proof; only explicit recovery can release it", async t => {
    const gate = deferred();
    const { session, fake, clock, file, open } = await fixture(t, { overrides: { open: async () => gate.promise } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "open"));
    clock.fire(100);
    assert.equal((await pending).reason, "timed-out");
    assert.equal((await session.status()).microsoft.state, "recovery-required");
    assert.ok(JSON.parse(await readFile(file, "utf8")).owner);
    await assert.rejects(open(), code("profile-contention"));
    await assert.rejects(connect(session), code("busy"));
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(JSON.parse(await readFile(file, "utf8")).owner);
    assert.equal((await act(session, "microsoft-recover")).outcome, "completed");
    assert.equal(JSON.parse(await readFile(file, "utf8")).owner, null);
});

test("failed cleanup prevents handoff, preserves the lock and requires explicit proof-based recovery", async t => {
    let allowStop = false;
    const { session, fake, file, open } = await fixture(t, { overrides: { stop: async () => ({
        processExited: allowStop, profileReleased: allowStop,
    }) } });
    await signIn(session);
    assert.equal((await connect(session)).reason, "cleanup-failed");
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
    assert.equal((await session.status()).microsoft.state, "recovery-required");
    const owner = JSON.parse(await readFile(file, "utf8")).owner;
    await assert.rejects(session.close(), code("cleanup-failed"));
    assert.equal(JSON.parse(await readFile(file, "utf8")).owner.id, owner.id);
    await assert.rejects(open(), code("profile-contention"));
    allowStop = true;
    assert.equal((await act(session, "microsoft-recover")).outcome, "completed");
    assert.equal(JSON.parse(await readFile(file, "utf8")).owner, null);
});

test("cleanup timeout is bounded and keeps ownership; late stop success does not silently release the lock", async t => {
    const gate = deferred();
    let pendingStop = true;
    const { session, fake, clock, file } = await fixture(t, { overrides: { stop: async () =>
        pendingStop ? gate.promise : { processExited: true, profileReleased: true } } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "stop"));
    clock.fire(50);
    assert.equal((await pending).reason, "cleanup-failed");
    gate.resolve({ processExited: true, profileReleased: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(JSON.parse(await readFile(file, "utf8")).owner);
    pendingStop = false;
    await act(session, "microsoft-recover");
});

test("sign-out during visible-to-hidden cleanup wins and late cleanup cannot reactivate", async t => {
    const gate = deferred();
    const { session, fake } = await fixture(t, { overrides: { stop: async () => gate.promise } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "stop"));
    const signout = act(session, "wire-sign-out");
    await until(async () => (await session.status()).wire === "signed-out");
    gate.resolve({ processExited: true, profileReleased: true });
    await signout;
    assert.equal((await pending).outcome, "cancelled");
    assert.equal((await session.status()).authorization.retained, false);
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
});

test("fresh runtime never replays a crashed operation or opens its retained owner before recovery", async t => {
    const { session, context, open, fake, file } = await fixture(t);
    await session.close();
    const moduleUrl = new URL("../lib/microsoft-session.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { createMicrosoftSession } from ${JSON.stringify(moduleUrl)};
        const session = await createMicrosoftSession(${JSON.stringify(context)}, {
            collection: {paused:false,windowDays:14},
            transport: {qualification:"synthetic-only-v1",
                open: async () => process.exit(0), verify: async () => {}, stop: async () => {}}
        });
        await session.command(${JSON.stringify(PANEL_A)}, {action:"wire-sign-in",operationId:${JSON.stringify(randomUUID())},generation:(await session.status()).generation}, () => true);
        await session.command(${JSON.stringify(PANEL_A)}, {action:"microsoft-connect",operationId:${JSON.stringify(randomUUID())},
            generation:(await session.status()).generation,expectedPartition:${JSON.stringify(ACCOUNT_A)},replace:false}, () => true);
    `], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
    const prior = JSON.parse(await readFile(file, "utf8"));
    assert.ok(prior.owner);
    const pendingReceipt = prior.receipts.find(receipt => receipt.outcome === "pending");
    const fresh = await open();
    assert.equal((await fresh.status()).microsoft.state, "recovery-required");
    assert.equal((await fresh.receipt(PANEL_A, pendingReceipt.operationId)).outcome, "ambiguous");
    assert.equal(fake.events.length, 0);
    await assert.rejects(connect(fresh), code("busy"));
    await act(fresh, "microsoft-recover");
    assert.equal((await fresh.receipt(PANEL_A, pendingReceipt.operationId)).outcome, "ambiguous");
    assert.equal(fake.events.filter(event => event[0] === "open").length, 0);
});

test("storage failure aborts a connection, preserves the recovery marker and never reports success or raw errors", async t => {
    const { session: initial, context, fake, open, file } = await fixture(t);
    await initial.close();
    const underlying = sessionStorage(context);
    let failing = false;
    const session = await open({ storage: { ...underlying, write: async value => {
        if (failing) throw new Error("SYNTHETIC_SECRET disk full /private/path");
        await underlying.write(value);
    } } });
    await signIn(session);
    await connect(session);
    const lease = await session.lease("microsoft-read");
    failing = true;
    await assert.rejects(act(session, "wire-sign-out"), code("storage-failed"));
    assert.equal(fake.owners.size, 0);
    assert.equal((await session.status()).microsoft.reason, "storage-failed");
    assert.equal((await session.status()).authorization.retained, false);
    await assert.rejects(session.assertLease(lease), code("storage-failed"));
    await assert.rejects(session.close(), code("storage-failed"));
    assert.equal(fake.owners.size, 0);
    assert.ok(JSON.parse(await readFile(file, "utf8")).owner);
    assert.doesNotMatch(JSON.stringify(await session.status()) + await readFile(file, "utf8"), /SYNTHETIC_SECRET|private.path/);
});

test("corrupt and null persisted state are errors, never signed-in/empty success-shaped defaults", async t => {
    const { session, file, open } = await fixture(t);
    await session.close();
    for (const text of ["null", "{broken", '{"version":99}', '{"token":"SYNTHETIC_SECRET"}']) {
        await writeFile(file, text);
        await assert.rejects(open(), code("state-invalid"));
        assert.equal(await readFile(file, "utf8"), text);
    }
});

test("transport errors and arbitrary commands/proof fields cannot leak credentials or launch capabilities", async t => {
    const { session, file, fake } = await fixture(t, { overrides: { verify: async () => {
        throw new Error("SYNTHETIC_SECRET access_token=private https://example.invalid/?token=private");
    } } });
    await signIn(session);
    assert.equal((await connect(session)).reason, "transport-failed");
    const base = await operation(session, "wire-sign-out");
    for (const extra of [{ url: "https://example.invalid" }, { token: "private" }, { command: "edge" }, { action: "launch-browser" }]) {
        await assert.rejects(session.command(PANEL_A, { ...base, ...extra }, authorizeSynthetic), code("invalid-request"));
    }
    await assert.rejects(session.assertLease({ generation: (await session.status()).generation, kind: "retained" }), code("lease-invalid"));
    assert.doesNotMatch(await readFile(file, "utf8"), /SYNTHETIC_SECRET|access_token|example.invalid/);
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
});

test("a second caller cannot create another runtime/profile owner", async t => {
    const { session, open, fake } = await fixture(t);
    await signIn(session);
    await connect(session);
    await assert.rejects(open(), code("profile-contention"));
    assert.equal(fake.maxOwners(), 1);
});

test("no profile directory, acquisition, evidence or shared state is created by this module", async t => {
    const { session, context } = await fixture(t);
    await signIn(session);
    await connect(session);
    assert.deepEqual(await readdir(context.dataDir), ["microsoft-session"]);
    assert.deepEqual((await readdir(path.join(context.dataDir, "microsoft-session"))).sort(), ["collector.lock", "session.json"]);
});

test("concurrent close/cancel/duplicate close cannot launch hidden or release the runtime lock twice", async t => {
    const gate = deferred();
    const { session, fake, open } = await fixture(t, { overrides: { verify: async () => gate.promise } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "verify"));
    const cancel = session.command(PANEL_A, await operation(session, "microsoft-cancel"), authorizeSynthetic);
    const closing = session.close();
    assert.equal(session.close(), closing);
    const results = await Promise.allSettled([pending, cancel, closing]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[0].value.outcome, "cancelled");
    if (results[1].status === "rejected") assert.equal(results[1].reason.code, "session-closed");
    assert.equal(results[2].status, "fulfilled");
    gate.resolve({ partition: ACCOUNT_A, chat: true, cowork: true });
    const fresh = await open();
    assert.equal((await fresh.status()).authorization.microsoftAcquisition, false);
    assert.equal(fake.events.filter(event => event[0] === "open").length, 1);
});

test("sign-out stays durable when cleanup fails and recovery never reopens the WIRE gate", async t => {
    let fail = false;
    const { session, file, open, fake } = await fixture(t, { overrides: { stop: async () => ({
        processExited: !fail, profileReleased: !fail,
    }) } });
    await signIn(session);
    await connect(session);
    fail = true;
    const result = await act(session, "wire-sign-out");
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "cleanup-failed");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.wire, "signed-out");
    assert.ok(saved.owner);
    assert.equal((await session.status()).authorization.retained, false);
    fail = false;
    await act(session, "microsoft-recover");
    assert.equal((await session.status()).wire, "signed-out");
    await session.close();
    const fresh = await open();
    assert.equal((await fresh.status()).wire, "signed-out");
    assert.equal(fake.owners.size, 0);
});

test("headless identity/access is revalidated, not inferred from visible sign-in", async t => {
    let checks = 0;
    const { session, fake } = await fixture(t, { overrides: { verify: async () => ({
        partition: ++checks === 1 ? ACCOUNT_A : ACCOUNT_B, chat: true, cowork: true,
    }) } });
    await signIn(session);
    const result = await connect(session);
    assert.equal(result.reason, "wrong-account");
    assert.equal((await session.status()).microsoft.partition, null);
    assert.equal((await session.status()).authorization.microsoftAcquisition, false);
    assert.equal(fake.owners.size, 0);
});

test("Pause during sign-in permits verified connection but never starts acquisition or signs out retained content", async t => {
    const gate = deferred();
    const { session, fake } = await fixture(t, { overrides: { verify: async () => gate.promise } });
    await signIn(session);
    const pending = connect(session);
    await until(() => fake.events.some(event => event[0] === "verify"));
    await session.updateCollection({ paused: true, windowDays: 7 });
    gate.resolve({ partition: ACCOUNT_A, chat: true, cowork: true });
    assert.equal((await pending).outcome, "completed");
    assert.equal((await session.status()).wire, "signed-in");
    assert.equal((await session.status()).microsoft.state, "connected");
    assert.equal((await session.status()).authorization.retained, true);
    assert.equal((await session.status()).collection, "paused");
    assert.equal(await session.collectionIntent(), null);
});

test("storage failure at final connection commit cannot report connected or retain a live browser", async t => {
    const { session: initial, context, open, fake, file } = await fixture(t);
    await initial.close();
    const underlying = sessionStorage(context);
    const session = await open({ storage: { ...underlying, write: async value => {
        if (value.connection === "connected") throw new Error("SYNTHETIC_SECRET commit failure");
        await underlying.write(value);
    } } });
    await signIn(session);
    await assert.rejects(connect(session), code("storage-failed"));
    assert.equal((await session.status()).authorization.microsoftAcquisition, false);
    assert.equal(fake.owners.size, 0);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.notEqual(saved.connection, "connected");
    assert.ok(saved.owner);
    assert.equal(saved.receipts.at(-1).outcome, "pending");
    assert.doesNotMatch(await readFile(file, "utf8"), /SYNTHETIC_SECRET/);
});

test("receipt capacity fails closed rather than evicting no-replay history", async t => {
    const { session: initial, context, file, open } = await fixture(t);
    await signIn(initial);
    await initial.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    const original = saved.receipts[0];
    saved.receipts = Array.from({ length: 1024 }, () => ({ ...original, operationId: randomUUID() }));
    await writeFile(file, JSON.stringify(saved));
    const fresh = await open();
    await assert.rejects(act(fresh, "wire-sign-in"), code("receipt-limit"));
    assert.equal((await fresh.status()).wire, "signed-out");
    assert.equal((await fresh.status()).authorization.retained, false);
    assert.equal(JSON.parse(await readFile(file, "utf8")).wire, "signed-out");
    assert.equal(JSON.parse(await readFile(file, "utf8")).receipts.length, 1024);
    assert.equal(await sessionStorage(context).read().then(state => state.receipts.length), 1024);
});

test("unavailable Microsoft recovery never becomes a prerequisite to reopen already-authorized GitHub", async t => {
    const { session: initial, file, open, fake } = await fixture(t);
    await initial.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.owner = { id: randomUUID(), phase: "closing" };
    saved.connection = "recovery-required";
    saved.reason = "cleanup-failed";
    await writeFile(file, JSON.stringify(saved));
    const fresh = await open({ transport: undefined });
    assert.equal((await fresh.status()).wire, "signed-out");
    await signIn(fresh);
    assert.equal((await fresh.status()).authorization.githubAcquisition, true);
    assert.equal((await fresh.status()).authorization.retained, true);
    assert.equal((await fresh.status()).authorization.microsoftAcquisition, false);
    await assert.rejects(act(fresh, "microsoft-recover"), code("hooks-unqualified"));
    assert.deepEqual(fake.events, []);
});

for (const point of ["visible-marker", "cleanup-marker", "failed-receipt", "released-marker"]) {
    test(`storage failure at ${point} still stops only its owner and never produces a usable connection`, async t => {
        const { session: initial, context, file, open, fake } = await fixture(t, {
            overrides: point === "failed-receipt" ? { verify: async () => { throw new Error("SYNTHETIC_SECRET"); } } : {},
        });
        await initial.close();
        const underlying = sessionStorage(context);
        let sawOwner = false;
        const session = await open({ storage: { ...underlying, write: async value => {
            const shouldFail = point === "visible-marker" && value.owner?.phase === "visible"
                || point === "cleanup-marker" && value.owner?.phase === "closing"
                || point === "failed-receipt" && value.receipts.some(receipt => receipt.outcome === "failed")
                || point === "released-marker" && sawOwner && !value.owner;
            if (shouldFail) throw new Error("SYNTHETIC_SECRET");
            await underlying.write(value);
            sawOwner ||= Boolean(value.owner);
        } } });
        await signIn(session);
        await assert.rejects(connect(session), code("storage-failed"));
        assert.equal(fake.owners.size, 0);
        assert.equal((await session.status()).authorization.microsoftAcquisition, false);
        assert.doesNotMatch(await readFile(file, "utf8"), /SYNTHETIC_SECRET/);
        if (point === "visible-marker") assert.equal(fake.events.length, 0);
    });
}

test("expired/read/retained leases and emitted intents are invalidated by Pause, replacement and close", async t => {
    const { session } = await fixture(t);
    await signIn(session);
    await connect(session);
    const intent = await session.collectionIntent();
    const github = await session.lease("github-acquisition");
    const retained = await session.lease("retained");
    await session.updateCollection({ paused: true, windowDays: 14 });
    await assert.rejects(session.assertLease(intent.lease), code("lease-invalid"));
    await assert.rejects(session.assertLease(github), code("lease-invalid"));
    assert.equal(await session.assertLease(retained), true);
    await session.updateCollection({ paused: false, windowDays: 14 });
    await assert.rejects(session.assertLease(intent.lease), code("lease-invalid"));
    await assert.rejects(session.assertLease(github), code("lease-invalid"));
    await session.close();
    await assert.rejects(session.assertLease(retained), code("session-closed"));
});

test("cancel and recovery without pending work are rejected rather than reporting a successful connection operation", async t => {
    const { session } = await fixture(t);
    await assert.rejects(act(session, "microsoft-cancel"), code("invalid-request"));
    await assert.rejects(act(session, "microsoft-recover"), code("invalid-request"));
    assert.equal(await session.receipt(PANEL_A, randomUUID()), null);
});

test("changed runtime lock ownership is never removed by shutdown", async t => {
    const { session, context, fake } = await fixture(t);
    await signIn(session);
    await connect(session);
    const file = path.join(context.dataDir, "microsoft-session", "collector.lock");
    const replacement = { pid: process.pid, token: randomUUID() };
    await writeFile(file, JSON.stringify(replacement));
    await assert.rejects(session.close(), code("storage-failed"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), replacement);
    assert.equal(fake.owners.size, 0);
});

test("admit holds the state queue through awaited publication; queued sign-out wins over later stale admission", async t => {
    const { session, file } = await fixture(t);
    await signIn(session);
    const value = await session.lease("retained");
    const signout = await operation(session, "wire-sign-out");
    const entered = deferred(), finish = deferred(), events = [];
    const unsubscribe = session.subscribeAuthorizationChange(event => events.push(event));
    const initialEvents = events.length;
    let staleRan = false;
    const admitted = session.admit(value, async () => {
        entered.resolve();
        await finish.promise;
        assert.equal(events.length, initialEvents);
        assert.equal(JSON.parse(await readFile(file, "utf8")).wire, "signed-in");
        return "published-before-sign-out";
    });
    await entered.promise;
    const signedOut = session.command(PANEL_A, signout, authorizeSynthetic);
    const stale = assert.rejects(session.admit(value, () => { staleRan = true; }), code("lease-invalid"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.length, initialEvents);
    assert.equal(JSON.parse(await readFile(file, "utf8")).wire, "signed-in");
    finish.resolve();
    assert.equal(await admitted, "published-before-sign-out");
    assert.equal((await signedOut).outcome, "completed");
    await stale;
    assert.equal(staleRan, false);
    assert.equal(events.at(-1).retained, false);
    assert.ok(events.at(-1).generation > value.generation);
    unsubscribe();
});

for (const change of ["expire", "pause", "close"]) {
    test(`admit also serializes deferred callback before ${change}`, async t => {
        const { session } = await fixture(t);
        await signIn(session);
        await connect(session);
        const value = await session.lease("microsoft-read");
        const entered = deferred(), finish = deferred(), order = [];
        session.subscribeAuthorizationChange(() => { order.push("authorization"); });
        const admitted = session.admit(value, async () => {
            entered.resolve();
            await finish.promise;
            order.push("published");
            return 42;
        });
        await entered.promise;
        const before = order.length;
        const changed = change === "expire" ? session.expire(value)
            : change === "pause" ? session.updateCollection({ paused: true, windowDays: 14 }) : session.close();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(order.length, before);
        finish.resolve();
        assert.equal(await admitted, 42);
        await changed;
        assert.equal(order[before], "published");
        assert.equal(order[before + 1], "authorization");
        await assert.rejects(session.admit(value, () => assert.fail("Stale publication")), code(change === "close" ? "session-closed" : "lease-invalid"));
    });
}

test("failed or reentrant admission is explicit, sanitized, never replayed and does not poison later queue work", async t => {
    const { session } = await fixture(t);
    await signIn(session);
    const value = await session.lease("retained");
    const signout = await operation(session, "wire-sign-out");
    let calls = 0;
    await assert.rejects(session.admit(value, async () => {
        calls++;
        throw new Error("SYNTHETIC_SECRET callback");
    }), error => code("admission-failed")(error) && !error.message.includes("SYNTHETIC_SECRET"));
    for (const work of [
        () => session.status(),
        () => session.command(PANEL_A, signout, authorizeSynthetic),
        () => session.receipt(PANEL_A, signout.operationId),
        () => session.admit(value, () => undefined),
        () => session.updateCollection({ paused: true, windowDays: 14 }),
        () => session.close(),
        () => session.subscribeAuthorizationChange(() => undefined),
        async () => { await Promise.resolve(); return session.lease("retained"); },
    ]) await assert.rejects(session.admit(value, work), code("reentrant-call"));
    await assert.rejects(session.admit(value, null), code("invalid-request"));
    assert.equal(calls, 1);
    assert.equal(await session.admit(value, () => "usable"), "usable");
    assert.equal((await session.command(PANEL_A, signout, authorizeSynthetic)).outcome, "completed");
});

test("subscriptions synchronously seed and invalidate no-private authorization before publication, with Pause retained semantics", async t => {
    const { session } = await fixture(t);
    const events = [], controller = new AbortController();
    const unsubscribe = session.subscribeAuthorizationChange(event => { events.push(event); });
    assert.deepEqual(events, [{
        revision: 0, generation: 0, wire: "signed-out", collection: "enabled",
        retained: false, githubAcquisition: false, microsoftAcquisition: false,
    }]);
    await signIn(session);
    const retained = await session.lease("retained");
    const acquisition = await session.lease("github-acquisition");
    session.subscribeAuthorizationChange(event => {
        if (event.generation !== retained.generation || !event.retained) controller.abort();
    });
    await session.updateCollection({ paused: true, windowDays: 30 });
    assert.equal(events.at(-1).retained, true);
    assert.equal(events.at(-1).githubAcquisition, false);
    assert.equal(events.at(-1).generation, retained.generation);
    assert.equal(controller.signal.aborted, false);
    assert.equal(await session.admit(retained, () => "retained-publication"), "retained-publication");
    await assert.rejects(session.admit(acquisition, () => assert.fail("Paused acquisition")), code("lease-invalid"));
    await session.updateCollection({ paused: false, windowDays: 30 });
    assert.equal(events.at(-1).githubAcquisition, true);
    await act(session, "wire-sign-out");
    assert.equal(controller.signal.aborted, true);
    await assert.rejects(session.admit(retained, () => assert.fail("Signed-out publication")), code("lease-invalid"));
    for (const event of events) {
        assert.deepEqual(Object.keys(event).sort(), ["collection", "generation", "githubAcquisition", "microsoftAcquisition", "retained", "revision", "wire"]);
        assert.ok(Object.isFrozen(event));
    }
    for (let i = 1; i < events.length; i++) assert.ok(events[i].revision > events[i - 1].revision);
    const before = events.length;
    assert.equal(unsubscribe(), true);
    assert.equal(unsubscribe(), false);
    await signIn(session);
    await session.close();
    assert.equal(events.length, before);
});

test("provider expiry and deliberate account replacement notify while retaining separate GitHub eligibility", async t => {
    const { session } = await fixture(t);
    await signIn(session);
    await connect(session);
    const events = [];
    session.subscribeAuthorizationChange(event => events.push(event));
    const value = await session.lease("microsoft-read");
    assert.equal(events.at(-1).microsoftAcquisition, true);
    await session.expire(value);
    assert.equal(events.at(-1).microsoftAcquisition, false);
    assert.equal(events.at(-1).githubAcquisition, true);
    assert.equal(events.at(-1).retained, true);
    await connect(session, ACCOUNT_B, true);
    assert.ok(events.at(-1).generation > value.generation);
    assert.equal(events.at(-1).microsoftAcquisition, true);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(`${ACCOUNT_A}|${ACCOUNT_B}|partition|owner|receipt`));
});

test("replacement completion revokes leases acquired while the previous partition remained visible", async t => {
    const blocked = deferred();
    let replacing = false;
    const { session, fake } = await fixture(t, { overrides: { verify: async input => {
        if (replacing) await blocked.promise;
        return { partition: input.expectedPartition, chat: true, cowork: true };
    } } });
    await signIn(session);
    await connect(session);
    replacing = true;
    const pending = connect(session, ACCOUNT_B, true);
    await until(() => fake.events.filter(event => event[0] === "verify").length === 3);
    const oldPartition = await session.lease("microsoft-retained");
    assert.equal(oldPartition.partition, ACCOUNT_A);
    let last;
    session.subscribeAuthorizationChange(event => { last = event; });
    assert.equal(last.generation, oldPartition.generation);
    blocked.resolve();
    const result = await pending;
    assert.equal(result.outcome, "completed");
    assert.ok(last.generation > oldPartition.generation);
    assert.equal(result.generation, last.generation);
    await assert.rejects(session.admit(oldPartition, () => assert.fail("Previous-account publication")), code("lease-invalid"));
});

test("storage poisoning notifies before queued publication and close notifies before releasing authority", async t => {
    const { session: initial, context, open } = await fixture(t);
    await initial.close();
    const underlying = sessionStorage(context);
    let failing = false;
    const session = await open({ storage: { ...underlying, write: async value => {
        if (failing) throw new Error("SYNTHETIC_SECRET");
        await underlying.write(value);
    } } });
    await signIn(session);
    const value = await session.lease("retained");
    let last;
    session.subscribeAuthorizationChange(event => { last = event; });
    failing = true;
    const signout = session.command(PANEL_A, await operation(session, "wire-sign-out"), authorizeSynthetic);
    const stale = assert.rejects(session.admit(value, () => assert.fail("Poisoned publication")), code("storage-failed"));
    await assert.rejects(signout, code("storage-failed"));
    await stale;
    assert.equal(last.retained, false);
    assert.equal(last.githubAcquisition, false);
    assert.equal(last.microsoftAcquisition, false);
    const before = last.revision;
    await assert.rejects(session.close(), code("storage-failed"));
    assert.ok(last.revision > before);
    assert.equal(last.retained, false);
});

test("subscriber failures notify remaining consumers of poisoned authorization and surface only a fixed error", async t => {
    const { session } = await fixture(t);
    await signIn(session);
    const value = await session.lease("retained");
    let fail = false, last;
    const first = session.subscribeAuthorizationChange(() => {
        if (fail) throw new Error("SYNTHETIC_SECRET observer");
    });
    session.subscribeAuthorizationChange(event => { last = event; });
    fail = true;
    await assert.rejects(session.updateCollection({ paused: true, windowDays: 14 }), error =>
        code("authorization-listener-failed")(error) && !error.message.includes("SYNTHETIC_SECRET"));
    assert.equal(last.retained, false);
    assert.equal(last.githubAcquisition, false);
    await assert.rejects(session.admit(value, () => assert.fail("Failed invalidation publication")), code("authorization-listener-failed"));
    assert.equal((await session.status()).microsoft.reason, "authorization-listener-failed");
    first();
});

test("async/reentrant subscription registration is refused without disturbing existing authorization", async t => {
    const { session } = await fixture(t);
    await signIn(session);
    assert.throws(() => session.subscribeAuthorizationChange(async () => { throw new Error("SYNTHETIC_SECRET"); }), code("authorization-listener-failed"));
    assert.throws(() => session.subscribeAuthorizationChange(() => session.status()), code("authorization-listener-failed"));
    assert.throws(() => session.subscribeAuthorizationChange(null), code("invalid-request"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await session.status()).authorization.retained, true);
});

test("receipts persist backend ownership and reject different owners before and after restart without exposing owner material", async t => {
    const { session, file, open } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    const result = await session.command(PANEL_A, input, authorizeSynthetic);
    assert.deepEqual(await session.command(PANEL_A, input, authorizeSynthetic), result);
    assert.deepEqual(await session.receipt(PANEL_A, input.operationId), result);
    await assert.rejects(session.command(PANEL_B, input, authorizeSynthetic), error => code("operation-owner")(error) && error.status === 403);
    await assert.rejects(session.receipt(PANEL_B, input.operationId), code("operation-owner"));
    await assert.rejects(session.command(PANEL_B, { ...input, action: "wire-sign-out" }, authorizeSynthetic), code("operation-owner"));
    await session.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    const expectedOwner = createHash("sha256").update(JSON.stringify(PANEL_A)).digest("hex");
    const entry = saved.receipts.find(row => row.operationId === input.operationId);
    assert.equal(entry.ownerHash, expectedOwner);
    assert.equal(entry.fingerprint, createHash("sha256").update(JSON.stringify({ ownerHash: expectedOwner, ...input })).digest("hex"));
    assert.doesNotMatch(JSON.stringify(result) + await readFile(file, "utf8"), new RegExp(PANEL_A));
    assert.ok(!Object.hasOwn(result, "ownerHash"));
    assert.ok(!Object.hasOwn(result, "fingerprint"));
    const fresh = await open();
    assert.deepEqual(await fresh.command(PANEL_A, input, authorizeSynthetic), result);
    assert.deepEqual(await fresh.receipt(PANEL_A, input.operationId), result);
    await assert.rejects(fresh.command(PANEL_B, input, authorizeSynthetic), code("operation-owner"));
    await assert.rejects(fresh.receipt(PANEL_B, input.operationId), code("operation-owner"));
});

test("pending operations cannot be replayed or inspected under a second panel owner", async t => {
    const gate = deferred();
    const { session, fake } = await fixture(t, { overrides: { verify: async input => {
        await gate.promise;
        return { partition: input.expectedPartition, chat: true, cowork: true };
    } } });
    await signIn(session);
    const input = await operation(session, "microsoft-connect", { expectedPartition: ACCOUNT_A, replace: false });
    const pending = session.command(PANEL_A, input, authorizeSynthetic);
    await until(() => fake.events.some(event => event[0] === "verify"));
    assert.equal((await session.receipt(PANEL_A, input.operationId)).outcome, "pending");
    await assert.rejects(session.command(PANEL_B, input, authorizeSynthetic), code("operation-owner"));
    await assert.rejects(session.receipt(PANEL_B, input.operationId), code("operation-owner"));
    gate.resolve();
    assert.equal((await pending).outcome, "completed");
    assert.equal(fake.events.filter(event => event[0] === "open").length, 2);
});

test("legacy ownerless receipts are preserved but never adopted for lookup or replay by any panel", async t => {
    const { session, file, open, fake } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    await session.command(PANEL_A, input, authorizeSynthetic);
    await session.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    const entry = saved.receipts[0];
    delete entry.ownerHash;
    entry.fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await writeFile(file, JSON.stringify(saved));
    const fresh = await open();
    for (const owner of [PANEL_A, PANEL_B]) {
        await assert.rejects(fresh.command(owner, input, authorizeSynthetic), code("operation-owner"));
        await assert.rejects(fresh.receipt(owner, input.operationId), code("operation-owner"));
    }
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).receipts[0], entry);
    assert.equal(fake.events.length, 0);
    await act(fresh, "wire-sign-out");
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(after.receipts[0], entry);
    assert.ok(after.receipts[1].ownerHash);
});

test("restart marks an ownerless interrupted receipt ambiguous without assigning a new owner", async t => {
    const { session, file, open } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    await session.command(PANEL_A, input, authorizeSynthetic);
    await session.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    const entry = saved.receipts[0];
    delete entry.ownerHash;
    entry.outcome = "pending";
    await writeFile(file, JSON.stringify(saved));
    const fresh = await open();
    await assert.rejects(fresh.receipt(PANEL_A, input.operationId), code("operation-owner"));
    await assert.rejects(fresh.command(PANEL_A, input, authorizeSynthetic), code("operation-owner"));
    const recovered = JSON.parse(await readFile(file, "utf8")).receipts[0];
    assert.equal(recovered.outcome, "ambiguous");
    assert.equal(recovered.reason, "restart-required");
    assert.equal(recovered.fingerprint, entry.fingerprint);
    assert.ok(!Object.hasOwn(recovered, "ownerHash"));
});

test("malformed persisted owner hashes are rejected instead of becoming adoptable legacy receipts", async t => {
    const { session, file, open } = await fixture(t);
    await signIn(session);
    await session.close();
    const saved = JSON.parse(await readFile(file, "utf8"));
    for (const invalid of [null, "", "not-a-hash", [], "a".repeat(63)]) {
        saved.receipts[0].ownerHash = invalid;
        await writeFile(file, JSON.stringify(saved));
        await assert.rejects(open(), code("state-invalid"));
    }
});

test("missing/invalid backend owners and frontend owner fields are rejected without creating receipts", async t => {
    const { session, file } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    for (const owner of [undefined, null, {}, "", "short", "x".repeat(257), "owner-with-?arbitrary"]) {
        await assert.rejects(session.command(owner, input, authorizeSynthetic), code("invalid-request"));
        await assert.rejects(session.receipt(owner, input.operationId), code("invalid-request"));
    }
    await assert.rejects(session.command(input), code("invalid-request"));
    await assert.rejects(session.command(PANEL_A, { ...input, owner: PANEL_B }, authorizeSynthetic), code("invalid-request"));
    await assert.rejects(session.command(PANEL_A, { ...input, ownerHash: "b".repeat(64) }, authorizeSynthetic), code("invalid-request"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).receipts, []);
});

for (const invalidation of ["released", "expired"]) {
    test(`a capability ${invalidation} while the request body is pending cannot sign in WIRE`, async t => {
        const { session, file } = await fixture(t);
        const input = await operation(session, "wire-sign-in");
        const body = deferred();
        let now = 100, released = false, checks = 0;
        const authorize = () => { checks++; return !released && now < 200; };
        assert.equal(authorize(), true, "Earlier request check is not command admission.");
        const request = body.promise.then(() => session.command(PANEL_A, input, authorize));
        const rejected = assert.rejects(request, error => code("command-unauthorized")(error) && error.status === 403);
        if (invalidation === "released") released = true;
        else now = 200;
        body.resolve();
        await rejected;
        assert.equal(checks, 2);
        assert.equal((await session.status()).wire, "signed-out");
        assert.equal(await session.receipt(PANEL_A, input.operationId), null);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")).receipts, []);
    });

    test(`a capability ${invalidation} while sign-in is queued is checked inside the serialized command admission`, async t => {
        const { session: initial, context, open, file } = await fixture(t);
        await initial.close();
        const underlying = sessionStorage(context);
        const writing = deferred(), finishWrite = deferred();
        let blockSignout = false, now = 100, released = false, checks = 0;
        const session = await open({ storage: { ...underlying, write: async value => {
            if (blockSignout && value.wire === "signed-out") {
                writing.resolve();
                await finishWrite.promise;
            }
            await underlying.write(value);
        } } });
        await signIn(session);
        const signout = await operation(session, "wire-sign-out");
        const signin = { action: "wire-sign-in", operationId: randomUUID(), generation: signout.generation + 1 };
        blockSignout = true;
        const signedOut = session.command(PANEL_A, signout, authorizeSynthetic);
        await writing.promise;
        const queued = session.command(PANEL_A, signin, () => { checks++; return !released && now < 200; });
        const rejected = assert.rejects(queued, code("command-unauthorized"));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(checks, 0, "Admission guard cannot run ahead of the lifecycle queue.");
        if (invalidation === "released") released = true;
        else now = 200;
        finishWrite.resolve();
        assert.equal((await signedOut).outcome, "completed");
        await rejected;
        assert.equal(checks, 1);
        assert.equal((await session.status()).wire, "signed-out");
        assert.equal(await session.receipt(PANEL_A, signin.operationId), null);
        assert.equal(JSON.parse(await readFile(file, "utf8")).wire, "signed-out");
    });
}

test("command admission fails closed for missing, false, non-boolean, throwing, async and reentrant guards", async t => {
    const { session, file } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    const before = await readFile(file, "utf8");
    for (const authorize of [
        undefined, null, true, () => false, () => undefined, () => 1, () => ({}),
        () => { throw new Error("SYNTHETIC_SECRET guard"); },
        async () => true,
        async () => { throw new Error("SYNTHETIC_SECRET async guard"); },
        () => session.status(),
        () => session.close(),
    ]) {
        await assert.rejects(session.command(PANEL_A, input, authorize), error =>
            code("command-unauthorized")(error) && error.status === 403 && !error.message.includes("SYNTHETIC_SECRET"));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal((await session.status()).wire, "signed-out");
    assert.equal(await session.receipt(PANEL_A, input.operationId), null);
    assert.equal((await session.command(PANEL_A, input, authorizeSynthetic)).outcome, "completed");
});

test("revoked capabilities cannot use command replay to recover an existing receipt", async t => {
    const { session, file, open } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    const result = await session.command(PANEL_A, input, authorizeSynthetic);
    const before = await readFile(file, "utf8");
    await assert.rejects(session.command(PANEL_A, input, () => false), code("command-unauthorized"));
    assert.equal(await readFile(file, "utf8"), before);
    await session.close();
    const fresh = await open();
    await assert.rejects(fresh.command(PANEL_A, input, () => false), code("command-unauthorized"));
    assert.deepEqual(await fresh.command(PANEL_A, input, authorizeSynthetic), result);
    assert.deepEqual(await fresh.receipt(PANEL_A, input.operationId), result);
});

for (const invalidation of ["released", "expired"]) {
    test(`capability ${invalidation} after command admission preserves the started outcome and durable operation receipt`, async t => {
        const { session: initial, context, open, file } = await fixture(t);
        await initial.close();
        const underlying = sessionStorage(context);
        const writing = deferred(), finishWrite = deferred();
        let released = false, now = 100, checks = 0;
        const session = await open({ storage: { ...underlying, write: async value => {
            if (value.wire === "signed-in") {
                writing.resolve();
                await finishWrite.promise;
            }
            await underlying.write(value);
        } } });
        const input = await operation(session, "wire-sign-in");
        const started = session.command(PANEL_A, input, () => { checks++; return !released && now < 200; });
        await writing.promise;
        assert.equal(checks, 1);
        if (invalidation === "released") released = true;
        else now = 200;
        finishWrite.resolve();
        const receipt = await started;
        assert.equal(receipt.outcome, "completed");
        assert.equal(checks, 1, "An admitted operation is not retroactively made unstarted.");
        assert.equal((await session.status()).wire, "signed-in");
        assert.deepEqual(await session.receipt(PANEL_A, input.operationId), receipt);
        assert.equal(JSON.parse(await readFile(file, "utf8")).receipts.at(-1).operationId, input.operationId);
    });
}

test("the capability callback is backend-only and never enters request fingerprints or receipts", async t => {
    const { session, file } = await fixture(t);
    const input = await operation(session, "wire-sign-in");
    await assert.rejects(session.command(PANEL_A, { ...input, authorize: true }, authorizeSynthetic), code("invalid-request"));
    let calls = 0;
    const receipt = await session.command(PANEL_A, input, () => { calls++; return true; });
    assert.deepEqual(await session.command(PANEL_A, input, () => { calls++; return true; }), receipt);
    assert.equal(calls, 2);
    assert.doesNotMatch(await readFile(file, "utf8"), /authorize|capability|command-admission/);
});

test("authorization events and serialized status expose one coherent wire, collection and revision projection", async t => {
    const { session } = await fixture(t);
    const events = [];
    const unsubscribe = session.subscribeAuthorizationChange(event => { events.push(event); });
    assert.deepEqual(events, [{
        revision: 0, generation: 0, wire: "signed-out", collection: "enabled",
        retained: false, githubAcquisition: false, microsoftAcquisition: false,
    }]);
    async function assertCurrent(expected) {
        const before = events.length;
        const status = await session.status();
        assert.deepEqual(events.at(-1), expected);
        assert.equal(status.authorizationRevision, expected.revision);
        assert.equal(status.generation, expected.generation);
        assert.equal(status.wire, expected.wire);
        assert.equal(status.collection, expected.collection);
        assert.equal(status.authorization.retained, expected.retained);
        assert.equal(status.authorization.githubAcquisition, expected.githubAcquisition);
        assert.equal(status.authorization.microsoftAcquisition, expected.microsoftAcquisition);
        assert.deepEqual(await session.status(), status);
        assert.equal(events.length, before, "Reading status must not advance authorization or emit updates.");
    }
    await assertCurrent(events[0]);
    await signIn(session);
    await assertCurrent({
        revision: 1, generation: 1, wire: "signed-in", collection: "enabled",
        retained: true, githubAcquisition: true, microsoftAcquisition: false,
    });
    const retained = await session.lease("retained");
    const changed = session.updateCollection({ paused: true, windowDays: 30 });
    const published = session.admit(retained, () => ({ ...events.at(-1) }));
    await changed;
    const paused = {
        revision: 2, generation: 1, wire: "signed-in", collection: "paused",
        retained: true, githubAcquisition: false, microsoftAcquisition: false,
    };
    assert.deepEqual(await published, paused, "The synchronous event must be complete before later publication.");
    await assertCurrent(paused);
    await session.updateCollection({ paused: false, windowDays: 30 });
    await assertCurrent({
        revision: 3, generation: 1, wire: "signed-in", collection: "enabled",
        retained: true, githubAcquisition: true, microsoftAcquisition: false,
    });
    assert.ok(events.every(Object.isFrozen));
    unsubscribe();
});

test("failed close restores retained access only at a newer generation with coherent negative and positive control projections", async t => {
    const stopEntered = deferred(), finishStop = deferred();
    let delayStop = false;
    const { session } = await fixture(t, { overrides: { stop: async () => {
        if (delayStop) {
            stopEntered.resolve();
            return finishStop.promise;
        }
        return { processExited: true, profileReleased: true };
    } } });
    await signIn(session);
    await connect(session);
    const oldLease = await session.lease("retained");
    const events = [];
    session.subscribeAuthorizationChange(event => { events.push(event); });
    assert.equal(events[0].retained, true);
    assert.equal(events[0].generation, oldLease.generation);
    delayStop = true;
    const closing = assert.rejects(session.close(), code("cleanup-failed"));
    await stopEntered.promise;
    const negative = events.at(-1), duringClose = await session.status();
    assert.equal(events[1].retained, false);
    assert.equal(events[1].generation, oldLease.generation);
    assert.equal(negative.generation, oldLease.generation + 1);
    assert.equal(negative.wire, "signed-in");
    assert.equal(negative.collection, "enabled");
    assert.equal(negative.retained, false, "Effective access must override the durable signed-in label.");
    assert.equal(duringClose.authorizationRevision, negative.revision);
    assert.equal(duringClose.generation, negative.generation);
    assert.equal(duringClose.wire, negative.wire);
    assert.equal(duringClose.collection, negative.collection);
    assert.equal(duringClose.authorization.retained, false);
    finishStop.resolve({ processExited: false, profileReleased: false });
    await closing;
    const restored = events.at(-1), status = await session.status();
    assert.equal(restored.retained, true);
    assert.equal(restored.generation, negative.generation, "An initially negative generation can become readable.");
    assert.ok(restored.revision > negative.revision);
    assert.equal(status.authorizationRevision, restored.revision);
    assert.equal(status.wire, restored.wire);
    assert.equal(status.collection, restored.collection);
    assert.equal(status.authorization.retained, true);
    assert.ok(events.slice(1).every(event => !event.retained || event.generation > oldLease.generation),
        "The last previously readable generation must never become readable again.");
    await assert.rejects(session.admit(oldLease, () => assert.fail("Retired publication")), code("lease-invalid"));
    await session.admit(await session.lease("retained"), () => assert.equal(events.at(-1), restored));
    delayStop = false;
});

test("poisoned authorization retains truthful gate and Pause labels without restoring authority or losing revision coherence", async t => {
    const { session: initial, context, open } = await fixture(t);
    await initial.close();
    const storage = sessionStorage(context);
    let fail = false;
    const session = await open({ storage: { ...storage, write: async value => {
        if (fail) throw new Error("Synthetic storage failure.");
        await storage.write(value);
    } } });
    await signIn(session);
    await session.updateCollection({ paused: true, windowDays: 30 });
    const events = [];
    session.subscribeAuthorizationChange(event => { events.push(event); });
    const readable = events[0];
    fail = true;
    await assert.rejects(act(session, "wire-sign-out"), code("storage-failed"));
    const negative = events.at(-1), status = await session.status();
    assert.equal(negative.wire, "signed-in");
    assert.equal(negative.collection, "paused");
    assert.equal(negative.generation, readable.generation);
    assert.ok(negative.revision > readable.revision);
    assert.equal(negative.retained, false);
    assert.equal(negative.githubAcquisition, false);
    assert.equal(negative.microsoftAcquisition, false);
    assert.equal(status.authorizationRevision, negative.revision);
    assert.equal(status.wire, negative.wire);
    assert.equal(status.collection, negative.collection);
    assert.equal(status.authorization.retained, false);
    await assert.rejects(signIn(session), code("storage-failed"));
    await assert.rejects(session.close(), code("storage-failed"));
    assert.ok(events.slice(1).every(event => !event.retained));
    assert.equal((await session.status()).authorizationRevision, events.at(-1).revision);
});
