import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { sessionStorage } from "../lib/microsoft-session-state.mjs";
import { createFixtureRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, exclusiveBoard } from "../lib/store.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { privateFixture } from "./helpers.mjs";
import { seedRetainedReply } from "./search-corpus-fixture.mjs";

const nativeFetch = globalThis.fetch;
const backendOwner = "synthetic-backend-owner";
const settings = { paused: false, windowDays: 30 };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const deferred = () => Promise.withResolvers();
const projection = { layer: "tool", groupBy: "endpoint", filters: { scope: "all" }, limit: 10 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=", "base64");

test("an occupied runtime endpoint refuses the access factory before any lifecycle initialization", async t => {
    const { context } = await privateFixture(t, []);
    const occupied = createServer();
    await new Promise(resolve => occupied.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    let calls = 0;
    await assert.rejects(startServer(context, createExportController(context), {
        port: occupied.address().port, collector: { timers: false },
        createAccess: async () => { calls++; throw new Error("must not initialize"); },
    }), { code: "EADDRINUSE" });
    assert.equal(calls, 0);
    await assert.rejects(readFile(path.join(context.dataDir, "microsoft-session", "session.json")), { code: "ENOENT" });
});

test("access construction owns its endpoint first and a failed factory releases that exact endpoint", async t => {
    const { context } = await privateFixture(t, []);
    let origin;
    await assert.rejects(startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        createAccess: async value => {
            origin = value.origin;
            assert.equal((await fetch(origin + "/health")).status, 503);
            await assert.rejects(readFile(path.join(context.dataDir, "microsoft-session", "session.json")), { code: "ENOENT" });
            throw new Error("example-access-factory-failure");
        },
    }), /example-access-factory-failure/);
    const replacement = createServer();
    await new Promise((resolve, reject) => {
        replacement.once("error", reject);
        replacement.listen({ port: Number(new URL(origin).port), host: "127.0.0.1", exclusive: true }, resolve);
    });
    await new Promise(resolve => replacement.close(resolve));
});

test("the reserved endpoint becomes the same enforced runtime after backend access construction", async t => {
    const cleanups = [];
    const { context } = await privateFixture({ after: work => cleanups.push(work) }, []);
    let lifecycle, access, runtime, reservedOrigin;
    t.after(async () => {
        await runtime?.close(); access?.close(); await lifecycle?.close();
        for (const cleanup of cleanups) await cleanup();
    });
    runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false },
        createAccess: async ({ origin }) => {
            reservedOrigin = origin;
            assert.equal((await fetch(origin + "/health")).status, 503);
            lifecycle = await createMicrosoftSession(context, { collection: { paused: true, windowDays: 30 } });
            access = await createFixtureRuntimeAccess(context, { lifecycle });
            return access;
        },
    });
    assert.equal(new URL(runtime.url).origin, reservedOrigin);
    assert.equal((await fetch(runtime.url + "health")).status, 200);
    assert.equal(runtime.accessBootstrap.mode, "enforced");
    assert.equal((await access.status()).wire, "signed-out");
});

