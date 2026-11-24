import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture } from "./helpers.mjs";

async function managedFixture(t, options) {
    const { context } = await privateFixture(t);
    const channel = Object.assign(new EventEmitter(), { connected: true,
        env: { WIRE_UPDATE_LAUNCHER: "1", WIRE_UPDATE_BUILD: "0".repeat(40) } });
    let final, calls = [];
    channel.send = msg => {
        if (msg.type === "wire-update-request") {
            calls.push(msg.request);
            const value = msg.request.action === "status" ? { phase: "available", installed: "0".repeat(40), candidate: "1".repeat(40) } : { phase: "preparing" };
            queueMicrotask(() => channel.emit("message", { type: "wire-update-response", id: msg.id, value }));
        } else final = msg;
    };
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, updateChannel: channel, ...options });
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
    const prepare = () => { channel.emit("message", { type: "wire-update-quiesce", id: "fixture" }); return final; };
    return { page, post, apply, prepare, calls, origin, runtime, channel };
}

test("expiry withdraws data access without retiring a suspended browser's update blocker", { timeout: 18000 }, async t => {
    const { page, post, apply } = await managedFixture(t, { sessionTtlMs: 100 });
    const suspended = await page();
    await post("/api/app-update", { action: "status" }, suspended);
    await delay(160);
    const current = await page();
    assert.equal((await apply(current)).status, 409);
    assert.equal((await post("/api/app-update", { action: "status" }, suspended)).status, 403);
    assert.equal((await post("/api/app-update/release-panel", {}, suspended)).status, 200);
    assert.equal((await post("/api/app-update", { action: "status" }, suspended)).status, 403);
    assert.equal((await post("/api/app-update/release-panel", {}, current)).status, 200);
    assert.equal((await apply(await page())).status, 200);
});

test("an admitted collector owner defers cutover; no scheduled or queued work starts behind the fence", async t => {
    const { page, apply, runtime, prepare, channel } = await managedFixture(t);
    assert.equal((await apply(await page())).status, 200);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const activity = runtime.collector.exclusiveActivity(async () => { entered.resolve(); await gate.promise; });
    try {
        await entered.promise;
        assert.equal(prepare().ok, false);
    } finally { gate.resolve(); await activity; }
    assert.equal(prepare().ok, true);
    await assert.rejects(runtime.collector.exclusiveActivity(() => assert.fail("post-fence writer acquired")), /updat/i);
    await assert.rejects(runtime.collector.collectNow(), /updat/i);
    channel.emit("message", { type: "wire-update-resume" });
    assert.equal(await runtime.collector.exclusiveActivity(() => true), true);
});

test("releasing a page ends its pending update watch without publishing an offer or restoring authority", async t => {
    const { page, post, apply, runtime, calls } = await managedFixture(t);
    const departing = await page(), current = await page();
    await post("/api/app-update", { action: "status" }, departing);
    const listening = Promise.withResolvers();
    runtime.server.once("request", req => req.once("end", listening.resolve));
    const pending = post("/api/app-update/watch", {}, departing);
    await listening.promise;
    assert.equal((await post("/api/app-update/release-panel", {}, departing)).status, 200);
    const withdrawn = await pending;
    assert.equal(withdrawn.status, 403);
    assert.equal((await withdrawn.json()).code, "session_expired");
    assert.equal((await post("/api/app-update/watch", {}, departing)).status, 403);
    assert.equal((await apply(current)).status, 200);
    assert.equal(calls.filter(c => c.action === "apply").length, 1);
});

test("a late Settings hold supersedes readiness before dispatch and at final cutover", async t => {
    const { page, post, apply, prepare, calls } = await managedFixture(t);
    const first = await page(), peer = await page(), delayed = await page();
    for (const cap of [peer, delayed]) await post("/api/app-update", { action: "status" }, cap);
    const report = (offer, hold) => post("/api/app-update/readiness", { ...offer, hold }, peer);
    const watch = () => post("/api/app-update/watch", {}, peer).then(r => r.json());
    const watching = watch(), applying = apply(first);
    const offer = await watching;
    assert.equal((await report(offer, "")).status, 200);
    assert.equal((await report(offer, "settings")).status, 200);
    assert.equal((await applying).status, 409);
    assert.equal(calls.filter(c => c.action === "apply").length, 0);
    assert.equal((await post("/api/app-update/release-panel", {}, delayed)).status, 200);

    const watchingAgain = watch(), nextApply = apply(first);
    const next = await watchingAgain;
    assert.notEqual(next.operation, offer.operation);
    assert.equal((await report(offer, "")).status, 409);
    assert.equal((await report(next, "")).status, 200);
    assert.equal((await nextApply).status, 200);
    assert.equal((await report(next, "settings")).status, 200);
    assert.match(prepare().error, /Settings edit/);
});

test("cutover refuses an expired ready page even before the periodic prune", async t => {
    const { page, apply, prepare } = await managedFixture(t, { sessionTtlMs: 60000 });
    assert.equal((await apply(await page())).status, 200);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 60001);
    assert.equal(prepare().ok, false);
});

test("unused HTML and idle adapters do not veto one shared activation; verify ownership and in-flight Save at cutover", async t => {
    const { page, post, apply, prepare, calls, origin, runtime, channel } = await managedFixture(t);
    const first = await page(), other = await page();
    await post("/api/app-update", { action: "status" }, other);
    const adapter = (await (await post("/api/session", {}, null, { "X-Wire-Session-Protocol": "1" })).json()).capability;
    assert.equal((await apply(adapter)).status, 403);
    const watched = post("/api/app-update/watch", {}, other);
    const applying = apply(first);
    assert.equal((await (await watched).json()).candidate, "1".repeat(40));
    assert.equal((await apply(other)).status, 200);
    assert.equal((await applying).status, 200);
    assert.equal(calls.filter(c => c.action === "apply").length, 1);
    const newTab = await page();
    assert.equal((await post("/api/app-update", { action: "status" }, newTab)).status, 409);
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
