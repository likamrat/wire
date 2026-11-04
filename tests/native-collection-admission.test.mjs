import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftNativeRequestObserver } from "../lib/microsoft-native-request-observer.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { BoardError } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";

async function fixture(t, { persistCollectionSettings, paused = false, nativeConnection = false, expectedCloseError } = {}) {
    const cleanups = [];
    const { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: async () => ({
            tenantId: "example-tenant", subjectId: "example-subject", knownAccountMatched: true,
            evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() },
        }),
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused, windowDays: 30 },
        persistCollectionSettings });
    let access, runtime;
    t.after(async () => {
        await runtime?.close(); access?.close();
        try {
            if (expectedCloseError) await assert.rejects(lifecycle.close(), { code: expectedCloseError });
            else await lifecycle.close();
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        const result = await lifecycle.command("example-native-backend", {
            action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
            ...(action === "microsoft-connect" ? { replace: false } : {}),
        }, () => true);
        assert.equal(result.outcome, "completed");
    }
    access = await createNativeRuntimeAccess(context, { lifecycle, nativeSource: async () => [], nativeConnection });
    runtime = await startServer(context, createExportController(context),
        { port: 0, access, collector: { timers: false }, sessionTtlMs: 1000 });
    const origin = new URL(runtime.url).origin;
    async function api(capability, route, input, method = "POST") {
        const response = await fetch(origin + route, { method, headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}) });
        return { status: response.status, body: await response.json() };
    }
    const panel = async () => (await api(null, "/api/session", {})).body.capability;
    async function control(capability, enabled, route = "/api/collection/enabled") {
        const input = { enabled, expectedNativeRevision: (await lifecycle.status()).authorizationRevision };
        return api(capability, route, route === "/api/canvas" ? { action: "set_collection_enabled", input } : input);
    }
    return { lifecycle, runtime, origin, api, panel, control };
}

test("native product connection control is opt-in and absent from unchanged readonly bindings", async t => {
    const app = await fixture(t), capability = await app.panel();
    const before = await app.lifecycle.status();
    const status = await app.api(capability, "/api/access/status", undefined, "GET");
    const watch = await app.api(capability, "/api/access/watch", { schemaVersion: 1, after: null });
    assert.equal(Object.hasOwn(status.body, "microsoft"), false);
    assert.equal(Object.hasOwn(watch.body, "microsoft"), false);
    const denied = await app.api(capability, "/api/access/command", {
        schemaVersion: 1, action: "microsoft-connect", operationId: randomUUID(), generation: before.generation,
    });
    assert.equal(denied.status, 422);
    assert.equal((await app.lifecycle.status()).generation, before.generation);
});

test("native Settings connection publishes one coherent status/watch descriptor without collection", async t => {
    let settingsWrites = 0;
    const app = await fixture(t, { paused: true, nativeConnection: true,
        async persistCollectionSettings(value) { settingsWrites++; return value; } });
    const capability = await app.panel();
    const initial = await app.api(capability, "/api/access/status", undefined, "GET");
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.microsoft, { state: "connected", reason: null, actions: ["microsoft-connect"] });
    const operationId = randomUUID();
    const connected = await app.api(capability, "/api/access/command", {
        schemaVersion: 1, action: "microsoft-connect", operationId, generation: initial.body.generation,
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.outcome, "completed");
    assert.equal(connected.body.revocation, null);
    assert.equal(settingsWrites, 0, "Connect must not configure or resume collection.");
    await assert.rejects(app.lifecycle.lease("microsoft-read"), { code: "lease-invalid" });
    const current = await app.api(capability, "/api/access/status", undefined, "GET");
    const watch = await app.api(capability, "/api/access/watch", { schemaVersion: 1, after: null });
    assert.equal(current.body.generation, watch.body.generation);
    assert.equal(current.body.authorizationRevision, watch.body.authorizationRevision);
    assert.deepEqual(current.body.microsoft, watch.body.microsoft);
    assert.deepEqual(Object.keys(watch.body.microsoft).sort(), ["actions", "reason", "state"]);
    const ownReceipt = await app.api(capability, "/api/access/receipt", { schemaVersion: 1, operationId });
    assert.deepEqual(ownReceipt.body, connected.body);
    const foreign = await app.panel();
    assert.equal((await app.api(foreign, "/api/access/receipt", { schemaVersion: 1, operationId })).status, 403);
    const beforeRejected = await app.lifecycle.status();
    for (const extra of [{ replace: true }, { expectedPartition: "0".repeat(64) }]) {
        const rejected = await app.api(capability, "/api/access/command", {
            schemaVersion: 1, action: "microsoft-connect", operationId: randomUUID(),
            generation: beforeRejected.generation, ...extra,
        });
        assert.equal(rejected.status, 422);
    }
    assert.equal((await app.lifecycle.status()).generation, beforeRejected.generation);
});

