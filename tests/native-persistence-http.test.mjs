import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createNativePersistence, readNativeCollectionSettings } from "../lib/native-persistence.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController, writeBundle } from "../lib/export.mjs";
import { BoardError, loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { privateFixture, fixture as githubFixture } from "./helpers.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { savedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BOARD_ID } from "../lib/evidence.mjs";
import { createMicrosoftNativeHost, assertNativeRequestAdmission, nativeProtocolFailure } from "../lib/microsoft-native-host.mjs";
import { request as httpRequest } from "node:http";
import { chromium } from "playwright";
import { readMicrosoftNativeConfiguration, prepareMicrosoftNativeConfiguration } from "../lib/microsoft-native-configuration.mjs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { nativeFailureDetails, withNativeFailurePredicate } from "../lib/microsoft-session-state.mjs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { attachNativeBackfill, createNativeBackfill } from "../lib/native-backfill-state.mjs";

const projection = { layer: "tool", groupBy: "endpoint", filters: { scope: "all" }, limit: 10 };
const nativeExpectedBasis = aggregate => ({
    generation: aggregate.generation, accountRef: aggregate.microsoft.status.accountRef,
    configurationRevision: aggregate.microsoft.status.configuration.configurationRevision,
    privacyRevision: aggregate.microsoft.status.configuration.privacyRevision, globalRevision: aggregate.global.revision,
});

async function fixture(t, { beforeAcquire, completeNative, preAccount, configurationIntents, backfillTracking = false,
    initialConnect = true, paused = false, nativeConnection = false, sourceAware = false, globalCollection = null,
    nativeAcquisition = true, nativeScheduling = false, deletion, sessionTtlMs, unqualifiedReports = false, reportWriter } = {}) {
    const cleanups = [];
    const { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const sourceAccount = coworkFixture()[0].scope.account;
    let lifecycle, persistence, access, runtime, nativeHost, opens = 0, acquisitions = 0;
    async function stop() {
        await runtime?.close(); runtime = null;
        access?.close(); access = null;
        persistence?.close(); persistence = null;
        await lifecycle?.close(); lifecycle = null;
        await nativeHost?.close(); nativeHost = null;
    }
    t.after(async () => { await stop(); for (const cleanup of cleanups) await cleanup(); });
    async function start(connect = initialConnect) {
        const saved = await readNativeCollectionSettings(context);
        const transport = createMicrosoftNativeReadTransport({
            async open() { opens++; },
            async verifyAccount() {
                return { tenantId: sourceAccount.tenantId, subjectId: sourceAccount.subjectId,
                    knownAccountMatched: true, chat: true, cowork: true,
                    evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
            },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        lifecycle = await createMicrosoftSession(context, {
            transport, sourceAware, ...(sourceAware ? { globalCollection } : {}),
            collection: saved ? { paused: saved.paused, windowDays: saved.windowDays } : { paused, windowDays: 30 },
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token),
        });
        persistence = await createNativePersistence(context, { lifecycle, transport, preAccount, configurationIntents, backfillTracking });
        access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence, completeNative, nativeConnection, sourceAware, nativeAcquisition, nativeScheduling,
            async acquireNative(lease, configuration, recordFailure, backfill) {
                acquisitions++;
                assert.equal(lease.kind, "microsoft-read");
                await lifecycle.assertLease(lease);
                await beforeAcquire?.(lease, recordFailure, configuration, backfill);
                const records = coworkFixture();
                for (const row of records) row.capture.generation = lease.generation;
                return records;
            },
        });

        const controller = createExportController(context, reportWriter);
        runtime = await startServer(context, unqualifiedReports ? { ...controller } : controller, {
            port: 0, access, collector: { timers: false }, deletion, sessionTtlMs,
        });
        if (connect) for (const action of ["wire-sign-in", "microsoft-connect"]) {
            const receipt = await lifecycle.command("example-native-http-owner", {
                action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
                ...(action === "microsoft-connect" ? { replace: false } : {}),
            }, () => true);
            assert.equal(receipt.outcome, "completed");
        }
    }
    async function api(capability, route, input = {}, method = "POST", signal) {
        const origin = new URL(runtime.url).origin;
        const response = await fetch(origin + route, { method, headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}), signal });
        return { status: response.status, body: await response.json() };
    }
    const panel = async () => (await api(null, "/api/session")).body.capability;
    await start();
    return { context, api, panel,
        stop,
        get lifecycle() { return lifecycle; },
        get persistence() { return persistence; },
        get access() { return access; },
        get runtime() { return runtime; },
        get acquisitions() { return acquisitions; },
        get opens() { return opens; },
        async restartPaused() { await stop(); await start(false); },
        async restartSourceHost() {
            await stop();
            runtime = await startServer(context, createExportController(context), {
                port: 0, collector: { timers: false }, deletion,
                async createAccess() {
                    nativeHost = await createMicrosoftNativeHost(context, { sourceAware: true });
                    access = nativeHost.access;
                    return access;
                },
            });
        },
        async restartUnbound() {
            await stop();
            runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
        },
    };
}

async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("The read-only operation status waited behind acquisition.")), 2000);
        })]);
    } finally { clearTimeout(timer); }
}

for (const configured of [false, true]) test(`Copilot-only launcher refuses ${configured ? "enabled retained Microsoft evidence" : "a saved Microsoft account partition"} without changing private files`, async t => {
    const app = await fixture(t), capability = await app.panel();
    if (configured) {
        assert.equal((await app.api(capability, "/api/collection/configure", {
            expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
        })).status, 200);
        assert.equal((await app.api(capability, "/api/collection/now", { operationId: randomUUID() })).status, 200);
        assert.equal((await readNativeCollectionSettings(app.context)).paused, false);
    }
    await app.stop();
    const savedConfig = path.join(app.context.dataDir, "microsoft-source.json");
    await filesystem.writeFile(savedConfig, "PARKED_CONFIG_NOT_A_RELEASE_INPUT");
    const snapshot = async () => {
        const entries = await readdir(app.context.dataDir, { recursive: true, withFileTypes: true });
        const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
        return Promise.all(files.map(async file => [path.relative(app.context.dataDir, file),
            createHash("sha256").update(await readFile(file)).digest("hex")]));
    };
    const before = await snapshot(), opens = app.opens, acquisitions = app.acquisitions;
    await assert.rejects(promisify(execFile)(process.execPath, ["scripts\\start.mjs", "--port", "0"], {
        env: { ...process.env, WORKIQ_EVIDENCE_DATA_DIR: app.context.dataDir }, timeout: 10000,
    }), error => error.code === 1 && error.stderr.includes("matched Microsoft protected-state runtime"));
    assert.deepEqual(await snapshot(), before);
    assert.equal(app.opens, opens);
    assert.equal(app.acquisitions, acquisitions);
});

test("native Refresh rejects a captured scope changed before registration and preserves original receipt recovery", async t => {
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeConnection: true, paused: true, backfillTracking: true });
    const capability = await app.panel();
    const configure = async (surfaces, windowDays) => {
        const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
        assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
            schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
            expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces, windowDays,
        })).status, 200);
    };
    await configure(["cowork"], 7);
    const captured = nativeExpectedBasis((await app.api(capability, "/api/collection/sources/status")).body);
    await configure(["chat", "cowork"], 30);
    const before = await loadBoardState(app.context), operationId = randomUUID();
    const refused = await app.api(capability, "/api/collection/microsoft/now", { operationId, expectedBasis: captured });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "NATIVE_RETENTION_EXPECTED_BASIS_CHANGED");
    assert.equal(refused.body.outcome, undefined);
    assert.equal(app.acquisitions, 0);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention.receipts, before.nativeRetention.receipts);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention.backfill, before.nativeRetention.backfill);
    const aggregate = (await app.api(capability, "/api/collection/sources/status")).body;
    let fresh = nativeExpectedBasis(aggregate);
    for (const change of [{ generation: fresh.generation + 1 }, { accountRef: "0".repeat(64) },
        { configurationRevision: fresh.configurationRevision + 1 }, { privacyRevision: fresh.privacyRevision + 1 }, { globalRevision: 1 }]) {
        const result = await app.api(capability, "/api/collection/microsoft/now", {
            operationId: randomUUID(), expectedBasis: { ...fresh, ...change },
        });
        assert.equal(result.status, 409);
        assert.equal(result.body.code, "NATIVE_RETENTION_EXPECTED_BASIS_CHANGED");
        assert.equal(app.acquisitions, 0);
    }
    assert.equal((await app.api(capability, "/api/collection/microsoft/now", {
        operationId: randomUUID(), expectedBasis: { ...fresh, surfaces: ["cowork"] },
    })).status, 422);
    assert.equal((await app.api(capability, "/api/collection/global/enabled", {
        schemaVersion: 1, enabled: true, generation: aggregate.generation,
        authorizationRevision: aggregate.authorizationRevision, expectedRevision: null,
    })).status, 200);
    const staleGlobal = await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID(), expectedBasis: fresh });
    assert.equal(staleGlobal.status, 409);
    assert.equal(staleGlobal.body.code, "NATIVE_RETENTION_EXPECTED_BASIS_CHANGED");
    assert.equal(app.acquisitions, 0);
    fresh = nativeExpectedBasis((await app.api(capability, "/api/collection/sources/status")).body);
    const confirmedId = randomUUID();
    const confirmed = await app.api(capability, "/api/collection/microsoft/now", { operationId: confirmedId, expectedBasis: fresh });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.nativePersistenceReceipt.status, "committed");
    assert.equal(app.acquisitions, 1);
    await configure(["cowork"], 14);
    const recovered = await app.api(capability, "/api/collection/microsoft/now", { operationId: confirmedId, expectedBasis: fresh });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body.nativePersistenceReceipt, confirmed.body.nativePersistenceReceipt);
    assert.equal(app.acquisitions, 1, "Changed current preferences cannot turn original receipt recovery into reacquisition.");
    assert.equal((await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() })).status, 200);
    assert.equal(app.acquisitions, 2, "Existing independent callers keep their current-scope behavior.");
});

for (const mode of ["legacy", "legacy-device", "unbound"]) {
const approvedDeviceCheck = mode === "legacy-device";
test(`ordinary enrollment prepares fresh custody without opening Microsoft or enabling acquisition (${mode})`, async t => {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, []);
    let host, runtime;
    t.after(async () => {
        await runtime?.close(); await host?.close();
        for (const work of cleanup.reverse()) await work();
    });
    t.mock.method(chromium, "launchPersistentContext", () => assert.fail("Enrollment must not open a provider profile."));
    let enrollmentPolicy = null;
    if (approvedDeviceCheck) {
        const file = path.join(context.dataDir, "approved-enrollment.json");
        await filesystem.writeFile(file, JSON.stringify({ schemaVersion: 3, expectedAccount: "example@invalid.test",
            deviceRiskOrigin: "https://fpt.dfp.microsoft.com" }));
        enrollmentPolicy = await readMicrosoftNativeConfiguration(file);
    }
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        async createAccess() {
            host = await createMicrosoftNativeHost(context, { sourceAware: true, ordinaryStartup: true, enrollmentPolicy });
            return host.access;
        },
    });
    const origin = new URL(runtime.url).origin;
    let capability;
    const post = async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    };
    capability = (await post("/api/session")).body.capability;
    const before = (await post("/api/collection/microsoft/enrollment")).body;
    assert.deepEqual(before, { schemaVersion: 1, phase: "available", generation: 0, actions: ["prepare"], reason: null });
    const input = { schemaVersion: mode === "unbound" ? 2 : 1, generation: before.generation, operationId: randomUUID(),
        ...(mode === "unbound" ? {} : { expectedAccount: "example@invalid.test" }) };
    if (mode === "unbound") {
        assert.equal((await post("/api/collection/microsoft/enroll", { ...input, expectedAccount: "fixture@example.test" })).status, 422);
        assert.equal((await post("/api/collection/microsoft/enroll", { ...input, partition: "f".repeat(64) })).status, 422);
    }
    assert.equal((await post("/api/collection/microsoft/enroll", { ...input, generation: 9 })).status, 409);
    await assert.rejects(readFile(path.join(context.dataDir, "microsoft-source.json")), { code: "ENOENT" });
    const prepared = await post("/api/collection/microsoft/enroll", input);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.phase, "prepared");
    assert.deepEqual(prepared.body.actions, []);
    assert.doesNotMatch(JSON.stringify(prepared.body), /example@|profileDirectory|sessionId/);
    assert.deepEqual((await post("/api/collection/microsoft/enrollment")).body, prepared.body);
    const configuration = await readMicrosoftNativeConfiguration(path.join(context.dataDir, "microsoft-source.json"));
    assert.equal(configuration.expectedAccount, input.expectedAccount);
    assert.equal(configuration.deviceRiskOrigin, approvedDeviceCheck ? "https://fpt.dfp.microsoft.com" : undefined);
    assert.deepEqual(await readdir(configuration.profileDirectory), []);
    const marker = JSON.parse(await readFile(path.join(path.dirname(configuration.profileDirectory), "profile-owner.json"), "utf8"));
    assert.equal(marker.sessionId, configuration.profileOwnerSessionId);
    assert.equal(marker.profile, path.basename(configuration.profileDirectory));
    const status = await host.access.status();
    assert.equal(status.microsoft.actions.includes("microsoft-connect"), true);
    assert.equal(status.collection, "paused");
    assert.equal((await loadBoardState(context)).nativeRetention, undefined);
    assert.equal((await post("/api/collection/microsoft/enroll", input)).status, 409);
    assert.equal((await readMicrosoftNativeConfiguration(path.join(context.dataDir, "microsoft-source.json"))).profileDirectory,
        configuration.profileDirectory);
});
}

