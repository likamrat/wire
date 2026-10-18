import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption, openActivitySessions } from "./helpers.mjs";
import { reportContents, scanReport } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { createAssessmentWording } from "../web/assessment-presentation.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";

const proofs = process.env.WORKIQ_COLLAPSE_PROOFS;
const ready = page => page.locator("#workspace[aria-busy=false]").waitFor();
const toggle = page => page.locator("#navigationCollapse");
const nav = (page, route) => page.locator(`.primary-navigation a[data-nav="${route}"]`);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const records = ["/me/messages", "/me/events", "/me/drive/root/children", "/me/contacts", "/groups", "/search/query"].flatMap((endpoint, i) =>
    Array.from({ length: i + 1 }, (_, j) => {
        const row = fixture(`collapse-${i}-${j}`);
        row.userPrompt.text = "Synthetic sidebar request";
        row.toolCalls[0].requestedApiPath = endpoint;
        row.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
        return row;
    }));

async function setup(t, { empty = false, ...options } = {}) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, empty ? [] : records);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", ...options });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    page.setDefaultTimeout(8000);
    if (proofs) await mkdir(proofs, { recursive: true });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(url => ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
                "/api/assessment/overview", "/api/preview", "/api/cancel-preview"].includes(url)), `No collection, export, feedback or data mutations: ${requests}`);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?chart=workload"); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, requests };
}

async function geometry(page) {
    await frames(page);
    return page.evaluate(() => {
        const box = selector => {
            const node = document.querySelector(selector);
            if (!node?.checkVisibility()) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
        };
        return { sidebar: box("#sidebar"), main: box("#main"), header: box(".app-header"), chart: box(".chart-panel"),
            scene: box(".dimensional-plot"), filters: box("#filters"), overflow: document.documentElement.scrollWidth - innerWidth,
            offset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")),
            font: getComputedStyle(document.body).fontFamily, loaded: document.fonts.check("14px Arial"),
            scrollY, route: location.hash };
    });
}

async function screenshot(page, name) {
    if (proofs) await page.screenshot({ path: path.join(proofs, `${name}.png`), fullPage: false });
}

async function setCollapsed(page, collapsed) {
    if (await toggle(page).getAttribute("aria-expanded") === String(collapsed)) await toggle(page).click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await frames(page);
    assert.equal(await toggle(page).getAttribute("aria-expanded"), String(!collapsed));
}