test("identity-only native connection permits public Resume without claiming or acquiring source content", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t, { paused: true }), capability = await app.panel();
    const connected = await app.lifecycle.status();
    assert.equal(connected.microsoft.state, "connected");
    assert.equal(connected.collection, "paused");
    assert.equal(connected.microsoft.surfaces.chat.access, "not-verified");
    assert.equal(connected.microsoft.surfaces.cowork.access, "not-verified");
    await assert.rejects(app.lifecycle.lease("microsoft-read"), { code: "lease-invalid" });
    assert.equal((await app.control(capability, true)).status, 200);
    const lease = await app.lifecycle.lease("microsoft-read");
    assert.equal(lease.kind, "microsoft-read");
    assert.equal(await app.lifecycle.assertLease(lease), true);
    assert.equal((await app.lifecycle.status()).microsoft.surfaces.chat.access, "not-verified");
});

test("explicit native Enable holds configuration commit and runtime adoption in one lifecycle turn", async t => {
    const app = await fixture(t, { paused: true });
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    let token, dispatched = 0, observed, readSettled = false;
    const enabling = app.lifecycle.admitNativeConfiguration({ intent: "enable", windowDays: 7 }, {
        owner: "example-native-backend", check() {}, dispatched() { dispatched++; },
    }, async (value, admission) => {
        token = value;
        observed = app.lifecycle.assertNativeConfigurationAdmission(value);
        assert.equal(observed.intent, "enable");
        assert.equal(observed.owner, "example-native-backend");
        assert.equal(observed.account.subjectId, "example-subject");
        assert.deepEqual(Object.keys(value), []);
        assert.equal(Object.isFrozen(observed.settings), true);
        entered.resolve();
        await resume.promise;
        admission.check(); admission.dispatched();
        return { settings: observed.settings };
    });
    let nextIntent;
    try {
        await Promise.race([entered.promise, enabling.then(() => { throw new Error("Configuration callback was not entered."); })]);
        nextIntent = app.lifecycle.collectionIntent().then(value => { readSettled = true; return value; });
        await setImmediate();
        assert.equal(readSettled, false, "No acquisition intent may observe the gap between configuration and runtime adoption.");
    } finally { resume.resolve(); }
    await enabling;
    const intent = await nextIntent;
    assert.equal(dispatched, 1);
    assert.equal(intent.windowDays, 7);
    assert.equal(intent.lease.kind, "microsoft-read");
    assert.equal((await app.lifecycle.status()).collection, "enabled");
    assert.throws(() => app.lifecycle.assertNativeConfigurationAdmission(token), { code: "invalid-request" });
    await assert.rejects(app.lifecycle.assertLease(token), { code: "lease-invalid" });
});

test("native Save preserves Pause and a rejected configuration owner never enters persistence", async t => {
    const app = await fixture(t, { paused: true });
    const before = await app.lifecycle.status();
    let writes = 0;
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: "enable", windowDays: 7 }, {
        owner: "example-native-backend", check() { throw new Error("retired-owner"); }, dispatched() {},
    }, () => { writes++; }), { code: "command-unauthorized" });
    assert.equal(writes, 0);
    assert.equal((await app.lifecycle.status()).authorizationRevision, before.authorizationRevision);
    for (const rejected of [false, "yes", {}, Promise.resolve(true)]) {
        await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: "enable", windowDays: 7 }, {
            owner: "example-native-backend", check() { return rejected; }, dispatched() {},
        }, () => { writes++; }), { code: "command-unauthorized" });
    }
    assert.equal(writes, 0);
    await app.lifecycle.admitNativeConfiguration({ intent: "save", windowDays: 7 }, {
        owner: "example-native-backend", check() {}, dispatched() {},
    }, (token, admission) => {
        const permitted = app.lifecycle.assertNativeConfigurationAdmission(token);
        assert.deepEqual(permitted.settings, { paused: true, windowDays: 7 });
        admission.dispatched();
        return { settings: permitted.settings };
    });
    assert.equal((await app.lifecycle.status()).collection, "paused");
    await assert.rejects(app.lifecycle.lease("microsoft-read"), { code: "lease-invalid" });
});

