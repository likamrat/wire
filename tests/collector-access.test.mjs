import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { setTimeout as nativeTimeout } from "node:timers";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCollector } from "../lib/collector.mjs";
import { TAIL_LIMITS, collectorHostIdentity } from "../lib/collector-io.mjs";
import { BACKFILL_DIRECTORY } from "../lib/collector-backfill.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createFixtureRuntimeAccess, createNativeRuntimeAccess, createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { createDeletionController } from "../lib/deletion.mjs";
import { selectPersonalEvaluationCleanup } from "../lib/personal-evaluation.mjs";
import { finalizePersonalEvaluationCleanup } from "../lib/assessment-read-model.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";

const owner = "collector-fixture-owner";
const nativeFetch = globalThis.fetch;
const event = (type, data, id = randomUUID()) => ({ id, type, data, timestamp: new Date(Date.now() - 1000).toISOString() });
const lines = events => events.map(value => JSON.stringify(value) + "\n").join("");
function interaction(id) {
    return [
        event("user.message", { content: `Invented collector request ${id}` }, `prompt-${id}`),
        event("tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch",
            toolCallId: id, arguments: { entityUrls: ["/me/messages"] } }, `start-${id}`),
        event("tool.execution_complete", { toolCallId: id, success: true }, `end-${id}`),
    ];
}

async function fixture(t, { enabled = true, timers = false, transport, signedIn = false, sourceAware = false,
    globalCollection = null, startCollector = true } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wire-collector-admission-"));
    const context = { dataDir: path.join(root, "private") }, sourceId = randomUUID();
    const config = { schemaVersion: 1, approved: true, enabled, windowDays: 30, pollSeconds: 5,
        appDbPath: path.join(root, "data.db"), sessionRoot: path.join(root, "session-state") };
    const db = new DatabaseSync(config.appDbPath);
    db.exec("PRAGMA user_version=156; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);");
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceId, "Invented admission chat", "chat", null, "local");
    db.close();
    const sourceFile = path.join(config.sessionRoot, sourceId, "events.jsonl");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, lines([event("session.start", { sessionId: sourceId, version: 1 })]));
    await loadBoardState(context);
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify(config));
    let lifecycle, access, collector, runtime, beforeCommit, beforeSettings;
    const start = async () => {
        const nativeTransport = sourceAware ? createMicrosoftNativeReadTransport({
            async open() { assert.fail("GitHub manual collection cannot open Microsoft."); },
            async verifyAccount() { assert.fail("GitHub manual collection cannot verify Microsoft."); },
            async stop() { return { processExited: true, profileReleased: true }; },
        }) : transport;
        lifecycle = await createMicrosoftSession(context, { collection: { paused: false, windowDays: 7 },
            transport: nativeTransport, sourceAware, ...(sourceAware ? { globalCollection } : {}) });
        if (signedIn && (await lifecycle.status()).wire === "signed-out") {
            await lifecycle.command(owner, { action: "wire-sign-in", operationId: randomUUID(),
                generation: (await lifecycle.status()).generation }, () => true);
        }
        access = sourceAware ? await createNativeRuntimeAccess(context, { lifecycle, sourceAware: true,
            nativeSource() { assert.fail("GitHub checks cannot read native retained content."); },
        }) : await createFixtureRuntimeAccess(context, { lifecycle: {
            ...lifecycle,
            async admit(lease, work) {
                if (lease.kind === "github-acquisition") await beforeCommit?.();
                return lifecycle.admit(lease, work);
            },
            async updateCollection(value) {
                await beforeSettings?.(value);
                return lifecycle.updateCollection(value);
            },
        } });
        collector = await createCollector(context, { timers, access });
    };
    if (startCollector) await start();
    t.after(async () => {
        if (runtime) await runtime.close(); else await collector?.close();
        access?.close(); await lifecycle?.close();
        await rm(root, { recursive: true, force: true });
    });
    return { root, context, config, sourceId, sourceFile,
        get collector() { return collector; }, get lifecycle() { return lifecycle; }, get access() { return access; },
        interceptCommit(work) { beforeCommit = work; },
        interceptSettings(work) { beforeSettings = work; },
        append: values => appendFile(sourceFile, lines(values)),
        async command(action) {
            return lifecycle.command(owner, { action, operationId: randomUUID(),
                generation: (await lifecycle.status()).generation }, () => true);
        },
        async restart() {
            if (runtime) await runtime.close(); else await collector.close();
            runtime = null; access.close(); await lifecycle.close(); await start();
        },
        async http(options = {}) {
            await collector.close();
            runtime = await startServer(context, createExportController(context), {
                port: 0, access, collector: { timers: false, access },
                recorderDiagnostics: { testTransport: () => { throw new Error("Provider operations are forbidden."); } },
                ...options,
            });
            collector = runtime.collector;
            const api = async (capability, route, input) => {
                const origin = new URL(runtime.url).origin;
                const response = await nativeFetch(origin + route, { method: input === undefined ? "GET" : "POST",
                    headers: { Origin: origin, "X-Wire-Session-Protocol": "1", ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                        ...(capability ? { "X-Board-Capability": capability } : {}) },
                    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
                return { code: response.status, body: await response.json() };
            };
            return { runtime, api,
                panel: async () => (await api(null, "/api/session", {})).body.capability,
                async command(capability, action) {
                    return api(capability, "/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(),
                        generation: (await api(capability, "/api/access/status")).body.generation });
                },
            };
        },
    };
}

