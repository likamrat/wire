import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { sessionStorage } from "../lib/microsoft-session-state.mjs";
import { createFixtureRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";

const fields = ["schemaVersion", "mode", "runtimeId", "authorizationRevision", "generation",
    "wire", "retained", "collection", "maxWaitMs", "freshnessMs"].sort();
const cursor = value => ({ runtimeId: value.runtimeId, authorizationRevision: value.authorizationRevision });
async function fixture(t, { bound = true, sessionTtlMs, storage, expectedCloseError } = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: work => cleanup.push(work) });
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify({
        schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 60,
        appDbPath: path.join(context.dataDir, "never-read.db"), sessionRoot: path.join(context.dataDir, "never-read-history"),
    }));
    let lifecycle, access, runtime, exports;
    async function start() {
        if (bound) {
            lifecycle = await createMicrosoftSession(context, {
                collection: { paused: false, windowDays: 30 }, storage: storage?.(context),
            });
            access = await createFixtureRuntimeAccess(context, { lifecycle });
        }
        exports = createExportController(context);
        runtime = await startServer(context, exports, { port: 0, collector: { timers: false }, access, sessionTtlMs });
    }
    await start();
    const stop = async () => {
        await runtime.close(); access?.close();
        if (expectedCloseError) await assert.rejects(lifecycle.close(), { code: expectedCloseError });
        else await lifecycle?.close();
    };
    t.after(async () => { await stop(); for (const work of cleanup) await work(); });
    const request = (capability, route, input, options = {}) => {
        const origin = new URL(runtime.url).origin;
        return fetch(origin + route, {
            method: input === undefined ? "GET" : "POST",
            headers: { Origin: origin, "X-Wire-Session-Protocol": "1", ...(input === undefined ? {} : { "Content-Type": "application/json" }),
                ...(capability ? { "X-Board-Capability": capability } : {}), ...options.headers },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: options.signal,
        });
    };
    const api = async (...args) => {
        const response = await request(...args);
        return { code: response.status, body: await response.json(), headers: response.headers };
    };
    return {
        context, api, request,
        get runtime() { return runtime; }, get access() { return access; }, get lifecycle() { return lifecycle; },
        get exports() { return exports; },
        panel: async () => (await api(null, "/api/session", {})).body,
        watch: (capability, after = null, options) => api(capability, "/api/access/watch", { schemaVersion: 1, after }, options),
        async command(capability, action) {
            const operation = { schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation };
            const result = await api(capability, "/api/access/command", operation);
            return { ...result, operation };
        },
        async restart() { await stop(); await start(); },
    };
}

test("explicit unbound bootstrap/status and renewal never invent retained authority", async t => {
    const app = await fixture(t, { bound: false }), panel = await app.panel();
    assert.deepEqual(Object.keys(panel).sort(), ["accessBootstrap", "capability", "runtimeId"]);
    assert.deepEqual(panel.accessBootstrap, { schemaVersion: 1, mode: "unbound", runtimeId: app.runtime.runtimeId });
    assert.deepEqual((await app.api(panel.capability, "/api/access/status")).body, panel.accessBootstrap);
    assert.equal((await app.api(null, "/api/access/status")).code, 403);
    assert.equal((await app.watch(panel.capability)).code, 503);
    assert.equal((await app.api(panel.capability, "/api/state")).code, 200);
});

async function startWatch(app, capability, after, options) {
    const received = Promise.withResolvers();
    const observe = req => {
        if (req.url === "/api/access/watch") req.once("end", received.resolve);
    };
    app.runtime.server.on("request", observe);
    const pending = app.watch(capability, after, options);
    try { await received.promise; await setImmediate(); }
    finally { app.runtime.server.off("request", observe); }
    return { pending };
}
function assertProjection(app, response) {
    assert.equal(response.code, 200);
    assert.deepEqual(Object.keys(response.body).sort(), fields);
    assert.equal(response.body.schemaVersion, 1);
    assert.equal(response.body.mode, "enforced");
    assert.equal(response.body.runtimeId, app.runtime.runtimeId);
    assert.equal(response.body.maxWaitMs, 1000);
    assert.equal(response.body.freshnessMs, 5000);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-wire-generation"), null, "Control snapshots are not private display grants.");
    return response.body;
}

