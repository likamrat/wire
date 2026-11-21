import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { defaultConsent } from "../lib/assessment-contract.mjs";
import { fixture, exportCatalogFor, UNBOUND_FIXTURE_BOOTSTRAP, automaticScoreOffSummary, revealAnalyzeRecords, chooseTheme } from "./helpers.mjs";
import { selectAnalyzeRequest } from "./report-journey-helpers.mjs";

// No listener or real updater. Serve the normal built module and shell solely via intercepted requests.
const origin = "http://127.0.0.1:48197", capability = "c".repeat(64);
const old = "1".repeat(40), next = "2".repeat(40);
const originalRuntime = UNBOUND_FIXTURE_BOOTSTRAP.runtimeId, replacement = "00000000-0000-4000-8000-000000000002";
async function workspace(t, { renderer = "react", automatic = false, supported = true, manual = !supported, pending, open = "/settings" } = {}) {
    const assets = await loadBrowserAssets({ renderer }), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(6000);
    const actions = [], releases = [], errors = [], healthReads = [], pages = [];
    const state = { supported, automatic, installed: old, candidate: next, lastChecked: manual ? null : Date.UTC(2026, 10, 20, 20, 45), dismissed: null,
        phase: manual ? "manual" : "available", message: manual ? "This copy is managed manually." : "A newer build is available." };
    const setup = { entry: assets.entry, runtimeId: originalRuntime, capability, health: { service: "workiq-evidence", protocol: 1, runtimeId: originalRuntime, build: old, clientEntry: assets.entry },
        apply: route => route.fulfill({ status: 409, json: { error: "Close the other WIRE panel first." } }) };
    const records = [{ ...fixture("app-update"), capturedAt: new Date().toISOString() }];
    const basis = { sourceRevision: 1, membershipRevision: 1, consentRevision: 0, overrideRevision: 0, deletionEpoch: 0 };
    const assessment = { schemaVersion: 1, basis, catalog: [], overview: { interactionRefs: [], metrics: [] }, consent: defaultConsent(),
        source: { available: true, sourceConfigRef: "config-" + "1".repeat(32), sourceConfigRevision: 1 }, capabilities: { answer: true } };
    const collection = { revision: 1, configVersion: 1, state: "paused", connected: true,
        config: { approved: true, enabled: false, appDbPath: "invented.db", sessionRoot: "invented", windowDays: 7, pollSeconds: 5 }, metrics: {},
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 }, historyIssues: [] };
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    if (pending) await page.addInitScript(key => sessionStorage.setItem(key, "pending"), pending);
    await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        assert.equal(url.origin, origin);
        const path = url.pathname;
        if (path === "/favicon.svg") return route.fulfill({ contentType: "image/svg+xml",
            body: await readFile(new URL("../assets/wire-icon.svg", import.meta.url)) });
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            pages.push(setup.entry);
            return route.fulfill({ contentType: "text/html", body: renderHtmlShell(setup.capability, "updates", { ...UNBOUND_FIXTURE_BOOTSTRAP, runtimeId: setup.runtimeId },
                { ...assets, entry: setup.entry }) });
        }
        if (path.startsWith("/assets/client/")) {
            const file = assets.get(path) || path === setup.health.clientEntry && assets.get(assets.entry);
            return file ? route.fulfill({ contentType: file.type, body: file.bytes }) : route.fulfill({ status: 404 });
        }
        if (path === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript",
            body: await readFile(new URL("../lib/assessment-contract.mjs", import.meta.url)) });
        if (path === "/health") { healthReads.push(setup.health.build); return route.fulfill({ json: setup.health }); }
        const input = request.postDataJSON() || {};
        if (path === "/api/app-update/release-panel") {
            assert.equal(request.method(), "POST"); assert.deepEqual(input, {});
            releases.push(request.headers()["x-board-capability"]); return route.fulfill({ json: { released: true } });
        }
        if (path === "/api/app-update") {
            assert.equal(request.method(), "POST"); assert.equal(request.headers()["x-board-capability"], setup.capability);
            actions.push(input);
            if (input.action === "status" && setup.status) return setup.status(route);
            if (input.action === "preferences") state.automatic = input.enabled;
            if (input.action === "dismiss") state.dismissed = input.candidate;
            if (input.action === "apply") return setup.apply(route);
            return route.fulfill({ json: state });
        }
        if (path === "/api/snapshot") return route.fulfill({ json: { revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection, assessment,
            exportCatalog: exportCatalogFor(records), requestActivity: buildRequestActivity(records), analytics: { ...buildActivityAnalytics(records, input), revision: 1 } } });
        if (path === "/api/collection/status") return route.fulfill({ json: collection });
        if (path === "/api/assessment/consent") return route.fulfill({ json: { schemaVersion: 1, basis, data: { consent: assessment.consent, source: assessment.source, capabilities: assessment.capabilities } } });
        if (path === "/api/evaluation/automatic/summary") return route.fulfill({ json: automaticScoreOffSummary() });
        return route.fulfill({ status: 404, json: { error: "Not served by this offline fixture." } });
    });
    await page.goto(origin + open);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => actions.length).toBeGreaterThan(0);
    return { page, state, setup, actions, releases, healthReads, pages };
}