test("ordinary Copilot-only startup ignores saved Microsoft configuration and preserves GitHub approval and local access", { timeout: 45000 }, async t => {
    const app = await fixture(t, { startCollector: false });
    const legacy = await createCollector(app.context, { timers: false });
    try { await app.append(interaction("before-upgrade")); await legacy.collectNow(); }
    finally { await legacy.close(); }
    const configFile = path.join(app.context.dataDir, "collector", "config.json");
    const approved = await readFile(configFile), before = await loadBoardState(app.context);
    const microsoftFile = path.join(app.context.dataDir, "microsoft-source.json");
    const parked = "PARKED_CONFIGURATION_MUST_NOT_BE_READ";
    await writeFile(microsoftFile, parked);
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    let child, exited, origin, capability;
    const stop = async () => {
        if (!child) return;
        const owned = child;
        if (owned.connected) owned.disconnect();
        const timer = setTimeout(() => owned.kill(), 5000);
        try { assert.equal(await exited, 0); } finally { clearTimeout(timer); child = null; }
    };
    const start = async () => {
        const guard = `import { registerHooks } from "node:module";
            registerHooks({ resolve(specifier, context, next) {
                if (/microsoft-native-(host|configuration)\\.mjs/.test(specifier))
                    throw new Error("Release must not load a Microsoft acquisition/configuration owner.");
                return next(specifier, context);
            } });`;
        child = fork(fileURLToPath(new URL("../scripts/start.mjs", import.meta.url)), ["--port", "0"], {
            env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: app.context.dataDir },
            execArgv: ["--import", "data:text/javascript," + encodeURIComponent(guard)],
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        exited = new Promise(resolve => child.once("exit", resolve));
        let output = "", timer;
        try {
            origin = new URL(await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Ordinary startup timed out.")), 10000);
                child.once("error", reject);
                child.once("exit", () => reject(new Error("Ordinary startup exited before readiness.")));
                child.stderr.once("data", chunk => reject(new Error("Ordinary startup failed: " + chunk)));
                child.stdout.on("data", chunk => {
                    output += chunk;
                    const match = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                    if (match) resolve(match[1]);
                });
            })).origin;
        } finally { clearTimeout(timer); }
        const session = await nativeFetch(origin + "/api/session", { method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1" }, body: "{}" }).then(response => response.json());
        capability = session.capability;
        assert.equal(session.accessBootstrap.collectionMode, "copilot-only");
    };
    const api = async (route, input) => {
        const response = await nativeFetch(origin + route, {
            method: input === undefined ? "GET" : "POST",
            headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        return { status: response.status, body: await response.json() };
    };
    const command = async action => {
        const state = (await api("/api/access/status")).body;
        const result = await api("/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(), generation: state.generation });
        assert.equal(result.status, 200); assert.equal(result.body.outcome, "completed");
    };
    try {
        await start();
        const status = (await api("/api/access/status")).body;
        assert.equal(status.wire, "signed-in", "Existing unbound WIRE access must not become an unexplained new login gate.");
        const source = (await api("/api/collection/sources/status", {})).body;
        assert.equal(source.github.status.config.approved, true);
        assert.equal(source.github.status.config.enabled, true);
        assert.equal(Object.hasOwn(source, "microsoft"), false);
        assert.equal(source.global.state, "legacy-compatible");
        assert.equal(Object.hasOwn(status, "microsoft"), false);
        const sessionFile = path.join(app.context.dataDir, "microsoft-session", "session.json");
        const gateBefore = await readFile(sessionFile);
        for (const route of ["/api/collection/microsoft/enroll", "/api/collection/microsoft/configure",
            "/api/collection/microsoft/enabled", "/api/collection/microsoft/now"]) {
            const denied = await api(route, { enabled: true });
            assert.equal(denied.status, 403, route);
            assert.equal(denied.body.code, "WIRE_SOURCE_NOT_RELEASED");
        }
        for (const action of ["microsoft-connect", "microsoft-recover", "microsoft-cancel"]) {
            const denied = await api("/api/access/command", { schemaVersion: 1, action,
                operationId: randomUUID(), generation: status.generation });
            assert.equal(denied.status, 403);
            assert.equal(denied.body.code, "WIRE_SOURCE_NOT_RELEASED");
            assert.equal((await api("/api/canvas", { action, input: {} })).status, 403);
        }
        assert.deepEqual(await readFile(sessionFile), gateBefore, "Rejected activation must not mutate access receipts.");
        await assert.rejects(readFile(path.join(app.context.dataDir, "microsoft-native", "owner.json")), { code: "ENOENT" });
        await app.append(interaction("interval-after-upgrade"));
        const deadline = Date.now() + 10000;
        while (!(await loadBoardState(app.context)).evidence?.some(record => JSON.stringify(record).includes("interval-after-upgrade"))) {
            if (Date.now() >= deadline) assert.fail("Approved GitHub interval collection did not continue.");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const beforePause = (await api("/api/collection/sources/status", {})).body;
        const paused = await api("/api/collection/global/enabled", { schemaVersion: 1, enabled: false,
            generation: beforePause.generation, authorizationRevision: beforePause.authorizationRevision,
            expectedRevision: beforePause.global.revision });
        assert.equal(paused.status, 200);
        assert.equal(paused.body.global.paused, true);
        await app.append(interaction("manual-while-paused"));
        await new Promise(resolve => setTimeout(resolve, 5500));
        assert.equal((await loadBoardState(app.context)).evidence.some(record => JSON.stringify(record).includes("manual-while-paused")), false);
        assert.equal((await api("/api/canvas", { action: "collect_now", input: {} })).status, 200);
        assert.equal((await loadBoardState(app.context)).evidence.some(record => JSON.stringify(record).includes("manual-while-paused")), true);
        await command("wire-sign-out");
        assert.equal((await api("/api/snapshot", {})).status, 403);
        assert.equal((await api("/api/canvas", { action: "get_state", input: {} })).status, 403);
        assert.equal((await api("/api/canvas", { action: "collect_now", input: {} })).status, 403);
        await stop();
        await start();
        assert.equal((await api("/api/access/status")).body.wire, "signed-out", "Restart must preserve explicit WIRE logout.");
        await command("wire-sign-in");
        assert.equal((await api("/api/snapshot", {})).status, 200);
        assert.equal((await api("/api/collection/sources/status", {})).body.global.paused, true);
        assert.deepEqual(await readFile(configFile), approved);
        assert.equal((await loadBoardState(app.context)).nativeRetention, undefined);
        assert.deepEqual((await loadBoardState(app.context)).exports, before.exports);
        assert.equal(await readFile(microsoftFile, "utf8"), parked);
    } finally { await stop(); }
});

test("Copilot-only canvas requires explicit GitHub approval and preserves the disabled interval on manual collection", async t => {
    const app = await fixture(t, { startCollector: false });
    const configFile = path.join(app.context.dataDir, "collector", "config.json");
    await rm(configFile);
    let access, runtime;
    try {
        runtime = await startServer(app.context, createExportController(app.context), {
            port: 0, sourcePolicy: "copilot-only", collector: { timers: false },
            async createAccess() { return access = await createCopilotRuntimeAccess(app.context); },
        });
        const origin = new URL(runtime.url).origin;
        let capability;
        const post = async (route, input) => {
            const response = await fetch(origin + route, { method: "POST",
                headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
                    ...(capability ? { "X-Board-Capability": capability } : {}) },
                body: JSON.stringify(input) });
            return { status: response.status, body: await response.json() };
        };
        capability = (await post("/api/session", {})).body.capability;
        const canvas = (action, input = {}) => post("/api/canvas", { action, input });
        assert.notEqual((await canvas("collect_now")).status, 200);
        await assert.rejects(readFile(configFile), { code: "ENOENT" });
        assert.notEqual((await canvas("configure_collection", { surfaces: ["chat"], windowDays: 30 })).status, 200);
        await assert.rejects(readFile(configFile), { code: "ENOENT" });
        assert.equal((await canvas("configure_collection", {
            appDbPath: app.config.appDbPath, sessionRoot: app.config.sessionRoot,
            approved: true, enabled: false, windowDays: 30, pollSeconds: 5, expectedConfigVersion: null,
        })).status, 200);
        const approved = await readFile(configFile);
        await app.append(interaction("approved-canvas-manual"));
        assert.equal((await canvas("collect_now")).status, 200);
        assert.equal((await loadBoardState(app.context)).evidence.some(record => JSON.stringify(record).includes("approved-canvas-manual")), true);
        assert.deepEqual(await readFile(configFile), approved);
        assert.equal(JSON.parse(approved).enabled, false);
    } finally {
        await runtime?.close();
        await access?.close();
    }
});

test("approved GitHub timer keeps collecting while a scheduled Microsoft source read is waiting", { timeout: 15000 }, async t => {
    const app = await fixture(t, { startCollector: false });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), completed = Promise.withResolvers();
    const envelopes = [...chatFixture(), ...coworkFixture()], account = envelopes[0].scope.account;
    let runtime, access, persistence, lifecycle;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const transport = createMicrosoftNativeReadTransport({
            async open() {},
            async verifyAccount() { return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } }; },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        lifecycle = await createMicrosoftSession(app.context, { transport, sourceAware: true, globalCollection: null,
            collection: { paused: true, windowDays: 30 },
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
        persistence = await createNativePersistence(app.context, { lifecycle, transport, configurationIntents: true, preAccount: "metadata-only" });
        access = await createNativeRuntimeAccess(app.context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, nativeScheduling: true,
            async acquireNative() { entered.resolve(); await release.promise; return envelopes; },
            completeNative(_ticket, receipt) { completed.resolve(receipt); },
        });
        runtime = await startServer(app.context, createExportController(app.context), { port: 0, access, collector: { timers: true } });
        for (const action of ["wire-sign-in", "microsoft-connect"]) {
            await lifecycle.command(owner, { action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
                ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
        }
        const admission = { owner, check() {}, dispatched() {} }, offer = await access.nativeConfigurationOffer(admission);
        await access.configureNativeIntent({ schemaVersion: 2, intent: offer.intent, generation: offer.generation,
            authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
            expectedRevision: offer.expectedRevision, surfaces: ["chat", "cowork"], windowDays: 30 }, admission);
        t.mock.timers.tick(0);
        await entered.promise;
        await app.append(interaction("during-microsoft-read"));
        t.mock.timers.tick(5000);
        const deadline = Date.now() + 2000;
        let current;
        do {
            current = await loadBoardState(app.context);
            if (current.evidence?.some(row => JSON.stringify(row).includes("during-microsoft-read"))) break;
            await setImmediate();
        } while (Date.now() < deadline);
        assert.ok(current.evidence?.some(row => JSON.stringify(row).includes("during-microsoft-read")),
            "Provider waiting must not clear the approved GitHub timer for the entire native operation.");
        release.resolve();
        assert.equal((await completed.promise).status, "committed");
        const saved = await loadBoardState(app.context);
        assert.ok(saved.evidence.some(row => JSON.stringify(row).includes("during-microsoft-read")));
        assert.equal(saved.nativeRetention.partitions.length, 1);
        assert.deepEqual(JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "config.json"), "utf8")), app.config);
    } finally {
        release.resolve();
        await runtime?.close(); access?.close(); persistence?.close(); await lifecycle?.close();
    }
});

test("GitHub Refresh refuses a queued captured config change before reading source and keeps manual Pause semantics", async t => {
    const app = await fixture(t, { sourceAware: true, signedIn: true, enabled: false,
        globalCollection: { revision: 1, paused: true } });
    const http = await app.http(), capability = await http.panel();
    const status = (await http.api(capability, "/api/collection/status", {})).body;
    const expectedBasis = { generation: (await app.lifecycle.status()).generation, configVersion: status.configVersion };
    await app.append(interaction("captured-scope"));
    assert.equal((await http.api(capability, "/api/collection/configure", {
        appDbPath: app.config.appDbPath, sessionRoot: app.config.sessionRoot, approved: true, enabled: false,
        windowDays: 7, pollSeconds: 5, expectedConfigVersion: status.configVersion,
    })).code, 200);
    const before = await loadBoardState(app.context);
    const refused = await http.api(capability, "/api/collection/now", { expectedBasis });
    assert.equal(refused.code, 409);
    assert.equal(refused.body.code, "COLLECTION_EXPECTED_BASIS_CHANGED");
    assert.equal(refused.body.outcome, undefined);
    assert.deepEqual((await loadBoardState(app.context)).evidence, before.evidence);
    const current = (await http.api(capability, "/api/collection/status", {})).body;
    const fresh = { generation: (await app.lifecycle.status()).generation, configVersion: current.configVersion };
    assert.equal((await http.api(capability, "/api/collection/now", { expectedBasis: { ...fresh, generation: fresh.generation + 1 } })).code, 409);
    assert.equal((await http.api(capability, "/api/collection/now", { expectedBasis: { ...fresh, windowDays: 90 } })).code, 422);
    const result = await http.api(capability, "/api/collection/now", { expectedBasis: fresh });
    assert.equal(result.code, 200);
    assert.ok((await loadBoardState(app.context)).evidence.some(row => JSON.stringify(row).includes("captured-scope")));
    assert.equal((await app.lifecycle.globalCollectionStatus()).globalCollection.paused, true);
    assert.equal((await app.collector.status()).config.enabled, false);
    assert.equal((await app.collector.status()).config.windowDays, 7);
    assert.equal((await http.api(capability, "/api/collection/now", {})).code, 200);
});

test("a captured GitHub check revalidates after queued configuration and cannot join an unguarded pending check", async t => {
    const app = await fixture(t, { sourceAware: true, signedIn: true, enabled: false });
    const expectedBasis = { generation: (await app.lifecycle.status()).generation, configVersion: (await app.collector.status()).configVersion };
    const request = { owner, check() {}, dispatched() {} }, wait = Promise.withResolvers(), started = Promise.withResolvers();
    const blocking = app.collector.exclusiveActivity(async () => { started.resolve(); await wait.promise; });
    await started.promise;
    const settings = app.collector.configure({
        appDbPath: app.config.appDbPath, sessionRoot: app.config.sessionRoot, approved: true, enabled: false,
        windowDays: 7, pollSeconds: 5, expectedConfigVersion: expectedBasis.configVersion,
    }, request);
    const refresh = app.collector.collectNow(request, expectedBasis);
    const refusal = assert.rejects(refresh, { code: "COLLECTION_EXPECTED_BASIS_CHANGED" });
    wait.resolve();
    await blocking; await settings; await refusal;
    const current = { generation: (await app.lifecycle.status()).generation, configVersion: (await app.collector.status()).configVersion };
    const barrier = Promise.withResolvers(), active = Promise.withResolvers();
    const holding = app.collector.exclusiveActivity(async () => { active.resolve(); await barrier.promise; });
    await active.promise;
    const legacy = app.collector.collectNow(request);
    try {
        assert.throws(() => app.collector.collectNow(request, current), { code: "COLLECTION_EXPECTED_BASIS_CHANGED" });
    } finally { barrier.resolve(); }
    await holding; await legacy;
});
test("source-aware GitHub manual collection preserves paused global policy and disabled interval preference", async t => {
    const app = await fixture(t, { enabled: false, signedIn: true, sourceAware: true,
        globalCollection: { revision: 2, paused: true } });
    await app.append(interaction("source-aware-manual"));
    const before = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const result = await app.collector.collectNow({ owner, check() {}, dispatched() {} });
    assert.equal(result.lastCheck.schemaVersion, 2);
    assert.equal(result.lastCheck.outcome, "complete");
    assert.equal(result.lastCheck.changes.added, 1);
    assert.equal(result.config.enabled, false);
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), before);
    assert.deepEqual((await app.lifecycle.globalCollectionStatus()).globalCollection, { revision: 2, paused: true });
    assert.equal(app.access.collectionAvailable(), false);
    assert.equal(app.access.manualCollectionAvailable(), true);
});

