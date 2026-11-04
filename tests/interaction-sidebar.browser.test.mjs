import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain, navigateSettings, restoreLegacySearch, revealAnalyzeRecords } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";
import { reportContents } from "./report-journey-helpers.mjs";
import { openPersonalFeedback } from "./assessment-ui-fixtures.mjs";

const proof = process.env.WIRE_SIDEBAR_PROOFS;

function sidebarGeometryCurrent() {
    const root = document.documentElement, narrow = matchMedia("(max-width:699px)").matches;
    return Boolean(document.querySelector("#navigationContent").closest(narrow ? "#navigationDrawer" : "#sidebar"))
        && Boolean(document.querySelector("#shellBrand").closest(narrow ? "#navigationDrawer" : ".app-header"))
        && document.querySelector("#navigationToggle").hidden === !narrow
        && parseFloat(root.style.getPropertyValue("--app-header-height")) === Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height)
        && (narrow || parseFloat(root.style.getPropertyValue("--app-sidebar-width")) === document.querySelector("#sidebar").getBoundingClientRect().width);
}

function sidebarMotionSettled({ selector }) {
    const surface = document.querySelector(selector);
    const owners = selector === "#sidebar" ? [surface, document.querySelector("#shellBrand")] : [surface];
    // Sidebar controllers create WAAPI animations; control CSS feedback has a separate lifetime.
    const animations = owners.flatMap(node => node.getAnimations({ subtree: selector === "#sidebar" }))
        .filter(animation => animation.constructor === Animation);
    return animations.length === 0;
}

async function setup(t, { savedReport = false, touch = false, beforeNavigate, motion = "reduce", sidebarMotion, browserOptions = {} } = {}) {
    const records = Array.from({ length: 18 }, (_, index) => {
        const record = fixture(`sidebar-${index}`);
        record.sourceSessionName = `Invented planning chat ${index}`;
        record.userPrompt = { text: `Find the invented release checklist ${index}. ` + "Keep the original evidence and unresolved decisions together. ".repeat(4),
            status: "full", sourceTimestamp: "2026-09-30T12:00:00Z", sourceEventId: `sidebar-prompt-${index}`,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const reports = createExportController(context);
    if (savedReport) {
        const initial = await loadBoardState(context);
        const preview = await reports.preview("synthetic-sidebar-report", undefined, { promptMode: "none", formats: ["html", "json"] },
            { kind: "selected", revision: initial.revision, scenarioIds: [records[0].scenarioId] });
        await reports.review("synthetic-sidebar-report", preview.previewId, true);
        await reports.confirm("synthetic-sidebar-report", preview.previewId, true);
    }
    const runtime = await startServer(context, reports, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(browserOptions);
    const browserContext = await browser.newContext({ viewport: { width: touch ? 375 : 1440, height: 1000 }, hasTouch: touch, reducedMotion: motion });
    const page = await browserContext.newPage();
    const errors = [], requests = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push(new URL(request.url())));
    await page.addInitScript(() => {
        window.sidebarCopies = [];
        window.sidebarCopyMode = "success";
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            readText() { throw Error("Real clipboard reads are forbidden."); },
            async writeText(text) {
                if (window.sidebarCopyMode === "denied") throw new DOMException("Invented clipboard denial", "NotAllowedError");
                window.sidebarCopies.push(text);
            },
        } });
    });
    t.after(async () => {
        await browser.close();
        await runtime.close();
        for (const action of cleanup) await action();
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => url.origin === new URL(runtime.url).origin), "No off-device requests");
    });
    if (sidebarMotion) await page.addInitScript(value => localStorage.setItem("workiq-evidence.sidebar-motion", value), sidebarMotion);
    await beforeNavigate?.(page);
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime, records, requests, context, errors };
}

test("built-in motion glides both sidebars without changing the native host policy", async t => {
    const { page } = await setup(t, { motion: null,
        browserOptions: { channel: process.platform === "win32" ? "msedge" : undefined },
    });
    const nativeReduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await revealAnalyzeRecords(page);
    const frames = await page.evaluate(async () => {
        const rail = document.querySelector("#sidebar"), panel = document.querySelector("#contextSidebar"), trace = [];
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        async function sample(phase, node, expectedOpen) {
            for (let i = 0; i < 120; i++) {
                await frame();
                trace.push({ phase, open: panel.open, width: rail.getBoundingClientRect().width,
                    x: panel.getBoundingClientRect().x, transform: getComputedStyle(panel).transform });
                if (i > 2 && !node.getAnimations({ subtree: true }).length
                    && (expectedOpen === undefined || panel.open === expectedOpen)) return;
            }
            throw new Error(`${phase} did not settle`);
        }
        for (const phase of ["collapse", "expand"]) {
            document.querySelector("#navigationCollapse").click(); await sample(phase, rail);
        }
        document.querySelector(".request-card-open").click(); await sample("open", panel, true);
        document.querySelector("#closeContextSidebar").click(); await sample("close", panel, false);
        return trace;
    });
    for (const phase of ["collapse", "expand", "open", "close"]) {
        const rail = ["collapse", "expand"].includes(phase);
        const positions = new Set(frames.filter(frame => frame.phase === phase && (rail || frame.open))
            .map(frame => Math.round(rail ? frame.width : frame.x))).size;
        t.diagnostic(JSON.stringify({ phase, nativeReduced, positions }));
        assert.ok(positions >= 3, `${phase}: built-in glide paints at least 3 distinct positions, including when the host requests reduce`);
    }
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), nativeReduced);
});

test("built-in glide covers every sidebar role and drawer without changing saved state", { timeout: 45000 }, async t => {
    const { page, requests, context } = await setup(t, { savedReport: true, motion: null,
        browserOptions: { channel: process.platform === "win32" ? "msedge" : undefined },
    });
    const beforeState = await loadBoardState(context);
    const nativeReduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    const evidence = [];
    async function trace(selector, action, expectedOpen) {
        await page.evaluate(selector => {
            const node = document.querySelector(selector);
            window.preferenceMotion = { running: true, frames: [] };
            const state = window.preferenceMotion;
            function sample() {
                const rect = node.getBoundingClientRect();
                state.frames.push({ x: rect.x, width: rect.width, open: node.open,
                    moving: node.getAnimations().length > 0,
                    transform: getComputedStyle(node).transform, opacity: getComputedStyle(node).opacity });
                if (state.running) requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
        }, selector);
        await action();
        if (expectedOpen !== undefined) await expect(page.locator(selector)).toHaveJSProperty("open", expectedOpen);
        await page.waitForFunction(selector => !document.querySelector(selector).getAnimations().length, selector);
        return page.evaluate(() => { window.preferenceMotion.running = false; return window.preferenceMotion.frames; });
    }
    async function glide(selector, action, expectedOpen, label) {
        const frames = await trace(selector, action, expectedOpen);
        const positions = new Set(frames.filter(frame => frame.moving).map(frame => Math.round(selector === "#sidebar" ? frame.width : frame.x))).size;
        evidence.push({ label, nativeReduced, positions, frames });
        assert.ok(positions >= 3, `${label}: at least 3 painted intermediate positions`);
        assert.ok(frames.filter(frame => frame.moving).every(frame => frame.width > 0 && frame.opacity === "1"), "The moving surface stays painted");
        t.diagnostic(JSON.stringify({ label, nativeReduced, positions }));
    }
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await navigateMain(page, "analyze");
        for (const direction of ["collapse", "expand"]) await glide("#sidebar",
            () => page.locator("#navigationCollapse").click(), undefined, `${theme}/left/${direction}`);
        const link = page.locator(".request-card-open").first();
        await link.scrollIntoViewIfNeeded();
        const before = await link.boundingBox(), width = await page.locator("#main").evaluate(node => node.clientWidth);
        await glide("#contextSidebar", () => link.click(), true, `${theme}/interaction/open`);
        assert.ok(Math.abs((await link.boundingBox()).y - before.y) < 3, "Entrance retains its current card anchor");
        assert.ok(await page.locator("#main").evaluate(node => node.clientWidth) < width - 250);
        await page.locator(".request-card-open").nth(1).click();
        assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getAnimations().length), 0, "Replacement does not replay entrance");
        await link.click();
        // Clicking an off-screen replacement can scroll; Close must keep that newer reading position.
        const returnAnchor = await link.boundingBox();
        await glide("#contextSidebar", () => page.locator("#closeContextSidebar").click(), false, `${theme}/interaction/close`);
        await expect(link).toBeFocused();
        assert.ok(Math.abs((await link.boundingBox()).y - returnAnchor.y) < 3, "Exit retains the latest card anchor");
        await navigateMain(page, "reports");
        await glide("#contextSidebar", () => page.locator(".saved-report-summary").first().click(), true, `${theme}/saved/open`);
        await glide("#contextSidebar", () => page.locator("#closeContextSidebar").click(), false, `${theme}/saved/close`);
        await page.locator("#reportCreateLink").click();
        await page.locator("#reportList input").first().check();
        await glide("#contextSidebar", () => reportContents(page), true, `${theme}/setup/open`);
        await expect(page.locator("#contextSidebarFooter #exportBtn")).toBeVisible();
        await glide("#contextSidebar", () => page.locator("#closeContextSidebar").click(), false, `${theme}/setup/close`);
        await navigateMain(page, "analyze");
        await page.setViewportSize({ width: 375, height: 900 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await glide("#navigationDrawer", () => page.locator("#navigationToggle").click(), true, `${theme}/drawer/open`);
        assert.ok((await page.locator("#closeNavigation").boundingBox()).height >= 44);
        await glide("#navigationDrawer", () => page.keyboard.press("Escape"), false, `${theme}/drawer/close`);
        await expect(page.locator("#navigationToggle")).toBeFocused();
        await page.evaluate(() => document.documentElement.style.fontSize = "");
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
    assert.equal(requests.some(url => /\/api\/(?:preview|export|privacy-review|assessment\/feedback|collection\/configure|evaluation\/run)$/.test(url.pathname)), false);
    assert.deepEqual(await loadBoardState(context), beforeState, "Motion and inspection never change persisted evidence or authority");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "sidebar-role-frames.json"), JSON.stringify(evidence, null, 2));
    }
});

