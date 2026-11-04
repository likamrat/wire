import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { createNativeReportPublicationState } from "../web/native-report-publication-state.mjs";
import { navigateMain, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters, chooseTheme } from "./helpers.mjs";
import { openReportComparison } from "./report-journey-helpers.mjs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

const root = process.env.WIRE_NATIVE_SAVE_BACKEND_ROOT;
const backend = file => import(pathToFileURL(path.join(root, file)).href);
const allFormats = ["html", "pdf", "json", "markdown"];

async function setup(t, { segmented = false, mixed = false, dated = false, extraConversations = 0, shortPageSize = null,
    scheduled = false, enrolled = true, expiryClock = false, githubApproved = false, manualAcquisition = false, beforeAcquire,
    refreshProbe = false, backfillTracking = false } = {}) {
    const { privateFixture, fixture } = await backend("tests\\helpers.mjs");
    const { chatFixture, coworkFixture } = await backend("tests\\native-read-model-fixtures.mjs");
    const { createMicrosoftNativeReadTransport } = await backend("lib\\microsoft-native-transport.mjs");
    const { createMicrosoftSession } = await backend("lib\\microsoft-session.mjs");
    const { createNativePersistence } = await backend("lib\\native-persistence.mjs");
    const { createNativeRuntimeAccess } = await backend("lib\\runtime-access.mjs");
    const { createExportController } = await backend("lib\\export.mjs");
    const { startServer } = await backend("lib\\server.mjs");
    const { loadBoardState, replaceEvidence } = await backend("lib\\store.mjs");
    const cleanup = [], { root: fixtureRoot, context } = await privateFixture({ after: work => cleanup.push(work) }, []);
    if (githubApproved) {
        const { metadata174Schema } = await backend("tests\\copilot-metadata-fixture.mjs");
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
    runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
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
            window.refreshReviewProbe = () => ({ gesture: refreshGesture, nativeRead: state?.nativeRead, nativeRecovery: nativeCollectIntent });`);
    }
    if (expiryClock) {
        const factory = "createNativeReportPublicationState: " + createNativeReportPublicationState.toString();
        assert.ok(shell.includes(factory));
        shell = shell.replace(factory, `createNativeReportPublicationState: function () {
            const state = (${createNativeReportPublicationState.toString()})({ now: () => performance.now() + (window.reportExpiryOffset || 0) });
            return { ...state, preview(...args) { window.reportExpiryOffset = 0; return state.preview(...args); } };
        }`);
        await page.addInitScript(() => {
            const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window), deadlines = new Map();
            window.setTimeout = (callback, delay, ...args) => {
                const id = set(callback, delay, ...args);
                if (typeof callback === "function" && delay > 500000 && delay <= 600000) deadlines.set(id, () => callback(...args));
                return id;
            };
            window.clearTimeout = id => { deadlines.delete(id); clear(id); };
            window.expireReportForTest = () => {
                window.reportExpiryOffset = 600001;
                for (const fire of [...deadlines.values()]) fire();
            };
        });
    }
    await page.route(origin + "/", route => route.fulfill({ contentType: "text/html", body: shell }));
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

async function prepare(page, formats = ["html", "json"]) {
    await navigateMain(page, "reports");
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    await page.locator('[name=reportScope][value=current]').check();
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    await page.locator("#reportTitle").fill("Reviewed fixture report");
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator("#reportRecordedContext").check();
    for (const format of allFormats) await page.locator(`#formatOptions input[value=${format}]`).setChecked(formats.includes(format));
    await page.locator("#additionalMasking summary").click();
    await page.locator("#manualTerms").fill("invented");
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.getByRole("button", { name: "Save report", exact: true, includeHidden: true })).toBeDisabled();
}

async function captureReportSurface(page, name, { themes = ["light", "dark"] } = {}) {
    if (!process.env.WIRE_REPORT_PROOFS) return;
    await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
    for (const theme of themes) {
        await chooseTheme(page, theme);
        for (const [width, scale] of [[1440, 1], [768, 1], [390, 1], [390, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
            await page.evaluate(() => { scrollTo({ top: 0, behavior: "instant" }); return document.fonts.ready; });
            await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `${name}-${theme}-${width}-${scale}.png`), fullPage: true });
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "16px");
}