test("source-aware GitHub settings may enable an interval preference without resuming the global gate or acquiring", async t => {
    const app = await fixture(t, { enabled: false, signedIn: true, sourceAware: true,
        globalCollection: { revision: 2, paused: true } });
    await app.append(interaction("must-not-auto-acquire"));
    const before = await app.collector.status();
    const { schemaVersion, ...settings } = app.config;
    const result = await app.collector.configure({ ...settings, enabled: true, windowDays: 90,
        expectedConfigVersion: before.configVersion }, { owner, check() {}, dispatched() {} });
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.windowDays, 90);
    assert.equal(result.config.pollSeconds, app.config.pollSeconds);
    assert.equal(result.lastCheck, before.lastCheck);
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual((await app.lifecycle.globalCollectionStatus()).globalCollection, { revision: 2, paused: true });
    assert.equal(app.access.collectionAvailable(), false);
});

test("source-aware generic collection routes retain their GitHub meaning instead of native-control hijacking", async t => {
    const app = await fixture(t, { enabled: false, signedIn: true, sourceAware: true,
        globalCollection: { revision: 2, paused: true } });
    const http = await app.http(), panel = await http.panel();
    const before = await http.api(panel, "/api/collection/status", {});
    assert.equal(before.code, 200);
    assert.equal(before.body.nativeControl, undefined);
    assert.equal(before.body.nativePersistence, undefined);
    assert.equal((await http.api(panel, "/api/collection/status", { operationId: randomUUID() })).code, 400);
    const unavailable = await http.api(panel, "/api/collection/sources/status", {});
    assert.equal(unavailable.code, 503, "An unattached shared status module cannot become a legacy fallback.");
    assert.equal(unavailable.body.kind, undefined);
    const changed = await http.api(panel, "/api/collection/enabled", {
        enabled: true, expectedConfigVersion: before.body.configVersion,
    });
    assert.equal(changed.code, 200);
    assert.equal(changed.body.config.enabled, true);
    assert.deepEqual((await app.lifecycle.globalCollectionStatus()).globalCollection, { revision: 2, paused: true });
    await app.append(interaction("explicit-http-manual"));
    const collected = await http.api(panel, "/api/collection/now", {});
    assert.equal(collected.code, 200);
    assert.equal(collected.body.lastCheck.schemaVersion, 2);
    assert.equal(collected.body.lastCheck.changes.added, 1);
    assert.equal(collected.body.nativePersistenceReceipt, undefined);
});

async function enableReplies(app) {
    const state = await loadBoardState(app.context), source = app.collector.assessmentSource(state);
    await executeAssessmentAction(app.context, owner, "set_assessment_consent", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: 0,
        policyVersion: 1, enabled: true, categories: ["answer"], confirmed: true,
        sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
    }, { source: value => app.collector.assessmentSource(value) });
}
function interceptRenames(t, work) {
    const rename = fs.rename;
    t.mock.method(fs, "rename", (from, to) => work(from, to, () => rename(from, to)));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function checkpoint(app) {
    const root = path.join(app.context.dataDir, "collector");
    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
    return {
        index, cursorFile: path.join(root, index.fingerprint, app.sourceId + ".json"),
        bytes: await readFile(path.join(root, index.fingerprint, app.sourceId + ".json"), "utf8"),
        lastCheck: await readFile(path.join(root, "last-check.json"), "utf8"),
    };
}

async function legacyIndex(app) {
    const value = { schemaVersion: 1, sources: {}, metrics: { totalBytesRead: 123, cycles: 7 },
        lastCheckedAt: "2026-10-01T00:00:00Z", lastNewDataAt: null };
    const file = path.join(app.context.dataDir, "collector", "index.json");
    await writeFile(file, JSON.stringify(value));
    await app.restart();
    return { file, value };
}
async function ownedBarrier(index) {
    const { platform, machine } = await collectorHostIdentity();
    return { ...index, schemaVersion: 3, boundedHistoryVersion: 1, ownerHost: { platform, machine } };
}

for (const point of ["barrier-fsync", "barrier-rename", "checkpoint-rename", "final-index-rename"]) {
    test(`owned index barrier survives ${point} failure without exposing prospective progress ahead of evidence`, async t => {
        const app = await fixture(t, { signedIn: true }), legacy = await legacyIndex(app);
        await app.append(interaction("barrier-call"));
        const diagnostics = [];
        t.mock.method(console, "error", (...args) => {
            if (args[0] === "[workiq-collector] collection failed") diagnostics.push(args[1]);
        });
        let fail = true, indexWrites = 0, observedBarrier;
        const originalOpen = fs.open, originalRename = fs.rename;
        t.mock.method(fs, "open", async (file, ...args) => {
            const handle = await originalOpen(file, ...args);
            if (point === "barrier-fsync" && String(file).startsWith(legacy.file + ".") && String(file).endsWith(".tmp")) {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => {
                    await sync();
                    if (fail) throw Object.assign(new Error("Synthetic barrier fsync failure"), { code: "EIO" });
                };
            }
            return handle;
        });
        t.mock.method(fs, "rename", async (from, to) => {
            if (to === legacy.file) {
                indexWrites++;
                if (indexWrites === 1) {
                    observedBarrier = JSON.parse(await readFile(from, "utf8"));
                    assert.deepEqual(observedBarrier, await ownedBarrier(legacy.value));
                    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
                }
                if (point === "final-index-rename" && indexWrites === 2 && fail) {
                    throw Object.assign(new Error("Synthetic final index failure"), { code: "EIO" });
                }
            }
            if (point === "checkpoint-rename" && path.basename(to) === app.sourceId + ".json" && fail) {
                assert.equal((await loadBoardState(app.context)).evidence.length, 1);
                throw Object.assign(new Error("Synthetic checkpoint failure"), { code: "EIO" });
            }
            await originalRename(from, to);
            if (point === "barrier-rename" && to === legacy.file && indexWrites === 1 && fail) {
                throw Object.assign(new Error("Synthetic uncertain barrier result"), { code: "EIO" });
            }
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        await assert.rejects(app.collector.collectNow(), { code: "wire_access_admission_failed" });
        assert.deepEqual(diagnostics[0].causeCodes, ["EIO"], "Admission translation must not erase the private I/O cause.");
        assert.equal(diagnostics[0].stage, point.startsWith("barrier") ? "index-barrier"
            : point === "checkpoint-rename" ? "checkpoint" : "index");
        const durable = JSON.parse(await readFile(legacy.file));
        assert.deepEqual(durable, point === "barrier-fsync" ? legacy.value
            : await ownedBarrier(legacy.value));
        assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0,
            ["checkpoint-rename", "final-index-rename"].includes(point) ? 1 : 0);
        fail = false;
        t.mock.restoreAll(); syncBuiltinESMExports();
        await app.restart();
        const recovered = await app.collector.collectNow();
        assert.equal(recovered.config.schemaVersion, 1);
        const after = await checkpoint(app);
        assert.equal(after.index.schemaVersion, 3);
        assert.equal(after.index.boundedHistoryVersion, 1);
        assert.equal(after.index.sources[app.sourceId].cursor.offset, (await readFile(app.sourceFile)).length);
        assert.equal((await loadBoardState(app.context)).evidence.length, 1);
        await app.collector.collectNow();
        assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    });
}

for (const point of ["barrier", "checkpoint", "recovery-evidence"]) {
    test(`real original-panel expiry after ${point} fsync fences rename and preserves unknown-outcome handling`, async t => {
        let now = Date.now();
        t.mock.method(Date, "now", () => now);
        const app = await fixture(t), legacy = await legacyIndex(app);
        const http = await app.http({ sessionTtlMs: 1000 }), panel = await http.panel();
        await http.command(panel, "wire-sign-in");
        const events = interaction("expiry-at-fsync");
        if (point === "recovery-evidence") events[2].data.result = { content: "x".repeat(2 * 1024 ** 2) };
        await app.append(events);
        const original = fs.open;
        let expired = false;
        t.mock.method(fs, "open", async (file, ...args) => {
            const handle = await original(file, ...args);
            const target = point === "barrier" ? String(file).startsWith(legacy.file + ".")
                : point === "recovery-evidence" ? path.dirname(String(file)) === app.context.dataDir && path.basename(String(file)).startsWith(".state-")
                    : path.basename(String(file)).startsWith(app.sourceId + ".json.");
            if (target && String(file).endsWith(".tmp")) {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => { await sync(); if (!expired) { now += 1001; expired = true; } };
            }
            return handle;
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        let requests = 0;
        const observe = req => { if (req.method === "POST" && req.url === "/api/collection/now") requests++; };
        http.runtime.server.on("request", observe);
        t.after(() => http.runtime.server.off("request", observe));
        const response = await http.api(panel, "/api/collection/now", {});
        assert.equal(expired, true);
        assert.equal(response.code, 409);
        assert.equal(response.body.outcome, "unknown");
        assert.equal(requests, 1, "No lost/expired mutation is automatically replayed");
        const durable = JSON.parse(await readFile(legacy.file));
        assert.deepEqual(durable, point === "barrier" ? legacy.value
            : await ownedBarrier(legacy.value));
        assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, point === "checkpoint" ? 1 : 0);
        await assert.rejects(readFile(path.join(path.dirname(legacy.file), "last-check.json")), { code: "ENOENT" });
    });
}

test("barrier-only restart accepts existing schema1 event checkpoints without changing config or receipts", async t => {
    const app = await fixture(t, { signedIn: true });
    await app.append(interaction("legacy-prior"));
    await app.collector.collectNow();
    const before = await checkpoint(app), legacy = { ...before.index, schemaVersion: 1 };
    delete legacy.boundedHistoryVersion;
    const root = path.join(app.context.dataDir, "collector"), indexFile = path.join(root, "index.json");
    await writeFile(indexFile, JSON.stringify(legacy));
    await app.restart();
    const configBefore = await readFile(path.join(root, "config.json"));
    await app.append(interaction("after-barrier"));
    let fail = true;
    interceptRenames(t, async (from, to, rename) => {
        if (to === indexFile && fail) {
            const barrier = JSON.parse(await readFile(from));
            assert.deepEqual(barrier, await ownedBarrier(legacy));
            await rename();
            throw Object.assign(new Error("Synthetic barrier-only restart"), { code: "EIO" });
        }
        await rename();
    });
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_admission_failed" });
    assert.equal(await readFile(before.cursorFile, "utf8"), before.bytes);
    assert.equal(await readFile(path.join(root, "last-check.json"), "utf8"), before.lastCheck);
    assert.deepEqual(await readFile(path.join(root, "config.json")), configBefore);
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    fail = false;
    await app.restart();
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 2);
    assert.equal(JSON.parse((await checkpoint(app)).bytes).schemaVersion, 1);
    await app.collector.setEnabled(false);
    assert.equal(JSON.parse(await readFile(indexFile)).schemaVersion, 3);
    await app.collector.setEnabled(true);
    await app.collector.collectNow();
    assert.equal(JSON.parse(await readFile(indexFile)).schemaVersion, 3);
    assert.equal((await loadBoardState(app.context)).evidence.length, 2);
});

async function bounded(work) {
    let timer;
    try {
        return await Promise.race([work, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Owned fixture operation did not settle; possible lock-order cycle.")), 5000);
        })]);
    } finally { clearTimeout(timer); }
}