for (const motion of ["no-preference", "reduce"]) test(`sidebar interruption settles its owned motion without canceling control feedback (${motion})`, async t => {
    const { page } = await setup(t, { motion });
    const width = await page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().width);
    await page.locator("#navigationCollapse").evaluate(node => node.addEventListener("click", () => {
        window.sidebarControlFeedback = node.getAnimations().filter(animation => animation instanceof CSSTransition);
        window.sidebarFeedbackStarted = window.sidebarControlFeedback.map(animation => ({
            property: animation.transitionProperty, state: animation.playState }));
    }, { once: true }));
    await page.locator("#navigationCollapse").click();
    assert.equal(await page.evaluate(sidebarMotionSettled, { selector: "#sidebar" }), false);
    const feedback = await page.evaluate(() => window.sidebarFeedbackStarted);
    assert.ok(feedback.every(animation => animation.state !== "paused"), "Real control feedback starts unpaused");
    if (motion === "no-preference") assert.ok(feedback.length > 0, "Exercise real CSS feedback, not a newly manufactured animation");
    else assert.deepEqual(feedback, []);
    assert.ok(await page.evaluate(() => window.sidebarControlFeedback.every(animation => animation.playState !== "paused")),
        "The owned glide leaves other feedback transitions running or naturally finished");
    await page.evaluate(() => dispatchEvent(new Event("resize")));
    await page.waitForFunction(sidebarMotionSettled, { selector: "#sidebar" });
    await expect(page.locator("#sidebar")).not.toHaveAttribute("data-navigation-moving", "");
    await expect(page.locator("#navigationCollapse")).toHaveAttribute("aria-expanded", "false");
    const remaining = await page.evaluate(() => {
        const rail = document.querySelector("#sidebar").getBoundingClientRect();
        return { width: rail.width, mainX: document.querySelector("#main").getBoundingClientRect().x,
            feedback: window.sidebarControlFeedback.map(animation => ({ property: animation.transitionProperty, state: animation.playState })) };
    });
    assert.ok(remaining.width < width - 100, "Resize settles the requested collapsed state");
    assert.ok(Math.abs(remaining.mainX - remaining.width) < 1.1, "The actual main column follows the settled rail");
    assert.ok(remaining.feedback.every(animation => animation.state !== "idle" && animation.state !== "paused"),
        "Sidebar settlement cannot cancel or pause unrelated feedback");
    t.diagnostic(JSON.stringify({ motion, feedback, remaining }));
});

test("built-in motion never accesses the retired preference even when storage rejects it", async t => {
    const { page } = await setup(t, { beforeNavigate: page => page.addInitScript(() => {
        window.motionStorageAttempts = [];
        for (const operation of ["getItem", "setItem", "removeItem"]) {
            const original = Storage.prototype[operation];
            Storage.prototype[operation] = function (...args) {
                if (args[0] === "workiq-evidence.sidebar-motion") {
                    window.motionStorageAttempts.push(operation);
                    throw new DOMException("Synthetic storage denial", "SecurityError");
                }
                return original.apply(this, args);
            };
        }
    }) });
    await navigateMain(page, "settings"); await navigateSettings(page, "display");
    await expect(page.locator("#sidebarMotionPreference")).toHaveCount(0);
    await page.locator("#navigationCollapse").click();
    await page.waitForFunction(sidebarMotionSettled, { selector: "#sidebar" });
    assert.deepEqual(await page.evaluate(() => window.motionStorageAttempts), []);
    await page.reload(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.motionStorageAttempts), []);
});

for (const replace of [false, true]) test(`sidebar close preserves the current anchor ${replace ? "after an off-screen replacement scroll" : "without a replacement scroll"}`, async t => {
    const { page } = await setup(t, { sidebarMotion: "on" });
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.evaluate(node => {
        const box = node.getBoundingClientRect();
        window.scrollBy(0, box.bottom - innerHeight);
    });
    const before = await a.boundingBox();
    await a.click();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    const opened = await a.boundingBox(), beforeReplaceScroll = await page.evaluate(() => scrollY);
    assert.ok(Math.abs(opened.y - before.y) < 3, "Opening preserves the entry anchor");
    if (replace) await b.click();
    await a.click();
    const beforeClose = await a.boundingBox(), afterReplaceScroll = await page.evaluate(() => scrollY);
    assert.ok(Math.abs(opened.y - beforeClose.y - (afterReplaceScroll - beforeReplaceScroll)) < 3,
        "Any moved card position comes from the actual replacement scroll, not sidebar drift");
    if (replace) assert.ok(afterReplaceScroll > beforeReplaceScroll + 100, "The off-screen action exercises newer reading intent");
    else assert.equal(afterReplaceScroll, beforeReplaceScroll);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toHaveAttribute("open", "");
    const closed = await a.boundingBox();
    t.diagnostic(JSON.stringify({ replace, beforeY: before.y, openedY: opened.y,
        beforeCloseY: beforeClose.y, closedY: closed.y, beforeReplaceScroll, afterReplaceScroll }));
    assert.ok(Math.abs(closed.y - beforeClose.y) < 3, "Closing preserves the latest pre-exit anchor");
    if (replace) assert.ok(Math.abs(closed.y - before.y) > 100, "Close must not restore the stale pre-scroll anchor");
    else assert.ok(Math.abs(closed.y - before.y) < 3, "Without new reading intent the original anchor is retained");
    await expect(a).toBeFocused();
});

test("sidebar geometry waits for actual header publication before its baseline", async t => {
    const { page } = await setup(t, { beforeNavigate: page => page.addInitScript(() => {
        const NativeResizeObserver = ResizeObserver;
        window.headerSizeGate = { held: false, pending: [] };
        window.ResizeObserver = class extends NativeResizeObserver {
            constructor(callback) {
                super((entries, observer) => {
                    if (window.headerSizeGate.held && entries.some(entry => entry.target.matches(".app-header,#sidebar"))) {
                        window.headerSizeGate.pending.push(() => callback(entries, observer));
                    } else callback(entries, observer);
                });
            }
        };
    }) });
    await chooseTheme(page, "dark");
    await page.waitForFunction(sidebarGeometryCurrent);
    await page.evaluate(() => {
        window.headerSizeGate.held = true;
        document.documentElement.style.fontSize = "200%";
    });
    await page.waitForFunction(() => window.headerSizeGate.pending.length > 0);
    const sample = () => page.evaluate(() => ({
        published: document.documentElement.style.getPropertyValue("--app-header-height"),
        actual: Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height),
        control: document.querySelector("#navigationCollapse").getBoundingClientRect().toJSON(),
        hovered: document.querySelector("#navigationCollapse").matches(":hover"),
    }));
    const unpublished = await sample();
    assert.notEqual(parseFloat(unpublished.published), unpublished.actual, "The real producer has not yet published the enlarged header");
    assert.equal(await page.evaluate(sidebarGeometryCurrent), false, "The baseline readiness signal must reject unpublished geometry");
    assert.equal(unpublished.hovered, false);
    await page.evaluate(() => {
        window.headerSizeGate.held = false;
        for (const deliver of window.headerSizeGate.pending.splice(0)) deliver();
    });
    await page.waitForFunction(sidebarGeometryCurrent);
    const before = await sample();
    assert.equal(parseFloat(before.published), before.actual);
    assert.equal(before.hovered, false);
    assert.equal(before.control.y - unpublished.control.y, before.actual - parseFloat(unpublished.published),
        "The observed movement comes from header publication, without hover");
    assert.notDeepEqual(before.control, unpublished.control);
    await page.locator("#navigationCollapse").hover();
    const hovered = await sample();
    assert.deepEqual(hovered.control, before.control, "Hover preserves the complete current rectangle, including position");
    await page.locator("#navigationCollapse").focus(); await page.keyboard.press("Shift");
    const focused = await sample();
    assert.deepEqual(focused.control, before.control, "Focus preserves the complete current rectangle, including position");
    t.diagnostic(JSON.stringify({ unpublished, before, hovered, focused }));
});