test("native configuration capability is read-only and shares the admission authority basis", async t => {
    const app = await fixture(t, { paused: true });
    const before = await app.lifecycle.status();
    const capability = await app.lifecycle.nativeConfigurationStatus();
    assert.equal(capability.enable, true);
    assert.equal(capability.save, true);
    assert.equal(capability.authorizationRevision, before.authorizationRevision);
    assert.equal(capability.generation, before.generation);
    assert.equal((await app.lifecycle.status()).authorizationRevision, before.authorizationRevision);
    await app.lifecycle.admitNativeConfiguration({ intent: "save", windowDays: 7 }, {
        owner: "example-native-backend", check() { return true; }, dispatched() {},
    }, (token, admission) => {
        const permitted = app.lifecycle.assertNativeConfigurationAdmission(token);
        assert.equal(permitted.authorizationRevision, capability.authorizationRevision);
        assert.equal(permitted.partition, capability.partition);
        assert.equal(permitted.account.subjectId, "example-subject");
        admission.dispatched();
        return { settings: permitted.settings };
    });
});

test("configuration Save remains local after provider expiry while first Enable is unavailable", async t => {
    const app = await fixture(t);
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    const capability = await app.lifecycle.nativeConfigurationStatus();
    assert.equal(capability.save, true);
    assert.equal(capability.enable, false);
    assert.equal(Object.hasOwn(capability, "account"), false);
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: "enable", windowDays: 7 }, {
        owner: "example-native-backend", check() {}, dispatched() {},
    }, () => assert.fail("Expired identity cannot enable a new source grant.")), { code: "access-refused" });
    await app.lifecycle.admitNativeConfiguration({ intent: "save", windowDays: 7 }, {
        owner: "example-native-backend", check() {}, dispatched() {},
    }, (token, admission) => {
        const permitted = app.lifecycle.assertNativeConfigurationAdmission(token);
        assert.equal(permitted.account, null);
        admission.dispatched();
        return { settings: permitted.settings };
    });
    await assert.rejects(app.lifecycle.lease("microsoft-read"), { code: "lease-invalid" });
});

test("a dispatched native configuration failure closes authority rather than trusting stale settings", async t => {
    const app = await fixture(t, { expectedCloseError: "storage-failed" });
    const lease = await app.lifecycle.lease("microsoft-read");
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: "save", windowDays: 7 }, {
        owner: "example-native-backend", check() {}, dispatched() {},
    }, (token, admission) => {
        assert.equal(app.lifecycle.assertNativeConfigurationAdmission(token).settings.paused, false);
        admission.dispatched();
        throw new Error("example-configuration-write-uncertain");
    }), /example-configuration-write-uncertain/);
    const status = await app.lifecycle.status();
    assert.equal(status.authorization.microsoftAcquisition, false);
    assert.equal(status.authorization.retained, false);
    assert.equal(status.microsoft.reason, "storage-failed");
    await assert.rejects(app.lifecycle.assertLease(lease), { code: "storage-failed" });
});

