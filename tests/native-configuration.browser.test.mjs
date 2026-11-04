import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";
import { fixture, privateFixture, selectActivityOption, chooseTheme } from "./helpers.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";
import { mountCollectionSettings } from "../web/settings.mjs";
import { mountSourceCollectionSettings } from "../web/source-collection-settings.mjs";

const backendRoot = process.env.WIRE_BOUNDED_BACKEND_ROOT || path.resolve(import.meta.dirname, "..");
const [{ createMicrosoftSession }, { createMicrosoftNativeReadTransport }, { createNativePersistence },
    { createNativeRuntimeAccess }, { startServer }, { createExportController }, { loadBoardState }] = await Promise.all([
    "microsoft-session.mjs", "microsoft-native-transport.mjs", "native-persistence.mjs",
    "runtime-access.mjs", "server.mjs", "export.mjs", "store.mjs",
].map(file => import(pathToFileURL(path.join(backendRoot, "lib", file)).href)));
const settingsOverlay = process.env.WIRE_SETTINGS_CANDIDATE === "1" ? await Promise.all([
    ["settings.mjs", "mountCollectionSettings", mountCollectionSettings],
    ["source-collection-settings.mjs", "mountSourceCollectionSettings", mountSourceCollectionSettings],
].map(async ([file, name, candidate]) => ({
    original: (await import(pathToFileURL(path.join(backendRoot, "web", file)).href))[name].toString(),
    candidate: candidate.toString(),
}))) : [];