for (const theme of ["light", "dark"]) test(`sidebar command icons keep separate glyph, target and text geometry across all roles in ${theme}`, { timeout: 45000 }, async t => {
    const { page } = await setup(t, { savedReport: true });
    const directory = process.env.WIRE_SIDEBAR_ICON_PROOFS, evidence = [];
    await page.evaluate(() => {
        window.sidebarCommandClicks = {};
        for (const id of ["navigationCollapse", "navigationToggle", "closeNavigation", "closeContextSidebar"]) {
            document.getElementById(id).addEventListener("click", event => {
                if (event.isTrusted) window.sidebarCommandClicks[id] = (window.sidebarCommandClicks[id] || 0) + 1;
            });
        }
    });
    async function control(selector, label, navigation = false) {
        await page.waitForFunction(() => ["sidebar", "navigationDrawer", "contextSidebar"].every(id =>
            !document.getElementById(id).getAnimations().length));
        const node = page.locator(selector);
        const before = await node.boundingBox();
        await node.hover();
        assert.deepEqual(await node.boundingBox(), before, `${label}: hover cannot change command geometry`);
        await node.focus(); await page.keyboard.press("Shift");
        const metrics = await node.evaluate(node => {
            const rect = node.getBoundingClientRect(), svg = node.querySelector("svg"), box = svg.getBoundingClientRect();
            const style = getComputedStyle(node), svgStyle = getComputedStyle(svg), path = svg.getBBox(), matrix = svg.getScreenCTM();
            const point = (x, y) => new DOMPoint(x, y).matrixTransform(matrix);
            const start = point(path.x, path.y), end = point(path.x + path.width, path.y + path.height);
            const contains = target => target === node || node.contains(target);
            const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
            const clips = [];
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
                if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) clips.push(rect.left - ring >= bounds.left && rect.right + ring <= bounds.right);
                if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) clips.push(rect.top - ring >= bounds.top && rect.bottom + ring <= bounds.bottom);
            }
            return { target: rect.toJSON(), svg: box.toJSON(),
                iconOnly: node.matches(".icon-only,.navigation-collapse,#closeContextSidebar"),
                glyphPath: { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y, strokeWidth: svgStyle.strokeWidth },
                padding: style.padding, lineHeight: style.lineHeight, name: node.getAttribute("aria-label") || node.textContent.trim(),
                focus: node.matches(":focus-visible"), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), focusUnclipped: clips.every(Boolean),
                edgeHits: [[rect.left + 1, rect.top + rect.height / 2], [rect.right - 1, rect.top + rect.height / 2],
                    [rect.left + rect.width / 2, rect.top + 1], [rect.left + rect.width / 2, rect.bottom - 1]].every(([x, y]) => contains(document.elementFromPoint(x, y))),
                outsideHits: [[rect.left - 1, rect.top + rect.height / 2], [rect.right + 1, rect.top + rect.height / 2]]
                    .filter(([x]) => x >= 0 && x < innerWidth).some(([x, y]) => contains(document.elementFromPoint(x, y))),
            };
        });
        assert.deepEqual(metrics.target, { ...metrics.target, ...before }, `${label}: focus cannot change geometry`);
        assert.ok(metrics.target.width >= 44 && metrics.target.height >= 44, `${label}: 44px target`);
        if (metrics.iconOnly) assert.equal(metrics.target.height, 44, `${label}: textless utilities do not inherit a text-line minimum`);
        assert.ok(metrics.svg.x >= metrics.target.x && metrics.svg.right <= metrics.target.right
            && metrics.svg.y >= metrics.target.y && metrics.svg.bottom <= metrics.target.bottom, `${label}: display box stays inside its target`);
        if (navigation) { assert.equal(metrics.svg.width, 24); assert.equal(metrics.svg.height, 24); }
        assert.ok(metrics.name && metrics.focus && metrics.outline !== "none" && metrics.outlineWidth >= 2 && metrics.focusUnclipped,
            `${label}: named keyboard control with unclipped focus`);
        assert.ok(metrics.edgeHits && !metrics.outsideHits, `${label}: the target owns its edges, not its neighbors`);
        evidence.push({ label, ...metrics });
        return metrics;
    }
    async function edgeClick(id) {
        const before = await page.evaluate(id => window.sidebarCommandClicks[id] || 0, id);
        const box = await page.locator("#" + id).boundingBox();
        await page.mouse.click(box.x + 1, box.y + box.height / 2);
        assert.equal(await page.evaluate(id => window.sidebarCommandClicks[id], id), before + 1, `${id}: one edge activation`);
    }
    async function navigation(label) {
        await page.waitForFunction(() => ["sidebar", "navigationDrawer"].every(id => !document.getElementById(id).getAnimations().length));
        const rows = page.locator(".primary-navigation a");
        const before = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
        for (const destination of ["analyze", "reports", "settings"]) await control(`.primary-navigation [data-nav="${destination}"]`, `${label}/${destination}`, true);
        assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON())), before,
            `${label}: focusing one row cannot move its neighbors`);
        const metrics = await rows.evaluateAll(nodes => nodes.map(node => {
            const label = node.querySelector(".navigation-label"), range = document.createRange();
            range.selectNodeContents(label);
            return { target: node.getBoundingClientRect().toJSON(), label: range.getBoundingClientRect().toJSON(),
                labelOpacity: getComputedStyle(label).opacity, gap: getComputedStyle(node).columnGap, lineHeight: getComputedStyle(node).lineHeight };
        }));
        evidence.push({ label, rows: metrics });
    }
    for (const [width, scale] of [[1440, 100], [1440, 200], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
        await chooseTheme(page, theme);
        await page.waitForFunction(sidebarGeometryCurrent);
        const label = `${theme}/${width}/${scale}`;
        if (width >= 700) {
            for (const state of ["expanded", "collapsed"]) {
                if (await page.locator("html").getAttribute("data-navigation") !== state) await edgeClick("navigationCollapse");
                await control("#navigationCollapse", `${label}/${state}/toggle`, true);
                await navigation(`${label}/${state}`);
                const gap = await page.evaluate(() => document.querySelector("#navigationContent").getBoundingClientRect().top
                    - document.querySelector("#navigationCollapse").getBoundingClientRect().bottom);
                assert.equal(gap, 12, "The collapse toolbar keeps its deliberate 12px separation");
            }
            await edgeClick("navigationCollapse");
        } else {
            await control("#navigationToggle", `${label}/drawer-trigger`);
            await edgeClick("navigationToggle");
            await control("#closeNavigation", `${label}/drawer-close`);
            await navigation(`${label}/drawer`);
            const heading = await page.locator(".drawer-heading").evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node.querySelector("h2"));
                return { bounds: node.getBoundingClientRect().toJSON(), title: range.getBoundingClientRect().toJSON(),
                    close: node.querySelector("button").getBoundingClientRect().toJSON(), gap: getComputedStyle(node).gap };
            });
            assert.ok(heading.title.x >= heading.bounds.x && heading.title.right <= heading.bounds.right, "Drawer heading remains intact");
            assert.ok(heading.title.right <= heading.close.x || heading.title.bottom <= heading.close.y, "Wrapped close never overlaps its title");
            evidence.push({ label: `${label}/drawer-heading`, ...heading });
            await edgeClick("closeNavigation");
            await expect(page.locator("#navigationToggle")).toBeFocused();
        }
        for (const role of ["interaction", "saved", "setup"]) {
            if (role === "interaction") {
                await navigateMain(page, "analyze"); await page.locator(".request-card-open").first().click();
            } else {
                await navigateMain(page, "reports");
                if (role === "saved") await page.locator(".saved-report-summary").first().click();
                else {
                    await page.locator("#reportCreateLink").click();
                    await page.locator("#reportList input").first().check();
                    await reportContents(page);
                }
            }
            await control("#closeContextSidebar", `${label}/${role}/close`);
            const header = await page.locator(".context-sidebar-header").evaluate(node => {
                const title = node.querySelector("h2"), button = node.querySelector("button"), css = getComputedStyle(node);
                const range = document.createRange(); range.selectNodeContents(title);
                const text = range.getBoundingClientRect(), target = button.getBoundingClientRect(), bounds = node.getBoundingClientRect();
                return { bounds: bounds.toJSON(), title: title.getBoundingClientRect().toJSON(), text: text.toJSON(), target: target.toJSON(),
                    paddingTop: parseFloat(css.paddingTop), paddingBottom: parseFloat(css.paddingBottom), border: parseFloat(css.borderBottomWidth),
                    bodyY: document.querySelector("#contextSidebarBody").getBoundingClientRect().y, gap: parseFloat(css.columnGap),
                    titleOwnsText: title.contains(document.elementFromPoint(text.x + 2, text.y + text.height / 2)),
                    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
            });
            assert.ok(header.title.right + header.gap <= header.target.x + 1, `${label}/${role}: reserved title/utility separation`);
            assert.ok(Math.abs(header.bounds.height - Math.max(header.title.height, header.target.height)
                - header.paddingTop - header.paddingBottom - header.border) < 1, `${label}/${role}: header height comes only from its command row and intentional padding`);
            assert.ok(Math.abs(header.bodyY - header.bounds.bottom) < 1, `${label}/${role}: no phantom row between header and body`);
            assert.ok(header.titleOwnsText && !header.pageOverflow, `${label}/${role}: utility target does not steal text or cause overflow`);
            evidence.push({ label: `${label}/${role}/header`, ...header });
            if (directory && width === 375 && scale === 200) {
                await mkdir(directory, { recursive: true });
                await page.locator(".context-sidebar-header").screenshot({ path: path.join(directory, `${theme}-${role}-header.png`) });
            }
            await edgeClick("closeContextSidebar");
            await expect(page.locator("#contextSidebar")).not.toHaveAttribute("open", "");
        }
    }
    if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `sidebar-command-geometry-${theme}.json`), JSON.stringify(evidence, null, 2));
    }
    const headers = evidence.filter(entry => entry.label.endsWith("/header"));
    t.diagnostic(JSON.stringify({ measuredControls: evidence.filter(entry => entry.target && entry.svg).length,
        headers: headers.map(({ label, bounds, title, target, paddingTop, paddingBottom, gap }) => ({
            label, rowHeight: bounds.height, titleHeight: title.height, target: [target.width, target.height], paddingTop, paddingBottom, gap })) }));
});