async function fixture(t, { githubProfile, transport, deletion, sessionTtlMs, observeCommand, storage } = {}) {
    const cleanups = [];
    const { context, root } = await privateFixture({ after: work => cleanups.push(work) });
    const config = { schemaVersion: 1, approved: true, approvedAt: "2026-10-01T12:00:00.000Z",
        appDbPath: path.join(root, "never-read.db"), sessionRoot: path.join(root, "never-read-history"),
        enabled: false, windowDays: 30, pollSeconds: 60 };
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    const configFile = path.join(context.dataDir, "collector", "config.json");
    await writeFile(configFile, JSON.stringify(config));
    let lifecycle, access, runtime, exports;
    const start = async () => {
        lifecycle = await createMicrosoftSession(context, { collection: settings, transport, storage: storage?.(context) });
        access = await createFixtureRuntimeAccess(context, { lifecycle: observeCommand ? {
            ...lifecycle, command(...args) { observeCommand(...args); return lifecycle.command(...args); },
        } : lifecycle });
        exports = createExportController(context);
        runtime = await startServer(context, exports, { port: 0, collector: { timers: false }, access, githubProfile, deletion, sessionTtlMs });
    };
    await start();
    await seedRetainedReply(context, runtime.collector.assessmentSource(await loadBoardState(context)), "SYNTHETIC_RETAINED_REPLY");
    t.after(async () => {
        await runtime.close(); access.close(); await lifecycle.close();
        for (const work of cleanups) await work();
    });
    const api = async (capability, route, input, headers = {}) => {
        const origin = new URL(runtime.url).origin;
        const response = await nativeFetch(origin + route, {
            method: input === undefined ? "GET" : "POST",
            headers: { Origin: origin, "X-Wire-Session-Protocol": "1", ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                ...(capability ? { "X-Board-Capability": capability } : {}), ...headers },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        return { code: response.status, body: await response.json(), headers: response.headers };
    };
    const panel = async () => (await api(null, "/api/session", {})).body.capability;
    const command = async (capability, action) => {
        const current = (await api(capability, "/api/access/status")).body;
        const input = { schemaVersion: 1, action, operationId: randomUUID(), generation: current.generation };
        return { input, result: await api(capability, "/api/access/command", input) };
    };
    return { context, configFile, api, panel, command,
        get exports() { return exports; },
        get lifecycle() { return lifecycle; }, get access() { return access; }, get runtime() { return runtime; },
        async restart() {
            await runtime.close(); access.close(); await lifecycle.close(); await start();
        },
    };
}
async function saveReport(app, capability) {
    const preview = await app.api(capability, "/api/preview", {
        options: { formats: ["html", "json"], promptMode: "original" },
        selection: { kind: "all", revision: (await loadBoardState(app.context)).revision },
    });
    assert.equal(preview.code, 200);
    assert.equal((await app.api(capability, "/api/privacy-review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).code, 200);
    const result = await app.api(capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
    assert.equal(result.code, 200);
    return result.body.bundle;
}
async function searchPanel(app) {
    const capability = await app.panel(), controller = new AbortController();
    const origin = new URL(app.runtime.url).origin;
    const response = await nativeFetch(origin + "/api/search/events", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Board-Capability": capability },
        body: JSON.stringify({ schemaVersion: 3 }), signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
    const ended = (async () => {
        let buffer = "";
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) return "ended";
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf("\n")) >= 0) {
                    events.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
                }
            }
        } catch (error) {
            if (controller.signal.aborted) return "cancelled";
            if (error instanceof TypeError && error.message === "terminated") return "revoked";
            throw error;
        } finally { reader.releaseLock(); }
    })();
    return { events, ended,
        api: (route, input) => app.api(capability, route, route.endsWith("/query")
            ? { schemaVersion: 3, purpose: "navigation", ...input } : input),
        async wait(match) {
            const timeout = AbortSignal.timeout(10000);
            while (!events.some(match)) { timeout.throwIfAborted(); await setImmediate(); }
            return events.find(match);
        },
        async close() { controller.abort(); await ended; },
    };
}

test("fixture access cannot be enabled with a frontend-shaped flag or a live scheduler", async t => {
    const app = await fixture(t);
    await assert.rejects(startServer(app.context, app.exports, { port: 0, access: { enabled: true } }),
        { code: "wire_access_untrusted_binding" });
    await assert.rejects(startServer(app.context, app.exports, { port: 0, access: app.access }),
        { code: "wire_access_writer_integration_pending" });
    await assert.rejects(createFixtureRuntimeAccess(app.context, { lifecycle: {} }),
        { code: "wire_access_lifecycle_unqualified" });
});

test("opt-in gate protects real state, analytics, reader, Search and report routes across fresh instances", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    const signedOut = await app.api(a, "/api/access/status");
    assert.equal(signedOut.body.wire, "signed-out");
    assert.deepEqual(Object.keys(signedOut.body).sort(), ["actions", "authorizationRevision", "collection", "enforcement",
        "freshnessMs", "generation", "maxWaitMs", "mode", "retained", "runtimeId", "schemaVersion", "stage", "wire"]);
    assert.equal(signedOut.body.enforcement.clientClearance, "not-integrated");
    assert.equal((await app.command(a, "wire-sign-in")).result.code, 200);
    const snapshot = await app.api(a, "/api/snapshot", projection);
    assert.equal(snapshot.code, 200);
    assert.match(JSON.stringify(snapshot.body.scenarios), /SYNTHETIC_PRIVATE_PROMPT/);
    assert.equal(snapshot.body.analytics.revision, snapshot.body.revision);
    assert.ok(snapshot.body.analytics.rows.length);
    assert.equal((await app.api(a, "/api/analytics", projection)).code, 200);
    assert.equal((await app.api(a, "/api/state")).code, 200);
    const interactionRef = snapshot.body.assessment.catalog[0].interactionRef;
    const detailInput = { schemaVersion: 1, interactionRef, expectedSourceRevision: snapshot.body.assessment.basis.sourceRevision };
    const detail = await app.api(a, "/api/assessment/detail", detailInput);
    assert.equal(detail.code, 200);
    const state = await loadBoardState(app.context);
    const captured = state.personalEvaluation.captures[0].observation;
    const evidenceInput = { schemaVersion: 1, interactionRef, observationRef: captured.observationRef, expectedBasis: snapshot.body.assessment.basis };
    const text = await app.api(a, "/api/assessment/evidence", evidenceInput);
    assert.equal(text.code, 200);
    assert.match(JSON.stringify(text.body), /SYNTHETIC_RETAINED_REPLY/);
    const bundle = await saveReport(app, a);
    const index = (await loadBoardState(app.context)).exports.find(item => item.bundleId === bundle.bundleId);
    const filesBefore = await Promise.all(Object.values(index.files).map(async file => [file, hash(await readFile(file))]));
    const stateBefore = await loadBoardState(app.context);
    const configBefore = await readFile(app.configFile, "utf8");
    const fileName = Object.keys(index.files)[0];
    const successfulReads = [
        ["/api/refresh", {}], ["/api/report-artifacts/list", {}],
        ["/api/report/open", { bundleId: bundle.bundleId }],
        ["/api/report-file", { bundleId: bundle.bundleId, name: fileName }],
        ["/api/artifact-file", { bundleId: bundle.bundleId, kind: "report", format: "html" }],
        ["/api/assessment/overview", { schemaVersion: 1, interactionRefs: [interactionRef], expectedSourceRevision: stateBefore.evidenceRevision }],
        ["/api/assessment/consent", { schemaVersion: 1 }],
        ["/api/collection/status", {}],
        ["/api/canvas", { action: "get_summary", input: {} }],
    ];
    for (const [route, input] of successfulReads) assert.equal((await app.api(a, route, input)).code, 200, route);
    const out = await app.command(b, "wire-sign-out");
    assert.equal(out.result.code, 200);
    assert.deepEqual(out.result.body.revocation, { scope: "wire", partition: null });
    const denied = [
        ["/api/state", undefined], ["/api/snapshot", projection], ["/api/analytics", projection],
        ["/api/profile/github", undefined], ["/api/assessment/detail", detailInput], ["/api/assessment/evidence", evidenceInput],
        ...successfulReads,
        ["/api/period-comparison", {}], ["/api/search/query", {}], ["/api/search/open", {}],
        ["/api/search/status", {}], ["/api/search/events", { schemaVersion: 3 }],
        ["/api/preview", {}], ["/api/privacy-review", {}], ["/api/report-original", {}],
        ["/api/report-comparison/inspect", {}], ["/api/report-comparison/open", {}],
        ["/api/report-comparison/preview", {}], ["/api/report-comparison/review", {}],
        ["/api/record/status", {}], ["/api/deletion/status", { operationId: randomUUID() }],
        ["/api/recollection/status", {}], ["/api/evaluation/status", {}],
    ];
    for (const [route, input] of denied) {
        const result = await app.api(a, route, input);
        assert.ok([403, 409].includes(result.code), route);
        assert.equal(result.body.code, "wire_access_revoked", route);
        assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PRIVATE|SYNTHETIC_RETAINED/);
    }
    const fresh = await app.panel();
    assert.equal((await app.api(fresh, "/api/refresh", {})).body.code, "wire_access_revoked");
    await app.restart();
    const restarted = await app.panel();
    assert.equal((await app.api(restarted, "/api/access/status")).body.wire, "signed-out");
    assert.equal((await app.api(restarted, "/api/state")).body.code, "wire_access_revoked");
    assert.deepEqual(await loadBoardState(app.context), stateBefore);
    assert.equal(await readFile(app.configFile, "utf8"), configBefore);
    for (const [file, digest] of filesBefore) assert.equal(hash(await readFile(file)), digest);
    assert.equal((await app.command(restarted, "wire-sign-in")).result.code, 200);
    assert.equal((await app.api(restarted, "/api/state")).code, 200);
    assert.equal((await app.api(restarted, "/api/report/open", { bundleId: bundle.bundleId })).code, 200);
    assert.equal((await app.lifecycle.status()).microsoft.state, "unavailable");
});