test("real lifecycle seed, bootstrap, status and response stamps have coherent exact public projections", async t => {
    const app = await fixture(t), panel = await app.panel();
    assert.deepEqual(panel.accessBootstrap, { schemaVersion: 1, mode: "enforced", runtimeId: app.runtime.runtimeId,
        maxWaitMs: 1000, freshnessMs: 5000 });
    assert.equal(panel.runtimeId, panel.accessBootstrap.runtimeId);
    const value = assertProjection(app, await app.watch(panel.capability));
    assert.equal(value.wire, "signed-out");
    assert.equal(value.retained, false);
    const core = await app.lifecycle.status(), status = (await app.api(panel.capability, "/api/access/status")).body;
    assert.equal(value.authorizationRevision, core.authorizationRevision);
    assert.equal(status.authorizationRevision, value.authorizationRevision);
    assert.equal(status.runtimeId, value.runtimeId);
    assert.equal(status.mode, "enforced");
    assert.equal(status.maxWaitMs, 1000);
    assert.equal(status.freshnessMs, 5000);
    assert.equal((await app.api(panel.capability, "/api/state")).code, 403);
    await app.command(panel.capability, "wire-sign-in");
    const privateResponse = await app.api(panel.capability, "/api/state");
    assert.equal(privateResponse.code, 200);
    assert.equal(privateResponse.headers.get("x-wire-runtime"), app.runtime.runtimeId);
    assert.equal(Number(privateResponse.headers.get("x-wire-generation")), (await app.lifecycle.status()).generation);
});

test("control observer seeds synchronously and Pause wakes watchers without revoking retained reads or previews", async t => {
    const app = await fixture(t), panel = await app.panel();
    await app.command(panel.capability, "wire-sign-in");
    const lease = await app.access.read("synthetic-watch-owner"), revocations = [], observed = [];
    const stopRevocations = app.access.subscribe(value => revocations.push(value));
    const stopControl = app.access.subscribeControl(value => observed.push(value));
    t.after(() => { stopRevocations(); stopControl(); lease.release(); });
    assert.equal(observed.length, 1);
    assert.equal(Object.isFrozen(observed[0]), true);
    const preview = await app.api(panel.capability, "/api/preview", { options: { formats: ["html"] },
        selection: { kind: "all", revision: (await loadBoardState(app.context)).revision } });
    assert.equal(preview.code, 200);
    const initial = (await app.watch(panel.capability)).body;
    const { pending } = await startWatch(app, panel.capability, cursor(initial));
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    const paused = assertProjection(app, await pending);
    assert.ok(paused.authorizationRevision > initial.authorizationRevision);
    assert.equal(paused.generation, initial.generation);
    assert.equal(paused.collection, "paused");
    assert.equal(paused.retained, true);
    assert.equal(lease.signal.aborted, false);
    assert.equal(revocations.length, 0);
    assert.equal(observed.at(-1).collection, "paused");
    assert.equal((await app.api(panel.capability, "/api/privacy-review", {
        previewId: preview.body.previewId, disclosureReviewed: true,
    })).code, 200);
});

test("an idle panel wakes for signout and a missed signout/signin pair cannot reuse its readable generation", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a.capability, "wire-sign-in");
    const old = (await app.watch(a.capability)).body;
    const { pending } = await startWatch(app, a.capability, cursor(old));
    await app.command(b.capability, "wire-sign-out");
    const revoked = assertProjection(app, await pending);
    assert.equal(revoked.retained, false);
    assert.equal(revoked.wire, "signed-out");
    await app.command(b.capability, "wire-sign-in");
    const recovered = assertProjection(app, await app.watch(a.capability, cursor(old)));
    assert.equal(recovered.retained, true);
    assert.ok(recovered.generation > old.generation);
    assert.ok(recovered.authorizationRevision > revoked.authorizationRevision);
    assert.equal((await app.api(a.capability, "/api/state")).code, 200);
});

