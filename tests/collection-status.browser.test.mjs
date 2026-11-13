import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { createCollectionStatus } from "../lib/collection-status.mjs";
import { createCollector, collectionSummary } from "../lib/collector.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, chooseTheme, navigateMain } from "./helpers.mjs";
import { selectAnalyzeRequest } from "./report-journey-helpers.mjs";

for (const late of ["failure", "success", "transport-error", "composite-failure"]) test(`a late pre-return collection ${late} cannot replace newer status`, { timeout: 20000 }, async t => {
    const sourceSessionId = randomUUID(), retained = fixture(), timestamp = new Date(Date.now() - 1000).toISOString();
    const cleanup = [], { root, context } = await privateFixture({ after: work => cleanup.push(work) },
        [{ ...retained, sourceSessionId, capturedAt: timestamp, userPrompt: { ...retained.userPrompt, sourceTimestamp: timestamp },
            toolCalls: retained.toolCalls.map(call => ({ ...call, startedAt: timestamp })) }]);
    const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
    await mkdir(sessionRoot);
    const db = new DatabaseSync(appDbPath);
    db.exec(`PRAGMA user_version=156; PRAGMA journal_mode=WAL;
        CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,session_type TEXT,archived_at TEXT,execution_location TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE workspaces(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,name TEXT,archived_at TEXT,host_id TEXT,workspace_type TEXT);`);
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sourceSessionId, "Invented status recovery", "chat", null, "local");
    await mkdir(path.join(sessionRoot, sourceSessionId));
    await writeFile(path.join(sessionRoot, sourceSessionId, "events.jsonl"), JSON.stringify({
        id: "invented-start", type: "session.start", timestamp: new Date().toISOString(), data: { sessionId: sourceSessionId, version: 1 },
    }) + "\n");
    const collector = await createCollector(context, { timers: false });
    let runtime, access, browser;
    t.after(async () => {
        await browser?.close(); await runtime?.close(); await access?.close(); await collector.close(); db.close();
        for (const work of cleanup) await work();
    });
    await collector.configure({ appDbPath, sessionRoot, approved: true, enabled: true, pollSeconds: 5, windowDays: 30 });
    const before = await loadBoardState(context), diagnostics = [];
    const log = t.mock.method(console, "error", (...args) => diagnostics.push(args));
    const prepare = DatabaseSync.prototype.prepare;
    const metadataChange = t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
        const statement = prepare.call(this, sql);
        if (sql === "PRAGMA user_version") {
            const get = statement.get.bind(statement);
            statement.get = () => {
                const result = get();
                db.exec("INSERT INTO projects VALUES('invented-unrelated-project','Unrelated app metadata')");
                return result;
            };
        }
        return statement;
    });
    try { await assert.rejects(collector.collectNow(), { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" }); }
    finally { metadataChange.mock.restore(); log.mock.restore(); }
    const failed = collectionSummary(await collector.status());
    assert.equal(failed.state, "error");
    assert.deepEqual(diagnostics[0][1], { code: "COLLECTION_SOURCE_CHANGED", stage: "source-read", sourceChange: "metadata-read" });
    const recovered = collectionSummary(await collector.collectNow());
    assert.equal(recovered.error, null);
    assert.equal(recovered.revision, failed.revision, "Collector recovery need not change retained evidence.");
    assert.deepEqual((await loadBoardState(context)).evidence, before.evidence);
    await collector.close();
    access = await createCopilotRuntimeAccess(context);
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, access });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = [], writes = [], reads = [], prepares = [], release = Promise.withResolvers(), held = Promise.withResolvers();
    let compositeReads = 0, serverRuntime;
    await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.collectionReads = { pending: 0, decoded: 0, watches: [] };
        window.fetch = async (...args) => {
            const url = String(args[0]), watch = url.endsWith("/api/access/watch"), startedAt = performance.now();
            if (!watch && !/\/api\/collection\/(?:sources\/)?status$/.test(url)) return original(...args);
            if (!watch) window.collectionReads.pending++;
            const response = await original(...args), json = response.json.bind(response);
            response.json = async () => {
                try {
                    const value = await json();
                    if (watch) window.collectionReads.watches.push({ startedAt, deliveredAt: performance.now(), runtimeId: value.runtimeId });
                    return value;
                } finally {
                    if (!watch) { window.collectionReads.pending--; window.collectionReads.decoded++; }
                }
            };
            return response;
        };
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (/\/api\/(?:collection\/(?:now|configure|enabled)|access\/command|export)$/.test(request.url())) writes.push(request.url());
        if (request.url().endsWith("/api/preview")) prepares.push(request.postData());
    });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        await route.fulfill({ response, json: { ...payload, collection: {
            ...payload.collection, ...recovered,
            sourceAware: { ...payload.collection.sourceAware, github: { ...payload.collection.sourceAware.github, status: recovered } },
        } } });
    });
    await page.route("**/api/collection/status", async route => {
        const response = await route.fetch(), payload = await response.json();
        serverRuntime = response.headers()["x-wire-runtime"];
        const order = reads.length;
        reads.push(order);
        if (order === 0 && late !== "composite-failure") { held.resolve(); await release.promise; }
        if (order === 0 && late === "transport-error") return route.fulfill({ response, status: 503,
            json: { error: "Invented old status read unavailable." } });
        const status = order === 0 ? (late.endsWith("failure") ? failed : recovered) : (late === "success" ? failed : recovered);
        await route.fulfill({ response, json: { ...payload, ...status } });
    });
    if (late === "composite-failure") await page.route("**/api/collection/sources/status", async route => {
        const response = await route.fetch(), composite = await response.json(), order = compositeReads++;
        if (order === 0) { held.resolve(); await release.promise; }
        await route.fulfill({ response, json: { ...composite,
            github: { ...composite.github, status: order === 0 ? failed : recovered } } });
    });
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await selectAnalyzeRequest(page, page.locator(".activity-card").first());
    if (late === "failure") {
        await navigateMain(page, "reports");
        const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#reportPreset-all").click();
        assert.equal((await prepared).status(), 200);
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await navigateMain(page, "analyze");
    }
    const selection = await page.locator("#previewSelectionSummary").textContent();
    const card = await page.locator(".request-card-open").first().elementHandle();
    await card.focus();
    const visibility = hidden => page.evaluate(hidden => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        return new Promise(resolve => requestAnimationFrame(() => resolve({
            workspace: !document.getElementById("workspace").hidden,
            checking: !document.getElementById("accessShell").hidden,
            at: performance.now(), watch: window.collectionReads.watches.at(-1),
        })));
    }, hidden);
    try {
        await visibility(false);
        await held.promise;
        await visibility(true);
        const secondResponse = page.waitForResponse(response => response.url().endsWith("/api/collection/sources/status"));
        const firstFrame = await visibility(false);
        if (process.env.WIRE_COLLECTION_WARNING_PROOFS) {
            await mkdir(process.env.WIRE_COLLECTION_WARNING_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_COLLECTION_WARNING_PROOFS, `${late}-return.png`) });
        }
        await (await secondResponse).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const latestFailed = late === "success";
        await expect(page.locator("#collectionStatus")).toHaveText(latestFailed ? "Collection cannot check history" : "Collection active");
        const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        assert.equal(firstFrame.workspace, true);
        assert.equal(firstFrame.checking, false);
        assert.equal(firstFrame.watch.runtimeId, serverRuntime);
        assert.ok(firstFrame.at - firstFrame.watch.startedAt < 5000, "Return uses genuinely fresh authority.");
        release.resolve();
        await page.waitForFunction(() => window.collectionReads.pending === 0 && window.collectionReads.decoded >= 3);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator("#collectionNotice").isVisible(), latestFailed,
            "An old status must neither restore a recovered error nor hide the current failure.");
        await expect(page.locator("#collectionStatus")).toHaveText(latestFailed ? "Collection cannot check history" : "Collection active");
        assert.equal(await card.evaluate(node => node.isConnected), true);
        assert.equal(await card.evaluate(node => node === document.activeElement), true);
        assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), position);
        assert.equal(await page.locator("#previewSelectionSummary").textContent(), selection);
        if (late === "failure") {
            assert.equal(prepares.length, 1, "Status recovery must not reprepare a frozen report.");
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        }
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
        t.diagnostic(JSON.stringify({ diagnostic: diagnostics[0][1], firstFrame, statusReads: reads.length,
            retainedRevision: recovered.revision, serverRuntime }));
    } finally { release.resolve(); }
});

