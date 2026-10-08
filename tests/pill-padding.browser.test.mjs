import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, openActivitySessions, selectActivityOption } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport } from "./report-journey-helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_PADDING_PROOFS;
const original = "SYNTHETIC retained request\n  indentation and trailing spaces  \n" +
    "Inspect an invented calendar request without changing evidence or report membership. ".repeat(20);
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();

async function setup(t, hasTouch = true) {
    const row = fixture("padding-request");
    row.userPrompt.text = original;
    row.sourceSessionName = "Synthetic padding example";
    const { context } = await privateFixture(t, [row]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch });
    page.setDefaultTimeout(10000);
    const errors = [], writes = [];
    const status = {
        state: "collecting-on-interval", revision: 1, configVersion: "synthetic-padding-source",
        config: { approved: true, enabled: true, windowDays: 30, pollSeconds: 5,
            appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
        connected: true, cadence: { pollSeconds: 5 }, metrics: {},
        discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
    };
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), collection: status } });
    });
    await page.route("**/api/collection/status", route => route.fulfill({ json: status }));
    await page.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw new Error("No real clipboard reads"); },
            async writeText(text) { window.syntheticCopies.push(text); },
        } });
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []);
        assert.ok(writes.every(url => ["/api/snapshot", "/api/collection/status", "/api/evaluation/automatic/summary", "/api/assessment/detail", "/api/assessment/overview", "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview"].includes(url)),
            "Only isolated synthetic report actions; no collection/config/review-label/recording writes");
    });
    return { page, url: runtime.url };
}

async function measure(locator) {
    return locator.evaluate(root => {
        const style = getComputedStyle(root), before = getComputedStyle(root, "::before"), box = root.getBoundingClientRect();
        const pseudo = before.content !== "none" && before.position === "absolute" && before.zIndex === "-1";
        const paint = pseudo ? before : style;
        const inset = side => pseudo ? parseFloat(before[side]) || 0 : 0;
        const edge = { left: box.left + inset("left"), right: box.right - inset("right"),
            top: box.top + inset("top"), bottom: box.bottom - inset("bottom") };
        const rects = [], texts = [], icons = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.textContent.trim() || !parent.checkVisibility() || parent.closest(".visually-hidden")) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const parts = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
            rects.push(...parts); texts.push(...parts);
        }
        for (const node of root.querySelectorAll("svg,input[type=checkbox],.report-step-number")) {
            if (node.checkVisibility()) { const rect = node.getBoundingClientRect(); rects.push(rect); icons.push(rect); }
        }
        const radius = Math.min(parseFloat(paint.borderTopLeftRadius), (edge.right - edge.left) / 2, (edge.bottom - edge.top) / 2);
        // A line's outer corners can cross a capsule even when its rectangular padding is nonzero.
        const curveInset = y => {
            const distance = Math.min(y - edge.top, edge.bottom - y);
            return distance >= radius ? 0 : radius - Math.sqrt(Math.max(0, radius ** 2 - (radius - distance) ** 2));
        };
        function background(node) {
            if (!node) return "rgb(255, 255, 255)";
            const s = getComputedStyle(node), b = getComputedStyle(node, "::before");
            if (b.content !== "none" && b.zIndex === "-1" && b.backgroundColor !== "rgba(0, 0, 0, 0)") return b.backgroundColor;
            return s.backgroundColor === "rgba(0, 0, 0, 0)" ? background(node.parentElement) : s.backgroundColor;
        }
        const focus = root.matches(":focus-visible") || root.matches(":has(:focus-visible)");
        const ring = style.outlineStyle === "none" ? before : style;
        return {
            width: box.width, height: box.height, font: style.fontSize, weight: style.fontWeight,
            layered: pseudo, outerFill: style.backgroundColor,
            paintHeight: edge.bottom - edge.top, padding: style.padding, radius: paint.borderRadius,
            left: Math.min(...rects.map(r => r.left - edge.left)), right: Math.min(...rects.map(r => edge.right - r.right)),
            top: Math.min(...rects.map(r => r.top - edge.top)), bottom: Math.min(...rects.map(r => edge.bottom - r.bottom)),
            curve: Math.min(...rects.flatMap(r => [r.top, r.bottom].map(y =>
                Math.min(r.left - edge.left, edge.right - r.right) - curveInset(y)))),
            textLines: texts.length, iconCount: icons.length,
            clipped: rects.some(r => r.left < edge.left - .5 || r.right > edge.right + .5 || r.top < edge.top - .5 || r.bottom > edge.bottom + .5),
            ellipsis: !!root.querySelector(".select-value") && getComputedStyle(root.querySelector(".select-value")).textOverflow === "ellipsis"
                && root.querySelector(".select-value").scrollWidth > root.querySelector(".select-value").clientWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
            decoration: style.textDecorationLine, focus, outlineWidth: parseFloat(ring.outlineWidth), outline: ring.outlineColor,
            color: style.color, fill: background(root), outside: background(root.parentElement),
        };
    });
}

