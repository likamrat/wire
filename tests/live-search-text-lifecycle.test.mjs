import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { searchFixture, streamPanel, saveSearchComparison } from "./live-search-fixture.mjs";
import { forbidSearchAi } from "./search-text-guards.mjs";
import { exclusiveBoard, loadBoardState } from "../lib/store.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

async function ownedPanel(runtime, owner, query, types) {
    const events = [], ready = Promise.withResolvers();
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) {
            const event = JSON.parse(line); events.push(event);
            if (event.event === "results") ready.resolve(event);
        }, end() { this.emit("close"); } });
    runtime.search.attach(owner, response, { schemaVersion: 3 });
    runtime.search.query(owner, { schemaVersion: 3, purpose: "navigation", query, requestId: 1, types });
    return { found: await ready.promise, events, response };
}

test("actual PDF typing coalesces newest text and cancel closes its owned extraction", { timeout: 60000 }, async t => {
    const parsers = [], guard = forbidSearchAi(t, { pdf: true, onPdf: child => parsers.push(child) });
    const { runtime } = await searchFixture(t, { formats: ["pdf"] });
    guard.connect(runtime);
    const a = await streamPanel(runtime), b = await streamPanel(runtime);
    t.after(async () => { await a.close(); await b.close(); });
    const third = await streamPanel(runtime);
    assert.equal(third.response.status, 429);
    await third.close();
    await a.api("/api/search/query", { query: "physician", requestId: 1 });
    await a.wait(event => event.event === "status" && event.state === "building");
    for (const [i, query] of ["Sav", "Saved", "Saved r", "Saved report"].entries()) {
        await a.api("/api/search/query", { query, requestId: i + 2, types: ["report"] });
    }
    const result = await a.wait(event => event.event === "results" && event.requestId === 5);
    assert.equal(result.matches.receipt.mode, "text");
    assert.equal(result.matches.hits[0].target.format, "pdf");
    assert.equal(a.events.some(event => event.event === "results" && [2, 3, 4].includes(event.requestId)), false);
    const receipt = result.matches.receipt;
    assert.equal((await a.api("/api/search/open", { id: result.matches.hits[0].id, receipt, openId: 1 })).code, 200);
    const opened = await a.wait(event => event.event === "opened");
    assert.equal(Buffer.from(opened.document.data, "base64").subarray(0, 5).toString(), "%PDF-");
    await b.api("/api/search/query", { query: "physician", requestId: 1 });
    await b.wait(event => event.event === "status" && event.state === "building");
    await b.api("/api/search/cancel");
    await b.api("/api/search/close");
    assert.equal(b.events.some(event => event.event === "results"), false);
    await runtime.search.close();
    assert.ok(parsers.length > 0);
    assert.ok(parsers.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(runtime.search.status().closing, 0);
    guard.verify();
});

test("idle expiry and capability TTL/reconnect do not replay text authority", { timeout: 15000 }, async t => {
    const guard = forbidSearchAi(t);
    const { runtime } = await searchFixture(t, { sessionTtlMs: 650, search: { heartbeatMs: 50, idleMs: 250 } });
    guard.connect(runtime);
    const old = await streamPanel(runtime);
    t.after(() => old.close());
    await old.api("/api/search/query", { query: "physician", requestId: 1 });
    const result = await old.wait(event => event.event === "results");
    await old.wait(event => event.event === "fence" && event.reason === "idle");
    assert.equal((await old.api("/api/search/open", { id: result.matches.hits[0].id, receipt: result.matches.receipt, openId: 1 })).code, 428);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await old.api("/api/search/status")).code, 403);
    const fresh = await streamPanel(runtime);
    t.after(() => fresh.close());
    assert.equal((await fresh.api("/api/search/open", { id: result.matches.hits[0].id, receipt: result.matches.receipt, openId: 1 })).code, 409);
    await fresh.api("/api/search/query", { query: "physician", requestId: 1 });
    const next = await fresh.wait(event => event.event === "results");
    assert.notEqual(next.matches.receipt.panelId, result.matches.receipt.panelId);
    guard.verify();
});

test("text Open rejects foreign origin, anonymous reads and caller paths", { timeout: 10000 }, async t => {
    const guard = forbidSearchAi(t), { runtime } = await searchFixture(t);
    guard.connect(runtime);
    const origin = new URL(runtime.url).origin;
    const foreign = await fetch(origin + "/api/search/events", { method: "POST",
        headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: '{"schemaVersion":3}' });
    assert.equal(foreign.status, 403);
    const anonymous = await fetch(origin + "/api/search/query", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 3, purpose: "navigation", query: "physician", requestId: 1 }) });
    assert.equal(anonymous.status, 403);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    const found = await panel.wait(event => event.event === "results");
    assert.equal((await panel.api("/api/search/open", { id: found.matches.hits[0].id, receipt: found.matches.receipt,
        openId: 1, path: "unregistered.html" })).code, 422);
    assert.equal(panel.events.some(event => event.event === "opened"), false);
    guard.verify();
});

test("changed retained content cannot reuse a text receipt even when the state revision is reused", { timeout: 10000 }, async t => {
    const guard = forbidSearchAi(t), { runtime, context } = await searchFixture(t);
    guard.connect(runtime);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1, types: ["interaction"] });
    const found = await panel.wait(event => event.event === "results");
    const state = await loadBoardState(context);
    state.evidence[0].userPrompt.text = "Different invented content without a new revision.";
    const changed = JSON.stringify({ records: state.evidence, importCoverage: state.importCoverage });
    state.evidenceFile = createHash("sha256").update(changed).digest("hex") + ".json";
    await writeFile(path.join(context.dataDir, "private-evidence", state.evidenceFile), changed);
    await writeFile(path.join(context.dataDir, `${BOARD_ID}.state.json`), JSON.stringify(state));
    assert.equal((await panel.api("/api/search/open", { id: found.matches.hits[0].id, receipt: found.matches.receipt, openId: 1 })).code, 409);
    assert.equal(panel.events.some(event => event.event === "opened"), false);
    guard.verify();
});