async function captureCombinedRefresh(page, name) {
    const output = process.env.WIRE_COMBINED_REFRESH_PROOFS;
    if (!output) return;
    await mkdir(output, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 1], [390, 2]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(async scale => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            scrollTo(0, 0); await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, scale);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (await page.locator("#analyzeRefresh").isVisible()) {
            const action = await page.locator("#analyzeRefresh").boundingBox(), filters = await page.locator("#openAnalyzeFilters").boundingBox();
            assert.ok(action.width >= 44 && action.height >= 44 && action.x + action.width <= filters.x);
        }
        await page.screenshot({ path: path.join(output, `${name}-${theme}-${width}-${scale}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
}

test("combined Refresh checks both admitted sources once and applies one stable view", { skip: !root, timeout: 45000 }, async t => {
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
    await captureCombinedRefresh(page, "pending");
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
    await captureCombinedRefresh(page, "settings-completed");
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
    { skip: !root, timeout: 30000 }, async t => {
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
    { skip: !root, timeout: 30000 }, async t => {
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
        if (mode === "global-pause") {
            await navigateMain(page, "settings");
            await captureCombinedRefresh(page, "global-pause-result");
        }
        assert.deepEqual(writes, ["/api/collection/now"]);
        assert.equal(app.acquisitions, 0);
        assert.deepEqual((await app.board()).nativeRetention, before.nativeRetention);
        const status = await app.post("/api/collection/sources/status", {});
        if (mode === "global-pause") assert.equal(status.global.paused, true);
        if (mode === "paused") assert.equal(status.microsoft.status.configuration.settings.paused, true);
    });

for (const lost of ["github", "microsoft", "both"]) test(`combined Refresh recovers unknown ${lost} without repeating either source`,
    { skip: !root, timeout: 30000 }, async t => {
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
        if (lost === "microsoft") await captureCombinedRefresh(page, "microsoft-unconfirmed");
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

test("review correction: a report opened during recovery keeps its bytes root and ordinals", { skip: !root, timeout: 45000 }, async t => {
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
    { skip: !root, timeout: 30000 }, async t => {
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

test("review correction: completed GitHub feedback retires while Microsoft recovery remains original", { skip: !root, timeout: 30000 }, async t => {
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

test("review correction: Retry retires completed feedback against its newer view while Microsoft stays unknown", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh preserves Microsoft success when the GitHub check fails", { skip: !root, timeout: 30000 }, async t => {
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
test(`combined Refresh keeps a failed Microsoft acquisition unconfirmed and recovers only its original result${withAdmission ? " with screened admission" : ""}`, { skip: !root, timeout: 30000 }, async t => {
    const rejectAdmission = withAdmission ? (await backend("lib\\microsoft-native-host.mjs")).assertNativeRequestAdmission : null;
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

test("combined Refresh retries a lost final view without repeating either committed source", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh rejects a native scope change at registration without losing the GitHub result", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh cannot dispatch its second source after withdrawal", { skip: !root, timeout: 30000 }, async t => {
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
    { skip: !root, timeout: 30000 }, async t => {
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

test("review correction: Settings names Microsoft-only acquisition as Refresh", { skip: !root, timeout: 30000 }, async t => {
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

test("review correction: a stored-read-labelled Settings gesture cannot acquire", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh can check Microsoft without GitHub approval and never creates source permission", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh never adds a source that becomes available after the gesture", { skip: !root, timeout: 30000 }, async t => {
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

test("combined Refresh retires completed results when later stored activity arrives", { skip: !root, timeout: 30000 }, async t => {
    const app = await setup(t, { segmented: true, mixed: true, githubApproved: true, manualAcquisition: true }), { page } = app;
    await navigateMain(page, "analyze");
    await page.locator("#analyzeRefresh").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "complete");
    await app.advance();
    await expect(page.locator("#analyzeRefreshStatus")).toHaveText("", { timeout: 10000 });
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "idle");
    assert.equal(app.acquisitions, 1, "A later retained update cannot trigger another acquisition");
});

test("combined Refresh keeps an open native reader frozen while both sources finish", { skip: !root, timeout: 30000 }, async t => {
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
    { skip: !root, timeout: 30000 }, async t => {
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

test("joined Analyze Refresh cannot bypass a prepared native report or collect Microsoft",
    { skip: !root, timeout: 30000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, githubApproved: true }), { page } = app;
        const sourceWrites = [];
        page.on("request", request => {
            if (/\/api\/(?:access\/command|collection\/.*(?:now|configure|enabled))$/.test(new URL(request.url()).pathname)) {
                sourceWrites.push(new URL(request.url()).pathname);
            }
        });
        await navigateMain(page, "analyze");
        const before = await app.board();
        await expect(page.locator("#analyzeRefresh")).toBeEnabled();
        const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"), { timeout: 5000 });
        await page.locator("#analyzeRefresh").click();
        assert.equal((await read).status(), 200);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        assert.deepEqual((await app.board()).nativeRetention, before.nativeRetention);
        assert.deepEqual(sourceWrites, ["/api/collection/now"]);
        await prepare(page);
        const frame = page.locator("#reportReviewBody iframe"), bytes = await frame.getAttribute("srcdoc");
        const originalFrame = await frame.elementHandle();
        await navigateMain(page, "analyze");
        await expect(page.locator("#analyzeRefresh")).toBeDisabled();
        await page.locator("#analyzeRefresh").evaluate(node => node.click());
        assert.deepEqual(sourceWrites, ["/api/collection/now"]);
        await navigateMain(page, "reports");
        assert.equal(await frame.getAttribute("srcdoc"), bytes);
        assert.equal(await frame.evaluate((node, original) => node === original, originalFrame), true);
        assert.equal(app.writes.length, 0);
    });

for (const theme of ["light", "dark"]) test(`screen notices keep report journeys proportionate in ${theme} without changing saved files`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await chooseTheme(page, theme);
        const measurements = [];
        const output = process.env.WIRE_NOTICE_PROOFS;
        if (output) await mkdir(output, { recursive: true });
        async function capture(name) {
            for (const [width, scale] of [[1440, 1], [768, 1], [390, 1], [390, 2]]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; scrollTo(0, 0); }, scale);
                await page.evaluate(() => document.fonts.ready);
                await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
                if (name === "contents-error") await page.locator("#formatError").scrollIntoViewIfNeeded();
                const value = await page.evaluate(() => ({
                    overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    brokenActionWords: [...document.querySelectorAll("#reportContentsActions button")].filter(node => node.checkVisibility()).flatMap(node => {
                        const result = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                        while (walker.nextNode()) for (const word of walker.currentNode.textContent.matchAll(/\S+/g)) {
                            const range = document.createRange();
                            range.setStart(walker.currentNode, word.index); range.setEnd(walker.currentNode, word.index + word[0].length);
                            if (range.getClientRects().length > 1) result.push(word[0]);
                        }
                        return result;
                    }),
                    notices: [...document.querySelectorAll(".notice,.comparison-notice")].filter(node =>
                        node.checkVisibility({ visibilityProperty: true })).map(node => {
                        const css = getComputedStyle(node), box = node.getBoundingClientRect();
                        const following = node.nextElementSibling;
                        const heading = following?.matches("h2,h3") ? following : following?.querySelector("h2,h3");
                        return { text: node.textContent, target: node.id || node.className, width: box.width, height: box.height,
                            radius: parseFloat(css.borderTopLeftRadius), topPadding: parseFloat(css.paddingTop),
                            lineHeight: parseFloat(css.lineHeight), font: css.fontFamily, fontSize: parseFloat(css.fontSize),
                            headingGap: heading ? heading.getBoundingClientRect().top - box.bottom : null };
                    }),
                }));
                measurements.push({ name, theme, width, scale, ...value });
                if (output) {
                    await page.screenshot({ path: path.join(output, `${name}-${theme}-${width}-${scale}.png`), fullPage: true });
                    await page.screenshot({ path: path.join(output, `${name}-${theme}-${width}-${scale}-viewport.png`) });
                }
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        }
        await navigateMain(page, "reports");
        await capture("empty-library");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await capture("picker");
        await page.locator('[name=reportScope][value=all]').check();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.locator("#reportTitle").fill("Reviewed notice fixture");
        for (const format of ["html", "pdf", "json", "markdown"]) await page.locator(`#formatOptions input[value=${format}]`).uncheck();
        await expect(page.locator("#formatError")).toBeVisible();
        await capture("contents-error");
        await page.locator("#formatOptions input[value=html]").check();
        await page.locator("#formatOptions input[value=json]").check();
        await capture("contents");
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await capture("review");
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.route("**/api/export", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort("failed");
        }, { times: 1 });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
        await capture("save-unknown");
        await page.getByRole("button", { name: "Check save status", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const first = (await app.board()).exports[0];
        const files = await Promise.all(Object.values(first.files).map(file => readFile(file)));
        await page.goto(app.url + "#reports");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${first.bundleId}"]`)).toBeVisible();
        await capture("library");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${first.bundleId}"]`).click();
        await capture("details");
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toHaveText("Reviewed notice fixture");
        await capture("saved-reader");
        await page.goto(app.url + "#reports");
        await app.advance();
        const current = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
        const preview = await app.post("/api/preview", { nativeViewId: current.nativeRead.allViewId,
            selection: { kind: "all", revision: current.revision },
            options: { title: "Later notice fixture", promptMode: "none", formats: ["html", "json"] } });
        await app.post("/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true });
        const second = (await app.post("/api/export", { previewId: preview.previewId, confirmed: true })).bundle;
        await page.goto(app.url + "#reports");
        await openReportComparison(page);
        const workspace = page.locator("#comparisonWorkspace");
        for (const [label, bundle] of [["Earlier report", first], ["Later report", second]]) {
            await workspace.getByRole("combobox", { name: label, exact: true }).click();
            await page.locator(`.select-popup .select-option[data-value="${bundle.bundleId}"]`).click();
        }
        await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
        await expect(workspace.locator(".comparison-notice").first()).toContainText("Overlap is unverified");
        await capture("compare-overlap");
        await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
        await workspace.getByRole("checkbox", { name: /reviewed this frozen comparison/ }).check();
        await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
        await expect(workspace.getByRole("button", { name: "Open saved comparison", exact: true })).toBeVisible();
        assert.deepEqual(await Promise.all(Object.values(first.files).map(file => readFile(file))), files);
        if (output) await writeFile(path.join(output, `${theme}-measurements.json`), JSON.stringify(measurements, null, 2));
        for (const view of measurements) {
            assert.equal(view.overflow, false, `${view.name}/${view.width}/${view.scale} overflow`);
            assert.deepEqual(view.brokenActionWords, [], `${view.name}/${view.width}/${view.scale} action words must not split`);
            for (const notice of view.notices) {
                assert.ok(notice.radius <= 4, `${view.name}: passive notice cannot inherit a panel/pill radius`);
                assert.ok(notice.topPadding <= 8 * view.scale, `${view.name}: compact notice inset`);
                assert.ok(notice.font.includes("Asta Sans"));
                if (notice.headingGap !== null) assert.ok(notice.headingGap >= 16, `${view.name}: notice must not touch its following heading`);
            }
        }
    });

test("saved report Delete reads current authority internally after collection; cancel never dispatches deletion",
    { skip: !root, timeout: 45000 }, async t => {
        const app = await setup(t, { segmented: true }), { page } = app;
        await prepare(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports[0];
        await page.goto(app.url + "#reports");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        const sidebar = page.locator("#contextSidebar"), remove = sidebar.getByRole("button", { name: "Delete report", exact: true });
        await expect(remove).toBeEnabled();
        const original = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "json" });
        const { after } = await app.advance();
        await page.waitForResponse(async response => response.url().endsWith("/api/collection/status")
            && response.ok() && (await response.json()).revision === after.revision);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(remove).toBeEnabled();
        await expect(sidebar.getByRole("button", { name: "Check Delete availability", exact: true })).toHaveCount(0);
        assert.doesNotMatch(await sidebar.innerText(), /Read current deletion availability/);
        await remove.click();
        const dialog = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
        await expect(dialog).toHaveAttribute("data-decision-phase", "confirm");
        assert.equal(app.reads.filter(route => route === "/api/artifact-deletion/preview").length, 1);
        assert.equal(app.reads.filter(route => route === "/api/artifact-deletion/eligibility").length, 0);
        assert.equal(app.writes.filter(write => write.route === "/api/artifact-deletion/confirm").length, 0);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect(remove).toBeFocused();
        assert.ok((await app.board()).exports.some(item => item.bundleId === saved.bundleId));
        assert.deepEqual(await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "json" }), original);
        if (process.env.WIRE_REPORT_PROOFS) for (const theme of ["light", "dark"]) {
            await sidebar.getByRole("button", { name: "Close saved report details", exact: true }).click();
            await chooseTheme(page, theme);
            await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
            await captureReportSurface(page, "saved-details", { themes: [theme] });
        }
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        assert.equal(app.writes.filter(write => write.route === "/api/artifact-deletion/confirm").length, 0);
    });

for (const dismissal of ["Cancel", "Escape", "move focus", "open during read", "failed read", "all sources"]) test(`Delete ${dismissal} preserves inspector focus through a concurrent stored read`,
    { skip: !root, timeout: 45000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        const state = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
        const preview = await app.post("/api/preview", {
            nativeViewId: state.nativeRead.allViewId, selection: { kind: "all", revision: state.revision },
            options: { title: "Focus continuity fixture", promptMode: "none", formats: ["json"] },
        });
        await app.post("/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true });
        const saved = (await app.post("/api/export", { previewId: preview.previewId, confirmed: true })).bundle;
        await page.goto(app.url + (dismissal === "all sources" ? "#reports" : "#reports?source=github-copilot"));
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
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
        if (dismissal === "Escape") await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
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

test("Current report with no matching Microsoft conversations reviews saves and reopens its protected empty scope",
    { skip: !root, timeout: 60000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await navigateMain(page, "analyze");
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await closeAnalyzeFilters(page);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await prepare(page, allFormats);
        const preview = app.prepared.at(-1), note = "No Microsoft conversations matched the selected report scope.";
        assert.ok(app.previews.at(-1).nativeViewId);
        assert.equal(preview.snapshot.nativeEvidence.schemaVersion, 2);
        assert.deepEqual(preview.snapshot.nativeEvidence.conversations, []);
        await expect(page.frameLocator("#reportReviewBody iframe").getByText(note, { exact: false })).toBeVisible();
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        assert.equal(app.writes.length, 0, "Disclosure approval is not Save.");
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports.find(entry => entry.bundleId === preview.bundleId);
        assert.ok(saved.nativeSourceBinding);
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        for (const format of ["html", "pdf", "json", "markdown"]) {
            const result = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format });
            const name = `product-report.${format === "markdown" ? "md" : format}`, expected = app.reviews.at(-1).files[name];
            assert.deepEqual(Buffer.from(result.data, "base64"),
                typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected.data, "base64"));
        }
        await page.goto(app.url + "#reports");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        await expect(page.frameLocator("#savedReportReader iframe").getByText(note, { exact: false })).toBeVisible();
        const original = await page.locator("#savedReportReader iframe").getAttribute("srcdoc");
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            for (const theme of ["light", "dark"]) {
                await chooseTheme(page, theme);
                await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
                await expect(page.getByRole("switch", { name: "Dark theme", exact: true })).toHaveAttribute("aria-checked", String(theme === "dark"));
                await expect(page.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
                await page.evaluate(() => document.fonts.ready);
                await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
                assert.equal(await page.locator("#savedReportReader iframe").getAttribute("srcdoc"), original);
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `empty-scope-saved-${theme}.png`), fullPage: true });
            }
        }
        assert.equal(app.acquisitions, 0);
    });

