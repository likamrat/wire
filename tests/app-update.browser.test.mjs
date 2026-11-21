import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { defaultConsent } from "../lib/assessment-contract.mjs";
import { fixture, privateFixture, exportCatalogFor, UNBOUND_FIXTURE_BOOTSTRAP, automaticScoreOffSummary, revealAnalyzeRecords, chooseTheme, selectActivityOption } from "./helpers.mjs";
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
    const state = { supported, automatic, installed: supported ? old : null, ...(supported ? {} : { packageVersion: "1.0.0" }),
        candidate: manual ? null : next, lastChecked: manual ? null : Date.UTC(2026, 10, 20, 20, 45), dismissed: null,
        phase: manual ? "manual" : "available", message: manual ? "Updates are managed manually." : "A newer build is available." };
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
    await expect(page.locator(".app-version-card .settings-row-copy")).toHaveText(/^\s*WIRE · Package version 1\.0\.0\s*Updates are managed manually\.\s*$/);
    await expect(page.locator("#appUpdateVersion")).toHaveText(/Package version 1\.0\.0/);
    await expect(page.locator("#appUpdateAutoHelp")).toBeHidden();
    await expect(page.locator("#appUpdateCheck")).toBeDisabled();
    await expect(page.locator("#appUpdateAuto")).not.toBeChecked();
    await expect(page.locator("#appUpdateAuto")).toHaveAccessibleDescription("Updates are managed manually.");
    await expect(page.locator("#settingsAppUpdate")).toBeHidden(); await expect(page.locator("#appUpdateApply")).toBeHidden();
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#appUpdateNotice")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("General preference rows open canonical pages and return to updated values", async t => {
    const { page, actions } = await workspace(t, { supported: false });
    const current = page.getByRole("link", { name: "Change theme" }), zone = page.getByRole("link", { name: /Time zone.*Regional/ });
    const preview = current.locator(".palette-scene");
    await expect(preview).toBeVisible();
    const painted = node => [node, node.querySelector(".palette-rail"), node.querySelector(".palette-strip i")].map(n => getComputedStyle(n).backgroundColor);
    const initialPaint = await preview.evaluate(painted);
    const back = page.getByRole("button", { name: "Back to General" });
    await current.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#themesTitle")).toBeFocused();
    await expect(page).toHaveURL(/\/settings\?section=themes$/);
    await chooseTheme(page, "dark"); await page.locator("label:has(#palette-field)").click();
    const selectedPaint = await page.locator("label:has(#palette-field) .palette-scene:visible").evaluate(painted);
    await back.click(); await expect(current).toBeFocused(); await expect(current).toHaveAccessibleDescription("Field notes Dark");
    assert.deepEqual(await preview.evaluate(painted), selectedPaint);
    assert.notDeepEqual(selectedPaint, initialPaint);
    await page.goForward(); await expect(back).toBeVisible();
    await page.locator("#settingsCategoryNav [data-category=general]").click();
    await expect(zone).toContainText("Device default");
    await zone.click(); await expect(page.locator("#regionalTitle")).toBeFocused();
    await selectActivityOption(page, "displayTimeZone", "Asia/Tokyo");
    await page.goBack(); await expect(zone).toBeFocused(); await expect(zone).toContainText("Tokyo");
    await expect(zone).not.toContainText("Device default");
    if (process.env.WIRE_SETTINGS_GENERAL_PROOFS) {
        await mkdir(process.env.WIRE_SETTINGS_GENERAL_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_SETTINGS_GENERAL_PROOFS, "general-after-return.png") });
    }
    await page.goBack(); await expect(back).toBeVisible();
    await back.click(); await expect(current).toBeFocused();
    await page.goto(origin + "/settings?section=themes"); await expect(page.locator("#themesTitle")).toBeVisible();
    await expect(back).toBeHidden();
    assert.ok(actions.every(({ action }) => action === "status"));
});

