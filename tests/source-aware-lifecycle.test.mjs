import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { privateFixture } from "./helpers.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { sessionStorage } from "../lib/microsoft-session-state.mjs";

async function setup(t, { globalCollection = null, sourceAware = true, nativeSignInMode = "headless",
    verifyAccount, stop, background, storage } = {}) {
    const cleanups = [];
    const { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    let providerCalls = 0, expectedPoison = false;
    const opened = [];
    const transport = createMicrosoftNativeReadTransport({
        async open(operation) { providerCalls++; opened.push({ mode: operation.mode, ownerId: operation.ownerId }); },
        async verifyAccount(operation) {
            providerCalls++;
            if (verifyAccount) return verifyAccount(operation);
            return { tenantId: "source-aware-tenant", subjectId: "source-aware-subject", knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop(operation) { return stop ? stop(operation) : { processExited: true, profileReleased: true }; },
        ...(background ? { background } : {}),
    });
    const lifecycle = await createMicrosoftSession(context, { transport,
        collection: { paused: true, windowDays: 30 }, sourceAware, nativeSignInMode,
        ...(storage ? { storage: storage(context) } : {}),
        ...(sourceAware ? { globalCollection } : {}) });
    t.after(async () => {
        try { await lifecycle.close(); }
        catch (error) { if (!expectedPoison || error.code !== "storage-failed") throw error; }
        finally { for (const cleanup of cleanups) await cleanup(); }
    });
    const owner = "source-aware-lifecycle-owner";
    const command = async action => lifecycle.command(owner, { action, operationId: randomUUID(),
        generation: (await lifecycle.status()).generation, ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
    await command("wire-sign-in");
    return { lifecycle, command, owner, context, opened, expectPoison() { expectedPoison = true; },
        get providerCalls() { return providerCalls; } };
}

test("native Connect preserves configured visibility for each fresh admitted command without replay", async t => {
    const app = await setup(t, { nativeSignInMode: "visible" });
    const input = { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, replace: false };
    const result = await app.lifecycle.command(app.owner, input, () => true);
    assert.equal(result.outcome, "completed");
    assert.deepEqual(app.opened.map(value => value.mode), ["visible"], "Native Connect must not enter the legacy second-owner handoff.");
    let state = await sessionStorage(app.context).read();
    assert.equal(state.owner.phase, "visible");
    assert.equal(state.owner.id, app.opened[0].ownerId);
    assert.equal(state.connection, "connected");
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await app.lifecycle.globalCollectionStatus()).globalCollection, null);
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
    assert.deepEqual(await app.lifecycle.command(app.owner, input, () => true), result);
    assert.equal(app.opened.length, 1);
    assert.equal((await app.command("microsoft-connect")).outcome, "completed");
    assert.deepEqual(app.opened.map(value => value.mode), ["visible", "visible"]);
    state = await sessionStorage(app.context).read();
    assert.equal(state.owner.phase, "visible");
    assert.notEqual(app.opened[0].ownerId, app.opened[1].ownerId);
});

test("native background transition runs only after verified partition and durable connected state", async t => {
    let transitions = 0;
    const assertions = [];
    const app = await setup(t, { nativeSignInMode: "visible", background: async operation => {
        transitions++;
        assertions.push(operation.assertCurrent);
        const saved = await sessionStorage(app.context).read();
        assert.equal(saved.connection, "connected");
        assert.equal(saved.owner.id, operation.ownerId);
        assert.equal(saved.owner.phase, "visible", "Backgrounding does not change the true browser owner mode.");
        assert.ok(saved.partition);
        assert.equal(saved.receipts.at(-1).outcome, "pending", "The operation must not claim UI completion before transition.");
        operation.assertCurrent();
    } });
    assert.equal(transitions, 0);
    assert.equal((await app.command("microsoft-connect")).outcome, "completed");
    assert.equal(transitions, 1);
    assert.throws(assertions[0], { code: "cancelled" }, "A successful transition also retires its side-effect authority.");
    assert.deepEqual(app.opened.map(value => value.mode), ["visible"]);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await app.command("microsoft-connect")).outcome, "completed");
    assert.equal(transitions, 2);
    assert.deepEqual(app.opened.map(value => value.mode), ["visible", "visible"]);
});

test("native background failure stays failed with cleanup and never starts another owner", async t => {
    let transitions = 0;
    const app = await setup(t, { nativeSignInMode: "visible", background: async () => {
        transitions++;
        throw new Error("PRIVATE_WINDOW_ERROR");
    } });
    const result = await app.command("microsoft-connect");
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "transport-failed");
    const saved = await sessionStorage(app.context).read();
    assert.equal(saved.owner, null);
    assert.equal(saved.connection, "reconnect-required");
    const receipt = saved.receipts.find(row => row.operationId === result.operationId);
    assert.equal(receipt.nativeEvidence.cleanup.state, "completed");
    assert.equal(receipt.nativeEvidence.firstFailure.code, "transport-failed");
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_WINDOW_ERROR/);
    assert.equal(transitions, 1);
    assert.equal(app.opened.length, 1);
});