test("pointer and keyboard collapse reclaim actual chart width and retain tooltip dismissal and all destinations", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t);
    const before = await geometry(page), scene = await page.locator(".dimensional-plot").elementHandle();
    const snapshotReads = requests.filter(url => url === "/api/snapshot").length;
    assert.equal(before.loaded, true); assert.match(before.font, /^Arial,/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const documentNode = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#navigationExplore" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some(font => font.isCustomFont && /Asta/i.test(font.familyName)), "Navigation actually paints with embedded Asta, not fallback");
    await cdp.detach();
    await toggle(page).hover();
    await page.getByRole("tooltip", { name: "Collapse navigation", exact: true }).waitFor();
    const button = await toggle(page).boundingBox(), tooltip = await page.getByRole("tooltip").boundingBox();
    assert.equal(tooltip.x, button.x + button.width + 8);
    assert.ok(Math.abs(tooltip.y + tooltip.height / 2 - button.y - button.height / 2) < 1);
    await screenshot(page, "desktop-expanded-tooltip-light");
    await toggle(page).click();
    const collapsed = await geometry(page);
    assert.equal(collapsed.sidebar.width, 69);
    assert.equal(collapsed.main.x, collapsed.offset);
    assert.equal(collapsed.main.width - before.main.width, before.sidebar.width - collapsed.sidebar.width);
    assert.equal(collapsed.chart.width - before.chart.width, before.sidebar.width - collapsed.sidebar.width);
    assert.ok(collapsed.scene.width > before.scene.width, "Existing chart ResizeObserver uses released space");
    assert.deepEqual(collapsed.header, before.header);
    assert.equal(await scene.evaluate(node => node === document.querySelector(".dimensional-plot")), true, "No chart remount");
    assert.equal(requests.filter(url => url === "/api/snapshot").length, snapshotReads, "Collapse does not reload evidence");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Expand navigation");
    await page.waitForTimeout(350);
    assert.equal(await page.getByRole("tooltip").isVisible(), false, "Click does not resurrect help");
    await screenshot(page, "desktop-collapsed-light");
    await toggle(page).press("Enter");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Collapse navigation");
    await toggle(page).press("Space");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Expand navigation");
    await page.keyboard.press("Tab");
    await page.getByRole("tooltip", { name: "Home", exact: true }).waitFor();
    assert.equal(await nav(page, "home").evaluate(node => node.matches(":focus-visible")), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await page.keyboard.press("Shift+Tab");
    await page.getByRole("tooltip", { name: "Expand navigation", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.move(1435, 950);
    for (const route of ["activity", "reports", "collection-status", "settings", "home"]) {
        const link = nav(page, route), name = await link.getAttribute("aria-label");
        await link.hover();
        await page.getByRole("tooltip", { name, exact: true }).waitFor();
        await link.click(); await ready(page);
        assert.equal(await link.getAttribute("aria-current"), "page");
        assert.equal(await link.locator('svg[data-fluent-icon$="_filled"]').isVisible(), true);
        assert.equal(await link.locator('svg[data-fluent-icon$="_regular"]').isVisible(), false);
        assert.equal(await link.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
        await page.waitForTimeout(200);
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "No stale navigation tooltip");
    }
    if (proofs) await writeFile(path.join(proofs, "width-proof.json"), JSON.stringify({ before, collapsed, fonts }, null, 2));
});

test("scope, search, selected requests, Settings and report drafts survive toggles, history and review", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t, { reducedMotion: "no-preference" });
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    await navigateMain(page, "activity"); await ready(page);
    await page.locator("#activitySearch").fill("Synthetic"); await ready(page);
    await openActivitySessions(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    const activityUrl = page.url(), search = await page.locator("#activitySearch").inputValue();
    const searchNode = await page.locator("#activitySearch").elementHandle();
    await setCollapsed(page, true);
    assert.equal(page.url(), activityUrl);
    assert.equal(await searchNode.evaluate(node => node === document.querySelector("#activitySearch")), true);
    assert.equal(await page.locator("#activityList input[type=checkbox]:checked").count(), 1);
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "collection");
    await selectActivityOption(page, "collectionWindow", "7");
    const settingsDraft = await page.locator("#collectionWindow").elementHandle();
    await setCollapsed(page, false); await setCollapsed(page, true);
    assert.equal(await settingsDraft.evaluate(node => node.value), "7");
    await navigateMain(page, "reports"); await ready(page);
    await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#formatOptions input[value=json]").check();
    const draftNode = await page.locator("#promptOptions").elementHandle();
    await setCollapsed(page, false); await setCollapsed(page, true);
    assert.equal(await draftNode.evaluate(node => node === document.querySelector("#promptOptions")), true);
    assert.equal(await page.locator('[name=promptMode][value=none]').isChecked(), true);
    assert.equal(await page.locator("#formatOptions input[value=json]").isChecked(), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 request/);
    await scanReport(page);
    const review = await page.locator("#reportsView").elementHandle();
    const previews = requests.filter(url => url === "/api/preview").length;
    await setCollapsed(page, false); await setCollapsed(page, true);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "ready");
    assert.equal(await review.evaluate(node => node === document.querySelector("#reportsView")), true);
    assert.equal(requests.filter(url => url === "/api/preview").length, previews);
    assert.ok((await geometry(page)).overflow <= 1);
    await screenshot(page, "collapsed-report-review");
    await navigateMain(page, "activity"); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), search);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Mail");
    await openActivitySessions(page);
    assert.equal(await page.locator("#activityList input[type=checkbox]:checked").count(), 1);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator('[name=promptMode][value=none]').isChecked(), true);
    await page.goForward(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), search);
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "collection");
    assert.equal(await page.locator("#collectionWindow").inputValue(), "7");
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
    await page.locator("#collectionWindow-control").focus();
    const previous = await page.evaluate(() => ({ y: scrollY, active: document.activeElement.id }));
    // Cross-panel display preference updates must not steal focus from an unfinished form.
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
        key: "workiq-evidence.navigation", storageArea: localStorage, newValue: "expanded",
    })));
    assert.deepEqual(await page.evaluate(() => ({ y: scrollY, active: document.activeElement.id })), previous);
});