for (const segmented of [false, true]) test(`qualified ordinary ${segmented ? "v2 native" : "v1 mixed"} UI reviews and saves exact frozen files, then deletes only the qualified fixture target`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented, mixed: !segmented }), { page } = app;
        await prepare(page, allFormats);
        const original = app.previews[0].nativeViewId;
        assert.ok(original);
        await page.getByRole("tab", { name: /^Text \(/ }).click();
        await page.getByText("Edit or omit this report copy", { exact: true }).click();
        await page.locator(".report-copy-controls textarea").fill("Reviewed fixture wording.");
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await page.getByRole("tab", { name: /^Text \(/ }).click();
        const rebuilt = app.prepared.at(-1);
        const omittedIndex = [...rebuilt.promptReview, ...(rebuilt.contextReview ?? []), ...rebuilt.nativeReview]
            .findIndex((copy, index) => index > 0 && copy.original !== null);
        assert.ok(omittedIndex > 0);
        for (let index = 0; index < omittedIndex; index++) await page.getByRole("button", { name: "Next report copies", exact: true }).click();
        await page.getByText("Edit or omit this report copy", { exact: true }).click();
        await page.locator(".report-copy-controls input[type=checkbox]").check();
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.ok(app.previews.every(value => value.nativeViewId === original));
        assert.ok(app.previews.at(-1).options.overrides.some(copy => copy.omit));
        assert.ok(app.previews.at(-1).options.overrides.some(copy => copy.text === "Reviewed fixture wording."));
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        await expect.poll(() => app.reviews.length).toBeGreaterThan(0);
        const reviewed = app.reviews.at(-1);
        assert.deepEqual(reviewed.nativeReportPublication, { schemaVersion: 1, available: true, reason: null });
        const copies = [...reviewed.promptReview, ...(reviewed.contextReview ?? []), ...reviewed.nativeReview];
        assert.ok(copies.some(copy => copy.edited && copy.text === "Reviewed fixture wording."));
        assert.ok(copies.some(copy => copy.omitted && copy.text === null));
        assert.ok(reviewed.nativeReview.some(copy => copy.changes.some(change => change.category === "manual")));
        assert.ok(reviewed.nativeReview.every(copy => !/invented/i.test(copy.text ?? "")));
        if (segmented) await page.route("**/api/export", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort("failed");
        }, { times: 1 });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        if (segmented) {
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
            const readsBefore = app.reads.length;
            await page.getByRole("button", { name: "Check save status", exact: true }).click();
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
            assert.ok(app.reads.slice(readsBefore).includes("/api/snapshot"));
        }
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        const saved = (await app.board()).exports.find(item => item.bundleId === reviewed.bundleId);
        assert.ok(saved?.nativeEvidenceHash);
        for (const format of ["html", "pdf", "json", "markdown"]) {
            const result = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format });
            const extension = format === "markdown" ? "md" : format;
            const expected = reviewed.files[`product-report.${extension}`];
            assert.ok(expected !== undefined);
            assert.equal(result.encoding, "base64");
            const bytes = Buffer.from(result.data, "base64");
            const wanted = typeof expected === "string" ? Buffer.from(expected, "utf8") : Buffer.from(expected.data, "base64");
            assert.deepEqual(bytes, wanted);
        }
        await page.goto(app.url + "#reports");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await expect(page.getByRole("button", { name: "Delete report", exact: true })).toBeEnabled();
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        await page.goto(app.url + "#reports");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await expect(page.getByRole("button", { name: "Delete report", exact: true })).toBeEnabled();
        const before = await app.board();
        if (segmented) await page.route("**/api/artifact-deletion/confirm", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort("failed");
        }, { times: 1 });
        await page.getByRole("button", { name: "Delete report", exact: true }).click();
        const deletion = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
        await expect(deletion).toHaveAttribute("data-decision-phase", "confirm");
        await deletion.getByRole("button", { name: "Delete report", exact: true }).click();
        if (segmented) {
            await expect(deletion).toHaveAttribute("data-decision-phase", "unknown");
            const readsBefore = app.reads.length;
            await deletion.getByRole("button", { name: "Check deletion result", exact: true }).click();
            await expect(deletion).toHaveAttribute("data-decision-phase", "complete");
            assert.ok(app.reads.slice(readsBefore).includes("/api/artifact-deletion/status"));
        }
        await expect(deletion).toHaveAttribute("data-decision-phase", "complete");
        assert.equal(app.writes.filter(write => write.route === "/api/artifact-deletion/confirm").length, 1);
        const after = await app.board();
        assert.equal(after.exports.some(item => item.bundleId === saved.bundleId), false);
        assert.deepEqual(after.nativeRetention, before.nativeRetention);
        assert.deepEqual(after.evidence, before.evidence);
    });