test("React Settings checks, opts in and out, dismisses only this build, and schedules checks without applying", async t => {
    const { page, state, actions } = await workspace(t);
    const auto = page.getByRole("switch", { name: "Automatically check for updates" });
    await expect(auto).not.toBeChecked(); assert.deepEqual(actions, [{ action: "status" }]);
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.locator("#appUpdateDismiss").click();
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    await page.reload(); await expect(auto).toBeEnabled(); await expect(page.locator("#settingsAppUpdate")).toBeVisible();
    await auto.focus(); await page.keyboard.press("Space"); await expect(auto).toBeChecked();
    await page.clock.install();
    await page.reload(); await expect.poll(() => actions.at(-1).action).toBe("auto-check");
    await expect(auto).toBeEnabled();
    state.candidate = "3".repeat(40);
    await page.clock.fastForward("24:00:00");
    await expect(page.locator("#appUpdateApply")).toBeVisible();
    await auto.uncheck(); await expect(auto).toBeEnabled();
    await page.clock.fastForward("24:00:00");
    assert.deepEqual(actions, ["status", "check", { action: "dismiss", candidate: next }, "status", { action: "preferences", enabled: true },
        "status", "auto-check", "auto-check", { action: "preferences", enabled: false }].map(a => typeof a === "string" ? { action: a } : a));
});

test("General owns the update card, legacy links and searchable controls without triggering an update", async t => {
    const { page, actions } = await workspace(t);
    const general = page.locator("#settingsCategoryNav [data-category=general]");
    await expect(general).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#settingsCategoryNav [data-category=updates]")).toHaveCount(0);
    await expect(page.locator("#generalTitle")).toBeVisible();
    const check = page.getByRole("button", { name: "Check for updates" });
    await expect(check).toBeVisible();
    await expect(page.locator("#appUpdateVersion")).toContainText(old.slice(0, 8));
    await expect(page.locator("#appUpdateStatus")).toContainText("Last checked");
    await expect.poll(() => page.locator(".app-version-card img").evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator("#settingsCategoryNav [data-category=themes]").click();
    await page.locator("#settingsSearch").fill("Check for WIRE updates");
    const result = page.locator('#settingsSearchResults [data-setting="app-update"]');
    await expect(page.locator(".settings-search-heading")).toContainText("General");
    await result.focus(); await page.keyboard.press("Enter");
    await expect(check).toBeFocused();
    await expect(page).toHaveURL(/section=general&setting=app-update/);
    await page.goBack();
    await expect(result).toBeFocused();
    await expect(page.locator("#settingsSearch")).toHaveValue("Check for WIRE updates");
    await page.goto(origin + "/settings?section=updates&setting=automatic-updates");
    await expect(page.locator("#generalTitle")).toBeVisible();
    await expect(general).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/section=general&setting=automatic-updates/);
    assert.ok(actions.every(({ action }) => action === "status"));
});