test("mobile drawer keeps desktop choice, modal containment and focus across pointer and touch round-trips", { timeout: 60000 }, async t => {
    const { page } = await setup(t, { hasTouch: true });
    const navigation = await page.locator(".primary-navigation").elementHandle();
    for (const collapsed of [false, true]) {
        await setCollapsed(page, collapsed);
        await nav(page, "activity").focus();
        await page.setViewportSize({ width: 375, height: 900 }); await frames(page);
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        assert.equal(await toggle(page).isVisible(), false);
        assert.equal(await page.locator("#main").evaluate(node => node.getBoundingClientRect().width), 375);
        await page.locator("#navigationToggle").tap();
        assert.equal(await navigation.evaluate(node => node === document.querySelector("#navigationDrawer .primary-navigation")), true);
        assert.equal(await nav(page, "home").getAttribute("aria-current"), "page");
        assert.equal(await nav(page, "collection-status").locator(".navigation-label").evaluate(node => getComputedStyle(node).position), "static");
        for (let index = 0; index < 8; index++) {
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest("#navigationDrawer")), true, "Tab visits the drawer or browser chrome, never hidden/background controls");
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        await page.locator("#navigationToggle").tap();
        await page.mouse.click(365, 300);
        assert.equal(await page.locator("#navigationDrawer").evaluate(node => node.open), false);
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        assert.match(page.url(), /#home/, "Backdrop does not activate background content");
        await page.locator("#navigationToggle").tap();
        await nav(page, "settings").focus();
        await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page);
        assert.equal(await page.locator("#navigationDrawer").evaluate(node => node.open), false);
        assert.equal(await nav(page, "settings").evaluate(node => node === document.activeElement), true);
        assert.equal(await toggle(page).getAttribute("aria-expanded"), String(!collapsed));
        assert.equal(await navigation.evaluate(node => node === document.querySelector("#sidebar .primary-navigation")), true);
    }
    await toggle(page).tap();
    assert.equal(await toggle(page).getAttribute("aria-label"), "Collapse navigation", "Touch can reveal every full label");
    await toggle(page).tap();
    await nav(page, "activity").tap(); await ready(page);
    assert.equal(await nav(page, "activity").getAttribute("aria-current"), "page", "Touch activates a named rail destination");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
});