async function prepareMutation(app, http, panel, kind) {
    if (kind === "consent") {
        const state = await loadBoardState(app.context), source = app.collector.assessmentSource(state);
        return { route: "/api/assessment/consent/set", input: {
            schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
            expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: state.personalEvaluation?.consent?.revision ?? 0,
            policyVersion: 1, enabled: true, categories: ["answer"], confirmed: true,
            sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
        } };
    }
    if (kind === "artifact") {
        const prepared = await http.api(panel, "/api/preview", { options: { formats: ["html"] },
            selection: { kind: "all", revision: (await loadBoardState(app.context)).revision } });
        assert.equal(prepared.code, 200);
        assert.equal((await http.api(panel, "/api/privacy-review", { previewId: prepared.body.previewId, disclosureReviewed: true })).code, 200);
        const saved = await http.api(panel, "/api/export", { previewId: prepared.body.previewId, confirmed: true });
        assert.equal(saved.code, 200);
        const preview = await http.api(panel, "/api/artifact-deletion/preview", { artifactKind: "report", artifactId: saved.body.bundle.bundleId });
        assert.equal(preview.code, 200);
        return { route: "/api/artifact-deletion/confirm", input: { operationId: preview.body.operationId, confirmed: true },
            receiptToken: preview.body.receiptToken };
    }
    const preview = await http.api(panel, "/api/deletion/preview", { scope: "all" });
    assert.equal(preview.code, 200);
    return { route: "/api/deletion/confirm", input: { operationId: preview.body.operationId, confirmed: true } };
}

test("an explicit source-aware runtime binds its ordinary GitHub collector without a second access option", async t => {
    const app = await fixture(t, { enabled: false, signedIn: true, sourceAware: true,
        globalCollection: { revision: 2, paused: true } });
    const http = await app.http({ collector: { timers: false } }), panel = await http.panel();
    await app.append(interaction("source-host-bound-manual"));
    const before = await readFile(path.join(app.context.dataDir, "collector", "config.json"));
    const result = await http.api(panel, "/api/collection/now", {});
    assert.equal(result.code, 200);
    assert.equal(result.body.lastCheck.changes.added, 1);
    assert.equal(result.body.config.enabled, false);
    assert.deepEqual(await readFile(path.join(app.context.dataDir, "collector", "config.json")), before);
    assert.deepEqual((await app.lifecycle.globalCollectionStatus()).globalCollection, { revision: 2, paused: true });
    await http.command(panel, "wire-sign-out");
    await app.append(interaction("signed-out-must-not-collect"));
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 403);
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

test("opt-in collector denies source acquisition and checkpoint publication while WIRE is signed out", async t => {
    const app = await fixture(t);
    await app.append(interaction("blocked"));
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual(await readdir(path.join(app.context.dataDir, "collector")), ["config.json"]);
});

for (const invalidation of ["signout", "source-change", "record-revision"]) test(`${invalidation} after actual bounded recovery reading rejects stale publication`, async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    const events = interaction("stale");
    events[2].data.result = { content: "x".repeat(2 * 1024 ** 2) };
    await app.append(events);
    const original = await readFile(app.sourceFile);
    app.interceptCommit(async () => {
        if (invalidation === "signout") await app.command("wire-sign-out");
        else if (invalidation === "source-change") await app.append([event("assistant.message", { content: "Concurrent invented source append" })]);
        else await exclusiveBoard(app.context, async (current, save) => { current.revision++; await save(current); });
    });
    await assert.rejects(app.collector.collectNow(), { code: invalidation === "signout" ? "wire_access_revoked"
        : invalidation === "source-change" ? "COLLECTION_SOURCE_CHANGED" : "wire_access_admission_failed" });
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual((await readdir(path.join(app.context.dataDir, "collector"))).sort(),
        invalidation === "record-revision" ? ["config.json", "index.json"] : ["config.json"]);
    assert.deepEqual((await readFile(app.sourceFile)).subarray(0, original.length), original);
});

test("signout after fresh original completion lookbehind rejects publication without advancing its checkpoint", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    const events = interaction("lookbehind-revoked"), completion = events.pop();
    completion.data.result = { content: "EXCLUDED_LOOKBEHIND_BODY_" + "x".repeat(1100000) };
    await app.append(events);
    await app.collector.collectNow();
    const before = await loadBoardState(app.context);
    assert.equal(before.evidence[0].toolCalls[0].reportedOutcome, "unknown");
    const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json")));
    const checkpointFile = path.join(app.context.dataDir, "collector", index.fingerprint, `${app.sourceId}.json`);
    const checkpoint = await readFile(checkpointFile);
    await app.append([completion]);
    let opens = 0;
    const originalOpen = fs.open;
    const opening = t.mock.method(fs, "open", (...args) => {
        if (args[0] === app.sourceFile) opens++;
        return originalOpen(...args);
    });
    syncBuiltinESMExports();
    app.interceptCommit(async () => {
        assert.ok(opens >= 3, "The initial completion read and fresh lookbehind must precede revocation");
        await app.command("wire-sign-out");
    });
    try {
        await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
        assert.deepEqual((await loadBoardState(app.context)).evidence, before.evidence);
        assert.deepEqual(await readFile(checkpointFile), checkpoint);
    } finally { opening.mock.restore(); syncBuiltinESMExports(); }
});

test("existing deletion coordination waits for acquisition and prevents deleted records and replies from resurrecting", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    const recovered = interaction("deleted");
    recovered[2].data.result = { content: "x".repeat(2 * 1024 ** 2) };
    await app.append(recovered);
    await app.collector.collectNow();
    await enableReplies(app);
    await app.append([event("assistant.message", { content: "INVENTED_DELETED_REPLY" }, "deleted-reply")]);
    await app.collector.collectNow();
    const deletion = createDeletionController(app.context, { selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup });
    const preview = await deletion.preview(owner, { scope: "all" });
    await app.append(interaction("later-deleted"));
    let deleting;
    app.interceptCommit(() => {
        deleting = deletion.confirm(owner, { operationId: preview.operationId, confirmed: true });
        deleting.catch(() => {});
    });
    await app.collector.collectNow();
    await assert.rejects(deleting, { status: 409 });
    app.interceptCommit(null);
    const fresh = await deletion.preview(owner, { scope: "all" });
    const result = await deletion.confirm(owner, { operationId: fresh.operationId, confirmed: true });
    assert.equal(result.phase, "complete");
    assert.equal((await loadBoardState(app.context)).evidence.length, 0);
    await app.append([...interaction("deleted"),
        event("assistant.message", { content: "INVENTED_DELETED_REPLY" }, "deleted-reply"), ...interaction("new")]);
    await app.collector.collectNow();
    const state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].toolCalls[0].toolCallId, "new");
    assert.equal(state.personalEvaluation.captures.length, 0);
    assert.equal((await app.lifecycle.status()).authorization.retained, true);
    assert.equal((await app.collector.status()).config.enabled, true);
});

test("committed collector Pause and Resume own lifecycle acquisition without hiding retained evidence", async t => {
    const app = await fixture(t, { enabled: false });
    await app.command("wire-sign-in");
    await app.append(interaction("pause"));
    assert.equal((await app.lifecycle.status()).collection, "paused");
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    await app.collector.setEnabled(true);
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    await app.collector.setEnabled(false);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await app.lifecycle.status()).authorization.retained, true);
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

test("Pause requested during source reading invalidates that cycle before its real commit", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("pause-race"));
    let pause;
    app.interceptCommit(() => { pause = app.collector.setEnabled(false); });
    await assert.rejects(app.collector.collectNow(), { code: "collection_acquisition_superseded" });
    await pause;
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual(await readdir(path.join(app.context.dataDir, "collector")), ["config.json"]);
});

