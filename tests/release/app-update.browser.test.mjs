import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBrowserAssets } from "../../lib/browser-assets.mjs";
import { renderHtmlShell } from "../../lib/render.mjs";
import { createExportController } from "../../lib/export.mjs";
import { startServer } from "../../lib/server.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../../lib/activity-analytics.mjs";
import { defaultConsent } from "../../lib/assessment-contract.mjs";
import { fixture, privateFixture, exportCatalogFor, UNBOUND_FIXTURE_BOOTSTRAP, automaticScoreOffSummary, revealAnalyzeRecords, chooseTheme, selectActivityOption } from "../support/helpers.mjs";
import { selectAnalyzeRequest } from "../reports/report-journey-helpers.mjs";
import { paintedLabelContrast } from "../support/color-measurements.mjs";

// No listener or real updater. Serve the normal built module and shell solely via intercepted requests.
const origin = "http://127.0.0.1:48197", capability = "c".repeat(64);
const old = "1".repeat(40), next = "2".repeat(40);
const originalRuntime = UNBOUND_FIXTURE_BOOTSTRAP.runtimeId, replacement = "00000000-0000-4000-8000-000000000002";
async function workspace(t, { renderer = "react", automatic = false, supported = true, manual = !supported, offer = next, pending, open = "/settings" } = {}) {
    const assets = await loadBrowserAssets({ renderer }), browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(6000);
    const actions = [], releases = [], errors = [], healthReads = [], pages = [];
    const state = { supported, automatic, installed: supported ? old : null, packageVersion: "1.0.0",
        candidate: manual ? null : offer, lastChecked: manual ? null : Date.UTC(2026, 10, 20, 20, 45), dismissed: null,
        phase: manual ? "manual" : offer ? "available" : "current", message: manual ? "Updates are managed manually." : offer ? "Update available." : "Up to date." };
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
            body: await readFile(new URL("../../assets/wire-icon.svg", import.meta.url)) });
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
            body: await readFile(new URL("../../lib/assessment-contract.mjs", import.meta.url)) });
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

test("What's new opens the offered version's notes in WIRE without installing or following preview branches", async t => {
    const {page,state,actions} = await workspace(t,{offer:null});
    Object.assign(state,{phase:"available",candidate:next,
        installedRelease:{tag:"v1.0.0",commit:old,notes:"### Added\n- Installed release notes.",url:"https://github.com/likamrat/wire/releases/tag/v1.0.0"},
        availableRelease:{tag:"v1.2.0",commit:next,notes:"## What's new in v1.2.0\n\n### Fixed\n- Saved reports reopen.",url:"https://github.com/likamrat/wire/releases/tag/v1.2.0"}});
    await page.getByRole("button",{name:"Check for updates",exact:true}).click();
    const proof = process.env.WIRE_SETTINGS_GENERAL_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const capture = async name => { if (proof) await page.screenshot({path:path.join(proof, `release-links-${name}.png`)}); };
    const installed = page.getByRole("link", {name:"Installed release notes"});
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const link of [installed, page.locator("#availableReleaseNotes"), page.locator("#noticeReleaseNotes")]) {
            await expect(link).toBeVisible();
            await expect(link).toHaveCSS("text-decoration-line", "none");
            await expect(link.locator('[data-icon-role="forward"]')).toBeVisible();
            assert.ok((await link.boundingBox()).height >= 44);
        }
        await installed.hover(); await capture(`${theme}-general`);
        const face = () => installed.evaluate(n => getComputedStyle(n, "::before").backgroundColor);
        const hover = await face(); assert.notEqual(hover, "rgba(0, 0, 0, 0)");
        await page.mouse.down(); assert.notEqual(await face(), hover); await page.mouse.up();
        await expect(page.locator("#releaseReaderVersion")).toHaveText("v1.0.0");
        const back = page.locator(".release-reader a[href='/settings']"), github = page.locator("#releaseReaderGitHub");
        for (const link of [back, github]) await expect(link).toHaveCSS("text-decoration-line", "none");
        await expect(github).toHaveAttribute("href", state.installedRelease.url);
        await expect(github).toHaveAttribute("target", "_blank");
        await back.focus(); await page.keyboard.press("Tab");
        await expect(github).toBeFocused();
        assert.equal(await github.evaluate(n => getComputedStyle(n, "::before").outlineStyle), "solid");
        await capture(`${theme}-reader`);
        await back.click(); await expect(installed).toBeVisible();
    }
    await page.locator("#availableReleaseNotes").click();
    await expect(page).toHaveURL(/section=release-notes&release=v1\.2\.0/);
    await expect(page.locator("#releaseNotesBody li")).toHaveText("Saved reports reopen.");
    await expect(page.locator("#releaseReaderGitHub")).toHaveAttribute("href",state.availableRelease.url);
    await expect(page.locator("#releaseReaderVersion")).toHaveText("v1.2.0");
    await expect(page.locator("#releaseReaderApply")).toBeVisible();
    assert.equal(actions.some(r=>r.action==="apply"),false);
    await page.goBack();
    await expect(page.locator("#availableReleaseNotes")).toBeVisible();
});