test("history issues are scoped, bounded and stable during polling in both themes and touch layouts", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce", hasTouch: true });
    const failures = [], mutations = [], model = createCollectionStatus();
    page.on("pageerror", e => failures.push(e.message));
    page.on("request", r => { if (/\/api\/(?:export|preview|record|privacy-review|collection\/(?:now|enabled|configure))$/.test(r.url())) mutations.push(r.url()); });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const sources = Array.from({ length: 15 }, (_, i) => ({ sessionId: `source-${i}`, name: `Synthetic unavailable session ${i + 1}`,
        project: i % 2 ? null : "Synthetic project", projectId: i % 2 ? null : "synthetic-project", eligible: true }));
    sources.push({ sessionId: "limited", name: "Synthetic limited session", eligible: true });
    let cursors = sources.map(r => ({ sessionId: r.sessionId, lastAttemptAt: "2026-10-05T01:00:00Z",
        ...(r.sessionId === "limited" ? { scanned: true, cursor: { droppedBytes: 10, oversizedLines: 2 }, diagnostics: { contextEvictions: 3 } }
            : { error: "PRIVATE_ERROR token=private <img src=x onerror=alert(1)>", errorCode: "ENOENT" }) }));
    let detailedReads = 0;
    const status = () => {
        const { summary, issues } = model.coverage(sources, cursors, ["source-0"]);
        return { state: "collecting-on-interval", revision: before.revision, lastCheckedAt: "2026-10-05T01:00:00Z", lastNewDataAt: "2026-10-04T23:00:00Z",
            connected: true, config: { approved: true, enabled: true, appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state", pollSeconds: 5, windowDays: 30 },
            discovery: { counts: { sessions: 20, eligible: 16, dispositions: { eligible: 16, archived: 4 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
            cadence: { pollSeconds: 5 }, metrics: {}, historyCoverage: summary, historyIssues: issues, sourceErrors: summary.unavailable };
    };
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), payload = await response.json();
        const { historyIssues, ...summary } = status();
        await route.fulfill({ response, json: { ...payload, collection: summary } });
    });
    await page.route("**/api/collection/status", async route => {
        const detail = route.request().postDataJSON().details === true;
        if (detail) detailedReads++;
        const { historyIssues, ...summary } = status();
        await route.fulfill({ json: detail ? { ...summary, historyIssues } : summary });
    });
    await page.goto(runtime.url);
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    assert.equal(await page.locator("#collectionStatus").textContent(), "Collection active");
    assert.match(await page.locator("#collectionIssueLabel").textContent(), /16 chats with history gaps/);
    assert.equal(await page.locator("#collectionNotice").isVisible(), false);
    assert.equal(await page.locator("#collectionStrip").isVisible(), false);
    assert.equal(await page.locator("#collectionSetup").getAttribute("open"), null);
    assert.equal(detailedReads, 0, "No personal issue inventory requested until opened");
    const chartBefore = await page.locator("#chart").innerHTML();
    await navigateMain(page, "collection-status");
    await page.locator(".history-reason>summary").first().waitFor();
    assert.equal(await page.locator(".history-issue").count(), 0, "Reasons start closed; no extra outer Issues disclosure");
    await page.locator(".history-reason>summary").first().click();
    await page.locator(".history-issue").first().waitFor();
    assert.equal(await page.locator(".history-issue").count(), 6);
    assert.match(await page.locator("#collectionIssuesBody").innerText(), /not failed Work IQ or Graph requests/);
    const first = page.locator(".history-issue>summary").first();
    await first.focus(); await page.keyboard.press("Space");
    assert.match(await page.locator(".history-issue-detail").innerText(), /Previously collected evidence.*kept/);
    assert.match(await page.locator(".history-issue-detail").innerText(), /Oct 4, 2026.*GMT-7/);
    assert.doesNotMatch(await page.locator("#collectionIssuesBody").innerText(), /PRIVATE_ERROR|token=private|onerror|C:\\synthetic/);
    await first.evaluate(node => { window.issueFocusNode = node; });
    const scrollBefore = await page.evaluate(() => scrollY);
    const initialReads = detailedReads;
    cursors = cursors.map(r => ({ ...r, lastAttemptAt: "2026-10-05T01:01:00Z" }));
    await page.waitForFunction(() => document.querySelector("[data-history-attempt]").textContent.includes("6:01:00"));
    assert.ok(detailedReads > initialReads);
    assert.equal(await page.evaluate(() => document.activeElement === window.issueFocusNode && window.issueFocusNode.isConnected), true);
    assert.ok(Math.abs((await page.evaluate(() => scrollY)) - scrollBefore) < 2);
    assert.equal(await page.locator("#chart").innerHTML(), chartBefore);
    sources.unshift({ sessionId: "new-first", name: "New synthetic source", eligible: true });
    cursors.unshift({ sessionId: "new-first", error: "missing", errorCode: "ENOENT", lastAttemptAt: "2026-10-05T01:01:00Z" });
    await page.waitForFunction(() => document.querySelector("#collectionIssueLabel").textContent.includes("17 chats"));
    assert.equal(await first.evaluate(node => node === document.activeElement), true, "New issues append without moving an existing focused source");
    assert.match(await page.locator("#collectionIssueCounts").innerText(), /16 unavailable\s+1 limited/);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /7-12 of 16 affected Copilot chats/);
    await page.getByRole("button", { name: "Next affected Copilot chats", exact: true }).click();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /13-16 of 16 affected Copilot chats/);
    assert.equal(await page.locator(".history-issue").count(), 4);
    await page.locator(".history-reason>summary").last().click();
    await page.locator(".history-reason").last().locator(".history-issue>summary").click();
    assert.match(await page.locator(".history-reason").last().innerText(), /No evidence has been collected/);
    assert.match(await page.locator(".history-reason").last().innerText(), /earlier chat context/);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 900 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            for (const selector of [".history-reason>summary", "#collectNow", "#pauseCollection", "#collectionSetup>summary", ".history-issue>summary"]) {
                for (const box of await page.locator(selector).evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(n => ({ height: n.getBoundingClientRect().height })))) assert.ok(box.height >= 44, `${selector} touch target`);
            }
        }
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await navigateMain(page, "settings");
    assert.equal(await page.locator("#collectionIssuesBody").isVisible(), false);
    await page.goBack();
    await page.locator(".history-reason").last().locator(".history-issue-detail").waitFor();
    assert.match(await page.locator("#collectionIssueGroups").innerText(), /13-16 of 16 affected Copilot chats/);
    cursors = cursors.map(r => ({ ...r, error: null, errorCode: null, scanned: true, cursor: {}, diagnostics: {} }));
    await page.waitForFunction(() => document.querySelector("#collectionIssueLabel").textContent === "No history gaps reported");
    assert.equal(await page.locator("#issueSearch").isVisible(), false);
    assert.equal(await page.locator("#collectionIssueCounts").isVisible(), false);
    assert.equal(await page.locator("#collectionIssueGroups").isVisible(), false);
    assert.equal(await page.locator("#chart").innerHTML(), chartBefore);
    const after = await loadBoardState(context);
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.exports, before.exports);
    assert.deepEqual(mutations, []);
    assert.deepEqual(failures, []);
});
