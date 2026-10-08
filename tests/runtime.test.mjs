import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { get } from "node:http";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createBoardTransport } from "../lib/client-transport.mjs";
import { createRuntimeClient } from "../lib/runtime-client.mjs";
import { logoSvg } from "../lib/branding.mjs";

const nativeFetch = globalThis.fetch;
async function fixture(t, options = {}) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workiq-runtime-fixture-"));
    const context = { dataDir, sessionId: "synthetic-runtime-test" };
    const runtime = await startServer(context, createExportController(context), { port: 0, ...options });
    t.after(async () => {
        await close(runtime);
        await rm(dataDir, { recursive: true });
    });
    return { runtime, context, origin: runtime.url.slice(0, -1) };
}
async function close(runtime) {
    if (!runtime.server.listening) return;
    await new Promise((resolve, reject) => runtime.server.close(error => error ? reject(error) : resolve()));
}
async function post(origin, route, body, capability, headers = {}) {
    return nativeFetch(origin + route, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", ...(capability ? { "X-Board-Capability": capability } : {}), ...headers },
        body: JSON.stringify(body),
    });
}
async function session(origin) {
    const result = await post(origin, "/api/session", {});
    assert.equal(result.status, 200);
    return (await result.json()).capability;
}
function browserFetch(origin, calls) {
    globalThis.fetch = (route, options) => {
        calls.push(route);
        return nativeFetch(origin + route, { ...options, headers: { ...options.headers, Origin: origin } });
    };
}

test("one snapshot revision, session isolation, host/origin protections, and close without server death", async t => {
    const { runtime, origin } = await fixture(t);
    const a = await session(origin), b = await session(origin);
    assert.notEqual(a, b);
    const state = await post(origin, "/api/snapshot", { layer: "tool", groupBy: "endpoint", filters: { scope: "history" }, limit: 10 }, a);
    assert.equal(state.status, 200);
    const snapshot = await state.json();
    assert.equal(snapshot.revision, snapshot.analytics.revision);
    assert.equal((await post(origin, "/api/session", {}, undefined, { Origin: "https://foreign.example" })).status, 403);
    assert.equal((await post(origin, "/api/session", {}, undefined, { Origin: "null" })).status, 403);
    assert.equal((await post(origin, "/api/session", {}, undefined, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post(origin, "/api/session", {}, undefined, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(origin, "/api/session/release", {}, a)).status, 200);
    const expired = await post(origin, "/api/snapshot", {}, a);
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).code, "session_expired");
    assert.equal((await nativeFetch(origin + "/api/state", { headers: { "X-Board-Capability": b } })).status, 200);
    assert.equal(runtime.server.listening, true);
});

test("duplicate runtime cannot acquire the writer endpoint", async t => {
    const { runtime, context } = await fixture(t);
    await assert.rejects(startServer(context, createExportController(context), { port: runtime.server.address().port }), { code: "EADDRINUSE" });
});

test("the approved favicon is local, host-protected and does not consume panel capabilities", async t => {
    const { origin } = await fixture(t);
    for (let index = 0; index < 130; index++) {
        const icon = await nativeFetch(origin + "/favicon.svg");
        assert.equal(icon.status, 200);
        assert.match(icon.headers.get("content-type"), /^image\/svg\+xml/);
        assert.equal(await icon.text(), logoSvg);
        assert.match(icon.headers.get("content-security-policy"), /img-src 'self';/);
    }
    assert.equal((await post(origin, "/api/session", {})).status, 200, "Icon reads do not exhaust the 128-panel limit");
    assert.equal((await nativeFetch(origin + "/favicon.svg", { headers: { Origin: "https://foreign.example" } })).status, 403);
    const foreignHostStatus = await new Promise((resolve, reject) => {
        get(origin + "/favicon.svg", { headers: { Host: "foreign.example" } }, response => {
            response.resume();
            resolve(response.statusCode);
        }).on("error", reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await nativeFetch(origin + "/assets/wire.svg")).status, 403, "No general asset directory is exposed");
    const health = await (await nativeFetch(origin + "/health")).json();
    assert.equal(health.service, "workiq-evidence", "The established runtime identity remains compatible");
    assert.equal(health.protocol, 1);
});

test("old browser capability recovers after actual server restart; mutation is never replayed", async t => {
    const { runtime, context, origin } = await fixture(t);
    const capability = await session(origin);
    let changes = 0;
    const calls = [];
    const api = createBoardTransport(capability, () => changes++);
    const port = runtime.server.address().port;
    await close(runtime);
    const replacement = await startServer(context, createExportController(context), { port });
    t.after(() => close(replacement));
    browserFetch(origin, calls);
    try {
        const result = await api("/api/snapshot", { layer: "tool", groupBy: "endpoint", filters: { scope: "history" }, limit: 10 });
        assert.equal(result.revision, result.analytics.revision);
        assert.equal(changes, 1);
        assert.deepEqual(calls, ["/api/snapshot", "/api/session", "/api/snapshot"]);
        calls.length = 0;
        const staleMutation = createBoardTransport(capability);
        await assert.rejects(staleMutation("/api/move", { scenarioId: "synthetic-only", toState: "reviewing" }), /not replayed/);
        assert.deepEqual(calls, ["/api/move", "/api/session"]);
    } finally { globalThis.fetch = nativeFetch; await close(replacement); }
});

test("concurrent expired reads share one handshake; releasing adapter does not stop runtime", async t => {
    const { runtime, origin } = await fixture(t);
    const capability = await session(origin);
    await post(origin, "/api/session/release", {}, capability);
    const calls = [];
    browserFetch(origin, calls);
    try {
        const api = createBoardTransport(capability);
        const [a, b] = await Promise.all([api("/api/state"), api("/api/state")]);
        assert.equal(a.revision, b.revision);
        assert.equal(calls.filter(route => route === "/api/session").length, 1);
    } finally { globalThis.fetch = nativeFetch; }
    const client = createRuntimeClient(origin);
    const opened = await client.open("synthetic-panel");
    assert.equal(opened.url, runtime.url);
    assert.equal(opened.title, "WIRE");
    await client.action("synthetic-panel", "get_summary", {});
    await client.close("synthetic-panel");
    assert.equal((await nativeFetch(origin + "/health")).status, 200);
});

test("network loss is classified consistently at the first read, renewal and renewed read", async t => {
    const { origin } = await fixture(t);
    for (const failure of ["first", "renewal", "renewed-read"]) {
        const capability = await session(origin);
        if (failure !== "first") await post(origin, "/api/session/release", {}, capability);
        const calls = [];
        globalThis.fetch = (route, options) => {
            calls.push(route);
            if (failure === "first" || failure === "renewal" && route === "/api/session"
                || failure === "renewed-read" && calls.length === 3) return Promise.reject(new TypeError("Synthetic connection loss"));
            return nativeFetch(origin + route, { ...options, headers: { ...options.headers, Origin: origin } });
        };
        try {
            await assert.rejects(createBoardTransport(capability)("/api/state"), error =>
                error.reason === "runtime_unavailable" && /No action was replayed/.test(error.message));
            assert.equal(calls.length, failure === "first" ? 1 : failure === "renewal" ? 2 : 3);
        } finally { globalThis.fetch = nativeFetch; }
    }
});
