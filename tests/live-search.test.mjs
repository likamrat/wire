import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import { searchFixture, streamPanel, saveSearchComparison } from "./live-search-fixture.mjs";
import { exclusiveBoard, loadBoardState } from "../lib/store.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

test("ordered real model search coalesces PDF typing, opens verified bytes and fences two owners", { timeout: 120000 }, async t => {
    const { runtime, bundles } = await searchFixture(t, { formats: ["pdf"], search: { heartbeatMs: 100 } });
    const a = await streamPanel(runtime), b = await streamPanel(runtime);
    t.after(async () => { await a.close(); await b.close(); });
    const rejected = await streamPanel(runtime);
    assert.equal(rejected.response.status, 429); rejected.close();
    const began = performance.now();
    assert.equal((await a.api("/api/search/query", { query: "A doctor cared for somebody who was hurt.", requestId: 1 })).code, 200);
    const first = await a.wait(event => event.event === "results" && event.receipt.requestId === 1);
    assert.equal(first.receipt.mode, "hybrid");
    assert.equal(first.hits.find(hit => hit.type === "interaction").target.href, "#request?request=search-0");
    const buildIndex = first.receipt.indexId;
    await a.api("/api/search/query", { query: "Saved", requestId: 2 });
    await a.wait(event => event.event === "status" && event.state === "searching" && event.requestId === 2);
    for (const [index, query] of ["Saved r", "Saved rep", "Saved report"].entries()) {
        await a.api("/api/search/query", { query, requestId: index + 3, types: ["report"] });
    }
    const typed = await a.wait(event => event.event === "results" && event.receipt.requestId === 5);
    assert.equal(typed.receipt.indexId, buildIndex, "Normal typing must not rebuild the PDF corpus");
    assert.equal(a.events.some(event => event.event === "results" && [3, 4].includes(event.receipt.requestId)), false,
        "Intermediate queued queries are never disclosed");
    assert.equal(typed.hits[0].target.format, "pdf");
    const opened = await a.api("/api/search/open", { id: typed.hits[0].id, receipt: typed.receipt, openId: 1 });
    assert.equal(opened.code, 200);
    const document = await a.wait(event => event.event === "opened");
    assert.equal(document.document.kind, "pdf");
    assert.equal(Buffer.from(document.document.data, "base64").subarray(0, 5).toString(), "%PDF-");
    await b.api("/api/search/query", { query: "physician", requestId: 1 });
    await b.wait(event => event.event === "results");
    const fencesA = a.events.filter(event => event.event === "fence").length;
    const fencesB = b.events.filter(event => event.event === "fence").length;
    await b.api("/api/move", { scenarioId: "search-0", toState: "reviewing" });
    assert.ok(a.events.filter(event => event.event === "fence").length > fencesA);
    assert.ok(b.events.filter(event => event.event === "fence").length > fencesB);
    assert.equal((await a.api("/api/search/open", { id: typed.hits[0].id, receipt: typed.receipt, openId: 2 })).code, 409);
    await a.api("/api/search/query", { query: "Saved report", requestId: 6, types: ["report"] });
    const fresh = await a.wait(event => event.event === "results" && event.receipt.requestId === 6);
    await appendFile(bundles[0].files["product-report.pdf"], "tampered");
    assert.equal((await a.api("/api/search/open", { id: fresh.hits[0].id, receipt: fresh.receipt, openId: 3 })).code, 409);
    const metrics = (await a.api("/api/search/status")).body;
    t.diagnostic(JSON.stringify({ wallMs: performance.now() - began, metrics: metrics.metrics, model: metrics.model,
        items: metrics.items, chunks: metrics.chunks }));
    await a.api("/api/search/cancel");
    assert.equal((await a.api("/api/search/status")).body.indexId, null);
    await a.close(); await b.close();
    await runtime.search.close();
    assert.equal(runtime.search.status().panels, 0);
    assert.equal(runtime.search.status().closing, 0);
});

test("cancel during a real PDF/model build aborts owned work before disconnect closure", { timeout: 30000 }, async t => {
    const { runtime } = await searchFixture(t, { formats: ["pdf"] });
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    await panel.wait(event => event.event === "status" && event.state === "building");
    assert.equal((await panel.api("/api/search/cancel")).code, 200);
    await panel.api("/api/search/close");
    assert.equal(panel.events.some(event => event.event === "results"), false);
    assert.equal(runtime.search.status().panels, 0);
    assert.equal(runtime.search.status().closing, 0);
});

test("missing assets are explicitly lexical-only; expiry closes streams without replay", { timeout: 30000 }, async t => {
    const { runtime, root } = await searchFixture(t, { search: { modelDirectory: "missing-local-model", heartbeatMs: 50, idleMs: 1000 } });
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    const found = await panel.wait(event => event.event === "results");
    assert.equal(found.receipt.mode, "lexical-only");
    assert.equal(found.status.model.code, "model-missing");
    await panel.wait(event => event.event === "fence" && event.reason === "idle");
    assert.equal((await panel.api("/api/search/open", { id: found.hits[0].id, receipt: found.receipt, openId: 1 })).code, 428);
    assert.doesNotMatch(JSON.stringify(found.status), new RegExp(root.replaceAll("\\", "\\\\") + "|physician"));
});