test("native background timeout revokes late work before failed evidence finishes saving", async t => {
    const entered = Promise.withResolvers(), releaseWindowLookup = Promise.withResolvers();
    const savingFailure = Promise.withResolvers(), releaseFailureWrite = Promise.withResolvers();
    const lateFinished = Promise.withResolvers();
    let fireTimeout, originalSignal, lateFailure, windowCommands = 0, heldWrite = false;
    const app = await setup(t, {
        nativeSignInMode: "visible",
        storage(context) {
            const original = sessionStorage(context);
            return { ...original, async write(value) {
                if (!heldWrite && value.receipts.some(receipt => receipt.nativeEvidence?.firstFailure?.code === "timed-out")) {
                    heldWrite = true;
                    savingFailure.resolve();
                    await releaseFailureWrite.promise;
                }
                return original.write(value);
            } };
        },
        async background(operation) {
            originalSignal = operation.signal;
            entered.resolve();
            await releaseWindowLookup.promise;
            try {
                operation.assertCurrent();
                windowCommands++;
            } catch (error) {
                lateFailure = error.code;
                throw error;
            } finally { lateFinished.resolve(); }
        },
    });
    const set = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
        if (milliseconds === 1000) fireTimeout = callback;
        return set(callback, milliseconds, ...args);
    });
    const pending = app.command("microsoft-connect");
    try {
        await entered.promise;
        assert.equal(typeof fireTimeout, "function");
        fireTimeout();
        await savingFailure.promise;
        assert.equal(originalSignal.aborted, false, "Exercise the interval before outer connection cleanup aborts.");
        releaseWindowLookup.resolve();
        await lateFinished.promise;
        assert.equal(windowCommands, 0, "An expired transition cannot issue its later window command while persistence waits.");
        assert.equal(lateFailure, "cancelled");
        const saved = await sessionStorage(app.context).read();
        assert.equal(saved.receipts.at(-1).outcome, "pending", "Blocked evidence persistence cannot fabricate completion.");
    } finally {
        releaseWindowLookup.resolve();
        releaseFailureWrite.resolve();
        await pending;
    }
    const result = await pending;
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "timed-out");
    const saved = await sessionStorage(app.context).read();
    const receipt = saved.receipts.find(row => row.operationId === result.operationId);
    assert.equal(receipt.nativeEvidence.firstFailure.code, "timed-out");
    assert.equal(receipt.nativeEvidence.cleanup.state, "completed");
    assert.equal(saved.owner, null);
    assert.equal(app.opened.length, 1);
});

test("native wrong-partition verification cannot background the authentication window", async t => {
    let transitions = 0;
    const app = await setup(t, { nativeSignInMode: "visible", background: async () => { transitions++; } });
    const result = await app.lifecycle.command(app.owner, {
        action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, expectedPartition: "f".repeat(64), replace: false,
    }, () => true);
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "wrong-account");
    assert.equal(transitions, 0);
    assert.equal((await sessionStorage(app.context).read()).owner, null);
});

