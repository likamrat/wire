import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { privateFixture, fixture, navigateMain, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { assertNativeRequestAdmission } from "../lib/microsoft-native-host.mjs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

// Development-only Microsoft integration, using an invented local transport and a private store.
// After npm run build: node --test tests/native-report-save.qualification.mjs
async function setup(t, { segmented = false, mixed = false, dated = false, extraConversations = 0, shortPageSize = null,
    scheduled = false, enrolled = true, githubApproved = false, manualAcquisition = false, beforeAcquire,
    refreshProbe = false, backfillTracking = false, packaged = false } = {}) {

    const cleanup = [], { root: fixtureRoot, context } = await privateFixture({ after: work => cleanup.push(work) }, []);
    if (githubApproved) {

        const appDbPath = path.join(fixtureRoot, "data.db"), sessionRoot = path.join(fixtureRoot, "session-state");
        const db = new DatabaseSync(appDbPath);
        try { db.exec(metadata174Schema); } finally { db.close(); }
        await mkdir(sessionRoot);
        await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
        await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify({
            schemaVersion: 1, approved: true, enabled: true, windowDays: 30, pollSeconds: 5, appDbPath, sessionRoot,
        }));
    }
    const records = [...chatFixture(), ...coworkFixture()], account = records[0].scope.account;
    for (let index = 0; index < extraConversations; index++) {
        const more = coworkFixture();
        for (const row of more) {
            row.scope.conversationId += `-${index}`;
            if (row.record.task) row.record.task.sessionId = row.scope.conversationId;
        }
        records.push(...more);
    }
    if (dated) for (const [index, row] of records.filter(row => row.record.event === "ts").entries()) {
        const instant = index ? "2026-10-09T10:00:00.000Z" : "2026-10-02T10:00:00.000Z";
        row.record.data.ts = instant;
        row.qualifiedFields.observationTime = { availability: "recorded", scope: "observation", unit: "iso8601", basis: "cowork.data.ts", value: instant };
        row.evidenceReferences.observationTime = { sourceDocument: "invented-native-response",
            pointer: `/events/${row.ordering.recordOrdinal}/data/ts`, nativeEventId: row.record.id };
    }
    let persistence, access, runtime, browser, acquisitions = 0, failConnection = false;
    const captures = [], firstCapture = Promise.withResolvers();
    let captureWaiter;
    const transport = createMicrosoftNativeReadTransport({
        async open() {},
        async verifyAccount() {
            if (failConnection) throw new Error("Fixture connection unavailable.");
            return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
            chat: true, cowork: true, evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } }; },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, sourceAware: true, globalCollection: null,
        collection: { paused: true, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    t.after(async () => {
        await browser?.close(); await runtime?.close(); access?.close(); persistence?.close(); await lifecycle.close();
        for (const work of cleanup.reverse()) await work();
    });
    persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true, backfillTracking });
    access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence, nativeConnection: true,
        sourceAware: true, nativeAcquisition: scheduled || manualAcquisition, nativeScheduling: scheduled,
        async acquireNative(lease) {
            acquisitions++;
            if (!scheduled && !manualAcquisition) assert.fail("Report publication must not acquire source history.");
            await beforeAcquire?.();
            await lifecycle.assertLease(lease);
            const entries = structuredClone(records);
            if (acquisitions > 1) {
                const more = chatFixture();
                for (const row of more) row.scope.conversationId += `-scheduled-${acquisitions}`;
                entries.push(...more);
            }
            for (const row of entries) {
                row.capture.generation = lease.generation;
                if (manualAcquisition) row.capture.captureId += `-manual-${acquisitions}`;
            }
            return entries;
        },
        completeNative(_ticket, receipt) {
            if (!scheduled) return;
            assert.equal(receipt?.status, "committed");
            captures.push(receipt);
            firstCapture.resolve(receipt);
            captureWaiter?.resolve(receipt); captureWaiter = null;
        },
    });
    runtime = await startServer(context, createExportController(context), { port: 0, access, ...(packaged ? { frontend: "react" } : {}), collector: { timers: false } });
    const origin = new URL(runtime.url).origin;
    async function post(route, input, capability) {
        const response = await fetch(origin + route, { method: "POST", headers: {
            Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
        }, body: JSON.stringify(input) });
        const body = await response.json();
        assert.equal(response.status, 200, body.error);
        return body;
    }
    const setupPanel = await post("/api/session", {});
    for (const action of ["wire-sign-in", ...(enrolled ? ["microsoft-connect"] : [])]) await post("/api/access/command", {
        schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
    }, setupPanel.capability);
    const admission = { owner: "owned-publication-fixture", check() {}, dispatched() {} };
    if (enrolled) {
        const offer = (await post("/api/collection/sources/status", {}, setupPanel.capability)).microsoft.configurationOffer;
        await post("/api/collection/microsoft/configure", { schemaVersion: 2, intent: offer.intent,
            generation: offer.generation, authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
            expectedRevision: offer.expectedRevision, surfaces: offer.values.surfaces, windowDays: offer.values.windowDays }, setupPanel.capability);
        if (scheduled) await firstCapture.promise;
        else {
            const pending = await (segmented ? persistence.beginSegmented : persistence.begin)({ operationId: randomUUID() }, admission);
            await (segmented ? persistence.commitSegmented : persistence.commit)(pending.ticket, records);
            await persistence.retire(pending.ticket);
        }
    }
    if (mixed) await replaceEvidence(context, () => ({ records: [{ ...fixture("github-save-kept"), followUpPrompts: [] }],
        importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const handshake = await post("/api/session", {}), writes = [], reads = [], previews = [], prepared = [], reviews = [], errors = [], cancellations = [];
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const route = new URL(request.url()).pathname;
        if (["/api/export", "/api/artifact-deletion/confirm"].includes(route)) writes.push({ route, body: request.postDataJSON() });
        if (["/api/artifact-deletion/status", "/api/artifact-deletion/preview", "/api/artifact-deletion/eligibility", "/api/snapshot"].includes(route)) reads.push(route);
        if (route === "/api/preview") previews.push(request.postDataJSON());
        if (route === "/api/cancel-preview") cancellations.push(request.postDataJSON());
    });
    page.on("response", response => {
        const route = new URL(response.url()).pathname;
        if (response.ok() && ["/api/preview", "/api/privacy-review"].includes(route)) void response.json().then(value => {
            if (route === "/api/privacy-review") reviews.push(value);
            else prepared.push(value);
        });
    });
    let shell = renderHtmlShell(handshake.capability, "native-publication-ui", handshake.accessBootstrap);
    if (refreshProbe) {
        const declaration = "let refreshGesture = null;";
        assert.equal(shell.split(declaration).length, 2);
        shell = shell.replace(declaration, `${declaration}
            window.refreshReviewProbe = () => ({ gesture: refreshGesture, nativeRead: workspaceState.evidence?.nativeRead, nativeRecovery: nativeCollectIntent });`);
    }
    if (!packaged) await page.route(origin + "/", route => route.fulfill({ contentType: "text/html", body: shell }));
    if (shortPageSize) {
        // Model a byte-short producer page using genuine controller cursors and membership,
        // not sliced response rows or fabricated continuations.
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), value = await response.json();
            if (value.nativeRead?.status === "bounded") {
                const limit = value.nativeRead.page.limit;
                const bounded = await post("/api/retained/microsoft/query", {
                    schemaVersion: 1, revision: value.revision,
                    sources: ["microsoft-365-chat", "microsoft-365-cowork"],
                    analytics: route.request().postDataJSON(), page: { limit: shortPageSize, after: null },
                }, handshake.capability);
                value.nativeRead = { status: "bounded", ...bounded, page: { ...bounded.page, limit } };
                value.analytics.native = value.nativeRead;
            }
            await route.fulfill({ response, json: value });
        });
        await page.route("**/api/retained/microsoft/query", async route => {
            const input = route.request().postDataJSON(), limit = input.page.limit;
            const response = await route.fetch({ postData: { ...input, page: { ...input.page, limit: shortPageSize } } });
            const value = await response.json();
            if (response.ok()) value.page.limit = limit;
            await route.fulfill({ response, json: value });
        });
    }
    t.after(() => { assert.deepEqual(errors, []); if (!scheduled && !manualAcquisition) assert.equal(acquisitions, 0); });
    await page.goto(origin + "/");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    return { page, writes, reads, previews, prepared, reviews, cancellations, post: (route, input) => post(route, input, handshake.capability),
        board: () => loadBoardState(context), url: origin + "/", githubDatabase: path.join(fixtureRoot, "data.db"),
        command: async action => post("/api/access/command", { schemaVersion: 1, action, operationId: randomUUID(),
            generation: (await lifecycle.status()).generation }, handshake.capability),
        connectionFailure: value => { failConnection = value; },
        nextCapture: () => { captureWaiter = Promise.withResolvers(); return captureWaiter.promise; },
        captures, get acquisitions() { return acquisitions; },
        async addGithubActivity() {
            const sessionId = randomUUID(), callId = "review-private-github-call", at = new Date().toISOString();
            const db = new DatabaseSync(path.join(fixtureRoot, "data.db"));
            try {
                db.prepare("INSERT INTO sessions(id,title,session_type,archived_at,execution_location) VALUES(?,?,?,?,?)")
                    .run(sessionId, "Synthetic review source", "chat", null, "local");
            } finally { db.close(); }
            const folder = path.join(fixtureRoot, "session-state", sessionId);
            await mkdir(folder);
            const events = [
                ["session.start", { sessionId, version: 1 }],
                ["user.message", { content: "Synthetic private refresh request" }],
                ["tool.execution_start", { toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch", toolCallId: callId,
                    arguments: { entityUrls: ["/me/messages"] } }],
                ["tool.execution_complete", { toolCallId: callId, success: true }],
            ].map(([type, data]) => ({ id: randomUUID(), timestamp: at, type, data }));
            await writeFile(path.join(folder, "events.jsonl"), events.map(value => JSON.stringify(value) + "\n").join(""));
            return { sessionId, callId };
        },
        async damageRetiredRoot(file) {
            assert.match(file, /^[a-f0-9]{64}\.json$/);
            assert.ok(!(await loadBoardState(context)).nativeRetention.partitions.some(entry => entry.file === file));
            await writeFile(path.join(context.dataDir, "private-evidence", file), "damaged disposable retired root");
        },
        async pause() {
            return post("/api/collection/microsoft/enabled", { enabled: false,
                expectedNativeRevision: (await lifecycle.status()).authorizationRevision }, handshake.capability);
        },
        async advance() {
            const before = await loadBoardState(context);
            const more = chatFixture();
            for (const row of more) row.scope.conversationId += "-next-capture";
            const next = await (segmented ? persistence.beginSegmented : persistence.begin)({ operationId: randomUUID() }, admission);
            await (segmented ? persistence.commitSegmented : persistence.commit)(next.ticket, [...records, ...more]);
            await persistence.retire(next.ticket);
            const after = await loadBoardState(context);
            assert.ok(after.revision > before.revision);
            return { before, after };
        },
    };
}