test("lifecycle operations are owner-bound, protected, schema-closed and never adopted by renewed panels", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    const operation = await app.command(a, "wire-sign-in");
    assert.equal(operation.result.code, 200);
    assert.deepEqual((await app.api(a, "/api/access/command", operation.input)).body, operation.result.body);
    const receiptInput = { schemaVersion: 1, operationId: operation.input.operationId };
    for (const route of ["/api/access/command", "/api/access/receipt"]) {
        const input = route.endsWith("command") ? operation.input : receiptInput;
        assert.equal((await app.api(b, route, input)).code, 403);
        assert.equal((await app.api(null, route, input)).body.code, "session_expired");
        assert.equal((await app.api(a, route, input, { Origin: "https://foreign.invalid" })).code, 403);
    }
    assert.deepEqual((await app.api(a, "/api/access/receipt", receiptInput)).body, operation.result.body);
    assert.equal((await app.api(a, "/api/access/command", { ...operation.input, owner: backendOwner })).code, 422);
    assert.equal((await app.api(a, "/api/access/command", { ...operation.input, action: "microsoft-connect" })).code, 422);
    assert.equal((await app.api(a, "/api/access/command", { ...operation.input, operationId: [operation.input.operationId] })).code, 422);
    assert.equal((await app.api(a, "/api/access/receipt", { ...receiptInput, operationId: [receiptInput.operationId] })).code, 422);
    await app.api(a, "/api/session/release", {});
    const renewed = await app.panel();
    assert.equal((await app.api(renewed, "/api/access/receipt", receiptInput)).code, 403);
    await app.restart();
    assert.equal((await app.api(await app.panel(), "/api/access/command", operation.input)).code, 403);
});