test("capability TTL and reconnect create a new owner; old receipts cannot reopen", { timeout: 10000 }, async t => {
    const { runtime } = await searchFixture(t, { sessionTtlMs: 500, search: { modelDirectory: "missing-local-model", heartbeatMs: 50 } });
    const old = await streamPanel(runtime);
    t.after(() => old.close());
    await old.api("/api/search/query", { query: "physician", requestId: 1 });
    const result = await old.wait(event => event.event === "results");
    await old.wait(event => event.event === "fence" && event.reason === "closed");
    assert.equal((await old.api("/api/search/status")).code, 403);
    const fresh = await streamPanel(runtime);
    t.after(() => fresh.close());
    assert.equal((await fresh.api("/api/search/open", { id: result.hits[0].id, receipt: result.receipt, openId: 1 })).code, 409);
    await fresh.api("/api/search/query", { query: "physician", requestId: 1 });
    const next = await fresh.wait(event => event.event === "results");
    assert.notEqual(next.receipt.panelId, result.receipt.panelId);
});

test("membership admission is exact-owner, whole-corpus and source-bound without an asynchronous gate", { timeout: 30000 }, async t => {
    const { runtime, context } = await searchFixture(t, { search: { modelDirectory: "missing-local-model" } });
    const events = [];
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) { events.push(JSON.parse(line)); }, end() { this.emit("close"); } });
    runtime.search.attach("owned-proof", response);
    const query = async (query, requestId, types) => {
        runtime.search.query("owned-proof", { query, requestId, types });
        const deadline = AbortSignal.timeout(20000);
        while (!events.some(event => event.event === "results" && event.receipt.requestId === requestId)) {
            deadline.throwIfAborted();
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return events.find(event => event.event === "results" && event.receipt.requestId === requestId);
    };
    const result = await query("physician", 1, []);
    await exclusiveBoard(context, state => {
        const selected = runtime.search.membership("owned-proof", result.receipt, state, "tool");
        assert.deepEqual(selected.scenarioIds, ["search-0"]);
        assert.equal(selected.actionIds.length, 0);
        assert.throws(() => runtime.search.membership("unowned", result.receipt, state, "tool"), /disconnected/);
        assert.throws(() => runtime.search.membership("owned-proof", { ...result.receipt, epoch: result.receipt.epoch + 1 }, state, "tool"), /stale/);
    }, { readOnly: true });
    const narrowed = await query("physician", 2, ["interaction"]);
    assert.throws(() => runtime.search.membership("owned-proof", narrowed.receipt, {}, "invented"), /layer/);
    await exclusiveBoard(context, state => assert.throws(() => runtime.search.membership("owned-proof", narrowed.receipt, state, "tool"), /unavailable/), { readOnly: true });
    const empty = await query("NO_MATCH_WHOLE_CORPUS", 3, []);
    await exclusiveBoard(context, state => assert.deepEqual(runtime.search.membership("owned-proof", empty.receipt, state, "tool"),
        { scenarioIds: [], actionIds: [], parentScenarioIds: [] }), { readOnly: true });
    await runtime.collector.close();
    assert.throws(() => runtime.search.membership("owned-proof", empty.receipt, { revision: empty.receipt.revision }, "tool"), /stale/);
    while (!events.some(event => event.event === "fence" && event.epoch > empty.receipt.epoch)) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const noSource = await query("lab results", 4, []);
    assert.ok(noSource.status.corpus.issues.some(issue => issue.code === "source-unavailable"));
    assert.equal(noSource.hits.some(hit => hit.type === "reply"), false);
    assert.equal((await loadBoardState(context)).personalEvaluation.consent.state, "enabled", "Persisted consent is not current source authorization");
    response.writableLength = 9 * 1024 * 1024;
    assert.doesNotThrow(() => runtime.search.invalidate(), "Slow-consumer closure must not reenter the corpus invalidation callback");
    await runtime.search.close();
    assert.equal(runtime.search.status().panels, 0);
});

test("corrupt model bytes expose lexical-only status without implicit repair or acquisition", { timeout: 10000 }, async t => {
    const { runtime, root } = await searchFixture(t, { search: root => ({ modelDirectory: path.join(root, "corrupt-model") }) });
    await mkdir(path.join(root, "corrupt-model"));
    await writeFile(path.join(root, "corrupt-model", "config.json"), "{}");
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    const found = await panel.wait(event => event.event === "results");
    assert.equal(found.receipt.mode, "lexical-only");
    assert.equal(found.status.model.code, "model-corrupt");
});