async function prepare(page) {
    await navigateMain(page, "reports");
    await page.locator("#prepareReportPreview").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
}

for (const lost of [false, true]) test(`native Save keeps the original frozen population during ${lost ? "receipt recovery" : "scheduled collection"}`,
    { timeout: 180000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, scheduled: !lost, packaged: true }), { page } = app;
        const next = lost ? null : app.nextCapture();
        await prepare(page);
        const original = app.prepared.at(-1);
        assert.equal(original.snapshot.nativeEvidence.conversations.length, 2);
        if (lost) await page.route("**/api/export", async route => {
            const res = await route.fetch(); assert.equal(res.status(), 200);
            await app.advance(); await route.abort("connectionreset");
        }, { times: 1 });
        else assert.equal((await next).status, "committed");
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        if (lost) {
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
            await page.getByRole("button", { name: "Check save status", exact: true }).click();
        }
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const [saved] = (await app.board()).exports;
        assert.equal(saved.bundleId, original.bundleId);
        assert.equal(saved.selectionScope.nativeConversations, 2);
        assert.equal(await readFile(saved.files["product-report.html"], "utf8"), original.files["product-report.html"]);
        assert.equal(app.writes.filter(row => row.route === "/api/export").length, 1);
        assert.equal(app.previews.length, 1);
        const current = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
        assert.equal(current.nativeRead.aggregates.conversations, 3);
        if (!lost) assert.equal((await app.board()).nativeRetention.settings.paused, false);
    });