test("a first public release can follow a higher development package label without reinstalling the same commit", async t => {
    const {page,state,actions} = await workspace(t, { offer:null });
    const release = { tag:"v0.1.0", commit:next, notes:"## What's new in v0.1.0\n\nTest baseline.",
        url:"https://github.com/likamrat/wire/releases/tag/v0.1.0" };
    Object.assign(state, { packageVersion:"1.0.1", phase:"available", candidate:next, availableRelease:release });
    await page.getByRole("button",{name:"Check for updates",exact:true}).click();
    await expect(page.locator("#appUpdateVersion")).toHaveText("WIRE v1.0.1");
    await expect(page.locator("#appUpdateHeading")).toHaveText("WIRE v0.1.0 is available");
    Object.assign(state, { packageVersion:"0.1.0", installed:next, candidate:null, phase:"current", availableRelease:null, installedRelease:release });
    await page.reload();
    await expect(page.locator("#appUpdateVersion")).toHaveText("WIRE v0.1.0");
    await expect(page.locator("#settingsAppUpdate")).toBeHidden();
    await page.locator("#installedReleaseNotes").click();
    await expect(page.locator("#releaseReaderVersion")).toHaveText("v0.1.0");
    await expect(page.locator("#releaseReaderGitHub")).toHaveAttribute("href",release.url);
    assert.equal(actions.some(r=>r.action==="apply"),false);
});