test("light/navy, 200% text, empty/populated and container resizing preserve readable geometry", { timeout: 120000 }, async t => {
    const measurements = [];
    for (const empty of [false, true]) {
        const { page } = await setup(t, { empty, reducedMotion: "no-preference" });
        for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            for (const width of [768, 1440]) for (const collapsed of [false, true]) {
                await page.setViewportSize({ width, height: 1000 });
                await setCollapsed(page, collapsed);
                const measured = await geometry(page);
                assert.ok(measured.overflow <= 1, `${empty}/${theme}/${scale}/${width}/${collapsed}: no horizontal overflow`);
                assert.equal(measured.loaded, true);
                assert.equal(measured.main.x, measured.offset);
                assert.ok(Math.abs(measured.sidebar.width - measured.offset) < 1);
                for (const link of await page.locator(".primary-navigation a").all()) {
                    const row = await link.evaluate(node => {
                        const bounds = node.getBoundingClientRect(), label = node.querySelector(".navigation-label");
                        const range = document.createRange(); range.selectNodeContents(label);
                        const rect = range.getBoundingClientRect(), style = getComputedStyle(node);
                        return { width: bounds.width, height: bounds.height, lines: range.getClientRects().length,
                            contained: rect.left >= bounds.left && rect.right <= bounds.right,
                            font: style.fontSize, name: node.getAttribute("aria-label"),
                            ink: getComputedStyle(node.querySelector("svg")).color, paper: getComputedStyle(node.closest("aside")).backgroundColor };
                    });
                    assert.ok(row.width >= 44 && row.height >= 44);
                    assert.ok(row.name);
                    assert.ok(contrast(row.ink, row.paper) >= 3);
                    assert.equal(row.font, `${14 * scale}px`);
                    if (!collapsed) { assert.equal(row.lines, 1); assert.equal(row.contained, true); }
                }
                const stable = await geometry(page);
                assert.deepEqual(stable, measured, "No completed width/header jump");
                measurements.push({ empty, theme, scale, width, collapsed, ...measured });
                if (!empty && width === 1440) await screenshot(page, `${theme}-${scale}x-${collapsed ? "collapsed" : "expanded"}`);
            }
            await page.setViewportSize({ width: 375, height: 1000 }); await frames(page);
            await page.locator("#navigationToggle").click();
            assert.ok((await geometry(page)).overflow <= 1);
            if (!empty) await screenshot(page, `${theme}-${scale}x-mobile-drawer`);
            await page.keyboard.press("Escape");
            await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page);
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        await setCollapsed(page, false); await setCollapsed(page, true);
        assert.equal(await toggle(page).evaluate(node => getComputedStyle(node).animationName), "none");
        assert.deepEqual(await geometry(page), await geometry(page));
    }
    if (proofs) await writeFile(path.join(proofs, "layout-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("reload restores collapse and denied browser storage surfaces a recoverable panel-only choice", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await setCollapsed(page, true);
    await page.reload(); await ready(page);
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
    assert.equal((await geometry(page)).sidebar.width, 69);
    await page.evaluate(() => {
        window.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === "workiq-evidence.navigation") throw new DOMException("Synthetic denial", "QuotaExceededError");
            return window.originalSetItem.call(this, key, value);
        };
    });
    await setCollapsed(page, false);
    assert.equal(await page.locator("#navigationStorageNotice").isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.navigation")), "collapsed");
    await navigateMain(page, "activity"); await ready(page);
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "true");
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
    await setCollapsed(page, true);
    assert.equal(await page.locator("#navigationStorageNotice").isVisible(), false);
});