for (const [stage, failure] of [["snapshot", "missing"], ["preview", "malformed"], ["review", "unqualified"]]) test(`native Save stays closed when ${stage} readiness is ${failure}`,
    { skip: !root, timeout: 45000 }, async t => {
        const app = await setup(t), { page } = app;
        const endpoint = { snapshot: "/api/snapshot", preview: "/api/preview", review: "/api/privacy-review" }[stage];
        await page.route("**" + endpoint, async route => {
            const response = await route.fetch(), value = await response.json();
            if (stage === "snapshot") delete value.nativeReportPublication;
            else value.nativeReportPublication = stage === "preview" ? { schemaVersion: 1, available: true, reason: null, extra: true }
                : { schemaVersion: 1, available: false, reason: "runtime-unqualified" };
            await route.fulfill({ response, json: value });
        });
        if (stage === "snapshot") {
            await page.reload();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        }
        await prepare(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeDisabled();
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 0);
        assert.equal((await app.board()).exports.length, 0);
    });

test("existing Compare screen prepares, reviews and saves Microsoft snapshots without source acquisition",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app, saved = [];
        for (const kind of ["all", "current"]) {
            const state = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
            const preview = await app.post("/api/preview", {
                nativeViewId: kind === "all" ? state.nativeRead.allViewId : state.nativeRead.viewId,
                selection: { kind, revision: state.revision, ...(kind === "all" ? {} : { scenarioIds: state.exportCatalog.requests.map(row => row.scenarioId) }) },
                options: { title: `${kind} Microsoft fixture`, promptMode: "none", formats: ["html"] },
            });
            await app.post("/api/privacy-review", { previewId: preview.previewId, disclosureReviewed: true });
            saved.push((await app.post("/api/export", { previewId: preview.previewId, confirmed: true })).bundle);
        }
        await page.goto(app.url + "#reports");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await openReportComparison(page);
        const workspace = page.locator("#comparisonWorkspace");
        for (const [index, label] of ["Earlier report", "Later report"].entries()) {
            await workspace.getByRole("combobox", { name: label, exact: true }).click();
            await page.locator(`.select-popup .select-option[data-value="${saved[index].bundleId}"]`).click();
        }
        await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
        await expect(workspace.locator(".comparison-native-results")).toContainText("Microsoft 365 Cowork");
        assert.doesNotMatch(await workspace.locator(".comparison-native-results").innerText(),
            /Counts describe retained evidence|GitHub population only|Tool execution is separate from answer accuracy/);
        await expect(workspace.locator(".comparison-tool-results > p.comparison-meta")).toHaveText("GitHub population only.");
        const choices = await workspace.locator(".comparison-selectors select").evaluateAll(nodes =>
            nodes.flatMap(node => [...node.options].filter(option => option.value).map(option =>
                ({ label: option.textContent, detail: option.dataset.detail }))));
        for (const choice of choices) {
            assert.doesNotMatch(choice.label + choice.detail, /Files:|Report ID:|prompt mode|export-[a-f0-9-]{36}/i);
            assert.match(choice.detail, /Prepared .+Microsoft conversations?/);
        }
        await captureReportSurface(page, "native-compare");
        for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            if (process.env.WIRE_REPORT_PROOFS) {
                await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `native-compare-${width}.png`), fullPage: true });
            }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await workspace.getByLabel("Report title", { exact: true }).fill("Microsoft snapshot comparison");
        await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
        await workspace.getByRole("checkbox", { name: /reviewed this frozen comparison/ }).check();
        await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
        await expect(workspace.getByRole("button", { name: "Open saved comparison", exact: true })).toBeVisible();
        const comparison = (await app.board()).exports.find(entry => entry.kind === "comparison");
        assert.ok(comparison.nativeComparisonHash);
        await workspace.getByRole("button", { name: "Open saved comparison", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
    });