test("original native request provenance cannot move from the identity document into a content phase", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    const signal = new AbortController().signal;
    await observer.beginPhase("identity", { signal });
    const identity = {}, dispatchedIdentity = {}, blockedMessages = {}, duringTransition = {};
    assert.equal(observer.observe(identity, "cowork-detail"), true);
    observer.observe(dispatchedIdentity, "cowork-detail");
    await observer.continueOriginal(dispatchedIdentity, () => {});
    assert.equal(observer.observe(blockedMessages, "cowork-messages"), false);
    observer.block();
    assert.equal(observer.observe(duringTransition, "cowork-messages"), false);
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    let continued = 0;
    await assert.rejects(observer.continueOriginal(identity, () => { continued++; }), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
    await assert.rejects(observer.continueOriginal(duringTransition, () => { continued++; }), { code: "NATIVE_REQUEST_NOT_OBSERVED" });
    assert.equal(continued, 0);
    assert.deepEqual(observer.response(dispatchedIdentity), { phase: "identity", kind: "cowork-detail" });
    await assert.rejects(observer.assertCurrent(dispatchedIdentity), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
    assert.throws(() => observer.bodyComplete(dispatchedIdentity), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
    assert.equal(observer.snapshot().requests[0].phase, "identity", "A late identity response never becomes content evidence.");
    assert.equal(observer.snapshot().requests[0].bodyComplete, true, "Late body completion is still an observation, not acceptance.");
});

test("native request observations distinguish selection, continuation, response, body and acceptance", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {}, held = Promise.withResolvers(), entered = Promise.withResolvers();
    t.after(() => held.resolve());
    observer.observe(request, "cowork-messages");
    assert.deepEqual(observer.snapshot(), { selections: [{ phase: "cowork", kind: "cowork-messages", count: 1 }], requests: [] });
    const dispatch = observer.continueOriginal(request, async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    assert.equal(observer.snapshot().requests[0].continuation, "pending");
    assert.deepEqual(observer.response(request), { phase: "cowork", kind: "cowork-messages" });
    observer.bodyComplete(request);
    observer.requestFinished(request);
    let published = 0;
    const acceptance = observer.accept(request, () => { published++; });
    await setImmediate();
    assert.equal(published, 0, "A response cannot be accepted before original continuation settles.");
    held.resolve();
    await dispatch;
    await acceptance;
    assert.equal(published, 1);
    assert.deepEqual(observer.snapshot().requests, [{
        phase: "cowork", kind: "cowork-messages", continuation: "completed", responseObserved: true,
        network: "finished", bodyComplete: true, acceptance: "accepted", failure: null,
    }]);
    await assert.rejects(observer.accept(request, () => { published++; }), { code: "NATIVE_ORIGINAL_ACCEPTANCE_INVALID" });
    const duplicate = {};
    observer.observe(duplicate, "cowork-messages");
    await assert.rejects(observer.continueOriginal(duplicate, () => { published++; }), { code: "NATIVE_ORIGINAL_REQUEST_ALREADY_CONSUMED" });
    assert.equal(published, 1);
});

test("an asynchronously failed original continuation is recorded without raw errors or retry", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {};
    observer.observe(request, "cowork-messages");
    await assert.rejects(observer.continueOriginal(request, async () => { throw new Error("unpublished transport details"); }),
        { code: "NATIVE_ORIGINAL_CONTINUATION_FAILED" });
    const snapshot = observer.snapshot();
    assert.equal(snapshot.requests[0].continuation, "failed");
    assert.equal(snapshot.requests[0].failure, "continuation-failed");
    assert.equal(snapshot.requests[0].responseObserved, false);
    assert.equal(snapshot.requests[0].network, "pending", "A failed continuation is not proof of a provider/network failure.");
    assert.equal(JSON.stringify(snapshot).includes("unpublished"), false);
    await assert.rejects(observer.continueOriginal(request, () => assert.fail("must not retry")),
        { code: "NATIVE_ORIGINAL_REQUEST_ALREADY_CONSUMED" });
});

test("queued real Pause between request precheck and continuation prevents dispatch", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {};
    observer.observe(request, "cowork-messages");
    let dispatched = 0;
    const dispatch = observer.continueOriginal(request, () => { dispatched++; }).then(() => null, error => error);
    const pause = Promise.resolve().then(() => app.lifecycle.updateCollection({ paused: true, windowDays: 30 }));
    const error = await dispatch;
    await pause;
    assert.equal(dispatched, 0, "Pause must win at the irreversible original continuation, not only the earlier check.");
    assert.ok(error);
    assert.equal(observer.snapshot().requests[0].continuation, "not-started");
});

test("identity owner abort after precheck cannot start the original request", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    const owner = new AbortController(), request = {};
    await observer.beginPhase("identity", { signal: owner.signal });
    observer.observe(request, "cowork-detail");
    let dispatched = 0;
    const dispatch = observer.continueOriginal(request, () => { dispatched++; }).then(() => null, error => error);
    owner.abort();
    const error = await dispatch;
    assert.equal(dispatched, 0, "The final synchronous signal check must precede original continuation.");
    assert.equal(error?.code, "NATIVE_REQUEST_PHASE_RETIRED");
});