test("React Settings checks, opts in and out, dismisses only this build, and schedules checks without applying", async t => {
    const { page, state, actions } = await workspace(t, { offer: null });
    const auto = page.getByRole("switch", { name: "Automatically check for updates" });
    await expect(auto).not.toBeChecked(); assert.deepEqual(actions, [{ action: "status" }]);
    Object.assign(state, { phase: "available", candidate: next, message: "Update available." });
    await page.getByRole("button", { name: "Check for updates" }).click();
    await page.locator("#appUpdateDismiss").click();
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    await page.reload(); await expect(auto).toBeEnabled(); await expect(page.locator("#settingsAppUpdate")).toBeVisible();
    await auto.focus(); await page.keyboard.press("Space"); await expect(auto).toBeChecked();
    await page.clock.install();
    await page.reload(); await expect.poll(() => actions.at(-1).action).toBe("auto-check");
    await expect(auto).toBeEnabled();
    state.candidate = "3".repeat(40);
    // A pre-deadline launcher still owns its daily schedule.
    await page.clock.fastForward("00:05:00");
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    await page.clock.fastForward("23:55:00");
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
    const install = page.locator("#settingsAppUpdate");
    await expect(install).toBeVisible();
    await expect(page.locator("#appUpdateVersion")).toHaveText("WIRE v1.0.0");
    await expect(page.locator("#appUpdateVersion")).not.toHaveAttribute("title");
    await expect(page.locator("#appUpdateStatus")).toHaveText("Update available.");
    await expect.poll(() => page.locator(".app-version-card img").evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator("#settingsCategoryNav [data-category=themes]").click();
    await page.locator("#settingsSearch").fill("Check for WIRE updates");
    const result = page.locator('#settingsSearchResults [data-setting="app-update"]');
    await expect(page.locator(".settings-search-heading")).toContainText("General");
    await result.focus(); await page.keyboard.press("Enter");
    await expect(install).toBeFocused();
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

test("a manual check cannot publish an old offer after the page was suspended", async t => {
    const { page, state, actions } = await workspace(t, { offer: null });
    Object.assign(state, { phase: "available", candidate: next });
    const responded = page.waitForResponse(r => r.url().endsWith("/api/app-update") && r.request().postDataJSON()?.action === "check");
    await page.locator("#appUpdateCheck").click(); await responded;
    await expect(page.locator("#appUpdateCheck")).toHaveAttribute("aria-busy", "true");
    Object.assign(state, { phase: "current", candidate: null, message: "Up to date." });
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("#appUpdateStatus")).toContainText("Up to date.");
    await expect(page.locator("#appUpdateCheck")).toBeEnabled();
    await expect(page.locator("#settingsAppUpdate")).toBeHidden();
    assert.deepEqual(actions.map(a => a.action), ["status", "check", "status"]);
});

test("unsupported bundled runtime reads status only, even if a saved automatic preference is on", async t => {
    const { page, actions } = await workspace(t, { renderer: "bundled", automatic: true, supported: false });
    await expect(page.locator(".app-version-card .settings-row-copy")).toHaveText(/^\s*WIRE v1\.0\.0\s*$/, { useInnerText:true });
    await expect(page.locator("#availableReleaseNotes")).toBeHidden(); await expect(page.locator("#installedReleaseNotes")).toBeHidden();
    await expect(page.getByRole("link", { name: "Update instructions" })).toBeVisible();
    await expect(page.locator("#appUpdateCheck")).toBeHidden();
    await expect(page.locator("#appUpdateAuto")).toBeHidden();
    await expect(page.locator("#settingsAppUpdate")).toBeHidden(); await expect(page.locator("#appUpdateApply")).toBeHidden();
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#appUpdateNotice")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

for (const supported of [false, true]) test(`General keeps one edge below the ${supported ? "build" : "package"} card`, async t => {
    const { page, actions } = await workspace(t, { supported });
    const card = page.locator(".app-version-card"), next = card.locator("+ .settings-task-row"), appearance = page.locator(".general-appearance");
    const proof = process.env.WIRE_SETTINGS_GENERAL_PROOFS;
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `general-${supported ? "build" : "package"}-${theme}.png`) });
        }
        await expect(card).toHaveCSS("border-bottom-width", "1px");
        await expect(next).toHaveCSS("border-top-width", "0px");
        await expect(next).toHaveCSS("border-bottom-width", "1px");
        await expect(appearance).toHaveCSS("border-top-width", "0px");
    }
    await next.evaluate(row => { row.hidden = true; });
    await expect(next).toBeHidden();
    assert.equal(await appearance.evaluate(node => node.getBoundingClientRect().top),
        await card.evaluate(node => node.getBoundingClientRect().bottom));
    await page.locator("#settingsCategoryNav [data-category=privacy]").click();
    await expect(page.locator("[data-settings-section=privacy] .settings-task-row").last()).toHaveCSS("border-top-width", "1px");
    if (proof) await page.screenshot({ path: path.join(proof, "privacy-dark.png") });
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("General preference rows open canonical pages and return to updated values", async t => {
    const { page, actions } = await workspace(t, { supported: false });
    const current = page.getByRole("link", { name: "Change theme" }), zone = page.getByRole("link", { name: /Time zone.*Regional/ });
    const preview = current.locator(".palette-scene");
    await expect(preview).toBeVisible();
    const painted = node => [node, node.querySelector(".palette-rail"), node.querySelector(".palette-strip i")].map(n => getComputedStyle(n).backgroundColor);
    const initialPaint = await preview.evaluate(painted);
    const colors = current.locator(".palette-swatches i");
    const swatchPaint = () => colors.evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor));
    const initialColors = await swatchPaint();
    assert.equal(new Set(initialColors).size, 6);
    assert.ok(!initialColors.includes("rgba(0, 0, 0, 0)"));
    const back = page.getByRole("button", { name: "Back to General" });
    await current.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#themesTitle")).toBeFocused();
    await expect(page).toHaveURL(/\/settings\?section=themes$/);
    await chooseTheme(page, "dark"); await page.locator("label:has(#palette-field)").click();
    await expect(page.locator("#paletteSelection")).toBeHidden();
    await page.locator("#findPalette").click(); await page.locator("#paletteQuery").fill("linen");
    await expect(page.locator("#paletteSelection")).toHaveText("Active: Field notes");
    await expect(page.locator("#paletteSelection")).toBeVisible();
    await page.locator("#paletteQuery").press("Escape");
    const selectedPaint = await page.locator("label:has(#palette-field) .palette-scene:visible").evaluate(painted);
    await back.click(); await expect(current).toBeFocused(); await expect(current).toHaveAccessibleDescription("Field notes Dark");
    assert.deepEqual(await preview.evaluate(painted), selectedPaint);
    assert.notDeepEqual(selectedPaint, initialPaint);
    const selectedColors = await swatchPaint();
    assert.equal(new Set(selectedColors).size, 6);
    assert.notDeepEqual(selectedColors, initialColors);
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
    const thumbnail = await current.locator(".palette-scene").boundingBox();
    assert.ok(thumbnail.width >= 1.8 * thumbnail.height, "The miniature should stay landscape when text grows");
    const fit = await current.evaluate(n => {
        const row = n.getBoundingClientRect();
        return [...n.querySelectorAll(".palette-swatches i,#generalThemeAction,#generalMode")].every(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.left >= row.left - 1 && r.right <= row.right + 1;
        });
    });
    assert.ok(fit, "Theme swatches, mode and action must fit at enlarged text");
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

