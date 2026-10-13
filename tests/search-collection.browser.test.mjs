import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { privateFixture } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";

test("normal Search survives quiet automatic collection and fences real source changes", { timeout: 90000 }, async t => {
    const cleanups = [];
    const { root, context } = await privateFixture({ after: fn => cleanups.push(fn) }, []);
    const sessionRoot = path.join(root, "session-state"), appDbPath = path.join(root, "data.db");
    await fs.mkdir(sessionRoot);
    const db = new DatabaseSync(appDbPath);
    db.exec(metadata174Schema);
    const sourceId = randomUUID();
    db.prepare("INSERT INTO sessions(id,title,session_type,execution_location) VALUES(?,?,?,?)")
        .run(sourceId, "Invented search collection", "chat", "local");
    await fs.mkdir(path.join(sessionRoot, sourceId));
    const file = path.join(sessionRoot, sourceId, "events.jsonl");
    const events = () => {
        const toolCallId = randomUUID(), timestamp = new Date().toISOString();
        return [
            { type: "user.message", data: { content: "Find the invented maintenance notes." } },
            { type: "tool.execution_start", data: { toolName: "workiq-retrieve", toolCallId, arguments: { query: "invented maintenance notes" } } },
            { type: "tool.execution_complete", data: { toolCallId, success: true } },
        ].map(event => ({ ...event, id: randomUUID(), timestamp }));
    };
    await fs.writeFile(file, [{ id: randomUUID(), type: "session.start", timestamp: new Date().toISOString(),
        data: { sessionId: sourceId, version: 1 } }, ...events()].map(event => JSON.stringify(event) + "\n").join(""));
    const checks = [], notifications = [], waiters = [];
    const exports = createExportController(context);
    const runtime = await startServer(context, exports, {
        port: 0, search: { modelDirectory: process.env.WIRE_SEARCH_MODEL_TEST_DIRECTORY },
        collector: { onCommitted(check, change) {
            checks.push(check);
            notifications.push(change);
            for (const waiter of [...waiters]) if (checks.length >= waiter.count) {
                waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve();
            }
        } },
    });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let releaseRead = () => {};
    t.after(async () => {
        releaseRead();
        await browser.close(); await runtime.close(); db.close();
        for (const cleanup of cleanups) await cleanup();
    });
    const untilChecks = count => checks.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve }));
    await runtime.collector.configure({ appDbPath, sessionRoot, approved: true, enabled: true, windowDays: 30, pollSeconds: 5 });
    const state = await loadBoardState(context);
    const preview = await exports.preview("invented-report", undefined, { promptMode: "original", formats: ["html"] },
        { kind: "all", revision: state.revision });
    await exports.review("invented-report", preview.previewId, true);
    const { bundle } = await exports.confirm("invented-report", preview.previewId, true);
    const reportFile = bundle.files["product-report.html"], originalRead = fs.readFile;
    let gate = null, entered;
    const hold = () => {
        const waiting = Promise.withResolvers(), reached = Promise.withResolvers();
        gate = waiting.promise; entered = reached.resolve; releaseRead = () => { gate = null; waiting.resolve(); };
        return reached.promise;
    };
    const mock = t.mock.method(fs, "readFile", async (...args) => {
        if (gate && String(args[0]) === reportFile) { entered(); await gate; }
        return originalRead(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const errors = [], requests = [];
    let capability, opened;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.url().endsWith("/api/search/query")) requests.push(request.postDataJSON());
        if (request.url().endsWith("/api/search/open")) opened = request.postDataJSON();
        capability ??= request.headers()["x-board-capability"];
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const api = (route, input = {}) => page.evaluate(async ({ route, input, capability }) => {
        const response = await fetch(route, { method: "POST",
            headers: { "Content-Type": "application/json", "X-Board-Capability": capability }, body: JSON.stringify(input) });
        return { status: response.status, body: await response.json() };
    }, { route, input, capability });
    const input = page.locator("#wireSearch");
    const blockedBuild = hold(), before = await loadBoardState(context), firstCheck = checks.length;
    await input.fill("workiq-retrieve");
    await blockedBuild;
    await untilChecks(firstCheck + 3);
    const quietBuild = (await api("/api/search/status")).body;
    assert.equal(quietBuild.state, "building", "Quiet onCommitted cycles must not cancel the pending index build.");
    assert.equal((await loadBoardState(context)).revision, before.revision);
    assert.ok(checks.slice(firstCheck).every(check => check.beforeRevision === check.revision));
    assert.ok(notifications.slice(firstCheck).every(change => change.stateChanged === false));
    releaseRead();
    await expect(page.locator("#wireSearchResults button")).not.toHaveCount(0, { timeout: 20000 });
    const ready = (await api("/api/search/status")).body;
    assert.equal(ready.mode, "hybrid"); assert.equal(ready.model.state, "ready"); assert.ok(ready.indexId);
    assert.equal(requests.length, 1, "No frontend resubmission is needed after quiet collection.");
    const ids = await page.locator("#wireSearchResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId));
    const readyCheck = checks.length;
    await untilChecks(readyCheck + 2);
    const unchanged = (await api("/api/search/status")).body;
    assert.equal(unchanged.indexId, ready.indexId);
    assert.equal(unchanged.corpus.generation, ready.corpus.generation);
    assert.deepEqual(await page.locator("#wireSearchResults button").evaluateAll(nodes => nodes.map(node => node.dataset.searchId)), ids);

    const blockedQuery = hold(), queryCheck = checks.length;
    await input.fill("workiq-retriev");
    await blockedQuery;
    await untilChecks(queryCheck + 1);
    assert.equal((await api("/api/search/status")).body.indexId, ready.indexId);
    releaseRead();
    await expect(page.locator("#wireSearchResults button")).not.toHaveCount(0, { timeout: 10000 });
    assert.equal(requests.length, 2);

    const supersededQuery = hold();
    await input.fill("workiq-retrieve");
    await supersededQuery;
    const newCheck = checks.length;
    await fs.appendFile(file, events().map(event => JSON.stringify(event) + "\n").join(""));
    await untilChecks(newCheck + 1);
    assert.equal(notifications.at(-1).stateChanged, true);
    const changed = (await api("/api/search/status")).body;
    assert.equal(changed.indexId, null);
    releaseRead();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    assert.ok((await loadBoardState(context)).evidenceRevision > before.evidenceRevision);
    await input.fill("workiq-retriev");
    await expect(page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]')).toHaveCount(2, { timeout: 20000 });
    const rebuilt = (await api("/api/search/status")).body;
    assert.notEqual(rebuilt.indexId, ready.indexId);
    await page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]').first().click();
    await expect(page).toHaveURL(/#request\?.*call=/);
    await page.goBack();
    await expect(input).toHaveValue("workiq-retriev");

    db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(new Date().toISOString(), sourceId);
    await runtime.collector.collectNow();
    assert.equal(notifications.at(-1).stateChanged, true);
    assert.equal((await api("/api/search/status")).body.indexId, null, "An eligibility change must invalidate current membership.");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    assert.ok(opened);
    assert.equal((await api("/api/search/open", { ...opened, openId: opened.openId + 1 })).status, 409);
    db.prepare("UPDATE sessions SET archived_at=NULL WHERE id=?").run(sourceId);
    await runtime.collector.collectNow();
    await input.fill("workiq-retrieve");
    await expect(page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]')).toHaveCount(2, { timeout: 20000 });
    await runtime.collector.configure({ appDbPath, sessionRoot, approved: true, enabled: true, windowDays: 7, pollSeconds: 5 });
    assert.equal((await api("/api/search/status")).body.indexId, null, "An approved source-window change must invalidate membership.");
    await input.fill("workiq-retriev");
    await expect(page.locator('#wireSearchResults button[aria-label^="Open recorded call:"]')).toHaveCount(2, { timeout: 20000 });
    await runtime.collector.close();
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0, { timeout: 5000 });
    assert.equal((await api("/api/search/status")).body.indexId, null);
    assert.deepEqual(errors, []);
    assert.equal((await api("/api/search/close")).body.state, "closed");
    assert.equal(runtime.search.status().panels, 0);
    t.diagnostic(JSON.stringify({ quietBuildChecks: 3, quietReadyChecks: 2, quietQueryChecks: 1,
        queryRequests: requests.length, initialItems: ready.items, initialChunks: ready.chunks,
        realChange: "new call during query, archive eligibility, source window and source closure", model: ready.model.state }));
});
