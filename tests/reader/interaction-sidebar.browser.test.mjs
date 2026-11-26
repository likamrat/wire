import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, navigateMain, navigateSettings, revealAnalyzeRecords } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";

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

async function setup(t, { savedReport = false, touch = false, beforeNavigate, motion = "reduce", browserOptions = {} } = {}) {
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
    await browserContext.route("**/*", route => new URL(route.request().url()).origin === new URL(runtime.url).origin
        ? route.continue() : route.abort());
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

test("the reader and drawer glide without changing saved reports", { timeout: 45000 }, async t => {
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
        await page.getByRole("button", { name: "View report: Selected interactions", exact: true }).click();
        await expect(page.locator("#savedReportReader")).toBeVisible();
        await expect(page.locator("#contextSidebar")).toBeHidden();
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
        window.sidebarFeedbackCancellations = 0;
        for (const animation of window.sidebarControlFeedback) {
            const cancel = animation.cancel.bind(animation);
            animation.cancel = () => { window.sidebarFeedbackCancellations++; cancel(); };
        }
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
            hovered: document.querySelector("#navigationCollapse").matches(":hover"),
            cancellations: window.sidebarFeedbackCancellations,
            feedback: window.sidebarControlFeedback.map(animation => ({ property: animation.transitionProperty, state: animation.playState })) };
    });
    assert.ok(remaining.width < width - 100, "Resize settles the requested collapsed state");
    assert.ok(Math.abs(remaining.mainX - remaining.width) < 1.1, "The actual main column follows the settled rail");
    assert.equal(remaining.cancellations, 0, "Settlement does not cancel CSS feedback it does not own");
    // The header control now moves out from under the pointer; CSS may retire its old hover transition.
    assert.ok(remaining.feedback.every(animation => animation.state !== "paused" && (animation.state !== "idle" || !remaining.hovered)),
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
    const { page, records } = await setup(t);
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
    if (replace) {
        await b.click();
        await expect(page.locator('[data-reader-section="prompt"] .full-text-content')).toHaveText(records[1].userPrompt.text);
    }
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
        document.querySelector(".app-header .header-inner").style.minHeight = "124px";
    });
    await page.waitForFunction(() => window.headerSizeGate.pending.length > 0);
    const sample = () => page.evaluate(() => ({
        published: document.documentElement.style.getPropertyValue("--app-header-height"),
        actual: Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height),
        control: document.querySelector('#sidebar [data-nav="analyze"]').getBoundingClientRect().toJSON(),
        hovered: document.querySelector('#sidebar [data-nav="analyze"]').matches(":hover"),
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
    await page.locator('#sidebar [data-nav="analyze"]').hover();
    const hovered = await sample();
    assert.deepEqual(hovered.control, before.control, "Hover preserves the complete current rectangle, including position");
    await page.locator('#sidebar [data-nav="analyze"]').focus(); await page.keyboard.press("Shift");
    const focused = await sample();
    assert.deepEqual(focused.control, before.control, "Focus preserves the complete current rectangle, including position");
    t.diagnostic(JSON.stringify({ unpublished, before, hovered, focused }));
});