test("matching revision returns a current bounded heartbeat without inventing an authorization revision", async t => {
    const app = await fixture(t), panel = await app.panel();
    const seed = (await app.watch(panel.capability)).body, start = performance.now();
    const value = assertProjection(app, await app.watch(panel.capability, cursor(seed)));
    assert.ok(performance.now() - start >= 900, "A matching cursor must wait rather than spin.");
    assert.deepEqual(value, seed);
    assert.deepEqual((await app.watch(panel.capability)).body, seed);
});

test("watch replacement and disconnection detach only delivery; existing owner receipts remain readable", async t => {
    const app = await fixture(t), panel = await app.panel();
    const operation = await app.command(panel.capability, "wire-sign-in");
    const seed = (await app.watch(panel.capability)).body;
    const first = await startWatch(app, panel.capability, cursor(seed));
    const second = await startWatch(app, panel.capability, cursor(seed));
    assert.equal((await first.pending).body.code, "wire_access_watch_replaced");
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    assert.equal((await second.pending).body.collection, "paused");
    const next = (await app.watch(panel.capability)).body, controller = new AbortController();
    const lost = await startWatch(app, panel.capability, cursor(next), { signal: controller.signal });
    controller.abort();
    await assert.rejects(lost.pending, { name: "AbortError" });
    await app.lifecycle.updateCollection({ paused: false, windowDays: 30 });
    assert.equal((await app.watch(panel.capability)).body.collection, "enabled");
    const receipt = await app.api(panel.capability, "/api/access/receipt", {
        schemaVersion: 1, operationId: operation.operation.operationId,
    });
    assert.deepEqual(receipt.body, operation.body);
    assert.equal((await app.api(panel.capability, "/api/state")).code, 200);
});

test("automatic watch requests never renew capability TTL; expiry terminates its pending watch", async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const app = await fixture(t, { sessionTtlMs: 500 }), panel = await app.panel();
    for (let index = 0; index < 4; index++) {
        now += 100;
        assert.equal((await app.watch(panel.capability)).code, 200);
    }
    now += 100;
    assert.equal((await app.watch(panel.capability)).body.code, "session_expired");
    const replacement = await app.panel(), seed = (await app.watch(replacement.capability)).body;
    const { pending } = await startWatch(app, replacement.capability, cursor(seed));
    now += 500;
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    const expired = await pending;
    assert.equal(expired.code, 403);
    assert.equal(expired.body.code, "session_expired");
    assert.equal((await app.api(replacement.capability, "/api/access/status")).code, 403);
});

test("capability release ends a watch but another panel and fresh signed-out control remain usable", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    const seed = (await app.watch(a.capability)).body, { pending } = await startWatch(app, a.capability, cursor(seed));
    assert.equal((await app.api(a.capability, "/api/session/release", {})).code, 200);
    assert.equal((await pending).body.code, "session_expired");
    assert.equal((await app.watch(b.capability)).body.retained, false);
    const c = await app.panel();
    assert.equal((await app.watch(c.capability)).body.retained, false);
    assert.equal((await app.api(c.capability, "/api/state")).code, 403);
});