test("approved device enrollment rejects other identities and destinations before custody creation", async t => {
    const { context } = await privateFixture(t, []);
    const file = path.join(context.dataDir, "enrollment-policy.json");
    const policy = { schemaVersion: 3, expectedAccount: "example@invalid.test", deviceRiskOrigin: "https://fpt.dfp.microsoft.com" };
    for (const delta of [
        { deviceRiskOrigin: "https://different.microsoft.com" }, { deviceRiskOrigin: "https://fpt.dfp.microsoft.com/" },
        { deviceRiskOrigin: "https://fpt.dfp.microsoft.com?PRIVATE_QUERY" }, { deviceRiskOrigin: "http://fpt.dfp.microsoft.com" },
        { deviceRiskOrigin: "https://fpt.dfp.microsoft.com:8443" }, { profileDirectory: "PRIVATE_PROFILE" },
    ]) {
        await filesystem.writeFile(file, JSON.stringify({ ...policy, ...delta }));
        await assert.rejects(readMicrosoftNativeConfiguration(file), { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    }
    await filesystem.writeFile(file, JSON.stringify(policy));
    const admitted = await readMicrosoftNativeConfiguration(file);
    let dispatched = false;
    const admission = { check() {}, dispatched() { dispatched = true; } };
    await assert.rejects(prepareMicrosoftNativeConfiguration(context, "different@invalid.test", admission, admitted),
        { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    await assert.rejects(prepareMicrosoftNativeConfiguration(context, policy.expectedAccount, admission, { ...admitted }),
        { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
    assert.equal(dispatched, false);
    await assert.rejects(filesystem.stat(path.join(context.dataDir, "microsoft-native")), { code: "ENOENT" });
    await assert.rejects(createMicrosoftNativeHost(context, { sourceAware: true, configuration: admitted }),
        { code: "NATIVE_HOST_CONFIGURATION_INVALID" });
});

test("development start microsoft-config policy reaches paused enrollment without provider launch", { timeout: 15000 }, async t => {
    const cleanups = [], { context, root } = await privateFixture({ after: work => cleanups.push(work) }, []);
    const file = path.join(root, "approved-enrollment.json");
    await filesystem.writeFile(file, JSON.stringify({ schemaVersion: 3, expectedAccount: "example@invalid.test",
        deviceRiskOrigin: "https://fpt.dfp.microsoft.com" }));
    const environment = { ...process.env, WORKIQ_EVIDENCE_DATA_DIR: context.dataDir,
        COPILOT_HOME: path.join(root, "no-copilot"), GH_CONFIG_DIR: path.join(root, "no-github") };
    for (const name of Object.keys(environment)) {
        if (name === "NODE_TEST_CONTEXT" || name.startsWith("WIRE_") || /^(?:GH|GITHUB|COPILOT)_TOKEN$/.test(name)) delete environment[name];
    }
    let output = "";
    const child = spawn(process.execPath, ["scripts\\start.mjs", "--port", "0", "--development-microsoft", "--microsoft-config", file],
        { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    const exited = once(child, "exit");
    let watchdog = setTimeout(() => child.kill(), 12000);
    t.after(async () => {
        if (child.connected) child.disconnect();
        await exited; clearTimeout(watchdog);
        for (const work of cleanups.reverse()) await work();
    });
    const ready = await new Promise((resolve, reject) => {
        child.stdout.on("data", chunk => {
            output += chunk;
            const match = output.match(/WIRE ready at (http:\/\/127\.0\.0\.1:\d+\/)/);
            if (match) resolve(match[1]);
        });
        child.once("exit", () => reject(new Error("Normal source-policy startup failed.")));
        child.once("error", reject);
    });
    const origin = new URL(ready).origin;
    let capability;
    const post = async (route, input = {}) => {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(input) });
        assert.equal(response.status, 200);
        return response.json();
    };
    capability = (await post("/api/session")).capability;
    const before = await post("/api/collection/microsoft/enrollment");
    assert.equal(before.phase, "available");
    await post("/api/collection/microsoft/enroll", { schemaVersion: 1, generation: before.generation,
        operationId: randomUUID(), expectedAccount: "example@invalid.test" });
    const prepared = await readMicrosoftNativeConfiguration(path.join(context.dataDir, "microsoft-source.json"));
    assert.equal(prepared.deviceRiskOrigin, "https://fpt.dfp.microsoft.com");
    assert.deepEqual(await readdir(prepared.profileDirectory), []);
    const statusResponse = await fetch(origin + "/api/access/status", { headers: {
        Origin: origin, "X-Board-Capability": capability,
    } });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).collection, "paused");
    const session = JSON.parse(await readFile(path.join(context.dataDir, "microsoft-session", "session.json"), "utf8"));
    assert.equal(session.owner, null);
    assert.equal(session.receipts.some(row => row.action === "microsoft-connect"), false);
    child.disconnect();
    assert.equal((await exited)[0], 0);
    clearTimeout(watchdog); watchdog = null;
});

test("native scheduling commits through the shared writer and obeys Pause without a manual collection request", { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), completed = Promise.withResolvers();
    let acquire = () => { entered.resolve(); }, complete = (_ticket, receipt) => { completed.resolve(receipt); };
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeConnection: true, nativeScheduling: true, paused: true,
        beforeAcquire: () => acquire(), completeNative: (...args) => complete(...args),
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    const configured = await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    });
    assert.equal(configured.status, 200);
    t.mock.timers.tick(0);
    await entered.promise;
    assert.equal((await completed.promise).status, "committed");
    const snapshot = await app.api(capability, "/api/retained/microsoft/query", {
        schemaVersion: 1, revision: null, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 3, after: null },
    });
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.aggregates.conversations > 0);
    assert.equal(app.acquisitions, 1);
    assert.equal((await app.api(capability, "/api/collection/microsoft/enabled", {
        enabled: false, expectedNativeRevision: (await app.lifecycle.status()).authorizationRevision,
    })).status, 200);
    t.mock.timers.tick(120000);
    assert.equal(app.acquisitions, 1);
    const next = Promise.withResolvers(), release = Promise.withResolvers(), retired = Promise.withResolvers();
    t.after(() => release.resolve());
    acquire = () => { next.resolve(); return release.promise; };
    complete = (_ticket, receipt) => { assert.equal(receipt, undefined); retired.resolve(); };
    assert.equal((await app.api(capability, "/api/collection/microsoft/enabled", {
        enabled: true, expectedNativeRevision: (await app.lifecycle.status()).authorizationRevision,
    })).status, 200);
    t.mock.timers.tick(0);
    await next.promise;
    await assert.rejects(app.access.collectNativeNow({ operationId: randomUUID() }, {
        owner: "competing-manual-collection", check() {}, dispatched() {},
    }), { code: "wire_access_native_operation_pending" });
    assert.equal((await app.api(capability, "/api/collection/microsoft/enabled", {
        enabled: false, expectedNativeRevision: (await app.lifecycle.status()).authorizationRevision,
    })).status, 200);
    release.resolve();
    await retired.promise;
    await nextTurn();
    assert.equal((await app.api(capability, "/api/collection/microsoft/enabled", {
        enabled: true, expectedNativeRevision: (await app.lifecycle.status()).authorizationRevision,
    })).status, 200);
    t.mock.timers.tick(120000);
    const status = await app.api(capability, "/api/collection/microsoft/status");
    assert.ok(status.body.nativePersistence.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN"));
    assert.equal(app.acquisitions, 2, "An uncertain previous cycle must not be replayed automatically after Resume.");
    const model = createCollectionStatus(), pending = status.body.nativePersistence;
    assert.ok(model.persistence(status.body).actions.includes("collect-now"));
    for (const extra of ["NATIVE_RETENTION_OPERATION_PENDING", "NATIVE_RETENTION_PAUSED", "NATIVE_RETENTION_OPERATION_UNKNOWN"]) {
        assert.throws(() => model.persistence({ ...status.body, nativePersistence: {
            ...pending, blockers: [...pending.blockers, extra],
        } }), /conflict/);
    }
    const original = (await loadBoardState(app.context)).nativeRetention.receipts.at(-1).operationId;
    acquire = () => {};
    complete = () => {};
    assert.equal((await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() })).status, 200);
    const after = await app.api(capability, "/api/collection/microsoft/status");
    assert.equal(after.body.nativePersistence.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN"), false);
    assert.equal((await loadBoardState(app.context)).nativeRetention.receipts.find(row => row.operationId === original).status,
        "registered", "A later deliberate collection cannot settle the original unknown receipt.");
    const resumed = Promise.withResolvers();
    complete = (_ticket, receipt) => { resumed.resolve(receipt); };
    t.mock.timers.tick(60000);
    assert.equal((await resumed.promise).status, "committed");
    assert.equal(app.acquisitions, 4);
});

for (const withdrawal of ["logout", "shutdown"]) test(`scheduled native acquisition cannot publish after ${withdrawal}`,
    { timeout: 10000 }, async t => {
        const entered = Promise.withResolvers(), release = Promise.withResolvers(), retired = Promise.withResolvers();
        const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
            nativeConnection: true, nativeScheduling: true, paused: true,
            beforeAcquire: () => { entered.resolve(); return release.promise; },
            completeNative: (_ticket, receipt) => { assert.equal(receipt, undefined); retired.resolve(); },
        });
        t.after(() => release.resolve());
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const capability = await app.panel();
        const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
        assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
            schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
            globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision,
            surfaces: ["chat", "cowork"], windowDays: 30,
        })).status, 200);
        t.mock.timers.tick(0);
        await entered.promise;
        let stopping;
        if (withdrawal === "logout") {
            assert.equal((await app.api(capability, "/api/access/command", {
                schemaVersion: 1, action: "wire-sign-out", operationId: randomUUID(),
                generation: (await app.lifecycle.status()).generation,
            })).status, 200);
            assert.equal((await app.api(capability, "/api/snapshot", projection)).status, 403);
        } else stopping = app.stop();
        release.resolve();
        await retired.promise;
        await stopping;
        await nextTurn();
        const state = await loadBoardState(app.context);
        assert.deepEqual(state.nativeRetention.partitions, []);
        assert.equal(state.nativeRetention.receipts.at(-1).status, "registered");
        t.mock.timers.tick(120000);
        assert.equal(app.acquisitions, 1);
    });

test("native source expiry requires explicit reconnect and a new confirmed collection before automatic recovery", { timeout: 10000 }, async t => {
    const failed = Promise.withResolvers();
    let app, expire = true, complete = (_ticket, receipt) => { assert.equal(receipt, undefined); failed.resolve(); };
    app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeConnection: true, nativeScheduling: true, paused: true,
        async beforeAcquire(lease) {
            if (!expire) return;
            await app.lifecycle.expire(lease);
            throw Object.assign(new Error("Fixture source expired."), { code: "NATIVE_SOURCE_ACCESS_EXPIRED" });
        },
        completeNative: (...args) => complete(...args),
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    t.mock.timers.tick(0);
    await failed.promise;
    await nextTurn();
    assert.equal((await app.lifecycle.status()).microsoft.state, "reconnect-required");
    t.mock.timers.tick(120000);
    assert.equal(app.opens, 1, "Expiry must not automatically open an authentication flow.");
    assert.equal(app.acquisitions, 1);
    const oldOperation = (await loadBoardState(app.context)).nativeRetention.receipts.at(-1).operationId;
    expire = false;
    complete = () => {};
    assert.equal((await app.api(capability, "/api/access/command", {
        schemaVersion: 1, action: "microsoft-connect", operationId: randomUUID(), generation: (await app.lifecycle.status()).generation,
    })).status, 200);
    t.mock.timers.tick(0);
    const current = await app.api(capability, "/api/collection/microsoft/status");
    assert.ok(current.body.nativePersistence.blockers.includes("NATIVE_RETENTION_OPERATION_UNKNOWN"));
    assert.equal(app.opens, 2);
    assert.equal(app.acquisitions, 1);
    assert.equal((await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() })).status, 200);
    const resumed = Promise.withResolvers();
    complete = (_ticket, receipt) => resumed.resolve(receipt);
    t.mock.timers.tick(60000);
    assert.equal((await resumed.promise).status, "committed");
    const state = await loadBoardState(app.context);
    assert.equal(state.nativeRetention.receipts.find(row => row.operationId === oldOperation).status, "registered");
    assert.equal(state.nativeRetention.partitions.length, 1);
    assert.equal(app.opens, 2);
    assert.equal(app.acquisitions, 3);
});

test("a confirmed new manual collection clears a stopped automatic cycle without replaying it", { timeout: 10000 }, async t => {
    const failed = Promise.withResolvers();
    let failCompletion = true, complete = () => {};
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeConnection: true, nativeScheduling: true, paused: true,
        completeNative(_ticket, receipt) {
            if (failCompletion) {
                failed.resolve(receipt);
                throw Object.assign(new Error("Fixture completion unavailable."), { code: "NATIVE_CAPTURE_COMPLETION_FAILED" });
            }
            complete(receipt);
        },
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    });
    t.mock.timers.tick(0);
    const original = await failed.promise;
    let stopped;
    const deadline = Date.now() + 2000;
    do {
        stopped = await app.api(capability, "/api/collection/microsoft/status");
        if (stopped.body.nativePersistence.blockers.includes("NATIVE_RETENTION_AUTOMATIC_STOPPED")) break;
        await nextTurn();
    } while (Date.now() < deadline);
    assert.deepEqual(stopped.body.nativePersistence.blockers, ["NATIVE_RETENTION_AUTOMATIC_STOPPED"]);
    assert.ok(createCollectionStatus().persistence(stopped.body).actions.includes("collect-now"));
    t.mock.timers.tick(120000);
    assert.equal(app.acquisitions, 1);
    failCompletion = false;
    assert.equal((await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() })).status, 200);
    assert.deepEqual((await app.api(capability, "/api/collection/microsoft/status")).body.nativePersistence.blockers, []);
    const resumed = Promise.withResolvers();
    complete = receipt => resumed.resolve(receipt);
    t.mock.timers.tick(60000);
    assert.equal((await resumed.promise).status, "committed");
    assert.equal(app.acquisitions, 3);
    assert.equal((await loadBoardState(app.context)).nativeRetention.receipts.filter(row => row.operationId === original.operationId).length, 1);
});