test("ordinary native All activity uses the retained population through local Save and verified Open", { timeout: 60000 }, async t => {
    const app = await setup(t, { segmented: true, packaged: true }), { page } = app;
    await expect(page.locator("body")).toHaveClass(/wire-frontend-react/);
    await navigateMain(page, "reports");
    await expect(page.locator("#reportDeskDates")).toHaveText("All retained dates");
    await expect(page.locator("#reportDeskDates")).toBeDisabled();
    await expect(page.locator("#reportDeskFocus")).toHaveValue("all");
    await expect(page.locator("#reportDeskFocus")).toBeDisabled();
    let mixedStatus;
    await page.route("**/api/preview", async route => {
        const input = route.request().postDataJSON();
        const invalid = await route.fetch({ postData: { ...input, options: { ...input.options,
            reportFocus: { version: 1, preset: "all", outcome: "all", services: [] } } } });
        mixedStatus = invalid.status();
        await route.continue();
    }, { times: 1 });
    const response = page.waitForResponse(res => res.url().endsWith("/api/preview"));
    await page.locator("#prepareReportPreview").click();
    const res = await response, prepared = await res.json();
    assert.equal(res.status(), 200, prepared.error);
    assert.equal(mixedStatus, 422, "A native view and an interaction focus cannot be combined.");
    const request = app.previews.at(-1);
    assert.ok(request.nativeViewId);
    assert.equal(request.selection.kind, "all");
    assert.equal(request.options.reportFocus, undefined);
    assert.deepEqual(request.options.dateSelection, { range: "capture" });
    assert.equal(prepared.snapshot.nativeEvidence.conversations.length, 2);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toBeVisible();
    const [saved] = (await app.board()).exports;
    assert.equal(saved.bundleId, prepared.bundleId);
    assert.equal(await readFile(saved.files["product-report.html"], "utf8"), prepared.files["product-report.html"]);
    assert.equal(app.writes.filter(w => w.route === "/api/export").length, 1);
    await app.pause();
    assert.equal((await app.board()).nativeRetention.settings.paused, true);
    const original = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "html" });
    assert.equal(Buffer.from(original.data, "base64").toString(), prepared.files["product-report.html"]);
    await app.command("wire-sign-out");
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#savedReportReader iframe")).toHaveCount(0);
});

test("a GitHub-only Analyze view cannot erase the native source from Current or restrict All", async t => {
    const app = await setup(t, { segmented: true, mixed: true, packaged: true }), { page } = app;
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page);
    await navigateMain(page, "reports");
    await page.locator("#reportDeskActivity").click();
    await page.getByRole("radio", { name: /^Current Analyze view/ }).check();
    await page.getByRole("button", { name: "Use activity", exact: true }).click();
    await page.locator("#prepareReportPreview").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    const original = app.prepared.at(-1);
    assert.ok(app.previews.at(-1).nativeViewId);
    assert.equal(original.snapshot.nativeEvidence.conversations.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const [saved] = (await app.board()).exports;
    assert.ok(saved.nativeSourceBinding);
    assert.equal(await readFile(saved.files["product-report.html"], "utf8"), original.files["product-report.html"]);
    await page.goto(new URL("/reports", app.url).href);
    await page.locator("#reportDeskActivity").click();
    await page.getByRole("radio", { name: /^All collected activity/ }).check();
    await page.getByRole("button", { name: "Use activity", exact: true }).click();
    await page.locator("#prepareReportPreview").click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 2);
    assert.deepEqual((await app.board()).exports.map(entry => entry.bundleId), [saved.bundleId]);
});

test("combined Refresh checks both admitted sources once and applies one stable view", { timeout: 45000 }, async t => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true,
        beforeAcquire: async () => { entered.resolve(); await gate.promise; } }), { page } = app;
    await navigateMain(page, "analyze");
    const before = await app.board();
    const basis = await app.post("/api/collection/sources/status", {});
    const writes = [];
    page.on("request", request => {
        if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push({
            path: new URL(request.url()).pathname, input: request.postDataJSON(),
        });
    });
    const chart = await page.locator("#outcomeChart").boundingBox();
    await page.locator("#analyzeRefresh").focus(); await page.keyboard.press("Enter");
    await entered.promise;
    await expect(page.locator("#analyzeRefresh")).toBeDisabled();
    await expect(page.locator("#analyzeRefreshLabel")).toHaveText("Refresh");
    await expect(page.locator("#freshAwayNotice")).toBeHidden();
    assert.deepEqual(await page.locator("#outcomeChart").boundingBox(), chart);
    await page.locator("#analyzeRefresh").evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.deepEqual(writes.map(write => write.path), ["/api/collection/now", "/api/collection/microsoft/now"]);
    assert.deepEqual(writes[0].input.expectedBasis, { generation: basis.generation, configVersion: basis.github.status.configVersion });
    assert.deepEqual(writes[1].input.expectedBasis, { generation: basis.generation, accountRef: basis.microsoft.status.accountRef,
        configurationRevision: basis.microsoft.status.configuration.configurationRevision,
        privacyRevision: basis.microsoft.status.configuration.privacyRevision, globalRevision: basis.global.revision });
    gate.resolve();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: activity saved.");
    await expect(page.locator("#analyzeRefresh")).toBeEnabled();
    assert.equal(app.acquisitions, 1);
    const after = await app.board();
    assert.equal(after.nativeRetention.receipts.length, before.nativeRetention.receipts.length + 1);
    await navigateMain(page, "settings");
    await expect(page.locator("#freshStatus")).toHaveText("GitHub: no additional activity. Microsoft: activity saved.");
    await expect(page.locator("#freshCoverageAnnouncement")).toHaveText("Microsoft: partial history.");
    await expect(page.locator("#collectMicrosoftActivity")).toHaveText("Collect Microsoft activity");
    await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
    await prepare(page);
    const frame = page.locator("#reportReviewBody iframe"), bytes = await frame.getAttribute("srcdoc");
    await navigateMain(page, "analyze");
    await expect(page.locator("#analyzeRefresh")).toBeDisabled();
    await page.locator("#analyzeRefresh").evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(writes.length, 2);
    await navigateMain(page, "reports");
    assert.equal(await frame.getAttribute("srcdoc"), bytes);
});