test("existing saved-comparison preparation, listing, opening and download share the same gate", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const baseline = await saveReport(app, a), later = await saveReport(app, a);
    const pair = { baselineId: baseline.bundleId, laterId: later.bundleId };
    assert.equal((await app.api(a, "/api/report-comparison/inspect", pair)).code, 200);
    const preview = await app.api(a, "/api/report-comparison/preview", { ...pair, formats: ["html"] });
    assert.equal(preview.code, 200);
    assert.equal((await app.api(b, "/api/report-comparison/review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).code, 409);
    assert.equal((await app.api(a, "/api/report-comparison/review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).code, 200);
    const saved = await app.api(a, "/api/report-comparison/save", { previewId: preview.body.previewId, confirmed: true });
    assert.equal(saved.code, 200);
    const bundleId = saved.body.bundle.bundleId;
    const download = { bundleId, kind: "comparison", format: "html" };
    const before = await app.api(a, "/api/artifact-file", download);
    assert.equal(before.code, 200);
    assert.equal((await app.api(a, "/api/report-comparison/open", { bundleId })).code, 200);
    assert.equal((await app.api(a, "/api/report-artifacts/list", {})).body.artifacts.length, 3);
    await app.command(b, "wire-sign-out");
    for (const [route, input] of [
        ["/api/report-comparison/inspect", pair], ["/api/report-comparison/open", { bundleId }],
        ["/api/artifact-file", download], ["/api/report-artifacts/list", {}],
    ]) assert.equal((await app.api(a, route, input)).body.code, "wire_access_revoked");
    await app.command(a, "wire-sign-in");
    assert.deepEqual((await app.api(a, "/api/artifact-file", download)).body, before.body);
});

test("late real report preparation cannot publish or recover its old-generation preview after signout", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const entered = deferred(), resume = deferred();
    const original = app.exports.preview.bind(app.exports);
    let preview;
    t.mock.method(app.exports, "preview", async (...args) => {
        entered.resolve(); await resume.promise;
        preview = await original(...args);
        return preview;
    });
    const pending = app.api(a, "/api/preview", { options: { formats: ["html"] },
        selection: { kind: "all", revision: (await loadBoardState(app.context)).revision } });
    await entered.promise;
    assert.equal((await app.command(b, "wire-sign-out")).result.code, 200);
    resume.resolve();
    const result = await pending;
    assert.equal(result.code, 403);
    assert.equal(result.body.code, "wire_access_revoked");
    assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC|previewId/);
    await app.command(a, "wire-sign-in");
    assert.equal((await app.api(a, "/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true })).code, 409);
    assert.equal((await app.api(b, "/api/export", { previewId: preview.previewId, confirmed: true })).code, 409);
    assert.equal((await loadBoardState(app.context)).exports.length, 0);
});

test("an admitted real report save finishes before signout, without weakening its review or owner checks", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const preview = await app.api(a, "/api/preview", { options: { formats: ["html"] },
        selection: { kind: "all", revision: (await loadBoardState(app.context)).revision } });
    const confirmation = { previewId: preview.body.previewId, confirmed: true };
    assert.equal((await app.api(a, "/api/export", confirmation)).code, 428);
    assert.equal((await app.api(b, "/api/export", confirmation)).code, 409);
    await app.api(a, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true });
    const entered = deferred(), resume = deferred(), original = app.exports.confirm.bind(app.exports);
    t.mock.method(app.exports, "confirm", async (...args) => { entered.resolve(); await resume.promise; return original(...args); });
    const generation = (await app.api(a, "/api/access/status")).body.generation;
    const save = app.api(a, "/api/export", confirmation);
    await entered.promise;
    let signedOut = false;
    const out = app.api(b, "/api/access/command", {
        schemaVersion: 1, action: "wire-sign-out", operationId: randomUUID(), generation,
    }).then(result => { signedOut = true; return result; });
    await setImmediate();
    assert.equal(signedOut, false);
    resume.resolve();
    const saved = await save;
    assert.ok([200, 409].includes(saved.code), "An admitted mutation either publishes or reports an uncertain outcome.");
    if (saved.code === 409) assert.equal(saved.body.code, "wire_access_outcome_unknown");
    assert.equal((await out).code, 200);
    assert.equal((await loadBoardState(app.context)).exports.length, 1);
    assert.equal((await app.api(a, "/api/report-artifacts/list", {})).body.code, "wire_access_revoked");
});

test("signout preserves a sealed pending deletion receipt and cannot replay it under another panel", async t => {
    const app = await fixture(t, { deletion: { afterSeal() { throw new Error("Synthetic cleanup interruption"); } } });
    const a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const bundle = await saveReport(app, a);
    const preview = await app.api(a, "/api/deletion/preview", { scope: "all" });
    assert.equal(preview.code, 200);
    const input = { operationId: preview.body.operationId, confirmed: true };
    assert.equal((await app.api(a, "/api/deletion/confirm", input)).body.code, "wire_access_admission_failed");
    const pendingState = () => exclusiveBoard(app.context, state => state, { readOnly: true });
    const before = await pendingState();
    assert.equal(before.deletion.operations[input.operationId].phase, "pending");
    const files = await Promise.all(Object.values(before.exports[0].files).map(async file => [file, hash(await readFile(file))]));
    await app.command(b, "wire-sign-out");
    assert.deepEqual((await pendingState()).deletion, before.deletion);
    await app.command(a, "wire-sign-in");
    assert.equal((await app.api(b, "/api/deletion/confirm", input)).code, 403);
    assert.equal((await app.api(a, "/api/deletion/confirm", input)).code, 403, "Returning panels cannot replay a prior-generation mutation.");
    assert.deepEqual((await pendingState()).deletion, before.deletion);
    for (const [file, digest] of files) assert.equal(hash(await readFile(file)), digest);
    assert.equal((await app.api(a, "/api/report/open", { bundleId: bundle.bundleId })).code, 200);
});

test("profile metadata and image tickets cannot outlive the gate, including an in-flight image", async t => {
    const app = await fixture(t, { githubProfile: {
        copilot: { binding: "copilot-app", getAuthStatus: async () => ({
            isAuthenticated: true, authType: "user", host: "github.com", login: "synthetic-access",
        }) },
        fetch: async url => url.startsWith("https://api.github.com/")
            ? Response.json({ id: 12345, login: "synthetic-access", name: "Synthetic Access",
                type: "User", avatar_url: "https://avatars.githubusercontent.com/u/12345?v=4" })
            : new Response(png, { headers: { "content-type": "image/png" } }),
    } });
    const a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const profile = await app.api(a, "/api/profile/github");
    assert.equal(profile.body.identity.login, "synthetic-access");
    const origin = new URL(app.runtime.url).origin;
    const image = url => nativeFetch(origin + url, { headers: { "Sec-Fetch-Site": "same-origin" } });
    const currentImage = await image(profile.body.avatar.url);
    assert.deepEqual(Buffer.from(await currentImage.arrayBuffer()), png);
    assert.equal(currentImage.headers.get("x-wire-runtime"), app.runtime.runtimeId);
    assert.equal(Number(currentImage.headers.get("x-wire-generation")), (await app.lifecycle.status()).generation);
    const entered = deferred(), resume = deferred(), original = app.runtime.githubProfile.image.bind(app.runtime.githubProfile);
    t.mock.method(app.runtime.githubProfile, "image", async revision => {
        const result = await original(revision);
        entered.resolve(); await resume.promise; return result;
    });
    const pending = image(profile.body.avatar.url);
    await entered.promise;
    await app.command(b, "wire-sign-out");
    resume.resolve();
    const rejected = await pending;
    assert.notEqual(rejected.status, 200);
    assert.match(rejected.headers.get("content-type"), /json/);
    assert.notEqual((await image(profile.body.avatar.url)).status, 200);
    assert.equal((await app.api(a, "/api/profile/github")).body.code, "wire_access_revoked");
    await app.command(a, "wire-sign-in");
    assert.equal((await image(profile.body.avatar.url)).status, 404);
    const next = await app.api(a, "/api/profile/github");
    assert.notEqual(next.body.avatar.url, profile.body.avatar.url);
});

test("a late cosmetic profile failure cannot block local admission or publish metadata after signout", async t => {
    const entered = deferred(), resume = deferred();
    const app = await fixture(t, { githubProfile: {
        copilot: { binding: "copilot-app", getAuthStatus: async () => ({
            isAuthenticated: true, authType: "user", host: "github.com", login: "synthetic-access",
        }) },
        fetch: async () => { entered.resolve(); await resume.promise; throw new TypeError("Synthetic offline profile"); },
    } });
    const a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const pending = app.api(a, "/api/profile/github");
    await entered.promise;
    const lease = await app.access.acquireCollectionLease();
    assert.equal(await app.access.admitCollection(lease, () => 42), 42);
    await app.command(b, "wire-sign-out");
    resume.resolve();
    assert.equal((await pending).body.code, "wire_access_revoked");
});

test("real Search results and streams are withdrawn server-side; old receipt cannot reopen after sign in", async t => {
    const app = await fixture(t), a = await app.panel();
    await app.command(a, "wire-sign-in");
    const panel = await searchPanel(app);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "SYNTHETIC_PRIVATE_PROMPT", requestId: 1, types: ["interaction"] });
    const results = await panel.wait(event => event.event === "results" && event.requestId === 1);
    assert.equal(results.matches.total, 1);
    const receipt = results.matches.receipt, id = results.matches.hits[0].id;
    await app.lifecycle.updateCollection({ ...settings, paused: true });
    await panel.api("/api/search/query", { query: "SYNTHETIC_PRIVATE_PROMPT", requestId: 2, types: ["interaction"] });
    assert.equal((await panel.wait(event => event.event === "results" && event.requestId === 2)).matches.total, 1);
    await app.lifecycle.updateCollection(settings);
    await app.command(a, "wire-sign-out");
    assert.ok(["ended", "revoked"].includes(await panel.ended));
    const count = panel.events.length;
    assert.equal((await panel.api("/api/search/open", { id, receipt, openId: 1 })).body.code, "wire_access_revoked");
    await app.command(a, "wire-sign-in");
    assert.equal((await panel.api("/api/search/open", { id, receipt, openId: 2 })).code, 428);
    const timeout = AbortSignal.timeout(5000);
    while (app.runtime.search.status().panels) { timeout.throwIfAborted(); await setImmediate(); }
    assert.equal(panel.events.slice(count).some(event => ["results", "opened"].includes(event.event)), false);
});

test("Pause and natural Microsoft expiry leave retained GitHub and reports readable without avatar authorization", async t => {
    const app = await fixture(t, { transport: {
        qualification: "synthetic-only-v1", open: async () => {},
        verify: async ({ expectedPartition }) => ({ partition: expectedPartition, chat: true, cowork: true }),
        stop: async () => ({ processExited: true, profileReleased: true }),
    } });
    const a = await app.panel();
    await app.command(a, "wire-sign-in");
    const bundle = await saveReport(app, a);
    const retained = await app.access.read(backendOwner);
    await app.lifecycle.updateCollection({ ...settings, paused: true });
    assert.equal(retained.signal.aborted, false);
    assert.equal(retained.publish(() => "readable"), "readable");
    assert.equal((await app.api(a, "/api/report/open", { bundleId: bundle.bundleId })).code, 200);
    await app.lifecycle.updateCollection(settings);
    await app.lifecycle.command(backendOwner, { action: "microsoft-connect", operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation, expectedPartition: "a".repeat(64), replace: false }, () => true);
    await app.lifecycle.expire(await app.lifecycle.lease("microsoft-read"));
    assert.equal((await app.api(a, "/api/access/status")).body.retained, true);
    assert.equal((await app.api(a, "/api/state")).code, 200);
    assert.equal((await app.api(a, "/api/report/open", { bundleId: bundle.bundleId })).code, 200);
    assert.equal((await app.api(a, "/api/profile/github")).body.avatar.url, null);
    const acquisition = await app.access.acquireCollectionLease();
    assert.equal(await app.access.admitCollection(acquisition, () => "admitted independently of avatar"), "admitted independently of avatar");
    retained.release();
});

test("atomic admission rejects stale acquisition and serializes an admitted commit before signout", async t => {
    const app = await fixture(t), a = await app.panel();
    await app.command(a, "wire-sign-in");
    const stale = await app.access.acquireCollectionLease();
    await app.command(a, "wire-sign-out");
    let commits = 0;
    await assert.rejects(app.access.admitCollection(stale, () => commits++), { code: "wire_access_revoked" });
    await app.command(a, "wire-sign-in");
    const entered = deferred(), resume = deferred();
    const lease = await app.access.acquireCollectionLease();
    const write = app.access.admitCollection(lease, async () => { entered.resolve(); await resume.promise; commits++; });
    await entered.promise;
    const pending = app.lifecycle.command(backendOwner, { action: "wire-sign-out", operationId: randomUUID(), generation: lease.generation }, () => true);
    resume.resolve(); await write; await pending;
    assert.equal(commits, 1);
    await assert.rejects(app.access.admitCollection(lease, () => commits++), { code: "wire_access_revoked" });
    assert.equal(commits, 1);
    await app.command(a, "wire-sign-in");
    assert.throws(() => app.access.admitCollection({ kind: "retained" }, () => commits++), { code: "wire_access_invalid_lease" });
    const config = await readFile(app.configFile, "utf8");
    for (const [route, input] of [
        ["/api/collection/now", {}], ["/api/import", {}], ["/api/collection/configure", {}],
        ["/api/collection/enabled", { enabled: true }], ["/api/record", {}], ["/api/recollection/confirm", {}],
        ["/api/canvas", { action: "refresh_history", input: {} }],
    ]) assert.equal((await app.api(a, route, input)).body.code, "wire_access_writer_integration_pending");
    assert.equal(await readFile(app.configFile, "utf8"), config);
});

test("backend capability renewal cannot reopen WIRE or admit an old panel's sign-in command", async t => {
    const app = await fixture(t), a = await app.panel();
    await app.command(a, "wire-sign-in"); await app.command(a, "wire-sign-out");
    await app.api(a, "/api/session/release", {});
    const before = await sessionStorage(app.context).read(), retained = await loadBoardState(app.context);
    let commands = 0;
    const observe = req => { if (req.method === "POST" && req.url === "/api/access/command") commands++; };
    app.runtime.server.on("request", observe);
    t.after(() => app.runtime.server.off("request", observe));
    assert.equal((await app.api(a, "/api/state")).body.code, "session_expired");
    const renewed = await app.panel();
    const hidden = await app.api(renewed, "/api/state");
    assert.equal(hidden.code, 403);
    assert.equal(hidden.body.code, "wire_access_revoked");
    const operationId = randomUUID();
    const rejected = await app.api(a, "/api/access/command", {
        schemaVersion: 1, action: "wire-sign-in", generation: before.generation, operationId,
    });
    assert.equal(rejected.code, 403);
    assert.equal(rejected.body.code, "session_expired");
    assert.equal(rejected.body.outcome, undefined);
    assert.equal(commands, 1, "Only the deliberate rejected request reached the backend.");
    assert.deepEqual((await sessionStorage(app.context).read()).receipts, before.receipts);
    assert.deepEqual(await loadBoardState(app.context), retained);
    assert.equal((await app.lifecycle.status()).wire, "signed-out");
});

for (const invalidate of ["release", "expiry"]) {
    test(`command admission rejects panel ${invalidate} after its withheld body completes`, { timeout: 10000 }, async t => {
        let now = Date.now();
        if (invalidate === "expiry") t.mock.method(Date, "now", () => now);
        const app = await fixture(t, { sessionTtlMs: 1000 }), capability = await app.panel();
        const input = { schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(),
            generation: (await app.lifecycle.status()).generation };
        const origin = new URL(app.runtime.url).origin, body = JSON.stringify(input);
        const seen = deferred(), received = deferred();
        const observe = req => { if (req.url === "/api/access/command") seen.resolve(); };
        app.runtime.server.on("request", observe);
        t.after(() => app.runtime.server.off("request", observe));
        const req = httpRequest(origin + "/api/access/command", { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
            "X-Board-Capability": capability,
        } }, async res => {
            try {
                let bytes = "";
                for await (const chunk of res) bytes += chunk;
                received.resolve({ code: res.statusCode, body: JSON.parse(bytes) });
            } catch (error) { received.reject(error); }
        });
        req.on("error", received.reject);
        t.after(() => req.destroy());
        req.write(body.slice(0, 1));
        await seen.promise;
        if (invalidate === "release") assert.equal((await app.api(capability, "/api/session/release", {})).code, 200);
        else now += 1001;
        req.end(body.slice(1));
        assert.equal((await received.promise).code, 403);
        assert.equal((await app.api(capability, "/api/access/status")).code, 403);
        assert.equal((await app.lifecycle.status()).wire, "signed-out");
        assert.equal((await sessionStorage(app.context).read()).receipts.some(receipt => receipt.operationId === input.operationId), false);
    });
}

for (const invalidate of ["release", "expiry"]) {
    test(`command admission rechecks panel ${invalidate} inside the lifecycle queue`, { timeout: 10000 }, async t => {
        const queued = deferred(), operationId = randomUUID();
        let now = Date.now();
        if (invalidate === "expiry") t.mock.method(Date, "now", () => now);
        const app = await fixture(t, { sessionTtlMs: 1000,
            observeCommand: (owner, input) => { if (input.operationId === operationId) queued.resolve(); } });
        const capability = await app.panel();
        await app.command(capability, "wire-sign-in");
        const generation = (await app.lifecycle.status()).generation;
        const entered = deferred(), resume = deferred();
        const lease = await app.access.acquireCollectionLease();
        const blocker = app.access.admitCollection(lease, async () => { entered.resolve(); await resume.promise; });
        await entered.promise;
        const pending = app.api(capability, "/api/access/command", {
            schemaVersion: 1, action: "wire-sign-out", operationId, generation,
        });
        await queued.promise;
        if (invalidate === "release") assert.equal((await app.api(capability, "/api/session/release", {})).code, 200);
        else now += 1001;
        resume.resolve(); await blocker;
        assert.equal((await pending).code, 403);
        assert.equal((await app.lifecycle.status()).wire, "signed-in");
        assert.equal((await sessionStorage(app.context).read()).receipts.some(receipt => receipt.operationId === operationId), false);
    });
}

for (const invalidate of ["release", "expiry"]) {
    test(`already-admitted command retains its completed receipt after panel ${invalidate}`, { timeout: 10000 }, async t => {
        const operationId = randomUUID(), entered = deferred(), resume = deferred();
        let now = Date.now();
        if (invalidate === "expiry") t.mock.method(Date, "now", () => now);
        const app = await fixture(t, { sessionTtlMs: 1000, storage: context => {
            const store = sessionStorage(context);
            return { ...store, async write(next) {
                if (next.receipts.some(receipt => receipt.operationId === operationId)) {
                    entered.resolve(); await resume.promise;
                }
                await store.write(next);
            } };
        } });
        const capability = await app.panel();
        const pending = app.api(capability, "/api/access/command", {
            schemaVersion: 1, action: "wire-sign-in", operationId, generation: (await app.lifecycle.status()).generation,
        });
        await entered.promise;
        if (invalidate === "release") assert.equal((await app.api(capability, "/api/session/release", {})).code, 200);
        else now += 1001;
        resume.resolve();
        const result = await pending;
        assert.equal(result.code, 200);
        assert.equal(result.body.outcome, "completed");
        assert.equal(result.body.operationId, operationId);
        assert.equal((await app.lifecycle.status()).wire, "signed-in");
        assert.equal((await app.api(capability, "/api/access/status")).code, 403);
        await app.restart();
        assert.equal((await app.lifecycle.status()).wire, "signed-in", "The already-started completion remains durable.");
    });
}

test("backend committed comparison response stays unknown and recovers by read without repeating the save", { timeout: 15000 }, async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a, "wire-sign-in");
    const baseline = await saveReport(app, a), later = await saveReport(app, a);
    const preview = await app.api(a, "/api/report-comparison/preview", {
        baselineId: baseline.bundleId, laterId: later.bundleId, formats: ["html"],
    });
    assert.equal(preview.code, 200);
    assert.equal((await app.api(a, "/api/report-comparison/review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).code, 200);
    const entered = deferred(), resume = deferred();
    const original = app.runtime.collector.status.bind(app.runtime.collector);
    t.mock.method(app.runtime.collector, "status", async (...args) => {
        const result = await original(...args);
        entered.resolve(); await resume.promise; return result;
    });
    let saves = 0;
    const observe = req => { if (req.method === "POST" && req.url === "/api/report-comparison/save") saves++; };
    app.runtime.server.on("request", observe);
    t.after(() => app.runtime.server.off("request", observe));
    const pending = app.api(a, "/api/report-comparison/save", { previewId: preview.body.previewId, confirmed: true });
    try {
        await entered.promise;
        assert.equal((await loadBoardState(app.context)).exports.length, 3, "The real comparison commit already happened.");
        await app.command(b, "wire-sign-out");
    } finally { resume.resolve(); }
    const result = await pending;
    assert.equal(result.code, 409);
    assert.equal(result.body.code, "wire_access_outcome_unknown");
    assert.equal(result.body.outcome, "unknown");
    assert.equal(result.headers.get("x-wire-generation"), null);
    assert.equal(result.headers.get("x-wire-runtime"), null);
    assert.equal(saves, 1);
    assert.doesNotMatch(JSON.stringify(result.body), /SYNTHETIC_PRIVATE|SYNTHETIC_RETAINED/);
    assert.equal((await app.api(a, "/api/refresh", {})).body.code, "wire_access_revoked");
    await app.command(a, "wire-sign-in");
    const recovery = await app.api(a, "/api/refresh", {});
    assert.equal(recovery.code, 200);
    const recovered = recovery.body.exports
        .find(item => item.bundleId === preview.body.bundleId);
    assert.equal(recovered.kind, "comparison");
    assert.equal(recovered.title, preview.body.title);
    assert.ok(Object.keys(recovered.files).length, "Read-only recovery returns the original registered artifact.");
    assert.equal(saves, 1, "Recovery must not dispatch another save.");
    assert.equal((await loadBoardState(app.context)).exports.length, 3);
});

test("backend pre-dispatch access denial does not create a report or an unknown write outcome", async t => {
    const app = await fixture(t), capability = await app.panel();
    const before = await loadBoardState(app.context);
    let requests = 0, writes = 0;
    const observe = req => { if (req.method === "POST" && req.url === "/api/export") requests++; };
    app.runtime.server.on("request", observe);
    t.after(() => app.runtime.server.off("request", observe));
    const confirm = app.exports.confirm.bind(app.exports);
    t.mock.method(app.exports, "confirm", (...args) => { writes++; return confirm(...args); });
    const rejected = await app.api(capability, "/api/export", { previewId: "not-dispatched", confirmed: true });
    assert.equal(rejected.code, 403);
    assert.equal(rejected.body.code, "wire_access_revoked");
    assert.equal(rejected.body.outcome, undefined);
    assert.equal(requests, 1);
    assert.equal(writes, 0);
    assert.deepEqual(await loadBoardState(app.context), before);
});

for (const status of [403, 409]) {
    test(`declared-unbound response-classification unit preserves explicit unknown outcome at HTTP ${status}`, async t => {
        const bootstrap = { schemaVersion: 1, mode: "unbound", runtimeId: randomUUID() }, calls = [];
        t.mock.method(globalThis, "fetch", async route => {
            calls.push(route);
            return Response.json({
                code: "wire_access_outcome_unknown", outcome: "unknown", error: "Check the original saved result.",
            }, { status });
        });
        await assert.rejects(createBoardTransport("a".repeat(64), () => {}, bootstrap)(
            "/api/export", { previewId: "original", confirmed: true }),
        { code: "request_outcome_unknown", reason: "wire_access_outcome_unknown", outcome: "unknown" });
        assert.deepEqual(calls, ["/api/export"], "This declared-unbound unit has no server, watch or automatic mutation retry.");
    });
}