for (const dated of [false, true]) test(`existing period Compare keeps ${dated ? "dated and undated" : "undated"} Microsoft evidence visible and creates a reviewed period report`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, dated }), { page } = app;
        await page.goto(app.url + "#analyze?compare=periods&aFrom=2026-10-01&aTo=2026-10-07&bFrom=2026-10-08&bTo=2026-10-14");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodComparisonResults")).toContainText("Microsoft activity");
        await expect(page.locator("#periodComparisonResults")).toContainText("Undated");
        const populations = page.locator('#periodComparisonResults [aria-label="Microsoft period populations"] tbody tr').filter({ hasText: "Cowork" }).first();
        await expect(populations.locator("td")).toHaveText(dated ? ["1", "1", "0", "1"] : ["0", "0", "0", "3"]);
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            for (const width of [1440, 768, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `native-period-${dated ? "dated" : "undated"}-${width}.png`), fullPage: true });
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
        }
        await expect(page.locator("#createPeriodReport")).toBeEnabled();
        await page.locator("#createPeriodReport").click();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.locator("#reportTitle").fill("Microsoft period coverage");
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        assert.ok((await app.board()).exports.some(entry => entry.nativeEvidenceHash && entry.reportType === "period-comparison"));
    });

for (const grouped of [false, true]) test(`native ${grouped ? "Search and group" : "Search"} periods preserve exact row membership through report saving`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, dated: true }), { page } = app;
        await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork"); await closeAnalyzeFilters(page);
        if (grouped) {
            await expect(page.locator("#periodResult")).toContainText("3 native tool calls");
            await openAnalyzeFilters(page);
            await page.locator('[data-chart="workload"]').click();
            await closeAnalyzeFilters(page);
            await page.locator('#chart a[href*="nativeGroup="]').first().click();
            await openAnalyzeFilters(page);
            await expect(page.getByRole("button", { name: "Remove Microsoft group restriction", exact: true })).toBeVisible();
            await closeAnalyzeFilters(page);
        }
        await page.locator("#wireSearch").fill("CallGraph");
        await page.locator("#wireSearchScope-control").click();
        await page.locator('.select-popup [data-value="analysis"]').click();
        await expect(page.locator("#wireNativeSearch")).toContainText("1 matching native tool calls");
        await page.locator("#wireSearch").press("Escape");
        await page.locator("#comparePeriods").click();
        await expect(page.locator("#comparisonDateHint")).toContainText("replace the original Dates filter");
        for (const [label, date] of [["Period A from", "2026-10-01"], ["Period A to", "2026-10-07"],
            ["Period B from", "2026-10-08"], ["Period B to", "2026-10-14"]]) await page.getByLabel(label, { exact: true }).fill(date);
        await page.locator("#applyPeriodComparison").click();
        await expect(page.locator("#periodComparisonResults")).toContainText("Search, group and other source filters are preserved");
        const population = page.locator('#periodComparisonResults [aria-label="Microsoft period populations"] tbody tr').first();
        await expect(population.locator("td")).toHaveText(["1", "0", "-1", "0"]);
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            for (const width of [1440, 768, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `native-refined-${grouped ? "group" : "search"}-${width}.png`), fullPage: true });
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
        }
        await expect(page.locator("#createPeriodReport")).toBeEnabled();
        await page.locator("#createPeriodReport").click();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBeGreaterThan(0);
        assert.equal(app.prepared.at(-1).snapshot.periodComparison.nativePeriods.rows.length, 1);
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations[0].calls.length, 3);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    });

for (const kind of ["current", "all"]) test(`unenrolled source-aware ${kind} reports retain the ordinary GitHub create and save journey`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { mixed: true, enrolled: false }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await page.locator(`[name=reportScope][value=${kind}]`).check();
        await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBe(1);
        assert.equal(app.previews[0].nativeViewId, undefined);
        assert.equal(app.prepared[0].snapshot.nativeEvidence, undefined);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports[0];
        assert.equal(saved.selectionScope.requestGroups, 1);
        assert.equal(saved.nativeEvidenceHash, undefined);
        assert.equal(saved.nativeSourceBinding, undefined);
        assert.equal((await app.board()).nativeRetention, undefined);
    });