test("combined Refresh preserves a registered backfill window without promoting a data commit to history coverage",
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true, backfillTracking: true });
        const { page } = app, before = await app.board();
        const checkpoint = structuredClone(before.nativeRetention.backfill[0]);
        await navigateMain(page, "analyze");
        const reads = app.reads.filter(route => route === "/api/snapshot").length;
        await page.locator("#analyzeRefresh").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
        await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: activity saved.");
        assert.equal(app.reads.filter(route => route === "/api/snapshot").length - reads, 1);
        assert.equal(app.acquisitions, 1);
        assert.deepEqual((await app.board()).nativeRetention.backfill[0], checkpoint,
            "The compatible array-only source supplied no history-progress publication.");
        const aggregate = await app.post("/api/collection/sources/status", {});
        assert.equal(aggregate.microsoft.status.receipt.status, "committed");
        assert.equal(aggregate.microsoft.status.receipt.backfill, undefined);
        assert.equal(aggregate.microsoft.status.backfill.state, "started");
        assert.deepEqual(aggregate.microsoft.status.backfill.window, checkpoint.window);
        assert.deepEqual(aggregate.microsoft.status.backfill.sources.map(source => ({
            surface: source.surface, startQualified: source.startQualified, controlObserved: source.controlObserved,
            pages: source.pages, eligible: source.eligible, exhausted: source.exhausted,
        })), ["chat", "cowork"].map(surface => ({
            surface, startQualified: false, controlObserved: false, pages: 0, eligible: 0, exhausted: false,
        })));
        await navigateMain(page, "settings");
        await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("Chat history: Not checked yet.\nCowork history: Not checked yet.");
        await expect(page.locator("#sourceMicrosoftProgress .pending-indicator")).toHaveCount(0);
        await expect(page.locator("#freshCoverageAnnouncement")).toHaveText("Microsoft: partial history.");
    });

for (const mode of ["absent", "paused", "global-pause"]) test(`combined Refresh keeps the existing ${mode} source boundary`,
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true,
            enrolled: mode !== "absent", manualAcquisition: true }), { page } = app;
        if (mode === "paused") await app.pause();
        if (mode === "global-pause") {
            const status = await app.post("/api/collection/sources/status", {});
            await app.post("/api/collection/global/enabled", { schemaVersion: 1, enabled: false,
                generation: status.generation, authorizationRevision: status.authorizationRevision, expectedRevision: status.global.revision });
        }
        await page.reload();
        await navigateMain(page, "analyze");
        const before = await app.board(), writes = [];
        page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
        await page.locator("#analyzeRefresh").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
        await expect(page.locator("#analyzeRefreshStatus")).toHaveText(`GitHub: no additional activity. Microsoft: not checked (${mode === "absent" ? "not enabled" : "paused"}).`);

        assert.deepEqual(writes, ["/api/collection/now"]);
        assert.equal(app.acquisitions, 0);
        assert.deepEqual((await app.board()).nativeRetention, before.nativeRetention);
        const status = await app.post("/api/collection/sources/status", {});
        if (mode === "global-pause") assert.equal(status.global.paused, true);
        if (mode === "paused") assert.equal(status.microsoft.status.configuration.settings.paused, true);
    });

for (const lost of ["github", "microsoft", "both"]) test(`combined Refresh recovers unknown ${lost} without repeating either source`,
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true,
            refreshProbe: lost !== "github" }), { page } = app;
        await navigateMain(page, "analyze");
        const writes = [];
        page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push({
            path: new URL(request.url()).pathname, input: request.postDataJSON(),
        }); });
        const endpoints = lost === "both" ? ["**/api/collection/now", "**/api/collection/microsoft/now"]
            : [lost === "github" ? "**/api/collection/now" : "**/api/collection/microsoft/now"];
        for (const endpoint of endpoints) await page.route(endpoint, async route => {
            const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("connectionreset");
        }, { times: 1 });
        await page.locator("#analyzeRefresh").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
        await expect(page.locator("#analyzeRefreshStatus")).toHaveText(lost === "both"
            ? "GitHub: result unconfirmed. Microsoft: result unconfirmed." : lost === "github"
            ? "GitHub: result unconfirmed. Microsoft: activity saved." : "GitHub: no additional activity. Microsoft: result unconfirmed.");
        assert.equal(app.acquisitions, 1);
        assert.deepEqual(writes.map(write => write.path), ["/api/collection/now", "/api/collection/microsoft/now"]);
        const committed = (await app.board()).nativeRetention, lookups = [];
        if (lost === "microsoft") {
            const status = await app.post("/api/collection/sources/status", {});
            await app.post("/api/collection/global/enabled", { schemaVersion: 1, enabled: false,
                generation: status.generation, authorizationRevision: status.authorizationRevision, expectedRevision: status.global.revision });
        }
        page.on("request", request => { if (request.url().endsWith("/api/collection/microsoft/status")) lookups.push(request.postDataJSON()); });
        const reads = app.reads.filter(value => value === "/api/snapshot").length;
        await page.getByRole("button", { name: "Retry reading saved activity", exact: true }).click();
        if (lost !== "github") {
            await page.waitForFunction(() => window.refreshReviewProbe().gesture.recovering === false);
            assert.equal(app.reads.filter(value => value === "/api/snapshot").length - reads, 1,
                "Recovery applies exactly one final saved-activity view.");
        }
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", lost === "microsoft" ? "complete" : "unconfirmed");
        assert.equal(writes.length, 2);
        assert.equal(app.acquisitions, 1);
        assert.deepEqual((await app.board()).nativeRetention, committed);
        if (lost !== "github") assert.deepEqual(lookups, [{ operationId: writes[1].input.operationId }]);
        else assert.deepEqual(lookups, []);
        if (lost === "microsoft") assert.equal((await app.post("/api/collection/sources/status", {})).global.paused, true);
    });