for (const theme of ["light", "dark"]) test(`sidebar and drawer controls keep their hit targets and keyboard focus in ${theme}`, { timeout: 45000 }, async t => {
    const { page } = await setup(t);
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
        const footerUtility = await node.evaluate(n => n.closest(".footer-utilities") !== null);
        assert.ok(metrics.target.width >= (footerUtility ? 32 : 44) && metrics.target.height >= 44, `${label}: utility hit target`);
        if (metrics.iconOnly) assert.equal(metrics.target.height, 44, `${label}: textless utilities do not inherit a text-line minimum`);
        assert.ok(metrics.svg.x >= metrics.target.x && metrics.svg.right <= metrics.target.right
            && metrics.svg.y >= metrics.target.y && metrics.svg.bottom <= metrics.target.bottom, `${label}: display box stays inside its target`);
        if (navigation) {
            assert.ok(metrics.svg.width >= 18 && metrics.svg.width < metrics.target.width, `${label}: legible glyph inside its independent hit target`);
            assert.equal(metrics.svg.width, metrics.svg.height);
        }
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
        for (const destination of ["analyze", "trends", "reports", "compare", "settings"]) await control(`#navigationContent [data-nav="${destination}"]`, `${label}/${destination}`, true);
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
                assert.ok(gap >= 0, "The navigation links do not overlap the header toggle");
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
        {
            await navigateMain(page, "analyze"); await page.locator(".request-card-open").first().click();
            await control("#closeContextSidebar", `${label}/interaction/close`);
            const header = await page.locator(".context-sidebar-header").evaluate(node => {
                const title = node.querySelector("h2"), actions = [...node.querySelectorAll("button")].filter(item => item.checkVisibility()), css = getComputedStyle(node);
                const range = document.createRange(); range.selectNodeContents(title);
                const text = range.getBoundingClientRect(), target = actions[0].getBoundingClientRect(), bounds = node.getBoundingClientRect();
                return { bounds: bounds.toJSON(), title: title.getBoundingClientRect().toJSON(), text: text.toJSON(), target: target.toJSON(),
                    paddingTop: parseFloat(css.paddingTop), paddingBottom: parseFloat(css.paddingBottom), border: parseFloat(css.borderBottomWidth),
                    bodyY: document.querySelector("#contextSidebarBody").getBoundingClientRect().y, gap: parseFloat(css.columnGap),
                    titleOwnsText: title.contains(document.elementFromPoint(text.x + 2, text.y + text.height / 2)),
                    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
            });
            assert.ok(header.title.right <= header.target.x + 1 || header.title.bottom <= header.target.y + 1, `${label}: title/utility separation`);
            assert.ok(Math.abs(header.bounds.height - Math.max(header.title.height, header.target.height)
                - header.paddingTop - header.paddingBottom - header.border) < 1, `${label}: header height fits its command row`);
            assert.ok(Math.abs(header.bodyY - header.bounds.bottom) < 1, `${label}: no phantom row between header and body`);
            assert.ok(header.titleOwnsText && !header.pageOverflow, `${label}: utility target does not steal text or cause overflow`);
            evidence.push({ label: `${label}/interaction/header`, ...header });
            if (directory && width === 375 && scale === 200) {
                await mkdir(directory, { recursive: true });
                await page.locator(".context-sidebar-header").screenshot({ path: path.join(directory, `${theme}-interaction-header.png`) });
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

test("the outcome opens an anchored reader without replacing the Analyze list", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await revealAnalyzeRecords(page);
    const card = page.locator("#activityList .request-row").first();
    await expect(card.getByRole("button", { name: "Add to report", exact: true })).toBeVisible();
    await expect(card.locator(".card-orientation .request-card-open")).toHaveCount(1);
    await page.evaluate(() => { window.originalActivityList = document.querySelector("#activityList").firstElementChild; });
    const link = card.locator(".request-card-open");
    await link.scrollIntoViewIfNeeded();
    const before = await card.boundingBox();
    const mainWidth = await page.locator("#main").evaluate(node => node.clientWidth);
    await link.click();
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
        await link.click();
        await page.locator("#contextSidebar[open]").waitFor();
        await page.waitForFunction(sidebarMotionSettled, { selector: "#contextSidebar" });
        const copy = page.locator('[data-reader-section="prompt"] .ux-copy');
        await copy.click();
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        const measured = await page.evaluate(() => {
            const panel = document.querySelector("#contextSidebar"), body = document.querySelector("#contextSidebarBody");
            const close = document.querySelector("#closeContextSidebar");
            const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
            return { modal: panel.matches(":modal"), overflow: document.documentElement.scrollWidth - innerWidth,
                panel: rect(panel), close: rect(close), body: rect(body),
                jumpAction: rect(panel.querySelector(".reader-section-jumps .report-draft-trigger")),
                main: rect(document.querySelector("#main")), documentY: scrollY,
                promptWeight: getComputedStyle(document.querySelector(".request-original pre")).fontWeight,
                promptStyle: getComputedStyle(document.querySelector(".request-original pre")).fontStyle,
                colors: { page: getComputedStyle(panel).backgroundColor, text: getComputedStyle(body).color,
                    key: getComputedStyle(document.querySelector(".reader-facts dt")).color,
                    icon: getComputedStyle(close).color, focus: getComputedStyle(document.documentElement).getPropertyValue("--focus"),
                    edge: getComputedStyle(panel).borderInlineStartColor },
                shadow: getComputedStyle(panel).boxShadow,
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
        assert.ok(measured.facts.flat().every(Boolean));
        assert.ok(measured.close.width >= 44 && measured.close.height >= 44);
        assert.ok(measured.close.y >= 0 && measured.close.y + measured.close.height <= height);
        assert.ok(measured.body.y + measured.body.height <= height + 1);
        assert.ok(measured.jumpAction.height >= 44 && measured.jumpAction.width >= 44);
        assert.ok(measured.body.height >= 80, "Reading space remains usable");
        if (width >= 1280) {
            assert.ok(measured.main.x + measured.main.width <= measured.panel.x + 1, "No desktop overlay");
        }
        else assert.equal(measured.modal, true);
        const name = `${theme}-${width}-${height}-${scale}-${navigation}`;
        if (proof) {
            await page.screenshot({ path: path.join(proof, name + "-page.png"), fullPage: true });
            await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
        }
        const call = page.locator(".reader-call-row").first(), toggle = call.locator(".reader-call-toggle");
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await expect(call.locator(".technical-detail")).toContainText("/me/calendarView");
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

test("switching prompts keeps each disclosure with its interaction and does not refetch the list", async t => {
    const { page, requests } = await setup(t);
    await revealAnalyzeRecords(page);
    const a = page.locator(".request-card-open").first(), b = page.locator(".request-card-open").nth(1);
    await a.click();
    const reader = page.locator("#requestContent");
    await expect(reader).toHaveAttribute("data-view-key", "request:sidebar-0");
    const disclosure = page.getByRole("button", { name: "Source details", exact: true });
    await disclosure.click();
    await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 220);
    const reads = requests.filter(url => url.pathname === "/api/snapshot").length;
    await b.click();
    await expect(reader).toHaveAttribute("data-view-key", "request:sidebar-1");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await a.click();
    await expect(reader).toHaveAttribute("data-view-key", "request:sidebar-0");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure).toBeFocused();
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), 220);
    assert.equal(requests.filter(url => url.pathname === "/api/snapshot").length, reads, "Switching does not collect or reread the source");
    await selectActivityOption(page, "dateFilter", "7");
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).pathname, "/");
    await expect(page.locator("#dateFilter")).toHaveValue("7");
});

test("touch Copy activates once, uses a 44px target and reports clipboard denial inline", { timeout: 30000 }, async t => {
    const { page, records } = await setup(t, { touch: true });
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().tap();
    const copy = page.locator('[data-reader-section="prompt"] .ux-copy');
    await page.waitForFunction(sidebarMotionSettled, { selector: "#contextSidebar" });
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
        const card = document.querySelector(".request-card-open"), panel = document.querySelector("#contextSidebar");
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

test("forced colors keep the reader edge, navigation focus and Search usable", async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ forcedColors: "active" });
    const nav = page.locator('#navigationContent [data-nav=analyze]');
    await nav.focus(); await page.keyboard.press("Shift");
    await expect(nav).toBeFocused();
    const active = await nav.evaluate(node => {
        const style = getComputedStyle(node);
        return { ink: style.color, fill: style.backgroundColor, icon: getComputedStyle(node.querySelector("svg")).color,
            outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.equal(active.icon, active.ink); assert.ok(contrast(active.ink, active.fill) >= 4.5);
    assert.notEqual(active.outline, "none"); assert.ok(active.width >= 2);
    await page.locator(".request-card-open").first().press("Enter");
    const pane = page.locator("#contextSidebar");
    await expect(pane).toBeVisible();
    const paint = await pane.evaluate(node => {
        const s = getComputedStyle(node);
        return { fill: s.backgroundColor, edge: s.borderInlineStartColor, shadow: s.boxShadow,
            headerEdge: getComputedStyle(node.querySelector("header")).borderBottomColor };
    });
    assert.equal(paint.shadow, "none");
    for (const edge of [paint.edge, paint.headerEdge]) assert.ok(contrast(edge, paint.fill) >= 3);
    await page.keyboard.press("Escape"); await expect(pane).toBeHidden();
    await page.locator("#wireSearch").focus(); await expect(page.locator("#wireSearch")).toBeFocused();
});

test("four-state panel motion keeps anchors, fixed regions and content replacement coherent", { timeout: 60000 }, async t => {
    const { page, records } = await setup(t);
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
                    animations: panel.getAnimations().length,
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
        assert.ok(reflow.widgets && reflow.controls && !reflow.overflow, "Widgets, filters and legends fit the true remaining column");
        assert.ok(reflow.panelLayer < reflow.headerLayer, "Docked panel stays below the header and Search");
        await page.evaluate(() => window.surfaceMotion.phase = "replace");
        const bBox = await b.boundingBox();
        await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + 20);
        await expect(page.locator(".request-original pre")).toHaveText(records[1].userPrompt.text);
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
            assert.ok(moving.every(row => Math.abs(row.headerX - row.bodyX) <= 1));
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

async function holdReaderGlide(page, attribute) {
    // Acquire the actual glide before a driver round trip can outlast it.
    await page.locator("#contextSidebar").evaluate((node, attribute) => {
        window.ongoingGlide = null;
        const observer = new MutationObserver(() => {
            const glide = node.getAnimations().find(animation =>
                animation.effect.getKeyframes().some(frame => frame.transform));
            if (!node.open || !glide) return;
            observer.disconnect();
            glide.pause();
            glide.currentTime = Number(glide.effect.getTiming().duration) / 4;
            window.ongoingGlide = glide;
        });
        observer.observe(node, { attributes: true, attributeFilter: [attribute] });
    }, attribute);
}

test("a host reduced-motion change does not cancel built-in contextual glide", { timeout: 20000 }, async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await revealAnalyzeRecords(page);
    const link = page.locator(".request-card-open").first();
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    await holdReaderGlide(page, "open");
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await page.waitForFunction(() => window.ongoingGlide?.playState === "paused");
    const panel = page.locator("#contextSidebar");
    const early = await panel.evaluate(node => node.getBoundingClientRect().x);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const motion = await panel.evaluate(async node => {
        const animation = window.ongoingGlide;
        if (!node.getAnimations().includes(animation)) throw Error("The host change cancelled the original glide");
        // Sample real playback in the renderer, not across Playwright round trips.
        const start = node.getBoundingClientRect().x;
        animation.updatePlaybackRate(0.25);
        animation.play();
        let middle;
        do {
            await new Promise(resolve => requestAnimationFrame(resolve));
            middle = node.getBoundingClientRect().x;
        } while (node.getAnimations().includes(animation) && start - middle <= 1);
        animation.updatePlaybackRate(1);
        await animation.finished;
        return { middle, end: node.getBoundingClientRect().x };
    });
    assert.ok(early > motion.middle + 1 && motion.middle > motion.end + 1,
        `The original glide retains intermediate movement: ${early} -> ${motion.middle} -> ${motion.end}`);
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
    const origin = page.locator(".request-card-open").first();
    const inTransit = () => page.waitForFunction(() => {
        const panel = document.querySelector("#contextSidebar");
        if (window.ongoingGlide?.playState !== "paused") return false;
        const dx = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41;
        return dx > 0 && dx < panel.getBoundingClientRect().width;
    });
    await holdReaderGlide(page, "open");
    await origin.click();
    await inTransit();
    await page.setViewportSize({ width: 375, height: 820 });
    await expect.poll(() => page.locator("#contextSidebar").evaluate(node => node.matches(":modal") && node.getAnimations().length === 0)).toBe(true);
    await expect(page.locator("#closeContextSidebar")).toBeInViewport();
    await holdReaderGlide(page, "inert");
    await page.locator("#closeContextSidebar").click();
    await inTransit();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.locator("body").getAttribute("data-context-docked"), null);
    assert.equal(await page.locator("#contextSidebar").evaluate(node => node.inert || node.matches(":modal")), false);
    await expect(origin).toBeFocused();
});

test("removing retained activity clears the open reader and its detached Copy action", async t => {
    const { page, context, records } = await setup(t);
    await revealAnalyzeRecords(page);
    await page.locator(".request-card-open").first().click();
    const copy = await page.locator('[data-reader-section="prompt"] .ux-copy').elementHandle();
    await expect(page.locator(".request-original pre")).toHaveText(records[0].userPrompt.text);
    const prior = await loadBoardState(context);
    await replaceEvidence(context, () => ({ records: [], importCoverage: prior.importCoverage }));
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await expect(page.locator("#unavailableCall")).toContainText("These completed calls are unavailable");
    await expect(page.locator("#contextSidebarGuard")).toBeHidden();
    assert.equal(await page.locator("#requestContent .assessment-feedback-dialog").count(), 0);
    assert.equal(await page.locator("body").evaluate((node, prompt) => node.textContent.includes(prompt), records[0].userPrompt.text), false);
    await copy.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(await page.evaluate(() => window.sidebarCopies.length), 0, "Detached private getters cannot copy old evidence");
});

for (const exit of ["close", "replace"]) test(`a delayed detail response cannot reclaim the reader after ${exit}`, { timeout: 30000 }, async t => {
    const { page, records } = await setup(t);
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
        const first = page.locator('[data-view-key="request:sidebar-0"] .request-card-open');
        const second = page.locator('[data-view-key="request:sidebar-1"] .request-card-open');
        if (exit === "close") {
            await page.locator("#closeContextSidebar").click(); await expect(first).toBeFocused();
        } else {
            await second.click();
            await expect(page.locator(".request-original pre")).toHaveText(records[1].userPrompt.text);
            await expect(page.locator('[data-reader-section="activity"] .reader-section-heading')).toBeFocused();
        }
        release(); await Promise.all(deliveries);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await expect(page.locator("#requestContent")).not.toContainText(records[0].userPrompt.text);
        if (exit === "close") {
            await expect(page.locator("#contextSidebar")).toBeHidden(); await expect(first).toBeFocused();
        } else {
            await expect(page.locator(".request-original pre")).toHaveText(records[1].userPrompt.text);
            await expect(page.locator('[data-reader-section="activity"] .reader-section-heading')).toBeFocused();
        }
    } finally { release(); await Promise.all(deliveries); }
});