test("one owned Open slot, Close waiting and backpressure prevent late or truncated disclosure", { timeout: 15000 }, async t => {
    const guard = forbidSearchAi(t), { runtime, context } = await searchFixture(t);
    guard.connect(runtime);
    const panel = await ownedPanel(runtime, "open-slot", "physician", ["interaction"]);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const lock = exclusiveBoard(context, async () => { entered.resolve(); await release.promise; }, { readOnly: true });
    await entered.promise;
    const input = { id: panel.found.matches.hits[0].id, receipt: panel.found.matches.receipt, openId: 1 };
    const opening = runtime.search.open("open-slot", input), rejected = assert.rejects(opening, /stale-search-target/);
    await assert.rejects(runtime.search.open("open-slot", { ...input, openId: 2 }), error => error.code === "search-open-busy");
    let closed = false;
    const closing = runtime.search.release("open-slot").then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release.resolve(); await lock; await rejected; await closing;
    assert.equal(panel.events.some(event => event.event === "opened"), false);
    const events = [], response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) {
            const event = JSON.parse(line); events.push(event);
            if (event.event === "status" && event.state === "searching" && events.some(value => value.event === "fence")) {
                this.writableLength = 9 * 1024 * 1024;
            }
        }, end() { this.emit("close"); } });
    runtime.search.attach("slow-text", response, { schemaVersion: 3 });
    runtime.search.query("slow-text", { schemaVersion: 3, purpose: "navigation", query: "physician", requestId: 1 });
    const deadline = AbortSignal.timeout(10000);
    while (runtime.search.status().panels) { deadline.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(events.some(event => event.event === "results"), false);
    assert.equal(runtime.search.status().closing, 0);
    guard.verify();
});

test("frozen comparison Open remains exact-owner and cannot deliver bytes after Close", { timeout: 15000 }, async t => {
    const guard = forbidSearchAi(t), app = await searchFixture(t, { formats: ["json", "json"] });
    guard.connect(app.runtime);
    await saveSearchComparison(app, ["json"]);
    const a = await ownedPanel(app.runtime, "comparison-a", "Saved comparison", ["comparison"]);
    await ownedPanel(app.runtime, "comparison-b", "Saved comparison", ["comparison"]);
    const input = { id: a.found.matches.hits[0].id, receipt: a.found.matches.receipt, openId: 1 };
    await assert.rejects(app.runtime.search.open("comparison-b", input), /stale-search-target/);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const lock = exclusiveBoard(app.context, async () => { entered.resolve(); await release.promise; }, { readOnly: true });
    await entered.promise;
    const opening = app.runtime.search.open("comparison-a", input), rejected = assert.rejects(opening, /stale-search-target/);
    let closed = false;
    const closing = app.runtime.search.release("comparison-a").then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release.resolve(); await lock; await rejected; await closing;
    assert.equal(a.events.some(event => event.event === "opened"), false);
    guard.verify();
});

test("actual permission revocation fences both owners before acknowledgment while approved frozen content survives", { timeout: 20000 }, async t => {
    const guard = forbidSearchAi(t), app = await searchFixture(t, { formats: ["json"] });
    guard.connect(app.runtime);
    const a = await streamPanel(app.runtime), b = await streamPanel(app.runtime);
    t.after(async () => { await a.close(); await b.close(); });
    await a.api("/api/search/query", { query: "physician", requestId: 1, types: ["interaction"] });
    const activity = await a.wait(event => event.event === "results");
    await b.api("/api/search/query", { query: "LAB RES", requestId: 1, types: ["reply"] });
    const reply = await b.wait(event => event.event === "results");
    assert.equal(reply.matches.total, 1);
    const state = await loadBoardState(app.context), source = app.runtime.collector.assessmentSource(state);
    const revoked = await a.api("/api/assessment/consent/set", {
        schemaVersion: 1, mutationRef: `mutation-${randomUUID().replaceAll("-", "")}`,
        expectedSourceRevision: state.evidenceRevision, expectedConsentRevision: state.personalEvaluation.consent.revision,
        policyVersion: 1, enabled: false, categories: [], sourceConfigRef: source.sourceConfigRef,
        sourceConfigRevision: source.sourceConfigRevision, confirmed: true,
    });
    assert.equal(revoked.code, 200, revoked.body.error);
    await a.wait(event => event.event === "fence" && event.epoch > activity.epoch);
    await b.wait(event => event.event === "fence" && event.epoch > reply.epoch);
    assert.equal((await b.api("/api/search/open", { id: reply.matches.hits[0].id, receipt: reply.matches.receipt, openId: 1 })).code, 409);
    await a.api("/api/search/query", { query: "Saved report", requestId: 2, types: ["report"] });
    const saved = await a.wait(event => event.event === "results" && event.requestId === 2);
    assert.equal(saved.status.corpus.state, "partial");
    assert.equal(saved.matches.total, 1);
    assert.equal((await a.api("/api/search/open", { id: saved.matches.hits[0].id, receipt: saved.matches.receipt, openId: 2 })).code, 200);
    await appendFile(app.bundles[0].files["product-report.json"], "\nUnreviewed bytes");
    assert.equal((await a.api("/api/search/open", { id: saved.matches.hits[0].id, receipt: saved.matches.receipt, openId: 3 })).code, 409);
    assert.equal(a.events.some(event => event.event === "opened" && event.openId === 3), false);
    guard.verify();
});