test("manual-only launcher shows instructions without printing its build ID or offering installation", async t => {
    const { page, actions } = await workspace(t, { automatic: true, manual: true });
    await expect(page.locator("#appUpdateVersion")).toHaveText("WIRE v1.0.0");
    await expect(page.locator("#appUpdateVersion")).not.toHaveAttribute("title");
    await expect(page.locator("#appUpdateGuide")).toBeVisible();
    await expect(page.locator("#appUpdateAuto")).toBeDisabled(); await expect(page.locator("#settingsAppUpdate")).toBeHidden();
    await expect(page.locator("#appUpdateApply")).toBeHidden();
    assert.deepEqual(actions, [{ action: "status" }]);
});

test("Settings and the notice offer the same restart; dismissing leaves the Settings action", async t => {
    const { page, state, actions } = await workspace(t);
    const check = page.locator("#appUpdateCheck"), install = page.locator("#settingsAppUpdate"), popup = page.locator("#appUpdateApply");
    const fill = button => button.evaluate(node => getComputedStyle(node, "::before").backgroundColor);
    for (const [theme, width] of [["dark", 1280], ["light", 390]]) {
        await page.setViewportSize({ width, height: 900 });
        await chooseTheme(page, theme);
        await page.waitForFunction(() => !document.getAnimations().some(animation =>
            animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
        await expect(popup).toBeVisible();
        await expect(install).toHaveAccessibleName("Update and restart");
        await expect(popup).toHaveAccessibleName("Update and restart");
        if (width === 1280) {
            const lines = await page.locator("#appUpdateDetail").evaluate(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return new Set([...range.getClientRects()].map(rect => rect.top)).size;
            });
            assert.equal(lines, 2, "All of the update copy fits on two lines");
            const notice = await page.locator("#appUpdateNotice").boundingBox(), search = await page.locator("#settingsSearch").boundingBox();
            assert.ok(notice.x + notice.width <= search.x);
            const dismiss = await page.locator("#appUpdateDismiss").boundingBox();
            assert.equal(dismiss.y, (await popup.boundingBox()).y);
            await expect(page.locator("#appUpdateDismiss")).toHaveText("Dismiss");
        } else {
            const search = page.locator("#settingsSearch");
            await search.scrollIntoViewIfNeeded();
            await search.click();
            await expect(search).toBeFocused();
            const notice = await page.locator("#appUpdateNotice").boundingBox();
            assert.ok(notice.y + notice.height <= (await search.boundingBox()).y);
        }
        const paint = await page.locator("#appUpdateApply").evaluate(node => {
            const color = getComputedStyle(node, "::before").backgroundColor;
            return { rgb: color.match(/\d+/g)?.map(Number), overflow: document.documentElement.scrollWidth > innerWidth,
                height: node.getBoundingClientRect().height };
        });
        assert.ok(paint.rgb && paint.rgb[1] > paint.rgb[0] && paint.rgb[1] > paint.rgb[2], `${theme}: ${paint.rgb}`);
        await expect(check).toBeHidden();
        assert.equal(await fill(install), await fill(popup));
        await install.hover(); await page.mouse.down();
        try {
            await page.waitForFunction(() => !document.getAnimations().some(a => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)));
            const painted = await paintedLabelContrast(install);
            assert.ok(painted >= 4.5, `${theme}: pressed update text against its painted face (${painted.toFixed(2)}:1)`);
        } finally { await page.mouse.move(1, 1); await page.mouse.up(); }
        await expect.poll(() => fill(install)).toBe(await fill(popup));
        assert.ok(paint.height >= 44);
        assert.equal(paint.overflow, false);
        if (process.env.WIRE_APP_UPDATE_PROOFS) {
            await mkdir(process.env.WIRE_APP_UPDATE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_APP_UPDATE_PROOFS, `${theme}-${width}.png`) });
        }
    }
    const availableFill = await fill(install);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    await expect(install).toBeVisible(); await expect(check).toBeHidden();
    assert.equal(await fill(install), availableFill);
    await install.click();
    await expect(page.locator("#appUpdateStatus")).toContainText("Close the other WIRE panel first.");
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    await page.getByRole("link", { name: "Change theme" }).click();
    await expect(page.getByRole("complementary", { name: "Update not installed" })).toBeVisible();
    await expect(page.locator("#appUpdateDetail")).toHaveText("Close the other WIRE panel first.");
    await page.getByRole("button", { name: "Back to General" }).click();
    assert.deepEqual(actions.filter(a => a.action === "apply"), [{ action: "apply", candidate: next }]);
    Object.assign(state, { phase: "current", candidate: null, message: "Up to date." });
    await page.reload();
    for (const phase of ["current", "error", "unknown", "manual"]) {
        Object.assign(state, { phase, message: `Fixture ${phase}` });
        await check.click();
        await page.mouse.move(0, 0);
        if (phase === "manual") {
            await expect(page.locator("#appUpdateGuide")).toBeVisible();
            await expect(check).toBeHidden();
        } else {
            await expect(page.locator("#appUpdateStatus")).toContainText(state.message);
            await expect.poll(() => fill(check)).not.toBe(availableFill);
        }
    }
    assert.equal(actions.filter(a => a.action === "check").length, 4);
});