test("review correction: a report opened during recovery keeps its bytes root and ordinals", { timeout: 45000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true, refreshProbe: true }), { page } = app;
    await navigateMain(page, "analyze");
    await page.route("**/api/collection/microsoft/now", async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("connectionreset");
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
    const arrived = Promise.withResolvers(), gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    await page.route("**/api/collection/microsoft/status", async route => {
        const response = await route.fetch(); arrived.resolve(); await gate.promise; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click(); await arrived.promise;
    await prepare(page);
    const frame = page.locator("#reportReviewBody iframe"), bytes = await frame.getAttribute("srcdoc");
    const originalFrame = await frame.elementHandle();
    const native = await page.evaluateHandle(() => window.refreshReviewProbe().nativeRead);
    const rootAndOrdinals = await native.evaluate(value => JSON.stringify(value));
    const request = structuredClone(app.previews.at(-1));
    const reads = app.reads.filter(value => value === "/api/snapshot").length;
    gate.resolve();
    await page.waitForFunction(() => window.refreshReviewProbe().gesture.recovering === false);
    assert.equal(app.reads.filter(value => value === "/api/snapshot").length - reads, 0, "Review must defer the sole final view application");
    assert.equal(await frame.getAttribute("srcdoc"), bytes);
    assert.equal(await frame.evaluate((node, original) => node === original, originalFrame), true);
    assert.equal(await native.evaluate(value => value === window.refreshReviewProbe().nativeRead), true);
    assert.equal(await native.evaluate(value => JSON.stringify(value)), rootAndOrdinals);
    assert.deepEqual(app.previews.at(-1), request);
    assert.equal(app.acquisitions, 1);
});

for (const held of ["native-reply", "view"]) test(`review correction: withdrawal scrubs held gesture references before and after late ${held}`,
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true, refreshProbe: true }), { page } = app;
        const markers = await app.addGithubActivity();
        await navigateMain(page, "analyze");
        const arrived = Promise.withResolvers(), gate = Promise.withResolvers(), delivered = Promise.withResolvers();
        t.after(() => gate.resolve());
        await page.route(held === "view" ? "**/api/snapshot" : "**/api/collection/microsoft/now", async route => {
            const response = await route.fetch(); arrived.resolve(); await gate.promise;
            try { await route.fulfill({ response }); } finally { delivered.resolve(); }
        }, { times: 1 });
        await page.locator("#analyzeRefresh").click(); await arrived.promise;
        const references = await page.evaluateHandle(() => {
            const gesture = window.refreshReviewProbe().gesture, branches = Object.values(gesture.branches);
            return { gesture, branches, flows: branches.map(branch => branch.flow), plan: gesture.plan,
                payloads: branches.flatMap(branch => [branch.result, branch.result?.check, branch.result?.check?.changes?.items,
                    branch.flow.snapshot().check, branch.flow.snapshot().check?.changes?.items,
                    branch.flow.snapshot().nativeReceipt, branch.intent?.readbackQualification]).filter(Boolean) };
        });
        const before = await references.evaluate(value => JSON.stringify(value.payloads));
        assert.ok(before.includes(markers.sessionId) && before.includes(markers.callId), "Hold real private GitHub delta identities, not an empty check");
        if (held === "view") assert.equal(await references.evaluate(value =>
            value.branches.some(branch => Boolean(branch.intent?.readbackQualification))), true);
        const originalId = await references.evaluate(value => value.branches.find(branch => branch.source === "microsoft").intent.operationId);
        await app.command("wire-sign-out");
        await expect(page.locator("#workspace")).toBeHidden();
        async function assertScrubbed() {
            const value = await references.evaluate(value => ({
                payloads: JSON.stringify(value.payloads), plan: JSON.stringify(value.plan),
                flows: value.flows.map(flow => flow.snapshot()),
                results: value.branches.map(branch => branch.result ?? null),
                qualifications: value.branches.map(branch => branch.intent?.readbackQualification ?? null),
                activeGesture: window.refreshReviewProbe().gesture,
                recovery: window.refreshReviewProbe().nativeRecovery
                    ? { keys: Object.keys(window.refreshReviewProbe().nativeRecovery).sort(),
                        operationId: window.refreshReviewProbe().nativeRecovery.operationId } : null,
            }));
            assert.ok(!value.payloads.includes(markers.sessionId) && !value.payloads.includes(markers.callId));
            assert.deepEqual(value.flows.map(flow => [flow.check, flow.nativeReceipt, flow.context, flow.details]), [[null, null, "", ""], [null, null, "", ""]]);
            assert.deepEqual(value.results, [null, null]);
            assert.deepEqual(value.qualifications, [null, null]);
            assert.equal(value.activeGesture, null);
            assert.deepEqual(value.recovery, { keys: ["operationId", "owner"], operationId: originalId });
            assert.equal(value.plan, "{}");
        }
        await assertScrubbed();
        gate.resolve(); await delivered.promise;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertScrubbed();
        assert.equal(app.acquisitions, 1);
    });

test("review correction: completed GitHub feedback retires while Microsoft recovery remains original", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true, refreshProbe: true }), { page } = app;
    const markers = await app.addGithubActivity();
    await navigateMain(page, "analyze");
    const writes = [], lookups = [];
    page.on("request", request => {
        if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(request.postDataJSON());
        if (request.url().endsWith("/api/collection/microsoft/status")) lookups.push(request.postDataJSON());
    });
    await page.route("**/api/collection/microsoft/now", async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("connectionreset");
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: 1 new activity record. Microsoft: result unconfirmed.");
    const held = await page.evaluateHandle(() => {
        const branch = window.refreshReviewProbe().gesture.branches.github;
        return { branch, flow: branch.flow, result: branch.result, check: branch.flow.snapshot().check };
    });
    const originalId = writes[1].operationId;
    const { after } = await app.advance();
    await page.waitForFunction(revision => window.refreshReviewProbe().nativeRead.revision >= revision, after.revision, { timeout: 10000 });
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("Microsoft: result unconfirmed.");
    assert.equal(await held.evaluate(value => value.branch.state), "retired");
    assert.equal(await held.evaluate(value => value.branch.dispatched), true, "Retirement cannot make the source runnable again");
    const stale = await held.evaluate(value => JSON.stringify([value.result, value.check, value.flow.snapshot()]));
    assert.ok(!stale.includes(markers.sessionId) && !stale.includes(markers.callId));
    assert.equal(await page.evaluate(() => window.refreshReviewProbe().gesture.branches.microsoft.intent.operationId), originalId);
    const beforeLookups = lookups.length;
    await page.locator("#analyzeRefresh").click();
    await page.waitForFunction(() => window.refreshReviewProbe().gesture.recovering === false);
    assert.deepEqual(lookups.slice(beforeLookups), [{ operationId: originalId }]);
    assert.equal(writes.length, 2);
    assert.equal(app.acquisitions, 1);
    await expect(page.locator("#analyzeRefreshStatus")).not.toContainText("GitHub:");
});