test("ordinary pre-account snapshot keeps Settings available without publishing native data or account authority", async t => {
    const app = await fixture(t, { preAccount: "metadata-only", initialConnect: false, paused: true, nativeConnection: true });
    const capability = await app.panel();
    const denied = await app.api(capability, "/api/snapshot", projection);
    assert.equal(denied.status, 403);
    const signedIn = await app.api(capability, "/api/access/command", {
        schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(), generation: (await app.lifecycle.status()).generation,
    });
    assert.equal(signedIn.status, 200);
    const snapshot = await app.api(capability, "/api/snapshot", projection);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(Object.keys(snapshot.body.nativeRead).sort(), [
        "authorizationRevision", "generation", "reason", "revision", "status",
    ]);
    assert.equal(snapshot.body.nativeRead.status, "unavailable");
    assert.equal(snapshot.body.nativeRead.reason, "microsoft-account-not-configured");
    assert.equal(snapshot.body.collection.nativePersistence.kind, "native-account-unavailable");
    for (const key of ["accountRef", "receipt", "receiptQuery", "readback"]) {
        assert.equal(Object.hasOwn(snapshot.body.collection.nativePersistence, key), false);
    }
    assert.equal(snapshot.body.scenarios.some(row => row.nativeConversation), false);
    assert.equal(Object.hasOwn(snapshot.body.coverage, "native"), false);
    assert.equal(app.opens, 0);
    assert.equal(app.acquisitions, 0);
    const status = await app.api(capability, "/api/access/status", undefined, "GET");
    assert.equal(status.body.microsoft.actions.includes("microsoft-connect"), true);
    assert.notEqual((await app.api(capability, "/api/collection/status", { operationId: randomUUID() })).status, 200);
});

test("default unbound artifact publication rejects native report state before constructing a DTO", async t => {
    const app = await fixture(t), capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    assert.equal((await app.api(capability, "/api/collection/now", { operationId: randomUUID() })).status, 200);
    const snapshot = (await app.api(capability, "/api/snapshot", projection)).body;
    const admission = { owner: "example-native-report-runtime-owner", check() {}, dispatched() {} };
    const frame = await app.persistence.reportSource.capture({
        revision: snapshot.revision,
        scenarioIds: snapshot.scenarios.filter(row => row.nativeConversation).map(row => row.scenarioId),
    }, admission);
    const bundleId = `export-${randomUUID()}`;
    await app.persistence.reportSource.commit(frame, admission, state => {
        state.exports.push({ bundleId, kind: "report", title: "Private native report fixture",
            nativeEvidenceHash: "a".repeat(64), formats: [], files: {} });
    });
    await app.restartUnbound();
    const unbound = await app.panel();
    for (const [route, input, method] of [
        ["/api/snapshot", projection], ["/api/state", undefined, "GET"],
        ["/api/report-artifacts/list", {}], ["/api/report/open", { bundleId }],
        ["/api/artifact-file", { bundleId, kind: "report", format: "json" }],
        ["/api/report-file", { bundleId, name: "product-report.json" }],
    ]) {
        const response = await app.api(unbound, route, input, method);
        assert.equal(response.status, 503, route);
        assert.equal(response.body.code, "NATIVE_REPORT_RUNTIME_REQUIRED", route);
        assert.equal(JSON.stringify(response.body).includes("nativeSourceBinding"), false);
        assert.equal(JSON.stringify(response.body).includes("Private native report fixture"), false);
    }
});

async function seedSavedNativeReport(app, capability, { collect = true } = {}) {
    if (collect) {
        assert.equal((await app.api(capability, "/api/collection/configure", {
            expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
        })).status, 200);
        assert.equal((await app.api(capability, "/api/collection/now", { operationId: randomUUID() })).status, 200);
    }
    const guard = await app.access.read("example-native-report-runtime-owner");
    try {
        const native = await app.access.nativeReader.scan();
        const services = { ...app.access.nativeReportsFor(guard, { check() {}, dispatched() {} }),
            nativeRecords: native.records, nativeDefinitions: native.definitions };
        return (await savedNativeReportFixture({ context: app.context, persistence: app.persistence, services },
            { formats: ["html", "json"] })).bundle;
    } finally { guard.release(); }
}

test("HTTP saved native reads project authorized bindings and hide foreign artifacts without enabling preparation", async t => {
    const app = await fixture(t), capability = await app.panel();
    const saved = await seedSavedNativeReport(app, capability);
    const snapshot = await app.api(capability, "/api/snapshot", projection);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.exports[0].bundleId, saved.bundleId);
    for (const [route, input] of [
        ["/api/report-artifacts/list", {}],
        ["/api/report/open", { bundleId: saved.bundleId }],
        ["/api/artifact-file", { bundleId: saved.bundleId, kind: "report", format: "json" }],
        ["/api/report-file", { bundleId: saved.bundleId, name: "product-report.json" }],
    ]) {
        const response = await app.api(capability, route, input);
        assert.equal(response.status, 200, route);
        assert.doesNotMatch(JSON.stringify(response.body), /nativeSourceBinding/);
    }
    assert.doesNotMatch(JSON.stringify(snapshot.body), /nativeSourceBinding/);
    const blocked = await app.api(capability, "/api/preview", {
        selection: { kind: "all", revision: snapshot.body.revision }, options: { formats: ["json"] },
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "native-report-provenance-unqualified");
    assert.equal((await app.api(capability, "/api/artifact-deletion/preview", {
        artifactKind: "report", artifactId: saved.bundleId,
    })).status, 200);
    const disk = await loadBoardState(app.context);
    const account = disk.exports[0].nativeSourceBinding.account;
    await updateBoardState(app.context, state => {
        state.exports[0].nativeSourceBinding.account = account === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    });
    assert.deepEqual((await app.api(capability, "/api/snapshot", projection)).body.exports, []);
    assert.deepEqual((await app.api(capability, "/api/report-artifacts/list")).body.artifacts, []);
    for (const [route, input] of [
        ["/api/report/open", { bundleId: saved.bundleId }],
        ["/api/artifact-file", { bundleId: saved.bundleId, kind: "report", format: "json" }],
        ["/api/report-file", { bundleId: saved.bundleId, name: "product-report.json" }],
    ]) {
        const response = await app.api(capability, route, input);
        assert.equal(response.status, 403, route);
        assert.equal(response.body.code, "NATIVE_REPORT_ACCOUNT_REQUIRED", route);
        assert.equal(JSON.stringify(response.body).includes(saved.title), false);
    }
    assert.equal(app.acquisitions, 1);
});

test("HTTP GitHub reports and comparisons keep their single writer admission on a native report-policy store", async t => {
    const app = await fixture(t), capability = await app.panel();
    await seedSavedNativeReport(app, capability);
    const record = githubFixture("mixed-github");
    await replaceEvidence(app.context, (_records, importCoverage) => ({ records: [record], importCoverage }));
    const saved = [];
    for (let index = 0; index < 2; index++) {
        const before = await loadBoardState(app.context);
        const preview = await app.api(capability, "/api/preview", {
            selection: { kind: "selected", scenarioIds: [record.scenarioId], revision: before.revision },
            options: { formats: ["html", "json"], promptMode: "none" },
        });
        assert.equal(preview.status, 200);
        assert.equal((await app.api(capability, "/api/privacy-review", {
            previewId: preview.body.previewId, disclosureReviewed: true,
        })).status, 200);
        const result = await bounded(app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true }));
        assert.equal(result.status, 200);
        assert.equal(result.body.state.revision, before.revision + 1);
        assert.doesNotMatch(JSON.stringify(result.body), /nativeSourceBinding/);
        saved.push(result.body.bundle.bundleId);
    }
    const preview = await app.api(capability, "/api/report-comparison/preview", {
        baselineId: saved[0], laterId: saved[1], formats: ["html", "json"],
    });
    assert.equal(preview.status, 200);
    assert.equal((await app.api(capability, "/api/report-comparison/review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).status, 200);
    const result = await bounded(app.api(capability, "/api/report-comparison/save", {
        previewId: preview.body.previewId, confirmed: true,
    }));
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result.body), /nativeSourceBinding/);
    assert.equal((await app.api(capability, "/api/report-comparison/open", { bundleId: result.body.bundle.bundleId })).status, 200);
    assert.equal((await app.api(capability, "/api/artifact-deletion/preview", {
        artifactKind: "report", artifactId: saved[0],
    })).status, 200);
    assert.equal(app.acquisitions, 1);
});

test("HTTP frozen report Search retains the stream's own admission across query and open requests", { timeout: 10000 }, async t => {
    const app = await fixture(t), capability = await app.panel();
    const saved = await seedSavedNativeReport(app, capability);
    const controller = new AbortController(), origin = new URL(app.runtime.url).origin;
    const response = await fetch(origin + "/api/search/events", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability },
        body: JSON.stringify({ schemaVersion: 3 }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    t.after(async () => {
        controller.abort();
        try { await reader.cancel(); }
        catch (error) {
            if (error.name !== "AbortError" && !(error instanceof TypeError && error.message === "terminated")) throw error;
        }
        reader.releaseLock();
    });
    async function nextEvent(kind) {
        for (;;) {
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const event = JSON.parse(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                if (event.event === kind) return event;
                assert.notEqual(event.event, "error", JSON.stringify(event));
            }
            const { value, done } = await reader.read();
            assert.equal(done, false, "The owned report stream ended before publication.");
            buffer += decoder.decode(value, { stream: true });
        }
    }
    assert.equal((await app.api(capability, "/api/collection/status")).status, 200);
    assert.equal((await app.api(capability, "/api/search/query", {
        schemaVersion: 3, purpose: "navigation", query: "Read the invented records", requestId: 1, types: ["report"],
    })).status, 200);
    const results = await nextEvent("results");
    assert.equal(results.matches.total, 1);
    assert.doesNotMatch(JSON.stringify(results), /nativeSourceBinding/);
    assert.equal((await app.api(capability, "/api/search/open", {
        id: results.matches.hits[0].id, receipt: results.matches.receipt, openId: 1,
    })).status, 200);
    const opened = await nextEvent("opened");
    assert.equal(opened.document.artifact.bundleId, saved.bundleId);
    assert.doesNotMatch(JSON.stringify(opened), /nativeSourceBinding/);
    const deletion = await app.api(capability, "/api/artifact-deletion/preview", { artifactKind: "report", artifactId: saved.bundleId });
    assert.equal(deletion.status, 200);
    assert.equal((await app.api(capability, "/api/artifact-deletion/confirm", {
        operationId: deletion.body.operationId, confirmed: true,
    })).status, 200);
    assert.equal((await app.api(capability, "/api/search/open", {
        id: results.matches.hits[0].id, receipt: results.matches.receipt, openId: 2,
    })).status, 409);
    assert.equal((await app.api(capability, "/api/session/release")).status, 200);
    assert.equal(app.acquisitions, 1);
});

test("bounded HTTP routes read a genuine segmented root without selecting the old array reader or a writer", async t => {
    const app = await fixture(t), capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "example-segmented-http-fixture", check() {}, dispatched() {} };
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, coworkFixture());
    const comparison = await app.persistence.compareCommittedSource(begun.ticket, coworkFixture());
    assert.equal(comparison.status, "matched");
    app.persistence.retire(begun.ticket);
    const before = await loadBoardState(app.context);
    const input = { schemaVersion: 1, revision: before.revision, sources: ["microsoft-365-cowork"],
        page: { limit: 1, after: null }, analytics: { layer: "tool" } };
    const query = await app.api(capability, "/api/retained/microsoft/query", input);
    assert.equal(query.status, 200);
    assert.equal(query.body.aggregates.complete, true);
    const inventory = await app.api(capability, "/api/retained/microsoft/inventory", {
        schemaVersion: 1, revision: query.body.revision, viewId: query.body.viewId,
        dimension: "tools", page: input.page,
    });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.qualification, "available");
    assert.ok(inventory.body.aggregates.options > 0);
    const drilldown = await app.api(capability, "/api/retained/microsoft/drilldown", {
        schemaVersion: 1, revision: query.body.revision, viewId: query.body.viewId,
        groupId: query.body.grouping.groups[0].id, page: input.page,
    });
    assert.equal(drilldown.status, 200);
    assert.equal(drilldown.body.aggregates.selectedRows, query.body.grouping.groups[0].count);
    const analysis = await app.api(capability, "/api/retained/microsoft/analyze", {
        schemaVersion: 1, revision: query.body.revision, viewId: query.body.viewId,
        query: "CallGraph", types: ["action"], page: input.page,
    });
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.aggregates.calls, 1);
    assert.equal(analysis.body.textSelection.coverage, "complete");
    assert.match(analysis.body.textSelection.membershipRef, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(analysis.body, "query"), false);
    const detail = await app.api(capability, "/api/retained/microsoft/detail", {
        schemaVersion: 1, revision: before.revision, sources: input.sources, page: input.page,
        conversationId: query.body.page.items[0].id,
    });

    assert.equal(detail.status, 200);
    assert.equal(detail.body.page.items.length, 1);
    const search = await app.api(capability, "/api/retained/microsoft/search", {
        schemaVersion: 1, revision: before.revision, sources: input.sources, page: input.page,
        query: "Read", types: [],
    });
    assert.equal(search.status, 200);
    assert.ok(search.body.aggregates.matched);
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.equal(app.acquisitions, 0, "Only the existing fixture producer ran; no HTTP acquisition was dispatched.");
});

test("public exact-operation qualification compares private account and root without weakening owner fences", async t => {
    const app = await fixture(t), capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const operationId = randomUUID();
    assert.equal((await app.api(capability, "/api/collection/now", { operationId })).status, 200);
    const before = await loadBoardState(app.context);
    const qualified = await app.api(capability, "/api/retained/microsoft/readback", { schemaVersion: 1, operationId });
    assert.equal(qualified.status, 200);
    assert.equal(qualified.body.status, "matched");
    assert.equal(qualified.body.readback.committed.operationId, operationId);
    const receipt = before.nativeRetention.receipts.find(item => item.operationId === operationId);
    assert.equal(JSON.stringify(qualified.body).includes(receipt.snapshot), false);
    assert.equal(JSON.stringify(qualified.body).includes(receipt.partition), false);
    assert.deepEqual(await loadBoardState(app.context), before);
    const foreign = await app.api(await app.panel(), "/api/retained/microsoft/readback", { schemaVersion: 1, operationId });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "NATIVE_RETENTION_OPERATION_OWNER");
    const unknown = await app.api(capability, "/api/retained/microsoft/readback", { schemaVersion: 1, operationId: randomUUID() });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.status, "unconfirmed");
    assert.equal(unknown.body.reason, "operation-not-committed");
    assert.equal((await app.api(capability, "/api/retained/microsoft/readback", {
        schemaVersion: 1, operationId, receipt,
    })).status, 422);
    assert.equal(app.acquisitions, 1);
});

