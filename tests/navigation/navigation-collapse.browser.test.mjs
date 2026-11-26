import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";

const proofs = process.env.WORKIQ_COLLAPSE_PROOFS;
const ready = page => page.locator("#workspace[aria-busy=false]").waitFor();
const toggle = page => page.locator("#navigationCollapse");
const nav = (page, route) => page.locator(`#navigationContent nav a[data-nav="${route}"]`);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const records = ["/me/messages", "/me/events", "/me/drive/root/children", "/me/contacts", "/groups", "/search/query"].flatMap((endpoint, i) =>
    Array.from({ length: i + 1 }, (_, j) => {
        const row = fixture(`collapse-${i}-${j}`);
        row.userPrompt.text = "Synthetic sidebar request";
        row.toolCalls[0].requestedApiPath = endpoint;
        row.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
        return row;
    }));

async function setup(t, { empty = false, additionalReads = [], ...options } = {}) {
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
                "/api/assessment/overview", "/api/preview", "/api/cancel-preview", ...additionalReads].includes(url)), `No collection, export, feedback or data mutations: ${requests}`);
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
            scene: box("#chart .flat-comparison"), filters: box("#filters"), overflow: document.documentElement.scrollWidth - innerWidth,
            offset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")),
            font: getComputedStyle(document.body).fontFamily, loaded: document.fonts.check('14px "Asta Sans"'),
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
    const { page, requests } = await setup(t, { additionalReads: ["/api/trends", "/api/period-comparison"] });
    const before = await geometry(page), scene = await page.locator("#chart .flat-comparison").elementHandle();
    const snapshotReads = requests.filter(url => url === "/api/snapshot").length;
    assert.equal(before.loaded, true); assert.match(before.font, /^"Asta Sans",/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const documentNode = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: '.primary-navigation [data-nav="analyze"] .navigation-label' });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some(font => font.isCustomFont && /Asta/i.test(font.familyName)), "Navigation actually paints with embedded Asta, not fallback");
    await cdp.detach();
    await toggle(page).hover();
    await page.getByRole("tooltip", { name: "Collapse navigation", exact: true }).waitFor();
    const button = await toggle(page).boundingBox(), tooltip = await page.getByRole("tooltip").boundingBox();
    assert.equal(tooltip.x, button.x + button.width + 8);
    assert.ok(Math.abs(tooltip.y + tooltip.height / 2 - button.y - button.height / 2) < 1);
    await screenshot(page, "desktop-expanded-tooltip-light");
    await setCollapsed(page, true);
    const collapsed = await geometry(page);
    assert.ok(before.sidebar.width - collapsed.sidebar.width > 100);
    assert.equal(collapsed.main.x, collapsed.offset);
    assert.equal(collapsed.main.width - before.main.width, before.sidebar.width - collapsed.sidebar.width);
    assert.equal(collapsed.chart.width - before.chart.width, before.sidebar.width - collapsed.sidebar.width);
    assert.ok(collapsed.scene.width > before.scene.width, "The plotted data uses the released space");
    assert.deepEqual(collapsed.header, before.header);
    assert.equal(await scene.evaluate(node => node === document.querySelector("#chart .flat-comparison")), true, "No chart remount");
    assert.equal(requests.filter(url => url === "/api/snapshot").length, snapshotReads, "Collapse does not reload evidence");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Expand navigation");
    await page.waitForTimeout(350);
    assert.equal(await page.getByRole("tooltip").isVisible(), false, "Click does not resurrect help");
    await screenshot(page, "desktop-collapsed-light");
    await toggle(page).press("Enter");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Collapse navigation");
    await toggle(page).press("Space");
    assert.equal(await toggle(page).getAttribute("aria-label"), "Expand navigation");
    const analyze = nav(page, "analyze");
    for (let i = 0; i < 12 && !await analyze.evaluate(node => node === document.activeElement); i++) await page.keyboard.press("Tab");
    await page.getByRole("tooltip", { name: "Analyze", exact: true }).waitFor();
    assert.equal(await analyze.evaluate(node => node.matches(":focus-visible")), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    for (let i = 0; i < 12 && !await toggle(page).evaluate(node => node === document.activeElement); i++) await page.keyboard.press("Shift+Tab");
    await page.getByRole("tooltip", { name: "Expand navigation", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.mouse.move(1435, 950);
    for (const route of ["trends", "reports", "compare", "settings", "analyze"]) {
        const link = page.locator(`#sidebar a[data-nav="${route}"]`), name = await link.getAttribute("aria-label");
        await link.hover();
        await page.getByRole("tooltip", { name, exact: true }).waitFor();
        await link.click(); await ready(page);
        assert.equal(await link.getAttribute("aria-current"), "page");
        assert.equal(await link.locator(`svg[data-icon-role="navigation-${route}"]`).isVisible(), true);
        assert.equal(await link.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
        await page.waitForTimeout(200);
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "No stale navigation tooltip");
    }
    if (proofs) await writeFile(path.join(proofs, "width-proof.json"), JSON.stringify({ before, collapsed, fonts }, null, 2));
});

test("a cross-panel sidebar preference does not steal focus from a Settings draft", async t => {
    const { page } = await setup(t);
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    await selectActivityOption(page, "collectionWindow", "7");
    await setCollapsed(page, true);
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
    const navigation = await page.getByRole("navigation", { name: "Main navigation", exact: true }).elementHandle();
    for (const collapsed of [false, true]) {
        await setCollapsed(page, collapsed);
        await nav(page, "trends").focus();
        await page.setViewportSize({ width: 375, height: 900 }); await frames(page);
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        assert.equal(await toggle(page).isVisible(), false);
        assert.equal(await page.locator("#main").evaluate(node => node.getBoundingClientRect().width), await page.locator("body").evaluate(node => node.getBoundingClientRect().width));
        await page.locator("#navigationToggle").tap();
        assert.equal(await navigation.evaluate(node => node === document.querySelector("#navigationDrawer .primary-navigation")), true);
        assert.equal(await nav(page, "analyze").getAttribute("aria-current"), "page");
        assert.equal(await nav(page, "trends").locator(".navigation-label").isVisible(), true);
        for (let index = 0; index < 8; index++) {
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest("#navigationDrawer")), true, "Tab visits the drawer or browser chrome, never hidden/background controls");
        }
        const close = page.getByRole("button", { name: "Close navigation", exact: true });
        await close.focus();
        const help = page.getByRole("tooltip");
        await help.waitFor();
        assert.equal(await help.innerText(), "Close navigation");
        await page.keyboard.press("Escape");
        await help.waitFor({ state: "hidden" });
        assert.equal(await page.locator("#navigationDrawer").isVisible(), true);
        assert.equal(await close.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Escape");
        await page.locator("#navigationDrawer").waitFor({ state: "hidden" });
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        await page.locator("#navigationToggle").tap();
        await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
        const backdropX = await page.locator("#navigationDrawer").evaluate(node => {
            const edge = node.getBoundingClientRect().right, bodyEdge = document.body.getBoundingClientRect().right;
            if (bodyEdge <= edge) throw Error("No exposed backdrop");
            return (edge + bodyEdge) / 2;
        });
        await page.mouse.click(backdropX, 300);
        await page.locator("#navigationDrawer").waitFor({ state: "hidden" });
        assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
        assert.equal(new URL(page.url()).pathname, "/", "Backdrop does not activate background content");
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
    await nav(page, "reports").tap(); await ready(page);
    assert.equal(await nav(page, "reports").getAttribute("aria-current"), "page", "Touch activates a named rail destination");
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
    assert.equal((await geometry(page)).sidebar.width, 65);
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
                layoutWidth: document.documentElement.getBoundingClientRect().width,
                chartWidth: document.querySelector(".chart-panel").getBoundingClientRect().width,
                headerHeight: header.height, opacity: Number(getComputedStyle(label).opacity),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            });
        });
        window.navigationMotionObserver.observe(rail);
    });
    const scene = await page.locator("#chart .flat-comparison").elementHandle(), route = page.url();
    const reads = requests.filter(url => url === "/api/snapshot").length;
    const samples = [];
    for (const collapsed of [true, false]) {
        const start = await page.locator("#sidebar").evaluate(rail => {
            window.navigationMotionFrames = [];
            return { time: performance.now(), width: rail.getBoundingClientRect().width };
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
            assert.ok(Math.abs(frame.mainWidth + frame.width - frame.layoutWidth) < 1, "Sidebar and main fill the layout viewport");
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
        const rail = document.getElementById("sidebar");
        const before = rail.getBoundingClientRect().width;
        node.click();
        return { before, after: rail.getBoundingClientRect().width };
    });
    assert.ok(Math.abs(reversal.before - reversal.after) < 1, "Rapid reversal starts at the current rendered width");
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "true");
    assert.equal((await geometry(page)).sidebar.width, samples[0].start.width);
    assert.equal(await scene.evaluate(node => node === document.querySelector("#chart .flat-comparison")), true, "No chart remount");
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
    assert.equal(await page.locator("#main").evaluate(node => node.getBoundingClientRect().width), await page.locator("body").evaluate(node => node.getBoundingClientRect().width));
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    await page.locator("#navigationToggle").click();
    assert.equal(await nav(page, "trends").locator(".navigation-label").evaluate(node => Number(getComputedStyle(node).opacity)), 1);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page);
    assert.equal((await geometry(page)).sidebar.width, 65);
    await toggle(page).click();
    await page.emulateMedia({ reducedMotion: "reduce" }); await frames(page);
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await page.locator("#sidebar").getAttribute("data-navigation-moving"), null);
    assert.equal((await geometry(page)).sidebar.width, expanded);
    await toggle(page).click();
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    assert.equal((await geometry(page)).sidebar.width, 65);
    await page.reload(); await ready(page);
    assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getAnimations({ subtree: true }).length), 0, "No entrance animation on reload");
});