test("review correction: Retry retires completed feedback against its newer view while Microsoft stays unknown", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true, refreshProbe: true }), { page } = app;
    await app.addGithubActivity();
    await navigateMain(page, "analyze");
    const writes = [], lookups = [];
    page.on("request", request => {
        if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(request.postDataJSON());
        if (request.url().endsWith("/api/collection/microsoft/status")) lookups.push(request.postDataJSON());
    });
    await page.route("**/api/collection/microsoft/now", async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("connectionreset");
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: 1 new activity record. Microsoft: result unconfirmed.");
    const original = await page.evaluateHandle(() => window.refreshReviewProbe().gesture.branches.microsoft.intent);
    const originalId = writes[1].operationId;
    const arrived = Promise.withResolvers(), gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    await page.route("**/api/collection/microsoft/status", async route => {
        arrived.resolve(); await gate.promise; await route.abort("connectionreset");
    });
    const reads = app.reads.filter(value => value === "/api/snapshot").length;
    await page.locator("#analyzeRefresh").click(); await arrived.promise;
    const { after } = await app.advance();
    gate.resolve();
    await page.waitForFunction(() => window.refreshReviewProbe().gesture.recovering === false);
    assert.equal(await page.evaluate(() => window.refreshReviewProbe().nativeRead.revision), after.revision);
    assert.equal(app.reads.filter(value => value === "/api/snapshot").length - reads, 1);
    assert.equal(await page.locator("#analyzeRefreshStatus").textContent(), "Microsoft: result unconfirmed.");
    assert.deepEqual(await page.evaluate(() => {
        const branch = window.refreshReviewProbe().gesture.branches.github;
        return { state: branch.state, dispatched: branch.dispatched, result: branch.result };
    }), { state: "retired", dispatched: true, result: null });
    assert.equal(await original.evaluate(value => value === window.refreshReviewProbe().gesture.branches.microsoft.intent
        && value.operationId === window.refreshReviewProbe().nativeRecovery.operationId), true);
    await page.locator("#analyzeRefresh").click();
    await page.waitForFunction(() => window.refreshReviewProbe().gesture.recovering === false);
    assert.deepEqual(lookups, [{ operationId: originalId }, { operationId: originalId }]);
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("Microsoft: result unconfirmed.");
    assert.equal(writes.length, 2);
    assert.equal(app.acquisitions, 1);
});

test("combined Refresh preserves Microsoft success when the GitHub check fails", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    await rm(app.githubDatabase);
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: history check failed. Microsoft: activity saved.");
    assert.equal(app.acquisitions, 1);
    await navigateMain(page, "settings");
    await expect(page.locator("#freshContextMessage")).toContainText("GitHub:");
});

for (const withAdmission of [false, true])
test(`combined Refresh keeps a failed Microsoft acquisition unconfirmed and recovers only its original result${withAdmission ? " with screened admission" : ""}`, { timeout: 30000 }, async t => {
    const rejectAdmission = withAdmission ? assertNativeRequestAdmission : null;
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true,
        beforeAcquire: async () => {
            if (rejectAdmission) rejectAdmission(false, {
                url: new URL("https://login.microsoftonline.com/PRIVATE_ADMISSION_ROUTE?secret=PRIVATE_ADMISSION_QUERY"),
                method: "GET", type: "fetch", owned: true, original: true, navigation: false,
            }, "protocol", "auth-data");
            throw new Error("Synthetic Microsoft acquisition failure");
        } }), { page } = app;
    await navigateMain(page, "analyze");
    const writes = [];
    page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: result unconfirmed.");
    await expect(page.locator("#collectionNotice")).not.toContainText("Start a new collection");
    const retained = (await app.board()).nativeRetention;
    const original = await app.post("/api/collection/microsoft/status", { operationId: retained.receipts.at(-1).operationId });
    assert.equal(original.nativePersistence.receipt.status, "unknown");
    if (withAdmission) {
        const failure = retained.receipts.at(-1).firstFailure;
        assert.equal(failure.code, "NATIVE_SOURCE_REQUEST_UNQUALIFIED");
        assert.equal(failure.admission.predicate, "auth-data");
        assert.equal(failure.admission.publicRoute, "other");
        assert.equal(original.nativePersistence.receipt.firstFailure, undefined);
        assert.doesNotMatch(JSON.stringify({ retained, original }), /PRIVATE_ADMISSION_/);
        assert.doesNotMatch(await page.locator("#freshActivity").innerText(), /PRIVATE_ADMISSION_/);
    }
    await page.getByRole("button", { name: "Retry reading saved activity", exact: true }).click();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
    assert.equal(app.acquisitions, 1);
    assert.deepEqual(writes, ["/api/collection/now", "/api/collection/microsoft/now"]);
    assert.deepEqual((await app.board()).nativeRetention, retained);
});

test("combined Refresh retries a lost final view without repeating either committed source", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    const writes = [];
    page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.route("**/api/snapshot", async route => { const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("connectionreset"); }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
    const retained = (await app.board()).nativeRetention;
    assert.equal(retained.receipts.at(-1).status, "committed");
    await page.getByRole("button", { name: "Retry reading saved activity", exact: true }).click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: activity saved.");
    assert.deepEqual(writes, ["/api/collection/now", "/api/collection/microsoft/now"]);
    assert.equal(app.acquisitions, 1);
    assert.deepEqual((await app.board()).nativeRetention, retained);
});