test("watch validates exact schema, origin, method and cursor without replacing a valid pending read", async t => {
    const app = await fixture(t), panel = await app.panel(), seed = (await app.watch(panel.capability)).body;
    for (const input of [null, {}, [], { schemaVersion: 1 }, { schemaVersion: 2, after: null },
        { schemaVersion: 1, after: null, owner: "forged" }, { schemaVersion: 1, after: {} },
        { schemaVersion: 1, after: { ...cursor(seed), generation: 0 } },
        { schemaVersion: 1, after: { runtimeId: [seed.runtimeId], authorizationRevision: 0 } },
        { schemaVersion: 1, after: { runtimeId: seed.runtimeId, authorizationRevision: -1 } },
        { schemaVersion: 1, after: { runtimeId: seed.runtimeId, authorizationRevision: 1.5 } }]) {
        assert.ok([400, 422].includes((await app.api(panel.capability, "/api/access/watch", input)).code));
    }
    assert.equal((await app.api(panel.capability, "/api/access/watch")).code, 405);
    assert.equal((await app.api(null, "/api/access/watch", { schemaVersion: 1, after: null })).code, 403);
    assert.equal((await app.watch(panel.capability, null, { headers: { Origin: "https://foreign.invalid" } })).code, 403);
    assert.equal((await app.watch(panel.capability, null, { headers: { "Content-Type": "text/plain" } })).code, 415);
    const { pending } = await startWatch(app, panel.capability, cursor(seed));
    const future = await app.watch(panel.capability, { runtimeId: seed.runtimeId, authorizationRevision: seed.authorizationRevision + 10 });
    assert.equal(future.body.code, "wire_access_watch_future");
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    assert.equal((await pending).body.collection, "paused");
    assert.equal((await app.watch(panel.capability, { runtimeId: randomUUID(), authorizationRevision: 9999 })).code, 200);
});

test("runtime close terminates delivery and restart uses a fresh incarnation with the durable signed-out gate", async t => {
    const app = await fixture(t), panel = await app.panel();
    await app.command(panel.capability, "wire-sign-in");
    await app.command(panel.capability, "wire-sign-out");
    const seed = (await app.watch(panel.capability)).body, { pending } = await startWatch(app, panel.capability, cursor(seed));
    const restarting = app.restart();
    assert.equal((await pending).body.code, "wire_access_runtime_closed");
    await restarting;
    const fresh = await app.panel(), value = assertProjection(app, await app.watch(fresh.capability, cursor(seed)));
    assert.notEqual(value.runtimeId, seed.runtimeId);
    assert.equal(value.wire, "signed-out");
    assert.equal(value.retained, false);
    assert.equal((await app.watch(panel.capability)).code, 403);
});

test("facade closure fails control delivery closed and never relabels an enforced runtime as unbound", async t => {
    const app = await fixture(t), panel = await app.panel(), seed = (await app.watch(panel.capability)).body;
    const { pending } = await startWatch(app, panel.capability, cursor(seed));
    app.access.close();
    assert.equal((await pending).body.code, "wire_access_control_unavailable");
    assert.equal((await app.api(panel.capability, "/api/access/status")).code, 503);
    const renewed = await app.panel();
    assert.equal(renewed.accessBootstrap.mode, "enforced");
    assert.equal((await app.watch(renewed.capability)).code, 503);
});

test("watch revalidates a released capability after delayed request body parsing", async t => {
    const app = await fixture(t), panel = await app.panel(), body = JSON.stringify({ schemaVersion: 1, after: null });
    const origin = new URL(app.runtime.url).origin, received = Promise.withResolvers(), ended = Promise.withResolvers();
    const observe = req => { if (req.url === "/api/access/watch") received.resolve(); };
    app.runtime.server.on("request", observe);
    const request = httpRequest(origin + "/api/access/watch", { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "X-Board-Capability": panel.capability,
    } }, async response => {
        try {
            let text = ""; for await (const chunk of response) text += chunk;
            ended.resolve({ code: response.statusCode, body: JSON.parse(text) });
        } catch (error) { ended.reject(error); }
    });
    request.on("error", ended.reject);
    t.after(() => { request.destroy(); app.runtime.server.off("request", observe); });
    request.write(body.slice(0, 1)); await received.promise;
    await app.api(panel.capability, "/api/session/release", {});
    request.end(body.slice(1));
    assert.equal((await ended.promise).body.code, "session_expired");
});