async function setup(t, { beforeAcquire, holdsNetworkRequests = false, missingSourceComposite = false, sourceAware = false,
    verifyNative, mixed = false, github = mixed, nativeAcquisition = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, github ? [fixture()] : []);
    const sourceAccount = coworkFixture()[0].scope.account;
    const provider = [], writes = [], errors = [], unexpected = [];
    let persistence, runtime, browser, page, acquisitions = 0, loseConfigure = false, loseCollect = false, collectOwner;
    const collectLookups = [];
    const transport = createMicrosoftNativeReadTransport({
        async open() { provider.push("open"); },
        async verifyAccount() {
            provider.push("identity");
            await verifyNative?.();
            return { tenantId: sourceAccount.tenantId, subjectId: sourceAccount.subjectId, knownAccountMatched: true,
                evidence: { kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
        },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: true, windowDays: 30 },
        ...(sourceAware ? { sourceAware: true, globalCollection: null } : {}),
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    persistence = await createNativePersistence(context, { lifecycle, transport,
        preAccount: "metadata-only", configurationIntents: true });
    const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence, nativeConnection: true,
        ...(sourceAware ? { sourceAware: true, nativeAcquisition } : {}),
        async acquireNative(lease) {
            acquisitions++;
            await beforeAcquire?.(lease);
            const records = [...(mixed ? chatFixture() : []), ...coworkFixture()];
            for (const record of records) record.capture.generation = lease.generation;
            return records;
        } });
    t.after(async () => {
        await page?.unrouteAll({ behavior: holdsNetworkRequests ? "ignoreErrors" : "wait" });
        await browser?.close(); await runtime?.close(); access.close(); persistence.close(); await lifecycle.close();
        for (const work of cleanup.reverse()) await work();
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    });
    runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
    browser = await chromium.launch();
    page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
    const origin = new URL(runtime.url).origin;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
        if (url.pathname === "/" && settingsOverlay.length) {
            const response = await route.fetch();
            let body = await response.text();
            for (const replacement of settingsOverlay) {
                assert.equal(body.split(replacement.original).length, 2, "Replace only the exact original serialized Settings owner.");
                body = body.replace(replacement.original, () => replacement.candidate);
            }
            return route.fulfill({ response, body });
        }
        if (sourceAware && url.pathname === "/api/collection/microsoft/enrollment") {
            const status = await access.status();
            if (!status.retained) return route.fulfill({ status: 403, json: { code: "wire_access_revoked", error: "WIRE is signed out." } });
            return route.fulfill({ json: { schemaVersion: 1, phase: "prepared", generation: status.generation,
                actions: [], reason: "source-already-configured" },
            headers: { "X-Wire-Runtime": runtime.runtimeId, "X-Wire-Generation": String(status.generation) } });
        }
        if (missingSourceComposite && ["/", "/api/access/status", "/api/access/watch"].includes(url.pathname)) {
            const response = await route.fetch();
            if (url.pathname === "/") {
                const html = await response.text();
                const descriptor = /("schemaVersion":1,"mode":"enforced","runtimeId":"[^"]+","maxWaitMs":1000,"freshnessMs":5000)(})/g;
                assert.equal([...html.matchAll(descriptor)].length, 1);
                return route.fulfill({ response, body: html.replace(descriptor, '$1,"collectionMode":"source-aware"$2') });
            }
            return route.fulfill({ response, json: { ...await response.json(), collectionMode: "source-aware" } });
        }
        if (url.pathname === "/api/collection/status" && request.postDataJSON()?.operationId) {
            collectLookups.push({ operationId: request.postDataJSON().operationId,
                sameOwner: (await request.allHeaders())["x-board-capability"] === collectOwner });
        }
        if (request.method() === "POST" && /^\/api\/(?:access\/command|collection\/(?:(?:microsoft|global)\/)?(?:configure|enabled|now))$/.test(url.pathname)) {
            writes.push({ path: url.pathname, body: request.postDataJSON() });
            if (url.pathname === "/api/collection/now") collectOwner = (await request.allHeaders())["x-board-capability"];
            if (loseConfigure && url.pathname === "/api/collection/configure" || loseCollect && url.pathname === "/api/collection/now") {
                if (url.pathname === "/api/collection/configure") loseConfigure = false;
                else loseCollect = false;
                const response = await route.fetch();
                assert.equal(response.status(), 200);
                return route.abort("failed");
            }
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#settings?section=connection");
    if (!await page.locator("#wireAccountTrigger").isVisible()) await page.locator("#navigationToggle").click();
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    await page.locator("#wireAccountGate").click();
    if (missingSourceComposite) return { page, writes, provider, get acquisitions() { return acquisitions; } };
    if (sourceAware) {
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
        return { page, context, lifecycle, writes, provider, get acquisitions() { return acquisitions; },
            async seedLegacyActivity() {
                const admission = { owner: "existing-legacy-settings-fixture", check() {}, dispatched() {} };
                const begun = await persistence.begin({ operationId: randomUUID() }, admission);
                try {
                    const records = [...chatFixture(), ...coworkFixture()];
                    for (const record of records) record.capture.generation = begun.ticket.lease.generation;
                    return await persistence.commit(begun.ticket, records);
                } finally { await persistence.retire(begun.ticket); }
            },
            get runtimeUrl() { return runtime.url; } };
    }
    await expect(page.locator("#saveCollection")).toHaveText("Enable Microsoft collection");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#pauseCollection")).toBeHidden();
    await expect(page.locator("#settingsRefreshContext")).toBeHidden();
    assert.deepEqual(provider, []);
    assert.equal(acquisitions, 0);
    return { page, context, lifecycle, writes, provider, collectLookups, get acquisitions() { return acquisitions; },
        get runtimeUrl() { return runtime.url; },
        async isCollectOwner(request) { return (await request.allHeaders())["x-board-capability"] === collectOwner; },
        loseNextConfigure() { loseConfigure = true; },
        loseNextCollect() { loseCollect = true; },
        async changeElsewhere(values) {
            const request = async (path, body, capability) => {
                const response = await fetch(origin + path, { method: "POST", headers: {
                    Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
                }, body: JSON.stringify(body) });
                assert.equal(response.status, 200);
                return response.json();
            };
            const { capability } = await request("/api/session", {});
            try {
                const { nativeConfigurationOffer: offer } = await request("/api/collection/status", {}, capability);
                return await request("/api/collection/configure", {
                    schemaVersion: 1, intent: offer.intent, generation: offer.generation,
                    authorizationRevision: offer.authorizationRevision, expectedRevision: offer.expectedRevision, ...values,
                }, capability);
            } finally { await request("/api/session/release", {}, capability); }
        },
        async connect() {
            await page.locator("#wireMicrosoftAction").click();
            await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
            await expect(page.locator("#saveCollection")).toBeEnabled({ timeout: 10000 });
            await expect(page.locator("#settingsRefreshContext")).toBeHidden();
        } };
}

test("delayed first source snapshot converges Settings through accepted polling without a manual read", { timeout: 45000 }, async t => {
    const snapshotReady = Promise.withResolvers(), releaseSnapshot = Promise.withResolvers();
    t.after(() => releaseSnapshot.resolve());
    let failConnect = false;
    const app = await setup(t, { sourceAware: true, mixed: true, github: false,
        verifyNative: async () => { if (failConnect) throw new Error("Fixture transport failed"); } });
    const { page } = app;
    const capture = async phase => {
        if (!process.env.WIRE_SETTINGS_INITIAL_PROOFS) return;
        await mkdir(process.env.WIRE_SETTINGS_INITIAL_PROOFS, { recursive: true });
        await page.locator("#settingsView").screenshot({ path: path.join(process.env.WIRE_SETTINGS_INITIAL_PROOFS, phase + ".png") });
    };
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await selectActivityOption(page, "sourceMicrosoftWindow", "7");
    await page.locator("#saveMicrosoftCollection").click();
    await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Save preferences");
    await app.seedLegacyActivity();
    await page.reload();
    await expect(page.locator("#sourceMicrosoftSaved")).toContainText("2 conversations");
    await page.locator("#pauseMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    failConnect = true;
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await page.goto(app.runtimeUrl + "#settings?section=connection&setting=microsoft-connection");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    const before = await loadBoardState(app.context), writesBefore = app.writes.length;
    let delayed = false, watches = 0, reloadStarted, delayedAt, releasedAt;
    const reads = [];
    page.on("response", response => {
        const pathname = new URL(response.url()).pathname;
        if (pathname === "/api/access/watch") watches++;
        if (["/api/snapshot", "/api/collection/status", "/api/collection/sources/status"].includes(pathname)) {
            reads.push({ path: pathname, status: response.status(), elapsed: Date.now() - reloadStarted });
        }
    });
    await page.route("**/api/snapshot", async route => {
        if (delayed) return route.continue();
        delayed = true;
        delayedAt = Date.now();
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        snapshotReady.resolve();
        await releaseSnapshot.promise;
        await route.fulfill({ response });
    });
    reloadStarted = Date.now();
    await page.reload();
    await snapshotReady.promise;
    await new Promise(resolve => setTimeout(resolve, 3800));
    const whileChecking = await page.locator("#settingsConnectionError").textContent();
    const initialMicrosoft = await page.locator("#sourceMicrosoftStatus").textContent();
    const initialSources = await page.locator("#sourceMicrosoftSurfaces-control").textContent();
    const initialRecovery = await page.locator("#readMicrosoftCollection").isVisible();
    const initialSaveDisabled = await page.locator("#saveMicrosoftCollection").isDisabled();
    await capture("checking");
    releasedAt = Date.now();
    releaseSnapshot.resolve();
    await expect.poll(() => reads.filter(read => read.path === "/api/collection/sources/status").length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const result = { whileChecking, initialMicrosoft, initialSources, initialRecovery, initialSaveDisabled,
        delayedAt: delayedAt - reloadStarted, releasedAt: releasedAt - reloadStarted,
        watches, reads, error: await page.locator("#settingsConnectionError").textContent(),
        microsoft: await page.locator("#sourceMicrosoftStatus").textContent(),
        global: await page.locator("#globalCollectionStatus").textContent(),
        surfaces: await page.locator("#sourceMicrosoftSurfaces-control").textContent(),
        history: await page.locator("#sourceMicrosoftWindow-control").textContent() };
    t.diagnostic(JSON.stringify(result));
    assert.ok(reads.every(read => read.status === 200));
    await expect(page.locator("#settingsConnectionError")).toBeHidden();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
    await expect(page.locator("#sourceMicrosoftSurfaces-control")).toContainText("Chat and Cowork");
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("7");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await capture("accepted");
    assert.equal(app.writes.length, writesBefore);
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention, before.nativeRetention);
    assert.equal(whileChecking, "", "An unfinished first status read is checking, not a failed source read.");
    assert.equal(initialMicrosoft, "Checking settings...", "No accepted source snapshot has arrived yet.");
    assert.match(initialSources, /Loading options/);
    assert.equal(initialRecovery, false);
    assert.equal(initialSaveDisabled, true);
    await page.route("**/api/snapshot", route => route.fulfill({ status: 409, json: {
        code: "wire_access_global_collection_stale", error: "wire_access_global_collection_stale",
    } }));
    await page.reload();
    await expect(page.locator("#storedViewRetry")).toBeVisible();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Status unavailable");
    await expect(page.locator("#sourceMicrosoftSurfaces-control")).toHaveText("Refresh to choose");
    await expect(page.locator("#settingsConnectionError")).toBeVisible();
    await capture("refused");
    assert.equal(app.writes.length, writesBefore);
});

test("ordinary Microsoft Settings separates each source's history coverage from connection and collection permission", { timeout: 120000 }, async t => {
    const app = await setup(t, { sourceAware: true, mixed: true, nativeAcquisition: true }), { page } = app;
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Not enabled");
    await expect(page.locator("#sourceMicrosoftProgress")).toBeHidden();
    assert.equal(app.writes.some(write => write.path.includes("/collection/")), false);
    await selectActivityOption(page, "sourceMicrosoftWindow", "7");
    await page.locator("#saveMicrosoftCollection").click();
    await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
    const before = await loadBoardState(app.context), writes = app.writes.length;
    let backfill;
    await page.route(/\/api\/(?:collection\/sources\/status|snapshot)$/, async route => {
        const response = await route.fetch(), body = await response.json();
        const status = body.collection?.sourceAware?.microsoft.status ?? body.microsoft?.status;
        assert.ok(status, "Coverage fixtures only extend the actual current Microsoft source status.");
        if (backfill) status.backfill = backfill;
        else delete status.backfill;
        await route.fulfill({ response, json: body });
    });
    const source = {
        surface: "chat", startQualified: false, controlObserved: true, initial: "empty",
        pages: 4, chainPages: 4, exhausted: false, eligible: 5, handled: 3, suppressed: 0,
        pending: 2, unreadable: 0, stops: [],
    };
    const cases = [
        ["progressing", source, "Partly checked. 3 read, 2 pending."],
        ["unqualified", { ...source, exhausted: true, handled: 5, pending: 0 }, "Coverage not verified. 5 read."],
        ["progressing", { ...source, handled: 2, suppressed: 1, pending: 1, unreadable: 1,
            stops: ["membership-budget", "unreadable-history", "continuity-lost"] },
            "Partly checked. 2 read, 1 kept deleted, 1 pending, 1 unreadable. Interrupted; more histories uncounted."],
        ["covered", { ...source, startQualified: true, exhausted: true, handled: 5, pending: 0 }, "Window checked. 5 read."],
    ];
    const output = process.env.WIRE_HISTORY_PROGRESS_PROOFS;
    if (output) await mkdir(output, { recursive: true });
    for (const [index, [state, row, expected]] of cases.entries()) {
        backfill = { schemaVersion: 1, window: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-08T12:00:00.000Z" },
            state, sources: [row, { ...row, surface: "cowork" }] };
        await page.reload();
        await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(`Chat history: ${expected}\nCowork history: ${expected}`);
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Enabled");
        await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
        await expect(page.locator("#sourceMicrosoftProgress .pending-indicator")).toHaveCount(0);
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 1], [390, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await chooseTheme(page, theme);
            await page.evaluate(() => document.fonts.ready);
            const geometry = await page.locator("#sourceMicrosoftProgress").evaluate(node => {
                const rect = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect();
                const next = node.nextElementSibling.getBoundingClientRect(), css = getComputedStyle(node);
                return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    contained: rect.left >= parent.left && rect.right <= parent.right + 1,
                    followingGap: next.top - rect.bottom, fontSize: css.fontSize, weight: css.fontWeight,
                    radius: css.borderRadius, text: node.textContent };
            });
            assert.equal(geometry.overflow, false);
            assert.equal(geometry.contained, true);
            assert.ok(geometry.followingGap >= 8);
            assert.equal(geometry.weight, "400");
            assert.equal(geometry.radius, "0px");
            const paint = await page.locator("#sourceMicrosoftProgress").evaluate(measureControlSurface);
            assert.ok(contrast(paint.ink, paint.face) >= 4.5, "Per-source history text retains readable composed contrast.");
            if (output) {
                const name = `history-${index}-${state}-${theme}-${width}-${scale}`;
                await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
                await writeFile(path.join(output, name + ".json"), JSON.stringify(geometry, null, 2));
            }
        }
    }
    backfill = { schemaVersion: 1, window: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-08T12:00:00.000Z" },
        state: "progressing", sources: [
            { ...source, startQualified: true, exhausted: true, eligible: 0, handled: 0, pending: 0 },
            { ...source, surface: "cowork", controlObserved: false, initial: "unobserved",
                pages: 0, chainPages: 0, eligible: 0, handled: 0, pending: 0 },
        ] };
    await page.reload();
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(
        "Chat history: Window checked. No histories in this window.\nCowork history: Not checked yet.");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Enabled");
    await page.locator("#sourceMicrosoftSurfaces-control").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#sourceMicrosoftSurfaces-control")).toBeFocused();
    await selectActivityOption(page, "sourceMicrosoftSurfaces", "chat");
    await expect(page.locator("#sourceMicrosoftProgress")).toBeHidden();
    await page.locator("#cancelMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftProgress")).toContainText("Cowork history: Not checked yet.");
    if (output) await page.locator("#wireMicrosoftConnection").screenshot({ path: path.join(output, "mixed-source-coverage.png") });
    backfill = null;
    await page.reload();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText(
        "Chat history: Coverage not verified.\nCowork history: Coverage not verified.");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Enabled");
    assert.equal(app.writes.length, writes);
    assert.equal(app.acquisitions, 0);
    assert.deepEqual(await loadBoardState(app.context), before);
    if (output && process.env.WIRE_NATIVE_SETTINGS_INSPECTOR) {
        await expect(page.getByRole("heading", { name: "Settings", level: 1, exact: true })).toBeVisible();
        // The inspector selects an earlier hidden shell h1; its own hero metric sees Settings.
        await promisify(execFile)(process.execPath, [process.env.WIRE_NATIVE_SETTINGS_INSPECTOR,
            app.runtimeUrl + "#settings?section=connection", "--app", "--allow", "button-fx,edge-text,gradient,contrast,no-title",
            "--out", path.join(output, "inspection"), "--json"],
        { timeout: 60000, maxBuffer: 1024 * 1024 });
    }
    await selectActivityOption(page, "sourceMicrosoftSurfaces", "chat");
    await page.locator("#saveMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("Chat history: Coverage not verified.");
    await page.locator("#pauseMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    await expect(page.locator("#sourceMicrosoftProgress")).toHaveText("Chat history: Coverage not verified.");
    assert.equal(app.acquisitions, 0);
    t.diagnostic("Synthetic per-source coverage; real Settings, access decoders, Enable/Save/Pause and durable source choices. No provider or real Microsoft acceptance.");
});

test("composed startup distinguishes saved GitHub Chat and Cowork activity from current connection and collection", { timeout: 60000 }, async t => {
    let failConnect = false;
    const app = await setup(t, { sourceAware: true, mixed: true, nativeAcquisition: true,
        verifyNative: async () => { if (failConnect) throw new Error("Fixture transport failed"); } });
    const { page } = app;
    const capture = async name => {
        if (!process.env.WIRE_STARTUP_PROOFS) return;
        await mkdir(process.env.WIRE_STARTUP_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_STARTUP_PROOFS, name + ".png"), fullPage: true });
    };
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#saveMicrosoftCollection")).toBeEnabled();
    await selectActivityOption(page, "sourceMicrosoftWindow", "7");
    await page.locator("#saveMicrosoftCollection").click();
    await expect(page.locator("#collectMicrosoftActivity")).toBeEnabled();
    await page.locator("#collectMicrosoftActivity").click();
    await expect.poll(() => app.acquisitions).toBe(1);
    await expect(page.locator("#sourceMicrosoftSaved")).toContainText("2 conversations / 3 tool calls");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftSaved")).toContainText("Last saved");
    await expect(page.locator("#sourceMicrosoftSaved")).not.toContainText("not a live connection");
    await expect(page.locator("#sourceMicrosoftSaved")).not.toContainText("In this saved view");
    await expect(page.locator("#freshStatus")).toHaveText("Microsoft collection completed.");
    await expect(page.locator("#freshContextMessage")).toBeHidden();
    await capture("06-connected-collection-freshness");
    const stored = await loadBoardState(app.context), receipt = stored.nativeRetention.receipts.at(-1);
    assert.equal(receipt.status, "committed");
    await page.locator("#pauseMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    failConnect = true;
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await page.reload();
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    await expect(page.locator("#sourceMicrosoftSaved")).toContainText("Last saved");
    await expect(page.locator("#sourceMicrosoftSaved")).not.toContainText("not a live connection");
    await expect(page.locator("#sourceMicrosoftSaved")).not.toContainText("In this saved view");
    await expect(page.locator("#collectMicrosoftActivity")).toBeDisabled();
    await capture("07-composed-settings-saved-not-connected");
    for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.evaluate(() => document.fonts.ready);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}: no page overflow`);
            await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
            await expect(page.locator("#sourceMicrosoftSaved")).toContainText("2 conversations");
            await capture(`settings-${theme}-${width}`);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const snapshots = [];
    page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/snapshot" && response.ok()) void response.json().then(value => snapshots.push(value));
    });
    await page.goto(app.runtimeUrl + "#analyze");
    await page.reload();
    await expect(page.locator("#activityListSummary")).toHaveText("1 GitHub interaction / 2 Microsoft conversations");
    await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
    await expect(page.locator("#activityList")).toContainText("Microsoft 365 Copilot Chat");
    await expect(page.locator("#activityList")).toContainText("Cowork");
    await expect(page.locator("#activityList")).toContainText("SYNTHETIC_PRIVATE_PROMPT");
    await expect(page.locator("#collectionNotice")).toContainText("Connect a source in Settings.");
    await expect(page.locator("#scopeFilter option:checked")).toHaveText("Saved collection");
    await expect.poll(() => snapshots.length).toBeGreaterThan(0);
    assert.equal(snapshots.at(-1).nativeRead.readback.committed.committedAt, receipt.committedAt);
    assert.equal(snapshots.at(-1).collection.sourceAware.microsoft.status.receipt, null,
        "New page sees saved provenance without adopting the original page's collection receipt.");
    assert.equal(snapshots.at(-1).collection.sourceAware.microsoft.status.configuration.settings.paused, true);
    await capture("08-composed-analyze-saved-not-connected");
    await page.reload();
    await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
    assert.equal(app.acquisitions, 1, "Refresh and failed Connect do not collect again.");
    assert.deepEqual((await loadBoardState(app.context)).nativeRetention.receipts, stored.nativeRetention.receipts);
    t.diagnostic(JSON.stringify({ committedAt: receipt.committedAt, mixedSources: 3, conversations: 2,
        calls: 3, acquisitions: app.acquisitions, connected: false, paused: true }));
});

test("failed Connect keeps its settled result while stale source status offers read-only Settings recovery", { timeout: 45000 }, async t => {
    let failConnect = false;
    const entered = Promise.withResolvers(), failOriginal = Promise.withResolvers();
    t.after(() => failOriginal.resolve());
    const app = await setup(t, { sourceAware: true, verifyNative: async () => {
        if (failConnect) {
            entered.resolve();
            await failOriginal.promise;
            throw new Error("Fixture transport failed");
        }
    } }), { page } = app;
    await page.locator("#wireMicrosoftAction").click();
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Connected");
    await expect(page.locator("#sourceMicrosoftSurfaces")).toBeEnabled();
    await selectActivityOption(page, "sourceMicrosoftWindow", "7");
    await page.locator("#saveMicrosoftCollection").click();
    await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Save preferences");
    await page.locator("#pauseMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    const before = await loadBoardState(app.context), writesBefore = app.writes.length;
    failConnect = true;
    let staleReads = 0, allowStatus = false;
    await page.route("**/api/snapshot", async route => {
        if (allowStatus || (await app.lifecycle.status()).microsoft.reason !== "transport-failed") return route.continue();
        staleReads++;
        return route.fulfill({ status: 409, json: { error: "wire_access_global_collection_stale", code: "wire_access_global_collection_stale" } });
    });
    const settled = page.waitForResponse(response => response.url().endsWith("/api/access/command")
        && response.request().postDataJSON().action === "microsoft-connect");
    await page.locator("#wireMicrosoftAction").click();
    await entered.promise;
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Waiting for Microsoft sign-in");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
    failOriginal.resolve();
    const receipt = await (await settled).json();
    assert.equal(receipt.outcome, "failed"); assert.equal(receipt.reason, "transport-failed");
    const failedConnection = (await app.lifecycle.status()).microsoft;
    await expect(page.locator("#message")).toContainText("Read current");
    await expect(page.locator("#message")).not.toContainText("wire_access_global_collection_stale");
    await expect(page.getByRole("button", { name: "Read current settings", exact: true })).toBeEnabled();
    await expect(page.locator("#sourceMicrosoftSurfaces-control")).toHaveText("Refresh to choose");
    await expect(page.locator("#sourceMicrosoftWindow-control")).toHaveText("Refresh to choose");
    await expect(page.locator("#saveMicrosoftCollection")).toHaveText("Save preferences");
    await expect(page.locator("#storedViewRetry:visible, #reloadSettings:visible, #readMicrosoftCollection:visible, #readGlobalCollection:visible"))
        .toHaveCount(1);
    t.diagnostic(JSON.stringify({ transition: "original Connect pending -> failed -> status unavailable",
        sourceChoice: await page.locator("#sourceMicrosoftSurfaces-control").innerText(),
        historyChoice: await page.locator("#sourceMicrosoftWindow-control").innerText(),
        sharedRecoveryControls: 1, savedWindowDays: before.nativeRetention.settings.windowDays }));
    allowStatus = true;
    await page.locator("#storedViewRetry").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
    await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Paused");
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("7");
    await expect(page.locator("#sourceMicrosoftWindow-control")).toContainText("7 days");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    assert.deepEqual((await app.lifecycle.status()).microsoft, failedConnection);
    await selectActivityOption(page, "sourceMicrosoftWindow", "14");
    allowStatus = false;
    await page.route("**/api/collection/sources/status", route => allowStatus ? route.continue()
        : route.fulfill({ status: 409, json: { error: "wire_access_global_collection_stale", code: "wire_access_global_collection_stale" } }));
    await expect(page.locator("#settingsConnectionError")).toContainText("could not be read", { timeout: 10000 });
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("14");
    await expect(page.locator("#saveMicrosoftCollection")).toBeDisabled();
    allowStatus = true;
    await page.locator("#readMicrosoftCollection").click();
    await expect(page.locator("#sourceMicrosoftMessage")).toBeHidden();
    await expect(page.locator("#sourceMicrosoftWindow")).toHaveValue("14");
    await expect(page.locator("#sourceMicrosoftDraft")).toContainText("changed");
    await expect(page.locator("#wireMicrosoftStatus")).toHaveText("Not connected");
    const after = await loadBoardState(app.context);
    assert.deepEqual(after.nativeRetention, before.nativeRetention);
    assert.equal(Object.hasOwn(after, "globalCollection"), false);
    assert.deepEqual(app.writes.slice(writesBefore).map(write => write.body.action), ["microsoft-connect"]);
    assert.ok(staleReads > 0); assert.equal(app.acquisitions, 0);
});

test("in-flight original Connect keeps normal Settings stable across access-watch heartbeats", { timeout: 45000 }, async t => {
    const entered = Promise.withResolvers(), complete = Promise.withResolvers();
    let connecting = false, rejectSnapshot = true, staleReads = 0;
    const app = await setup(t, { sourceAware: true, verifyNative: async () => {
        connecting = true;
        entered.resolve();
        await complete.promise;
    } }), { page } = app;
    const watches = [];
    page.on("response", response => {
        if (response.url().endsWith("/api/access/watch")) void response.json().then(value => {
            watches.push({ revision: value.authorizationRevision, generation: value.generation, retained: value.retained,
                connection: value.microsoft?.state });
        }).catch(error => { watches.push({ readError: error.name }); });
    });
    await expect(page.locator("#settingsView")).toBeVisible();
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    const connection = await page.locator("#wireMicrosoftConnection").elementHandle();
    await page.route("**/api/snapshot", route => {
        if (!connecting || !rejectSnapshot) return route.continue();
        staleReads++;
        return route.fulfill({ status: 409, json: {
            error: "wire_access_global_collection_stale", code: "wire_access_global_collection_stale",
        } });
    });
    await page.evaluate(() => {
        window.settingsTransitions = [];
        const sample = () => {
            const workspace = document.getElementById("workspace"), message = document.getElementById("message");
            const state = workspace.hidden ? message.textContent : "settings:" + document.getElementById("wireMicrosoftStatus").textContent;
            if (settingsTransitions.at(-1) !== state) settingsTransitions.push(state);
        };
        window.settingsObserver = new MutationObserver(sample);
        settingsObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
        sample();
    });
    try {
        await page.locator("#wireMicrosoftAction").click();
        await entered.promise;
        await expect(page.locator("#storedViewRetry")).toHaveText("Read current settings");
        await expect(page.locator("#settingsView")).toBeVisible();
        await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
        await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
        assert.equal(await connection.evaluate(node => node === document.getElementById("wireMicrosoftConnection")), true);
        rejectSnapshot = false;
        await page.locator("#storedViewRetry").click();
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
        await page.waitForTimeout(11500);
        const transitions = await page.evaluate(() => settingsTransitions);
        assert.ok(watches.length >= 5, "Exercise the real in-flight command through multiple existing watch heartbeats.");
        assert.equal(watches.some(value => value.readError), false, "In-flight watch responses must remain readable.");
        assert.equal(transitions.some(value => value.includes("Private activity is unavailable")), false,
            JSON.stringify({ transitions, watches }));
        await expect(page.locator("#settingsView")).toBeVisible();
        await expect(page.locator("#wireMicrosoftAction")).toHaveText("Cancel sign-in");
        await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
        assert.equal(app.writes.filter(row => row.body.action === "microsoft-connect").length, 1);
        assert.ok(staleReads > 0);
        assert.equal(new URL(page.url()).hash, "#settings?section=connection");
        assert.equal(app.acquisitions, 0);
        t.diagnostic(JSON.stringify({ transitions, watchResponses: watches.length, staleSnapshotRefusals: staleReads,
            originalConnects: app.writes.filter(row => row.body.action === "microsoft-connect").length,
            pendingAction: await page.locator("#wireMicrosoftAction").textContent() }));
        if (!await page.locator("#wireAccountMenu").isVisible()) await page.locator("#wireAccountTrigger").click();
        await page.locator("#wireAccountGate").click();
        await expect(page.locator("#workspace")).toBeHidden();
        await expect(page.locator("#message")).toContainText("signed out");
        await expect(page.locator("#wireMicrosoftAction")).toBeHidden();
        await expect(page.locator("#sourceDatabase")).toHaveValue("");
        await expect(page.locator("#sourceSessions")).toHaveValue("");
        assert.equal(app.writes.filter(row => row.body.action === "microsoft-connect").length, 1);
    } finally {
        await page.evaluate(() => settingsObserver.disconnect());
        complete.resolve();
    }
});

test("activated main client rejects a native-only snapshot rather than falling back to native or GitHub collection", { timeout: 30000 }, async t => {
    // Negative marker projection only; this is not source-aware backend or mixed-data acceptance.
    const app = await setup(t, { missingSourceComposite: true }), { page } = app;
    await expect(page.locator("#message")).toContainText("Source-aware collection status is unavailable");
    for (const id of ["saveCollection", "pauseCollection", "collectNow", "connectCollection"]) {
        await expect(page.locator("#" + id)).toBeDisabled();
        await page.locator("#" + id).dispatchEvent("click");
    }
    assert.equal(app.writes.filter(write => write.path.startsWith("/api/collection/")).length, 0);
    assert.equal(app.acquisitions, 0);
    assert.deepEqual(app.provider, []);
});

test("existing Settings explicitly enables native collection and later saves while preserving Pause", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await expect(page.locator("#collectionWindow")).toHaveValue("30");
    await expect(page.locator("#nativeCollectionSurfaces")).toHaveValue("chat,cowork");
    await app.connect();
    assert.equal(app.writes.filter(write => write.path === "/api/collection/configure").length, 0);
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Microsoft collection enabled");
    await expect(page.locator("#saveCollection")).toHaveText("Save Microsoft preferences");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    let state = await loadBoardState(app.context);
    assert.deepEqual(state.nativeRetention.settings, { paused: false, windowDays: 30 });
    assert.deepEqual(state.nativeRetention.surfaces, ["chat", "cowork"]);
    assert.equal(state.nativeRetention.accounts.length, 1);
    assert.equal(state.nativeRetention.partitions.length, 0);
    assert.equal(app.acquisitions, 0, "Enable does not collect.");
    const enabled = app.writes.find(write => write.path === "/api/collection/configure").body;
    assert.deepEqual(Object.keys(enabled).sort(), ["authorizationRevision", "expectedRevision", "generation", "intent", "schemaVersion", "surfaces", "windowDays"]);
    assert.equal(enabled.intent, "enable"); assert.equal(enabled.expectedRevision, null);
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshStatus")).toHaveText("Microsoft collection completed.");
    assert.equal(app.acquisitions, 1);
    await page.locator("#pauseCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Microsoft reads paused");
    await selectActivityOption(page, "collectionWindow", "7");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toHaveText("Preferences saved.");
    state = await loadBoardState(app.context);
    assert.deepEqual(state.nativeRetention.settings, { paused: true, windowDays: 7 });
    assert.equal((await app.lifecycle.status()).collection, "paused");
    assert.equal(app.acquisitions, 1);
    const configure = app.writes.filter(write => write.path === "/api/collection/configure");
    assert.deepEqual(configure.map(write => write.body.intent), ["enable", "save"]);
    assert.equal(configure.some(write => Object.hasOwn(write.body, "paused") || Object.hasOwn(write.body, "operationId")), false);
    assert.deepEqual(app.writes.filter(write => write.path === "/api/collection/enabled").map(write => write.body.enabled), [false],
        "Only the explicit Pause uses the legacy native enabled route; no hidden Resume.");
    await page.reload();
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#pauseCollection")).toHaveText("Resume Microsoft reads");
    assert.equal(app.acquisitions, 1);
});

test("a lost native Enable response recovers current settings without replaying configuration", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await app.connect();
    await selectActivityOption(page, "nativeCollectionSurfaces", "cowork");
    await selectActivityOption(page, "collectionWindow", "7");
    app.loseNextConfigure();
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("unconfirmed");
    await expect(page.locator("#reloadSettings")).toBeVisible();
    assert.equal((await loadBoardState(app.context)).nativeRetention.settings.paused, false);
    await page.locator("#reloadSettings").click();
    await expect(page.locator("#settingsMessage")).toContainText("Current");
    await expect(page.locator("#saveCollection")).toHaveText("Save Microsoft preferences");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#nativeCollectionSurfaces")).toHaveValue("cowork");
    await expect(page.locator("#connectionStatus")).not.toHaveText("Not enabled");
    assert.equal(app.writes.filter(write => write.path === "/api/collection/configure").length, 1);
    assert.equal(app.acquisitions, 0);
    assert.equal(app.writes.some(write => write.path === "/api/collection/enabled"), false);
});

test("a new offer preserves the native draft and requires explicit cancel before another Save", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await app.connect();
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Microsoft collection enabled");
    await selectActivityOption(page, "collectionWindow", "7");
    const external = await app.changeElsewhere({ surfaces: ["chat"], windowDays: 14 });
    await expect(page.locator("#settingsDraftStatus")).toContainText("Settings changed", { timeout: 10000 });
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#nativeCollectionSurfaces")).toHaveValue("chat,cowork");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    assert.equal(app.writes.filter(write => write.path === "/api/collection/configure").length, 1);
    await page.locator("#cancelPreferences").click();
    await expect(page.locator("#collectionWindow")).toHaveValue("14");
    await expect(page.locator("#nativeCollectionSurfaces")).toHaveValue("chat");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await selectActivityOption(page, "collectionWindow", "90");
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Preferences saved");
    const saved = app.writes.filter(write => write.path === "/api/collection/configure").at(-1).body;
    assert.equal(saved.expectedRevision, external.nativeConfigurationOffer.expectedRevision);
    assert.equal(saved.authorizationRevision, external.nativeConfigurationOffer.authorizationRevision);
    assert.equal(app.acquisitions, 0);
});

test("a held Enable gesture cannot adopt authority from a later connection generation", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await app.connect();
    await page.locator("#saveCollection").dispatchEvent("pointerdown", { button: 0, pointerId: 1, isPrimary: true });
    await app.lifecycle.command("other-native-configuration-panel", {
        action: "microsoft-connect", replace: false, operationId: randomUUID(),
        generation: (await app.lifecycle.status()).generation,
    }, () => true);
    await expect(page.locator("#saveCollection")).toBeEnabled();
    await page.locator("#saveCollection").dispatchEvent("click", { detail: 1 });
    await expect(page.locator("#settingsMessage")).toContainText("before activation");
    assert.equal(app.writes.filter(write => write.path === "/api/collection/configure").length, 0);
    assert.equal((await loadBoardState(app.context)).nativeRetention, undefined);
});

test("a committed Collect with a lost reply recovers only its original owner's exact operation", { timeout: 45000 }, async t => {
    const app = await setup(t), { page } = app;
    await app.connect();
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Microsoft collection enabled");
    app.loseNextCollect();
    await page.locator("#checkActivity").click();
    await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "unconfirmed");
    assert.equal(app.acquisitions, 1);
    assert.equal((await loadBoardState(app.context)).nativeRetention.receipts[0].status, "committed");
    const retry = page.locator("#refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").first();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.locator("#freshStatus")).toHaveText("Microsoft collection completed.");
    const sent = app.writes.filter(write => write.path === "/api/collection/now");
    assert.equal(sent.length, 1);
    assert.deepEqual(app.collectLookups, [{ operationId: sent[0].body.operationId, sameOwner: true }]);
    assert.equal(app.acquisitions, 1);
});

test("a long Collect followed by snapshot freshness withdrawal never replays or adopts a foreign receipt", { timeout: 45000 }, async t => {
    const acquired = Promise.withResolvers(), releaseAcquire = Promise.withResolvers(), firstRead = Promise.withResolvers();
    const secondRead = Promise.withResolvers(), releaseSecondRead = Promise.withResolvers();
    t.after(() => { releaseAcquire.resolve(); releaseSecondRead.resolve(); });
    const app = await setup(t, { holdsNetworkRequests: true,
        beforeAcquire: async () => { acquired.resolve(); await releaseAcquire.promise; } });
    const { page } = app;
    let snapshots = 0, holdSnapshots = false, holdOneWatch = false, watchHeld = false;
    const failures = [];
    page.on("requestfailed", request => {
        if (new URL(request.url()).pathname === "/api/snapshot") failures.push(request.failure()?.errorText);
    });
    await page.route("**/api/access/watch", route => {
        if (holdOneWatch && !watchHeld) { watchHeld = true; return; }
        return route.fallback();
    });
    await page.route("**/api/snapshot", async route => {
        if (!holdSnapshots) return route.fallback();
        if (++snapshots === 1) {
            holdOneWatch = true; firstRead.resolve(route.request()); return;
        }
        if (snapshots === 2) { secondRead.resolve(route.request()); await releaseSecondRead.promise; }
        return route.fallback();
    });
    try {
        await app.connect();
        await page.locator("#saveCollection").click();
        await expect(page.locator("#settingsMessage")).toContainText("Microsoft collection enabled");
        holdSnapshots = true;
        await page.locator("#checkActivity").click();
        await acquired.promise;
        await page.waitForTimeout(5500);
        await expect(page.locator("#freshActivity")).toHaveAttribute("data-phase", "checking");
        await expect(page.locator("#workspace")).toBeVisible();
        releaseAcquire.resolve();
        await expect.poll(() => snapshots, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
        await firstRead.promise;
        await expect.poll(() => snapshots, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
        const recoveredRequest = await secondRead.promise;
        await expect(page.locator("#pageTitle")).toHaveText("Settings");
        await expect(page.locator("#activityList")).toHaveText("");
        await expect(page.locator("#requestContent")).toHaveText("");
        await expect(page.locator("#sourceDatabase")).toHaveValue("");
        assert.ok(failures.includes("net::ERR_ABORTED"));
        const sameOwner = await app.isCollectOwner(recoveredRequest);
        releaseSecondRead.resolve();
        await expect(page.locator("#workspace")).toBeVisible();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        assert.equal(app.writes.filter(write => write.path === "/api/collection/now").length, 1);
        assert.equal(app.acquisitions, 1);
        assert.equal((await loadBoardState(app.context)).nativeRetention.receipts[0].status, "committed");
        assert.ok(app.collectLookups.every(lookup => lookup.sameOwner));
        const operationId = app.writes.find(write => write.path === "/api/collection/now").body.operationId;
        assert.ok(app.collectLookups.every(lookup => lookup.operationId === operationId));
        if (sameOwner) {
            if ((await page.locator("#freshStatus").textContent()).trim() !== "Microsoft collection completed.") {
                const retry = page.locator("#refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").first();
                await expect(retry).toBeEnabled(); await retry.click();
            }
            await expect(page.locator("#freshStatus")).toHaveText("Microsoft collection completed.");
            assert.equal(app.acquisitions, 1);
        } else await expect(page.locator("#freshStatus")).not.toHaveText("Microsoft collection completed.");
        t.diagnostic(JSON.stringify({ simulated: true, snapshotAbortedByFreshness: true,
            recoveredOriginalControlOwner: sameOwner, sourceAcquisitions: app.acquisitions, originalOperationLookups: app.collectLookups.length }));
    } finally {
        releaseAcquire.resolve(); releaseSecondRead.resolve();
    }
});

test("a snapshot reply deadline keeps fresh authority and recovers the same Collect without another acquisition", { timeout: 30000 }, async t => {
    const app = await setup(t, { holdsNetworkRequests: true }), { page } = app;
    let holdSnapshot = false, held = false, lastWatchAt = Date.now();
    const starts = new WeakMap(), failures = [];
    page.on("request", request => starts.set(request, Date.now()));
    page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/access/watch" && response.status() === 200) lastWatchAt = Date.now();
    });
    page.on("requestfailed", request => {
        if (new URL(request.url()).pathname === "/api/snapshot") failures.push({
            code: request.failure()?.errorText, elapsed: Date.now() - starts.get(request), watchAge: Date.now() - lastWatchAt,
        });
    });
    await page.route("**/api/snapshot", route => {
        if (holdSnapshot && !held) { held = true; return; }
        return route.fallback();
    });
    await app.connect();
    await page.locator("#saveCollection").click();
    await expect(page.locator("#settingsMessage")).toContainText("Microsoft collection enabled");
    holdSnapshot = true;
    await page.locator("#checkActivity").click();
    await expect.poll(() => failures.length, { timeout: 15000 }).toBe(1);
    assert.equal(failures[0].code, "net::ERR_ABORTED");
    assert.ok(failures[0].elapsed >= 9000 && failures[0].elapsed < 13000);
    assert.ok(failures[0].watchAge < 2000);
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#freshStatus")).not.toHaveText("Microsoft collection completed.");
    const retry = page.locator("#refreshBtn:visible, #collectionRetry:visible, [data-stored-refresh-retry]:visible").first();
    await expect(retry).toBeEnabled(); await retry.click();
    await expect(page.locator("#freshStatus")).toHaveText("Microsoft collection completed.");
    const sent = app.writes.filter(write => write.path === "/api/collection/now");
    assert.equal(sent.length, 1);
    assert.equal(app.acquisitions, 1);
    assert.equal(app.collectLookups.length, 2);
    assert.ok(app.collectLookups.every(lookup => lookup.sameOwner && lookup.operationId === sent[0].body.operationId));
    t.diagnostic(JSON.stringify({ simulated: true, snapshotDeadline: true, observedNetworkCode: failures[0].code,
        requestMilliseconds: failures[0].elapsed, watchAgeMilliseconds: failures[0].watchAge, sourceAcquisitions: 1 }));
});

test("native collection controls preserve the existing Settings frame in both themes and narrow widths", { timeout: 120000 }, async t => {
    const app = await setup(t), { page } = app;
    const proofs = process.env.WIRE_NATIVE_SETTINGS_PROOFS;
    const measured = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    for (const phase of ["before-account", "ready-to-enable"]) {
        if (phase === "ready-to-enable") await app.connect();
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            for (const width of [1440, 768, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                await expect(page.locator("#nativeCollectionSourceField")).toBeVisible();
                await expect(page.locator("#connectionPreferences")).toBeVisible();
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                const geometry = await page.locator("#connectionPreferences").evaluate(node => {
                    const frame = node.getBoundingClientRect();
                    return [...node.querySelectorAll("button, .select-trigger")].filter(control => control.checkVisibility())
                        .map(control => { const box = control.getBoundingClientRect(); return {
                            inside: box.left >= frame.left - 1 && box.right <= frame.right + 1, height: box.height,
                        }; });
                });
                assert.ok(geometry.length >= 3);
                assert.ok(geometry.every(control => control.inside && control.height >= 44));
                const controls = page.locator("#connectionPreferences button:visible, #connectionPreferences .select-trigger:visible");
                for (const control of await controls.all()) {
                    const paint = await control.evaluate(measureControlSurface), ratio = contrast(paint.ink, paint.face);
                    assert.ok(ratio >= 4.5, "Native preference controls retain legible actual painted faces.");
                    measured.push({ phase, theme, width, contrast: ratio, height: paint.box.height, disabled: paint.disabled });
                }
                if (proofs) await page.screenshot({ path: path.join(proofs, `${phase}-${theme}-${width}.png`), fullPage: true });
            }
        }
    }
    if (proofs && process.env.WIRE_NATIVE_SETTINGS_INSPECTOR) {
        const exceptions = {
            "button-fx": "Unchanged, accepted WIRE button paint; this increment adds no shadow or effect.",
            "edge-text": "The unchanged WIRE brand tagline is at 15px; product layout ownership prohibits an unrelated logo move.",
            gradient: "The unchanged rounded Search capsule belongs to the accepted WIRE design and is not restyled here.",
            contrast: "The generic probe ignores the primary button's inset pseudo-element face; actual composited control contrast is asserted separately.",
        };
        await promisify(execFile)(process.execPath, [process.env.WIRE_NATIVE_SETTINGS_INSPECTOR,
            app.runtimeUrl + "#settings?section=connection", "--app", "--allow", Object.keys(exceptions).join(","),
            "--out", path.join(proofs, "inspection-verified"), "--json"],
        { timeout: 60000, maxBuffer: 1024 * 1024 });
        await writeFile(path.join(proofs, "control-paint.json"), JSON.stringify({ measured, exceptions }, null, 2) + "\n");
    }
    assert.equal(app.writes.some(write => write.path.startsWith("/api/collection/")), false);
    assert.equal(app.acquisitions, 0);
});