function padded(row, label, { horizontal = 12, vertical = 2, curve = 2, target = 44 } = {}) {
    if (row.layered) assert.equal(row.outerFill, "rgba(0, 0, 0, 0)", `${label}: only the inset face paints, never the larger target`);
    assert.ok(row.left >= horizontal - .6 && row.right >= horizontal - .6,
        `${label}: painted horizontal insets ${row.left}/${row.right}, expected ${horizontal}`);
    assert.ok(row.top >= vertical - .6 && row.bottom >= vertical - .6,
        `${label}: painted vertical insets ${row.top}/${row.bottom}, expected ${vertical}`);
    assert.ok(row.curve >= curve - .6, `${label}: text/icon-to-curved-edge clearance ${row.curve}`);
    assert.ok(row.height >= target, `${label}: ${target}px target`);
    assert.equal(row.clipped, false, `${label}: full label within paint`);
    assert.equal(row.ellipsis, false, `${label}: no truncated action label`);
    assert.ok(row.overflow <= 1, `${label}: no page overflow`);
    assert.ok(contrast(row.color, row.fill) >= 4.5, `${label}: readable paired ink`);
    if (row.focus) {
        assert.ok(row.outlineWidth >= 2, `${label}: keyboard focus`);
        assert.ok(contrast(row.outline, row.outside) >= 3, `${label}: meaningful focus contrast`);
    }
}

async function save(name, data) {
    if (proofs) await writeFile(path.join(proofs, name + ".json"), JSON.stringify(data, null, 2));
}

