import test from "node:test";
import assert from "node:assert/strict";
import { createHostedRuntime } from "../lib/hosted-runtime.mjs";

const inUse = () => Object.assign(new Error("in use"), { code: "EADDRINUSE" });

test("a running WIRE is reused instead of starting a second writer", async () => {
    let starts = 0;
    const hosted = createHostedRuntime({ probe: async () => true, start: async () => { starts++; } });
    assert.equal(await hosted.ensure(), "http://127.0.0.1:4000");
    assert.equal(starts, 0);
    assert.equal(hosted.owner, false);
});

test("concurrent requests start one owned runtime, which closes with the host", async () => {
    let starts = 0, closed = 0;
    const hosted = createHostedRuntime({ probe: async () => false,
        start: async () => { starts++; await new Promise(resolve => setTimeout(resolve, 10)); return { close: async () => { closed++; } }; } });
    await Promise.all([hosted.ensure(), hosted.ensure(), hosted.ensure()]);
    assert.equal(starts, 1);
    assert.equal(hosted.owner, true);
    await hosted.close();
    assert.equal(closed, 1);
    await assert.rejects(hosted.ensure(), { code: "WIRE_RUNTIME_UNAVAILABLE" });
});

test("losing the port race connects to the winner; an unrelated port owner is refused", async () => {
    let healthy = false;
    const raced = createHostedRuntime({ probe: async () => healthy, start: async () => { healthy = true; throw inUse(); } });
    assert.equal(await raced.ensure(), "http://127.0.0.1:4000");
    assert.equal(raced.owner, false);
    const blocked = createHostedRuntime({ probe: async () => false, start: async () => { throw inUse(); } });
    await assert.rejects(blocked.ensure(), { code: "EADDRINUSE" });
});

test("a contributor port is only ever connected to, never started", async () => {
    let starts = 0;
    const hosted = createHostedRuntime({ port: 4100, probe: async () => false, start: async () => { starts++; } });
    await assert.rejects(hosted.ensure(), { code: "WIRE_RUNTIME_UNAVAILABLE" });
    assert.equal(starts, 0);
});