test("source-aware report HTTP resolves whole accepted native scopes and independently requested GitHub IDs", async t => {
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only" }), capability = await app.panel();
    const request = { owner: "existing-native-report-http-fixture", check() {}, dispatched() {} };
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, coworkFixture());
    app.persistence.retire(begun.ticket);
    const github = githubFixture("accepted-github-http");
    await replaceEvidence(app.context, (_records, importCoverage) => ({ records: [github], importCoverage }));
    const page = await app.api(capability, "/api/retained/microsoft/query", {
        schemaVersion: 1, revision: null, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
        analytics: { layer: "tool", filters: { scope: "all" } }, page: { limit: 1, after: null },
    });
    assert.equal(page.status, 200);
    const before = await loadBoardState(app.context);
    for (const kind of ["all", "current", "selected"]) {
        const selection = { kind, revision: page.body.revision,
            ...(kind === "all" ? {} : { scenarioIds: kind === "current" ? [github.scenarioId] : [page.body.page.items[0].id] }) };
        const preview = await app.api(capability, "/api/preview", {
            selection, nativeViewId: kind === "all" ? page.body.allViewId : page.body.viewId,
            options: { formats: ["json"], promptMode: "none" },
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        assert.equal(preview.body.snapshot.nativeEvidence.conversations.length, 1);
        assert.equal(preview.body.snapshot.selectionScope.kind, kind);
        assert.equal(preview.body.snapshot.records.length, kind === "selected" ? 1 : 2);
        assert.doesNotMatch(JSON.stringify(preview.body), /originalViewExpectations|rootHash|nativeSourceBinding/);
        assert.equal((await app.api(capability, "/api/privacy-review", {
            previewId: preview.body.previewId, disclosureReviewed: true,
        })).status, 200);
        assert.deepEqual(preview.body.nativeReportPublication, { schemaVersion: 1, available: true, reason: null });
        assert.equal((await app.api(capability, "/api/cancel-preview", { previewId: preview.body.previewId })).status, 200);
        assert.deepEqual(await loadBoardState(app.context), before);
    }
    for (const ids of [["unknown-request"], ["0".repeat(64)]]) {
        const response = await app.api(capability, "/api/preview", {
            selection: { kind: "selected", revision: page.body.revision, scenarioIds: ids },
            nativeViewId: page.body.viewId, options: { formats: ["json"] },
        });
        assert.equal(response.status, 409);
    }
    const foreign = await app.api(await app.panel(), "/api/preview", {
        selection: { kind: "current", revision: page.body.revision, scenarioIds: [github.scenarioId] },
        nativeViewId: page.body.viewId, options: { formats: ["json"] },
    });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.code, "NATIVE_VIEW_SELECTION_STALE");
    const filtered = await app.api(capability, "/api/retained/microsoft/query", {
        schemaVersion: 1, revision: before.revision, sources: ["microsoft-365-chat", "microsoft-365-cowork"],
        analytics: { filters: { from: "2026-01-01", to: "2026-12-31" } }, page: { limit: 1, after: null },
    });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.aggregates.conversations, 0);
    const emptyNative = await app.api(capability, "/api/preview", {
        selection: { kind: "current", revision: before.revision, scenarioIds: [github.scenarioId] },
        nativeViewId: filtered.body.viewId, options: { formats: ["json"], promptMode: "none" },
    });
    assert.equal(emptyNative.status, 200);
    assert.equal(emptyNative.body.snapshot.nativeEvidence.schemaVersion, 2);
    assert.deepEqual(emptyNative.body.snapshot.nativeEvidence.conversations, []);
    assert.equal((await app.api(capability, "/api/privacy-review", {
        previewId: emptyNative.body.previewId, disclosureReviewed: true,
    })).status, 200);
    const saved = await app.api(capability, "/api/export", { previewId: emptyNative.body.previewId, confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state.revision, before.revision + 1);
    assert.equal(saved.body.state.nativeRead.status, "bounded");
    assert.ok((await loadBoardState(app.context)).exports[0].nativeSourceBinding);
    const frozenEmpty = await app.api(capability, "/api/artifact-file", { bundleId: saved.body.bundle.bundleId, kind: "report", format: "json" });
    assert.equal(frozenEmpty.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(frozenEmpty.body.data, "base64")).nativeEvidence, emptyNative.body.snapshot.nativeEvidence);
    const mixed = await app.api(capability, "/api/preview", {
        selection: { kind: "current", revision: saved.body.state.revision, scenarioIds: [github.scenarioId] },
        nativeViewId: saved.body.state.nativeRead.viewId, options: { formats: ["json"], promptMode: "none" },
    });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.body.snapshot.records.length, 2);
    assert.ok(mixed.body.snapshot.nativeEvidence.githubEvaluationFacts);
    assert.equal((await app.api(capability, "/api/privacy-review", { previewId: mixed.body.previewId, disclosureReviewed: true })).status, 200);
    const mixedSaved = await app.api(capability, "/api/export", { previewId: mixed.body.previewId, confirmed: true });
    assert.equal(mixedSaved.status, 200);
    assert.equal(mixedSaved.body.state.revision, saved.body.state.revision + 1);
    assert.equal(mixedSaved.body.bundle.evaluationFactsHash, undefined);
    assert.match(mixedSaved.body.bundle.nativeEvidenceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, before.nativeRetention);
    assert.equal(app.acquisitions, 0);
});

test("source-aware HTTP settings compose actual global/schema2 persistence while keeping the normal native writer closed", async t => {
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        initialConnect: false, nativeConnection: true, paused: true, nativeAcquisition: false });
    const capability = await app.panel();
    const command = async action => app.api(capability, "/api/access/command", {
        schemaVersion: 1, action, operationId: randomUUID(), generation: (await app.lifecycle.status()).generation,
    });
    assert.equal((await command("wire-sign-in")).body.outcome, "completed");
    let combined = await app.api(capability, "/api/collection/sources/status");
    assert.equal(combined.status, 200);
    assert.deepEqual(combined.body.global, { state: "legacy-compatible", revision: null, actions: ["pause", "resume"] });
    assert.equal(combined.body.microsoft.configurationOffer.schemaVersion, 2);
    assert.equal(combined.body.microsoft.configurationOffer.globalRevision, null);
    assert.equal((await loadBoardState(app.context)).globalCollection, undefined);
    const global = async enabled => {
        const previous = (await app.api(capability, "/api/collection/sources/status")).body;
        return app.api(capability, "/api/collection/global/enabled", {
            schemaVersion: 1, enabled, generation: previous.generation,
            authorizationRevision: previous.authorizationRevision, expectedRevision: previous.global.revision,
        });
    };
    assert.equal((await global(false)).status, 200);
    assert.equal((await command("microsoft-connect")).body.outcome, "completed");
    combined = await app.api(capability, "/api/collection/sources/status");
    const offer = combined.body.microsoft.configurationOffer;
    assert.equal(offer.intent, "enable");
    assert.equal(offer.globalRevision, 1);
    const configure = value => app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: value.intent, generation: value.generation, authorizationRevision: value.authorizationRevision,
        expectedRevision: value.expectedRevision, globalRevision: value.globalRevision,
        surfaces: ["cowork"], windowDays: 14,
    });
    assert.equal((await configure(offer)).status, 200);
    const enrolled = await loadBoardState(app.context);
    assert.deepEqual(enrolled.globalCollection, { revision: 1, paused: true });
    assert.deepEqual(enrolled.nativeRetention.settings, { paused: false, windowDays: 14 });
    assert.equal(enrolled.nativeRetention.accounts.length, 1);
    assert.equal((await global(true)).status, 200);
    assert.equal((await configure(offer)).status, 409);
    const available = (await app.api(capability, "/api/collection/sources/status")).body;
    assert.deepEqual(available.global, { state: "committed", revision: 2, paused: false, actions: ["pause"] });
    assert.equal(available.microsoft.actions.includes("collect-now"), false);
    assert.ok(available.microsoft.status.blockers.includes("NATIVE_RETENTION_ACQUISITION_UNAVAILABLE"));
    const beforeCollect = await loadBoardState(app.context);
    const rejected = await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.code, "wire_access_native_writer_unqualified");
    assert.equal(rejected.body.outcome, undefined);
    assert.deepEqual(await loadBoardState(app.context), beforeCollect);
    const snapshot = await app.api(capability, "/api/snapshot", projection);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.nativeRead.status, "unavailable");
    assert.equal(snapshot.body.nativeRead.reason, "native-retained-source-not-committed");
    assert.deepEqual(snapshot.body.collection.sourceAware.global, available.global);
    const control = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeControl;
    assert.equal((await app.api(capability, "/api/collection/microsoft/enabled", {
        enabled: false, expectedNativeRevision: control.revision,
    })).status, 200);
    await global(false);
    await global(true);
    assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
    assert.equal((await readNativeCollectionSettings(app.context)).windowDays, 14);
    assert.equal(app.acquisitions, 0);
});

test("HTTP Delete all clears retained segmented activity without Microsoft reconnect and preserves saved reports", async t => {
    let seals = 0;
    const app = await fixture(t, { deletion: { onSeal(_state, operation) { if (operation.kind === "activity-deletion") seals++; } } });
    let capability = await app.panel();
    const saved = await seedSavedNativeReport(app, capability);
    const savedBytes = await readFile(saved.files["product-report.json"]);
    const admission = { owner: "segmented-deletion-fixture-owner", check() {}, dispatched() {} };
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, admission);
    const repeated = coworkFixture();
    for (const row of repeated) {
        row.capture.captureId += "-segmented";
        row.capture.generation = begun.ticket.lease.generation;
    }
    await app.persistence.commitSegmented(begun.ticket, repeated);
    app.persistence.retire(begun.ticket);
    const original = await loadBoardState(app.context);
    await app.restartPaused();
    capability = await app.panel();
    assert.equal((await app.lifecycle.status()).microsoft.state, "reconnect-required");
    const opens = app.opens;
    const preview = await app.api(capability, "/api/deletion/preview", { scope: "all" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.counts.records > 0);
    assert.equal(preview.body.counts.savedReports, 1);
    assert.doesNotMatch(JSON.stringify(preview.body), /tenantId|subjectId|partition|localActivityAdmission|cleanup/);
    assert.equal((await app.api(capability, "/api/deletion/preview", {
        scope: "range", from: "2026-01-01", to: "2026-12-31",
    })).body.code, "NATIVE_SEGMENTED_RANGE_DELETION_UNAVAILABLE");
    const result = await bounded(app.api(capability, "/api/deletion/confirm", {
        operationId: preview.body.operationId, confirmed: true,
    }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.phase, "complete");
    assert.doesNotMatch(JSON.stringify(result.body), /tenantId|subjectId|partition|localActivityAdmission|cleanup/);
    const state = await loadBoardState(app.context);
    assert.equal(state.stateVersion, 7);
    assert.deepEqual(state.exports, original.exports);
    assert.deepEqual(state.nativeRetention.receipts, original.nativeRetention.receipts);
    assert.deepEqual(await readFile(saved.files["product-report.json"]), savedBytes);
    for (const file of await readdir(path.join(app.context.dataDir, "private-evidence"))) {
        const document = JSON.parse(await readFile(path.join(app.context.dataDir, "private-evidence", file)));
        if (document.contractVersion === "m365-native-screened-segments-v2") {
            assert.equal(document.kind, "root");
            assert.equal(document.tree, null);
        }
    }
    assert.equal(seals, 1);
    assert.equal(app.opens, opens);
    assert.equal(app.acquisitions, 1);
});

for (const revoke of ["release", "expiry"]) test(`local deletion confirmation rechecks original panel ${revoke} after collector quiescence`, { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const app = await fixture(t, { sessionTtlMs: revoke === "expiry" ? 500 : undefined,
        deletion: { coordinateRecorder: work => { entered.resolve(); return work(); } } });
    t.after(() => resume.resolve());
    let capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["cowork"], windowDays: 30,
    })).status, 200);
    assert.equal((await app.api(capability, "/api/collection/now", { operationId: randomUUID() })).status, 200);
    capability = await app.panel();
    const preview = await app.api(capability, "/api/deletion/preview", { scope: "all" });
    assert.equal(preview.status, 200);
    const before = await loadBoardState(app.context);
    const held = app.runtime.collector.exclusiveActivity(() => resume.promise);
    const confirm = app.api(capability, "/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    await entered.promise;
    if (revoke === "release") assert.equal((await app.api(capability, "/api/session/release")).status, 200);
    else await new Promise(resolve => setTimeout(resolve, 550));
    resume.resolve();
    await held;
    const response = await confirm;
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.outcome, undefined);
    await app.runtime.collector.exclusiveActivity(() => {});
    assert.deepEqual(await loadBoardState(app.context), before);
});