test("route opening detects changed retained content even if an external write reuses its revision", { timeout: 10000 }, async t => {
    const { runtime, context } = await searchFixture(t, { search: { modelDirectory: "missing-local-model" } });
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1, types: ["interaction"] });
    const found = await panel.wait(event => event.event === "results");
    const state = await loadBoardState(context);
    state.evidence[0].userPrompt.text = "Different invented content, without a new revision.";
    const changed = JSON.stringify({ records: state.evidence, importCoverage: state.importCoverage });
    state.evidenceFile = createHash("sha256").update(changed).digest("hex") + ".json";
    await writeFile(path.join(context.dataDir, "private-evidence", state.evidenceFile), changed);
    await writeFile(path.join(context.dataDir, `${BOARD_ID}.state.json`), JSON.stringify(state));
    assert.equal((await panel.api("/api/search/open", { id: found.hits[0].id, receipt: found.receipt, openId: 1 })).code, 409);
    assert.equal(panel.events.some(event => event.event === "opened"), false);
});

test("opening has one owned read slot and close waits for that gate without a late disclosure", { timeout: 10000 }, async t => {
    const { runtime, context } = await searchFixture(t, { search: { modelDirectory: "missing-local-model" } });
    const events = [], ready = Promise.withResolvers();
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        writeHead() {}, flushHeaders() {}, write(line) {
            const event = JSON.parse(line); events.push(event);
            if (event.event === "results") ready.resolve(event);
        }, end() { this.emit("close"); } });
    runtime.search.attach("open-proof", response);
    runtime.search.query("open-proof", { query: "physician", requestId: 1, types: ["interaction"] });
    const found = await ready.promise, entered = Promise.withResolvers(), release = Promise.withResolvers();
    const lock = exclusiveBoard(context, async () => { entered.resolve(); await release.promise; }, { readOnly: true });
    await entered.promise;
    const input = { id: found.hits[0].id, receipt: found.receipt, openId: 1 };
    const opening = runtime.search.open("open-proof", input);
    const rejected = assert.rejects(opening, /stale-search-target/);
    await assert.rejects(runtime.search.open("open-proof", { ...input, openId: 2 }), error => error.code === "search-open-busy");
    let closed = false;
    const closing = runtime.search.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release.resolve(); await lock; await rejected; await closing;
    assert.equal(events.some(event => event.event === "opened"), false);
});

test("search transport rejects foreign origin, unauthenticated reads and caller-supplied paths", { timeout: 10000 }, async t => {
    const { runtime } = await searchFixture(t, { search: { modelDirectory: "missing-local-model" } });
    const origin = new URL(runtime.url).origin;
    const foreign = await fetch(origin + "/api/search/events", { method: "POST",
        headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(foreign.status, 403);
    const anonymous = await fetch(origin + "/api/search/query", { method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ query: "physician", requestId: 1 }) });
    assert.equal(anonymous.status, 403);
    const panel = await streamPanel(runtime);
    t.after(() => panel.close());
    await panel.api("/api/search/query", { query: "physician", requestId: 1 });
    const found = await panel.wait(event => event.event === "results");
    const opened = await panel.api("/api/search/open", { id: found.hits[0].id, receipt: found.receipt,
        openId: 1, path: "unregistered.html" });
    assert.equal(opened.code, 422);
    assert.equal(panel.events.some(event => event.event === "opened"), false);
});

test("frozen-reader: foreign comparison receipt and close during its file gate cannot disclose bytes", { timeout: 15000 }, async t => {
    const app = await searchFixture(t, { formats: ["json", "json"], search: { modelDirectory: "missing-local-model" } });
    await saveSearchComparison(app, ["json"]);
    const owners = new Map();
    for (const owner of ["file-owner-a", "file-owner-b"]) {
        const ready = Promise.withResolvers(), events = [];
        const response = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
            writeHead() {}, flushHeaders() {}, write(line) {
                const event = JSON.parse(line); events.push(event);
                if (event.event === "results") ready.resolve(event);
            }, end() { this.emit("close"); } });
        app.runtime.search.attach(owner, response);
        app.runtime.search.query(owner, { query: "Saved comparison", requestId: 1, types: ["comparison"] });
        owners.set(owner, { found: await ready.promise, events });
    }
    const { found, events } = owners.get("file-owner-a"), input = { id: found.hits[0].id, receipt: found.receipt, openId: 1 };
    await assert.rejects(app.runtime.search.open("file-owner-b", input), /stale-search-target/);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const lock = exclusiveBoard(app.context, async () => { entered.resolve(); await release.promise; }, { readOnly: true });
    await entered.promise;
    const opening = app.runtime.search.open("file-owner-a", input), rejected = assert.rejects(opening, /stale-search-target/);
    let closed = false;
    const closing = app.runtime.search.release("file-owner-a").then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release.resolve(); await lock; await rejected; await closing;
    assert.equal(events.some(event => event.event === "opened"), false);
    await app.runtime.search.close();
    assert.equal(app.runtime.search.status().panels, 0);
});
