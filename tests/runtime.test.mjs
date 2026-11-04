import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { get } from "node:http";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
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
        headers: { Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
            ...(capability ? { "X-Board-Capability": capability } : {}), ...headers },
        body: JSON.stringify(body),
    });
}
async function session(origin, connection = false) {
    const result = await post(origin, "/api/session", {});
    assert.equal(result.status, 200);
    const value = await result.json();
    return connection ? value : value.capability;
}
function browserFetch(origin, calls) {
    globalThis.fetch = (route, options) => {
        calls.push(route);
        return nativeFetch(origin + route, { ...options, headers: { ...options.headers, Origin: origin } });
    };
}

test("unsupported session handshakes require an update before consuming any of the 128 panel authorities", async t => {
    const { origin } = await fixture(t);
    const obsolete = () => nativeFetch(origin + "/api/session", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}",
    });
    for (let index = 0; index < 130; index++) {
        const response = await obsolete();
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.code, "WIRE_CLIENT_UPDATE_REQUIRED");
        assert.match(body.error, /Reload|reload/);
        assert.equal(body.capability, undefined);
    }
    for (const protocol of ["0", "2", "1, 1", "copilot-only"]) {
        const response = await post(origin, "/api/session", {}, undefined, { "X-Wire-Session-Protocol": protocol });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "WIRE_CLIENT_UPDATE_REQUIRED");
    }
    assert.equal((await post(origin, "/api/session", { mode: "unbound" })).status, 400);
    assert.equal((await post(origin, "/api/snapshot", {})).status, 403,
        "Compatibility metadata alone never authenticates a panel.");
    const owners = [];
    for (let index = 0; index < 128; index++) owners.push(await session(origin));
    assert.equal(new Set(owners).size, 128);
    assert.equal((await post(origin, "/api/session", {})).status, 429);
    assert.equal((await nativeFetch(origin + "/")).status, 429, "The current server-rendered entry shares the unchanged cap.");
    assert.equal((await obsolete()).status, 409, "Compatibility is checked even when legitimate panels occupy every slot.");
    assert.equal((await nativeFetch(origin + "/health")).status, 200);
    assert.equal((await post(origin, "/api/session/release", {}, owners[0])).status, 200);
    assert.equal((await nativeFetch(origin + "/")).status, 200);
    assert.equal((await post(origin, "/api/snapshot", {}, owners[0])).status, 403);
    assert.equal((await post(origin, "/api/snapshot", {}, owners[1])).status, 200);
});

test("current canvas reuses one compatible authority for 130 opens and reads, then releases only itself", async t => {
    const { runtime, origin } = await fixture(t), requests = [];
    runtime.server.on("request", request => requests.push({
        path: request.url, protocol: request.headers["x-wire-session-protocol"],
    }));
    const client = createRuntimeClient(origin), other = await session(origin);
    requests.length = 0;
    for (let index = 0; index < 130; index++) {
        assert.equal((await client.open("reused-canvas")).url, runtime.url);
        await client.action("reused-canvas", "get_summary", {});
    }
    assert.deepEqual(requests.filter(request => request.path === "/api/session"),
        [{ path: "/api/session", protocol: "1" }]);
    await client.close("reused-canvas");
    assert.equal(requests.filter(request => request.path === "/api/session/release").length, 1);
    assert.equal((await post(origin, "/api/snapshot", {}, other)).status, 200);
});

test("canvas compatibility refusal remains explicit and does not replay an attempted open", async t => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push(new URL(url).pathname);
        if (url.endsWith("/health")) return Response.json({ service: "workiq-evidence", protocol: 1 });
        assert.equal(options.headers["X-Wire-Session-Protocol"], "1");
        return Response.json({ code: "WIRE_CLIENT_UPDATE_REQUIRED",
            error: "Update and reload the WIRE canvas extension. No panel was opened." }, { status: 409 });
    });
    await assert.rejects(createRuntimeClient("http://127.0.0.1:1").open("outdated-canvas"),
        error => error.code === "WIRE_CLIENT_UPDATE_REQUIRED" && /update and reload/i.test(error.message));
    assert.deepEqual(calls, ["/health", "/api/session"]);
});