test("the offer glides above the account without moving General or taking focus; reduced motion stays still", async t => {
    const { page, state } = await workspace(t, { offer: null });
    const notice = page.locator("#appUpdateNotice"), card = page.locator(".app-version-card");
    for (const reduced of [false, true]) {
        await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        Object.assign(state, { phase: "current", candidate: null, dismissed: null, message: "Up to date." });
        await page.reload();
        await expect(page.locator("#appUpdateStatus")).toContainText("Up to date.");
        await expect(notice).toBeHidden();
        const top = (await card.boundingBox()).y;
        await notice.evaluate(n => {
            const sample = () => {
                window.offerFrames.push({ y: n.getBoundingClientRect().y, inert: n.inert, alpha: Number(getComputedStyle(n).opacity) });
                window.offerFrame = requestAnimationFrame(sample);
            };
            window.offerFrames = []; sample();
        });
        Object.assign(state, { phase: "available", candidate: next, message: "Update available." });
        await page.locator("#appUpdateCheck").click();
        await expect(notice).toHaveCSS("opacity", "1");
        await page.waitForFunction(() => document.querySelector("#appUpdateNotice").getAnimations().length === 0);
        const corner = await notice.boundingBox(), beforeDismiss = await card.boundingBox();
        assert.equal(beforeDismiss.y, top);
        const anchor = await notice.evaluate(n => ({ takesFocus: n.contains(document.activeElement),
            accountGap: document.querySelector(".navigation-footer").getBoundingClientRect().top - n.getBoundingClientRect().bottom }));
        assert.ok(!anchor.takesFocus && anchor.accountGap > 0 && corner.x === 10, JSON.stringify({anchor, corner}));
        await page.locator("#navigationCollapse").click();
        await expect.poll(() => notice.evaluate(n => Math.round(n.getBoundingClientRect().left - document.querySelector("#sidebar").getBoundingClientRect().right))).toBe(8);
        await page.locator("#navigationCollapse").click();
        await expect.poll(() => card.boundingBox()).toEqual(beforeDismiss);
        await page.locator("#appUpdateDismiss").click();
        await expect(notice).toBeHidden();
        assert.deepEqual(await card.boundingBox(), beforeDismiss);
        await expect(page.locator("#settingsAppUpdate")).toBeVisible();
        const samples = await page.evaluate(() => { cancelAnimationFrame(window.offerFrame); return window.offerFrames; });
        for (const inert of [false, true]) {
            const movement = samples.filter(f => f.inert === inert && f.alpha > 0 && f.alpha < 1 && f.y > corner.y + .1);
            assert.equal(new Set(movement.map(f => f.y)).size >= 2, !reduced, `inert=${inert}, reduced=${reduced}`);
        }
    }
});