for (const sourceHost of [false, true]) test(`sealed native cleanup recovers through ${sourceHost ? "source host" : "runtime"} startup without reconnecting or replaying confirmation`, async t => {
    let interrupt = true, seals = 0;
    const app = await fixture(t, { deletion: {
        onSeal() { seals++; },
        afterSeal() { if (interrupt) throw new Error("Existing fixture interruption after sealed local deletion."); },
    } });
    let capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "local-cleanup-recovery-fixture", check() {}, dispatched() {} };
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, coworkFixture());
    app.persistence.retire(begun.ticket);
    const preview = await app.api(capability, "/api/deletion/preview", { scope: "all" });
    assert.equal(preview.status, 200);
    const confirm = await app.api(capability, "/api/deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    assert.equal(confirm.status, 500);
    assert.equal(confirm.body.outcome, "unknown");
    const file = path.join(app.context.dataDir, `${BOARD_ID}.state.json`);
    const sealed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(sealed.deletion.pending, preview.body.operationId);
    const originalReceipts = structuredClone(sealed.nativeRetention.receipts);
    const opens = app.opens;
    interrupt = false;
    await (sourceHost ? app.restartSourceHost() : app.restartPaused());
    capability = await app.panel();
    const state = await loadBoardState(app.context);
    assert.equal(state.deletion.pending, undefined);
    assert.equal(state.deletion.operations[preview.body.operationId].phase, "complete");
    assert.deepEqual(state.nativeRetention.receipts, originalReceipts);
    const status = await app.api(capability, "/api/deletion/status", { operationId: preview.body.operationId });
    assert.equal(status.status, 200);
    assert.equal(status.body.phase, "complete");
    assert.doesNotMatch(JSON.stringify(status.body), /localActivityAdmission|cleanup|partition/);
    assert.equal((await app.api(capability, "/api/deletion/confirm", {
        operationId: preview.body.operationId, confirmed: true,
    })).status, 403);
    assert.equal(seals, 2);
    assert.equal(app.opens, opens);
    assert.equal(app.acquisitions, 0);
});

test("native saved artifact HTTP eligibility and deletion use exact account-qualified admission without touching activity", async t => {
    let seals = 0, sealedBeforeCleanup = false;
    let saved;
    const app = await fixture(t, { deletion: { async onSeal(state, operation) {
        if (operation.kind !== "artifact-deletion") return;
        seals++;
        assert.equal(state.exports.some(item => item.bundleId === saved.bundleId), false);
        assert.equal(operation.phase, "pending");
        sealedBeforeCleanup = (await readFile(saved.files["product-report.json"])).length > 0;
    } } });
    const capability = await app.panel();
    saved = await seedSavedNativeReport(app, capability);
    const before = await loadBoardState(app.context);
    const scope = { artifactKind: "report", artifactId: saved.bundleId };
    const eligibility = await app.api(capability, "/api/artifact-deletion/eligibility", scope);
    assert.equal(eligibility.status, 200, JSON.stringify(eligibility.body));
    assert.equal(eligibility.body.artifact.canDelete, true);
    assert.equal(eligibility.body.artifact.bundleId, saved.bundleId);
    assert.doesNotMatch(JSON.stringify(eligibility.body), /nativeSourceBinding|nativeArtifactAdmission|artifactBinding/);
    const ordinary = await app.api(capability, "/api/report-artifacts/list");
    assert.equal(ordinary.body.artifacts.find(item => item.bundleId === saved.bundleId).canDelete, false);
    const preview = await app.api(capability, "/api/artifact-deletion/preview", scope);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(await loadBoardState(app.context), before);
    const result = await bounded(app.api(capability, "/api/artifact-deletion/confirm", {
        operationId: preview.body.operationId, confirmed: true,
    }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.phase, "complete");
    assert.equal(seals, 1);
    assert.equal(sealedBeforeCleanup, true);
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.nativeRetention, before.nativeRetention);
    assert.equal(after.exports.length, 0);
    assert.equal(after.nativeReportPolicy, before.nativeReportPolicy);
    for (const file of Object.values(saved.files)) await assert.rejects(readFile(file), { code: "ENOENT" });
    const replay = await app.api(capability, "/api/artifact-deletion/confirm", {
        operationId: preview.body.operationId, confirmed: true,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.phase, "complete");
    assert.equal(seals, 1);
    assert.deepEqual(await loadBoardState(app.context), after);
    assert.doesNotMatch(JSON.stringify(result.body), /nativeSourceBinding|nativeArtifactAdmission|artifactBinding|cleanup/);
    assert.equal(app.acquisitions, 1);
});

test("artifact eligibility and bulk preview deny foreign accounts before any descriptor or file traversal", async t => {
    let described = 0;
    const app = await fixture(t, { deletion: { describeSavedArtifact() {
        described++; assert.fail("Foreign artifact scope must not invoke a descriptor.");
    } } });
    const capability = await app.panel(), owned = await seedSavedNativeReport(app, capability);
    const foreign = await seedSavedNativeReport(app, capability, { collect: false });
    await updateBoardState(app.context, state => {
        state.exports.find(item => item.bundleId === foreign.bundleId).nativeSourceBinding.account = "0".repeat(64);
    });
    const before = await loadBoardState(app.context);
    for (const [route, input] of [
        ["/api/artifact-deletion/eligibility", { artifactKind: "report", artifactId: foreign.bundleId }],
        ["/api/artifact-deletion/preview", { artifactKind: "report", artifactId: foreign.bundleId }],
        ["/api/artifact-deletion/preview", { scope: "all-reports" }],
    ]) {
        const response = await app.api(capability, route, input);
        assert.equal(response.status, 403, route);
        assert.equal(response.body.code, "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE");
        const text = JSON.stringify(response.body);
        assert.equal(text.includes(foreign.bundleId), false);
        assert.equal(text.includes(owned.bundleId), false);
        assert.equal(Object.hasOwn(response.body, "counts"), false);
    }
    assert.equal(described, 0);
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.ok((await readFile(foreign.files["product-report.json"])).length);
    const list = await app.api(capability, "/api/report-artifacts/list");
    assert.deepEqual(list.body.artifacts.map(item => item.bundleId), [owned.bundleId]);
});

for (const revoke of ["release", "expiry"]) test(`artifact confirmation rejects original panel ${revoke} after quiescence before dispatch`, { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const app = await fixture(t, { sessionTtlMs: revoke === "expiry" ? 500 : undefined,
        deletion: { coordinateRecorder: work => { entered.resolve(); return work(); } } });
    t.after(() => resume.resolve());
    const saved = await seedSavedNativeReport(app, await app.panel());
    const capability = await app.panel();
    const preview = await app.api(capability, "/api/artifact-deletion/preview", { artifactKind: "report", artifactId: saved.bundleId });
    assert.equal(preview.status, 200);
    const before = await loadBoardState(app.context), held = app.runtime.collector.exclusiveActivity(() => resume.promise);
    const pending = app.api(capability, "/api/artifact-deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    await entered.promise;
    if (revoke === "release") assert.equal((await app.api(capability, "/api/session/release")).status, 200);
    else await new Promise(resolve => setTimeout(resolve, 550));
    resume.resolve(); await held;
    const result = await pending;
    assert.equal(result.status, 403);
    assert.equal(result.body.outcome, undefined);
    await app.runtime.collector.exclusiveActivity(() => {});
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.ok((await readFile(saved.files["product-report.json"])).length);
});

test("interrupted native artifact confirmation recovers only its sealed files through the source host", async t => {
    let interrupt = true, seals = 0;
    const app = await fixture(t, { deletion: {
        onSeal() { seals++; },
        afterSeal() { if (interrupt) throw new Error("Existing fixture interruption after artifact seal."); },
    } });
    const capability = await app.panel(), saved = await seedSavedNativeReport(app, capability);
    const before = await loadBoardState(app.context);
    const preview = await app.api(capability, "/api/artifact-deletion/preview", { artifactKind: "report", artifactId: saved.bundleId });
    assert.equal(preview.status, 200);
    const result = await app.api(capability, "/api/artifact-deletion/confirm", { operationId: preview.body.operationId, confirmed: true });
    assert.equal(result.status, 500);
    assert.equal(result.body.outcome, "unknown");
    const pending = JSON.parse(await readFile(path.join(app.context.dataDir, `${BOARD_ID}.state.json`), "utf8"));
    assert.equal(pending.deletion.pending, preview.body.operationId);
    const opens = app.opens;
    interrupt = false;
    await app.restartSourceHost();
    const status = await app.api(await app.panel(), "/api/artifact-deletion/status", {
        operationId: preview.body.operationId, receiptToken: preview.body.receiptToken,
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.phase, "complete");
    assert.doesNotMatch(JSON.stringify(status.body), /nativeArtifactAdmission|nativeSourceBinding|cleanup/);
    const state = await loadBoardState(app.context);
    assert.deepEqual(state.nativeRetention, before.nativeRetention);
    assert.equal(state.nativeReportPolicy, before.nativeReportPolicy);
    assert.equal(state.exports.length, 0);
    for (const file of Object.values(saved.files)) await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(app.opens, opens);
    assert.equal(seals, 2);
});

test("ordinary GitHub artifact metadata cannot expose or imply deletion through a hidden native dependency", async t => {
    let described = 0;
    const app = await fixture(t, { deletion: { describeSavedArtifact() {
        described++; assert.fail("Hidden dependency must deny before descriptor I/O.");
    } } });
    const capability = await app.panel();
    await seedSavedNativeReport(app, capability);
    const github = githubFixture("visible-github-hidden-dependency");
    await replaceEvidence(app.context, (_records, importCoverage) => ({ records: [github], importCoverage }));
    const saved = [];
    for (let index = 0; index < 2; index++) {
        const before = await loadBoardState(app.context);
        const preview = await app.api(capability, "/api/preview", {
            selection: { kind: "selected", revision: before.revision, scenarioIds: [github.scenarioId] },
            options: { formats: ["html", "json"], promptMode: "none" },
        });
        assert.equal(preview.status, 200);
        assert.equal((await app.api(capability, "/api/privacy-review", {
            previewId: preview.body.previewId, disclosureReviewed: true,
        })).status, 200);
        const result = await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
        assert.equal(result.status, 200);
        saved.push(result.body.bundle);
    }
    const hiddenId = `export-${randomUUID()}`, hiddenTitle = "Private dependency title";
    await updateBoardState(app.context, state => {
        state.exports.push({ bundleId: hiddenId, kind: "comparison", title: hiddenTitle,
            nativeEvidenceHash: "a".repeat(64), nativeSourceBinding: { schemaVersion: 1, account: "0".repeat(64) },
            sourceReports: saved.map(item => ({ bundleId: item.bundleId, snapshotHash: item.snapshotHash })), formats: [], files: {} });
    });
    const target = saved[0].bundleId;
    for (const [route, input] of [
        ["/api/report-artifacts/list", {}],
        ["/api/report/open", { bundleId: target }],
        ["/api/artifact-file", { bundleId: target, kind: "report", format: "json" }],
        ["/api/report-comparison/inspect", { baselineId: target, laterId: saved[1].bundleId }],
        ["/api/report-comparison/preview", { baselineId: target, laterId: saved[1].bundleId, formats: ["json"] }],
    ]) {
        const response = await app.api(capability, route, input);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const text = JSON.stringify(response.body);
        assert.equal(text.includes(hiddenId), false, route);
        assert.equal(text.includes(hiddenTitle), false, route);
        const metadata = response.body.artifact ?? response.body.artifacts?.find(item => item.bundleId === target)
            ?? response.body.sources?.find(item => item.bundleId === target);
        if (metadata) {
            assert.equal(metadata.canDelete, false, route);
            assert.equal(metadata.retainedComparisonCount, 0, "Only authorized visible comparison counts may be projected.");
        }
    }
    const denied = await app.api(capability, "/api/artifact-deletion/eligibility", { artifactKind: "report", artifactId: target });
    assert.equal(denied.status, 403);
    assert.equal((await app.api(capability, "/api/artifact-deletion/preview", {
        artifactKind: "report", artifactId: target,
    })).status, 403);
    assert.equal(described, 0);
});

test("aborted inventory request bodies are expected cancellation, not an internal operation failure", { timeout: 10000 }, async t => {
    const app = await fixture(t), capability = await app.panel(), origin = new URL(app.runtime.url).origin;
    const server = app.runtime.server;
    const observed = Promise.withResolvers(), settled = Promise.withResolvers(), resume = Promise.withResolvers(), errors = [];
    const lease = await app.lifecycle.lease("retained");
    const held = app.lifecycle.admit(lease, () => resume.promise);
    t.after(() => resume.resolve());
    t.mock.method(console, "error", (...args) => { errors.push(args); });
    const listener = request => {
        if (request.url !== "/api/retained/microsoft/inventory") return;
        observed.resolve();
        request.once("error", () => setImmediate(settled.resolve));
    };
    server.on("request", listener);
    t.after(() => server.off("request", listener));
    const request = httpRequest(origin + "/api/retained/microsoft/inventory", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1024",
            "X-Board-Capability": capability },
    });
    request.on("error", error => { if (error.code !== "ECONNRESET") settled.reject(error); });
    request.write('{"schemaVersion":1,');
    await observed.promise;
    await new Promise(resolve => setImmediate(resolve));
    request.destroy();
    await settled.promise;
    resume.resolve();
    await held;
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.some(args => args[0] === "[workiq-runtime] operation failed" && args[1]?.code === "INTERNAL"), false);
    assert.equal((await app.api(capability, "/api/collection/status")).status, 200);
    assert.equal(app.acquisitions, 0);
});