test("a change during body parsing is in the first snapshot, not lost between a status read and subscription", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel(), old = (await app.watch(a.capability)).body;
    const body = JSON.stringify({ schemaVersion: 1, after: cursor(old) });
    const origin = new URL(app.runtime.url).origin, received = Promise.withResolvers(), ended = Promise.withResolvers();
    const observe = req => { if (req.url === "/api/access/watch") received.resolve(); };
    app.runtime.server.on("request", observe);
    const request = httpRequest(origin + "/api/access/watch", { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "X-Board-Capability": a.capability,
    } }, async response => {
        try {
            let text = ""; for await (const chunk of response) text += chunk;
            ended.resolve({ code: response.statusCode, body: JSON.parse(text) });
        } catch (error) { ended.reject(error); }
    });
    request.on("error", ended.reject);
    t.after(() => { request.destroy(); app.runtime.server.off("request", observe); });
    request.write(body.slice(0, 1)); await received.promise;
    await app.command(b.capability, "wire-sign-in");
    request.end(body.slice(1));
    const result = await ended.promise;
    assert.equal(result.code, 200);
    assert.equal(result.body.retained, true);
    assert.equal(result.body.authorizationRevision, (await app.lifecycle.status()).authorizationRevision);
    assert.ok(result.body.generation > old.generation);
});

test("watch notification preserves committed mutation uncertainty and original same-owner control receipts", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    const signedIn = await app.command(a.capability, "wire-sign-in");
    const bundles = [];
    for (let index = 0; index < 2; index++) {
        const preview = await app.api(a.capability, "/api/preview", { options: { formats: ["html", "json"] },
            selection: { kind: "all", revision: (await loadBoardState(app.context)).revision } });
        assert.equal(preview.code, 200);
        await app.api(a.capability, "/api/privacy-review", { previewId: preview.body.previewId, disclosureReviewed: true });
        const saved = await app.api(a.capability, "/api/export", { previewId: preview.body.previewId, confirmed: true });
        assert.equal(saved.code, 200); bundles.push(saved.body.bundle);
    }
    const preview = await app.api(a.capability, "/api/report-comparison/preview", {
        baselineId: bundles[0].bundleId, laterId: bundles[1].bundleId, formats: ["html"],
    });
    assert.equal(preview.code, 200);
    await app.api(a.capability, "/api/report-comparison/review", { previewId: preview.body.previewId, disclosureReviewed: true });
    const entered = Promise.withResolvers(), resume = Promise.withResolvers(), original = app.runtime.collector.status.bind(app.runtime.collector);
    t.mock.method(app.runtime.collector, "status", async (...args) => {
        const result = await original(...args); entered.resolve(); await resume.promise; return result;
    });
    const seed = (await app.watch(a.capability)).body;
    const { pending: watching } = await startWatch(app, a.capability, cursor(seed));
    const save = app.api(a.capability, "/api/report-comparison/save", { previewId: preview.body.previewId, confirmed: true });
    await entered.promise;
    assert.equal((await loadBoardState(app.context)).exports.length, 3);
    await app.command(b.capability, "wire-sign-out");
    assert.equal((await watching).body.retained, false);
    resume.resolve();
    const result = await save;
    assert.equal(result.code, 409);
    assert.equal(result.body.code, "wire_access_outcome_unknown");
    assert.equal(result.body.outcome, "unknown");
    assert.equal(result.headers.get("x-wire-runtime"), null);
    const receiptInput = { schemaVersion: 1, operationId: signedIn.operation.operationId };
    assert.deepEqual((await app.api(a.capability, "/api/access/receipt", receiptInput)).body, signedIn.body);
    assert.equal((await app.api(b.capability, "/api/access/receipt", receiptInput)).code, 403);
    assert.equal((await loadBoardState(app.context)).exports.length, 3);
    assert.equal((await app.api(a.capability, "/api/report-artifacts/list", {})).code, 403);
});