test("canvas incompatibility identifies the requested origin without allocating a session", async t => {
    const origin = "http://127.0.0.1:54321", calls = [];
    t.mock.method(globalThis, "fetch", async url => {
        calls.push(url);
        return Response.json({ service: "unrelated-fixture", protocol: 1 });
    });
    await assert.rejects(createRuntimeClient(origin).open("wrong-service"),
        { message: `${origin} is not a compatible WIRE runtime.` });
    assert.deepEqual(calls, [origin + "/health"]);
});

test("registered canvas uses the current adapter and surfaces update-required without hiding it as server downtime", async t => {
    const { runtime, origin } = await fixture(t), key = `wireCanvasFixture_${randomUUID()}`;
    const sdk = `export class CanvasError extends Error {
        constructor(code, message) { super(message); this.code = code; }
    }
    export const createCanvas = value => value;
    export const joinSession = async value => { globalThis[${JSON.stringify(key)}] = value; return {}; };`;
    const client = `import { createRuntimeClient as create } from ${JSON.stringify(new URL("../lib/runtime-client.mjs", import.meta.url).href)};
        export const createRuntimeClient = () => create(${JSON.stringify(origin)});`;
    const entry = new URL("../extension.mjs", import.meta.url);
    const hooks = registerHooks({
        resolve(specifier, context, next) {
            if (context.parentURL?.startsWith(entry.href)) {
                const source = specifier === "@github/copilot-sdk/extension" ? sdk
                    : specifier === "./lib/runtime-client.mjs" ? client : null;
                if (source) return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
            }
            return next(specifier, context);
        },
    });
    t.after(() => { hooks.deregister(); delete globalThis[key]; });
    await import(entry.href + "?fixture=" + randomUUID());
    const canvas = globalThis[key].canvases[0];
    const opened = await canvas.open({ instanceId: "registered-fixture" });
    assert.equal(opened.url, runtime.url);
    const summary = canvas.actions.find(action => action.name === "get_summary");
    await summary.handler({ instanceId: "registered-fixture", actionName: "get_summary", input: {} });
    await canvas.onClose({ instanceId: "registered-fixture" });
    t.mock.method(globalThis, "fetch", (url, options) => url === origin + "/api/session"
        ? Promise.resolve(Response.json({ code: "WIRE_CLIENT_UPDATE_REQUIRED",
            error: "Update and reload the WIRE canvas extension. No panel was opened." }, { status: 409 }))
        : nativeFetch(url, options));
    await assert.rejects(canvas.open({ instanceId: "incompatible-fixture" }),
        error => error.code === "runtime_update_required" && /update and reload/i.test(error.message));
});

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
    const { capability, accessBootstrap } = await session(origin, true);
    let changes = 0;
    const calls = [];
    const api = createBoardTransport(capability, () => changes++, accessBootstrap);
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
        const staleMutation = createBoardTransport(capability, undefined, accessBootstrap);
        await assert.rejects(staleMutation("/api/move", { scenarioId: "synthetic-only", toState: "reviewing" }), /not replayed/);
        assert.deepEqual(calls, ["/api/move", "/api/session"]);
    } finally { globalThis.fetch = nativeFetch; await close(replacement); }
});

test("concurrent expired reads share one handshake; releasing adapter does not stop runtime", async t => {
    const { runtime, origin } = await fixture(t);
    const { capability, accessBootstrap } = await session(origin, true);
    await post(origin, "/api/session/release", {}, capability);
    const calls = [];
    browserFetch(origin, calls);
    try {
        const api = createBoardTransport(capability, undefined, accessBootstrap);
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
        const { capability, accessBootstrap } = await session(origin, true);
        if (failure !== "first") await post(origin, "/api/session/release", {}, capability);
        const calls = [];
        globalThis.fetch = (route, options) => {
            calls.push(route);
            if (failure === "first" || failure === "renewal" && route === "/api/session"
                || failure === "renewed-read" && calls.length === 3) return Promise.reject(new TypeError("Synthetic connection loss"));
            return nativeFetch(origin + route, { ...options, headers: { ...options.headers, Origin: origin } });
        };
        try {
            await assert.rejects(createBoardTransport(capability, undefined, accessBootstrap)("/api/state"), error =>
                error.reason === "runtime_unavailable" && /No action was replayed/.test(error.message));
            assert.equal(calls.length, failure === "first" ? 1 : failure === "renewal" ? 2 : 3);
        } finally { globalThis.fetch = nativeFetch; }
    }
});
