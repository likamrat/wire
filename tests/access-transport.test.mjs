import test from "node:test";
import assert from "node:assert/strict";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { SESSION_REASONS } from "../lib/microsoft-session-state.mjs";

const runtimeId = "00000000-0000-4000-8000-000000000001";
const capability = "a".repeat(64);
const bootstrap = { schemaVersion: 1, mode: "enforced", runtimeId, maxWaitMs: 1000, freshnessMs: 5000 };
const unbound = { schemaVersion: 1, mode: "unbound", runtimeId };
const seed = (changes = {}) => ({ ...bootstrap, authorizationRevision: 0, generation: 0,
    wire: "signed-out", retained: false, collection: "enabled", ...changes });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("enforced first false or absent grant sends no private request; only explicit unbound preserves legacy reads", async t => {
    const paths = [];
    t.mock.method(globalThis, "fetch", async path => {
        paths.push(path);
        return Response.json(path === "/api/access/watch" ? seed() : { private: true });
    });

    for (const descriptor of [undefined, null, {}, { ...bootstrap, schemaVersion: 2 }, { ...bootstrap, extra: true }, bootstrap]) {
        const api = createBoardTransport(capability, () => {}, descriptor);
        await assert.rejects(api("/api/snapshot", {}), error => error.reason === "wire_access_unavailable");
    }
    assert.deepEqual(paths, []);
    const api = createBoardTransport(capability, () => {}, unbound);
    assert.deepEqual(await api("/api/snapshot", {}), { private: true });
    assert.deepEqual(paths, ["/api/snapshot"]);
});