test("sidebar icon-only targets do not inherit text-line height", async t => {
    const { page } = await setup(t, { touch: true });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const evidence = [];
    async function probe(selector, row, neighbor) {
        evidence.push(await page.locator(selector).evaluate(async (node, { row, neighbor }) => {
            const css = node.getAttribute("style");
            const sample = () => ({ target: node.getBoundingClientRect().toJSON(),
                glyph: node.querySelector("svg").getBoundingClientRect().toJSON(),
                minimumHeight: getComputedStyle(node).minHeight, lineHeight: getComputedStyle(node).lineHeight,
                row: document.querySelector(row).getBoundingClientRect().toJSON(),
                neighbor: document.querySelector(neighbor).getBoundingClientRect().toJSON() });
            const before = sample();
            node.style.minHeight = "44px";
            await new Promise(resolve => requestAnimationFrame(resolve));
            const isolated = sample();
            if (css === null) node.removeAttribute("style"); else node.setAttribute("style", css);
            await new Promise(resolve => requestAnimationFrame(resolve));
            return { id: node.id, before, isolated, restored: sample() };
        }, { row, neighbor }));
    }
    await probe("#navigationToggle", ".workspace-toolbar-inner", ".wire-search-entry");
    await page.locator("#navigationToggle").click();
    await page.waitForFunction(sidebarMotionSettled, { selector: "#navigationDrawer" });
    await probe("#closeNavigation", ".drawer-heading", "#drawerBrand");
    await page.locator("#closeNavigation").click();
    for (const row of evidence) {
        assert.equal(row.before.target.height, 44, `${row.id}: no text-line height on the real icon-only target`);
        assert.equal(row.before.target.width, 44);
        assert.equal(row.before.target.height, row.restored.target.height, "The isolated fixture probe restores the real control");
        assert.deepEqual(row.before.row, row.isolated.row, "A 44px minimum adds no phantom toolbar or heading space");
        assert.equal(row.before.glyph.width, row.isolated.glyph.width);
        assert.equal(row.before.glyph.height, row.isolated.glyph.height);
    }
    t.diagnostic(JSON.stringify(evidence));
    const directory = process.env.WIRE_SIDEBAR_ICON_PROOFS;
    if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "sidebar-text-action-probe.json"), JSON.stringify(evidence, null, 2));
    }
});

test("opening during an actual pending overview resumes the retained Analyze summary without recursion", { timeout: 20000 }, async t => {
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    const { page, errors } = await setup(t, { beforeNavigate: page => page.route("**/api/assessment/overview", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held;
            await route.fulfill({ response });
        })();
        deliveries.push(delivery);
        return delivery;
    }) });
    try {
        await restoreLegacySearch(page, "release checklist 0.");
        await pending;
        await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
        await revealAnalyzeRecords(page);
        await page.locator(".request-card-open").first().click();
        assert.deepEqual(errors, [], "Pending overview must not throw during sidebar entry");
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        release(); await Promise.all(deliveries);
        await expect(page.locator("#homeInsights[aria-busy=true]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
        await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
        await expect(page.locator("#pageTitle")).toHaveText("Analyze");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
    } finally { release(); await Promise.all(deliveries); }
});

test("closing while the background overview is pending resumes it after exit cleanup", { timeout: 20000 }, async t => {
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    const { page } = await setup(t, { beforeNavigate: page => page.route("**/api/assessment/overview", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    }) });
    try {
        await restoreLegacySearch(page, "release checklist 0.");
        await pending;
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await revealAnalyzeRecords(page);
        await page.locator(".request-card-open").first().click();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await expect(page.locator("#homeInsights")).toHaveAttribute("aria-busy", "true");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        release(); await Promise.all(deliveries);
        await expect(page.locator("#homeInsights[aria-busy=true]")).toHaveCount(0);
        await expect(page.locator("#homeInsights .assessment-summary")).toHaveCount(1);
        await expect(page.locator("#pageTitle")).toHaveText("Analyze");
    } finally { release(); await Promise.all(deliveries); }
});

for (const action of ["Measure definitions", "Automatic scores"]) test(`an origin ${action} action takes ownership before old sidebar cleanup`, { timeout: 20000 }, async t => {
    const { page } = await setup(t, action === "Automatic scores" ? { beforeNavigate: page =>
        page.route("**/api/evaluation/automatic/summary", async route => {
            const response = await route.fetch(), summary = await response.json();
            await route.fulfill({ json: { ...summary, snapshot: { ...summary.snapshot, state: "paused", reason: "source-changed" } } });
        }) } : {});
    await restoreLegacySearch(page, "release checklist 0.");
    await page.locator("#analyzeReviewDetails>summary").click();
    const trigger = page.locator("#homeInsights").getByRole("button", { name: action, exact: true });
    await expect(trigger).toBeVisible();
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    if (action === "Automatic scores") await page.route("**/api/evaluation/automatic/setup", route => {
        const delivery = (async () => {
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].pause());
        const origin = page.url();
        if (action === "Measure definitions") {
            await trigger.focus();
            await trigger.press("Enter");
        } else {
            await trigger.click();
            await pending;
        }
        await page.locator("#contextSidebar").evaluate(node => { for (const animation of node.getAnimations()) animation.finish(); });
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const dialog = action === "Measure definitions" ? page.locator('dialog[aria-label="Insight details"]')
            : page.locator("dialog.automatic-score-dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(action === "Measure definitions" ? "What these results mean" : "Connect a supported local Copilot source");
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.locator("#requestContent").textContent(), "", "Old private paint is gone before the new owner paints");
        assert.equal(page.url(), origin, "Controller acquisition did not require navigation");
        assert.equal(await page.locator("dialog[open]").count(), 1, "The latest dialog remains the only active surface");
        await expect(dialog.locator("button").first()).toBeFocused();
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, action === "Measure definitions" ? "origin-definitions.png" : "origin-automatic-scores.png") });
        }
    } finally { release(); await Promise.all(deliveries); }
});

test("minimal native card opens an anchored sidebar without replacing the Analyze DOM", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await revealAnalyzeRecords(page);
    const card = page.locator("#activityList>.request-row").first();
    assert.equal(await card.locator('input,button,.card-context,.request-meta,.full-text-toggle').count(), 0);
    assert.equal(await card.getByRole("link").count(), 1);
    await page.evaluate(() => { window.originalActivityList = document.querySelector("#activityList").firstElementChild; });
    const link = card.locator("a");
    const before = await card.boundingBox();
    const mainWidth = await page.locator("#main").evaluate(node => node.clientWidth);
    await page.mouse.click(before.x + before.width / 2, before.y + 20);
    await page.locator("#contextSidebar[open]").waitFor();
    await page.waitForFunction(sidebarMotionSettled, { selector: "#contextSidebar" });
    assert.equal(await page.locator("#homeView").isVisible(), true);
    assert.equal(await page.evaluate(() => window.originalActivityList === document.querySelector("#activityList").firstElementChild), true);
    assert.ok(Math.abs((await card.boundingBox()).y - before.y) <= 3, "Card vertical anchor retained");
    assert.ok(await page.locator("#main").evaluate(node => node.clientWidth) < mainWidth - 250, "Actual main width is reduced");
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.matches(":modal")), false);
    assert.equal(await link.getAttribute("aria-expanded"), "true");
    await page.locator("#closeContextSidebar").click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.originalActivityList === document.querySelector("#activityList").firstElementChild), true);
    assert.equal(await link.evaluate(node => node === document.activeElement), true);
    assert.ok(Math.abs((await card.boundingBox()).y - before.y) <= 3);
    assert.equal(await page.locator("#main").evaluate(node => node.clientWidth), mainWidth);
    await page.goForward();
    await page.locator("#contextSidebar[open]").waitFor();
    await page.goBack();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
});

for (const sidebarMotion of ["system", "on"]) test(`personal feedback stays inline and holds a dirty card switch until discarded (${sidebarMotion})`, { timeout: 30000 }, async t => {
    const { page } = await setup(t, { sidebarMotion });
    await revealAnalyzeRecords(page);
    const first = page.locator(".request-card-open").first(), second = page.locator(".request-card-open").nth(1);
    await first.click();
    await openPersonalFeedback(page);
    assert.equal(await page.locator("dialog[open]").count(), 1, "Only the shared sidebar is open");
    await page.locator("#requestContent .assessment-feedback-dialog").getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value="fail"]').click();
    const original = page.url();
    await second.click();
    assert.equal(page.url(), original, "Dirty switch has not changed route identity");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog select").inputValue(), "fail");
    await page.goBack();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    await expect(page).toHaveURL(original);
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.locator("#requestContent .assessment-feedback-dialog [role=combobox]")).toBeFocused();
    await second.click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    assert.notEqual(page.url(), original);
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
});

