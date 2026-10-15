import test from "node:test";
import assert from "node:assert/strict";
import { createBoardTransport } from "../lib/client-transport.mjs";

test("caller cancellation is bounded to search and never gives mutations automatic retry", async t => {
    const original = globalThis.fetch, requests = [];
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        if (url === "/api/session") return Response.json({ capability: "b".repeat(64) });
        return Response.json({ code: "session_expired" }, { status: 403 });
    };
    let changes = 0;
    const api = createBoardTransport("a".repeat(64), () => { changes++; });
    await assert.rejects(api("/api/export", {}, { signal: new AbortController().signal }), /limited to owned search/);
    assert.equal(requests.length, 0);
    await assert.rejects(api("/api/export", { confirmed: true }), error => error.code === "request_rejected");
    assert.deepEqual(requests.map(request => request.url), ["/api/export", "/api/session"]);
    assert.equal(changes, 1);
    assert.ok(requests.every(request => !request.url.includes("a".repeat(64))));
    requests.length = 0;
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    };
    const controller = new AbortController(), pending = api("/api/search/query", { query: "Invented text", requestId: 1 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.reason === "search_cancelled");
    assert.equal(requests.length, 1);
});

test("ordered search stream uses the caller's contract version, capability header and owned reader", async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const seen = [], bodies = [], frames = [
        { event: "connected", panelId: "invented", epoch: 0 },
        { event: "results", panelId: "invented", epoch: 0, hits: [] },
        { event: "fence", panelId: "invented", epoch: 1 },
    ];
    globalThis.fetch = async (url, options) => {
        assert.equal(url, "/api/search/events");
        assert.equal(options.headers["X-Board-Capability"], "a".repeat(64));
        bodies.push(JSON.parse(options.body));
        assert.equal(options.credentials, "same-origin");
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"));
            controller.close();
        } }));
    };
    const api = createBoardTransport("a".repeat(64));
    await assert.rejects(api.searchEvents(event => seen.push(event), { signal: new AbortController().signal, schemaVersion: 3 }), /disconnected/);
    assert.deepEqual(bodies, [{ schemaVersion: 3 }]);
    assert.deepEqual(seen, frames);
});

test("search renewal preserves the supplied version and invalid versions never dispatch", async t => {
    const original = globalThis.fetch, requests = [];
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body), capability: options.headers["X-Board-Capability"] });
        if (url === "/api/session") return Response.json({ capability: "b".repeat(64) });
        if (options.headers["X-Board-Capability"] === "a".repeat(64)) return Response.json({ code: "session_expired" }, { status: 403 });
        return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    };
    let renewed = 0;
    const api = createBoardTransport("a".repeat(64), () => renewed++);
    for (const schemaVersion of [undefined, null, 0, -1, 3.5, Number.NaN]) {
        await assert.rejects(api.searchEvents(() => {}, { signal: new AbortController().signal, schemaVersion }), /current contract version/);
    }
    assert.equal(requests.length, 0);
    await assert.rejects(api.searchEvents(() => {}, { signal: new AbortController().signal, schemaVersion: 3 }), /disconnected/);
    assert.equal(renewed, 1);
    assert.deepEqual(requests.filter(request => request.url === "/api/search/events").map(request => request.body), [
        { schemaVersion: 3 }, { schemaVersion: 3 },
    ]);
    assert.deepEqual(requests.map(request => request.url), ["/api/search/events", "/api/session", "/api/search/events"]);
    assert.equal(requests.at(-1).capability, "b".repeat(64));
});