test("real complete and matching-preview Read/Hide controls keep measured padding in pointer and keyboard states", { timeout: 120000 }, async t => {
    const { page, url } = await setup(t), rows = [], failures = [];
    for (const [context, route, selector] of [
        ["complete", "#request?request=padding-request", ".request-original .full-text-toggle"],
        ["matching", "#activity?session=test-session&result=success", ".matched-action .full-text-toggle"],
    ]) {
        await page.goto(url + route); await ready(page); await openActivitySessions(page);
        const control = page.locator(selector).filter({ visible: true }).first();
        assert.equal(await control.count(), 1);
        const id = await control.getAttribute("id"), routeBefore = page.url();
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) for (const expanded of [false, true]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
            await chooseTheme(page, theme);
            if (await control.getAttribute("aria-expanded") !== String(expanded)) await control.click();
            const label = expanded ? "Hide prompt" : "Read prompt";
            assert.equal(await control.textContent(), label);
            if (context === "complete") assert.equal(await control.getAttribute("aria-label"), label);
            for (const state of ["rest", "hover", "pressed", "focus"]) {
                await control.scrollIntoViewIfNeeded();
                await page.mouse.move(0, 0); await control.evaluate(node => node.blur());
                if (["hover", "pressed"].includes(state)) await control.hover();
                if (state === "pressed") await page.mouse.down();
                if (state === "focus") { await control.focus(); await page.keyboard.press("Shift"); }
                const metrics = await measure(control), label = `${context}/${theme}/${width}/${scale}/${expanded}/${state}`;
                rows.push({ context, theme, viewportWidth: width, scale, expanded, state, ...metrics });
                try { padded(metrics, label, { vertical: 8, curve: 6 }); } catch (error) { failures.push(error.message); }
                if (proofs && state === "hover" && width === 1200 && scale === 1) await control.screenshot({ path: path.join(proofs, `${context}-${theme}-${expanded ? "hide" : "read"}.png`) });
                if (state === "pressed") { await page.mouse.move(0, 0); await page.mouse.up(); }
            }
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
            assert.equal(await control.getAttribute("id"), id);
            assert.equal(page.url(), routeBefore);
            assert.equal(await control.locator("button,a,[tabindex]").count(), 0);
            const reader = page.locator('[id="' + await control.getAttribute("aria-controls") + '"]');
            assert.equal(await reader.count(), expanded ? 1 : 0);
            if (expanded) assert.equal(await reader.locator("pre").textContent(), original);
        }
        const events = await control.evaluate(node => {
            window.paddingGestureAbort?.abort();
            window.paddingGestureAbort = new AbortController();
            window.paddingClicks = 0;
            window.paddingGestureEvents = [];
            window.paddingObservedControl = node;
            document.addEventListener("click", event => {
                const target = event.target.closest?.(".full-text-toggle");
                const current = document.getElementById(node.id);
                window.paddingGestureEvents.push({
                    target: { tag: event.target.tagName, id: event.target.id },
                    toggleId: target?.id ?? null, expectedId: node.id,
                    originalConnected: node.isConnected, currentIsOriginal: current === node,
                    x: event.clientX, y: event.clientY, detail: event.detail,
                    expandedAtDispatch: current?.getAttribute("aria-expanded") ?? null,
                });
                if (target?.id === node.id) window.paddingClicks++;
            }, { capture: true, signal: window.paddingGestureAbort.signal });
            return 0;
        });
        let activations = 0;
        for (const gesture of ["edge", "Enter", "Space"]) {
            const open = await control.getAttribute("aria-expanded");
            let point = null;
            if (gesture === "edge") {
                const box = await control.boundingBox();
                point = await control.evaluate((node, box) => {
                    const x = box.x + 4, y = box.y + box.height / 2, hit = document.elementFromPoint(x, y);
                    return { box, x, y, hit: { tag: hit?.tagName, id: hit?.id }, ownsPoint: node.contains(hit) };
                }, box);
                await control.click({ position: { x: 4, y: box.height / 2 } });
            } else { await control.focus(); await page.keyboard.press(gesture); }
            activations++;
            const observed = await control.evaluate(node => ({
                expanded: node.getAttribute("aria-expanded"), clicks: window.paddingClicks,
                focusId: document.activeElement?.id, viewport: { width: innerWidth, height: innerHeight },
                rootFont: getComputedStyle(document.documentElement).fontSize,
                box: node.getBoundingClientRect().toJSON(),
                originalConnected: window.paddingObservedControl.isConnected,
                currentIsOriginal: node === window.paddingObservedControl,
                events: window.paddingGestureEvents,
            }));
            const diagnostic = JSON.stringify({ context, gesture, before: open, point, ...observed });
            assert.equal(observed.clicks, activations, `Exactly one real activation per gesture: ${diagnostic}`);
            assert.notEqual(observed.expanded, open, diagnostic);
            assert.equal(observed.focusId, id, `Reader focus remains on the operated control: ${diagnostic}`);
        }
        assert.equal(await page.evaluate(() => window.paddingClicks), events + 3, "Native edge/Enter/Space each activate exactly once");
        await page.evaluate(() => window.paddingGestureAbort.abort());
    }
    await save("toggle-state-matrix", rows);
    assert.deepEqual(failures, []);
});