test("sidebar adapts the actual columns and remains readable with fixed actions at narrow and doubled text sizes", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    if (proof) await mkdir(proof, { recursive: true });
    const samples = [];
    for (const [theme, width, height, scale, navigation] of [
        ["light", 1440, 1000, 1, "expanded"], ["dark", 1440, 1000, 1, "collapsed"],
        ["dark", 1280, 900, 1, "expanded"], ["light", 820, 720, 1, "expanded"],
        ["dark", 375, 820, 1, "expanded"], ["light", 375, 820, 2, "expanded"],
        ["dark", 420, 820, 2, "expanded"], ["light", 820, 400, 1, "expanded"],
    ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        if (await page.locator("#navigationCollapse").isVisible()
            && await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await revealAnalyzeRecords(page);
        const link = page.locator(".request-card-open").first();
        await link.scrollIntoViewIfNeeded();
        const entry = await link.boundingBox();
        await page.mouse.click(entry.x + entry.width / 2, Math.max(90, entry.y + 20));
        await page.locator("#contextSidebar[open]").waitFor();
        const copy = page.locator('[data-reader-section="prompt"] .ux-copy');
        await copy.click();
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        const measured = await page.evaluate(() => {
            const panel = document.querySelector("#contextSidebar"), body = document.querySelector("#contextSidebarBody");
            const close = document.querySelector("#closeContextSidebar"), footer = document.querySelector("#contextSidebarFooter");
            const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
            return { modal: panel.matches(":modal"), overflow: document.documentElement.scrollWidth - innerWidth,
                panel: rect(panel), close: rect(close), footer: rect(footer), body: rect(body),
                reportActions: [...footer.querySelectorAll("button")].map(rect),
                main: rect(document.querySelector("#main")), documentY: scrollY,
                promptWeight: getComputedStyle(document.querySelector(".request-original pre")).fontWeight,
                promptStyle: getComputedStyle(document.querySelector(".request-original pre")).fontStyle,
                colors: { page: getComputedStyle(panel).backgroundColor, text: getComputedStyle(body).color,
                    key: getComputedStyle(document.querySelector(".reader-facts dt")).color,
                    icon: getComputedStyle(close).color, focus: getComputedStyle(document.documentElement).getPropertyValue("--focus"),
                    edge: getComputedStyle(panel).borderInlineStartColor },
                shadow: getComputedStyle(panel).boxShadow,
                footerFill: getComputedStyle(footer).backgroundColor,
                facts: [...document.querySelectorAll(".reader-facts dt")].map(dt => {
                    const key = getComputedStyle(dt), value = getComputedStyle(dt.nextElementSibling);
                    return [key.fontFamily === value.fontFamily, key.fontSize === value.fontSize, key.fontWeight === value.fontWeight];
                }) };
        });
        assert.ok(measured.overflow <= 1, JSON.stringify(measured));
        assert.equal(measured.promptWeight, "400");
        assert.equal(measured.promptStyle, "normal");
        assert.ok(contrast(measured.colors.text, measured.colors.page) >= 4.5);
        assert.ok(contrast(measured.colors.key, measured.colors.page) >= 4.5);
        assert.ok(contrast(measured.colors.icon, measured.colors.page) >= 3);
        assert.ok(contrast(measured.colors.focus, measured.colors.page) >= 3);
        assert.equal(measured.colors.edge, "rgba(0, 0, 0, 0)", "The ordinary pane perimeter is decorative, not a control boundary");
        assert.notEqual(measured.shadow, "none");
        assert.equal(measured.footerFill, measured.colors.page, "Fixed actions belong to the same pane surface");
        assert.ok(measured.facts.flat().every(Boolean));
        assert.ok(measured.close.width >= 44 && measured.close.height >= 44);
        assert.ok(measured.close.y >= 0 && measured.close.y + measured.close.height <= height);
        assert.ok(measured.footer.y >= measured.body.y + measured.body.height - 1);
        assert.ok(measured.footer.y + measured.footer.height <= height + 1, JSON.stringify(measured));
        assert.ok(measured.body.height >= 80, "Reading space remains usable");
        if (width >= 1280) {
            assert.ok(measured.main.x + measured.main.width <= measured.panel.x + 1, "No desktop overlay");
            assert.ok(Math.abs(measured.reportActions[0].y - measured.reportActions[1].y) <= 1, "The compact desktop footer remains one action row");
        }
        else assert.equal(measured.modal, true);
        const name = `${theme}-${width}-${height}-${scale}-${navigation}`;
        if (proof) {
            await page.screenshot({ path: path.join(proof, name + "-page.png"), fullPage: true });
            await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
        }
        await expect(page.locator('[data-reader-section="activity"] .technical-detail').first()).toBeVisible();
        await openPersonalFeedback(page);
        const beforeScroll = await page.evaluate(() => scrollY);
        await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = node.scrollHeight);
        assert.equal(await page.evaluate(() => scrollY), beforeScroll, "Panel scrolling cannot move the document");
        if (proof) await page.screenshot({ path: path.join(proof, name + "-details.png") });
        samples.push({ theme, width, height, scale, navigation, ...measured });
        await page.locator("#closeContextSidebar").click();
        await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    }
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(samples, null, 2));
});

test("switching restores current disclosure and scroll state while filters dismiss the interaction", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await revealAnalyzeRecords(page);
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.click();
    const first = page.url();
    const disclosure = page.locator('[data-reader-section="activity"]>.reader-section-heading>.reader-section-toggle');
    await disclosure.click();
    await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 220);
    const scroll = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    const reads = requests.filter(url => url.pathname === "/api/snapshot").length;
    await a.click();
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), scroll, "The active card does not reset reading");
    await b.click(); assert.notEqual(page.url(), first);
    await a.click();
    assert.equal(page.url(), first);
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), scroll);
    assert.equal(requests.filter(url => url.pathname === "/api/snapshot").length, reads, "Switching does not collect or reread the source");
    await selectActivityOption(page, "dateFilter", "7");
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.match(page.url(), /#analyze.*range=7/);
});

test("inline feedback recovers an uncertain committed write without replay after switching interactions", { timeout: 30000 }, async t => {
    const { page, context } = await setup(t);
    let writes = 0;
    await page.route("**/api/assessment/feedback", async route => {
        writes++;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("connectionreset");
    });

    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await openPersonalFeedback(page);
    const feedback = page.locator("#requestContent .assessment-feedback-dialog");
    await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value=pass]').click();
    await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
    await expect(feedback.getByRole("button", { name: "Check update result", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
    await expect(page.locator('[data-reader-section="reviews"] .reader-section-notice')).toContainText("check the feedback update");
    await page.locator(".request-card-open").nth(1).click();
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(writes, 1);
    assert.ok(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")));
    await page.getByRole("button", { name: "Check earlier update", exact: true }).click();
    await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
    assert.equal(writes, 1);
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("all personal-feedback dimensions save and withdraw inline, with explicit unsent Cancel", { timeout: 45000 }, async t => {
    const { page, context } = await setup(t);
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    let count = 0;
    async function openFeedback(check) {
        return openPersonalFeedback(page, check);
    }
    async function saved() {
        await expect.poll(async () => (await loadBoardState(context)).personalEvaluation.feedback.records.length).toBe(++count);
        await expect(page.locator("#requestContent .assessment-feedback-dialog:visible")).toHaveCount(0);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator("#requestContent .interaction-insights[aria-busy=true]")).toHaveCount(0);
        if (count % 2 === 1) await expect(page.locator('#requestContent .single-interaction-measures tr[data-origin="user-personal"]')).toHaveCount(1);
        await expect(page.locator('#requestContent .single-interaction-measures [data-origin="automatic-local"]')).toHaveCount(0);
    }
    for (const [check, verdict] of [["semantic-answer-correctness", "pass"], ["answer-support-validity", "fail"], ["action-authorization-compliance", "unassessed"]]) {
        let form = await openFeedback(check);
        await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.locator(`.select-option[data-value="${verdict}"]`).click();
        if (count === 0) {
            await form.getByRole("button", { name: "Cancel", exact: true }).click();
            await page.getByRole("button", { name: "Discard changes", exact: true }).click();
            await openPersonalFeedback(page, check);
            await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
            await page.locator(`.select-option[data-value="${verdict}"]`).click();
        }
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await saved();
        form = await openFeedback(check);
        await expect(form).toContainText("Saved feedback:");
        await form.getByRole("button", { name: "Withdraw feedback", exact: true }).click();
        await saved();
    }
    const records = (await loadBoardState(context)).personalEvaluation.feedback.records;
    assert.deepEqual(records.map(row => row.assessment.checkId), [
        "semantic-answer-correctness", "semantic-answer-correctness", "answer-support-validity", "answer-support-validity",
        "action-authorization-compliance", "action-authorization-compliance",
    ]);
    assert.deepEqual(records.map(row => row.assessment.withdrawn), [false, true, false, true, false, true]);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("contextual automatic-score setup is inline and never grants approval on entry", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestContent [data-automatic-scores]").first().click();
    await expect(page.locator("#requestContent .automatic-score-dialog")).toContainText("Connect a supported local Copilot source");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
    await expect(page.locator('[data-reader-section="reviews"] .reader-section-notice')).toContainText("Close Automatic scores");
    assert.equal(await page.locator("dialog[open]").count(), 1);
    assert.equal(requests.filter(url => /\/(?:approve|revoke|consent\/set|evaluation\/run)$/.test(url.pathname)).length, 0);
    await page.locator("#requestContent .automatic-score-dialog").getByRole("button", { name: "Close automatic scores", exact: true }).click();
    await expect(page.locator("#requestContent .automatic-score-dialog")).toBeHidden();
});

test("inline automatic approval keeps explicit scope and consent fields without a second dialog or submission", { timeout: 30000 }, async t => {
    const { page, requests } = await setup(t);
    await page.route("**/api/evaluation/automatic/setup", route => route.fulfill({ json: {
        schemaVersion: 1, sourceRevision: 7, approvalRevision: 0, minimumSessionAiCredits: 30, snapshot: null,
        source: { sourceConfigRef: "sourceconfig-" + "a".repeat(32), sourceConfigRevision: 1, windowDays: 30 },
        method: { provider: "github-copilot", model: "synthetic-model", rubricId: "wire-recorded-interaction-review", rubricVersion: 1 },
        chats: [{ chatRef: "chat-" + "b".repeat(32), name: "Invented approval chat", outsideWindow: 1, requestGroups: 2, shortId: "invented" }],
    } }));
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await page.locator("#requestContent [data-automatic-scores]").first().click();
    const form = page.locator("#requestContent .automatic-score-dialog");
    const approve = form.getByRole("button", { name: "Approve automatic scores", exact: true });
    await expect(approve).toBeDisabled();
    await form.getByRole("checkbox", { name: /Invented approval chat/ }).check();
    await form.getByLabel("Total assessment allowance", { exact: true }).fill("2");
    await form.getByLabel("Total budget (AI credits)", { exact: true }).fill("30");
    await expect(approve).toBeDisabled();
    await form.getByRole("checkbox", { name: /Allow this evidence/ }).check();
    await expect(approve).toBeEnabled();
    await page.setViewportSize({ width: 375, height: 820 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await approve.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.locator("dialog[open]").count(), 1);
    if (proof) await page.screenshot({ path: path.join(proof, "inline-approval-375-200.png") });
    await page.locator('[data-reader-section="reviews"] .reader-section-toggle').click();
    await expect(page.locator('[data-reader-section="reviews"] .reader-section-toggle')).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
    await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
    await expect(form.getByLabel("Total assessment allowance", { exact: true })).toHaveValue("2");
    await expect(approve).toBeEnabled();
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(requests.filter(url => url.pathname.endsWith("/automatic/approve")).length, 0);
});

test("touch Copy activates once, uses a 44px target and reports clipboard denial inline", { timeout: 30000 }, async t => {
    const { page, records } = await setup(t, { touch: true });
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().tap();
    const copy = page.locator('[data-reader-section="prompt"] .ux-copy');
    const before = await copy.boundingBox();
    assert.ok(before.width >= 44 && before.height >= 44);
    await copy.tap();
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    assert.deepEqual(await copy.boundingBox(), before);
    assert.deepEqual(await page.evaluate(() => window.sidebarCopies), [records[0].userPrompt.text]);
    await page.evaluate(() => window.sidebarCopyMode = "denied");
    await copy.tap();
    await expect(page.locator('[data-reader-section="prompt"] .ux-copy-status.error')).toContainText("permission was denied");
    assert.equal(await page.evaluate(() => window.sidebarCopies.length), 1);
    assert.equal(await page.locator("dialog[open]").count(), 1);
});

test("motion glides only the sidebar and interrupted close settles to the newest card", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
        window.sidebarMotion = [];
        const card = document.querySelector(".request-row"), panel = document.querySelector("#contextSidebar");
        let count = 0;
        function sample() {
            if (panel.open) window.sidebarMotion.push({ cardY: card.getBoundingClientRect().top,
                panelX: panel.getBoundingClientRect().left, transform: getComputedStyle(panel).transform,
                cardTransform: getComputedStyle(card).transform });
        }
        const layout = new ResizeObserver(sample);
        layout.observe(document.querySelector("#main"));
        function tick() {
            if (!panel.getAnimations().length) sample();
            if (++count < 30) requestAnimationFrame(tick);
            else layout.disconnect();
        }
        requestAnimationFrame(tick);
    });
    const box = await a.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.waitForFunction(() => window.sidebarMotion.length >= 15);
    const samples = await page.evaluate(() => window.sidebarMotion);
    assert.ok(samples.some(sample => sample.panelX > samples.at(-1).panelX + 10), "Actual right-edge glide occurs");
    assert.ok(samples.every(sample => Math.abs(sample.cardY - box.y) < 3 && sample.cardTransform === "none"));
    await page.locator("#closeContextSidebar").click();
    const reversingFrom = await page.locator("#contextSidebar").evaluate(async node => {
        const animation = node.getAnimations()[0];
        animation.pause(); await animation.ready; animation.currentTime = 60;
        await new Promise(resolve => requestAnimationFrame(resolve));
        return getComputedStyle(node).transform;
    });
    await b.click();
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].effect.getKeyframes()[0].transform),
        reversingFrom, "A new card reverses from the presented edge instead of snapping closed first");
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
    assert.equal(await page.locator("dialog[open]").count(), 1);
    if (proof) await writeFile(path.join(proof, "motion.json"), JSON.stringify(samples, null, 2));
});