test("unsupported bundled runtime reads status only, even if a saved automatic preference is on", async t => {
    const { page, actions } = await workspace(t, { renderer: "bundled", automatic: true, supported: false });
    await expect(page.locator("#appUpdateStatus")).toHaveText(/manually/);
    await expect(page.locator("#appUpdateManual")).toContainText("README");
    await expect(page.locator("#settingsAppUpdate")).toBeHidden(); await expect(page.locator("#appUpdateApply")).toBeHidden();
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#appUpdateNotice")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("a managed launcher reporting manual-only shows instructions and never schedules or offers installation", async t => {
    const { page, actions } = await workspace(t, { automatic: true, manual: true });
    await expect(page.locator("#appUpdateManual")).toBeVisible();
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#settingsAppUpdate")).toBeHidden();
    await expect(page.locator("#appUpdateApply")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("the Update action stays green and accessible in dark and narrow light Settings", async t => {
    const { page } = await workspace(t);
    for (const [theme, width] of [["dark", 1280], ["light", 390]]) {
        await page.setViewportSize({ width, height: 900 });
        await chooseTheme(page, theme);
        await page.waitForFunction(() => !document.getAnimations().some(animation =>
            animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
        await expect(page.locator("#appUpdateApply")).toBeVisible();
        const paint = await page.locator("#appUpdateApply").evaluate(node => {
            const color = getComputedStyle(node, "::before").backgroundColor;
            return { rgb: color.match(/\d+/g)?.map(Number), overflow: document.documentElement.scrollWidth > innerWidth,
                height: node.getBoundingClientRect().height };
        });
        assert.ok(paint.rgb && paint.rgb[1] > paint.rgb[0] && paint.rgb[1] > paint.rgb[2], `${theme}: ${paint.rgb}`);
        assert.ok(paint.height >= 44);
        assert.equal(paint.overflow, false);
        if (process.env.WIRE_APP_UPDATE_PROOFS) {
            await mkdir(process.env.WIRE_APP_UPDATE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_APP_UPDATE_PROOFS, `${theme}-${width}.png`) });
        }
    }
});

test("unfinished settings and report selection block activation from the normal React shell", async t => {
    const { page, actions, releases } = await workspace(t);
    const apply = page.locator("#appUpdateApply");
    await page.locator('#settingsCategoryNav [data-category="source-access"]').click();
    await page.locator("#reviewSource,#editSource").filter({ visible: true }).first().click();
    await apply.click();
    await expect(page.locator("#appUpdateDetail")).toContainText("Settings changes");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    assert.deepEqual(actions, [{ action: "status" }]); assert.deepEqual(releases, []);
    await page.reload();
    await page.locator('a[data-nav="analyze"]:visible').last().click();
    await revealAnalyzeRecords(page);
    await selectAnalyzeRequest(page, page.locator("#activityList .activity-card").first());
    await apply.click(); await expect(page.locator("#appUpdateDetail")).toContainText("report draft");
    assert.ok(!actions.some(a => a.action === "apply"));
});

test("a retained uncertain operation blocks activation even outside its Settings section", async t => {
    const { page, actions } = await workspace(t, { pending: "workiq-evidence.source-check.v1" });
    await page.locator("#appUpdateApply").click();
    await expect(page.locator("#appUpdateDetail")).toContainText("original result");
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("a clean managed tab retains its capability for bfcache and releases only its original page on departure", async t => {
    const { page, releases, actions } = await workspace(t);
    await expect(page.locator("#appUpdateAuto")).toBeEnabled();
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect.poll(() => actions.length).toBe(2);
    await expect(page.locator("#appUpdateAuto")).toBeEnabled(); assert.deepEqual(releases, []);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await expect.poll(() => releases).toEqual([capability]);
});

test("single activation stays fenced through transport loss until the authenticated status, runtime, health and executed target asset agree", async t => {
    const { page, actions, setup, state, pages, healthReads } = await workspace(t);
    const apply = page.locator("#appUpdateApply"), modal = page.locator("#appUpdateFence");
    await apply.click(); await expect(page.locator("#appUpdateDetail")).toHaveText("Close the other WIRE panel first.");
    const hold = Promise.withResolvers();
    setup.apply = async route => { await hold.promise; await route.abort("connectionreset"); };
    await apply.click(); await expect(modal).toBeVisible();
    await page.evaluate(() => {
        document.getElementById("settingsAppUpdate").click();
        document.querySelector('[data-category="themes"]').click();
        document.getElementById("appUpdateAuto").click();
    });
    await page.keyboard.press("Escape"); await expect(modal).toBeVisible();
    hold.resolve(); await expect.poll(() => healthReads.length).toBeGreaterThan(0);
    assert.equal(pages.length, 1); await expect(modal).toBeVisible();
    setup.health = { ...setup.health, build: next, runtimeId: replacement, clientEntry: "/assets/client/newbuild-12345678.js" };
    await expect(page.locator("#appUpdateProgress")).toContainText("runtime identity", { timeout: 12000 });
    await expect(modal).toBeVisible();
    setup.capability = "d".repeat(64); setup.runtimeId = replacement;
    // The shell still names the stale entry: an available JS file is not loaded-client proof.
    await page.reload();
    await expect(page.locator("#appUpdateProgress")).toContainText("different browser build", { timeout: 12000 });
    await expect(modal).toBeVisible();
    setup.entry = setup.health.clientEntry;
    setup.status = route => route.fulfill({ status: 403, json: { code: "session_expired", error: "Page permission expired." } });
    await page.reload();
    await expect(page.locator("#appUpdateProgress")).toContainText("could not verify");
    await expect(modal).toBeVisible(); await expect(page.locator("#appUpdateHeading")).not.toHaveText("WIRE updated");
    setup.status = route => route.abort("connectionreset");
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateProgress")).toContainText("could not verify"); await expect(modal).toBeVisible();
    setup.status = null; state.phase = "current"; state.clientEntry = setup.entry;
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateProgress")).toContainText("does not confirm"); await expect(modal).toBeVisible();
    state.installed = next; state.clientEntry = "/assets/client/wrong-12345678.js";
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateProgress")).toContainText("does not confirm"); await expect(modal).toBeVisible();
    state.clientEntry = setup.entry;
    await page.locator("#appUpdateRecover").click(); await expect(page.locator("#appUpdateHeading")).toHaveText("WIRE updated");
    await expect(modal).not.toBeVisible();
    assert.deepEqual(actions.filter(a => a.action === "apply"), [{ action: "apply", candidate: next }, { action: "apply", candidate: next }]);
    assert.equal(actions.filter(a => a.action === "preferences").length, 0);
});

test("expired original permission on bfcache restore cannot release an unverified page interlock", async t => {
    const { page, setup, actions, releases } = await workspace(t);
    await expect(page.locator("#appUpdateAuto")).toBeEnabled();
    setup.status = route => route.fulfill({ status: 403, json: { code: "session_expired", error: "Page permission expired." } });
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("#appUpdateStatus")).toHaveText("Page permission expired.");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    assert.deepEqual(releases, []); assert.deepEqual(actions, [{ action: "status" }, { action: "status" }]);
});

test("a suspended draft is not certified clean by later status or by a reset of the visible editor", async t => {
    const { page, releases, actions } = await workspace(t);
    await page.locator('#settingsCategoryNav [data-category="source-access"]').click();
    await page.locator("#editSource").click();
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect.poll(() => actions.length).toBe(2);
    await page.locator("#cancelSource").click();
    await page.locator("#appUpdateApply").click();
    await expect(page.locator("#appUpdateDetail")).toContainText("unfinished work when it was suspended");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    assert.deepEqual(releases, []); assert.ok(!actions.some(a => a.action === "apply"));
});