test("edge activation reaches the same reader after font reset leaves it above the viewport", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.setViewportSize({ width: 2560, height: 1000 });
    await page.goto(url + "#request?request=padding-request"); await ready(page);
    const control = page.locator(".request-original .full-text-toggle");
    await control.click();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    await page.evaluate(() => {
        document.documentElement.style.fontSize = "100%";
        window.scrollTo(0, document.documentElement.scrollHeight);
    });
    const id = await control.getAttribute("id"), before = await control.boundingBox();
    assert.ok(before.y + before.height < 0, "Reproduce the observed off-viewport reader after the font-size reset.");
    assert.equal(await control.getAttribute("aria-expanded"), "true");
    await control.evaluate(node => {
        window.readerEdgeEvents = [];
        window.readerEdgeOriginal = node;
        node.addEventListener("click", event => {
            const rect = node.getBoundingClientRect();
            window.readerEdgeEvents.push({
                x: event.clientX - rect.left, y: event.clientY - rect.top,
                height: rect.height, focusId: document.activeElement?.id,
            });
        }, { capture: true });
    });
    await control.click({ position: { x: 4, y: before.height / 2 } });
    const result = await control.evaluate(node => ({
        expanded: node.getAttribute("aria-expanded"),
        sameNode: node === window.readerEdgeOriginal && node.isConnected,
        focusId: document.activeElement?.id, events: window.readerEdgeEvents,
    }));
    assert.equal(result.events.length, 1, "The intended offscreen edge action must actually reach the reader once.");
    assert.equal(result.sameNode, true);
    assert.equal(result.expanded, "false");
    assert.equal(result.focusId, id);
    assert.ok(Math.abs(result.events[0].x - 4) <= 1, "Click stays at the original four-pixel left edge.");
    assert.ok(Math.abs(result.events[0].y - result.events[0].height / 2) <= 1, "Click stays at the current vertical center.");
    await save("offscreen-edge-regression", { before, ...result });
});