test("soft surfaces preserve functional edges, nav states and Search depth in all four shell states", { timeout: 45000 }, async t => {
    const { page } = await setup(t, { savedReport: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) for (const navigation of ["expanded", "collapsed"]) {
        await chooseTheme(page, theme);
        if (await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await navigateMain(page, "analyze");
        const paint = await page.evaluate(() => {
            const style = selector => getComputedStyle(document.querySelector(selector));
            const active = document.querySelector('.primary-navigation a[aria-current=page]');
            const widgets = [...document.querySelectorAll(".analyze-population,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card")];
            return {
                widgets: widgets.map(node => ({ border: getComputedStyle(node).borderTopColor, shadow: getComputedStyle(node).boxShadow })),
                active: { fill: getComputedStyle(active).backgroundColor, before: getComputedStyle(active, "::before").content,
                    ink: getComputedStyle(active).color, weight: getComputedStyle(active).fontWeight },
                rail: { fill: style("#sidebar").backgroundColor, edge: style("#sidebar").borderRightColor },
                search: { shadow: style("#wireSearch").boxShadow, border: style("#wireSearch").borderTopColor,
                    fill: style("#wireSearch").backgroundColor },
                width: document.querySelector("#main").clientWidth,
                promptSize: style(".request-card-prompt").fontSize,
            };
        });
        assert.equal(paint.widgets.length, 6);
        assert.ok(paint.widgets.every(widget => widget.border === "rgba(0, 0, 0, 0)" && widget.shadow === "none"));
        assert.equal(paint.active.before, "none", "No redundant active-nav stripe");
        assert.notEqual(paint.active.fill, paint.rail.fill);
        assert.equal(paint.active.weight, "600");
        assert.ok(contrast(paint.active.ink, paint.active.fill) >= 4.5);
        assert.equal(paint.rail.edge, "rgba(0, 0, 0, 0)", "Tonal separation replaces the decorative shell frame");
        assert.notEqual(paint.search.shadow, "none", "Search retains its own elevation");
        assert.ok(contrast(paint.search.border, paint.search.fill) >= 3);
        const nav = page.locator('.primary-navigation a[aria-current=page]');
        await nav.focus();
        assert.ok(await nav.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth)) >= 2);
        await page.mouse.move(500, 100);
        await page.locator("#navigationCollapse").hover();
        const hover = await page.locator("#navigationCollapse").evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.down();
        const pressed = await page.locator("#navigationCollapse").evaluate(node => getComputedStyle(node).backgroundColor);
        await page.mouse.move(500, 100); await page.mouse.up();
        assert.notEqual(hover, pressed, "Collapse has distinct hover and pressed feedback without a box");
        await page.locator(".request-card-open").first().click();
        const pane = await page.locator("#contextSidebar").evaluate(node => {
            const css = getComputedStyle(node), header = getComputedStyle(node.querySelector("header"));
            const footer = getComputedStyle(document.querySelector("#contextSidebarFooter"));
            return { fill: css.backgroundColor, shadow: css.boxShadow, edge: css.borderInlineStartColor,
                edgeWidth: css.borderInlineStartWidth, headerFill: header.backgroundColor, headerEdge: header.borderBottomColor,
                footerFill: footer.backgroundColor, footerEdge: footer.borderTopColor };
        });
        assert.notEqual(pane.shadow, "none", "The contextual pane has its own directional elevation");
        assert.equal(pane.fill, paint.rail.fill);
        assert.equal(pane.edge, "rgba(0, 0, 0, 0)");
        assert.equal(pane.edgeWidth, "1px", "Changing perimeter paint preserves the existing box metrics");
        assert.equal(pane.headerFill, "rgba(0, 0, 0, 0)");
        assert.equal(pane.footerFill, pane.fill);
        assert.equal(pane.headerEdge, "rgba(0, 0, 0, 0)");
        assert.equal(pane.footerEdge, "rgba(0, 0, 0, 0)");
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, `pane-${theme}-${navigation}.png`) });
        }
        await page.emulateMedia({ forcedColors: "active" });
        const forcedPane = await page.locator("#contextSidebar").evaluate(node => {
            const css = getComputedStyle(node);
            return { fill: css.backgroundColor, shadow: css.boxShadow, edge: css.borderInlineStartColor,
                headerEdge: getComputedStyle(node.querySelector("header")).borderBottomColor,
                footerEdge: getComputedStyle(document.querySelector("#contextSidebarFooter")).borderTopColor };
        });
        assert.equal(forcedPane.shadow, "none");
        for (const edge of ["edge", "headerEdge", "footerEdge"]) assert.ok(contrast(forcedPane[edge], forcedPane.fill) >= 3);
        if (proof) await page.screenshot({ path: path.join(proof, `pane-forced-${theme}-${navigation}.png`) });
        await page.emulateMedia({ forcedColors: "none" });
        await page.locator("#closeContextSidebar").click();
        await navigateMain(page, "reports");
        assert.equal(await page.locator("#bundles").evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator(".saved-library-row").first()).toBeVisible();
        assert.notEqual(await page.locator(".saved-library-row").first().evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await page.locator("#reportCreateLink").click();
        assert.equal(await page.locator(".report-journey").evaluate(node => getComputedStyle(node).borderTopColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator("#reportList input[type=checkbox]").first()).toBeVisible();
        await page.locator("#reportList input[type=checkbox]").first().check();
        await expect(page.locator("#reportList input[type=checkbox]").first()).toBeChecked();
        await navigateMain(page, "settings");
        assert.equal(await page.locator(".settings-categories").evaluate(node => getComputedStyle(node).borderRightColor), "rgba(0, 0, 0, 0)");
        await expect(page.locator("#saveCollection")).toBeDisabled();
        await expect(page.locator("#cancelPreferences")).toBeDisabled();
        await page.emulateMedia({ forcedColors: "active" });
        const highlighted = await page.locator('.primary-navigation a[aria-current=page]').evaluate(node => ({
            fill: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node).color,
            icon: getComputedStyle(node.querySelector("svg")).color, adjustment: getComputedStyle(node).forcedColorAdjust,
        }));
        assert.equal(highlighted.adjustment, "none");
        assert.equal(highlighted.ink, highlighted.icon);
        assert.ok(contrast(highlighted.ink, highlighted.fill) >= 4.5);
        await page.emulateMedia({ forcedColors: "none" });
        measurements.push({ theme, navigation, ...paint, pane, forcedPane, highlighted });
    }
    for (const theme of ["light", "dark"]) {
        const expanded = measurements.find(row => row.theme === theme && row.navigation === "expanded");
        const collapsed = measurements.find(row => row.theme === theme && row.navigation === "collapsed");
        assert.ok(collapsed.width > expanded.width + 100);
        assert.equal(collapsed.promptSize, expanded.promptSize, "Width is reclaimed without scaling text");
    }
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "soft-surface-states.json"), JSON.stringify(measurements, null, 2));
    }
});