test("admitting original continuation never holds the lifecycle through network waiting", { timeout: 5000 }, async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {}, entered = Promise.withResolvers(), held = Promise.withResolvers();
    observer.observe(request, "cowork-messages");
    const dispatch = observer.continueOriginal(request, async () => { entered.resolve(); await held.promise; });
    let timer;
    try {
        await entered.promise;
        await Promise.race([
            app.lifecycle.updateCollection({ paused: true, windowDays: 30 }),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Pause waited behind network continuation.")), 1000); }),
        ]);
        assert.equal(observer.snapshot().requests[0].continuation, "pending");
    } finally { clearTimeout(timer); held.resolve(); }
    await dispatch;
    assert.equal(observer.snapshot().requests[0].continuation, "completed");
    await assert.rejects(observer.assertCurrent(request), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
});

test("request failure is distinct from a completed body and refuses late acceptance", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {};
    observer.observe(request, "cowork-messages");
    await observer.continueOriginal(request, () => {});
    observer.requestFailed(request);
    observer.requestFinished(request);
    assert.equal(observer.snapshot().requests[0].network, "failed");
    assert.equal(observer.snapshot().requests[0].bodyComplete, false);
    await assert.rejects(observer.accept(request, () => assert.fail("must not publish")), { code: "NATIVE_ORIGINAL_REQUEST_FAILED" });
});

test("native original publication cannot report acceptance of an asynchronous callback", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    await observer.beginPhase("cowork", { lease: await app.lifecycle.lease("microsoft-read") });
    const request = {};
    observer.observe(request, "cowork-detail");
    await observer.continueOriginal(request, () => {});
    observer.response(request);
    observer.bodyComplete(request);
    await assert.rejects(observer.accept(request, async () => {}), { code: "admission-failed" });
    assert.equal(observer.snapshot().requests[0].acceptance, "failed");
});