test("combined Refresh rejects a native scope change at registration without losing the GitHub result", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    const before = (await app.board()).nativeRetention.receipts;
    await page.route("**/api/collection/microsoft/now", async route => {
        const status = await app.post("/api/collection/sources/status", {}), offer = status.microsoft.configurationOffer;
        await app.post("/api/collection/microsoft/configure", { schemaVersion: 2, intent: offer.intent,
            generation: offer.generation, authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
            expectedRevision: offer.expectedRevision, surfaces: offer.values.surfaces, windowDays: 90 });
        const response = await route.fetch();
        assert.equal(response.status(), 409);
        assert.equal((await response.json()).code, "NATIVE_RETENTION_EXPECTED_BASIS_CHANGED");
        await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: not checked (settings or access changed).");
    assert.equal(app.acquisitions, 0);
    assert.deepEqual((await app.board()).nativeRetention.receipts, before);
});

test("combined Refresh cannot dispatch its second source after withdrawal", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    const arrived = Promise.withResolvers(), gate = Promise.withResolvers(), writes = [];
    t.after(() => gate.resolve());
    page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?now$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.route("**/api/collection/now", async route => {
        const response = await route.fetch(); arrived.resolve(); await gate.promise; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click(); await arrived.promise;
    await app.command("wire-sign-out");
    await expect(page.locator("#workspace")).toBeHidden();
    gate.resolve();
    await expect(page.locator("#analyzeRefresh")).toBeHidden();
    assert.deepEqual(writes, ["/api/collection/now"]);
    assert.equal(app.acquisitions, 0);
});

for (const changed of ["github", "microsoft"]) test(`combined Refresh retains completed ${changed} work when its settings change before view application`,
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
        await navigateMain(page, "analyze");
        await page.route("**/api/collection/microsoft/now", async route => {
            if (changed === "github") {
                const status = await app.post("/api/collection/sources/status", {}), config = status.github.status.config;
                await app.post("/api/collection/configure", {
                    appDbPath: config.appDbPath, sessionRoot: config.sessionRoot, approved: true, enabled: config.enabled,
                    windowDays: 90, pollSeconds: config.pollSeconds, expectedConfigVersion: status.github.status.configVersion,
                });
            }
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            if (changed === "microsoft") {
                const status = await app.post("/api/collection/sources/status", {}), offer = status.microsoft.configurationOffer;
                await app.post("/api/collection/microsoft/configure", { schemaVersion: 2, intent: offer.intent,
                    generation: offer.generation, authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
                    expectedRevision: offer.expectedRevision, surfaces: offer.values.surfaces, windowDays: 90 });
            }
            await route.fulfill({ response });
        }, { times: 1 });
        await page.locator("#analyzeRefresh").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
        await expect(page.locator("#analyzeRefreshStatus")).toHaveText(changed === "github"
            ? "GitHub: check finished; settings changed. Microsoft: activity saved."
            : "GitHub: no additional activity. Microsoft: activity saved; settings changed.");
        await expect(page.locator("#analyzeRefresh")).toBeEnabled();
        await expect(page.locator("#analyzeRefreshLabel")).toHaveText("Refresh");
        assert.equal(app.acquisitions, 1);
        assert.equal((await app.board()).nativeRetention.receipts.at(-1).status, "committed");
    });

test("review correction: Settings names Microsoft-only acquisition as Refresh", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "settings");
    await expect(page.locator("#checkActivity")).toHaveAccessibleName("Refresh");
    await expect(page.locator("#checkActivity .settings-action-label")).toHaveText("Refresh");
    const writes = [];
    page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?(?:now|configure|enabled)$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshStatus")).toHaveText("GitHub: not checked (not connected). Microsoft: activity saved.");
    assert.deepEqual(writes, ["/api/collection/microsoft/now"]);
    assert.equal(app.acquisitions, 1);
});

test("review correction: a stored-read-labelled Settings gesture cannot acquire", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "settings");
    await page.locator("#checkActivity").evaluate(node => {
        node.setAttribute("aria-label", "Read stored activity");
        node.querySelector(".settings-action-label").textContent = "Read stored activity";
    });
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshStatus")).toHaveText("Stored activity refreshed.");
    assert.equal(app.acquisitions, 0);
});

test("combined Refresh can check Microsoft without GitHub approval and never creates source permission", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    const writes = [];
    page.on("request", request => { if (/\/api\/collection\/(?:microsoft\/)?(?:now|configure|enabled)$/.test(request.url())) writes.push(new URL(request.url()).pathname); });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: not checked (not connected). Microsoft: activity saved.");
    assert.deepEqual(writes, ["/api/collection/microsoft/now"]);
    assert.equal(app.acquisitions, 1);
    assert.equal((await app.post("/api/collection/sources/status", {})).github.status.config, null);
});

test("combined Refresh never adds a source that becomes available after the gesture", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await app.pause(); await page.reload(); await navigateMain(page, "analyze");
    await page.route("**/api/collection/now", async route => {
        const response = await route.fetch(), status = await app.post("/api/collection/sources/status", {});
        await app.post("/api/collection/microsoft/enabled", { enabled: true, expectedNativeRevision: status.authorizationRevision });
        await route.fulfill({ response });
    }, { times: 1 });
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: not checked (paused).");
    assert.equal(app.acquisitions, 0);
    assert.equal((await app.post("/api/collection/sources/status", {})).microsoft.status.configuration.settings.paused, false);
});

test("combined Refresh retires completed results when later stored activity arrives", { timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await app.advance();
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("", { timeout: 10000 });
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "idle");
    assert.equal(app.acquisitions, 1, "A later retained update cannot trigger another acquisition");
});

test("combined Refresh keeps an open native reader frozen while both sources finish", { timeout: 30000 }, async t => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true,
        beforeAcquire: async () => { entered.resolve(); await gate.promise; } }), { page } = app;
    await navigateMain(page, "analyze");
    await page.locator("#analyzeRefresh").click(); await entered.promise;
    await page.locator("#activityList .request-card-open").filter({ hasText: "Read the invented records." }).click();
    await expect(page.locator("#requestContent")).toContainText("Read the invented records.");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(3);
    await expect(page.locator("#requestContent")).not.toContainText("Reading saved activity...");
    await expect(page.locator("#requestContent")).toContainText("Context (1 saved record)");
    const content = await page.locator("#requestContent").innerText();
    const reader = await page.locator("#requestContent").elementHandle();
    gate.resolve();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    assert.equal(await page.locator("#requestContent").innerText(), content);
    assert.equal(await reader.evaluate(node => node === document.getElementById("requestContent")), true);
    assert.equal(app.acquisitions, 1);
});

for (const source of ["github-copilot", "microsoft-365"]) test(`combined Refresh keeps the ${source} display filter while checking both admitted sources`,
    { timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
        await navigateMain(page, "analyze");
        await selectActivityOption(page, "sourceFilter", source); await closeAnalyzeFilters(page);
        const origin = page.url();
        await page.locator("#analyzeRefresh").click();
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
        await expect(page.locator("#analyzeRefreshStatus")).toHaveText("GitHub: no additional activity. Microsoft: activity saved.");
        assert.equal(page.url(), origin);
        await expect(page.locator("#sourceFilter")).toHaveValue(source);
        assert.equal(app.acquisitions, 1);
    });