for (const segmented of [false, true]) test(`qualified protected v${segmented ? 2 : 1} report Save publishes reviewed bytes once then reopens and deletes`, async t => {
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeAcquisition: false }), capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "reviewed-publication-http-fixture", check() {}, dispatched() {} };
    const begun = await (segmented ? app.persistence.beginSegmented : app.persistence.begin)({ operationId: randomUUID() }, request);
    await (segmented ? app.persistence.commitSegmented : app.persistence.commit)(begun.ticket, [...chatFixture(), ...coworkFixture()]);
    app.persistence.retire(begun.ticket);
    const state = await app.api(capability, "/api/snapshot", projection);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.nativeReportPublication, { schemaVersion: 1, available: true, reason: null });
    const before = await loadBoardState(app.context);
    const selection = { kind: "all", revision: before.revision };
    const nativeViewId = state.body.nativeRead.allViewId;
    const options = { formats: ["html", "json", "markdown", "pdf"], promptMode: "original", recordedContext: true };
    const first = await app.api(capability, "/api/preview", { selection, nativeViewId, options: { ...options, formats: ["html"] } });
    assert.equal(first.status, 200);
    const edited = first.body.nativeReview.find(copy => copy.author === "user");
    const omitted = first.body.nativeReview.find(copy => copy.author === "assistant");
    const preview = await app.api(capability, "/api/preview", { selection, nativeViewId, options: {
        ...options, manualTerms: ["invented"], overrides: [
            { key: edited.key, text: edited.original.replace("An invented", "A reviewed") },
            { key: omitted.key, omit: true },
        ],
    } });
    assert.equal(preview.status, 200);
    assert.equal((await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true })).status, 428);
    const foreign = await app.panel();
    assert.equal((await app.api(foreign, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true })).status, 409);
    assert.equal((await app.api(foreign, "/api/export", { previewId: preview.body.previewId, confirmed: true })).status, 409);
    assert.deepEqual(await loadBoardState(app.context), before);
    const reviewed = await app.api(capability, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.nativeReportPublication.available, true);
    assert.equal((await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true,
        publication: { bundle: reviewed.body } })).status, 400);
    const saved = await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.state.revision, before.revision + 1);
    const after = await loadBoardState(app.context);
    assert.equal(after.exports.length, 1);
    assert.deepEqual(after.nativeRetention, before.nativeRetention);
    assert.equal(after.globalCollection, undefined);
    assert.equal(after.stateVersion, segmented ? 7 : 5);
    assert.equal(after.artifactDeletion.revision, (before.artifactDeletion?.revision ?? 0) + 1);
    assert.doesNotMatch(JSON.stringify(saved.body), /nativeSourceBinding|originalViewExpectations|rootHash|nativeArtifactAdmission/);
    for (const [name, file] of Object.entries(reviewed.body.files)) {
        const expected = typeof file === "string" ? Buffer.from(file) : Buffer.from(file.data, "base64");
        assert.deepEqual(await readFile(saved.body.bundle.files[name]), expected);
    }
    const frozen = await app.api(capability, "/api/artifact-file", { bundleId: saved.body.bundle.bundleId, kind: "report", format: "json" });
    assert.equal(frozen.status, 200);
    const document = JSON.parse(Buffer.from(frozen.body.data, "base64").toString("utf8"));
    assert.equal(document.nativeEvidence.disclosure.copies.find(copy => copy.key === omitted.key).omitted, true);
    assert.equal(document.nativeEvidence.disclosure.copies.find(copy => copy.key === edited.key).representation, "edited-copy");
    assert.equal((await app.api(capability, "/api/report/open", { bundleId: saved.body.bundle.bundleId })).status, 200);
    assert.equal((await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true })).status, 409);
    assert.deepEqual(await loadBoardState(app.context), after);
    const scope = { artifactKind: "report", artifactId: saved.body.bundle.bundleId };
    assert.equal((await app.api(capability, "/api/artifact-deletion/eligibility", scope)).body.artifact.canDelete, true);
    const removal = await app.api(capability, "/api/artifact-deletion/preview", scope);
    assert.equal(removal.status, 200);
    assert.equal((await app.api(capability, "/api/artifact-deletion/confirm", { operationId: removal.body.operationId, confirmed: true })).body.phase, "complete");
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, before.nativeRetention);
    assert.equal(app.acquisitions, 0);
});

test("copied report controller cannot advertise or dispatch native publication", async t => {
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeAcquisition: false, unqualifiedReports: true }), capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces: ["cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "unqualified-publication-http-fixture", check() {}, dispatched() {} };
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, coworkFixture()); app.persistence.retire(begun.ticket);
    const state = (await app.api(capability, "/api/snapshot", projection)).body;
    assert.deepEqual(state.nativeReportPublication, { schemaVersion: 1, available: false, reason: "runtime-unqualified" });
    const before = await loadBoardState(app.context);
    const preview = await app.api(capability, "/api/preview", {
        selection: { kind: "all", revision: before.revision }, nativeViewId: state.nativeRead.allViewId, options: { formats: ["json"] },
    });
    assert.equal(preview.status, 200);
    assert.equal((await app.api(capability, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true })).status, 200);
    const result = await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "NATIVE_REPORT_SAVE_UNAVAILABLE");
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.equal(app.acquisitions, 0);
});

test("native HTTP Save withdrawn after actual file writing remains unknown and never replays", { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    let written, writes = 0;
    const app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeAcquisition: false, async reportWriter(...args) {
            writes++; written = await writeBundle(...args);
            entered.resolve(); await resume.promise;
            return written;
        } });
    t.after(() => resume.resolve());
    const capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces: ["cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "withheld-native-publication-fixture", check() {}, dispatched() {} };
    const begun = await app.persistence.beginSegmented({ operationId: randomUUID() }, request);
    await app.persistence.commitSegmented(begun.ticket, coworkFixture()); app.persistence.retire(begun.ticket);
    const snapshot = (await app.api(capability, "/api/snapshot", projection)).body;
    const before = await loadBoardState(app.context);
    const preview = await app.api(capability, "/api/preview", {
        selection: { kind: "all", revision: before.revision }, nativeViewId: snapshot.nativeRead.allViewId,
        options: { formats: ["json"], promptMode: "none" },
    });
    assert.equal(preview.status, 200);
    assert.equal((await app.api(capability, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true })).status, 200);
    const pending = app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
    await entered.promise;
    assert.equal((await app.api(capability, "/api/session/release")).status, 200);
    resume.resolve();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(response.body.outcome, "unknown");
    assert.equal(response.body.code, "wire_access_outcome_unknown");
    assert.deepEqual(await loadBoardState(app.context), before);
    assert.ok((await readFile(written.files["product-report.json"])).length);
    assert.equal((await app.api(await app.panel(), "/api/export", { previewId: preview.body.previewId, confirmed: true })).status, 409);
    assert.equal(writes, 1);
    assert.equal(app.acquisitions, 0);
});

test("normal source-aware Collect uses the shared segmented publisher and original-ticket completion without replay", async t => {
    let app;
    const completed = [];
    app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        async completeNative(ticket, receipt, source) {
            completed.push({ operationId: ticket.operationId, status: receipt.status,
                comparison: await app.persistence.compareCommittedSource(ticket, source) });
        } });
    const capability = await app.panel();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        expectedRevision: offer.expectedRevision, globalRevision: offer.globalRevision, surfaces: ["cowork"], windowDays: 30,
    })).status, 200);
    const request = { owner: "existing-v1-source-fixture", check() {}, dispatched() {} };
    const legacy = await app.persistence.begin({ operationId: randomUUID() }, request), source = coworkFixture();
    for (const row of source) row.capture.generation = legacy.ticket.lease.generation;
    await app.persistence.commit(legacy.ticket, source);
    app.persistence.retire(legacy.ticket);
    const before = await loadBoardState(app.context), oldReceipt = structuredClone(before.nativeRetention.receipts[0]);
    assert.equal(before.stateVersion, 4);
    const operationId = randomUUID();
    const result = await app.api(capability, "/api/collection/microsoft/now", { operationId });
    assert.equal(result.status, 200);
    assert.equal(result.body.nativePersistenceReceipt.status, "committed");
    assert.equal(result.body.nativePersistenceReceipt.schemaVersion, 1);
    assert.equal(Object.hasOwn(result.body.nativePersistenceReceipt, "storageIntent"), false);
    const after = await loadBoardState(app.context);
    assert.equal(after.stateVersion, 7);
    assert.equal(after.nativeRetention.schemaVersion, 2);
    assert.equal(after.nativeRetention.partitions[0].format, "segments-v2");
    assert.deepEqual(after.nativeRetention.receipts[0], oldReceipt);
    assert.equal(after.nativeRetention.receipts.at(-1).storageIntent.previousFormat, "screened-v1");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].operationId, operationId);
    assert.equal(completed[0].comparison.status, "matched");
    assert.equal(app.acquisitions, 1);
    const qualified = await app.api(capability, "/api/retained/microsoft/readback", { schemaVersion: 1, operationId });
    assert.equal(qualified.body.status, "matched");
    assert.equal(qualified.body.readback.committed.operationId, operationId);
    const recovered = await app.api(capability, "/api/collection/microsoft/now", { operationId });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.nativePersistenceReceipt.operationId, operationId);
    assert.equal(app.acquisitions, 1);
    assert.equal(completed.length, 1);
    assert.deepEqual(await loadBoardState(app.context), after);
    const next = await app.api(capability, "/api/collection/microsoft/now", { operationId: randomUUID() });
    assert.equal(next.status, 200);
    assert.equal((await loadBoardState(app.context)).nativeRetention.receipts.at(-1).storageIntent.previousFormat, "segments-v2");
    assert.equal(app.acquisitions, 2);
    assert.equal(completed.length, 2);
    assert.equal(completed[1].comparison.status, "matched");
});

test("public native Enable uses its offer without Resume and later Save preserves Pause", async t => {
    const app = await fixture(t, { preAccount: "metadata-only", configurationIntents: true,
        initialConnect: false, paused: true, nativeConnection: true });
    const capability = await app.panel();
    const command = action => app.api(capability, "/api/access/command", {
        schemaVersion: 1, action, operationId: randomUUID(), generation,
    });
    let generation = (await app.lifecycle.status()).generation;
    const signedIn = await command("wire-sign-in");
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.body.outcome, "completed");
    generation = (await app.lifecycle.status()).generation;
    const unavailable = await app.api(capability, "/api/collection/status");
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.nativeControl.canResume, false);
    assert.deepEqual(unavailable.body.nativeConfigurationOffer.values, { surfaces: ["chat", "cowork"], windowDays: 30 });
    assert.deepEqual(unavailable.body.nativeConfigurationOffer.blockers, ["NATIVE_CONFIGURATION_ACCOUNT_REQUIRED"]);
    const snapshot = await app.api(capability, "/api/snapshot", projection);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.body.collection.nativeConfigurationOffer, unavailable.body.nativeConfigurationOffer);
    assert.equal(app.opens, 0);
    assert.equal(app.acquisitions, 0);
    const connected = await command("microsoft-connect");
    assert.equal(connected.status, 200);
    assert.equal(connected.body.outcome, "completed");
    const offered = (await app.api(capability, "/api/collection/status")).body;
    assert.equal(offered.nativeControl.canResume, false);
    assert.equal(offered.nativeConfigurationOffer.available, true);
    const intent = offer => ({ schemaVersion: 1, intent: offer.intent, generation: offer.generation,
        authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision,
        surfaces: [...offer.values.surfaces], windowDays: offer.values.windowDays });
    assert.notEqual((await app.api(capability, "/api/collection/enabled", {
        enabled: true, expectedNativeRevision: offered.nativeControl.revision,
    })).status, 200);
    assert.equal(await readNativeCollectionSettings(app.context), null);
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 400);
    const enabled = await app.api(capability, "/api/collection/configure", intent(offered.nativeConfigurationOffer));
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.nativeControl.enabled, true);
    assert.equal(enabled.body.nativePersistence.configured, true);
    assert.equal(enabled.body.nativeConfigurationOffer.intent, "save");
    assert.equal(enabled.body.nativeConfigurationOffer.basis, "committed-native");
    assert.deepEqual(enabled.body.nativeConfigurationOffer.values, { surfaces: ["chat", "cowork"], windowDays: 30 });
    assert.equal((await readNativeCollectionSettings(app.context)).paused, false);
    assert.equal(app.opens, 1);
    assert.equal(app.acquisitions, 0, "Enable must not issue a collection or acquire content.");
    const paused = await app.api(capability, "/api/collection/enabled", {
        enabled: false, expectedNativeRevision: enabled.body.nativeControl.revision,
    });
    assert.equal(paused.status, 200);
    const saveOffer = (await app.api(capability, "/api/collection/status")).body.nativeConfigurationOffer;
    const saved = await app.api(capability, "/api/collection/configure", {
        ...intent(saveOffer), surfaces: ["cowork"], windowDays: 14,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.nativeControl.enabled, false);
    assert.deepEqual(saved.body.nativeConfigurationOffer.values, { surfaces: ["cowork"], windowDays: 14 });
    assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal(app.acquisitions, 0);
    assert.equal(app.opens, 1);
    assert.equal((await app.api(capability, "/api/collection/configure", intent(saveOffer))).status, 409,
        "A successful Save never makes the old offered authority safe to replay.");
});

test("lost Enable response recovers current configuration without replaying Enable or acquiring content", async t => {
    const app = await fixture(t, { configurationIntents: true, paused: true, nativeConnection: true });
    const capability = await app.panel();
    const offered = (await app.api(capability, "/api/collection/status")).body.nativeConfigurationOffer;
    const input = { schemaVersion: 1, intent: offered.intent, generation: offered.generation,
        authorizationRevision: offered.authorizationRevision, expectedRevision: offered.expectedRevision,
        surfaces: [...offered.values.surfaces], windowDays: offered.values.windowDays };
    const controller = new AbortController();
    const unsubscribe = app.lifecycle.subscribeAuthorizationChange(event => {
        if (event.collection === "enabled") controller.abort();
    });
    try {
        await assert.rejects(app.api(capability, "/api/collection/configure", input, "POST", controller.signal),
            { name: "AbortError" });
    } finally { unsubscribe(); }
    const recovered = await app.api(await app.panel(), "/api/collection/status");
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.nativePersistence.configured, true);
    assert.equal(recovered.body.nativeControl.enabled, true);
    assert.equal(recovered.body.nativeConfigurationOffer.intent, "save");
    assert.equal(recovered.body.nativeConfigurationOffer.expectedRevision, 1);
    assert.equal(recovered.body.nativePersistence.receipt, null);
    assert.equal((await readNativeCollectionSettings(app.context)).paused, false);
    assert.equal((await app.api(capability, "/api/collection/configure", input)).status, 409);
    assert.equal((await readNativeCollectionSettings(app.context)).configurationRevision, 1);
    assert.equal(app.acquisitions, 0);
    assert.equal(app.opens, 1);
});

test("native metadata cannot publish when its backend owner returns false after the asynchronous read", async t => {
    const app = await fixture(t, { configurationIntents: true, paused: true });
    for (const read of [
        admission => app.access.nativePersistenceStatus({}, admission),
        admission => app.access.nativeConfigurationOffer(admission),
    ]) {
        let live = true;
        const admission = {
            owner: "example-native-metadata-owner",
            check() {
                const allowed = live;
                queueMicrotask(() => { live = false; });
                return allowed;
            },
            dispatched() { assert.fail("A metadata read must not dispatch a mutation."); },
        };
        await assert.rejects(read(admission), { code: "wire_access_revoked" });
    }
    assert.equal(app.acquisitions, 0);
});