for (const revoke of ["pause", "expiry", "signout", "replacement", "close"]) {
    test(`original request acceptance is fenced after ${revoke}`, async t => {
        const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
        t.after(() => observer.close());
        const lease = await app.lifecycle.lease("microsoft-read"), request = {};
        await observer.beginPhase("cowork", { lease });
        observer.observe(request, "cowork-messages");
        await observer.continueOriginal(request, () => {});
        observer.response(request);
        observer.bodyComplete(request);
        if (revoke === "pause") {
            await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
            await app.lifecycle.updateCollection({ paused: false, windowDays: 30 });
        } else if (revoke === "expiry") await app.lifecycle.expire(lease);
        else if (revoke === "signout") await app.lifecycle.command("example-native-backend", {
            action: "wire-sign-out", operationId: randomUUID(), generation: (await app.lifecycle.status()).generation,
        }, () => true);
        else if (revoke === "replacement") await app.lifecycle.command("example-native-backend", {
            action: "microsoft-connect", operationId: randomUUID(), generation: (await app.lifecycle.status()).generation, replace: true,
        }, () => true);
        else observer.close();
        await assert.rejects(observer.accept(request, () => assert.fail("must not publish")), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
        assert.equal(observer.snapshot().requests[0].acceptance, "failed");
    });
}

test("an aborted identity owner cannot accept its completed original detail response", async t => {
    const app = await fixture(t), observer = createMicrosoftNativeRequestObserver({ lifecycle: app.lifecycle });
    t.after(() => observer.close());
    const owner = new AbortController(), request = {};
    await observer.beginPhase("identity", { signal: owner.signal });
    observer.observe(request, "cowork-detail");
    await observer.continueOriginal(request, () => {});
    observer.response(request);
    observer.bodyComplete(request);
    owner.abort();
    await assert.rejects(observer.accept(request, () => assert.fail("must not publish")), { code: "NATIVE_REQUEST_PHASE_RETIRED" });
    assert.equal(observer.snapshot().requests[0].acceptance, "failed");
});

for (const invalidate of ["release", "expiry"]) for (const enabled of [false, true]) {
    test(`public native ${enabled ? "Resume" : "Pause"} rejects queued panel ${invalidate} before dispatch`,
        { timeout: 10000 }, async t => {
            let now = Date.now();
            t.mock.method(Date, "now", () => now);
            let settingsWrites = 0;
            const app = await fixture(t, { async persistCollectionSettings(settings) { settingsWrites++; return settings; } });
            const capability = await app.panel();
            if (enabled) assert.equal((await app.control(capability, false)).status, 200);
            const before = await app.lifecycle.status();
            const writesBefore = settingsWrites;
            const lease = await app.lifecycle.lease("retained");
            const input = { enabled, expectedNativeRevision: before.authorizationRevision };
            const body = JSON.stringify(input);
            const bodyWaiting = Promise.withResolvers(), bodyProcessed = Promise.withResolvers(), response = Promise.withResolvers();
            const entered = Promise.withResolvers(), resume = Promise.withResolvers();
            const observe = req => {
                if (req.url !== "/api/collection/enabled") return;
                req.on("newListener", name => { if (name === "readable") bodyWaiting.resolve(); });
                req.once("end", () => { void setImmediate().then(bodyProcessed.resolve); });
            };
            app.runtime.server.on("request", observe);
            const req = httpRequest(app.origin + "/api/collection/enabled", { method: "POST", headers: {
                Origin: app.origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
                "X-Board-Capability": capability,
            } }, async res => {
                try {
                    let bytes = "";
                    for await (const chunk of res) bytes += chunk;
                    response.resolve({ status: res.statusCode, body: JSON.parse(bytes) });
                } catch (error) { response.reject(error); }
            });
            req.on("error", response.reject);
            t.after(() => { resume.resolve(); req.destroy(); app.runtime.server.off("request", observe); });
            req.write(body.slice(0, 1));
            await bodyWaiting.promise;
            const blocker = app.lifecycle.admit(lease, async () => { entered.resolve(); await resume.promise; });
            try {
                await entered.promise;
                req.end(body.slice(1));
                await bodyProcessed.promise;
                if (invalidate === "release") assert.equal((await app.api(capability, "/api/session/release", {})).status, 200);
                else now += 1001;
            } finally { resume.resolve(); }
            await blocker;
            const result = await response.promise, after = await app.lifecycle.status();
            assert.equal(after.collection, before.collection, "The queued setter must not mutate after panel invalidation.");
            assert.equal(after.authorizationRevision, before.authorizationRevision, "Rejected work must not notify a mutation.");
            assert.equal(settingsWrites, writesBefore, "A retired queued request must not enter configuration persistence.");
            assert.equal(result.status, 403);
            assert.ok(["session_expired", "wire_access_revoked"].includes(result.body.code));
            assert.equal(result.body.outcome, undefined, "Work rejected before dispatch must not claim an unknown write outcome.");
            const fresh = await app.panel();
            assert.equal((await app.control(fresh, enabled)).status, 200, "A genuine authorized new action still works.");
            assert.equal(settingsWrites, writesBefore + 1);
            assert.equal((await app.lifecycle.status()).collection, enabled ? "enabled" : "paused");
        });
}

test("authorized native HTTP and canvas Pause/Resume remain guarded and reject browser admission fields", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t), capability = await app.panel();
    const before = await app.lifecycle.status();
    const denied = await app.api(capability, "/api/collection/enabled", {
        enabled: false, expectedNativeRevision: before.authorizationRevision, check: true, dispatched: true,
    });
    assert.equal(denied.status, 400);
    assert.equal((await app.lifecycle.status()).collection, "enabled");
    assert.equal((await app.control(capability, false)).status, 200);
    const stale = await app.api(capability, "/api/collection/enabled", { enabled: true, expectedNativeRevision: before.authorizationRevision });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "wire_access_stale_collection_control");
    assert.equal(stale.body.outcome, undefined);
    assert.equal((await app.control(capability, true, "/api/canvas")).status, 200);
    assert.equal((await app.lifecycle.status()).collection, "enabled");
});

test("native Pause dispatched before panel release preserves honest unknown-outcome classification", { timeout: 10000 }, async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t), capability = await app.panel();
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const status = app.runtime.collector.status.bind(app.runtime.collector);
    t.mock.method(app.runtime.collector, "status", async (...args) => {
        const result = await status(...args);
        entered.resolve(); await resume.promise;
        return result;
    });
    const pending = app.control(capability, false);
    try {
        await entered.promise;
        assert.equal((await app.lifecycle.status()).collection, "paused");
        assert.equal((await app.api(capability, "/api/session/release", {})).status, 200);
    } finally { resume.resolve(); }
    const result = await pending;
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "wire_access_outcome_unknown");
    assert.equal(result.body.outcome, "unknown");
    assert.equal((await app.lifecycle.status()).collection, "paused");
});