test("native preview expiry retires approval and allows deliberate fresh preparation with draft edits intact",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, expiryClock: true }), { page } = app;
        await prepare(page);
        await page.getByRole("tab", { name: /^Text \(/ }).click();
        await page.getByText("Edit or omit this report copy", { exact: true }).click();
        await page.locator(".report-copy-controls textarea").fill("Keep this report-only edit after expiry.");
        await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBe(2);
        const original = app.prepared.at(-1), options = structuredClone(app.previews.at(-1).options);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        await page.evaluate(() => window.expireReportForTest());
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "draft");
        await expect(page.locator("#reportsView").getByRole("alert")).toContainText("expired");
        await expect(page.getByRole("button", { name: "Save report", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
        await expect.poll(() => app.cancellations.filter(item => item.previewId === original.previewId).length).toBe(1);
        await page.getByRole("button", { name: "Read current activity", exact: true }).click();
        await page.getByRole("button", { name: "1. Activity", exact: true }).click();
        await page.getByRole("button", { name: "Use current activity for this report scope", exact: true }).click();
        await page.getByRole("button", { name: "2. Contents", exact: true }).click();
        await expect(page.getByRole("button", { name: "Prepare report", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Return to review", exact: true })).toHaveCount(0);
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBe(3);
        assert.notEqual(app.prepared.at(-1).previewId, original.previewId);
        assert.notEqual(app.previews.at(-1).nativeViewId, app.previews[1].nativeViewId);
        assert.deepEqual(app.previews.at(-1).options, options);
        await expect(page.locator(".attestation input[data-review-control]")).not.toBeChecked();
        assert.equal(app.reviews.length, 1, "Fresh preparation must not carry forward the expired disclosure approval.");
        assert.deepEqual(app.writes, []);
    });

test("report picker replacements retire private native cards and their caller-owned selection listeners",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        const list = page.locator("#reportList"), first = list.locator("[data-native-report-request]").first();
        const id = await first.getAttribute("data-native-report-request");
        await first.check();
        for (let index = 0; index < 6; index++) {
            const card = await list.locator("#report-native-select-" + id).locator("..").locator("..").elementHandle();
            const checkbox = await card.$("input"), open = await card.$(".request-card-open");
            const summary = await page.locator("#scopeSummary").textContent(), location = page.url();
            await page.locator("#reportRequestSearch").fill("no matching report card");
            await expect(list.locator(".activity-card")).toHaveCount(0);
            assert.equal(await card.textContent(), "");
            assert.equal(await card.getAttribute("data-view-key"), null);
            await card.evaluate(node => document.getElementById("reportList").append(node));
            await open.dispatchEvent("click");
            await checkbox.evaluate((node, id) => {
                node.dataset.nativeReportRequest = id;
                node.checked = false;
                node.dispatchEvent(new Event("change", { bubbles: true }));
            }, id);
            assert.equal(page.url(), location);
            assert.equal(await page.locator("#scopeSummary").textContent(), summary);
            await card.evaluate(node => node.remove());
            await page.locator("#reportRequestSearch").fill("");
            await expect(list.locator("#report-native-select-" + id)).toBeChecked();
            await checkbox.dispose(); await open.dispose(); await card.dispose();
        }
        assert.deepEqual(app.writes, []);
        assert.equal(app.previews.length, 0);
    });

test("a GitHub-only Analyze filter does not invent an unavailable Microsoft report page",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await selectActivityOption(page, "sourceFilter", "github-copilot");
        await closeAnalyzeFilters(page);
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        const list = page.locator("#reportList");
        await expect(list.locator(".activity-card")).toHaveCount(1);
        await expect(list.locator("[data-page-position]")).toHaveText("1-1 of 1 available cards");
        await expect(list).not.toContainText("Microsoft page unavailable");
        await page.locator('[name=reportScope][value=all]').check();
        await expect(page.getByRole("button", { name: "Continue to contents", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBe(1);
        assert.equal(app.prepared[0].snapshot.selectionScope.nativeConversations, 2, "All keeps its original complete membership, not this page's source filter.");
        assert.equal(app.prepared[0].snapshot.selectionScope.requestGroups, 1);
    });

test("one report picker uses the common cards, reader and selection flow for GitHub and Microsoft",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await expect(page.locator("#nativeReportPicker")).toHaveCount(0);
        await expect(page.locator("#reportsView")).not.toContainText("Microsoft reports require a current preview");
        await expect(page.locator("#reportsView")).not.toContainText("Microsoft picks keep their original view");
        const list = page.locator("#reportList");
        await expect(list.locator(".report-request-page")).toHaveCount(1);
        await expect(list.locator(".activity-card")).toHaveCount(3);
        await expect(list.locator(".request-card-open")).toHaveCount(3);
        for (const scope of ["current", "all"]) {
            await page.locator(`[name=reportScope][value=${scope}]`).check();
            await expect(list.locator(".activity-card")).toHaveCount(3);
            await expect(list.locator("input[type=checkbox]")).toHaveCount(0);
            await expect(list).not.toContainText("only independently selected GitHub");
        }
        await page.locator('[name=reportScope][value=selected]').check();
        await page.locator("#reportRequestSearch").fill("no fixture match");
        await expect(list.locator(".activity-card")).toHaveCount(0);
        await page.locator("#reportRequestSearch").fill("");
        const native = list.locator(".activity-card").filter({ has: page.locator("[data-native-report-request]") }).first();
        const pickedId = await native.locator("[data-native-report-request]").getAttribute("data-native-report-request");
        const title = await native.locator(".request-card-prompt").textContent();
        await page.locator("#reportRequestSearch").fill(title.slice(0, 20));
        await expect(list.locator("#report-native-select-" + pickedId)).toBeVisible();
        await list.locator("#report-native-select-" + pickedId).check();
        await page.locator("#reportRequestSearch").fill("");
        await list.locator('[data-report-request="github-save-kept"]').check();
        await list.locator("#report-native-select-" + pickedId).locator("..").locator("..").locator(".request-card-open").click();
        await expect(page.locator("#contextSidebarFooter #requestReportToggle")).toHaveText("Remove from report");
        await page.locator("#contextSidebarFooter #requestReportToggle").click();
        await page.locator("#contextSidebarFooter #requestReportToggle").click();
        await page.locator("#contextSidebarFooter #requestReportContinue").click();
        await expect(list.locator("#report-native-select-" + pickedId)).toBeChecked();
        await expect(list.locator('[data-report-request="github-save-kept"]')).toBeChecked();
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            for (const theme of ["light", "dark"]) {
                await chooseTheme(page, theme);
                for (const [width, scale] of [[1440, 1], [768, 1], [390, 1], [390, 2]]) {
                    await page.setViewportSize({ width, height: 1000 });
                    await page.evaluate(scale => document.documentElement.style.fontSize = `${16 * scale}px`, scale);
                    await page.evaluate(() => { scrollTo({ top: 0, behavior: "instant" }); return document.fonts.ready; });
                    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
                    await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `unified-report-picker-${theme}-${width}-${scale}.png`), fullPage: true });
                    const open = list.locator("#report-native-select-" + pickedId).locator("..").locator("..").locator(".request-card-open");
                    await open.focus(); await page.keyboard.press("Enter");
                    await expect(page.locator("#contextSidebarFooter #requestReportToggle")).toHaveText("Remove from report");
                    await expect(page.locator("#requestContent")).toHaveAttribute("aria-busy", "false");
                    await expect(page.locator("#contextSidebarFooter").getByRole("button", { name: "Back to activity", exact: true })).toHaveCount(1);
                    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
                    await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `unified-report-reader-${theme}-${width}-${scale}.png`) });
                    await page.locator("#contextSidebarFooter #requestReportContinue").focus();
                    await page.keyboard.press("Enter");
                    await expect(list.locator("#report-native-select-" + pickedId)).toBeChecked();
                    await expect(open).toBeFocused();
                }
            }
            await page.setViewportSize({ width: 1440, height: 1000 });
            await page.evaluate(() => document.documentElement.style.fontSize = "16px");
        }
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.locator("#reportTitle").fill("Shared report journey");
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBeGreaterThan(0);
        assert.deepEqual(app.previews.at(-1).selection.scenarioIds, ["github-save-kept", pickedId]);
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 1);
        assert.equal(app.prepared.at(-1).snapshot.records.filter(record => record.recordKind !== "native-conversation").length, 1);
        await captureReportSurface(page, "unified-report-review");
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports.at(-1);
        await page.goto(app.url + "#reports");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await expect(page.locator("#contextSidebarBody")).toContainText("GitHub interactions");
        await expect(page.locator("#contextSidebarBody")).toContainText("Microsoft conversations");
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        await expect(page.locator("#savedReportReader .document-file-footer")).toHaveCount(0);
        await captureReportSurface(page, "unified-saved-report");
    });

