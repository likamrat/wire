import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { createNativeRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture } from "./helpers.mjs";
import { metadata174Schema } from "./copilot-metadata-fixture.mjs";
import { chatFixture, coworkFixture } from "./native-read-model-fixtures.mjs";

test("ordinary app consolidates real stopped collection, healthy recovery and global pause notices",
    { timeout: 45000 }, async t => {
        const cleanup = [], { root, context } = await privateFixture({ after: work => cleanup.push(work) }, []);
        let lifecycle, persistence, access, runtime, browser;
        const errors = [], external = [], browserWrites = [];
        t.after(async () => {
            await browser?.close();
            await runtime?.close();
            access?.close();
            persistence?.close();
            await lifecycle?.close();
            for (const work of cleanup.reverse()) await work();
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            assert.deepEqual(browserWrites, ["/api/collection/now"]);
        });
        const appDbPath = path.join(root, "data.db"), sessionRoot = path.join(root, "session-state");
        const db = new DatabaseSync(appDbPath);
        try { db.exec(metadata174Schema); } finally { db.close(); }
        await mkdir(sessionRoot);
        await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
        await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify({
            schemaVersion: 1, approved: true, enabled: true, windowDays: 30, pollSeconds: 5, appDbPath, sessionRoot,
        }));

        const records = [...chatFixture(), ...coworkFixture()], account = records[0].scope.account;
        const firstCapture = Promise.withResolvers();
        let acquisitions = 0, opens = 0, failCompletion = true;
        const transport = createMicrosoftNativeReadTransport({
            async open() { opens++; },
            async verifyAccount() {
                return { tenantId: account.tenantId, subjectId: account.subjectId, knownAccountMatched: true,
                    chat: true, cowork: true, evidence: { kind: "native-account-metadata",
                        issuer: "https://example.invalid", observedAt: new Date().toISOString() } };
            },
            async stop() { return { processExited: true, profileReleased: true }; },
        });
        lifecycle = await createMicrosoftSession(context, { transport, sourceAware: true, globalCollection: null,
            collection: { paused: true, windowDays: 30 },
            persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
        persistence = await createNativePersistence(context, {
            lifecycle, transport, preAccount: "metadata-only", configurationIntents: true,
        });
        access = await createNativeRuntimeAccess(context, { lifecycle, nativePersistence: persistence,
            sourceAware: true, nativeConnection: true, nativeAcquisition: true, nativeScheduling: true,
            async acquireNative(lease) {
                await lifecycle.assertLease(lease);
                acquisitions++;
                const rows = structuredClone(records);
                for (const row of rows) row.capture.generation = lease.generation;
                return rows;
            },
            completeNative(_ticket, receipt) {
                assert.equal(receipt?.status, "committed");
                firstCapture.resolve(receipt);
                if (failCompletion) throw Object.assign(new Error("Invented completion failure."), {
                    code: "NATIVE_CAPTURE_COMPLETION_FAILED",
                });
            },
        });
        runtime = await startServer(context, createExportController(context), {
            port: 0, access, collector: { timers: false },
        });
        const origin = new URL(runtime.url).origin;
        async function post(route, input, capability) {
            const response = await fetch(origin + route, { method: "POST", headers: {
                Origin: origin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
                ...(capability ? { "X-Board-Capability": capability } : {}),
            }, body: JSON.stringify(input) });
            const body = await response.json();
            assert.equal(response.status, 200, body.error);
            return body;
        }
        const session = await post("/api/session", {});
        for (const action of ["wire-sign-in", "microsoft-connect"]) await post("/api/access/command", {
            schemaVersion: 1, action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
        }, session.capability);
        const sources = () => post("/api/collection/sources/status", {}, session.capability);
        const offer = (await sources()).microsoft.configurationOffer;
        await post("/api/collection/microsoft/configure", {
            schemaVersion: 2, intent: offer.intent, generation: offer.generation,
            authorizationRevision: offer.authorizationRevision, globalRevision: offer.globalRevision,
            expectedRevision: offer.expectedRevision, surfaces: offer.values.surfaces, windowDays: offer.values.windowDays,
        }, session.capability);
        const original = await firstCapture.promise;
        await expect.poll(async () => (await sources()).microsoft.status.blockers)
            .toEqual(["NATIVE_RETENTION_AUTOMATIC_STOPPED"]);

        browser = await chromium.launch();
        const page = await browser.newPage({ reducedMotion: "reduce" });
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
            if (message.type() === "error" && /^Error: <[\w:-]+> attribute [\w:-]+:/i.test(message.text())) errors.push(message.text());
        });
        await page.route("**/*", route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
            if (/^\/api\/(?:access\/command|collection\/.*(?:configure|enabled|now)|preview|export)$/.test(url.pathname)) {
                browserWrites.push(url.pathname); return route.abort();
            }
            return route.continue();
        });
        await page.goto(runtime.url + "#analyze");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#collectionNoticeText")).toHaveText(
            "Automatic Microsoft collection stopped after an error. Start a new collection in Settings.");
        await expect(page.locator("#collectionNotice a")).toHaveAttribute("href",
            "#settings?section=connection&setting=microsoft-collection");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        assert.equal(acquisitions, 1);
        assert.equal(opens, 1);

        failCompletion = false;
        const recoveryId = randomUUID();
        await post("/api/collection/microsoft/now", { operationId: recoveryId }, session.capability);
        assert.deepEqual((await sources()).microsoft.status.blockers, []);
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#collectionNotice")).toBeHidden();
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        assert.equal(acquisitions, 2);
        assert.equal(opens, 1);
        const receipts = (await loadBoardState(context)).nativeRetention.receipts;
        assert.equal(receipts.filter(receipt => receipt.operationId === original.operationId).length, 1);
        assert.equal(receipts.find(receipt => receipt.operationId === recoveryId)?.status, "committed");

        const current = await sources();
        await post("/api/collection/global/enabled", {
            schemaVersion: 1, enabled: false, generation: current.generation,
            authorizationRevision: current.authorizationRevision, expectedRevision: current.global.revision,
        }, session.capability);
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#collectionNoticeText")).toHaveText("Collection is paused.");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        assert.equal(acquisitions, 2);
        assert.equal(opens, 1);
        assert.deepEqual(browserWrites, []);
        const preserved = await loadBoardState(context);
        let ordinaryChecks = 0;
        await page.route(origin + "/api/collection/now", async route => {
            ordinaryChecks++;
            browserWrites.push("/api/collection/now");
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort("connectionreset");
        });
        const refresh = page.locator("#analyzeRefresh");
        await expect(refresh).toBeEnabled();
        await refresh.click();
        const retry = page.getByRole("button", { name: "Retry reading saved activity", exact: true });
        await expect(retry).toBeVisible();
        await expect(page.locator("#freshAwayNotice")).toContainText("GitHub: result unconfirmed. Microsoft: not checked (paused).");
        await retry.click();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        assert.equal(ordinaryChecks, 1, "The toolbar Retry cannot replay the unknown GitHub check.");
        assert.equal(acquisitions, 2, "Global Pause withholds Microsoft acquisition while GitHub keeps its manual exception.");
        assert.equal(opens, 1);
        const afterRefresh = await loadBoardState(context);
        assert.deepEqual(afterRefresh.nativeRetention, preserved.nativeRetention);
        assert.deepEqual(afterRefresh.globalCollection, preserved.globalCollection);
    });
