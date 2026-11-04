import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, fixture, navigateMain, navigateSettings } from "./helpers.mjs";

for (const configured of [false, true]) test(`ordinary GitHub paging survives ${configured ? "configured but uncommitted" : "unenrolled"} Microsoft without widening reports`,
    { timeout: 45000 }, async t => {
        const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) },
            Array.from({ length: 9 }, (_, index) => fixture(`unavailable-paging-${index}`)));
        let providerCalls = 0, acquisitions = 0, persistence, runtime, browser;
        const transport = createMicrosoftNativeReadTransport({
            async open() { providerCalls++; },
            async verifyAccount() {
                providerCalls++;
                return { tenantId: "invented-paging-tenant", subjectId: "invented-paging-subject",
                    knownAccountMatched: true, chat: true, cowork: true, evidence: {
                        kind: "native-account-metadata", issuer: "https://example.invalid", observedAt: new Date().toISOString(),
                    } };
            },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        const lifecycle = await createMicrosoftSession(context, { transport, sourceAware: true, globalCollection: null,
            collection: { paused: true, windowDays: 30 },
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
        persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true });
        const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, nativeAcquisition: false,
            async acquireNative() { acquisitions++; throw new Error("No acquisition is allowed in this fixture."); } });
        const errors = [], writes = [];
        t.after(async () => {
            await browser?.close(); await runtime?.close(); access.close(); persistence.close(); await lifecycle.close();
            for (const action of cleanup.reverse()) await action();
            assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(acquisitions, 0);
            assert.equal(providerCalls, configured ? 2 : 0);
        });
        runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
        const origin = new URL(runtime.url).origin;
        async function post(route, input, capability) {
            const response = await fetch(origin + route, { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
            }, body: JSON.stringify(input) });
            const value = await response.json();
            assert.equal(response.status, 200, value.error);
            return value;
        }
        const session = await post("/api/session", {});
        await post("/api/access/command", { schemaVersion: 1, action: "wire-sign-in", operationId: randomUUID(),
            generation: (await lifecycle.status()).generation }, session.capability);
        if (configured) {
            await post("/api/access/command", { schemaVersion: 1, action: "microsoft-connect", operationId: randomUUID(),
                generation: (await lifecycle.status()).generation }, session.capability);
            const offer = (await post("/api/collection/sources/status", {}, session.capability)).microsoft.configurationOffer;
            await post("/api/collection/microsoft/configure", { schemaVersion: 2, intent: offer.intent,
                generation: offer.generation, authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
                expectedRevision: offer.expectedRevision, surfaces: offer.values.surfaces, windowDays: offer.values.windowDays }, session.capability);
        }
        const before = await loadBoardState(context);
        browser = await chromium.launch();
        const page = await browser.newPage({ reducedMotion: "reduce" });
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            if (/^\/api\/(?:access\/command|collection\/.*(?:configure|enabled|now)|preview|export)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
        });
        const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
        await page.goto(runtime.url + "#analyze");
        const snapshot = await (await read).json();
        assert.equal(snapshot.nativeRead.status, "unavailable");
        assert.equal(snapshot.nativeRead.reason, configured ? "native-retained-source-not-committed" : "microsoft-account-not-configured");
        assert.equal(snapshot.collection.sourceAware.microsoft.status.configured, configured);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#sourceFilter")).toHaveValue("all");
        if (!configured) {
            await expect(page.locator("#collectionNotice")).toBeVisible();
            await expect(page.locator("#collectionNoticeAction")).toBeVisible();
            await expect(page.locator("#boundedFilterNotice")).toBeHidden();
            await expect(page.locator("#boundedFilterNotice")).toBeEmpty();
        } else {
            await expect(page.locator("#boundedFilterNotice")).toBeVisible();
            await expect(page.locator("#boundedFilterNotice")).toHaveText("No saved Microsoft activity is available.");
        }
        if (process.env.WIRE_SETUP_COPY_PROOFS) {
            await mkdir(process.env.WIRE_SETUP_COPY_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_SETUP_COPY_PROOFS,
                configured ? "configured-missing-data.png" : "single-setup-entry.png"), fullPage: true });
        }
        const cards = page.locator("#activityList .activity-card"), pager = page.locator("#activityPager");
        await expect(cards).toHaveCount(8);
        const first = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey));
        const next = pager.getByRole("button", { name: "Next", exact: true });
        await expect(next).toBeEnabled();
        await expect(pager).toContainText("1-8 of 9 GitHub interactions");
        await expect(pager).toContainText("Microsoft total unavailable");
        await next.click();
        await expect(cards).toHaveCount(1);
        await expect(pager).toContainText("9-9 of 9 GitHub interactions");
        await expect(next).toBeDisabled();
        await expect(page.locator("#activityList .empty-state")).toHaveCount(0);
        await expect(pager).toContainText("Microsoft total unavailable");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: current totals unavailable");
        await expect(page.locator("#periodResult")).not.toContainText("Microsoft: 0");
        await expect(page.locator("#sourceFilter")).toHaveValue("all");
        await pager.getByRole("button", { name: "Previous", exact: true }).click();
        await expect(cards).toHaveCount(8);
        assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey)), first);
        await navigateMain(page, "reports");
        await page.getByRole("link", { name: "Create a report", exact: true }).click();
        for (const scope of ["current", "all"]) {
            await page.locator(`[name=reportScope][value=${scope}]`).check();
            const next = page.getByRole("button", { name: "Continue to contents", exact: true });
            if (configured) {
                await expect(next).toBeDisabled();
                await expect(page.locator("#scopeCount-" + scope)).not.toContainText("9 interactions");
            } else {
                await expect(next).toBeEnabled();
                await expect(page.locator("#scopeCount-" + scope)).toContainText("9 interactions");
            }
        }
        assert.deepEqual(await loadBoardState(context), before);
    });