test("native original failure and cleanup disposition persist before Connect returns", async t => {
    const cleanupEntered = Promise.withResolvers(), finishCleanup = Promise.withResolvers();
    let originalOperation;
    const app = await setup(t, {
        async verifyAccount(operation) {
            originalOperation = operation;
            const before = await app.lifecycle.status();
            assert.throws(() => operation.recordFailure({ code: "NATIVE_FAVICON_UNQUALIFIED", url: "https://private.invalid" }),
                { code: "invalid-request" });
            const first = { code: "NATIVE_FAVICON_UNQUALIFIED",
                faviconFailure: { stage: "network", category: "declaration-unqualified" } };
            const persisted = operation.recordFailure(first);
            first.code = "NATIVE_SOURCE_REQUEST_FAILED";
            assert.equal(await persisted, true);
            assert.deepEqual(await app.lifecycle.status(), before, "Private evidence must not revoke public authorization.");
            throw Object.assign(new Error("PRIVATE_FAILURE_MESSAGE"), { code: "NATIVE_FAVICON_UNQUALIFIED" });
        },
        async stop() {
            cleanupEntered.resolve();
            await finishCleanup.promise;
            return { processExited: true, profileReleased: true };
        },
    });
    const input = { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, replace: false };
    const pending = app.lifecycle.command(app.owner, input, () => true);
    try {
        await cleanupEntered.promise;
        const saved = await sessionStorage(app.context).read();
        const receipt = saved.receipts.find(row => row.operationId === input.operationId);
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.reason, "transport-failed");
        assert.equal(receipt.nativeEvidence.firstFailure.code, "NATIVE_FAVICON_UNQUALIFIED");
        assert.deepEqual(receipt.nativeEvidence.firstFailure.faviconFailure,
            { stage: "network", category: "declaration-unqualified" });
        assert.equal(receipt.nativeEvidence.cleanup.state, "pending");
        assert.equal(await originalOperation.recordFailure({ code: "NATIVE_SOURCE_REQUEST_FAILED" }), false,
            "A late failure cannot overwrite the original evidence or terminal receipt.");
        assert.deepEqual((await sessionStorage(app.context).read()).receipts, saved.receipts);
        assert.equal(Object.hasOwn(await app.lifecycle.receipt(app.owner, input.operationId), "nativeEvidence"), false);
        assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_FAILURE_MESSAGE/);
    } finally { finishCleanup.resolve(); }
    const result = await pending;
    assert.equal(result.outcome, "failed");
    const final = await sessionStorage(app.context).read();
    const receipt = final.receipts.find(row => row.operationId === input.operationId);
    assert.equal(receipt.nativeEvidence.firstFailure.code, "NATIVE_FAVICON_UNQUALIFIED");
    assert.equal(receipt.nativeEvidence.cleanup.state, "completed");
    assert.equal(final.owner, null);
    assert.deepEqual(await app.lifecycle.command(app.owner, input, () => true), result);
    assert.equal(app.opened.length, 1, "A stored outcome or missing shell response must not trigger another Connect.");
});