test("configuration change supersedes an old source cycle and commits shared settings before new acquisition", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("configuration"));
    const { schemaVersion, ...input } = app.config;
    let change;
    app.interceptCommit(() => {
        change = app.collector.configure({ ...input, enabled: false, windowDays: 7 });
        change.catch(() => {});
    });

    await assert.rejects(app.collector.collectNow(), { code: "collection_acquisition_superseded" });
    await change;
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.equal((await app.collector.status()).config.windowDays, 7);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    app.interceptCommit(null);
    await app.collector.setEnabled(true);
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

test("explicit joined fixture binding uses the existing HTTP collection and Pause paths", async t => {
    const app = await fixture(t), http = await app.http(), panel = await http.panel();
    await http.command(panel, "wire-sign-in");
    await app.append(interaction("http"));
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    assert.equal((await http.api(panel, "/api/collection/enabled", { enabled: false })).code, 200);
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 403);
    assert.equal((await http.api(panel, "/api/state")).body.scenarios.length, 1);
    assert.equal((await http.api(panel, "/api/canvas", { action: "set_collection_enabled", input: { enabled: true } })).code, 200);
    assert.equal((await http.api(panel, "/api/canvas", { action: "collect_now", input: {} })).code, 200);
    const { schemaVersion, ...input } = app.config;
    assert.equal((await http.api(panel, "/api/canvas", {
        action: "configure_collection", input: { ...input, enabled: false, windowDays: 7 },
    })).code, 200);
    assert.equal((await app.lifecycle.status()).collection, "paused");
});

test("protected deletion fails closed when its backend per-call admission callback is missing", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("admission-required"));
    await app.collector.collectNow();
    const deletion = createDeletionController(app.context, { requireAdmission: true });
    const preview = await deletion.preview(owner, { scope: "all" });
    const before = await loadBoardState(app.context);
    await assert.rejects(deletion.confirm(owner, { operationId: preview.operationId, confirmed: true }),
        { code: "mutation_admission_required" });
    await assert.rejects(deletion.confirmArtifact(owner, { operationId: preview.operationId, confirmed: true }),
        { code: "mutation_admission_required" });
    assert.deepEqual(await loadBoardState(app.context), before);
});

test("one actual admission orders evidence, consented reply and checkpoints before signout can finish", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("baseline"));
    await app.collector.collectNow();
    await enableReplies(app);
    await app.append([...interaction("atomic"), event("assistant.message", { content: "INVENTED_ATOMIC_REPLY" }, "reply-atomic")]);
    const source = await readFile(app.sourceFile), before = await checkpoint(app);
    const generation = (await app.lifecycle.status()).generation;
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const writes = [];
    let held = false, signoutComplete = false;
    interceptRenames(t, async (from, to, rename) => {
        await rename(); writes.push(to);
        if (!held && path.dirname(to) === app.context.dataDir && to.endsWith(".state.json")) {
            held = true; entered.resolve(); await resume.promise;
        }
    });
    const collecting = app.collector.collectNow();
    await entered.promise;
    const signingOut = app.lifecycle.command(owner, { action: "wire-sign-out", operationId: randomUUID(), generation }, () => true)
        .then(value => { signoutComplete = true; return value; });
    try {
        await setImmediate();
        assert.equal(signoutComplete, false);
        assert.equal(await readFile(before.cursorFile, "utf8"), before.bytes, "Cursor cannot advance ahead of the retained reply.");
    } finally { resume.resolve(); }
    await collecting; await signingOut;
    const after = await checkpoint(app), state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 2);
    assert.equal(state.personalEvaluation.captures.length, 1);
    const capture = state.personalEvaluation.captures[0];
    assert.equal(JSON.parse(await readFile(path.join(app.context.dataDir, "assessment-evidence", capture.payloadFile), "utf8")).text, "INVENTED_ATOMIC_REPLY");
    const stateWrites = writes.map((file, index) => file.endsWith(".state.json") ? index : -1).filter(index => index >= 0);
    assert.equal(stateWrites.length, 2);
    assert.ok(stateWrites[1] < writes.indexOf(after.cursorFile));
    assert.ok(writes.indexOf(after.cursorFile) < writes.indexOf(path.join(app.context.dataDir, "collector", "index.json")));
    assert.equal(JSON.parse(after.bytes).cursor.offset, source.length);
    assert.deepEqual(await readFile(app.sourceFile), source);
    await app.restart();
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    await app.command("wire-sign-in");
    await app.collector.collectNow();
    const recovered = await loadBoardState(app.context);
    assert.equal(recovered.evidence.length, 2);
    assert.equal(recovered.personalEvaluation.captures.length, 1);
});

test("the existing scheduler sleeps behind WIRE and Pause gates and resumes only authorized fixture reads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const app = await fixture(t, { timers: true });
    await app.append(interaction("scheduled"));
    t.mock.timers.tick(5000);
    await setImmediate();
    assert.equal((await app.collector.status()).error, null, "A closed gate is not a failed source poll.");
    await app.command("wire-sign-in");
    t.mock.timers.tick(5000);
    await waitForNativeRecords(app, ["scheduled"]);
    await app.collector.setEnabled(false);
    await app.append(interaction("resumed"));
    t.mock.timers.tick(5000); await setImmediate();
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    await app.collector.setEnabled(true);
    t.mock.timers.tick(5000);
    await waitForNativeRecords(app, ["scheduled", "resumed"]);
    await app.command("wire-sign-out");
    t.mock.timers.tick(5000); await setImmediate();
    assert.equal((await app.collector.status()).error, null);
    assert.equal((await loadBoardState(app.context)).evidence.length, 2);
});

test("failed reply publication cannot advance real checkpoints and restart safely replays only uncommitted source progress", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("prior"));
    await app.collector.collectNow();
    await enableReplies(app);
    const before = await checkpoint(app);
    await app.append([...interaction("retry"), event("assistant.message", { content: "INVENTED_RETRY_REPLY" }, "retry-reply")]);
    const original = await readFile(app.sourceFile);
    let stateWrites = 0, fail = true;
    interceptRenames(t, async (from, to, rename) => {
        if (path.dirname(to) === app.context.dataDir && to.endsWith(".state.json") && ++stateWrites === 2 && fail) {
            throw Object.assign(new Error("Invented reply-state publication failure"), { code: "EIO" });
        }
        await rename();
    });
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_admission_failed" });
    const interrupted = await loadBoardState(app.context);
    assert.equal(interrupted.evidence.length, 2, "Admission is ordering, not a rollback of already-written evidence.");
    assert.equal(interrupted.personalEvaluation.captures.length, 0);
    const failed = await checkpoint(app);
    assert.equal(failed.bytes, before.bytes);
    assert.deepEqual(failed.index, before.index);
    assert.equal(failed.lastCheck, before.lastCheck);
    fail = false;
    await app.restart();
    await app.collector.collectNow();
    await app.collector.collectNow();
    const recovered = await loadBoardState(app.context);
    assert.equal(recovered.evidence.length, 2);
    assert.equal(recovered.personalEvaluation.captures.length, 1);
    assert.equal(JSON.parse((await checkpoint(app)).bytes).cursor.offset, original.length);
    assert.deepEqual(await readFile(app.sourceFile), original);
});

test("natural Microsoft expiry fences an old GitHub cycle but permits fresh GitHub acquisition without reconnecting", async t => {
    const app = await fixture(t, { transport: {
        qualification: "synthetic-only-v1", open: async () => {},
        verify: async ({ expectedPartition }) => ({ partition: expectedPartition, chat: true, cowork: true }),
        stop: async () => ({ processExited: true, profileReleased: true }),
    } });
    await app.command("wire-sign-in");
    await app.lifecycle.command(owner, { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, expectedPartition: "a".repeat(64), replace: false }, () => true);
    const nativeLease = await app.lifecycle.lease("microsoft-read");
    await app.append(interaction("expiry"));
    app.interceptCommit(() => app.lifecycle.expire(nativeLease));
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual(await readdir(path.join(app.context.dataDir, "collector")), ["config.json"]);
    const status = await app.lifecycle.status();
    assert.equal(status.authorization.retained, true);
    assert.equal(status.authorization.githubAcquisition, true);
    assert.equal(status.authorization.microsoftAcquisition, false);
    app.interceptCommit(null);
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

test("fixture source ownership and unsupported joined entry points fail closed without changing preferences", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    const file = path.join(app.context.dataDir, "collector", "config.json"), before = await readFile(file);
    const { schemaVersion, ...input } = app.config;
    await assert.rejects(app.collector.configure({ ...input,
        appDbPath: path.join(app.root, "..", "not-owned", "data.db"),
        sessionRoot: path.join(app.root, "..", "not-owned", "session-state"),
    }), { code: "wire_access_fixture_source_required" });
    assert.deepEqual(await readFile(file), before);
    await assert.rejects(app.collector.qualifyInteractionModels({}), { code: "wire_access_writer_integration_pending" });
    await assert.rejects(app.collector.qualifyResponseTimings({}), { code: "wire_access_writer_integration_pending" });
    assert.throws(() => app.collector.approvedRecollectionSource(), { code: "wire_access_writer_integration_pending" });
    await assert.rejects(startServer(app.context, createExportController(app.context), {
        port: 0, collector: { timers: false, access: app.access },
    }), { code: "wire_access_writer_integration_pending" });
});

test("failed settings synchronization preserves committed preferences as an unknown outcome and blocks acquisition until recovery", async t => {
    const app = await fixture(t);
    await app.command("wire-sign-in");
    await app.append(interaction("settings-recovery"));
    app.interceptSettings(() => { throw new Error("Invented settings synchronization failure"); });
    await assert.rejects(app.collector.setEnabled(false), { status: 409, code: "collection_configuration_outcome_unknown" });
    const status = await app.collector.status();
    assert.equal(status.config.enabled, false);
    assert.match(status.error, /settings were saved/);
    assert.equal(JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "config.json"), "utf8")).enabled, false);
    await assert.rejects(app.collector.collectNow(), { status: 503 });
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    app.interceptSettings(null);
    await app.restart();
    assert.equal((await app.lifecycle.status()).collection, "paused");
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
    await app.collector.setEnabled(true);
    await app.collector.collectNow();
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