test("pending and failed report pages withhold old cards and retry from a current source snapshot",
    { timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, extraConversations: 11 }), { page } = app;
        await navigateMain(page, "reports");
        await page.locator("#reportDeskActivity").click();
        await page.getByRole("radio", { name: /^Selected interactions/ }).check();
        const list = page.locator("#reportList"), first = list.locator("[data-native-report-request]").first();
        const firstId = await first.getAttribute("data-native-report-request");
        await first.check();
        const retired = await first.elementHandle();
        let release;
        const held = new Promise(resolve => { release = resolve; });
        t.after(release);
        await page.route("**/api/retained/microsoft/query", async route => {
            await held;
            await route.fulfill({ status: 503, json: { error: "Fixture source page unavailable." } });
        }, { times: 1 });
        await list.getByRole("button", { name: "Next report requests", exact: true }).click();
        await expect(list.locator("[data-native-report-request]")).toHaveCount(0);
        await expect(list.locator("[data-page-position]")).toContainText("loading");
        await retired.evaluate(node => { node.checked = false; node.dispatchEvent(new Event("change", { bubbles: true })); });
        await expect(page.locator("#scopeSummary")).toContainText("1 retained Microsoft conversation selected");
        release();
        await expect(list.getByRole("alert")).toContainText("Fixture source page unavailable.");
        await expect(list.locator("[data-page-position]")).toContainText("unavailable");
        await expect(list.locator("[data-native-report-request]")).toHaveCount(0);
        await list.getByRole("button", { name: "Read current activity", exact: true }).click();
        await expect(list.locator("#report-native-select-" + firstId)).toBeChecked();
        const visible = await list.locator(".activity-card").count();
        assert.ok(visible > 1);
        await expect(list.locator("[data-page-position]")).toHaveText(`1-${visible} of 14 available cards`);
        assert.equal(app.previews.length, 0);
        assert.deepEqual(app.writes, []);
    });

test("report ranges follow byte-short source pages through the final cursor and back",
    { timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, extraConversations: 5, shortPageSize: 2 }), { page } = app;
        await navigateMain(page, "reports");
        await page.locator("#reportDeskActivity").click();
        await page.getByRole("radio", { name: /^Selected interactions/ }).check();
        const list = page.locator("#reportList"), position = list.locator("[data-page-position]");
        await expect(position).toHaveText("1-3 of 8 available cards");
        const first = list.locator("[data-native-report-request]").first();
        const firstId = await first.getAttribute("data-native-report-request");
        await first.check();
        for (const range of ["4-5", "6-7", "8-8"]) {
            await list.getByRole("button", { name: "Next report requests", exact: true }).click();
            await expect(position).toHaveText(`${range} of 8 available cards`);
        }
        await expect(list.locator(".activity-card")).toHaveCount(1);
        await expect(list.getByRole("button", { name: "Next report requests", exact: true })).toBeDisabled();
        const last = list.locator("[data-native-report-request]");
        const lastId = await last.getAttribute("data-native-report-request");
        await last.check();
        for (const range of ["6-7", "4-5", "1-3"]) {
            await list.getByRole("button", { name: "Previous report requests", exact: true }).click();
            await expect(position).toHaveText(`${range} of 8 available cards`);
        }
        await expect(list.locator("#report-native-select-" + firstId)).toBeChecked();
        await expect(page.locator("#reportPageSelectionSummary")).toHaveText("1 included outside this page.");
        await page.getByRole("button", { name: "Use activity", exact: true }).click();
        await page.locator("#prepareReportPreview").click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.deepEqual(new Set(app.previews.at(-1).selection.scenarioIds), new Set([firstId, lastId]));
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 2);
    });

for (const dismissal of ["move focus", "open during read", "failed read"]) test(`Delete ${dismissal} preserves inspector focus through a concurrent stored read`,
    { timeout: 45000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        const state = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
        const preview = await app.post("/api/preview", {
            nativeViewId: state.nativeRead.allViewId, selection: { kind: "all", revision: state.revision },
            options: { title: "Focus continuity fixture", promptMode: "none", formats: ["json"] },
        });
        await app.post("/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true });
        const saved = (await app.post("/api/export", { previewId: preview.previewId, confirmed: true })).bundle;
        await page.goto(new URL("/reports?task=library", app.url).href);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-library-row[data-bundle-id="${saved.bundleId}"]`).getByRole("button", { name: "Inspect details" }).click();
        const remove = page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true });
        const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
        if (dismissal !== "open during read") {
            await remove.click();
            await expect(dialog).toHaveAttribute("data-decision-phase", "confirm");
        }
        const arrived = Promise.withResolvers(), release = Promise.withResolvers();
        t.after(() => release.resolve());
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch();
            arrived.resolve();
            await release.promise;
            if (dismissal === "failed read") await route.fulfill({ status: 503, json: { error: "Stored fixture read unavailable." } });
            else await route.fulfill({ response });
        }, { times: 1 });
        await app.advance();
        await arrived.promise;
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        await expect(remove).toBeEnabled();
        if (dismissal === "open during read") {
            await remove.click();
            await expect(dialog).toHaveAttribute("data-decision-phase", "confirm");
        }
        const cancelling = page.waitForResponse(response => response.url().endsWith("/api/artifact-deletion/cancel"));
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).not.toBeVisible();
        assert.equal((await cancelling).status(), 200);
        await expect(remove).toBeFocused();
        assert.equal(app.reads.filter(route => route === "/api/artifact-deletion/preview").length, 1);
        if (dismissal === "move focus") {
            await page.keyboard.press("Tab");
            assert.equal(await remove.evaluate(node => node === document.activeElement), false);
        }
        const nextFocus = await page.evaluateHandle(() => document.activeElement);
        release.resolve();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        if (dismissal === "failed read") {
            await expect(remove).toBeDisabled();
            await remove.dispatchEvent("click");
            await expect(dialog).not.toBeVisible();
            assert.equal(app.reads.filter(route => route === "/api/artifact-deletion/preview").length, 1, "A failed read cannot permit another preview.");
        } else {
            await expect(page.locator("#message")).not.toContainText("Activity paging requires");
            await expect(remove).toBeEnabled();
            if (dismissal === "move focus") assert.equal(await nextFocus.evaluate(node => node === document.activeElement), true, "Completing the read must not steal newer focus.");
            else await expect(remove).toBeFocused();
        }
        assert.equal(app.writes.filter(write => write.route === "/api/artifact-deletion/confirm").length, 0);
    });