test("General shortcut hover highlights only the destination and keeps its chevron centered", async t => {
    const { page } = await workspace(t, { supported: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const id of ["general-regional", "general-themes"]) {
        const row = page.locator("#" + id), destination = row.locator(".preference-destination");
        await row.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        const resting = await destination.boundingBox();
        // Hover the description, not the trailing action: the whole row is still a link.
        await row.hover({ position: { x: 5, y: 10 } });
        const paint = await row.evaluate(n => {
            const d = n.querySelector(".preference-destination"), icon = d.querySelector("svg");
            const rect = n.getBoundingClientRect(), arrow = icon.getBoundingClientRect(), face = d.getBoundingClientRect();
            return { hovered: n.matches(":hover"), row: getComputedStyle(n).backgroundColor, face: getComputedStyle(d).backgroundColor,
                arrowOffset: (arrow.top + arrow.bottom - rect.top - rect.bottom) / 2,
                endInset: face.right - arrow.right, height: rect.height };
        });
        if (process.env.WIRE_SETTINGS_GENERAL_PROOFS) {
            await mkdir(process.env.WIRE_SETTINGS_GENERAL_PROOFS, { recursive: true });
            await row.screenshot({ path: path.join(process.env.WIRE_SETTINGS_GENERAL_PROOFS, `${id}-hover.png`) });
        }
        assert.ok(paint.hovered && Math.abs(paint.arrowOffset) <= 1, `${id}: ${JSON.stringify(paint)}`);
        assert.equal(paint.row, "rgba(0, 0, 0, 0)", `${id}: row-wide hover`);
        assert.notEqual(paint.face, paint.row, `${id}: no visible destination cue`);
        assert.ok(paint.endInset >= 4 && paint.height >= 44,
            `${id}: ${JSON.stringify(paint)}`);
        assert.deepEqual(await destination.boundingBox(), resting);
    }
});

test("General shows the actual fallback zone and panel-only palette at narrow enlarged size", async t => {
    const { page, actions } = await workspace(t, { supported: false });
    await page.addInitScript(() => {
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
            if (key === "workiq-evidence.palette.v1") throw new DOMException("Unavailable in fixture", "SecurityError");
            return read.call(this, key);
        };
        const format = Intl.DateTimeFormat;
        Intl.DateTimeFormat = new Proxy(format, { apply(target, self, args) {
            const result = Reflect.apply(target, self, args);
            if (!args.length) result.resolvedOptions = () => ({ locale: "en-US" });
            return result;
        } });
    });
    await page.setViewportSize({ width: 375, height: 850 }); await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const current = page.locator("#general-themes"), zone = page.locator("#general-regional");
    await expect(current).toContainText(/Petrol & coral.*this panel only/);
    await expect(zone).toContainText(/UTC.*fallback: browser timezone unavailable/);
    await zone.focus(); await page.keyboard.press("Enter"); await expect(page.locator("#regionalTitle")).toBeFocused();
    await expect(page.locator("#displayTimeZone option:checked")).toHaveText(/UTC.*fallback/);
    await page.getByRole("button", { name: "Back to General" }).click(); await expect(zone).toBeFocused();
    const geometry = await zone.evaluate(node => ({ row: node.offsetHeight, width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(geometry.row >= 44 && geometry.width <= geometry.viewport + 1, JSON.stringify(geometry));
    if (process.env.WIRE_SETTINGS_GENERAL_PROOFS) {
        await mkdir(process.env.WIRE_SETTINGS_GENERAL_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_SETTINGS_GENERAL_PROOFS, "general-fallback-narrow.png") });
    }
    assert.ok(actions.every(({ action }) => action === "status"));
});

test("a managed launcher reporting manual-only keeps its build ID and never schedules or offers installation", async t => {
    const { page, actions } = await workspace(t, { automatic: true, manual: true });
    await expect(page.locator("#appUpdateVersion")).toContainText(`Build ${old.slice(0, 8)}`);
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#settingsAppUpdate")).toBeHidden();
    await expect(page.locator("#appUpdateApply")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("Check for updates signals availability in both themes and stays check-only after Dismiss", async t => {
    const { page, state, actions } = await workspace(t);
    const check = page.getByRole("button", { name: "Check for updates" });
    const fill = button => button.evaluate(node => getComputedStyle(node, "::before").backgroundColor);
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
        await expect(check).toBeVisible();
        assert.equal(await fill(check), await fill(page.locator("#appUpdateApply")));
        assert.ok(paint.height >= 44);
        assert.equal(paint.overflow, false);
        if (process.env.WIRE_APP_UPDATE_PROOFS) {
            await mkdir(process.env.WIRE_APP_UPDATE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_APP_UPDATE_PROOFS, `${theme}-${width}.png`) });
        }
    }
    const availableFill = await fill(check);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    assert.equal(await fill(check), availableFill);
    for (const phase of ["current", "error", "unknown", "manual"]) {
        Object.assign(state, { phase, message: `Fixture ${phase}` });
        await check.click();
        await page.mouse.move(0, 0);
        await expect(page.locator("#appUpdateStatus")).toContainText(state.message);
        await expect.poll(() => fill(check)).not.toBe(availableFill);
    }
    assert.deepEqual(actions.map(a => a.action), ["status", "dismiss", "check", "check", "check", "check"]);
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

test("manual reload releases a clean page without releasing a suspended page or an uncertain operation", async t => {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [fixture("manual-departure")]);
    t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, frontend: "react" });
    cleanup.push(() => runtime.close());
    const responses = [];
    runtime.server.on("request", (req, res) => {
        if (req.url === "/api/session/release" || req.url === "/api/app-update/release-panel") res.on("finish", () => responses.push([req.url, res.statusCode]));
    });
    const browser = await chromium.launch(); cleanup.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(runtime.url + "settings");
    await expect(page.locator("#appUpdateStatus")).toHaveText("Updates are managed manually.");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("#appUpdateStatus")).toHaveText("Updates are managed manually.");
    assert.deepEqual(responses, []);
    await page.reload();
    await expect.poll(() => responses).toEqual([["/api/session/release", 200]]);
    await expect(page.locator("#appUpdateStatus")).toHaveText("Updates are managed manually.");
    const pendingPage = await browser.newPage();
    await pendingPage.addInitScript(() => sessionStorage.setItem("workiq-evidence.source-check.v1", "pending"));
    await pendingPage.goto(runtime.url + "settings");
    await expect(pendingPage.locator("#appUpdateStatus")).toHaveText("Updates are managed manually.");
    await expect(pendingPage.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await pendingPage.reload();
    await expect(pendingPage.locator("#appUpdateStatus")).toHaveText("Updates are managed manually.");
    assert.deepEqual(responses, [["/api/session/release", 200]]);
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