test("sidebar and content glide together through intermediate widths, reverse without snapping and settle cleanly", { timeout: 45000 }, async t => {
    const { page, requests } = await setup(t, { reducedMotion: "no-preference",
        ...(proofs ? { recordVideo: { dir: proofs, size: { width: 1440, height: 1000 } } } : {}) });
    await page.evaluate(() => {
        window.navigationMotionFrames = [];
        const rail = document.querySelector("#sidebar"), main = document.querySelector("#main");
        window.navigationMotionObserver = new ResizeObserver(() => {
            const sidebar = rail.getBoundingClientRect(), content = main.getBoundingClientRect();
            const label = document.querySelector(".navigation-label"), header = document.querySelector(".app-header").getBoundingClientRect();
            window.navigationMotionFrames.push({
                time: performance.now(), width: sidebar.width, mainX: content.x, mainWidth: content.width,
                chartWidth: document.querySelector(".chart-panel").getBoundingClientRect().width,
                headerHeight: header.height, opacity: Number(getComputedStyle(label).opacity),
                overflow: document.documentElement.scrollWidth - innerWidth,
            });
        });
        window.navigationMotionObserver.observe(rail);
    });
    const scene = await page.locator(".dimensional-plot").elementHandle(), route = page.url();
    const reads = requests.filter(url => url === "/api/snapshot").length;
    const samples = [];
    for (const collapsed of [true, false]) {
        const start = await toggle(page).evaluate(node => {
            window.navigationMotionFrames = [];
            return { time: performance.now(), width: node.closest("aside").getBoundingClientRect().width };
        });
        await toggle(page).click();
        assert.equal(await page.locator("#sidebar").getAttribute("data-navigation-moving"), "");
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        const measured = await page.evaluate(() => window.navigationMotionFrames);
        const finish = (await geometry(page)).sidebar.width;
        assert.ok(measured.length >= 6, "Several real rendered frames, not a delayed snap");
        const intermediate = measured.filter(frame => frame.width > Math.min(start.width, finish) + 1 && frame.width < Math.max(start.width, finish) - 1);
        assert.ok(intermediate.length >= 5, `${collapsed}: actual intermediate widths`);
        assert.ok(measured.at(-1).time - measured[0].time >= 250, "The rendered glide itself lasts long enough to be perceptible");
        for (const [index, frame] of measured.entries()) {
            assert.ok(Math.abs(frame.mainX - frame.width) < 1, "The same observed width drives the main edge every frame");
            assert.ok(Math.abs(frame.mainWidth + frame.width - 1440) < 1);
            assert.ok(frame.overflow <= 1, "No transient horizontal overflow");
            assert.equal(frame.headerHeight, measured[0].headerHeight);
            if (index) assert.ok(collapsed ? frame.width <= measured[index - 1].width + 1 : frame.width >= measured[index - 1].width - 1, "Monotonic glide, no width bounce");
        }
        assert.ok(intermediate.some(frame => frame.opacity > 0 && frame.opacity < 1), "Labels fade, not pop");
        const settled = await geometry(page);
        await page.waitForTimeout(100);
        assert.deepEqual(await geometry(page), settled, "No end-of-animation jump");
        samples.push({ collapsed, start, finish, frames: measured });
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Movement does not resurrect dismissed help");
    }
    await toggle(page).click();
    await page.waitForTimeout(95);
    const reversal = await toggle(page).evaluate(node => {
        const before = node.closest("aside").getBoundingClientRect().width;
        node.click();
        return { before, after: node.closest("aside").getBoundingClientRect().width };
    });
    assert.ok(Math.abs(reversal.before - reversal.after) < 1, "Rapid reversal starts at the current rendered width");
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "true");
    assert.equal((await geometry(page)).sidebar.width, 208);
    assert.equal(await scene.evaluate(node => node === document.querySelector(".dimensional-plot")), true);
    assert.equal(page.url(), route);
    assert.equal(requests.filter(url => url === "/api/snapshot").length, reads);
    assert.equal(await toggle(page).evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => window.navigationMotionObserver.disconnect());
    if (proofs) {
        await writeFile(path.join(proofs, "glide-frames.json"), JSON.stringify({ samples, reversal }, null, 2));
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.waitForTimeout(400);
            for (const collapsed of [true, false]) {
                // Freeze a genuine animation midway for a readable full-shell proof.
                await toggle(page).click();
                await page.evaluate(() => {
                    for (const animation of document.querySelector("#sidebar").getAnimations({ subtree: true })) {
                        animation.pause(); animation.currentTime = 140;
                    }
                });
                await screenshot(page, `${theme}-${collapsed ? "collapse" : "expand"}-mid-glide`);
                await page.evaluate(() => {
                    for (const animation of document.querySelector("#sidebar").getAnimations({ subtree: true })) animation.play();
                });
                await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
            }
        }
    }
});

