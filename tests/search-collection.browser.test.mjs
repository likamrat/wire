import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { AsyncResource, createHook } from "node:async_hooks";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { privateFixture } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { openReportComparison } from "./report-journey-helpers.mjs";

test("literal Search follows real collection advances while saved-report Compare stays frozen", { timeout: 45000 }, async t => {
    const cleanup = [], { root, context } = await privateFixture({ after: work => cleanup.push(work) }, []);
    const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state"), sourceId = randomUUID();
    const db = new DatabaseSync(appDbPath);
    db.exec(metadata174Schema);
    db.prepare("INSERT INTO sessions(id,title,session_type,execution_location) VALUES(?,?,?,?)")
        .run(sourceId, "Invented continuing Search history", "chat", "local");
    db.close();
    const sourceFile = path.join(sessionRoot, sourceId, "events.jsonl");
    const events = () => {
        const toolCallId = randomUUID(), timestamp = new Date(Date.now() - 1000).toISOString();
        return [
            { type: "user.message", data: { content: "Review the invented GitHub records." } },
            { type: "tool.execution_start", data: { toolName: "workiq-retrieve", toolCallId, arguments: { query: "invented records" } } },
            { type: "tool.execution_complete", data: { toolCallId, success: true } },
        ].map(value => ({ ...value, id: randomUUID(), timestamp }));
    };
    const lines = rows => rows.map(row => JSON.stringify(row) + "\n").join("");
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, lines([{ id: randomUUID(), type: "session.start", timestamp: new Date().toISOString(),
        data: { sessionId: sourceId, version: 1 } }, ...events()]));
    await fs.mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await fs.writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify({
        schemaVersion: 1, approved: true, enabled: true, appDbPath, sessionRoot, windowDays: 30, pollSeconds: 5,
    }));
    const timerScopes = new WeakSet(), scheduledCallbacks = new WeakSet(), timers = [], hook = createHook({ init(_id, type, _parent, resource) {
        if (type === "WIRENativeCollectorTimer") timerScopes.add(resource);
    } }).enable();
    const bind = AsyncResource.prototype.bind;
    t.mock.method(AsyncResource.prototype, "bind", function (...args) {
        const bound = Reflect.apply(bind, this, args);
        if (timerScopes.has(this)) scheduledCallbacks.add(bound);
        return bound;
    });
    const set = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
        const timer = set(callback, delay, ...args);
        // Advance the actual native scheduler callback, not all network/watch clocks.
        if (delay === 60000 && scheduledCallbacks.has(callback)) timers.push({ timer, callback });
        return timer;
    });
    let runtime, persistence, access, browser, captures = 0, changed = 0;
    const firstCapture = Promise.withResolvers(), nextCapture = Promise.withResolvers();
    const records = [...chatFixture(), ...coworkFixture()], account = records[0].scope.account;
    const transport = createMicrosoftNativeReadTransport({
        async open() {},
        async verifyAccount() { return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
            chat: true, cowork: true, evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } }; },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, sourceAware: true, globalCollection: null,
        collection: { paused: true, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    const errors = [], writes = [], searchReads = [], nativeSearch = [];
    let browserCapability;
    t.after(async () => {
        await browser?.close(); await runtime?.close(); access?.close(); persistence?.close(); await lifecycle.close(); hook.disable();
        for (const work of cleanup.reverse()) await work();
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    });
    persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true });
    access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
        sourceAware: true, nativeConnection: true, nativeAcquisition: true, nativeScheduling: true,
        async acquireNative(lease) {
            await lifecycle.assertLease(lease);
            const rows = structuredClone(records);
            if (captures) for (const row of chatFixture()) {
                row.scope.conversationId += "-continuing-search"; rows.push(row);
            }
            for (const row of rows) row.capture.generation = lease.generation;
            return rows;
        },
        completeNative(_ticket, receipt) {
            assert.equal(receipt?.status, "committed"); captures++;
            (captures === 1 ? firstCapture : nextCapture).resolve(receipt);
        },
    });
    runtime = await startServer(context, createExportController(context), { port: 0, access,
        collector: { timers: true, onCommitted(_check, change) { if (change.stateChanged) changed++; } },
        evaluation: { evaluatorFactory() { throw new Error("No model providers in this Search fixture."); } } });
    const origin = new URL(runtime.url).origin;
    async function post(route, input = {}, capability) {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(input) });
        const body = await response.json(); assert.equal(response.status, 200, body.error); return body;
    }
    const session = await post("/api/session");
    for (const action of ["wire-sign-in", "microsoft-connect"]) await post("/api/access/command", {
        schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
    }, session.capability);
    await post("/api/collection/now", {}, session.capability);
    const offer = (await post("/api/collection/sources/status", {}, session.capability)).microsoft.configurationOffer;
    await post("/api/collection/microsoft/configure", {
        schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
        globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision,
        surfaces: offer.values.surfaces, windowDays: offer.values.windowDays,
    }, session.capability);
    await firstCapture.promise;
    const saved = [];
    for (const title of ["Invented earlier report", "Invented later report"]) {
        const snapshot = await post("/api/snapshot", { layer: "tool", filters: { scope: "all" } }, session.capability);
        const preview = await post("/api/preview", { nativeViewId: snapshot.nativeRead.allViewId,
            selection: { kind: "all", revision: snapshot.revision },
            options: { title, promptMode: "none", formats: ["html"] } }, session.capability);
        await post("/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true }, session.capability);
        saved.push((await post("/api/export", { previewId: preview.previewId, confirmed: true }, session.capability)).bundle);
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
    });
    page.on("request", request => {
        const route = new URL(request.url()).pathname;
        browserCapability ??= request.headers()["x-board-capability"];
        if (/^\/api\/(?:access\/command|collection\/.*(?:configure|enabled|now)|preview|export)$/.test(route)) writes.push(route);
        if (route === "/api/search/query") searchReads.push(request.postDataJSON());
    });
    page.on("response", response => {
        if (response.url().endsWith("/api/retained/microsoft/search") && response.ok()) void response.json().then(value => nativeSearch.push(value));
    });
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await openReportComparison(page);
    const compare = page.locator("#comparisonWorkspace");
    for (const [index, label] of ["Earlier report", "Later report"].entries()) {
        await compare.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup [data-value="${saved[index].bundleId}"]`).click();
    }
    await compare.getByRole("button", { name: "Compare reports", exact: true }).click();
    await expect(compare.locator(".comparison-native-results")).toBeVisible();
    const frozen = await compare.locator(".comparison-native-results").innerText(), before = await loadBoardState(context);
    await page.locator("#wireSearch").fill("invented");
    await expect(page.locator("#wireSearchResults button").first()).toBeVisible();
    await expect(page.locator("#wireNativeSearch .wire-search-hit").first()).toBeVisible();
    const proof = process.env.WIRE_SEARCH_ADVANCE_PROOFS;
    if (proof) {
        await fs.mkdir(proof, { recursive: true });
        await page.screenshot({ path: path.join(proof, "search-before-collection.png") });
    }
    await page.evaluate(() => { window.retiredNativeHit = document.querySelector("#wireNativeSearch .wire-search-hit"); });
    await expect.poll(() => timers.length).toBeGreaterThan(0);
    const changedBefore = changed, scheduled = timers.at(-1);
    clearTimeout(scheduled.timer); scheduled.callback();
    await fs.appendFile(sourceFile, lines(events()));
    await nextCapture.promise;
    await expect.poll(() => changed, { timeout: 10000 }).toBeGreaterThan(changedBefore);
    await expect.poll(() => nativeSearch.at(-1)?.revision, { timeout: 10000 }).toBeGreaterThan(before.revision);
    await expect(page.locator("#wireSearch")).toHaveValue("invented");
    await expect(page.locator("#wireNativeSearch .wire-search-hit").first()).toBeVisible();
    const compareUrl = page.url();
    await page.evaluate(() => window.retiredNativeHit.click());
    assert.equal(page.url(), compareUrl, "An old detached hit must not open a replacement record.");
    await page.locator("#wireSearch").fill("Review the invented GitHub records.");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(2);
    await expect(page.locator("#wireSearchCoverage")).toHaveText("Saved GitHub replies are unavailable for Search.");
    await page.locator("#wireSearch").fill("Read the invented records.");
    await expect(page.locator("#wireNativeSearch .wire-search-hit")).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator("#wireSearchResults button")).toHaveCount(0);
    await expect(page.locator("#wireSearchStatus")).toHaveText("Saved GitHub replies are unavailable for Search.");
    await expect(page.locator("#wireSearchPanel")).not.toContainText("No matches");
    await expect(page.locator("#wireSearchPanel")).not.toContainText("Saved content changed. Search again.");
    await expect(page.locator("#wireSearchPanel")).not.toContainText("NATIVE_REPORT_SOURCE_STALE");
    await expect(page.locator("#wireNativeSearch")).toContainText("1 match across saved dates.");
    await expect(page.locator("#wireNativeSearch")).not.toContainText("0 unavailable text");
    await expect(page.locator("#wireSearchCoverage")).toBeHidden();
    assert.equal(await compare.locator(".comparison-native-results").innerText(), frozen);
    assert.ok(nativeSearch.at(-1).revision > before.revision);
    assert.equal((await loadBoardState(context)).nativeRetention.settings.paused, false);
    assert.ok(searchReads.length < 8, "Known read refreshes must stay bounded rather than loop.");
    assert.equal(captures, 2, "Search must not replay acquisition.");
    if (proof) {
        await page.screenshot({ path: path.join(proof, "search-after-collection.png") });
        await fs.writeFile(path.join(proof, "search-advance.json"), JSON.stringify({
            beforeRevision: before.revision, afterRevision: nativeSearch.at(-1).revision,
            captures, queryRequests: searchReads.length, comparisonUnchanged: true, ordinaryMatches: 0, microsoftMatches: 1,
            nativeTarget: nativeSearch.at(-1).page.items[0].target,
            nativeSourceRevision: nativeSearch.at(-1).sourceRevision,
        }, null, 2));
    }
    const searchStatus = await post("/api/search/status", {}, browserCapability);
    assert.equal(searchStatus.corpus.state, "partial");
    assert.deepEqual(searchStatus.corpus.issues.map(({ code, types }) => ({ code, types })),
        [{ code: "not-authorized", types: ["reply"] }], "A real reply-coverage gap must not be hidden as recovered complete coverage.");
    const acceptedSearch = nativeSearch.at(-1), hit = acceptedSearch.page.items.find(item => item.source.sourceId === "microsoft-365-cowork");
    assert.ok(hit);
    await page.locator("#wireNativeSearch .wire-search-hit").click();
    const reader = page.locator("#requestContent"), original = reader.locator("[data-reader-section=source] [data-native-ordinal]").first();
    await expect(reader).toHaveAttribute("aria-busy", "false");
    await expect(original).toHaveAttribute("data-native-ordinal", String(hit.target.ordinal));
    await expect(original).toContainText("Read the invented records.");
    await expect(original).toBeFocused();
    const readingUrl = page.url();
    assert.equal(new URLSearchParams(new URL(readingUrl).hash.split("?")[1]).get("nativeRevision"), String(acceptedSearch.revision));
    const expandedCall = reader.locator(".reader-call").filter({ hasText: "mcp__graph__CallGraph" });
    await expandedCall.locator(".reader-call-toggle").click();
    await expect(expandedCall.getByRole("button", { name: "Copy input", exact: true })).toBeVisible();
    const readerText = await reader.innerText(), afterSearch = await loadBoardState(context), captureCount = captures;
    await page.evaluate(() => { window.currentReadNode = document.querySelector("#requestContent .reader-message"); });
    const continued = timers.at(-1);
    clearTimeout(continued.timer); continued.callback();
    await expect.poll(() => captures, { timeout: 10000 }).toBeGreaterThan(captureCount);
    await expect.poll(async () => (await loadBoardState(context)).revision, { timeout: 10000 }).toBeGreaterThan(afterSearch.revision);
    await expect(page.locator("#requestReportTitle"))
        .toHaveText("Reopen this conversation from current activity to change report selection.", { timeout: 10000 });
    assert.equal(page.url(), readingUrl);
    assert.equal(await reader.innerText(), readerText);
    assert.equal(await page.evaluate(() => currentReadNode.isConnected), true);
    await expect(reader).not.toContainText("This exact Microsoft record is unavailable");
    await expect(page.locator("#requestReportToggle")).toBeDisabled();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    assert.equal(await compare.locator(".comparison-native-results").innerText(), frozen);
    await page.locator("#wireSearch").fill("No invented record matches this phrase");
    await expect(page.locator("#wireSearchStatus")).toHaveText("Saved GitHub replies are unavailable for Search.");
    await expect(page.locator("#wireSearchRetry")).toBeHidden();
});

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
        port: 0,
        collector: { onCommitted(check, change) {
            checks.push(check);
            notifications.push(change);
            for (const waiter of [...waiters]) if (checks.length >= waiter.count) {
                waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve();
            }
        } },
    });
    const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
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
    assert.equal(ready.mode, "text"); assert.equal(Object.hasOwn(ready, "model"), false); assert.ok(ready.indexId);
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
        queryRequests: requests.length, initialItems: ready.items,
        realChange: "new call during query, archive eligibility, source window and source closure", mode: ready.mode }));
});