function watched(t, privateRequest, accessBootstrap = bootstrap) {
    const watches = [], requests = [], events = [];
    t.mock.method(globalThis, "fetch", (path, options) => {
        requests.push({ path, options });
        if (path === "/api/access/watch") {
            const pending = Promise.withResolvers();
            watches.push({ ...pending, input: JSON.parse(options.body), options });
            options.signal.addEventListener("abort", () => pending.reject(options.signal.reason), { once: true });
            return pending.promise;
        }

        if (privateRequest) return privateRequest(path, options);
        return Promise.resolve(Response.json({ private: "current" },
            { headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" } }));
    });
    const api = createBoardTransport(capability, () => {}, accessBootstrap);
    api.subscribeAccess(value => events.push(value));
    api.startAccess();
    t.after(() => api.suspendAccess());
    return { api, watches, requests, events, async respond(value) {
        watches.at(-1).resolve(Response.json(value));
        await tick();
    } };
}

test("native save refusal requires the exact original request and never overrides unknown or withdrawn outcomes", async t => {
    const refusal = { outcome: "not-published", kind: "report", previewId: "original-preview",
        bundleId: "export-00000000-0000-4000-8000-000000000001" };
    let response = { error: "Guarded publication refused.", reportSave: refusal };
    const app = watched(t, () => Promise.resolve(Response.json(response,
        { status: 409, headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" } })));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    await assert.rejects(app.api("/api/export", { previewId: refusal.previewId, confirmed: true }), error => {
        assert.deepEqual(error.reportSave, refusal);
        assert.notEqual(error.code, "request_rejected", "Only the report owner can match the original bundle identity.");
        return true;
    });
    for (const value of [
        { error: "Generic conflict." },
        { reportSave: { ...refusal, previewId: "another-preview" } },
        { reportSave: { ...refusal, unexpected: true } },
        { reportSave: refusal, outcome: "unknown" },
    ]) {
        response = value;
        await assert.rejects(app.api("/api/export", { previewId: refusal.previewId, confirmed: true }), error => {
            assert.equal(error.reportSave, undefined);
            assert.notEqual(error.code, "request_rejected");
            return true;
        });
    }
    response = { reportSave: refusal };
    await assert.rejects(app.api("/api/preview", { previewId: refusal.previewId }), error => error.reportSave === undefined);
    await app.respond(seed({ retained: false }));
    await assert.rejects(app.api("/api/export", { previewId: refusal.previewId, confirmed: true }), error => error.reportSave === undefined);
});

test("source-aware collection activates only from an enforced bootstrap and matching watch", async t => {
    const app = watched(t, undefined, { ...bootstrap, collectionMode: "source-aware" });
    assert.equal(app.api.accessState().collectionMode, "source-aware");
    assert.equal(app.api.publicationToken(), null);
    await app.respond(seed({ retained: true, wire: "signed-in", collectionMode: "source-aware" }));
    assert.ok(app.api.publicationToken());
    assert.deepEqual(await app.api("/api/snapshot", {}), { private: "current" });
});

test("source-aware renewal cannot silently downgrade collection authority", async t => {
    for (const nextRuntime of [runtimeId, "00000000-0000-4000-8000-000000000009"]) {
        const app = watched(t, path => Promise.resolve(path === "/api/session"
            ? Response.json({ capability: "b".repeat(64), runtimeId: nextRuntime,
                accessBootstrap: { ...bootstrap, runtimeId: nextRuntime } })
            : Response.json({ code: "session_expired" }, { status: 403 })),
        { ...bootstrap, collectionMode: "source-aware" });
        await app.respond(seed({ retained: true, wire: "signed-in", collectionMode: "source-aware" }));
        await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
        assert.equal(app.api.accessState().collectionMode, "source-aware");
        assert.equal(app.api.publicationToken(), null);
        assert.equal(app.api.controlToken(), null);
        app.api.suspendAccess();
    }
});

test("source-aware marker loss or mutation withdraws the runtime instead of falling back", async t => {
    for (const marker of [undefined, null, false, "native-only"]) {
        const app = watched(t, undefined, { ...bootstrap, collectionMode: "source-aware" });
        await app.respond(seed({ retained: true, wire: "signed-in", collectionMode: "source-aware" }));
        const token = app.api.publicationToken();
        await app.respond(seed({ retained: true, wire: "signed-in", authorizationRevision: 1,
            ...(marker === undefined ? {} : { collectionMode: marker }) }));
        assert.equal(app.api.isCurrent(token), false);
        assert.equal(app.api.accessState().collectionMode, "source-aware");
        await assert.rejects(app.api("/api/collection/configure", {}), { code: "request_rejected" });
        app.api.suspendAccess();
    }
    for (const value of [{ ...unbound, collectionMode: "source-aware" }, { ...bootstrap, collectionMode: null }]) {
        const api = createBoardTransport(capability, () => {}, value);
        assert.equal(api.accessState().mode, "unavailable");
        assert.equal(api.controlToken(), null);
    }
});

test("source-aware status routes remain abortable reads rather than unknown mutations", async t => {
    const pending = [];
    const app = watched(t, (path, options) => {
        const held = Promise.withResolvers();
        pending.push({ ...held, options });
        options.signal.addEventListener("abort", () => held.reject(options.signal.reason), { once: true });
        return held.promise;
    }, { ...bootstrap, collectionMode: "source-aware" });
    await app.respond(seed({ retained: true, wire: "signed-in", collectionMode: "source-aware" }));
    const assertions = ["/api/collection/sources/status", "/api/collection/microsoft/status", "/api/collection/microsoft/enrollment",
        "/api/retained/microsoft/query", "/api/retained/microsoft/detail", "/api/retained/microsoft/search",
        "/api/retained/microsoft/readback", "/api/retained/microsoft/inventory",
        "/api/retained/microsoft/drilldown", "/api/retained/microsoft/analyze", "/api/artifact-deletion/eligibility"].map(path =>
        assert.rejects(app.api(path, {}), { reason: "wire_access_stale" }));
    try {
        app.api.suspendAccess();
        assert.ok(pending.every(call => call.options.signal.aborted));
    } finally {
        for (const call of pending) call.resolve(Response.json({}, { headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" } }));
        await Promise.all(assertions);
    }
});

test("explicit Microsoft routes preserve existing mutation deadlines without changing global control timing", async t => {
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", milliseconds => {
        deadlines.push(milliseconds);
        return new AbortController().signal;
    });
    const app = watched(t, undefined, { ...bootstrap, collectionMode: "source-aware" });
    await app.respond(seed({ retained: true, wire: "signed-in", collectionMode: "source-aware" }));
    for (const path of ["/api/collection/microsoft/configure", "/api/collection/microsoft/now", "/api/collection/global/enabled",
        "/api/retained/microsoft/query", "/api/retained/microsoft/detail", "/api/retained/microsoft/search", "/api/retained/microsoft/readback",
        "/api/retained/microsoft/inventory", "/api/retained/microsoft/drilldown", "/api/retained/microsoft/analyze",
        "/api/artifact-deletion/eligibility"]) {
        await app.api(path, {});
    }
    assert.deepEqual(deadlines, [120000, 120000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]);
});

test("one seeded watch admits reading; Pause preserves a publication token and idle sign-out withdraws it", async t => {
    const app = watched(t);
    assert.equal(app.watches.length, 1);
    assert.deepEqual(app.watches[0].input, { schemaVersion: 1, after: null });
    await app.respond(seed());
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_unavailable" });
    assert.equal(app.requests.filter(request => request.path !== "/api/access/watch").length, 0);
    await app.respond(seed({ authorizationRevision: 1, retained: true, wire: "signed-in" }));
    const token = app.api.publicationToken();
    assert.ok(token);
    assert.deepEqual(await app.api("/api/snapshot", {}), { private: "current" });
    await app.respond(seed({ authorizationRevision: 2, retained: true, wire: "signed-in", collection: "paused" }));
    assert.equal(app.api.isCurrent(token), true);
    assert.deepEqual(app.watches.at(-1).input.after, { runtimeId, authorizationRevision: 2 });
    await app.respond(seed({ authorizationRevision: 3 }));
    assert.equal(app.api.isCurrent(token), false);
    assert.equal(app.api.publicationToken(), null);
    assert.equal(app.events.at(-1).readable, false);
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_unavailable" });
});

test("native connection descriptors retain readable access across equal independently decoded watches", async t => {
    const app = watched(t);
    const value = seed({ retained: true, wire: "signed-in",
        microsoft: { state: "disconnected", reason: null, actions: ["microsoft-connect"] } });
    await app.respond(value);
    const token = app.api.publicationToken();
    assert.ok(token);
    await app.respond(structuredClone(value));
    assert.equal(app.api.isCurrent(token), true);
    const current = app.api.accessState().state.microsoft;
    assert.deepEqual(current, value.microsoft);
    assert.ok(Object.isFrozen(current));
    assert.ok(Object.isFrozen(current.actions));
});

test("native watch descriptors reject private fields and cannot change within one authorization revision", async t => {
    const app = watched(t);
    const microsoft = { state: "connected", reason: null, actions: ["microsoft-connect"] };
    for (const value of [null, { ...microsoft, partition: "private" }, { ...microsoft, reason: "unknown-reason" },
        { ...microsoft, actions: ["microsoft-connect", "microsoft-connect"] },
        { ...microsoft, actions: ["collect-now"] }, { ...microsoft, state: "invented" }]) {
        assert.throws(() => app.api.decodeMicrosoftConnection(value), TypeError);
    }
    await app.respond(seed({ retained: true, wire: "signed-in", microsoft }));
    const token = app.api.publicationToken();
    await app.respond(seed({ retained: true, wire: "signed-in", microsoft: { ...microsoft, actions: [] } }));
    assert.equal(app.api.isCurrent(token), false);
    assert.equal(app.api.accessState().readable, false);
});

test("a newer watch that removes native controls does not retain their old capability projection", async t => {
    const app = watched(t);
    await app.respond(seed({ retained: true, wire: "signed-in",
        microsoft: { state: "disconnected", reason: null, actions: ["microsoft-connect"] } }));
    await app.respond(seed({ authorizationRevision: 1, retained: true, wire: "signed-in" }));
    assert.equal(app.api.accessState().readable, true);
    assert.equal(app.api.accessState().state.microsoft, undefined);
});

test("native control receipt decoding is exact-operation and same-account, with the backend reason vocabulary", () => {
    const api = createBoardTransport(capability, () => {}, bootstrap);
    for (const reason of SESSION_REASONS) {
        assert.equal(api.decodeMicrosoftConnection({ state: "unavailable", reason, actions: [] }).reason, reason);
    }
    const operation = { id: runtimeId, action: "microsoft-connect", generation: 1 };
    const receipt = { operationId: runtimeId, action: operation.action, generation: 2,
        outcome: "completed", reason: null, revocation: null };
    assert.deepEqual(api.decodeMicrosoftReceipt(receipt, operation), receipt);
    for (const invalid of [
        { ...receipt, operationId: "00000000-0000-4000-8000-000000000002" },
        { ...receipt, action: "microsoft-recover" }, { ...receipt, generation: 1 },
        { ...receipt, revocation: { scope: "microsoft-account", partition: "private" } },
        { ...receipt, reason: "unknown-reason" }, { ...receipt, owner: "private" },
    ]) assert.throws(() => api.decodeMicrosoftReceipt(invalid, operation), TypeError);
});

test("request-start freshness expires at 5000 even with held timers and delayed watch delivery", async t => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const app = watched(t);
    now = 4999;
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const original = app.api.publicationToken();
    assert.ok(original, "4999ms is still current");
    const delayed = app.watches.at(-1);
    now = 5000;
    assert.equal(app.api.isCurrent(original), false, "5000ms retires without a timer callback");
    now = 5001;
    delayed.resolve(Response.json(seed({ retained: true, wire: "signed-in" })));
    await tick();
    assert.equal(app.api.publicationToken(), null);
    assert.deepEqual(app.watches.at(-1).input.after, null);
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    assert.ok(app.api.publicationToken(), "new seed may recover the same backend generation");
    assert.equal(app.api.isCurrent(original), false, "same generation never revives the old local token");
    const late = app.watches.at(-1);
    now = 10001;
    late.resolve(Response.json(seed({ retained: true, wire: "signed-in" })));
    await tick();
    assert.equal(app.api.publicationToken(), null);
});

test("withdrawal aborts reads and fences held decoding; a dispatched write stays unknown with no replay", async t => {
    const bodies = [], started = [];
    const app = watched(t, (path, options) => {
        const body = Promise.withResolvers();
        bodies.push(body); started.push({ path, signal: options.signal });
        return Promise.resolve({ ok: true, status: 200,
            headers: new Headers({ "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" }),
            json: () => body.promise });
    });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const read = app.api("/api/snapshot", {});
    const write = app.api("/api/export", { previewId: "original", confirmed: true });
    const readCheck = assert.rejects(read, { reason: "wire_access_stale" });
    const writeCheck = assert.rejects(write, { code: "request_outcome_unknown", outcome: "unknown" });
    await tick();
    await app.respond(seed({ authorizationRevision: 1, generation: 1 }));
    assert.equal(started[0].signal.aborted, true);
    for (const body of bodies) body.resolve({ private: "retired" });
    await Promise.all([readCheck, writeCheck]);
    await app.respond(seed({ authorizationRevision: 2, generation: 2, retained: true, wire: "signed-in" }));
    assert.deepEqual(started.map(call => call.path), ["/api/snapshot", "/api/export"]);
});

test("capability replacement closes publication before renewal and never retries the retired private call", async t => {
    const renewal = Promise.withResolvers();
    let app;
    app = watched(t, path => {
        if (path === "/api/session") {
            assert.equal(app.api.publicationToken(), null, "renewal must begin after withdrawal");
            return renewal.promise;
        }
        return Promise.resolve(Response.json({ code: "session_expired" }, { status: 403 }));
    });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const original = app.api.publicationToken();
    const pending = app.api("/api/snapshot", {});
    const rejected = assert.rejects(pending, { reason: "wire_access_stale" });
    await tick();
    renewal.resolve(Response.json({ capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap }));
    await rejected;
    await tick();
    assert.equal(app.api.publicationToken(), null);
    assert.deepEqual(app.watches.at(-1).input.after, null);
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    assert.ok(app.api.publicationToken());
    assert.equal(app.api.isCurrent(original), false);
    assert.equal(app.requests.filter(request => request.path === "/api/snapshot").length, 1);
    assert.equal(app.watches.at(-1).options.headers["X-Board-Capability"], "b".repeat(64));
});

test("Search is gated before streaming and each buffered event is fenced after withdrawal", { timeout: 1000 }, async t => {
    let stream;
    const app = watched(t, () => Promise.resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } }),
        { headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" } })));
    const signal = new AbortController().signal;
    await assert.rejects(app.api.searchEvents(() => {}, { signal, schemaVersion: 3 }), { reason: "wire_access_unavailable" });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const events = [];
    const pending = app.api.searchEvents(event => {
        events.push(event);
        app.api.suspendAccess();
    }, { signal, schemaVersion: 3 });
    const rejected = assert.rejects(pending, { reason: "wire_access_stale" });
    await tick();
    stream.enqueue(new TextEncoder().encode('{"event":"first"}\n{"event":"retired"}\n'));
    await rejected;
    assert.deepEqual(events, [{ event: "first" }]);
    assert.equal(app.requests.filter(request => request.path === "/api/search/events").length, 1);
});

test("the dispatch guard runs after request preparation and never queues a refused call for readiness", async t => {
    const app = watched(t);
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    await assert.rejects(app.api("/api/export", { toJSON() {
        app.api.suspendAccess();
        return { previewId: "retired", confirmed: true };
    } }), { reason: "wire_access_unavailable", code: "request_rejected" });
    app.api.startAccess();
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    assert.equal(app.requests.filter(request => request.path === "/api/export").length, 0);
});

test("strict renewal rejects runtime disagreement and enforced downgrade without installing private authority", async t => {
    for (const invalid of [
        { capability: "b".repeat(64), runtimeId: "00000000-0000-4000-8000-000000000002", accessBootstrap: bootstrap },
        { capability: "b".repeat(64), runtimeId, accessBootstrap: unbound },
        { capability: "b".repeat(64), runtimeId: "00000000-0000-4000-8000-000000000002",
            accessBootstrap: { ...unbound, runtimeId: "00000000-0000-4000-8000-000000000002" } },
        { capability: "b".repeat(64), runtimeId, accessBootstrap: { ...bootstrap, freshnessMs: 5001 } },
        { capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap, extra: true },
    ]) {
        const app = watched(t, path => Promise.resolve(Response.json(path === "/api/session" ? invalid : { code: "session_expired" },
            path === "/api/session" ? {} : { status: 403 })));
        await app.respond(seed({ retained: true, wire: "signed-in" }));
        await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
        assert.equal(app.api.publicationToken(), null);
        assert.equal(app.requests.filter(request => request.path === "/api/snapshot").length, 1);
        app.api.suspendAccess();
    }
});

test("a revoked read retires other held reads before the next watch, including retained old generation", async t => {
    const held = Promise.withResolvers();
    const app = watched(t, path => path === "/api/snapshot" ? held.promise
        : Promise.resolve(Response.json({ code: "wire_access_revoked" }, { status: 403 })));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const token = app.api.publicationToken(), pending = app.api("/api/snapshot", {});
    const rejected = assert.rejects(pending, { reason: "wire_access_stale" });
    await assert.rejects(app.api("/api/state"), { reason: "wire_access_stale" });
    assert.equal(app.api.isCurrent(token), false);
    held.resolve(Response.json({ private: "old" }, { headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "0" } }));
    await rejected;
    await tick();
    await app.respond(seed({ authorizationRevision: 1, retained: true, wire: "signed-in" }));
    assert.equal(app.api.publicationToken(), null, "an explicitly revoked readable generation cannot be resurrected");
});

test("a replacement runtime needs its own fresh seed even when its numeric generation is identical", async t => {
    const replacement = "00000000-0000-4000-8000-000000000002";
    const app = watched(t, path => Promise.resolve(path === "/api/session"
        ? Response.json({ capability: "b".repeat(64), runtimeId: replacement, accessBootstrap: { ...bootstrap, runtimeId: replacement } })
        : Response.json({ code: "session_expired" }, { status: 403 })));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const original = app.api.publicationToken();
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
    await tick();
    assert.equal(app.api.publicationToken(), null);
    await app.respond(seed({ runtimeId: replacement, retained: true, wire: "signed-in" }));
    assert.equal(app.api.publicationToken().runtimeId, replacement);
    assert.equal(app.api.isCurrent(original), false);
});

test("private response stamps and decreasing control counters fail closed before private decoding", async t => {
    let decoded = false;
    const app = watched(t, () => Promise.resolve({ ok: true, status: 200,
        headers: new Headers({ "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "999" }),
        json: async () => { decoded = true; return { private: "wrong authority" }; } }));
    await app.respond(seed({ authorizationRevision: 5, retained: true, wire: "signed-in" }));
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
    assert.equal(decoded, false);
    await tick();
    await app.respond(seed({ authorizationRevision: 4, retained: true, wire: "signed-in" }));
    assert.equal(app.api.publicationToken(), null);
});

test("validated current mode changes with a new runtime, never with an old bootstrap assumption", async t => {
    const replacement = "00000000-0000-4000-8000-000000000003", pending = Promise.withResolvers();
    t.mock.method(globalThis, "fetch", async path => {
        if (path === "/api/session") return Response.json({ capability: "b".repeat(64), runtimeId: replacement,
            accessBootstrap: { ...bootstrap, runtimeId: replacement } });
        if (path === "/api/access/watch") return pending.promise;
        return Response.json({ code: "session_expired" }, { status: 403 });
    });
    let observed;
    const api = createBoardTransport(capability, () => { observed = api.accessState().mode; }, unbound);
    t.after(() => { api.suspendAccess(); pending.resolve(Response.json(seed())); });
    const original = api.publicationToken();
    api.startAccess();
    await assert.rejects(api("/api/state"), { reason: "wire_access_stale" });
    assert.equal(observed, "enforced");
    assert.equal(api.accessState().mode, "enforced");
    assert.equal(api.isCurrent(original), false);
    assert.equal(api.publicationToken(), null);
});

test("a consumer clearance failure keeps publication closed rather than admitting a later ready state", async t => {
    const errors = [];
    t.mock.method(console, "error", (...values) => errors.push(values));
    const app = watched(t);
    let fail = false;
    app.api.subscribeAccess(change => {
        if (fail && !change.readable) { fail = false; throw new Error("Synthetic clearance failure"); }
    });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    fail = true;
    await app.respond(seed({ authorizationRevision: 1, generation: 1 }));
    assert.equal(app.api.accessState().reason, "clearance-failed");
    assert.equal(app.api.publicationToken(), null);
    const watches = app.watches.length;
    app.api.startAccess();
    await tick();
    assert.equal(app.watches.length, watches);
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_unavailable" });
    assert.equal(errors.length, 1);
});

test("original control ownership survives sign-out but cannot dispatch a receipt or replay a command under a new capability", async t => {
    const command = Promise.withResolvers();
    const app = watched(t, path => {
        if (path === "/api/access/command") return command.promise;
        if (path === "/api/session") return Promise.resolve(Response.json({ capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap }));
        return Promise.resolve(Response.json({ operationId: "original", phase: "complete" }));
    });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const original = app.api.controlToken();
    const sent = app.api("/api/access/command", { operationId: "original", action: "wire-sign-out" }, { controlToken: original });
    const unknown = assert.rejects(sent, { code: "request_outcome_unknown", outcome: "unknown", reason: "wire_control_stale" });
    await app.respond(seed({ authorizationRevision: 1, generation: 1 }));
    assert.equal(app.api.publicationToken(), null);
    assert.equal(app.api.isControlCurrent(original), true);
    assert.equal((await app.api("/api/access/receipt", { operationId: "original" }, { controlToken: original })).phase, "complete");
    app.watches.at(-1).resolve(Response.json({ code: "session_expired" }, { status: 403 }));
    await tick();
    assert.equal(app.api.isControlCurrent(original), false);
    const before = app.requests.length;
    await assert.rejects(app.api("/api/access/receipt", { operationId: "original" }, { controlToken: original }),
        { code: "request_rejected", reason: "wire_control_stale" });
    assert.equal(app.requests.length, before);
    command.resolve(Response.json({ operationId: "original", phase: "complete" }));
    await unknown;
    assert.equal(app.requests.filter(request => request.path === "/api/access/command").length, 1);
});

test("explicit unbound renewal retains legacy publication lifetime but replaces runtime metadata and control ownership", async t => {
    const replacement = "00000000-0000-4000-8000-000000000004";
    t.mock.method(globalThis, "fetch", async (path, options) => {
        if (path === "/api/session") return Response.json({ capability: "b".repeat(64), runtimeId: replacement,
            accessBootstrap: { ...unbound, runtimeId: replacement } });
        return options.headers["X-Board-Capability"] === capability
            ? Response.json({ code: "session_expired" }, { status: 403 }) : Response.json({ current: true });
    });
    const api = createBoardTransport(capability, () => {}, unbound);
    const display = api.publicationToken(), owner = api.controlToken();
    assert.deepEqual(await api("/api/snapshot", {}), { current: true });
    assert.equal(api.isCurrent(display), true);
    assert.deepEqual(Object.keys(display), [], "legacy lifetime carries no stale runtime metadata");
    assert.equal(api.accessState().runtimeId, replacement);
    assert.equal(api.isControlCurrent(owner), false);
});

test("a visibility wake during renewal cannot attach a watch to the retired capability", async t => {
    const renewed = Promise.withResolvers();
    const app = watched(t, path => {
        assert.equal(path, "/api/session");
        return renewed.promise;
    });
    t.after(() => renewed.resolve(Response.json({ capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap })));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    app.watches.at(-1).resolve(Response.json({ code: "session_expired" }, { status: 403 }));
    await tick();
    const count = app.watches.length;
    app.api.startAccess();
    assert.equal(app.watches.length, count, "renewal owns the connection until its descriptor is validated");
    renewed.resolve(Response.json({ capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap }));
    await tick();
    assert.equal(app.watches.length, count + 1);
    assert.equal(app.watches.at(-1).options.headers["X-Board-Capability"], "b".repeat(64));
    assert.equal(app.watches.at(-1).input.after, null);
});

test("failed renewal initiated by a private read recovers the watch without replaying that read", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let renewals = 0;
    const app = watched(t, path => {
        if (path === "/api/session") return ++renewals === 1
            ? Promise.reject(new TypeError("Synthetic connection loss"))
            : Promise.resolve(Response.json({ capability: "b".repeat(64), runtimeId, accessBootstrap: bootstrap }));
        return Promise.resolve(Response.json({ code: "session_expired" }, { status: 403 }));
    });
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    await assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
    assert.equal(app.api.publicationToken(), null);
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(renewals, 2);
    assert.equal(app.watches.at(-1).options.headers["X-Board-Capability"], "b".repeat(64));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    assert.ok(app.api.publicationToken());
    assert.equal(app.requests.filter(request => request.path === "/api/snapshot").length, 1);
});

test("a retained generation replacement clears first, then allows new reads without inventing WIRE sign-out", async t => {
    const held = Promise.withResolvers();
    let reads = 0;
    const app = watched(t, () => ++reads === 1 ? held.promise
        : Promise.resolve(Response.json({ current: true }, { headers: { "X-Wire-Runtime": runtimeId, "X-Wire-Generation": "1" } })));
    await app.respond(seed({ retained: true, wire: "signed-in" }));
    const previous = app.api.publicationToken();
    const retired = assert.rejects(app.api("/api/snapshot", {}), { reason: "wire_access_stale" });
    await app.respond(seed({ authorizationRevision: 1, generation: 1, retained: true, wire: "signed-in" }));
    assert.deepEqual(app.events.slice(-2).map(event => [event.readable, event.reason]),
        [[false, "generation-changed"], [true, "ready"]]);
    assert.equal(app.api.isCurrent(previous), false);
    assert.equal(app.api.accessState().state.wire, "signed-in");
    held.resolve(Response.json({ old: true }));
    await retired;
    assert.deepEqual(await app.api("/api/snapshot", {}), { current: true });
    assert.equal(reads, 2);
    assert.equal(app.requests.filter(request => request.path === "/api/access/command").length, 0);
});