test("resizing settles geometry while host motion changes preserve built-in glide and the desktop choice", { timeout: 30000 }, async t => {
    const { page } = await setup(t, { reducedMotion: "no-preference" });
    const expanded = (await geometry(page)).sidebar.width;
    await toggle(page).click();
    assert.ok(await page.locator("#sidebar").evaluate(node => node.hasAttribute("data-navigation-moving")));
    await page.setViewportSize({ width: 375, height: 900 }); await frames(page);
    assert.equal(await page.locator("#sidebar").getAttribute("data-navigation-moving"), null);
    assert.equal(await page.locator("#main").evaluate(node => node.getBoundingClientRect().width), 375);
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    await page.locator("#navigationToggle").click();
    assert.equal(await nav(page, "settings").locator(".navigation-label").evaluate(node => Number(getComputedStyle(node).opacity)), 1);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page);
    assert.equal((await geometry(page)).sidebar.width, 69);
    await toggle(page).click();
    await page.emulateMedia({ reducedMotion: "reduce" }); await frames(page);
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await page.locator("#sidebar").getAttribute("data-navigation-moving"), null);
    assert.equal((await geometry(page)).sidebar.width, expanded);
    await toggle(page).click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    assert.equal((await geometry(page)).sidebar.width, 69);
    await page.reload(); await ready(page);
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0, "No entrance animation on reload");
});

test("synthetic comparison content and native reading dialogs fit the actual collapsed shell", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await navigateMain(page, "reports"); await ready(page);
    const report = id => ({
        schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true, patternVersion: 1,
        metrics: {}, toolRows: [{ id, patternId: "mail", outcome: id === "a" ? "success" : "failure" }],
        patterns: [{ patternId: "mail", unitKind: "tool-call", tool: "workiq-fetch", workload: "Mail",
            attribution: "requested-single-target", targetShape: "single", available: true,
            endpoints: [{ pathTemplate: "/me/messages", method: null, apiVersion: null, queryKeys: [] }] }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "synthetic-fixture", callTimesAvailable: false, historyComplete: false },
    });
    // Mount the existing comparison renderer in its real shell container without
    // creating, exporting or claiming any saved report in the isolated store.
    await page.evaluate(({ source, wording, model }) => {
        const script = document.createElement("script");
        script.nonce = document.querySelector("script[nonce]").nonce;
        script.textContent = `window.collapseComparison = (${source})((${wording})());`;
        document.head.append(script);
        const host = document.querySelector("#comparisonWorkspace");
        host.hidden = false;
        window.collapseComparison.render(host, model);
    }, { source: createReportComparison.toString(), wording: createAssessmentWording.toString(), model: compareFrozenReportFacts(report("a"), report("b"), { identityRelation: "same-namespace" }) });
    const comparison = page.locator("#comparisonWorkspace .report-comparison"), original = await comparison.elementHandle();
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.setViewportSize({ width: 1200, height: 1000 });
        await setCollapsed(page, false);
        const before = await comparison.boundingBox(), sidebar = (await geometry(page)).sidebar;
        await setCollapsed(page, true);
        const after = await comparison.boundingBox(), collapsed = (await geometry(page)).sidebar;
        assert.ok(Math.abs(after.width - before.width - sidebar.width + collapsed.width) < 1);
        assert.equal(await original.evaluate(node => node === document.querySelector("#comparisonWorkspace .report-comparison")), true);
        assert.ok((await geometry(page)).overflow <= 1);
        assert.deepEqual(await comparison.locator(".comparison-score-value,.comparison-metric-value").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent)), []);
        if (scale === 1) { await comparison.scrollIntoViewIfNeeded(); await screenshot(page, `comparison-collapsed-${theme}`); }
    }
    await navigateMain(page, "home"); await ready(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    for (const collapsed of [false, true]) {
        await setCollapsed(page, collapsed);
        const definitions = page.locator("#homeInsights").getByRole("button", { name: "Measure definitions", exact: true });
        await definitions.click();
        const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
        await dialog.waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.closest("dialog[open]") !== null), true);
        for (const width of [768, 375]) {
            await page.setViewportSize({ width, height: 900 }); await frames(page);
            const bounds = await dialog.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest("dialog[open]")), true);
        }
        await page.keyboard.press("Escape");
        assert.equal(await definitions.evaluate(node => node === document.activeElement), true);
        await page.setViewportSize({ width: 1200, height: 1000 }); await frames(page);
        assert.equal(await toggle(page).getAttribute("aria-expanded"), String(!collapsed));
    }
});