test("failed watch delivery cannot poison lifecycle authorization or another panel's watch", async t => {
    const app = await fixture(t), a = await app.panel(), b = await app.panel();
    await app.command(a.capability, "wire-sign-in");
    const errors = [];
    t.mock.method(console, "error", (...values) => errors.push(values));
    const failDelivery = (req, res) => {
        if (req.url === "/api/access/watch" && req.headers["x-watch-fixture-failure"] === "once") {
            res.writeHead = () => { throw new Error("Invented delivery failure with private details"); };
        }
    };
    app.runtime.server.on("request", failDelivery);
    t.after(() => app.runtime.server.off("request", failDelivery));
    const seed = (await app.watch(a.capability)).body;
    const broken = await startWatch(app, a.capability, cursor(seed), { headers: { "X-Watch-Fixture-Failure": "once" } });
    const rejected = assert.rejects(broken.pending, TypeError);
    const healthy = await startWatch(app, b.capability, cursor(seed));
    await app.lifecycle.updateCollection({ paused: true, windowDays: 30 });
    await rejected;
    assert.equal((await healthy.pending).body.retained, true);
    assert.equal((await app.lifecycle.status()).authorization.retained, true);
    assert.deepEqual(errors, [["[workiq-runtime] access watch delivery failed", { code: "ACCESS_WATCH_DELIVERY_FAILED" }]]);
    assert.equal((await app.watch(a.capability)).code, 200);
});

test("real lifecycle storage poisoning notifies effective retained:false without fabricating durable signout or unbound mode", async t => {
    let fail = false;
    const app = await fixture(t, { expectedCloseError: "storage-failed", storage: context => {
        const actual = sessionStorage(context);
        return { ...actual, async write(value) {
            if (fail) throw new Error("Invented private storage failure");
            return actual.write(value);
        } };
    } });
    const a = await app.panel(), b = await app.panel();
    await app.command(a.capability, "wire-sign-in");
    const seed = (await app.watch(a.capability)).body;
    const { pending } = await startWatch(app, a.capability, cursor(seed));
    fail = true;
    const failure = await app.command(b.capability, "wire-sign-out");
    assert.equal(failure.body.code, "wire_access_storage_failed");
    const poisoned = assertProjection(app, await pending);
    assert.equal(poisoned.wire, "signed-in", "A failed durable write is not successful signout.");
    assert.equal(poisoned.retained, false, "Effective access, not the durable intent label, governs publication.");
    assert.equal(poisoned.generation, seed.generation);
    assert.ok(poisoned.authorizationRevision > seed.authorizationRevision);
    assert.equal((await app.api(a.capability, "/api/state")).body.code, "wire_access_storage_failed");
    assert.equal((await app.panel()).accessBootstrap.mode, "enforced");
    assert.equal((await app.watch(a.capability)).body.retained, false);
});

test("invalid explicit binding cannot boot a success-shaped unbound runtime", async t => {
    const app = await fixture(t, { bound: false });
    await assert.rejects(startServer(app.context, app.exports, {
        port: 0, collector: { timers: false }, access: { enabled: true },
    }), { code: "wire_access_untrusted_binding" });
    await assert.rejects(startServer(app.context, app.exports, {
        port: 0, collector: { timers: false }, access: null,
    }), { code: "wire_access_untrusted_binding" });
});

test("a pending native-timer watch expires at the original capability deadline without another request or event", async t => {
    const app = await fixture(t, { sessionTtlMs: 200 }), panel = await app.panel();
    const seed = (await app.watch(panel.capability)).body;
    const result = await app.watch(panel.capability, cursor(seed));
    assert.equal(result.code, 403);
    assert.equal(result.body.code, "session_expired");
    const fresh = await app.panel();
    assert.equal((await app.watch(fresh.capability)).body.retained, false);
});