test("finite painted-control inventory has balanced real content insets across themes, viewports and text enlargement", { timeout: 240000 }, async t => {
    const { page, url } = await setup(t), rows = [], failures = [];
    async function matrix(surface, selectors) {
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
            await chooseTheme(page, theme);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction(() => matchMedia("(max-width:699px)").matches ||
                Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) - document.querySelector("#sidebar").getBoundingClientRect().width) < .01);
            for (const selector of selectors) {
                const control = page.locator(selector).first();
                assert.equal(await control.isVisible(), true, `${surface}/${selector} is actually rendered`);
                const metrics = await measure(control), label = `${surface}/${theme}/${width}/${scale}/${selector}`;
                const padding = selector === ".result-link" ? { horizontal: 8 } : {};
                rows.push({ surface, selector, theme, viewportWidth: width, scale, state: "rest", ...metrics });
                try { padded(metrics, label, padding); } catch (error) { failures.push(error.message); }
                if (width === 1200 && scale === 1 && await control.evaluate(node => node.matches("button,a"))) {
                    for (const state of ["hover", "pressed", "focus"]) {
                        await control.hover();
                        if (state === "pressed") await page.mouse.down();
                        if (state === "focus") { await page.mouse.move(0, 0); await control.focus(); await page.keyboard.press("Shift"); }
                        const next = await measure(control);
                        rows.push({ surface, selector, theme, viewportWidth: width, scale, state, ...next });
                        try {
                            padded(next, label + "/" + state, padding);
                            for (const key of ["width", "height", "font", "left", "right", "top", "bottom"])
                                assert.equal(next[key], metrics[key], `${label}/${state}: stable ${key}`);
                        } catch (error) { failures.push(error.message); }
                        if (state === "pressed") { await page.mouse.move(0, 0); await page.mouse.up(); }
                        await control.evaluate(node => node.blur());
                    }
                }
            }
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 1000 });
    }
    await page.goto(url + "#home"); await ready(page);
    await page.locator("#freshHelp > summary").click();
    await matrix("home", ["#checkActivity", ".fresh-links a:first-child", ".fresh-links a:last-child", "#pageAction", "#dateFilter-control",
        ".view-switch button[aria-pressed=true]", ".view-switch button[aria-pressed=false]", ".percentage-switch button[aria-pressed=true]",
        ".percentage-switch button[aria-pressed=false]", "#outcomeFilter-control"]);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    await matrix("filters", [".filter-chip", "#serviceFilter-control", "#outcomeFilter-control", "#projectFilter-control", "#layerFilter-control"]);
    await navigateMain(page, "activity"); await ready(page); await openActivitySessions(page);
    await page.locator("#activitySearch").fill("Synthetic"); await page.waitForTimeout(350);
    await page.locator(".request-row input").first().check();
    await matrix("activity", [".session-toggle", ".result-link", ".request-row .full-text-toggle", "#activityClearSelection", "#clearActivitySearch"]);
    await page.locator(".request-link").first().click(); await ready(page);
    await matrix("request", [".request-original .full-text-toggle", ".request-actions button", "#contextReturn a", "#resetView"]);
    await navigateMain(page, "reports"); await ready(page);
    await chooseReportScope(page, "all");
    await matrix("report-requests", [".report-step[aria-current=step]", ".report-step:disabled", ".report-stage-actions button"]);
    await reportContents(page);
    await matrix("report-contents", [".format-choices label", "#exportBtn", ".report-step[aria-current=step]"]);
    await page.locator('[name=promptMode][value=none]').check();
    await scanReport(page);
    await matrix("report-review", ["#reportReviewBody .dialog-actions button"]);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Complete disclosure review", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await matrix("report-save", ["#reportSaveBody button"]);
    await page.getByRole("button", { name: "Confirm local export", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    await matrix("report-saved", [".report-downloads button"]);
    await navigateMain(page, "settings"); await ready(page);
    await matrix("settings-connection", ["#editSource", "#pauseCollection", "#collectNow"]);
    await page.locator("#editSource").click();
    await matrix("settings-source-draft", ["#connectCollection", "#cancelSource"]);
    await page.locator("#cancelSource").click();
    await navigateSettings(page, "collection");
    await matrix("settings-preferences", ["#collectionWindow-control", "#collectionCadence-control", "#saveCollection", "#cancelPreferences"]);
    await page.locator("#settingsSearch").fill("collection");
    await matrix("settings-search", ["#clearSettingsSearch"]);
    await save("family-responsive-matrix", rows);
    assert.deepEqual(failures, []);
});

test("control-state comparisons wait for the actual sidebar offset after font-driven container reflow", async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "#settings?section=collection"); await ready(page);
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) - document.querySelector("#sidebar").getBoundingClientRect().width) < .01);
    const pending = await page.evaluate(() => {
        document.documentElement.style.fontSize = "100%";
        return {
            offset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")),
            rail: document.querySelector("#sidebar").getBoundingClientRect().width,
            width: document.querySelector("#collectionWindow-control").getBoundingClientRect().width,
        };
    });
    assert.notEqual(pending.offset, pending.rail, "The font change genuinely precedes ResizeObserver delivery.");
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) - document.querySelector("#sidebar").getBoundingClientRect().width) < .01);
    const control = page.locator("#collectionWindow-control"), before = await measure(control);
    await control.hover();
    const after = await measure(control);
    for (const key of ["width", "height", "font", "left", "right", "top", "bottom"]) assert.equal(after[key], before[key], `Settled hover cannot change ${key}`);
    assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width"))), pending.rail);
    t.diagnostic(JSON.stringify({ pending, settledWidth: before.width, hoverWidth: after.width }));
});

test("narrow embedded request reader keeps padding and focus independently of its wide host", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.setViewportSize({ width: 2560, height: 1000 });
    await page.setContent(`<iframe title="Synthetic narrow reader" src="${url}#request?request=padding-request" style="width:375px;height:900px;border:0"></iframe>`);
    const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
    await ready(frame);
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await frame.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(frame, theme);
        const control = frame.locator(".request-original .full-text-toggle");
        for (const expanded of [false, true]) {
            if (await control.getAttribute("aria-expanded") !== String(expanded)) await control.click();
            await control.focus(); await page.keyboard.press("Shift");
            padded(await measure(control), `iframe/${theme}/${scale}/${expanded}`, { vertical: 8, curve: 6 });
            assert.equal(await control.evaluate(node => node.matches(":focus-visible")), true);
        }
    }
});