for (const kind of ["activity", "artifact", "consent"]) {
    test(`joined ${kind} waits outside lifecycle admission so signout can fence the pending collector`, async t => {
        const app = await fixture(t), http = await app.http(), a = await http.panel(), b = await http.panel(), c = await http.panel();
        await http.command(a, "wire-sign-in");
        await app.append(interaction("joined-base"));
        assert.equal((await http.api(a, "/api/collection/now", {})).code, 200);
        const mutation = await prepareMutation(app, http, b, kind);
        const before = await loadBoardState(app.context);
        await app.append(interaction("joined-stale"));
        const reading = Promise.withResolvers(), resume = Promise.withResolvers(), coordinating = Promise.withResolvers();
        app.interceptCommit(async () => { reading.resolve(); await resume.promise; });
        const recorder = http.runtime.recorderDiagnostics, original = recorder.exclusiveActivity.bind(recorder);
        t.mock.method(recorder, "exclusiveActivity", work => {
            const result = original(work); coordinating.resolve(); return result;
        });
        const collecting = http.api(a, "/api/collection/now", {});
        let pending;
        try {
            await bounded(reading.promise);
            pending = http.api(b, mutation.route, mutation.input);
            await bounded(coordinating.promise);
            assert.equal((await bounded(http.command(c, "wire-sign-out"))).code, 200);
        } finally { resume.resolve(); }
        assert.equal((await bounded(collecting)).code, 403);
        assert.equal((await bounded(pending)).code, 403);
        assert.deepEqual(await loadBoardState(app.context), before);
        app.interceptCommit(null);
    });
}

for (const kind of ["collection", "activity", "artifact", "consent"]) {
    for (const invalidation of ["release", "expiry"]) {
        test(`joined ${kind} rejects original-panel ${invalidation} after quiescence without dispatch or replay`, async t => {
            let now = Date.now();
            if (invalidation === "expiry") t.mock.method(Date, "now", () => now);
            const app = await fixture(t), http = await app.http({ sessionTtlMs: 1000 }), panel = await http.panel();
            await http.command(panel, "wire-sign-in");
            await app.append(interaction("waiting-base"));
            assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
            const mutation = kind === "collection" ? { route: "/api/collection/now", input: {} }
                : await prepareMutation(app, http, panel, kind);
            const before = await loadBoardState(app.context);
            await app.append(interaction("must-not-dispatch"));
            const lock = kind === "collection" ? app.collector : http.runtime.recorderDiagnostics;
            const occupied = Promise.withResolvers(), resume = Promise.withResolvers(), queued = Promise.withResolvers();
            const blocker = lock.exclusiveActivity(async () => { occupied.resolve(); await resume.promise; });
            await bounded(occupied.promise);
            const method = kind === "collection" ? "collectNow" : "exclusiveActivity", original = lock[method].bind(lock);
            t.mock.method(lock, method, (...args) => {
                const result = original(...args); queued.resolve(); return result;
            });
            let requests = 0;
            const observe = req => { if (req.method === "POST" && req.url === mutation.route) requests++; };
            http.runtime.server.on("request", observe);
            t.after(() => http.runtime.server.off("request", observe));
            const pending = http.api(panel, mutation.route, mutation.input);
            try {
                await bounded(queued.promise);
                if (invalidation === "release") assert.equal((await http.api(panel, "/api/session/release", {})).code, 200);
                else now += 1001;
            } finally { resume.resolve(); }
            await bounded(blocker);
            const rejected = await bounded(pending);
            assert.equal(rejected.code, 403);
            assert.equal(rejected.body.code, invalidation === "release" ? "wire_access_revoked" : "session_expired");
            assert.equal(rejected.body.outcome, undefined, "Quiescence waits are not write dispatch.");
            assert.equal(requests, 1);
            assert.deepEqual(await loadBoardState(app.context), before);
        });
    }
}

for (const setting of ["pause", "configuration"]) {
    test(`joined HTTP ${setting} supersedes source work before its real commit`, async t => {
        const app = await fixture(t), http = await app.http(), a = await http.panel(), b = await http.panel();
        await http.command(a, "wire-sign-in");
        await app.append(interaction("http-superseded"));
        const reading = Promise.withResolvers(), resume = Promise.withResolvers(), queued = Promise.withResolvers();
        app.interceptCommit(async () => { reading.resolve(); await resume.promise; });
        const method = setting === "pause" ? "setEnabled" : "configure", original = app.collector[method].bind(app.collector);
        t.mock.method(app.collector, method, (...args) => {
            const result = original(...args); queued.resolve(); return result;
        });
        const collecting = http.api(a, "/api/collection/now", {});
        let changing;
        try {
            await bounded(reading.promise);
            const { schemaVersion, ...input } = app.config;
            changing = setting === "pause" ? http.api(b, "/api/collection/enabled", { enabled: false })
                : http.api(b, "/api/collection/configure", { ...input, enabled: false, windowDays: 7 });
            await bounded(queued.promise);
        } finally { resume.resolve(); }
        const rejected = await bounded(collecting);
        assert.equal(rejected.body.code, "collection_acquisition_superseded");
        assert.equal(rejected.body.outcome, undefined);
        assert.equal((await bounded(changing)).code, 200);
        assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
        assert.equal((await app.lifecycle.status()).collection, "paused");
        if (setting === "configuration") assert.equal((await app.collector.status()).config.windowDays, 7);
        app.interceptCommit(null);
    });
}

test("joined HTTP reply-write failure remains outcome-unknown and resumes from unchanged checkpoints after restart", async t => {
    const app = await fixture(t);
    let http = await app.http(), panel = await http.panel();
    await http.command(panel, "wire-sign-in");
    await app.append(interaction("http-prior"));
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
    const consent = await prepareMutation(app, http, panel, "consent");
    assert.equal((await http.api(panel, consent.route, consent.input)).code, 200);
    const before = await checkpoint(app);
    await app.append([...interaction("http-retry"), event("assistant.message", { content: "INVENTED_HTTP_RETRY" }, "http-reply")]);
    let stateWrites = 0, fail = true;
    interceptRenames(t, async (from, to, rename) => {
        if (path.dirname(to) === app.context.dataDir && to.endsWith(".state.json") && ++stateWrites === 2 && fail) {
            throw Object.assign(new Error("Invented HTTP reply-state failure"), { code: "EIO" });
        }
        await rename();
    });
    let requests = 0;
    const originalServer = http.runtime.server;
    const observe = req => { if (req.method === "POST" && req.url === "/api/collection/now") requests++; };
    originalServer.on("request", observe);
    t.after(() => originalServer.off("request", observe));
    const failed = await http.api(panel, "/api/collection/now", {});
    assert.equal(failed.code, 409);
    assert.equal(failed.body.code, "wire_access_admission_failed");
    assert.equal(failed.body.outcome, "unknown");
    assert.equal(requests, 1);
    const interrupted = await loadBoardState(app.context);
    assert.equal(interrupted.evidence.length, 2);
    assert.equal(interrupted.personalEvaluation.captures.length, 0);
    assert.equal((await checkpoint(app)).bytes, before.bytes);
    fail = false;
    await app.restart();
    http = await app.http(); panel = await http.panel();
    http.runtime.server.on("request", observe);
    const replacementServer = http.runtime.server;
    t.after(() => replacementServer.off("request", observe));
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
    assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
    const recovered = await loadBoardState(app.context);
    assert.equal(recovered.evidence.length, 2);
    assert.equal(recovered.personalEvaluation.captures.length, 1);
    assert.equal(JSON.parse((await checkpoint(app)).bytes).cursor.offset, (await readFile(app.sourceFile)).length);
    assert.equal(requests, 3, "Only the failed cycle and two deliberate recovery polls were requested.");
});

test("joined consent, captured reply, artifact receipts and deletion retain their real writer ownership", async t => {
    const app = await fixture(t), http = await app.http(), a = await http.panel(), b = await http.panel();
    await http.command(a, "wire-sign-in");
    await app.append(interaction("http-policy"));
    assert.equal((await http.api(a, "/api/collection/now", {})).code, 200);
    const consent = await prepareMutation(app, http, b, "consent");
    const reading = Promise.withResolvers(), resume = Promise.withResolvers(), coordinating = Promise.withResolvers();
    app.interceptCommit(async () => { reading.resolve(); await resume.promise; });
    const recorder = http.runtime.recorderDiagnostics, original = recorder.exclusiveActivity.bind(recorder);
    t.mock.method(recorder, "exclusiveActivity", work => {
        const result = original(work); coordinating.resolve(); return result;
    });
    const collecting = http.api(a, "/api/collection/now", {});
    let approving;
    try {
        await bounded(reading.promise);
        approving = http.api(b, consent.route, consent.input);
        await bounded(coordinating.promise);
    } finally { resume.resolve(); }
    assert.equal((await bounded(collecting)).code, 200);
    assert.equal((await bounded(approving)).code, 200);
    app.interceptCommit(null);
    await app.append([event("assistant.message", { content: "INVENTED_HTTP_POLICY_REPLY" }, "http-policy-reply")]);
    assert.equal((await http.api(a, "/api/collection/now", {})).code, 200);
    assert.equal((await loadBoardState(app.context)).personalEvaluation.captures.length, 1);
    const artifact = await prepareMutation(app, http, b, "artifact");
    assert.equal((await http.api(b, artifact.route, artifact.input)).body.phase, "complete");
    assert.equal((await http.api(b, "/api/artifact-deletion/status", { operationId: artifact.input.operationId })).body.phase, "complete");
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    const deletion = await prepareMutation(app, http, b, "activity");
    assert.equal((await http.api(b, deletion.route, deletion.input)).body.phase, "complete");
    await app.append([...interaction("http-policy"),
        event("assistant.message", { content: "INVENTED_HTTP_POLICY_REPLY" }, "http-policy-reply"), ...interaction("http-new")]);
    assert.equal((await http.api(a, "/api/collection/now", {})).code, 200);
    const state = await loadBoardState(app.context);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].toolCalls[0].toolCallId, "http-new");
    assert.equal(state.personalEvaluation.captures.length, 0);
    assert.equal((await http.api(b, "/api/deletion/status", { operationId: deletion.input.operationId })).body.phase, "complete");
    for (const [route, input] of [
        ["/api/record", { confirmed: true, attemptId: randomUUID() }], ["/api/import", {}],
        ["/api/collection/models/qualify", {}], ["/api/assessment/response-timing/qualify", {}],
        ["/api/recollection/confirm", {}],
    ]) assert.equal((await http.api(a, route, input)).body.code, "wire_access_writer_integration_pending");
    assert.throws(() => app.collector.collectNow(), { code: "mutation_admission_required" });
    await assert.rejects(app.collector.configure({}), { code: "mutation_admission_required" });
    await assert.rejects(app.collector.setEnabled(false), { code: "mutation_admission_required" });
});