test("unfinished settings and report selection block activation from the normal React shell", async t => {
    const { page, actions, releases } = await workspace(t);
    const apply = page.locator("#appUpdateApply");
    await page.locator('#settingsCategoryNav [data-category="connection"]').click();
    // An unsaved source edit is the unfinished Settings change.
    const sessions = page.locator("#sourceSessions");
    await sessions.fill(await sessions.inputValue() + "-unsaved");
    await apply.click();
    await expect(page.locator("#appUpdateHeading")).toHaveText("Update not installed");
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

test("reloading before opening status returns does not release a page with an unresolved operation", async t => {
    const { page, setup, state } = await workspace(t);
    await expect(page.locator("#appUpdateAuto")).toBeEnabled();
    const waiting = Promise.withResolvers(), resume = Promise.withResolvers();
    setup.status = async route => {
        setup.status = null; waiting.resolve(); await resume.promise;
        await route.fulfill({ json: state }).catch(() => {}); // The original document left.
    };
    await page.addInitScript(() => {
        sessionStorage.setItem("workiq-evidence.source-check.v1", "pending");
        const fetch = window.fetch;
        window.fetch = (...args) => {
            if (args[0] === "/api/app-update/release-panel") sessionStorage.setItem("fixture.release-attempted", "true");
            return fetch(...args);
        };
    });
    try {
        await page.reload(); await waiting.promise;
        await page.reload();
    } finally { resume.resolve(); }
    await expect(page.locator("#appUpdateAuto")).toBeEnabled();
    await page.locator("#appUpdateApply").click();
    await expect(page.locator("#appUpdateDetail")).toContainText("original result");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("fixture.release-attempted")), null);
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

async function managedWorkspace(t) {
    const cleanup = new AsyncDisposableStack();
    t.after(() => cleanup.disposeAsync());
    const { context } = await privateFixture({ after: close => cleanup.defer(close) });
    const channel = Object.assign(new EventEmitter(), { connected: true, env: { WIRE_UPDATE_LAUNCHER: "1", WIRE_UPDATE_BUILD: old } });
    const actions = [], state = { supported: true, automatic: false, installed: old, candidate: null, dismissed: null,
        lastChecked: null, phase: "current", message: "Up to date." };
    channel.send = ({ id, request }) => {
        actions.push(request.action);
        if (request.action === "check") Object.assign(state, { candidate: next, phase: "available", message: "Update available." });
        if (request.action === "dismiss") state.dismissed = request.candidate;
        channel.emit("message", { type: "wire-update-response", id, value: { ...state } });
    };
    const runtime = await startServer(context, createExportController(context), {
        port: 0, collector: { timers: false }, frontend: "react", updateChannel: channel,
    });
    cleanup.defer(() => runtime.close());
    const browser = await chromium.launch(); cleanup.defer(() => browser.close());
    return { runtime, browser, actions };
}

test("a lost opening update reply rejoins the peer watch in the original document", async t => {
    const { runtime, browser, actions } = await managedWorkspace(t);
    const page = await browser.newPage(), requests = [], documents = [];
    page.on("request", r => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents.push(r.url());
        const path = new URL(r.url()).pathname;
        if (path.startsWith("/api/app-update")) requests.push([path, r.headers()["x-board-capability"]]);
    });
    await page.route("**/api/app-update", async route => {
        assert.deepEqual(route.request().postDataJSON(), { action: "status" });
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        assert.equal((await response.json()).coordinated, true);
        await route.abort("connectionreset");
    }, { times: 1 });
    await page.goto(runtime.url + "settings");
    await expect.poll(() => requests.map(([path]) => path)).toEqual(["/api/app-update", "/api/app-update", "/api/app-update/watch"]);
    assert.deepEqual(actions, ["status", "status"]);
    assert.equal(new Set(requests.map(([, cap]) => cap)).size, 1);
    assert.deepEqual(documents, [runtime.url + "settings"]);
    await expect(page.locator("#appUpdateCheck")).toBeEnabled();
});

test("a check publishes its offer to another open view and dismissal keeps the update available", async t => {
    const { runtime, browser, actions } = await managedWorkspace(t);
    const [caller, peer] = await Promise.all([browser.newPage(), browser.newPage()]);
    const watch = "**/api/app-update/watch";
    await Promise.all([caller.waitForRequest(watch), peer.waitForRequest(watch),
        caller.goto(runtime.url + "settings"), peer.goto(runtime.url + "settings")]);
    await expect(peer.locator("#appUpdateNotice")).toBeHidden();
    async function peerChange(action, click) {
        const [own, shared] = await Promise.all([
            caller.waitForResponse(r => r.url().endsWith("/api/app-update") && r.request().postDataJSON().action === action),
            peer.waitForResponse(watch, { timeout: 5000 }), click(),
        ]);
        assert.equal(own.status(), 200); assert.equal(shared.status(), 200);
        const status = await own.json();
        assert.deepEqual(await shared.json(), { status });
        assert.ok(status.statusRevision > shared.request().postDataJSON().statusRevision);
        assert.equal(status.candidate, next);
        return status;
    }
    const offer = await peerChange("check", () => caller.locator("#appUpdateCheck").click());
    assert.equal(offer.dismissed, null);
    await expect(peer.locator("#appUpdateNotice")).toBeVisible();
    const dismissed = await peerChange("dismiss", () => caller.locator("#appUpdateDismiss").click());
    assert.equal(dismissed.dismissed, next);
    await expect(peer.locator("#appUpdateNotice")).toBeHidden();
    await expect(peer.locator("#settingsAppUpdate")).toBeEnabled();
    assert.deepEqual(actions, ["status", "status", "check", "dismiss"]);
});

test("an opening status refusal or unreadable reply does not retry or release the document", async t => {
    const { page, setup, actions, releases } = await workspace(t, { offer: null });
    await expect(page.locator("#appUpdateAuto")).toBeEnabled();
    await page.clock.install();
    for (const [status, json, message] of [
        [403, { error: "Page permission expired." }, "Page permission expired."],
        [200, {}, "Update status could not be confirmed."],
    ]) {
        setup.status = route => route.fulfill({ status, json });
        const before = actions.length;
        await page.reload();
        await expect(page.locator("#appUpdateStatus")).toContainText(message);
        const releasedOnDeparture = releases.length;
        await page.clock.runFor(2500);
        assert.deepEqual(actions.slice(before), [{ action: "status" }]);
        assert.equal(releases.length, releasedOnDeparture);
    }
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
    await expect(page.locator("#appUpdateGuide")).toBeVisible();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("#appUpdateGuide")).toBeVisible();
    assert.deepEqual(responses, []);
    await page.reload();
    await expect.poll(() => responses).toEqual([["/api/session/release", 200]]);
    await expect(page.locator("#appUpdateGuide")).toBeVisible();
    const pendingPage = await browser.newPage();
    await pendingPage.addInitScript(() => sessionStorage.setItem("workiq-evidence.source-check.v1", "pending"));
    await pendingPage.goto(runtime.url + "settings");
    await expect(pendingPage.locator("#appUpdateGuide")).toBeVisible();
    await expect(pendingPage.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await pendingPage.reload();
    await expect(pendingPage.locator("#appUpdateGuide")).toBeVisible();
    assert.deepEqual(responses, [["/api/session/release", 200]]);
});

test("single activation stays fenced through transport loss until the authenticated status, runtime, health and executed target asset agree", async t => {
    const { page, actions, setup, state, pages, healthReads } = await workspace(t);
    const apply = page.locator("#appUpdateApply"), modal = page.locator("#appUpdateFence");
    await apply.click(); await expect(page.locator("#appUpdateStatus")).toContainText("Close the other WIRE panel first.");
    await expect(page.locator("#appUpdateNotice")).toBeHidden();
    const hold = Promise.withResolvers();
    setup.apply = async route => { await hold.promise; await route.abort("connectionreset"); };
    await page.locator("#settingsAppUpdate").focus();
    await page.keyboard.press("Enter"); await expect(modal).toBeVisible();
    const activity = page.locator("#appUpdateActivity");
    if (process.env.WIRE_APP_UPDATE_PROOFS) {
        await mkdir(process.env.WIRE_APP_UPDATE_PROOFS, { recursive: true });
        await modal.screenshot({ path: path.join(process.env.WIRE_APP_UPDATE_PROOFS, "keyboard-update-progress.png") });
    }
    assert.equal(await modal.locator("h2").evaluate(title => getComputedStyle(title, "::before").content), "none",
        "the focused update dialog must not paint a heading marker across its spinner");
    await expect(modal).toBeFocused();
    await expect(page.locator("#appUpdateHint")).toBeHidden();
    const rotation = () => activity.evaluate(node => getComputedStyle(node).transform);
    const start = await rotation();
    await expect.poll(rotation).not.toBe(start);
    await page.emulateMedia({ reducedMotion: "reduce" }); await expect(activity).toHaveCSS("animation-name", "none");
    await expect(modal.getByRole("status")).toHaveText("Updating WIRE… back shortly.");
    await page.evaluate(() => {
        document.getElementById("settingsAppUpdate").click();
        document.querySelector('[data-category="themes"]').click();
        document.getElementById("appUpdateAuto").click();
    });
    await page.keyboard.press("Escape"); await expect(modal).toBeVisible();
    hold.resolve(); await expect.poll(() => healthReads.length).toBeGreaterThan(0);
    assert.equal(pages.length, 1); await expect(modal).toBeVisible();
    setup.health = { ...setup.health, build: next, runtimeId: replacement, clientEntry: "/assets/client/newbuild-12345678.js" };
    await expect(page.locator("#appUpdateHint")).toContainText("runtime identity", { timeout: 12000 });
    await expect(modal).toBeVisible();
    await page.keyboard.press("Tab"); await expect(page.locator("#appUpdateRecover")).toBeFocused();
    setup.capability = "d".repeat(64); setup.runtimeId = replacement;
    // The shell still names the stale entry: an available JS file is not loaded-client proof.
    await page.reload();
    await expect(page.locator("#appUpdateHint")).toContainText("different browser build", { timeout: 12000 });
    await expect(activity).toBeHidden(); await expect(page.locator("#appUpdateRecover")).toBeVisible();
    await expect(modal).toBeVisible();
    setup.entry = setup.health.clientEntry;
    setup.status = route => route.fulfill({ status: 403, json: { code: "session_expired", error: "Page permission expired." } });
    await page.reload();
    await expect(page.locator("#appUpdateHint")).toContainText("could not verify");
    await expect(modal).toBeVisible(); await expect(page.locator("#appUpdateNotice")).toBeHidden();
    setup.status = route => route.abort("connectionreset");
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateHint")).toContainText("could not verify"); await expect(modal).toBeVisible();
    setup.status = null; state.phase = "current"; state.clientEntry = setup.entry;
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateHint")).toContainText("does not confirm"); await expect(modal).toBeVisible();
    state.installed = next; state.clientEntry = "/assets/client/wrong-12345678.js";
    await page.locator("#appUpdateRecover").click();
    await expect(page.locator("#appUpdateHint")).toContainText("does not confirm"); await expect(modal).toBeVisible();
    state.clientEntry = setup.entry;
    delete state.packageVersion;
    await page.locator("#appUpdateRecover").click();
    const notice = page.locator("#appUpdateNotice");
    await expect(notice.getByRole("status")).toHaveText("WIRE updated", { useInnerText: true });
    await expect(modal).not.toBeVisible();
    assert.deepEqual(actions.filter(a => a.action === "apply"), [{ action: "apply", candidate: next }, { action: "apply", candidate: next }]);
    assert.equal(actions.filter(a => a.action === "preferences").length, 0);
});

test("the replacement shell shows recovery before its module loads and stops on a failed entry", async t => {
    const { page, setup, actions } = await workspace(t);
    await page.evaluate(receipt => sessionStorage.setItem("wire.app-update.expected", JSON.stringify(receipt)), {
        previous: old, candidate: next, runtimeId: originalRuntime, targetRuntime: replacement, entry: setup.entry, origin,
    });
    setup.runtimeId = replacement;
    const hold = Promise.withResolvers();
    await page.route(origin + setup.entry, async route => { await hold.promise; await route.abort("failed"); });
    try {
        await page.reload({ waitUntil: "commit" });
        await expect(page.getByRole("dialog", { name: "Checking version" })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Checking version" })).toBeFocused();
        await expect(page.locator("#loading")).toBeHidden();
        await expect(page.locator("#appUpdateActivity")).toBeVisible();
    } finally { hold.resolve(); }
    await expect(page.locator("#appUpdateHint")).toContainText("Reload this tab to check the restart");
    await expect(page.locator("#appUpdateActivity")).toBeHidden();
    assert.ok(!actions.some(a => a.action === "apply"));
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
    await page.locator('#settingsCategoryNav [data-category="connection"]').click();
    const sessions = page.locator("#sourceSessions");
    await sessions.fill(await sessions.inputValue() + "-unsaved");
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