test("native original failure survives process exit before verification returns without claiming cleanup", async t => {
    const app = await setup(t);
    await app.lifecycle.close();
    const sessionUrl = new URL("../lib/microsoft-session.mjs", import.meta.url).href;
    const transportUrl = new URL("../lib/microsoft-native-transport.mjs", import.meta.url).href;
    const operationId = randomUUID();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import {createMicrosoftSession} from ${JSON.stringify(sessionUrl)};
        import {createMicrosoftNativeReadTransport} from ${JSON.stringify(transportUrl)};
        const transport=createMicrosoftNativeReadTransport({
            async open(){},
            async verifyAccount(operation){
                await operation.recordFailure({code:"NATIVE_AUTH_REENTRY_UNQUALIFIED"});
                process.exit(0);
            },
            async stop(){throw Error("Cleanup must not have run");}
        });
        const session=await createMicrosoftSession(${JSON.stringify(app.context)}, {
            transport,collection:{paused:true,windowDays:7},sourceAware:true,globalCollection:null
        });
        await session.command(${JSON.stringify(app.owner)}, {
            action:"microsoft-connect",operationId:${JSON.stringify(operationId)},
            generation:(await session.status()).generation,replace:false
        },()=>true);
    `], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
    const interrupted = await sessionStorage(app.context).read();
    const original = interrupted.receipts.find(row => row.operationId === operationId);
    assert.equal(original.outcome, "pending");
    assert.equal(original.nativeEvidence.firstFailure.code, "NATIVE_AUTH_REENTRY_UNQUALIFIED");
    assert.equal(original.nativeEvidence.cleanup, undefined);
    assert.equal(interrupted.owner.operationId, operationId);
    let opens = 0, stops = 0;
    const transport = createMicrosoftNativeReadTransport({
        async open() { opens++; },
        async verifyAccount() { assert.fail("Recovery must not authenticate"); },
        async stop() { stops++; return { processExited: true, profileReleased: true }; },
    });
    const fresh = await createMicrosoftSession(app.context, {
        transport, collection: { paused: true, windowDays: 7 }, sourceAware: true, globalCollection: null,
    });
    try {
        const restarted = (await sessionStorage(app.context).read()).receipts.find(row => row.operationId === operationId);
        assert.equal(restarted.outcome, "ambiguous");
        assert.equal(restarted.reason, "restart-required");
        assert.deepEqual(restarted.nativeEvidence, original.nativeEvidence);
        const duplicate = await fresh.command(app.owner, { action: "microsoft-connect", operationId,
            generation: original.generation - 1, replace: false }, () => true);
        assert.equal(duplicate.outcome, "ambiguous");
        assert.equal(opens, 0);
        const recovery = await fresh.command(app.owner, { action: "microsoft-recover", operationId: randomUUID(),
            generation: (await fresh.status()).generation }, () => true);
        assert.equal(recovery.outcome, "completed");
        const recovered = (await sessionStorage(app.context).read()).receipts.find(row => row.operationId === operationId);
        assert.equal(recovered.outcome, "ambiguous", "Recovery cannot invent a verification result.");
        assert.deepEqual(recovered.nativeEvidence.firstFailure, original.nativeEvidence.firstFailure);
        assert.equal(recovered.nativeEvidence.cleanup.state, "completed");
        assert.equal(stops, 1);
        assert.equal(opens, 0);
    } finally { await fresh.close(); }
});

test("native failed cleanup stays distinct from the original failure until explicit recovery", async t => {
    let allowCleanup = false;
    const app = await setup(t, {
        async verifyAccount(operation) {
            await operation.recordFailure({ code: "NATIVE_SOURCE_REQUEST_FAILED" });
            throw new Error("PRIVATE_FAILURE_MESSAGE");
        },
        async stop() { return { processExited: allowCleanup, profileReleased: allowCleanup }; },
    });
    try {
        const result = await app.command("microsoft-connect");
        assert.equal(result.outcome, "failed");
        assert.equal(result.reason, "transport-failed");
        const failed = await sessionStorage(app.context).read();
        const original = failed.receipts.find(row => row.operationId === result.operationId);
        assert.equal(original.nativeEvidence.firstFailure.code, "NATIVE_SOURCE_REQUEST_FAILED");
        assert.equal(original.nativeEvidence.cleanup.state, "failed");
        assert.ok(failed.owner);
        assert.equal(failed.connection, "recovery-required");
        allowCleanup = true;
        assert.equal((await app.command("microsoft-recover")).outcome, "completed");
        const recovered = (await sessionStorage(app.context).read()).receipts.find(row => row.operationId === result.operationId);
        assert.deepEqual(recovered.nativeEvidence.firstFailure, original.nativeEvidence.firstFailure);
        assert.equal(recovered.nativeEvidence.cleanup.state, "completed");
        assert.equal(recovered.reason, "transport-failed");
        assert.equal(app.opened.length, 1);
    } finally { allowCleanup = true; }
});

test("source-aware absence preserves legacy intent distinctions without inventing global policy", async t => {
    const app = await setup(t);
    const control = await app.lifecycle.globalCollectionStatus();
    assert.equal(control.globalCollection, null);
    const scheduled = await app.lifecycle.lease("github-acquisition");
    const manual = await app.lifecycle.lease("github-manual-acquisition");
    assert.equal(await app.lifecycle.assertLease(scheduled), true);
    assert.equal(await app.lifecycle.assertLease(manual), true);
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
    assert.equal((await app.lifecycle.status()).collection, "paused", "Native source Pause is not global permission.");
    assert.equal(app.providerCalls, 0);
});

test("explicit global control adopts the committed gate before releasing its lifecycle turn", async t => {
    const app = await setup(t), lifecycle = app.lifecycle;
    const before = await lifecycle.globalCollectionStatus();
    const automatic = await lifecycle.lease("github-acquisition");
    const manual = await lifecycle.lease("github-manual-acquisition");
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let held, dispatches = 0, statusReturned = false;
    const input = { schemaVersion: 1, enabled: false, generation: before.generation,
        authorizationRevision: before.authorizationRevision, expectedRevision: null };
    const admission = { owner: app.owner, check() {}, dispatched() { dispatches++; } };
    const pending = lifecycle.admitGlobalCollection(input, admission, async (token, guarded) => {
        held = token;
        assert.deepEqual(lifecycle.assertGlobalCollectionAdmission(token), {
            owner: app.owner, generation: input.generation, authorizationRevision: input.authorizationRevision,
            intent: "set-global-collection", expectedRevision: null, paused: true,
        });
        entered.resolve();
        await finish.promise;
        guarded.check();
        guarded.dispatched();
        return { revision: 1, paused: true };
    });
    await entered.promise;
    const queued = lifecycle.globalCollectionStatus().then(value => { statusReturned = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(statusReturned, false);
    finish.resolve();
    assert.deepEqual(await pending, { revision: 1, paused: true });
    const paused = await queued;
    assert.deepEqual(paused.globalCollection, { revision: 1, paused: true });
    assert.equal(dispatches, 1);
    assert.throws(() => lifecycle.assertGlobalCollectionAdmission(held));
    await assert.rejects(lifecycle.assertLease(automatic));
    assert.equal(await lifecycle.assertLease(manual), true, "Global Pause does not cancel the separate approved manual intent.");
    await assert.rejects(lifecycle.lease("github-acquisition"));
    const resumed = await lifecycle.admitGlobalCollection({
        schemaVersion: 1, enabled: true, generation: paused.generation,
        authorizationRevision: paused.authorizationRevision, expectedRevision: 1,
    }, admission, (token, guarded) => {
        assert.equal(lifecycle.assertGlobalCollectionAdmission(token).paused, false);
        guarded.dispatched();
        return { revision: 2, paused: false };
    });
    assert.deepEqual(resumed, { revision: 2, paused: false });
    assert.equal((await lifecycle.status()).collection, "paused", "Global Resume cannot rewrite native source Pause.");
    await assert.rejects(lifecycle.lease("microsoft-read"));
    assert.equal(app.providerCalls, 0);
});

test("native source enrollment binds and preserves the separate committed global Pause", async t => {
    const app = await setup(t, { globalCollection: { revision: 9, paused: true } });
    await app.command("microsoft-connect");
    const native = await app.lifecycle.nativeConfigurationStatus();
    assert.equal(native.globalRevision, 9);
    const admission = { owner: app.owner, check() {}, dispatched() {} };
    await app.lifecycle.admitNativeConfiguration({ intent: "enable", windowDays: 7, globalRevision: 9 },
        admission, (token, guarded) => {
            const stamp = app.lifecycle.assertNativeConfigurationAdmission(token);
            assert.equal(stamp.globalRevision, 9);
            assert.deepEqual(stamp.settings, { paused: false, windowDays: 7 });
            guarded.dispatched();
            return { settings: stamp.settings };
        });
    assert.deepEqual((await app.lifecycle.globalCollectionStatus()).globalCollection, { revision: 9, paused: true });
    assert.equal((await app.lifecycle.status()).collection, "enabled", "The source intent is separate from global permission.");
    await assert.rejects(app.lifecycle.lease("microsoft-read"));
    await assert.rejects(app.lifecycle.admitNativeConfiguration({ intent: "save", windowDays: 30, globalRevision: 8 },
        admission, () => assert.fail("A stale global basis cannot enter the store.")));
    const current = await app.lifecycle.globalCollectionStatus();
    await app.lifecycle.admitGlobalCollection({ schemaVersion: 1, enabled: true, generation: current.generation,
        authorizationRevision: current.authorizationRevision, expectedRevision: 9 }, admission,
    () => ({ revision: 10, paused: false }));
    assert.equal(await app.lifecycle.assertLease(await app.lifecycle.lease("microsoft-read")), true);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 7);
});

test("source-aware global control rejects stale, malformed and asynchronous authority before dispatch", async t => {
    const app = await setup(t), current = await app.lifecycle.globalCollectionStatus();
    const input = { schemaVersion: 1, enabled: false, generation: current.generation,
        authorizationRevision: current.authorizationRevision, expectedRevision: null };
    let calls = 0;
    const work = () => { calls++; return { revision: 1, paused: true }; };
    const admission = check => ({ owner: app.owner, check, dispatched() { assert.fail("No write can be dispatched."); } });
    for (const changed of [{ schemaVersion: 2 }, { generation: current.generation + 1 },
        { authorizationRevision: current.authorizationRevision + 1 }, { expectedRevision: 0 },
        { expectedRevision: 1 }, { enabled: "false" }, { globalRevision: null }]) {
        await assert.rejects(app.lifecycle.admitGlobalCollection({ ...input, ...changed }, admission(() => true), work));
    }
    for (const check of [() => false, () => "true", () => ({}), () => Promise.resolve(true),
        () => Promise.reject(new Error("Example rejected control check."))]) {
        await assert.rejects(app.lifecycle.admitGlobalCollection(input, admission(check), work),
            { code: "command-unauthorized" });
    }
    assert.equal(calls, 0);
    assert.equal((await app.lifecycle.globalCollectionStatus()).globalCollection, null);
    await new Promise(resolve => setImmediate(resolve));
});

test("unchanged explicit global intent consumes its stamp without manufacturing another gate revision", async t => {
    const app = await setup(t, { globalCollection: { revision: 3, paused: true } });
    const current = await app.lifecycle.globalCollectionStatus();
    const input = { schemaVersion: 1, enabled: false, generation: current.generation,
        authorizationRevision: current.authorizationRevision, expectedRevision: 3 };
    const admission = { owner: app.owner, check() {}, dispatched() { assert.fail("A no-op need not write."); } };
    const result = await app.lifecycle.admitGlobalCollection(input, admission, () => ({ revision: 3, paused: true }));
    assert.deepEqual(result, { revision: 3, paused: true });
    assert.ok((await app.lifecycle.globalCollectionStatus()).authorizationRevision > current.authorizationRevision);
    await assert.rejects(app.lifecycle.admitGlobalCollection(input, admission, () => result),
        { code: "stale-collection-control" });
});

test("a dispatched global-control failure cannot retain possibly stale acquisition authority", async t => {
    const app = await setup(t), current = await app.lifecycle.globalCollectionStatus();
    app.expectPoison();
    await assert.rejects(app.lifecycle.admitGlobalCollection({
        schemaVersion: 1, enabled: false, generation: current.generation,
        authorizationRevision: current.authorizationRevision, expectedRevision: null,
    }, { owner: app.owner, check() {}, dispatched() {} }, (_token, admission) => {
        admission.dispatched();
        throw new Error("Example uncertain save.");
    }));
    const status = await app.lifecycle.status();
    assert.equal(status.authorization.retained, false);
    assert.equal(status.authorization.githubAcquisition, false);
    assert.equal(status.authorization.githubManualAcquisition, false);
    await assert.rejects(app.lifecycle.lease("github-manual-acquisition"));
});

test("native-only construction keeps source-aware controls and the manual lease kind unavailable", async t => {
    const app = await setup(t, { sourceAware: false });
    assert.equal(Object.hasOwn(app.lifecycle, "globalCollectionStatus"), false);
    assert.equal(Object.hasOwn(app.lifecycle, "admitGlobalCollection"), false);
    await assert.rejects(app.lifecycle.lease("github-manual-acquisition"), { code: "invalid-request" });
    assert.equal(Object.hasOwn(await app.lifecycle.nativeConfigurationStatus(), "globalRevision"), false);
});