for (const kind of ["activity", "artifact"]) {
    test(`joined ${kind} sealed-cleanup failure preserves recovery across signed-out restart without mutation replay`, async t => {
        const app = await fixture(t);
        let http = await app.http({ deletion: { afterSeal() { throw new Error("Invented sealed cleanup failure"); } } });
        let panel = await http.panel();
        await http.command(panel, "wire-sign-in");
        await app.append(interaction("sealed"));
        assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
        const mutation = await prepareMutation(app, http, panel, kind);
        const failed = await http.api(panel, mutation.route, mutation.input);
        assert.equal(failed.body.outcome, "unknown");
        assert.equal(failed.body.code, "wire_access_admission_failed");
        const before = await exclusiveBoard(app.context, state => state.deletion.operations[mutation.input.operationId], { readOnly: true });
        assert.equal(before.phase, "pending");
        await http.command(panel, "wire-sign-out");
        await app.restart();
        http = await app.http(); panel = await http.panel();
        assert.equal((await http.api(panel, "/api/access/status")).body.wire, "signed-out");
        assert.equal((await http.api(panel, "/api/collection/now", {})).code, 403);
        await http.command(panel, "wire-sign-in");
        const receipt = await http.api(panel, kind === "artifact" ? "/api/artifact-deletion/status" : "/api/deletion/status", {
            operationId: mutation.input.operationId,
            ...(mutation.receiptToken ? { receiptToken: mutation.receiptToken } : {}),
        });
        assert.equal(receipt.body.phase, "complete");
        assert.equal((await http.api(panel, mutation.route, mutation.input)).code, 403);
        assert.equal((await http.api(panel, "/api/collection/now", {})).code, 200);
        assert.equal((await loadBoardState(app.context)).evidence.length, kind === "activity" ? 0 : 1);
    });
}

test("joined collection committed before signout keeps an uncertain response and recovers its check without repeating acquisition", async t => {
    const app = await fixture(t), http = await app.http(), a = await http.panel(), b = await http.panel();
    await http.command(a, "wire-sign-in");
    const recovered = interaction("committed-http");
    recovered[2].data.result = { content: "PRIVATE_OUTCOME_RESPONSE_" + "x".repeat(2 * 1024 ** 2) };
    await app.append(recovered);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const original = app.collector.status.bind(app.collector);
    t.mock.method(app.collector, "status", async (...args) => {
        const value = await original(...args); entered.resolve(); await resume.promise; return value;
    });
    let requests = 0;
    const observe = req => { if (req.method === "POST" && req.url === "/api/collection/now") requests++; };
    http.runtime.server.on("request", observe);
    t.after(() => http.runtime.server.off("request", observe));
    const pending = http.api(a, "/api/collection/now", {});
    let check;
    try {
        await bounded(entered.promise);
        check = JSON.parse((await checkpoint(app)).lastCheck);
        assert.equal((await loadBoardState(app.context)).evidence.length, 1);
        assert.equal((await loadBoardState(app.context)).evidence[0].toolCalls[0].reportedOutcome, "succeeded");
        assert.equal((await http.command(b, "wire-sign-out")).code, 200);
    } finally { resume.resolve(); }
    const result = await bounded(pending);
    assert.equal(result.code, 409);
    assert.equal(result.body.code, "wire_access_outcome_unknown");
    assert.equal(result.body.outcome, "unknown");
    assert.doesNotMatch(JSON.stringify(result.body), /committed-http/);
    await http.command(a, "wire-sign-in");
    const status = await http.api(a, "/api/collection/status", {});
    assert.equal(status.code, 200);
    assert.equal(status.body.lastCheck.id, check.id);
    assert.equal(requests, 1, "Reading the original check receipt cannot repeat acquisition.");
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
});

test("joined consent revocation waits in the common order and removes reply authority without reopening capture", async t => {
    const app = await fixture(t), http = await app.http(), a = await http.panel(), b = await http.panel();
    await http.command(a, "wire-sign-in");
    await app.append(interaction("revoke-policy"));
    await http.api(a, "/api/collection/now", {});
    const consent = await prepareMutation(app, http, b, "consent");
    assert.equal((await http.api(b, consent.route, consent.input)).code, 200);
    await app.append([event("assistant.message", { content: "INVENTED_BEFORE_REVOCATION" }, "revoke-old")]);
    await http.api(a, "/api/collection/now", {});
    const before = await loadBoardState(app.context);
    assert.equal(before.personalEvaluation.captures.length, 1);
    const revoke = { ...consent.input, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: before.evidenceRevision, expectedConsentRevision: before.personalEvaluation.consent.revision,
        enabled: false, categories: [] };
    const reading = Promise.withResolvers(), resume = Promise.withResolvers(), coordinating = Promise.withResolvers();
    app.interceptCommit(async () => { reading.resolve(); await resume.promise; });
    const original = http.runtime.recorderDiagnostics.exclusiveActivity.bind(http.runtime.recorderDiagnostics);
    t.mock.method(http.runtime.recorderDiagnostics, "exclusiveActivity", work => {
        const result = original(work); coordinating.resolve(); return result;
    });
    const collecting = http.api(a, "/api/collection/now", {});
    let revoking;
    try {
        await bounded(reading.promise);
        revoking = http.api(b, consent.route, revoke);
        await bounded(coordinating.promise);
    } finally { resume.resolve(); }
    assert.equal((await bounded(collecting)).code, 200);
    assert.equal((await bounded(revoking)).code, 200);
    app.interceptCommit(null);
    await app.append([event("assistant.message", { content: "INVENTED_AFTER_REVOCATION" }, "revoke-new")]);
    assert.equal((await http.api(a, "/api/collection/now", {})).code, 200);
    const after = await loadBoardState(app.context);
    assert.equal(after.personalEvaluation.consent.state, "revoked");
    assert.equal(after.personalEvaluation.captures.length, 0);
    assert.equal((await app.lifecycle.status()).authorization.retained, true);
});

const nativeWait = milliseconds => new Promise(resolve => nativeTimeout(resolve, milliseconds));
function shortenNativePolling(t) {
    // Keep real Timeout resources and inherited async context; change only the fixture cadence.
    t.mock.method(globalThis, "setTimeout", (work, delay, ...args) =>
        nativeTimeout(work, delay === 5000 ? 25 : delay, ...args));
}
async function waitForNativeRecords(app, expected) {
    const until = performance.now() + 5000;
    while (true) {
        const status = await app.collector.status(), state = await loadBoardState(app.context);
        assert.doesNotMatch(status.error ?? "", /wire_access_reentrant_call/, "A native timer must not run in a lifecycle callback's context.");
        const ids = (state.evidence ?? []).flatMap(record => record.toolCalls.map(call => call.toolCallId)).sort();
        if (JSON.stringify(ids) === JSON.stringify([...expected].sort()) && status.metrics.backlogBytes === 0) {
            try {
                // Observe committed files without a Windows read handle blocking their atomic rename.
                const committed = await app.collector.exclusiveActivity(async () => {
                    const root = path.join(app.context.dataDir, "collector");
                    const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
                    if (typeof index.fingerprint !== "string") return null;
                    const cursorFile = path.join(root, index.fingerprint, app.sourceId + ".json");
                    const cursor = await readFile(cursorFile, "utf8"), length = (await readFile(app.sourceFile)).length;
                    if (index.sources[app.sourceId]?.cursor?.offset === length && JSON.parse(cursor).cursor.offset === length) {
                        return { cursorFile, cursor };
                    }
                    return null;
                });
                if (committed) return committed;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        assert.ok(performance.now() < until, "Native scheduling must acquire and commit the expected actual fixture records.");
        await nativeWait(5);
    }
}

async function appendOmittedPrefix(app, id) {
    await app.append(interaction(id));
    const padding = await fs.open(app.sourceFile, "a");
    try {
        await padding.writeFile(`{"id":"churn-padding","type":"assistant.message","timestamp":"${new Date().toISOString()}","data":{"content":"`);
        const chunk = Buffer.alloc(1024 ** 2, 120);
        for (let offset = 0; offset < TAIL_LIMITS.initialFileBytes; offset += chunk.length) await padding.write(chunk);
        await padding.writeFile('"}}\n');
    } finally { await padding.close(); }
}

for (const churnPoint of ["board", "prefix", "unrelated-tail", "final-check"]) test(`automatic prefix publication persists across unrelated live changes at ${churnPoint}`, async t => {
    shortenNativePolling(t);
    const app = await fixture(t, { timers: true });
    await appendOmittedPrefix(app, "prefix-metadata-churn");
    const db = new DatabaseSync(app.config.appDbPath);
    db.exec("PRAGMA journal_mode=WAL");
    const unrelated = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(unrelated, "Unrelated archived fixture", "chat", "2026-01-01", "local");
    const unrelatedFile = path.join(app.config.sessionRoot, unrelated, "events.jsonl");
    await mkdir(path.dirname(unrelatedFile));
    await writeFile(unrelatedFile, lines([event("session.start", { sessionId: unrelated, version: 1 })]));
    const update = db.prepare("UPDATE sessions SET title=? WHERE id=?");
    const originalOpen = fs.open, failures = [];
    let changes = 0, finalCheckArmed = false;
    const originalStat = nativeFs.statSync;
    if (churnPoint === "final-check") t.mock.method(nativeFs, "statSync", (file, ...args) => {
        if (file === app.sourceFile && finalCheckArmed) {
            finalCheckArmed = false;
            update.run(`Unrelated final-check change ${++changes}`, unrelated);
        }
        return originalStat(file, ...args);
    });
    t.mock.method(console, "error", (...args) => {
        if (args[0] === "[workiq-collector] collection failed") failures.push(args[1]?.code);
    });
    t.mock.method(fs, "open", async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        const selected = churnPoint === "board" ? path.dirname(String(file)) === app.context.dataDir && path.basename(String(file)).startsWith(".state-")
            : String(file).includes(path.sep + BACKFILL_DIRECTORY + path.sep);
        if (selected && String(file).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                await sync();
                if (churnPoint === "final-check") { finalCheckArmed = true; return; }
                changes++;
                if (churnPoint === "unrelated-tail") await appendFile(unrelatedFile, lines(interaction(`unrelated-${changes}`)));
                else update.run(`Unrelated change ${changes}`, unrelated);
            };
        }
        return handle;
    });
    syncBuiltinESMExports();
    try {
        await app.command("wire-sign-in");
        const deadline = performance.now() + 5000;
        let status;
        do {
            await nativeWait(10);
            status = await app.collector.status();
            if (status.state !== "collecting" && status.backfill?.visitedSources === 1 || failures.length >= 2) break;
        } while (performance.now() < deadline);
        assert.ok(changes > 0, `The fixture must change unrelated live-WAL metadata at prefix publication; failures=${JSON.stringify(failures)}.`);
        assert.deepEqual([...failures], [], "Harmless metadata churn must not create unknown publication outcomes.");
        assert.equal(status.backfill?.visitedSources, 1, "The actual automatic prefix progress must be durable.");
        const prefix = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", BACKFILL_DIRECTORY, app.sourceId + ".json")));
        assert.equal(prefix.backfill.sources[0].phase, "visited");
        assert.equal((await loadBoardState(app.context)).evidence.length, 1);
        await app.restart();
        assert.equal((await app.collector.status()).backfill.visitedSources, 1);
        await app.append(interaction("after-prefix-churn"));
        await waitForNativeRecords(app, ["prefix-metadata-churn", "after-prefix-churn"]);
        assert.deepEqual([...failures], []);
    } finally {
        await app.collector.close();
        t.mock.restoreAll(); syncBuiltinESMExports();
        db.close();
    }
});