test("pending and failed report pages withhold old cards and retry from a current source snapshot",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, extraConversations: 11 }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
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

test("one report pager advances authorized source pages without replacing selected membership",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, extraConversations: 11 }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        const list = page.locator("#reportList"), first = list.locator("[data-native-report-request]").first();
        await expect(list.locator('[aria-label="Report activity pages"]')).toHaveCount(1);
        const firstId = await first.getAttribute("data-native-report-request");
        await first.check();
        await list.locator('[data-report-request="github-save-kept"]').check();
        await list.getByRole("button", { name: "Next report requests", exact: true }).click();
        await expect(list.locator("#report-native-select-" + firstId)).toHaveCount(0);
        const second = list.locator("[data-native-report-request]").first();
        await expect(second).toBeVisible();
        const secondId = await second.getAttribute("data-native-report-request");
        assert.notEqual(secondId, firstId);
        await second.check();
        await expect(page.locator("#scopeSummary")).toContainText("2 retained Microsoft conversations selected");
        await list.getByRole("button", { name: "Previous report requests", exact: true }).click();
        await expect(list.locator("#report-native-select-" + firstId)).toBeChecked();
        await expect(list.locator('[data-report-request="github-save-kept"]')).toBeChecked();
        await expect(page.locator("#reportPageSelectionSummary")).toContainText("1 included outside this page.");
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect.poll(() => app.prepared.length).toBeGreaterThan(0);
        assert.deepEqual(new Set(app.previews.at(-1).selection.scenarioIds), new Set(["github-save-kept", firstId, secondId]));
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 2);
        assert.equal((await app.board()).exports.length, 0);
    });

test("report ranges follow byte-short source pages through the final cursor and back",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, extraConversations: 5, shortPageSize: 2 }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
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
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.deepEqual(new Set(app.previews.at(-1).selection.scenarioIds), new Set([firstId, lastId]));
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 2);
    });

for (const stage of ["draft", "preview", "review"]) test(`a committed collection advance during report ${stage} cannot silently replace reviewed membership`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        await page.locator('[name=reportScope][value=current]').check();
        await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        await page.locator("#reportTitle").fill("Original collection scope");
        await page.locator("#formatOptions input[value=json]").check();
        if (stage !== "draft") {
            await page.getByRole("button", { name: "Prepare report", exact: true }).click();
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
            if (stage === "review") {
                await page.locator(".attestation input[data-review-control]").check();
                await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
                await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
            }
        }
        const attempts = app.previews.length;
        await app.advance();
        if (stage !== "draft") {
            if (stage === "preview") await page.getByRole("button", { name: "1. Activity", exact: true }).click();
            await expect(page.locator("#newDataNotice")).toContainText("preview stays frozen", { timeout: 15000 });
            if (stage === "preview") {
                await page.getByRole("button", { name: "3. Review & save", exact: true }).click();
                await page.locator(".attestation input[data-review-control]").check();
                await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
            }
            await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
            assert.equal(app.previews.length, attempts);
            assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 2);
            if (process.env.WIRE_REPORT_PROOFS) await page.screenshot({
                path: path.join(process.env.WIRE_REPORT_PROOFS, `collection-advance-${stage}.png`), fullPage: true,
            });
            await page.getByRole("button", { name: "Save report", exact: true }).click();
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
            assert.equal((await app.board()).exports[0].selectionScope.nativeConversations, 2);
            assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
            return;
        }
        const action = page.getByRole("button", { name: "Prepare report", exact: true });
        if (await action.isEnabled()) await action.click();
        await expect(page.locator("#reportsView")).not.toHaveAttribute("data-report-phase", "saved");
        await expect(page.getByRole("button", { name: "Save report", exact: true }).and(page.locator(":enabled"))).toHaveCount(0);
        await expect(page.locator("#reportsView").getByRole("alert")).toContainText(/changed|STALE/);
        assert.equal((await app.board()).exports.length, 0);
        assert.equal(app.previews.length, attempts + 1);
        assert.equal(await page.locator("#reportTitle").inputValue(), "Original collection scope");
        assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `collection-advance-${stage}.png`), fullPage: true });
        }
    });

