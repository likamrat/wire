import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption, navigateMain, fixture, privateFixture } from "./helpers.mjs";
import { chatFixture, coworkFixture, absent } from "./native-read-model-fixtures.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { savedNativeReportFixture } from "./native-report-controller-fixture.mjs";
import { nativeConversationIdentity } from "../lib/native-read-model.mjs";
import { openReportLibrary, prepareReportPreview } from "./report-journey-helpers.mjs";

for (const { segmented, incompleteText = false } of [{ segmented: false }, { segmented: true }, { segmented: true, incompleteText: true }]) test(incompleteText
    ? "incomplete Microsoft text keeps Search unavailable with readable recovery and diagnostic identity"
    : segmented ? "compiled v2 Analyze binds the refined group and Search to Current report without acquiring"
    : "v1 saved report keeps deletion explicit as the stored view advances",
    { timeout: 90000 }, async t => {
        const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [fixture("bounded-native-github")]);
        const envelopes = [...chatFixture(), ...coworkFixture()], account = envelopes[0].scope.account;
        if (incompleteText) envelopes[0].qualifiedFields.message = absent("field-absent-from-read-response");
        let persistence, access, runtime, browser, acquisitions = 0;
        const transport = createMicrosoftNativeReadTransport({
            async open() {},
            async verifyAccount() { return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
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
        persistence = await createNativePersistence(context, { lifecycle, transport, preAccount: "metadata-only", configurationIntents: true });
        access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, nativeAcquisition: false,
            async acquireNative() { acquisitions++; throw new Error("No acquisition is permitted in bounded UI qualification."); } });
        runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
        const origin = new URL(runtime.url).origin;
        async function post(route, input, capability) {
            const response = await fetch(origin + route, { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1", ...(capability ? { "X-Board-Capability": capability } : {}),
            }, body: JSON.stringify(input) });
            const body = await response.json();
            assert.equal(response.status, 200, body.error);
            return body;
        }
        const setup = await post("/api/session", {});
        for (const action of ["wire-sign-in", "microsoft-connect"]) await post("/api/access/command", {
            schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
        }, setup.capability);
        const offer = (await post("/api/collection/sources/status", {}, setup.capability)).microsoft.configurationOffer;
        await post("/api/collection/microsoft/configure", {
            schemaVersion: 2, intent: offer.intent, generation: offer.generation, authorizationRevision: offer.authorizationRevision,
            globalRevision: offer.globalRevision, expectedRevision: offer.expectedRevision,
            surfaces: offer.values.surfaces, windowDays: offer.values.windowDays,
        }, setup.capability);
        // Existing fixture producer seeds the retained store; the runtime acquisition path stays withheld.
        const admission = { owner: "bounded-ui-existing-fixture", check() {}, dispatched() {} };
        const pending = await (segmented ? persistence.beginSegmented : persistence.begin)({ operationId: randomUUID() }, admission);
        await (segmented ? persistence.commitSegmented : persistence.commit)(pending.ticket, envelopes);
        await persistence.retire(pending.ticket);
        const saved = segmented ? null : await savedNativeReportFixture({ context, persistence, services: {
            nativeReportAdmission: admission, nativeRecords: [...new Set(envelopes.map(record => nativeConversationIdentity(record.scope)))]
                .map(scenarioId => ({ scenarioId })),
        } });
        const handshake = await post("/api/session", {});
        assert.equal(handshake.accessBootstrap.collectionMode, "source-aware");
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], writes = [], previews = [], groups = [], analyses = [], eligibilityReads = [], deletionPreviews = [], artifactWrites = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
        });
        page.on("response", response => {
            if (new URL(response.url()).pathname === "/api/retained/microsoft/drilldown" && response.ok()) {
                void response.json().then(value => groups.push(value));
            }
            if (new URL(response.url()).pathname === "/api/retained/microsoft/analyze" && response.ok()) {
                void response.json().then(value => analyses.push({ value, input: response.request().postDataJSON() }));
            }
        });
        page.on("request", request => {
            const pathname = new URL(request.url()).pathname;
            if (/^\/api\/collection\/.*(?:configure|enabled|now)$/.test(pathname)) writes.push(pathname);
            if (pathname === "/api/preview") previews.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/eligibility") eligibilityReads.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/preview") deletionPreviews.push(request.postDataJSON());
            if (pathname === "/api/artifact-deletion/confirm") artifactWrites.push(request.postDataJSON());
        });
        await page.goto(origin + "/");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(3);
        if (incompleteText) {
            const failure = page.waitForResponse(response => response.url().endsWith("/api/retained/microsoft/analyze"));
            await page.locator("#wireSearch").fill("invented");
            await selectActivityOption(page, "wireSearchScope", "analysis");
            const response = await failure, diagnostic = await response.json();
            assert.equal(response.status(), 428);
            assert.equal(diagnostic.code, "NATIVE_VIEW_TEXT_COVERAGE_UNAVAILABLE");
            const explanation = "Some saved Microsoft text is unavailable. Search cannot verify all matching activity.";
            assert.equal(diagnostic.error, explanation);
            await expect(page.locator("#wireNativeSearch .notice")).toHaveText(explanation);
            await expect(page.locator("#wireNativeSearch")).not.toContainText(diagnostic.code);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: current totals unavailable");
            await expect(page.locator("#periodResult")).not.toContainText("Microsoft: 0");
            const retry = page.waitForResponse(value => value.url().endsWith("/api/retained/microsoft/analyze"));
            await page.getByRole("button", { name: "Retry Microsoft Analyze Search", exact: true }).click();
            const retried = await retry;
            assert.equal(retried.status(), 428);
            assert.deepEqual(retried.request().postDataJSON(), response.request().postDataJSON(), "Retry preserves the original analytical scope.");
            assert.equal((await retried.json()).code, diagnostic.code);
            await expect(page.locator("#wireNativeSearch .notice")).toHaveText(explanation);
            assert.equal(acquisitions, 0);
            assert.deepEqual(writes, []);
            assert.deepEqual(errors, []);
            return;
        }
        if (segmented) {
            await page.locator("#wireSearch").fill("");
            await selectActivityOption(page, "sourceFilter", "microsoft-365-cowork"); await closeAnalyzeFilters(page);
            await openAnalyzeFilters(page);
            await page.locator("#toolFilter-control").click();
            await expect.poll(() => page.locator("#toolFilter option[data-native-inventory=true]").count()).toBe(3);
            await page.locator('.select-popup [data-value="mcp__graph__CallGraph"]').click(); await closeAnalyzeFilters(page);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
            await openAnalyzeFilters(page);
            await page.locator('[data-chart="workload"]').click(); await closeAnalyzeFilters(page);
            const group = page.locator("#chart a.flat-comparison-action").first();
            await expect(group).toHaveAttribute("href", /privateView=required/);
            await group.click();
            await expect(page.locator('[aria-label="Remove Microsoft group restriction"]')).toHaveCount(1);
            assert.doesNotMatch(page.url(), /nativeGroup=|[a-f0-9]{64}/);
            await selectActivityOption(page, "toolFilter", "all"); await closeAnalyzeFilters(page);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
            await expect(page.locator('[aria-label="Remove Microsoft group restriction"]')).toHaveCount(1);
            const originalGroup = groups.at(-1);
            assert.ok(originalGroup?.viewId);
            await page.locator("#wireSearch").fill("CallGraph");
            await page.locator("#wireSearchScope-control").click();
            await page.locator('.select-popup [data-value="analysis"]').click();
            await expect.poll(() => analyses.length).toBeGreaterThan(0);
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
            await expect(page.locator("#wireNativeSearch")).toContainText("1 matching native tool calls");
            const baseView = analyses.at(-1).input.viewId;
            assert.equal(baseView, originalGroup.viewId);
            await page.locator("#wireSearch").fill("Read");
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 3 native tool calls");
            await expect(page.locator("#wireNativeSearch")).toContainText("3 matching native tool calls");
            assert.equal(analyses.at(-1).input.viewId, baseView, "Typed replacements keep the unrefined original base.");
            await page.locator("#wireSearch").fill("CallGraph");
            await expect(page.locator("#periodResult")).toContainText("Microsoft: 1 native tool calls");
            await page.locator("#wireSearch").press("Escape");
            await navigateMain(page, "reports");
            await page.locator("#reportDeskActivity").click();
            const picker = page.getByRole("dialog", { name: "Choose activity" });
            await picker.getByRole("radio", { name: /^Current Analyze view/ }).check();
            await picker.getByRole("button", { name: "Use activity", exact: true }).click();
            const analysisView = analyses.at(-1).value.viewId;
            await prepareReportPreview(page);
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
            assert.equal(previews.at(-1).nativeViewId, analysisView);
            await navigateMain(page, "analyze");
        }
        await page.goto(origin + "/settings?section=connection");
        await expect(page.locator("#collectMicrosoftActivity")).toBeDisabled();
        await expect(page.locator("#sourceMicrosoftStatus")).toHaveText("Unavailable");
        await expect(page.locator("#globalCollectionStatus")).toHaveText("Source settings apply");
        if (saved) {
            await navigateMain(page, "reports");
            await page.reload();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await openReportLibrary(page);
            await page.locator(`[data-view-key="inspect-bundle:${saved.bundle.bundleId}"]`).click();
            const remove = page.locator("#contextSidebar").getByRole("button", { name: "Delete report", exact: true });
            await expect(remove).toBeEnabled();
            assert.deepEqual(eligibilityReads, []);
            assert.deepEqual(deletionPreviews, []);
            await expect(page.locator("#deleteAllReports")).toBeDisabled();
            let releaseSnapshot, snapshotHeld = false, hold = true;
            const resumed = new Promise(resolve => { releaseSnapshot = resolve; });
            t.after(() => releaseSnapshot());
            await page.route("**/api/snapshot", async route => {
                if (!hold) return route.continue();
                hold = false;
                const response = await route.fetch();
                snapshotHeld = true;
                await resumed;
                await route.fulfill({ response });
            });
            await updateBoardState(context, state => { state.continuation = "Existing fixture revision changed."; });
            await expect.poll(() => snapshotHeld, { timeout: 15000 }).toBe(true);
            try {
                await expect(remove).toBeEnabled();
                assert.deepEqual(deletionPreviews, [], "A background stored read does not prepare deletion.");
            }
            finally { releaseSnapshot(); }
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await expect(page.locator("#message")).not.toContainText("Activity paging requires");
            assert.deepEqual(deletionPreviews, []);
            await expect(page.getByRole("button", { name: "Check Delete availability", exact: true })).toHaveCount(0);
            await expect(remove).toBeEnabled();
            await remove.click();
            const deletion = page.locator('dialog[aria-labelledby="savedArtifactDeleteTitle"]');
            await expect(deletion).toHaveAttribute("data-decision-phase", "confirm");
            assert.equal(deletionPreviews.at(-1).artifactKind, "report");
            assert.equal(deletionPreviews.at(-1).artifactId, saved.bundle.bundleId);
            await expect(deletion).toContainText("Collected activity");
            await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect(remove).toBeFocused();
            await page.route("**/api/artifact-deletion/preview", async route => {
                const response = await route.fetch();
                await route.fulfill({ response, status: 403,
                    json: { error: "Artifact access unavailable", code: "NATIVE_ARTIFACT_MUTATION_UNAVAILABLE" } });
            });
            await remove.click();
            await expect(deletion).toHaveAttribute("data-decision-phase", "error");
            await expect(deletion).toContainText("Artifact access unavailable");
            await expect(deletion.getByRole("button", { name: "Delete report", exact: true })).toBeHidden();
            assert.deepEqual(eligibilityReads, []);
            assert.deepEqual(artifactWrites, []);
            assert.ok((await loadBoardState(context)).exports.some(item => item.bundleId === saved.bundle.bundleId));
        }
        assert.equal(acquisitions, 0);
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
    });