for (const change of ["selected-membership", "source-tail-growth", "source-identity", "unsettled-metadata"]) {
    test(`automatic prefix publication still refuses ${change} after fsync`, async t => {
        shortenNativePolling(t);
        const app = await fixture(t, { timers: true });
        await appendOmittedPrefix(app, "prefix-guard-refusal");
        const db = new DatabaseSync(app.config.appDbPath);
        db.exec("PRAGMA journal_mode=WAL");
        db.prepare("UPDATE sessions SET title=? WHERE id=?").run("Invented guarded prefix", app.sourceId);
        const originalOpen = fs.open, failures = [], diagnostics = [];
        let changed = false;
        let metadataChanges = 0;
        const originalStat = nativeFs.statSync;
        if (change === "unsettled-metadata") t.mock.method(nativeFs, "statSync", (file, ...args) => {
            if (file === app.sourceFile && changed) {
                db.prepare("UPDATE sessions SET title=? WHERE id=?").run(`Still changing ${++metadataChanges}`, app.sourceId);
            }
            return originalStat(file, ...args);
        });
        t.mock.method(console, "error", (...args) => {
            if (args[0] === "[workiq-collector] collection failed") {
                failures.push(args[1]?.code);
                diagnostics.push(args[1]);
            }
        });
        t.mock.method(fs, "open", async (file, ...args) => {
            const handle = await originalOpen(file, ...args);
            if (String(file).includes(path.sep + BACKFILL_DIRECTORY + path.sep) && String(file).endsWith(".tmp")) {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => {
                    await sync();
                    if (changed) return;
                    changed = true;
                    if (change === "unsettled-metadata") return;
                    if (change === "selected-membership") db.prepare("UPDATE sessions SET archived_at=? WHERE id=?")
                        .run(new Date().toISOString(), app.sourceId);
                    else if (change === "source-tail-growth") await app.append(interaction("later-source-tail"));
                    else {
                        await fs.rename(app.sourceFile, app.sourceFile + ".old");
                        await writeFile(app.sourceFile, lines([event("session.start", { sessionId: app.sourceId, version: 1 })]));
                    }
                };
            }
            return handle;
        });
        syncBuiltinESMExports();
        try {
            await app.command("wire-sign-in");
            const deadline = performance.now() + 5000;
            while (!failures.length && performance.now() < deadline) await nativeWait(5);
            assert.equal(changed, true, `The source change must reach the guarded prefix write; failures=${JSON.stringify(failures)}.`);
            assert.equal(failures[0], "wire_access_admission_failed");
            assert.deepEqual(diagnostics[0], {
                code: "wire_access_admission_failed", stage: "prefix",
                sourceChange: change === "selected-membership" ? "membership" : change === "source-tail-growth" ? "history-size"
                    : change === "unsettled-metadata" ? "metadata-stamp" : "history-identity",
                causeCodes: ["COLLECTION_SOURCE_CHANGED"],
            }, "Only fixed stage/reason and recognized codes may be logged, never source text, paths or stacks.");
            if (change === "unsettled-metadata") assert.ok(metadataChanges > 0 && metadataChanges <= 3,
                "Pre-write validation must be bounded, not an unlimited retry until success.");
            await app.collector.close();
            await assert.rejects(readFile(path.join(app.context.dataDir, "collector", BACKFILL_DIRECTORY, app.sourceId + ".json")),
                { code: "ENOENT" });
            const index = JSON.parse(await readFile(path.join(app.context.dataDir, "collector", "index.json")));
            assert.equal(index.sources[app.sourceId]?.backfill?.phase, undefined,
                "The failed prefix publication must not claim committed progress.");
        } finally {
            await app.collector.close();
            t.mock.restoreAll(); syncBuiltinESMExports();
            db.close();
        }
    });
}

test("native timers backfill after WIRE sign-in and Resume, and stop acquiring after signout", async t => {
    shortenNativePolling(t);
    const app = await fixture(t, { timers: true });
    t.after(app.lifecycle.subscribeAuthorizationChange(() => {
        assert.throws(() => app.lifecycle.lease("github-acquisition"), { code: "reentrant-call" });
    }));
    await app.append(interaction("native-sign-in"));
    const padding = await fs.open(app.sourceFile, "a");
    try {
        await padding.writeFile(`{"id":"timer-padding","type":"assistant.message","timestamp":"${new Date().toISOString()}","data":{"content":"`);
        const chunk = Buffer.alloc(1024 ** 2, 120);
        for (let offset = 0; offset < TAIL_LIMITS.initialFileBytes; offset += chunk.length) await padding.write(chunk);
        await padding.writeFile('"}}\n');
    } finally { await padding.close(); }
    await nativeWait(75);
    assert.equal((await loadBoardState(app.context)).evidence?.length ?? 0, 0);
    assert.deepEqual(await readdir(path.join(app.context.dataDir, "collector")), ["config.json"]);
    await app.command("wire-sign-in");
    const first = await waitForNativeRecords(app, ["native-sign-in"]);
    assert.equal((await app.collector.status()).backfill.visitedSources, 1);
    await app.collector.setEnabled(false);
    await app.append(interaction("native-resume"));
    await nativeWait(75);
    assert.equal(await readFile(first.cursorFile, "utf8"), first.cursor);
    await app.collector.setEnabled(true);
    await waitForNativeRecords(app, ["native-sign-in", "native-resume"]);
    await app.command("wire-sign-out");
    const stopped = await readFile(first.cursorFile, "utf8");
    await app.append(interaction("native-revoked"));
    await nativeWait(100);
    assert.equal(await readFile(first.cursorFile, "utf8"), stopped);
    assert.equal((await loadBoardState(app.context)).evidence.length, 2);
    await assert.rejects(app.collector.collectNow(), { code: "wire_access_revoked" });
});

test("native generation-change timers commit actual source progress and cannot revive a closed collector", async t => {
    shortenNativePolling(t);
    const app = await fixture(t, { timers: true, signedIn: true, transport: {
        qualification: "synthetic-only-v1", open: async () => {},
        verify: async ({ expectedPartition }) => ({ partition: expectedPartition, chat: true, cowork: true }),
        stop: async () => ({ processExited: true, profileReleased: true }),
    } });
    await app.append(interaction("native-initial"));
    await waitForNativeRecords(app, ["native-initial"]);
    await app.lifecycle.command(owner, { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, expectedPartition: "c".repeat(64), replace: false }, () => true);
    await app.append(interaction("native-generation"));
    await waitForNativeRecords(app, ["native-initial", "native-generation"]);
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    await app.append(interaction("native-expiry"));
    const completed = await waitForNativeRecords(app, ["native-initial", "native-generation", "native-expiry"]);
    await app.collector.close();
    const stopped = await readFile(completed.cursorFile, "utf8");
    await app.append(interaction("native-closed"));
    await app.command("wire-sign-out"); await app.command("wire-sign-in");
    await nativeWait(100);
    assert.equal(await readFile(completed.cursorFile, "utf8"), stopped);
    assert.equal((await loadBoardState(app.context)).evidence.length, 3);
    await assert.rejects(app.collector.collectNow(), /runtime is stopped/);
});

test("native timer retry after a real commit failure keeps the collector context and publishes once", async t => {
    shortenNativePolling(t);
    const app = await fixture(t, { timers: true });
    await app.append(interaction("native-retry"));
    let failures = 0;
    interceptRenames(t, async (from, to, rename) => {
        if (failures === 0 && path.dirname(to) === app.context.dataDir && to.endsWith(".state.json")) {
            failures++;
            throw Object.assign(new Error("Invented native timer publication failure"), { code: "EIO" });
        }
        await rename();
    });
    await app.command("wire-sign-in");
    await waitForNativeRecords(app, ["native-retry"]);
    assert.equal(failures, 1);
    assert.equal((await loadBoardState(app.context)).evidence.length, 1);
    assert.equal((await app.collector.status()).error, null);
});