test("a qualified pre-publication refusal unlocks re-review without retrying the original save",
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await prepare(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        const original = app.prepared.at(-1), refused = page.waitForResponse(response => response.url().endsWith("/api/export"));
        const { before } = await app.advance();
        await app.damageRetiredRoot(before.nativeRetention.partitions[0].file);
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        const response = await refused, value = await response.json();
        assert.deepEqual(value.reportSave, { outcome: "not-published", kind: "report",
            previewId: original.previewId, bundleId: original.bundleId });
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
        await expect(page.locator("#reportsView").getByRole("alert")).toContainText("No report was saved.");
        await expect(page.getByRole("button", { name: "Back to contents", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Check save status", exact: true })).toHaveCount(0);
        assert.equal((await app.board()).exports.length, 0);
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        await page.getByRole("button", { name: "Read current activity", exact: true }).click();
        await page.getByRole("button", { name: "1. Activity", exact: true }).click();
        await page.getByRole("button", { name: "Use current activity for this report scope", exact: true }).click();
        await page.getByRole("button", { name: "2. Contents", exact: true }).click();
        assert.equal(await page.locator("#reportTitle").inputValue(), "Reviewed fixture report");
        await page.getByRole("button", { name: "Prepare report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        await expect(page.locator(".attestation input[data-review-control]")).not.toBeChecked();
        assert.notEqual(app.prepared.at(-1).previewId, original.previewId);
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
    });

for (const refusal of ["unqualified", "foreign-bundle", "unknown"]) test(`a ${refusal} save response cannot claim qualified no-publication recovery`,
    { skip: !root, timeout: 90000 }, async t => {
        const app = await setup(t, { segmented: true }), { page } = app;
        await prepare(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        const original = app.prepared.at(-1);
        await page.route("**/api/export", route => route.fulfill({ status: 409, json: {
            code: "NATIVE_REPORT_SOURCE_STALE", error: "Fixture conflict; publication is not qualified.",
            ...(refusal === "unqualified" ? {} : { reportSave: { outcome: "not-published", kind: "report",
                previewId: original.previewId, bundleId: refusal === "foreign-bundle" ? `export-${randomUUID()}` : original.bundleId } }),
            ...(refusal === "unknown" ? { outcome: "unknown" } : {}),
        } }), { times: 1 });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
        await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Back to contents", exact: true })).toBeDisabled();
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
    });

test("a real scheduled capture finishes while the original report is reviewed and saved without pausing collection",
    { skip: !root, timeout: 180000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true, scheduled: true }), { page } = app;
        assert.equal(app.captures.length, 1);
        const next = app.nextCapture();
        await prepare(page, allFormats);
        const original = app.prepared.at(-1);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        const capture = await next;
        assert.equal(capture.status, "committed");
        await expect(page.locator("#newDataNotice")).toContainText("preview stays frozen", { timeout: 15000 });
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        assert.equal(app.previews.length, 1);
        assert.equal((await app.board()).nativeRetention.settings.paused, false);
        if (process.env.WIRE_REPORT_PROOFS) await page.screenshot({
            path: path.join(process.env.WIRE_REPORT_PROOFS, "scheduled-collection-during-review.png"), fullPage: true,
        });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports[0];
        assert.equal(saved.selectionScope.nativeConversations, 2);
        const current = await app.post("/api/snapshot", { layer: "tool", filters: { scope: "all" } });
        assert.equal(current.nativeRead.aggregates.conversations, 3);
        for (const format of ["html", "pdf", "json", "markdown"]) {
            const result = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format });
            const bytes = original.files[`product-report.${format === "markdown" ? "md" : format}`];
            assert.deepEqual(Buffer.from(result.data, "base64"), typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes.data, "base64"));
        }
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        assert.equal((await app.board()).nativeRetention.settings.paused, false);
    });

test("a lost saved response survives collection advancement with immutable files and a frozen Compare journey",
    { skip: !root, timeout: 120000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await prepare(page, allFormats);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        const original = app.prepared.at(-1);
        await page.route("**/api/export", async route => {
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await app.advance();
            await route.abort("failed");
        }, { times: 1 });
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
        await page.getByRole("button", { name: "Check save status", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        const first = (await app.board()).exports[0];
        const frozen = {};
        for (const format of ["html", "pdf", "json", "markdown"]) {
            const result = await app.post("/api/artifact-file", { kind: "report", bundleId: first.bundleId, format });
            const expected = original.files[`product-report.${format === "markdown" ? "md" : format}`];
            frozen[format] = Buffer.from(result.data, "base64");
            assert.deepEqual(frozen[format], typeof expected === "string" ? Buffer.from(expected) : Buffer.from(expected.data, "base64"));
        }
        await page.goto(app.url + "#reports"); await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${first.bundleId}"]`).click();
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        await page.goto(app.url + "#reports");
        await prepare(page);
        assert.equal(app.prepared.at(-1).snapshot.nativeEvidence.conversations.length, 3);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const second = (await app.board()).exports.find(entry => entry.bundleId !== first.bundleId);
        await page.goto(app.url + "#reports");
        await openReportComparison(page);
        const workspace = page.locator("#comparisonWorkspace");
        for (const [label, bundle] of [["Earlier report", first], ["Later report", second]]) {
            await workspace.getByRole("combobox", { name: label, exact: true }).click();
            await page.locator(`.select-popup .select-option[data-value="${bundle.bundleId}"]`).click();
        }
        await workspace.getByRole("button", { name: "Compare reports", exact: true }).click();
        await expect(workspace.locator(".comparison-native-results")).toContainText("Conversations");
        await workspace.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
        await workspace.getByRole("checkbox", { name: /reviewed this frozen comparison/ }).check();
        await workspace.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await workspace.getByRole("button", { name: "Save comparison", exact: true }).click();
        await expect(workspace.getByRole("button", { name: "Open saved comparison", exact: true })).toBeVisible();
        for (const [format, bytes] of Object.entries(frozen)) {
            const result = await app.post("/api/artifact-file", { kind: "report", bundleId: first.bundleId, format });
            assert.deepEqual(Buffer.from(result.data, "base64"), bytes);
        }
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 2);
    });

test("saved report reading survives Pause and reconnect while Logout clears report owners",
    { skip: !root, timeout: 120000 }, async t => {
        const app = await setup(t, { segmented: true, mixed: true }), { page } = app;
        await prepare(page);
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const saved = (await app.board()).exports[0];
        const original = await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "html" });
        await page.goto(app.url + "#settings?section=connection&setting=microsoft-connection");
        await expect(page.locator("#pauseMicrosoftCollection")).toBeEnabled();
        if (!(await app.board()).nativeRetention.settings.paused) await page.locator("#pauseMicrosoftCollection").click();
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
        assert.equal((await app.board()).nativeRetention.settings.paused, true);
        app.connectionFailure(true);
        await page.locator("#wireMicrosoftAction").click();
        await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
        await page.goto(app.url + "#reports");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        assert.deepEqual(await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "html" }), original);
        await page.goto(app.url + "#settings?section=connection&setting=microsoft-connection");
        app.connectionFailure(false);
        await page.locator("#wireMicrosoftAction").click();
        await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
        assert.equal((await app.board()).nativeRetention.settings.paused, true);
        await page.goto(app.url + "#reports?task=create");
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const pick = page.locator("#reportList [data-native-report-request]").first();
        await pick.check();
        const retired = await pick.elementHandle();
        await page.locator("#wireAccountTrigger").click();
        await page.locator("#wireAccountGate").click();
        await expect(page.locator("#workspace")).toBeHidden();
        await expect(page.locator("#reportList")).toBeEmpty();
        await retired.evaluate(node => { node.checked = true; node.dispatchEvent(new Event("change", { bubbles: true })); });
        assert.equal(app.writes.filter(write => write.route === "/api/export").length, 1);
        if (await page.locator("#wireAccountTrigger").getAttribute("aria-expanded") !== "true") await page.locator("#wireAccountTrigger").click();
        await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
        await page.locator("#wireAccountGate").click();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.goto(app.url + "#reports?task=create");
        await expect(page.locator("#reportList input:checked")).toHaveCount(0);
        await page.goto(app.url + "#reports");
        await page.locator(`.saved-report-summary[data-view-key="inspect-bundle:${saved.bundleId}"]`).click();
        await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        assert.deepEqual(await app.post("/api/artifact-file", { kind: "report", bundleId: saved.bundleId, format: "html" }), original);
    });