test("native metadata accepts only synchronous undefined or true owner checks and drains rejected thenables", async t => {
    const app = await fixture(t, { configurationIntents: true, paused: true });
    for (const read of [
        admission => app.access.nativePersistenceStatus({}, admission),
        admission => app.access.nativeConfigurationOffer(admission),
    ]) {
        const admission = check => ({ owner: "example-native-metadata-owner", check,
            dispatched() { assert.fail("A metadata read must not dispatch a mutation."); } });
        for (const checked of [undefined, true]) await read(admission(() => checked));
        for (const check of [
            () => false, () => "true", () => ({}), () => Promise.resolve(true),
            () => Promise.reject(new Error("Example rejected owner check.")),
            () => ({ then(resolve, reject) { reject(new Error("Example rejected thenable owner check.")); } }),
        ]) {
            await assert.rejects(read(admission(check)), { code: "wire_access_revoked" });
        }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.acquisitions, 0);
});

test("source-aware explicit GitHub manual leases retain their request owner while global scheduling is paused", async t => {
    const app = await fixture(t, { sourceAware: true, globalCollection: { revision: 1, paused: true }, paused: true });
    const capability = await app.panel();
    assert.equal((await app.api(capability, "/api/access/status", undefined, "GET")).body.collectionMode, "source-aware");
    assert.equal((await app.api(capability, "/api/access/watch", { schemaVersion: 1, after: null })).body.collectionMode, "source-aware");
    assert.match(await (await fetch(app.runtime.url)).text(), /"collectionMode":"source-aware"/);
    let live = true, admitted = 0;
    const request = { owner: "example-github-manual-owner", check() { return live; }, dispatched() {} };
    assert.equal(app.access.collectionAvailable(), false);
    await assert.rejects(app.access.acquireCollectionLease());
    const manual = await app.access.acquireCollectionLease(request);
    assert.equal(manual.kind, "github-manual-acquisition");
    const unbound = await app.lifecycle.lease("github-manual-acquisition");
    assert.throws(() => app.access.assertCollectionLease(unbound), { code: "wire_access_invalid_lease" });
    assert.throws(() => app.access.assertCollectionLease({ ...manual }), { code: "wire_access_invalid_lease" });
    assert.equal(await app.access.assertCollectionLease(manual), true);
    await app.access.admitCollection(manual, () => { admitted++; });
    live = false;
    await assert.rejects(async () => app.access.assertCollectionLease(manual), { code: "wire_access_revoked" });
    await assert.rejects(async () => app.access.admitCollection(manual, () => { admitted++; }), { code: "wire_access_revoked" });
    assert.equal(admitted, 1);
    assert.equal((await app.lifecycle.globalCollectionStatus()).globalCollection.paused, true);
    assert.equal(app.acquisitions, 0);
});

test("source completion receives the actual backend commit outside lifecycle admission and is not replayed", async t => {
    let app, completions = 0, compared;
    app = await fixture(t, { async completeNative(ticket, receipt, envelopes) {
        completions++;
        assert.equal(ticket.lease.kind, "microsoft-read");
        assert.equal(await app.lifecycle.assertLease(ticket.lease), true);
        assert.equal(receipt.status, "committed");
        assert.equal(receipt.operationId, ticket.operationId);
        assert.ok(Array.isArray(envelopes) && envelopes.length > 0);
        compared = await app.persistence.compareCommittedSource(ticket, envelopes);
    } });
    const capability = await app.panel(), operationId = randomUUID();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    assert.equal((await app.api(capability, "/api/collection/now", { operationId })).status, 200);
    assert.equal((await app.api(capability, "/api/collection/now", { operationId })).status, 200);
    assert.equal(completions, 1);
    assert.equal(app.acquisitions, 1);
    assert.equal(compared.status, "matched");
    assert.ok(compared.retainedObservationInputs > 0);
});

test("source completion still releases a failed acquisition without inventing a committed result", async t => {
    let completions = 0;
    const app = await fixture(t, {
        beforeAcquire() { throw new BoardError("Example source unavailable.", 503); },
        completeNative(ticket, receipt, envelopes) {
            completions++;
            assert.equal(ticket.lease.kind, "microsoft-read");
            assert.equal(receipt, undefined);
            assert.equal(envelopes, undefined);
        },
    });
    const capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const result = await app.api(capability, "/api/collection/now", { operationId: randomUUID() });
    assert.equal(result.status, 503);
    assert.equal(result.body.outcome, "unknown");
    assert.equal(completions, 1);
});

for (const protocolStop of [false, true, "binding"])
test(`ordinary acquisition persists original admission and checkpoint through later failure and restart${protocolStop
    ? protocolStop === "binding" ? " with capacity binding" : " with protocol stop" : ""}`, async t => {
    let original;
    try {
        assertNativeRequestAdmission(false, { url: new URL("https://login.microsoftonline.com/PRIVATE_ROUTE?secret=PRIVATE_QUERY"),
            method: "GET", type: "fetch", owned: true, original: true, navigation: false }, "protocol", "auth-data");
    } catch (error) { original = error; }
    if (protocolStop) original = nativeProtocolFailure("request-failed", null, {
        observation: { source: "network", terminal: "failed" },
    });
    if (protocolStop === "binding") original = nativeProtocolFailure("capacity-unbound", {
        url: new URL("https://aadcdn.msauth.net/fixture.gif"), method: "GET", type: "image",
        owned: true, original: true, navigation: false, stage: "request",
    }, { observation: {
        capacity: { active: 128, reserved: 0, waiting: 1, withoutTerminal: 128, withoutAcknowledgement: 128, redirecting: 0 },
        binding: { reason: "metadata-timeout", retained: 135, limit: 512, capped: false },
    } });
    const detail = nativeFailureDetails(original, "acquisition");
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    let app, checkpoint;
    app = await fixture(t, { sourceAware: true, configurationIntents: true, preAccount: "metadata-only",
        nativeConnection: true, paused: true, backfillTracking: true,
        async beforeAcquire(lease, recordFailure, configuration, previous) {
            checkpoint = createNativeBackfill(lease.partition, configuration.settings.windowDays,
                configuration.surfaces, configuration.privacyRevision, previous, Date.now(), previous.deletionVersion ?? 0);
            const source = checkpoint.sources[0];
            source.controlObserved = true; source.initial = "empty";
            source.pages = ["a".repeat(64)]; source.chain = "b".repeat(64); source.chainPages = 1;
            source.histories = [{ key: "c".repeat(64), activity: Date.parse(checkpoint.window.to) - 1000,
                handledActivity: null, handledThrough: null, state: "unreadable" }];
            source.stops = ["unreadable-history"];
            await recordFailure(original, attachNativeBackfill([], checkpoint));
            await app.lifecycle.expire(lease);
            const laterProgress = structuredClone(checkpoint);
            laterProgress.sources[0].histories = [];
            await recordFailure(new Error("PRIVATE_LATER_ERROR"), attachNativeBackfill([], laterProgress));
            throw new Error("PRIVATE_LATER_ERROR");
        },
        completeNative() { throw new Error("PRIVATE_CLEANUP_ERROR"); },
    });
    const capability = await app.panel(), operationId = randomUUID();
    const offer = (await app.api(capability, "/api/collection/microsoft/status")).body.nativeConfigurationOffer;
    assert.equal((await app.api(capability, "/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const result = await app.api(capability, "/api/collection/microsoft/now", { operationId });
    assert.notEqual(result.status, 200);
    const state = await loadBoardState(app.context);
    const saved = state.nativeRetention.receipts.find(row => row.operationId === operationId);
    assert.deepEqual({ admission: saved.firstFailure?.admission,
        histories: state.nativeRetention.backfill[0].sources[0].histories },
    { admission: detail.admission, histories: checkpoint.sources[0].histories });
    assert.equal(saved.firstFailure.code, original.code);
    assert.deepEqual(saved.firstFailure.predicate, detail.predicate);
    assert.deepEqual(saved.firstFailure.protocolStop, detail.protocolStop);
    assert.equal(saved.backfill.sources[0].unreadable, 1);
    assert.equal((await app.api(capability, "/api/collection/microsoft/status", { operationId })).body.nativePersistence.receipt.firstFailure, undefined);
    await app.restartPaused();
    const restarted = await loadBoardState(app.context);
    assert.deepEqual(restarted.nativeRetention.receipts.find(row => row.operationId === operationId).firstFailure, saved.firstFailure);
    assert.deepEqual(restarted.nativeRetention.backfill, state.nativeRetention.backfill);
    assert.equal(app.acquisitions, 1);
    assert.doesNotMatch(JSON.stringify({ state, restarted, result, logs }), /PRIVATE_|https:\/\/login\.microsoftonline/);
});

test("registered acquisition keeps its first predicate after expiry, cleanup failure and restart without replay", async t => {
    const predicate = { schemaVersion: 1, stage: "protocol", name: "favicon-request-network-id" };
    let app, ticket;
    app = await fixture(t, {
        async beforeAcquire(lease) {
            await app.lifecycle.expire(lease);
            throw withNativeFailurePredicate(Object.assign(new BoardError("Private source failure.", 503),
                { code: "NATIVE_FAVICON_UNQUALIFIED" }), predicate.stage, predicate.name);
        },
        async completeNative(original) {
            ticket = original;
            const later = nativeFailureDetails(Object.assign(new Error("PRIVATE_CLEANUP_VALUE"),
                { code: "NATIVE_SOURCE_REQUEST_FAILED" }), "completion");
            assert.equal(await app.persistence.recordFailure(original, later), false);
            throw new Error("PRIVATE_CLEANUP_VALUE");
        },
    });
    const capability = await app.panel(), operationId = randomUUID();
    await app.api(capability, "/api/collection/configure", { expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 });
    const result = await app.api(capability, "/api/collection/now", { operationId });
    assert.notEqual(result.status, 200);
    assert.equal(result.body.outcome, "unknown");
    const state = await loadBoardState(app.context);
    const saved = state.nativeRetention.receipts.find(row => row.operationId === operationId);
    assert.equal(saved.status, "registered");
    assert.equal(saved.firstFailure.code, "NATIVE_FAVICON_UNQUALIFIED");
    assert.deepEqual(saved.firstFailure.predicate, predicate);
    assert.doesNotMatch(JSON.stringify(state), /Private source failure|PRIVATE_CLEANUP_VALUE/);
    assert.deepEqual(state.nativeRetention.partitions, []);
    const publicReceipt = (await app.api(capability, "/api/collection/status", { operationId })).body.nativePersistence.receipt;
    assert.equal(publicReceipt.firstFailure, undefined);
    const before = JSON.stringify(saved.firstFailure);
    await app.restartPaused();
    assert.equal(JSON.stringify((await loadBoardState(app.context)).nativeRetention.receipts.find(row =>
        row.operationId === operationId).firstFailure), before);
    assert.equal(app.acquisitions, 1);
    await assert.rejects(app.persistence.recordFailure(ticket, nativeFailureDetails(new Error("cleanup"), "completion")),
        { code: "NATIVE_RETENTION_TICKET_INVALID" });
});
test("a cleanup failure is explicit but cannot erase the original source error", async t => {
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    const app = await fixture(t, {
        beforeAcquire() {
            throw Object.assign(new BoardError("Example source unavailable.", 503), { code: "EXAMPLE_SOURCE_UNAVAILABLE" });
        },
        completeNative() { throw new Error("cleanup-private-details"); },
    });
    const capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const result = await app.api(capability, "/api/collection/now", { operationId: randomUUID() });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "EXAMPLE_SOURCE_UNAVAILABLE");
    assert.ok(logs.some(row => row[1]?.code === "NATIVE_CAPTURE_COMPLETION_FAILED"));
    assert.equal(JSON.stringify(logs).includes("cleanup-private-details"), false);
});

test("the registered source hook durably records its original stop before cleanup finishes", async t => {
    const recorded = Promise.withResolvers(), cleanup = Promise.withResolvers();
    const error = withNativeFailurePredicate(Object.assign(new BoardError("Source stopped.", 503),
        { code: "NATIVE_FAVICON_UNQUALIFIED" }), "route", "favicon-request-admission");
    const app = await fixture(t, {
        async beforeAcquire(_lease, recordFailure) {
            await recordFailure(error);
            recorded.resolve();
            await cleanup.promise;
            throw error;
        },
    });
    t.after(() => cleanup.resolve());
    const capability = await app.panel(), operationId = randomUUID();
    await app.api(capability, "/api/collection/configure", { expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 });
    const collecting = app.api(capability, "/api/collection/now", { operationId });
    try {
        await recorded.promise;
        const current = (await loadBoardState(app.context)).nativeRetention.receipts.find(row => row.operationId === operationId);
        assert.equal(current.firstFailure.predicate.name, "favicon-request-admission");
        assert.equal(current.status, "registered");
        assert.equal((await app.api(capability, "/api/collection/status", { operationId })).body.nativePersistence.receipt.status, "pending");
    } finally { cleanup.resolve(); }
    assert.equal((await collecting).body.outcome, "unknown");
    assert.equal(app.acquisitions, 1);
});
test("normal snapshots preserve the current owner's native status before and after Collect", { timeout: 15000 }, async t => {
    const app = await fixture(t), capability = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const routes = [
        ["/api/snapshot", projection], ["/api/refresh", {}], ["/api/state", {}, "GET"],
        ["/api/canvas", { action: "get_snapshot", input: projection }],
        ["/api/canvas", { action: "get_state", input: {} }],
        ["/api/canvas", { action: "reload_snapshot", input: {} }],
    ];
    for (const [route, input, method] of routes) {
        const result = await app.api(capability, route, input, method);
        assert.equal(result.status, 200);
        assert.equal(result.body.collection?.nativeControl?.writerAdmission, "withheld", route);
        assert.equal(result.body.collection?.nativePersistence?.configured, true, route);
        assert.equal(result.body.collection.nativePersistence.actions.includes("collect-now"), true, route);
        assert.equal(result.body.collection.nativePersistence.receipt, null, route);
    }
    const operationId = randomUUID();
    const collected = await app.api(capability, "/api/collection/now", { operationId });
    assert.equal(collected.status, 200);
    for (const [route, input, method] of routes) {
        const result = await app.api(capability, route, input, method);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.collection?.nativePersistence?.receipt, collected.body.nativePersistenceReceipt, route);
        assert.equal(result.body.nativeRead.readback.snapshot, collected.body.nativePersistenceReceipt.snapshot, route);
    }
    const foreign = await app.panel();
    const foreignSnapshot = await app.api(foreign, "/api/snapshot", projection);
    assert.equal(foreignSnapshot.status, 200);
    assert.equal(foreignSnapshot.body.collection.nativePersistence.receipt, null, "Snapshots must not adopt another panel's operation.");
    const generation = (await app.lifecycle.status()).generation;
    assert.equal((await app.api(capability, "/api/access/command", {
        schemaVersion: 1, action: "wire-sign-out", operationId: randomUUID(), generation,
    })).status, 200);
    for (const [route, input, method] of routes) {
        const denied = await app.api(capability, route, input, method);
        assert.equal(denied.status, 403, route);
        assert.equal(denied.body.collection, undefined, route);
    }
});

test("transient first-failure storage loss cannot let cleanup replace the original predicate", async t => {
    const originalError = withNativeFailurePredicate(Object.assign(new BoardError("PRIVATE_FIRST_ERROR", 503),
        { code: "NATIVE_FAVICON_UNQUALIFIED" }), "protocol", "favicon-request-epoch");
    let cleanupCalls = 0;
    const app = await fixture(t, {
        beforeAcquire() { throw originalError; },
        completeNative() {
            cleanupCalls++;
            throw Object.assign(new Error("PRIVATE_CLEANUP_ERROR"), { code: "NATIVE_SOURCE_REQUEST_FAILED" });
        },
    });
    const capability = await app.panel(), operationId = randomUUID(), owner = "transient-first-failure-owner";
    const admission = { owner, check() {}, dispatched() {} };
    await app.api(capability, "/api/collection/configure", { expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 });
    let failedWrites = 0;
    const rename = filesystem.rename;
    const failure = t.mock.method(filesystem, "rename", async (from, to) => {
        if (!failedWrites && String(to).endsWith(`${BOARD_ID}.state.json`)) {
            const state = JSON.parse(await readFile(from, "utf8"));
            if (state.nativeRetention?.receipts.find(row => row.operationId === operationId)?.firstFailure) {
                failedWrites++;
                throw Object.assign(new Error("Fixture first diagnostic write failed."), { code: "EIO" });
            }
        }
        return rename(from, to);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(app.access.collectNativeNow({ operationId }, admission), error => error === originalError); }
    finally { failure.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(failedWrites, 1);
    assert.equal(cleanupCalls, 1);
    const saved = (await loadBoardState(app.context)).nativeRetention.receipts.find(row => row.operationId === operationId);
    assert.equal(saved.status, "registered");
    assert.equal(saved.firstFailure.code, "NATIVE_FAVICON_UNQUALIFIED");
    assert.deepEqual(saved.firstFailure.predicate, { schemaVersion: 1, stage: "protocol", name: "favicon-request-epoch" });
    await app.restartPaused();
    const recovered = await app.persistence.begin({ operationId }, admission);
    assert.equal(recovered.kind, "unresolved");
    assert.equal(recovered.receipt.status, "unknown");
    assert.equal(recovered.receipt.firstFailure, undefined);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention.receipts.find(row =>
        row.operationId === operationId).firstFailure, saved.firstFailure);
    assert.equal(app.acquisitions, 1);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_FIRST|PRIVATE_CLEANUP/);
});
for (const revoke of ["release", "signout"]) test(`native snapshot status cannot publish after ${revoke} during projection`, { timeout: 10000 }, async t => {
    const app = await fixture(t), capability = await app.panel(), control = await app.panel();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const generation = (await app.lifecycle.status()).generation;
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const original = app.runtime.collector.status.bind(app.runtime.collector);
    t.mock.method(app.runtime.collector, "status", async (...args) => {
        const value = await original(...args);
        entered.resolve(); await resume.promise;
        return value;
    });
    const pending = app.api(capability, "/api/snapshot", projection);
    try {
        await bounded(entered.promise);
        const denied = revoke === "release"
            ? await app.api(capability, "/api/session/release")
            : await app.api(control, "/api/access/command", { schemaVersion: 1, action: "wire-sign-out", operationId: randomUUID(), generation });
        assert.equal(denied.status, 200);
    } finally { resume.resolve(); }
    const result = await pending;
    assert.equal(result.status, 403);
    assert.equal(result.body.collection, undefined);
    assert.equal(result.body.nativeRead, undefined);
});

test("registered operation recovery is read-only during acquisition and cannot replay an unknown attempt", { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const app = await fixture(t, { async beforeAcquire() {
        entered.resolve();
        await resume.promise;
        throw Object.assign(new BoardError("Example source acquisition was not available.", 503), { code: "EXAMPLE_SOURCE_UNAVAILABLE" });
    } });
    const capability = await app.panel(), operationId = randomUUID();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const pending = app.api(capability, "/api/collection/now", { operationId });
    try {
        await bounded(entered.promise);
        const status = await bounded(app.api(capability, "/api/collection/status", { operationId }));
        assert.equal(status.status, 200);
        assert.equal(status.body.nativePersistence.receipt.status, "pending");
        assert.equal(status.body.nativePersistence.receipt.operationId, operationId);
        assert.equal(Object.hasOwn(status.body.nativePersistence.receipt, "snapshot"), false);
        assert.equal(Object.hasOwn(status.body.nativePersistence.receipt, "revision"), false);
        assert.equal(app.acquisitions, 1);
    } finally { resume.resolve(); }
    const failed = await pending;
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, "EXAMPLE_SOURCE_UNAVAILABLE");
    assert.equal(failed.body.outcome, "unknown");
    const recovered = await app.api(capability, "/api/collection/status", { operationId });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.nativePersistence.receipt.status, "unknown");
    const repeat = await app.api(capability, "/api/collection/now", { operationId });
    assert.equal(repeat.status, 409);
    assert.equal(repeat.body.code, "NATIVE_RETENTION_OPERATION_UNKNOWN");
    assert.equal(repeat.body.nativePersistenceReceipt.operationId, operationId);
    assert.equal(repeat.body.outcome, "unknown");
    assert.equal(app.acquisitions, 1, "Registration recovery must never dispatch a second acquisition.");
});

