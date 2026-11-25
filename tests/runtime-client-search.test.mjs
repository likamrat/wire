import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRuntimeClient } from "../lib/runtime-client.mjs";

async function fakeRuntime(t, fenceReason) {
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const json = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
        if (req.url === "/health") return json({ service: "workiq-evidence", protocol: 1, runtimeId: "r" });
        if (req.url === "/api/session") return json({ capability: "c".repeat(64) });
        if (req.url === "/api/search/query" || req.url === "/api/search/close") return json({ state: "queued" });
        if (req.url === "/api/search/events") {
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            const send = value => res.write(JSON.stringify(value) + "\n");
            send({ event: "connected" });
            setTimeout(() => {
                send({ event: "status", state: "building", requestId: 1 });
                send({ event: "fence", reason: fenceReason });
                send({ event: "results", requestId: 1, matches: { hits: [{ type: "interaction", title: "t", excerpt: "calendar" }], total: 1 } });
                send({ event: "status", state: "ready", requestId: 1, status: { corpus: { state: "ready" } } });
            }, 20);
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return createRuntimeClient(`http://127.0.0.1:${server.address().port}`);
}

test("agent Search waits through the index-building fence and returns its results", async t => {
    const outcome = await (await fakeRuntime(t, "indexing")).search("agent", { query: "calendar" });
    assert.equal(outcome.state, "ready");
    assert.equal(outcome.results.matches.total, 1);
});

test("agent Search stops when retained evidence changes mid-search", async t => {
    await assert.rejects((await fakeRuntime(t, "collected")).search("agent", { query: "calendar" }), { code: "collected" });
});
