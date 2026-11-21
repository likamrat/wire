import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture } from "./helpers.mjs";

test("only the sole browser panel may activate; recheck panels and in-flight Save at final cutover", async t => {
    const { context } = await privateFixture(t);
    const channel = Object.assign(new EventEmitter(), { connected: true,
        env: { WIRE_UPDATE_LAUNCHER: "1", WIRE_UPDATE_BUILD: "0".repeat(40) } });
    let final, calls = [];
    channel.send = msg => {
        if (msg.type === "wire-update-request") {
            calls.push(msg.request);
            queueMicrotask(() => channel.emit("message", { type: "wire-update-response", id: msg.id, value: { phase: "preparing" } }));
        } else final = msg;
    };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, updateChannel: channel });
    t.after(async () => { const stopped = runtime.close(); runtime.server.closeIdleConnections(); await stopped; });
    const origin = new URL(runtime.url).origin;
    const page = async () => {
        const html = await (await fetch(runtime.url)).text();
        const token = html.match(/\}\)\("([0-9a-f]{64})",/);
        assert.ok(token, "normal browser entry issues its own capability"); return token[1];
    };
    const post = (route, body, cap, extra = {}) => fetch(origin + route, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", ...(cap && { "X-Board-Capability": cap }), ...extra,
    }, body: JSON.stringify(body) });
    const apply = cap => post("/api/app-update", { action: "apply", candidate: "1".repeat(40) }, cap);
    const first = await page(), other = await page();
    assert.equal((await apply(first)).status, 409);
    assert.deepEqual(calls, []);
    await post("/api/session/release", {}, other);
    const adapter = (await (await post("/api/session", {}, null, { "X-Wire-Session-Protocol": "1" })).json()).capability;
    assert.equal((await apply(adapter)).status, 403);
    await post("/api/session/release", {}, adapter);
    assert.equal((await apply(first)).status, 200);
    const newTab = await page();
    const prepare = () => { channel.emit("message", { type: "wire-update-quiesce", id: "fixture" }); return final; };
    assert.equal(prepare().ok, false);
    await post("/api/session/release", {}, newTab);
    const pending = request(origin + "/api/export", { method: "POST", headers: { Origin: origin,
        "Content-Type": "application/json", "X-Board-Capability": first } });
    const started = new Promise(resolve => runtime.server.once("request", resolve));
    pending.on("error", () => {}); pending.write("{"); await started;
    assert.match(prepare().error, /operation is still running/);
    const finished = new Promise(resolve => pending.on("response", res => { res.resume(); res.on("end", resolve); }));
    pending.end("}"); await finished;
    assert.equal(prepare().ok, true);
    assert.equal((await fetch(origin + "/reports")).status, 409);
    assert.equal((await post("/api/export", {}, first)).status, 409);
    const health = await (await fetch(origin + "/health")).json();
    assert.equal(health.build, channel.env.WIRE_UPDATE_BUILD);
    channel.emit("message", { type: "wire-update-resume" });
    assert.equal((await fetch(origin + "/reports")).status, 200);
});