test("public Pause is not queued behind acquisition and prevents its later data commit", { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const app = await fixture(t, { async beforeAcquire() { entered.resolve(); await resume.promise; } });
    const capability = await app.panel(), operationId = randomUUID();
    const configured = await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    });
    assert.equal(configured.status, 200);
    const pending = app.api(capability, "/api/collection/now", { operationId });
    try {
        await bounded(entered.promise);
        const paused = await bounded(app.api(capability, "/api/collection/enabled", {
            enabled: false, expectedNativeRevision: configured.body.nativeControl.revision,
        }));
        assert.equal(paused.status, 200);
        assert.equal((await readNativeCollectionSettings(app.context)).paused, true);
    } finally { resume.resolve(); }
    const rejected = await pending;
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.outcome, "unknown");
    const status = await app.api(capability, "/api/collection/status", { operationId });
    assert.equal(status.status, 200);
    assert.equal(status.body.nativePersistence.receipt.status, "unknown");
    assert.equal(Object.hasOwn(status.body.nativePersistence.receipt, "snapshot"), false);
    const snapshot = await app.api(capability, "/api/snapshot", projection);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.nativeRead.readback.snapshot, null);
    assert.equal(app.acquisitions, 1);
});

test("native changed-window configuration stays coherent through durable Pause and Resume", async t => {
    const app = await fixture(t), capability = await app.panel();
    const configured = await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 7,
    });
    assert.equal(configured.status, 200);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 7);
    assert.equal((await app.api(capability, "/api/collection/enabled", {
        enabled: false, expectedNativeRevision: configured.body.nativeControl.revision,
    })).status, 200);
    const stored = await readNativeCollectionSettings(app.context);
    assert.equal(stored.paused, true);
    assert.equal(stored.windowDays, 7);
    const paused = (await app.api(capability, "/api/collection/status")).body.nativeControl;
    assert.equal((await app.api(capability, "/api/collection/enabled", {
        enabled: true, expectedNativeRevision: paused.revision,
    })).status, 200);
    assert.equal((await app.lifecycle.collectionIntent()).windowDays, 7);
    assert.equal((await readNativeCollectionSettings(app.context)).windowDays, 7);
    assert.equal(app.acquisitions, 0);
});

test("a fresh process reads the durable native snapshot from committed paused settings", { timeout: 15000 }, async t => {
    let registeredWindow;
    const app = await fixture(t, { backfillTracking: true, beforeAcquire: async () => {
        const progress = (await loadBoardState(app.context)).nativeRetention.backfill?.[0];
        assert.ok(progress, "Registration must persist the unfinished window before source work.");
        registeredWindow = progress.window;
    } }), capability = await app.panel(), operationId = randomUUID();
    assert.equal((await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    })).status, 200);
    const collected = await app.api(capability, "/api/collection/now", { operationId });
    assert.equal(collected.status, 200);
    const receipt = collected.body.nativePersistenceReceipt;
    const before = await app.api(capability, "/api/snapshot", projection);
    assert.equal(before.status, 200);
    const data = before.body.scenarios.filter(row => row.nativeConversation).map(row => row.nativeConversation);
    const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const control = (await app.api(capability, "/api/collection/status")).body.nativeControl;
    assert.equal((await app.api(capability, "/api/collection/enabled", {
        enabled: false, expectedNativeRevision: control.revision,
    })).status, 200);
    await app.stop();
    const result = await promisify(execFile)(process.execPath,
        [fileURLToPath(new URL("./native-persistence-restart.mjs", import.meta.url)), app.context.dataDir],
        { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
    const restored = JSON.parse(result.stdout);
    assert.notEqual(restored.pid, process.pid);
    assert.equal(restored.collection, "paused");
    assert.equal(restored.settings.paused, true);
    assert.equal(restored.providerAttempts, 0);
    assert.equal(restored.acquisitions, 0);
    assert.equal(restored.dataDigest, digest);
    assert.equal(restored.conversations, data.length);
    assert.equal(restored.readback.snapshot, receipt.snapshot);
    assert.equal(restored.readback.committed.operationId, operationId);
    assert.ok(restored.readback.current.generation > receipt.generation);
    assert.equal(restored.receipt, null);
    assert.equal(restored.actions.includes("collect-now"), false);
    assert.equal(restored.backfill.state, "started", "A data commit without progress publication cannot imply covered history.");
    assert.deepEqual(restored.backfill.window, registeredWindow);
    assert.ok(restored.backfill.sources.every(row => !row.exhausted && !row.startQualified && row.pages === 0));
});

test("normal native CollectNow commits once and paused restart reads committed data without acquisition", { timeout: 15000 }, async t => {
    const app = await fixture(t), capability = await app.panel();
    assert.equal(await readNativeCollectionSettings(app.context), null);
    const configured = await app.api(capability, "/api/collection/configure", {
        expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30,
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.nativeControl.writerAdmission, "withheld");
    assert.equal(configured.body.nativePersistence.configured, true);
    const operationId = randomUUID();
    const collected = await app.api(capability, "/api/collection/now", { operationId });
    assert.equal(collected.status, 200);
    const receipt = collected.body.nativePersistenceReceipt;
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.operationId, operationId);
    assert.equal(Object.hasOwn(receipt, "ownerHash"), false);
    assert.equal(Object.hasOwn(receipt, "fingerprint"), false);
    assert.equal(app.acquisitions, 1);
    const replay = await app.api(capability, "/api/collection/now", { operationId });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.nativePersistenceReceipt, receipt);
    assert.equal(app.acquisitions, 1);
    const recovered = await app.api(capability, "/api/collection/status", { operationId });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body.nativePersistence.receipt, receipt);
    const foreign = await app.panel();
    for (const route of ["/api/collection/status", "/api/collection/now"]) {
        const denied = await app.api(foreign, route, { operationId });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.code, "NATIVE_RETENTION_OPERATION_OWNER");
    }
    assert.equal(app.acquisitions, 1);
    const before = await app.api(capability, "/api/snapshot", projection);
    assert.equal(before.status, 200);
    const nativeBefore = before.body.scenarios.filter(row => row.nativeConversation).map(row => row.nativeConversation);
    assert.ok(nativeBefore.length > 0);
    assert.equal(before.body.nativeRead.readback.snapshot, receipt.snapshot);
    assert.equal(before.body.nativeRead.readback.committed.operationId, operationId);
    const control = (await app.api(capability, "/api/collection/status")).body.nativeControl;
    assert.equal((await app.api(capability, "/api/collection/enabled",
        { enabled: false, expectedNativeRevision: control.revision })).status, 200);
    const settings = await readNativeCollectionSettings(app.context);
    assert.equal(settings.paused, true);
    await app.restartPaused();
    assert.equal((await app.lifecycle.status()).collection, "paused");
    const restarted = await app.panel();
    const after = await app.api(restarted, "/api/snapshot", projection);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.scenarios.filter(row => row.nativeConversation).map(row => row.nativeConversation), nativeBefore);
    assert.equal(after.body.nativeRead.readback.snapshot, receipt.snapshot);
    assert.equal(after.body.nativeRead.readback.committed.operationId, operationId);
    assert.ok(after.body.nativeRead.readback.current.generation > receipt.generation);
    assert.equal(after.body.nativeRead.readback.current.configurationRevision, settings.configurationRevision);
    const status = await app.api(restarted, "/api/collection/status");
    assert.equal(status.body.nativePersistence.receipt, null, "A new owner cannot adopt the original operation receipt.");
    assert.equal(status.body.nativePersistence.actions.includes("collect-now"), false);
    assert.equal(app.acquisitions, 1);
    assert.equal(app.opens, 1);
});
