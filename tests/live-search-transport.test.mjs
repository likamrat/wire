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

test("ordered search stream uses the capability header, no query URL and releases its reader", async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const seen = [], frames = [
        { event: "connected", panelId: "invented", epoch: 0 },
        { event: "results", panelId: "invented", epoch: 0, hits: [] },
        { event: "fence", panelId: "invented", epoch: 1 },
    ];
    globalThis.fetch = async (url, options) => {
        assert.equal(url, "/api/search/events");
        assert.equal(options.headers["X-Board-Capability"], "a".repeat(64));
        assert.equal(options.body, '{"schemaVersion":2}');
        assert.equal(options.credentials, "same-origin");
        return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"));
            controller.close();
        } }));
    };
    const api = createBoardTransport("a".repeat(64));
    await assert.rejects(api.searchEvents(event => seen.push(event), { signal: new AbortController().signal }), /disconnected/);
    assert.deepEqual(seen, frames);
});