test("four-state panel motion keeps anchors, fixed regions and content replacement coherent", { timeout: 60000 }, async t => {
    const { page } = await setup(t);
    const traces = [];
    const settled = () => page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    for (const theme of ["light", "dark"]) for (const navigation of ["expanded", "collapsed"]) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await chooseTheme(page, theme);
        if (await page.locator("html").getAttribute("data-navigation") !== navigation) await page.locator("#navigationCollapse").click();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await revealAnalyzeRecords(page);
        const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
        await a.scrollIntoViewIfNeeded();
        const entry = await a.boundingBox(), width = await page.locator("#main").evaluate(node => node.clientWidth);
        await page.evaluate(() => {
            const panel = document.querySelector("#contextSidebar"), card = document.querySelector(".request-card-open");
            window.surfaceMotion = { phase: "open", frames: [], running: true };
            const state = window.surfaceMotion;
            function frame(at) {
                const rect = node => node.getBoundingClientRect();
                const panelRect = rect(panel), css = getComputedStyle(panel);
                state.frames.push({ at, phase: state.phase, open: panel.open,
                    x: panelRect.x, width: panelRect.width, cardY: rect(card).y,
                    transform: css.transform, opacity: css.opacity, cardTransform: getComputedStyle(card).transform,
                    headerX: rect(panel.querySelector("header")).x, bodyX: rect(document.querySelector("#contextSidebarBody")).x,
                    footerX: rect(document.querySelector("#contextSidebarFooter")).x, animations: panel.getAnimations().length,
                    mainWidth: document.querySelector("#main").clientWidth,
                    mainRight: rect(document.querySelector("#main")).right });
            }
            // WIRE's layout observer was registered at mount; sample after it compensates reflow.
            const layout = new ResizeObserver(() => { if (state.running) frame(performance.now()); });
            layout.observe(document.querySelector("#main"));
            function tick(at) {
                if (!panel.getAnimations().length) frame(at);
                if (state.running) requestAnimationFrame(tick);
                else layout.disconnect();
            }
            requestAnimationFrame(tick);
        });
        await page.mouse.click(entry.x + entry.width / 2, entry.y + 20);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible(); await settled();
        const panelWidth = await page.locator("#contextSidebar").evaluate(node => node.clientWidth);
        assert.ok(await page.locator("#main").evaluate(node => node.clientWidth) < width - 250);
        const reflow = await page.evaluate(() => {
            const main = document.querySelector("#main").getBoundingClientRect();
            const inside = selector => [...document.querySelectorAll(selector)].filter(node => node.checkVisibility()).every(node => {
                const box = node.getBoundingClientRect();
                return box.left >= main.left && box.right <= main.right + 1;
            });
            const grid = document.querySelector(".analyze-chart-grid");
            return { columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
                widgets: inside("#analyzePopulation,.analyze-chart-main,.analyze-outcome-summary,#percentageCharts .percentage-card"),
                controls: inside("#filters button,#filters input,.percentage-legend-row"),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                headerLayer: Number(getComputedStyle(document.querySelector(".app-header")).zIndex),
                panelLayer: Number(getComputedStyle(document.querySelector("#contextSidebar")).zIndex) };
        });
        assert.equal(reflow.columns, 1, "Widgets stack for the remaining main column");
        assert.ok(reflow.widgets && reflow.controls && !reflow.overflow, "Widgets, filters and legends fit the true remaining column");
        assert.ok(reflow.panelLayer < reflow.headerLayer, "Docked panel stays below the header and Search");
        await page.evaluate(() => window.surfaceMotion.phase = "replace");
        const bBox = await b.boundingBox();
        await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + 20);
        await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
        const aBox = await a.boundingBox();
        await page.mouse.click(aBox.x + aBox.width / 2, aBox.y + 20);
        await expect(page.locator(".request-original pre")).toContainText("checklist 0.");
        await page.evaluate(() => window.surfaceMotion.phase = "close");
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0); await settled();
        await expect(a).toBeFocused();
        assert.ok(Math.abs((await a.boundingBox()).y - entry.y) <= 3);
        assert.equal(await page.locator("#main").evaluate(node => node.clientWidth), width);
        const frames = await page.evaluate(() => { window.surfaceMotion.running = false; return window.surfaceMotion.frames; });
        if (proof) {
            await mkdir(proof, { recursive: true });
            await writeFile(path.join(proof, `panel-motion-${theme}-${navigation}.json`), JSON.stringify({ entry, frames }, null, 2));
        }
        for (const phase of ["open", "close"]) {
            const moving = frames.filter(row => row.phase === phase && row.open && row.animations);
            assert.ok(new Set(moving.map(row => Math.round(row.x))).size >= 3, `${theme}/${navigation}/${phase}: intermediate painted positions`);
            assert.ok(moving.every(row => row.cardTransform === "none" && row.opacity === "1"));
            assert.ok(moving.every(row => Math.abs(row.cardY - entry.y) <= 3),
                `${phase}: card anchor ${entry.y}, observed ${moving.map(row => row.cardY)}`);
            assert.ok(moving.every(row => Math.abs(row.headerX - row.bodyX) <= 1 && Math.abs(row.bodyX - row.footerX) <= 1));
            assert.ok(moving.every(row => row.width >= panelWidth && row.width <= panelWidth + 2), "Panel translates without scaling or morphing");
            assert.ok(new Set(moving.map(row => row.mainWidth)).size >= 3, "The real main column reflows with the sidebar");
            assert.ok(moving.every(row => Math.abs(row.mainRight - row.x) < 2), "Main layout and the painted panel share one edge");
            for (let i = 1; i < moving.length; i++) {
                assert.ok(phase === "open" ? moving[i].x <= moving[i - 1].x + 1 : moving[i].x >= moving[i - 1].x - 1,
                    "One directional glide without bounce");
            }
        }
        assert.ok(frames.filter(row => row.phase === "replace").every(row => row.animations === 0), "No entrance replay on replacement");
        traces.push({ theme, navigation, entryY: entry.y, width, reflow, frames });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".request-card-open").first().press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await settled();
    await page.locator("#closeContextSidebar").press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "four-state-motion.json"), JSON.stringify(traces, null, 2));
    }
});

test("a host reduced-motion change does not cancel built-in contextual glide", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    const link = page.locator(".request-card-open").first();
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.locator("#contextSidebar").evaluate(node => { window.ongoingGlide = node.getAnimations()[0]; });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motion = await page.locator("#contextSidebar").evaluate(async node => {
        const rows = [], animation = window.ongoingGlide;
        while (node.getAnimations().includes(animation)) {
            rows.push(node.getBoundingClientRect().x);
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return rows;
    });
    assert.ok(new Set(motion.map(Math.round)).size >= 3, "The existing glide continues through the controlled host change");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
});

test("owned sidebar history keeps Close, Escape, Back and Forward anchored and restores the caller's scroll mode", { timeout: 45000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const measurements = [];
    for (const mode of ["auto", "manual"]) for (const action of ["Close", "Escape", "Back"]) {
        await page.evaluate(mode => history.scrollRestoration = mode, mode);
        await revealAnalyzeRecords(page);
        const link = page.locator(".request-card-open").first();
        await link.scrollIntoViewIfNeeded();
        const entry = await link.boundingBox();
        await page.mouse.click(entry.x + entry.width / 2, entry.y + 20);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        await page.evaluate(() => {
            window.historyExit = { frames: [], running: true };
            const trace = window.historyExit;
            function sample() {
                const panel = document.querySelector("#contextSidebar");
                trace.frames.push({ open: panel.open, moving: panel.getAnimations().length > 0,
                    cardY: document.querySelector(".request-card-open").getBoundingClientRect().y });
            }
            const layout = new ResizeObserver(() => { if (trace.running) sample(); });
            layout.observe(document.querySelector("#main"));
            function tick() {
                if (!document.querySelector("#contextSidebar").getAnimations().length) sample();
                if (trace.running) requestAnimationFrame(tick);
                else layout.disconnect();
            }
            requestAnimationFrame(tick);
        });
        if (action === "Close") await page.locator("#closeContextSidebar").click();
        else if (action === "Escape") {
            await page.locator("#contextSidebarTitle").focus();
            await page.keyboard.press("Escape");
        } else await page.goBack();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        const frames = await page.evaluate(() => { window.historyExit.running = false; return window.historyExit.frames; });
        assert.ok(frames.some(frame => frame.open && frame.moving));
        assert.ok(frames.every(frame => Math.abs(frame.cardY - entry.y) <= 3), `${mode}/${action}: native restoration moved the card`);
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        await expect(link).toBeFocused();
        await page.goForward();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
        const forwardY = (await link.boundingBox()).y;
        assert.ok(Math.abs(forwardY - entry.y) <= 3, `${mode}/${action}: Forward restores the owned sidebar anchor ${entry.y}, got ${forwardY}`);
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.evaluate(() => history.scrollRestoration), mode);
        measurements.push({ mode, action, entryY: entry.y, frames });
    }
    await page.evaluate(() => history.scrollRestoration = "auto");
    await page.goto(runtime.url + "#request?request=sidebar-0");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#homeView")).toBeVisible();
    assert.ok(page.url().startsWith(runtime.url), "Direct entry closes locally rather than navigating out of WIRE");
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await navigateMain(page, "settings");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await page.evaluate(() => history.go(-2));
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#settingsView")).toBeHidden();
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto", "Skipping the request entry restores the marked origin mode");
    if (proof) {
        await mkdir(proof, { recursive: true });
        await writeFile(path.join(proof, "owned-history-motion.json"), JSON.stringify(measurements, null, 2));
    }
});