test("native Pause persists its actual admitted settings through a temporary configuration-only token", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    let app, observed;
    app = await fixture(t, { async persistCollectionSettings(settings, token) {
        observed = { settings, token, admission: app.lifecycle.assertNativeCollectionSettingsAdmission(token) };
        assert.equal(Object.isFrozen(settings), true);
        assert.equal(Object.isFrozen(observed.admission), true);
        assert.deepEqual(Object.keys(token), []);
        return settings;
    } });
    const capability = await app.panel(), before = await app.lifecycle.status();
    assert.equal((await app.control(capability, false)).status, 200);
    assert.ok(observed, "The public Pause must invoke the host persistence hook before reporting success.");
    assert.deepEqual(observed.settings, { paused: true, windowDays: 30 });
    assert.deepEqual(observed.admission, {
        generation: before.generation, partition: before.microsoft.partition, settings: observed.settings,
    });
    assert.throws(() => app.lifecycle.assertNativeCollectionSettingsAdmission(observed.token), { code: "invalid-request" });
    assert.throws(() => app.lifecycle.assertNativeCollectionSettingsAdmission(observed.admission), { code: "invalid-request" });
    await assert.rejects(app.lifecycle.assertLease(observed.token), { code: "lease-invalid" });
});

for (const invalidation of ["release", "expiry"]) test(`native Pause awaits settings persistence and keeps dispatched panel ${invalidation} uncertain`, { timeout: 10000 }, async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    let app, token, latest;
    app = await fixture(t, { async persistCollectionSettings(settings, value) {
        token = value;
        entered.resolve();
        await resume.promise;
        assert.equal(app.lifecycle.assertNativeCollectionSettingsAdmission(token).settings, settings);
        return settings;
    } });
    const unsubscribe = app.lifecycle.subscribeAuthorizationChange(value => { latest = value; });
    const capability = await app.panel(), revision = latest.revision;
    const pending = app.control(capability, false);
    try {
        await entered.promise;
        assert.equal(latest.collection, "enabled", "Runtime settings must not lead the durable hook.");
        assert.equal(latest.revision, revision);
        assert.equal(app.lifecycle.assertNativeCollectionSettingsAdmission(token).settings.paused, true);
        if (invalidation === "release") assert.equal((await app.api(capability, "/api/session/release", {})).status, 200);
        else now += 1001;
    } finally { resume.resolve(); }
    const result = await pending;
    unsubscribe();
    assert.equal(result.status, 409);
    assert.equal(result.body.outcome, "unknown");
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.throws(() => app.lifecycle.assertNativeCollectionSettingsAdmission(token), { code: "invalid-request" });
});

test("native controls adopt the committed window while preserving their admitted Pause intent", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t, { async persistCollectionSettings(settings) { return { ...settings, windowDays: 7 }; } });
    const capability = await app.panel();
    assert.equal((await app.control(capability, false)).status, 200);
    assert.equal((await app.control(capability, true)).status, 200);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 7);
});

test("native collection synchronization reads committed settings only after entering its serial queue", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const lease = await app.lifecycle.lease("retained");
    const blocker = app.lifecycle.admit(lease, async () => { entered.resolve(); await resume.promise; });
    await entered.promise;
    let reads = 0, committed = { paused: false, windowDays: 7 };
    const pending = app.lifecycle.updateCollection(async () => {
        reads++;
        assert.throws(() => app.lifecycle.status(), { code: "reentrant-call" });
        return committed;
    }).then(value => ({ value }), error => ({ error }));
    try {
        await Promise.resolve();
        assert.equal(reads, 0);
        committed = { paused: false, windowDays: 14 };
    } finally { resume.resolve(); }
    await blocker;
    const result = await pending;
    assert.equal(result.error, undefined);
    assert.equal(reads, 1);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 14);
});

test("a failed settings hook retires its token without publishing a successful runtime Pause", async t => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    let token;
    const app = await fixture(t, { async persistCollectionSettings(settings, value) {
        token = value;
        throw Object.assign(new BoardError("Native configuration write could not be confirmed.", 503),
            { code: "native_configuration_unconfirmed" });
    } });
    const capability = await app.panel(), before = await app.lifecycle.status();
    const result = await app.control(capability, false);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "native_configuration_unconfirmed");
    assert.equal(result.body.outcome, "unknown");
    const after = await app.lifecycle.status();
    assert.equal(after.collection, before.collection);
    assert.equal(after.authorizationRevision, before.authorizationRevision);
    assert.throws(() => app.lifecycle.assertNativeCollectionSettingsAdmission(token), { code: "invalid-request" });
});