test("normal client consumes the unavailable contract without granting collection or hiding Settings", { timeout: 45000 }, async t => {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, []);
    const forbidden = [];
    const transport = createMicrosoftNativeReadTransport({
        async open() { forbidden.push("provider-open"); throw new Error("Provider access is forbidden."); },
        async verifyAccount() { forbidden.push("provider-identity"); throw new Error("Provider access is forbidden."); },
        async stop() { return { processExited: true, profileReleased: true }; },
    });
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: true, windowDays: 30 } });
    const persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only" });
    const access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence, nativeConnection: true,
        async acquireNative() { forbidden.push("native-acquisition"); throw new Error("Source acquisition is forbidden."); } });
    let runtime, browser, page;
    const errors = [], mutations = [], unexpected = [], wireCommands = [];
    t.after(async () => {
        await page?.unrouteAll({ behavior: "wait" });
        await browser?.close(); await runtime?.close(); access.close(); persistence.close(); await lifecycle.close();
        for (const action of cleanup.reverse()) await action();
        assert.deepEqual(errors, []); assert.deepEqual(mutations, []); assert.deepEqual(unexpected, []);
        assert.deepEqual(forbidden, []);
    });
    const before = await loadBoardState(context);
    runtime = await startServer(context, createExportController(context), { port: 0, access, collector: { timers: false } });
    browser = await chromium.launch();
    page = await browser.newPage({ reducedMotion: "reduce" });
    const origin = new URL(runtime.url).origin;
    page.on("pageerror", error => errors.push(error.message));
    let omitStatus = false, snapshots = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/snapshot") snapshots++; });
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
        if (url.pathname === "/api/access/command" && request.postDataJSON().action === "wire-sign-in") {
            wireCommands.push(request.postDataJSON()); return route.continue();
        }
        if (/^\/api\/(?:access\/command|collection\/(?:now|configure|enabled))$/.test(url.pathname)) {
            mutations.push(url.pathname); return route.abort();
        }
        if (url.pathname === "/api/snapshot" && omitStatus) {
            const response = await route.fetch(), payload = await response.json();
            assert.equal(response.status(), 200);
            delete payload.collection.nativePersistence;
            return route.fulfill({ response, json: payload });
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#settings?section=connection");
    if (!await page.locator("#wireAccountTrigger").isVisible()) await page.locator("#navigationToggle").click();
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountGate")).toHaveText("Sign in to WIRE");
    const firstSnapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.locator("#wireAccountGate").click();
    const response = await firstSnapshot, snapshot = await response.json();
    assert.equal(response.status(), 200);
    assert.deepEqual(Object.keys(snapshot.nativeRead).sort(), ["authorizationRevision", "generation", "reason", "revision", "status"]);
    assert.equal(snapshot.nativeRead.status, "unavailable");
    assert.equal(snapshot.collection.nativePersistence.kind, "native-account-unavailable");
    assert.equal(snapshot.scenarios.some(record => record.recordKind === "native-conversation"), false);
    assert.equal(Object.hasOwn(snapshot.coverage, "native"), false);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).not.toContainText("could not load");
    await expect(page.locator("#wireMicrosoftAction")).toBeVisible();
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    await expect(page.locator("#wireMicrosoftAction")).toHaveText("Connect Microsoft 365");
    await expect(page.locator("#collectionStatus")).toHaveText("Microsoft account not connected");
    await expect(page.locator("#checkActivity")).toBeHidden();
    await expect(page.locator("#freshStatus")).not.toHaveText("Microsoft collection completed.");
    const initialSnapshots = snapshots;
    await navigateMain(page, "analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#message")).not.toContainText("could not load");
    assert.equal(snapshots, initialSnapshots, "Same-query sidebar navigation reuses accepted unavailable metadata.");
    await navigateMain(page, "settings");
    await navigateSettings(page, "connection");
    await page.reload();
    await expect(page.locator("#collectionStatus")).toHaveText("Microsoft account not connected");
    await expect(page.locator("#wireMicrosoftAction")).toBeVisible();
    await expect(page.locator("#wireMicrosoftAction")).toBeEnabled();
    omitStatus = true;
    await page.reload();
    await expect(page.locator("#message")).toContainText("Microsoft account setup status changed");
    assert.equal(wireCommands.length, 1);
    assert.deepEqual(await loadBoardState(context), before);
});