test("nested icon-only report help retains its deliberate desktop size and circular shape", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, false);
    await page.goto(url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await scanReport(page);
    const help = page.locator("#reportReviewBody .dialog-actions .ux-help").first();
    assert.equal(await help.isVisible(), true);
    for (const state of ["rest", "hover", "focus"]) {
        if (state === "hover") await help.hover();
        if (state === "focus") { await help.focus(); await page.keyboard.press("Shift"); }
        const metrics = await help.evaluate(node => {
            const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { width: rect.width, height: rect.height, padding: style.padding, radius: style.borderRadius };
        });
        assert.deepEqual(metrics, { width: 40, height: 40, padding: "4px", radius: "999px" }, state);
    }
});

test("all format-label peers grow together without trading away padding or help target geometry", { timeout: 60000 }, async t => {
    const { page, url } = await setup(t, false), matrix = [], failures = [];
    await page.goto(url + "#reports"); await ready(page);
    await chooseReportScope(page, "all"); await reportContents(page);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) for (const checked of [false, true]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await chooseTheme(page, theme);
        await page.locator('.format-choices input[value="markdown"]').setChecked(checked);
        const peers = await page.locator(".format-choices label").evaluateAll(labels => labels.map(node => {
            const box = node.getBoundingClientRect(), style = getComputedStyle(node);
            const help = node.parentElement.querySelector(".ux-help").getBoundingClientRect();
            return { format: node.querySelector("input").value, width: box.width, height: box.height,
                padding: style.padding, helpWidth: help.width, helpHeight: help.height };
        }));
        matrix.push({ theme, width, scale, checked, peers });
        try {
            for (const key of ["width", "height"])
                assert.ok(Math.max(...peers.map(row => row[key])) - Math.min(...peers.map(row => row[key])) < 1,
                    `${theme}/${width}/${scale}: equal format ${key}: ${JSON.stringify(peers)}`);
            for (const row of peers) {
                const helpSize = width <= 600 ? 44 : 40;
                assert.equal(row.helpWidth, helpSize); assert.equal(row.helpHeight, helpSize);
                const control = page.locator(`.format-choices label:has(input[value="${row.format}"])`);
                padded(await measure(control), `${theme}/${width}/${scale}/${row.format}`, { vertical: 4 });
            }
        } catch (error) { failures.push(error.message); }
    }
    await save("format-peer-matrix", matrix);
    assert.deepEqual(failures, []);
});

test("long labels wrap inside their native paint and focus outline without separating icons or chevrons", { timeout: 120000 }, async t => {
    const { page, url } = await setup(t), rows = [], failures = [];
    await page.goto(url + "#home"); await ready(page);
    await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
    const selectors = ["#pageAction", ".filter-chip", ".view-switch button"];
    await page.evaluate(() => {
        const label = "Ausgewählte Anfragen vollständig anzeigen und überprüfen";
        document.querySelector("#pageAction").lastChild.textContent = label;
        const chip = document.querySelector(".filter-chip");
        [...chip.childNodes].find(node => node.nodeType === Node.TEXT_NODE).textContent = label;
        document.querySelector(".view-switch button").textContent = label;
    });
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await chooseTheme(page, theme);
        for (const selector of selectors) {
            const node = page.locator(selector).first();
            await node.focus(); await page.keyboard.press("Shift");
            const metrics = await measure(node);
            rows.push({ selector, theme, scale, ...metrics });
            try { padded(metrics, `${theme}/${scale}/${selector}`); } catch (error) { failures.push(error.message); }
        }
    }
    await save("long-label-matrix", rows);
    assert.deepEqual(failures, []);
});