test("host media change and newer keyboard intent preserve the current exit owner", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    const link = page.locator(".request-card-open").first();
    await link.click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(link).toBeFocused();
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.evaluate(() => history.scrollRestoration), "auto");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await link.click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").getAnimations().length === 0);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#wireSearch").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page.locator("#wireSearch")).toBeFocused();
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    await page.locator("#wireSearch").press("Escape");
});

test("resizing during entry or exit settles the latest layout without a stale overlay", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    assert.ok(await page.locator("#contextSidebar").evaluate(node => node.getAnimations().length > 0));
    await page.setViewportSize({ width: 375, height: 820 });
    await expect.poll(() => page.locator("#contextSidebar").evaluate(node => node.matches(":modal") && node.getAnimations().length === 0)).toBe(true);
    await expect(page.locator("#closeContextSidebar")).toBeInViewport();
    await page.locator("#closeContextSidebar").click();
    assert.ok(await page.locator("#contextSidebar").evaluate(node => node.getAnimations().length > 0));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert || node.matches(":modal")), false);
    await expect(page.locator(".request-card-open").first()).toBeFocused();
});

for (const sidebarMotion of ["system", "on"]) test(`leaving during a pending feedback receipt neither retains an interactive form nor replays the write (${sidebarMotion})`, { timeout: 30000 }, async t => {
    const { page, context } = await setup(t, { sidebarMotion });
    let release, arrived, writes = 0;
    const held = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/feedback", route => {
        const delivery = (async () => {
            writes++;
            const response = await route.fetch();
            arrived(); await held; await route.fulfill({ response });
        })();
        deliveries.push(delivery); return delivery;
    });
    try {
        await revealAnalyzeRecords(page);
        await page.locator(".request-card-open").first().click();
        await openPersonalFeedback(page);
        const form = page.locator("#requestContent .assessment-feedback-dialog");
        await form.getByRole("combobox", { name: "Your assessment", exact: true }).click();
        await page.locator(".select-option[data-value=pass]").click();
        await form.getByRole("button", { name: "Save feedback", exact: true }).click();
        await pending;
        await page.getByRole("button", { name: "Collapse all sections", exact: true }).click();
        await expect(page.locator(".reader-section-toggle[aria-expanded=false]")).toHaveCount(0);
        await expect(page.locator('[data-reader-section="reviews"] .reader-section-notice')).toContainText("Finish or check");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
        assert.ok(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")));
        release(); await Promise.all(deliveries);
        await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
        assert.equal(writes, 1);
        assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    } finally { release(); await Promise.all(deliveries); }
});

test("report continuation retains choices and returns to the original sidebar with current canonical membership", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await revealAnalyzeRecords(page);
    const card = page.locator(".request-card-open").first();
    await card.click();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await page.locator("#requestReportContinue").click();
    await expect(page.locator("#reportStage1")).toBeVisible();
    const checked = page.locator("#reportList input:checked");
    assert.equal(await checked.count(), 1);
    await expect(checked.locator("xpath=ancestor::article[1]")).toBeFocused();
    await page.goBack();
    await page.locator("#contextSidebar[open]").waitFor();
    await expect(page.locator("#homeView")).toBeVisible();
    await expect(page.locator("#reportsView")).toBeHidden();
    await expect(page.locator("#requestReportContinue")).toBeFocused();
    await page.locator("#requestReportToggle").click();
    await expect(page.locator("#requestReportContinue")).toBeDisabled();
    await page.locator("#closeContextSidebar").click();
    await expect(card).toBeFocused();
});

for (const sidebarMotion of ["system", "on"]) test(`source invalidation scrubs the old prompt, copy getter and held unsent-feedback transition (${sidebarMotion})`, { timeout: 30000 }, async t => {
    const { page, context, records } = await setup(t, { sidebarMotion });
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    const copy = await page.locator('[data-reader-section="prompt"] .ux-copy').elementHandle();
    await openPersonalFeedback(page);
    await page.locator("#requestContent .assessment-feedback-dialog").getByRole("combobox", { name: "Your assessment", exact: true }).click();
    await page.locator('.select-option[data-value=fail]').click();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebarGuard")).toBeVisible();
    const prior = await loadBoardState(context);
    await replaceEvidence(context, () => ({ records: [], importCoverage: prior.importCoverage }));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#requestContent")).toContainText("This interaction is not available");
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
    assert.equal(await page.locator("body").evaluate((node, prompt) => node.textContent.includes(prompt), records[0].userPrompt.text), false);
    await copy.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(await page.evaluate(() => window.sidebarCopies.length), 0, "Detached private getters cannot copy old evidence");
});

for (const sidebarMotion of ["system", "on"]) test(`a delayed interaction read cannot repaint or focus its successor (${sidebarMotion})`, { timeout: 30000 }, async t => {
    const { page } = await setup(t, { sidebarMotion });
    let release, arrived, heldOnce = false;
    const pending = new Promise(resolve => { arrived = resolve; }), held = new Promise(resolve => { release = resolve; });
    const deliveries = [];
    await page.route("**/api/assessment/detail", route => {
        if (heldOnce) return route.continue();
        heldOnce = true;
        const delivered = (async () => {
            const response = await route.fetch();
            arrived(); await held;
            await route.fulfill({ response });
        })();
        deliveries.push(delivered);
        return delivered;
    });
    try {
        await revealAnalyzeRecords(page);
        await page.locator(".request-card-open").first().click();
        await pending;
        await page.locator(".request-card-open").nth(1).click();
        await expect(page.locator("#requestContent .interaction-insights[aria-busy=true]")).toHaveCount(0);
        const before = await page.locator("#requestContent").innerText();
        const focus = await page.evaluate(() => document.activeElement.id);
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await page.locator("#requestContent").innerText(), before);
        assert.equal(await page.evaluate(() => document.activeElement.id), focus);
        await expect(page.locator(".request-original pre")).toContainText("checklist 1.");
    } finally { release(); await Promise.all(deliveries); }
});

test("shared Lucide and screen typography preserve Reports and Settings controls in both themes", { timeout: 45000 }, async t => {
    const { page } = await setup(t, { savedReport: true });
    if (proof) await mkdir(proof, { recursive: true });
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["light", 375, 2], ["dark", 375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await navigateMain(page, "reports");
        const saved = page.locator("#bundleList .saved-report").first();
        if (await saved.getAttribute("open") === null) await saved.locator("summary").click();
        const downloads = page.locator("#bundleList .report-file-action button:visible");
        assert.ok(await downloads.count() >= 2);
        assert.ok((await downloads.evaluateAll(nodes => nodes.map(node => node.textContent.trim()))).every(text => text === ""));
        if (proof) await page.screenshot({ path: path.join(proof, `reports-library-${theme}-${width}-${scale}.png`), fullPage: true });
        await page.locator("#reportCreateLink").click();
        await page.locator("#reportList input[type=checkbox]").first().check();
        const prompt = page.locator("#reportList .full-text-preview").first();
        assert.deepEqual(await prompt.evaluate(node => [getComputedStyle(node).fontWeight, getComputedStyle(node).fontStyle]), ["400", "normal"]);
        if (proof) await page.screenshot({ path: path.join(proof, `reports-picker-${theme}-${width}-${scale}.png`), fullPage: true });
        await navigateMain(page, "settings");
        await navigateSettings(page, "connection");
        assert.equal(await page.locator("#settingsCategoryNav svg").count(), 0, "Settings category links need no ornamental icons");
        await expect(page.locator("#saveCollection")).toBeDisabled();
        await expect(page.locator("#cancelPreferences")).toBeDisabled();
        if (proof) await page.screenshot({ path: path.join(proof, `settings-${theme}-${width}-${scale}.png`), fullPage: true });
        const roles = await page.locator("svg.wire-icon:visible").evaluateAll(nodes => nodes.map(node => ({
            asset: node.dataset.lucideIcon, fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke,
            hidden: node.getAttribute("aria-hidden"), focusable: node.getAttribute("focusable"),
        })));
        assert.ok(roles.length > 0 && roles.every(role => role.asset && role.fill === "none" && role.stroke !== "none" && role.hidden === "true" && role.focusable === "false"));
        assert.equal(await page.locator('[data-fluent-icon],svg.fluent-icon').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});
