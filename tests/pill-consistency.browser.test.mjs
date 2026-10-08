import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption, revealStoredRefresh } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_PILL_CONSISTENCY_PROOFS;
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();
async function setup(t, touch = false) {
    const cleanup = [], row = fixture("pill-consistency");
    row.sourceSessionName = "Synthetic pill comparison";
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, [row]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: touch ? 375 : 1200, height: 1000 }, hasTouch: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const posts = [], errors = [];
    const status = {
        state: "collecting-on-interval", revision: before.revision, configVersion: "synthetic-pill-source",
        config: { approved: true, enabled: true, windowDays: 30, pollSeconds: 5,
            appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
        connected: true, lastCheckedAt: "2026-10-05T12:00:00Z", cadence: { pollSeconds: 5 }, metrics: {},
        discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
        historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
    };
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), collection: status } });
    });
    await page.route("**/api/collection/status", route => route.fulfill({ json: status }));
    await page.addInitScript(() => {
        const push = history.pushState;
        window.pillRoutes = 0;
        history.pushState = function (...args) { window.pillRoutes++; return push.apply(this, args); };
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status", "/api/assessment/consent"].includes(url)), "Inspecting pills never collects, approves or mutates: " + JSON.stringify(posts));
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home?scope=all"); await ready(page);
    return { page, runtime, context, posts };
}

async function measure(locator) {
    return locator.evaluate(root => {
        function background(node) {
            if (!node) return "rgb(255, 255, 255)";
            const style = getComputedStyle(node), before = getComputedStyle(node, "::before");
            if (before.content !== "none" && before.zIndex === "-1" && before.backgroundColor !== "rgba(0, 0, 0, 0)") return before.backgroundColor;
            return style.backgroundColor === "rgba(0, 0, 0, 0)" ? background(node.parentElement) : style.backgroundColor;
        }
        const style = getComputedStyle(root), before = getComputedStyle(root, "::before"), rect = root.getBoundingClientRect();
        const paint = before.content !== "none" && before.zIndex === "-1" ? before : style;
        const range = document.createRange(); range.selectNodeContents(root);
        return {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height, font: style.fontSize, weight: style.fontWeight, primary: root.matches(".primary"),
            settingsSelect: root.matches(".settings-view .select-trigger"),
            radius: paint.borderRadius, border: paint.borderColor, borderWidth: parseFloat(paint.borderWidth), fill: background(root),
            outside: background(root.parentElement), shadow: paint.boxShadow, decoration: style.textDecorationLine,
            paintHeight: rect.height - (paint === before ? parseFloat(before.top) + parseFloat(before.bottom) : 0),
            focus: root.matches(":focus-visible"), outline: paint.outlineStyle === "none" ? style.outlineColor : paint.outlineColor,
            outlineWidth: Math.max(parseFloat(paint.outlineWidth), parseFloat(style.outlineWidth)),
            overflow: document.documentElement.scrollWidth - innerWidth,
            clipped: [...range.getClientRects()].some(r => r.width && (r.left < rect.left - 1 || r.right > rect.right + 1 || r.bottom > rect.bottom + 1)),
            content: [root, ...root.querySelectorAll("*")].filter(node => node.matches("svg") ||
                [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())).map(node => ({
                color: getComputedStyle(node).color, background: background(node), kind: node.matches("svg") ? "icon" : "text",
            })),
        };
    });
}

function assertPaint(metrics, label, { boundary = true, pill = true } = {}) {
    for (const node of metrics.content) assert.ok(contrast(node.color, node.background) >= (node.kind === "icon" ? 3 : 4.5), `${label}: ${node.kind} contrast`);
    if (boundary) {
        assert.ok(metrics.borderWidth >= 1, `${label}: painted boundary`);
        assert.notEqual(metrics.border, "rgba(0, 0, 0, 0)", `${label}: boundary is not transparent`);
        assert.ok(contrast(metrics.border, metrics.outside) >= 3, `${label}: external boundary ${metrics.border} on ${metrics.outside}`);
        assert.ok(contrast(metrics.border, metrics.fill) >= 3 || contrast(metrics.fill, metrics.outside) >= 3, `${label}: identifiable painted edge`);
    }
    if (metrics.settingsSelect) assert.equal(metrics.radius, "4px", `${label}: Settings uses the reference's rectangular field role`);
    else if (metrics.primary) assert.equal(metrics.radius, "8px", `${label}: primary action has modest corners`);
    else if (pill) assert.ok(parseFloat(metrics.radius) <= 8, `${label}: shared controls are not oversized capsules`);
    assert.equal(metrics.clipped, false, `${label}: full label inside control`);
    assert.ok(metrics.overflow <= 1, `${label}: no page overflow`);
    if (metrics.focus) {
        assert.ok(metrics.outlineWidth >= 2, `${label}: keyboard ring`);
        assert.ok(contrast(metrics.outline, metrics.outside) >= 3, `${label}: focus contrast`);
    }
}

async function inspect(page, selector, theme, matrix, options = {}) {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0); await locator.evaluate(node => node.blur());
    const record = async state => {
        const metrics = await measure(locator);
        assertPaint(metrics, `${theme}/${selector}/${state}`, options);
        matrix.push({ theme, selector, state, ...metrics });
    };
    await record("rest");
    await locator.hover(); await record("hover");
    await page.mouse.down(); await record("pressed");
    await page.mouse.move(0, 0); await page.mouse.up();
    await locator.focus(); await page.keyboard.press("Shift"); await record("focus");
    await locator.evaluate(node => node.blur());
}

test("secondary pills have coherent visible boundaries and paired nested ink in both themes and states", { timeout: 120000 }, async t => {
    const { page } = await setup(t), matrix = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        if (!await page.locator("#freshHelp").evaluate(node => node.open)) await page.locator("#freshHelp > summary").click();
        for (const selector of [".fresh-links a:first-child", ".fresh-links a:last-child", "#pageAction", "#dateFilter-control",
            ".view-switch button[aria-pressed=true]", ".view-switch button[aria-pressed=false]", ".percentage-switch button[aria-pressed=true]",
            ".percentage-switch button[aria-pressed=false]", "#outcomeFilter-control"]) {
            await inspect(page, selector, theme, matrix);
        }
        await inspect(page, "#checkActivity", theme, matrix);
        assert.notEqual((await measure(page.locator("#checkActivity"))).fill, (await measure(page.locator(".fresh-links a").first())).fill, "Primary is stronger than related navigation");
        const selected = await measure(page.locator(".view-switch button[aria-pressed=true]"));
        const unselected = await measure(page.locator(".view-switch button[aria-pressed=false]").first());
        assert.ok(Number(selected.weight) > Number(unselected.weight));
        assert.notEqual(selected.shadow, unselected.shadow, "Selection is not color alone");
        assert.equal(await page.locator(".percentage-legend-row button,.percentage-legend-row .button-link").count(), 0, "Percentage labels are plain native links, never action pills");
        assert.ok(await page.locator(".percentage-label[href]").count() > 0);
        if (proofs) for (const [name, selector] of Object.entries({ tabs: ".view-switch", select: ".period-controls", result: "#resultSummary", percentage: ".percentage-switch" })) {
            await page.locator(selector).screenshot({ path: path.join(proofs, `${name}-${theme}.png`) });
        }
        await selectActivityOption(page, "serviceFilter", "Calendar"); await ready(page);
        await inspect(page, ".filter-chip", theme, matrix);
        if (proofs) await page.locator("#filterChips").screenshot({ path: path.join(proofs, `filter-chips-${theme}.png`) });
        await page.locator(".filter-chip").first().click(); await ready(page);
        await navigateMain(page, "activity"); await ready(page);
        await inspect(page, ".result-link", theme, matrix);
        if (proofs) await page.locator(".recorded-results").first().screenshot({ path: path.join(proofs, `result-links-${theme}.png`) });
        await navigateMain(page, "settings"); await ready(page);
        if (!await page.locator("#settingsCategoryNav a").first().isVisible()) await page.locator("#settingsCategorySummary").click();
        await inspect(page, "#settingsCategoryNav a[aria-current=page]", theme, matrix, { pill: false, boundary: false });
        await inspect(page, '#settingsCategoryNav a[data-category="display"]', theme, matrix, { pill: false, boundary: false });
        for (const selector of ['#settingsCategoryNav a[aria-current=page]', '#settingsCategoryNav a[data-category="display"]']) {
            const nav = await measure(page.locator(selector));
            assert.equal(nav.borderWidth, 0, "Settings categories are quiet navigation rows, not outlined action buttons");
            assert.equal(nav.radius, "6px");
            assert.ok(nav.height >= 44);
        }
        if (proofs) await page.locator("#settingsCategoryNav").screenshot({ path: path.join(proofs, `settings-categories-${theme}.png`) });
        await navigateSettings(page, "collection");
        await inspect(page, "#collectionWindow-control", theme, matrix);
        await navigateMain(page, "home"); await ready(page);
        const chooser = page.locator("#pageAction");
        await chooser.hover();
        await page.evaluate(theme => {
            const value = theme === "light" ? "dark" : "light";
            localStorage.setItem("workiq-evidence.theme", value);
            dispatchEvent(new StorageEvent("storage", { key: "workiq-evidence.theme", newValue: value }));
        }, theme);
        assert.equal(await chooser.evaluate(node => node.matches(":hover")), true);
        const switched = await measure(chooser);
        assertPaint(switched, "theme changed while hovered");
        matrix.push({ theme: `${theme}->opposite`, selector: "#pageAction", state: "theme-switch-hover", ...switched });
    }
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => { await held; await route.fallback(); });
    try {
        await (await revealStoredRefresh(page)).click();
        const primary = page.locator("#checkActivity");
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            assert.equal(await primary.isDisabled(), true, "The actual pending snapshot disables checking");
            await primary.hover();
            const metrics = await measure(primary);
            assertPaint(metrics, `disabled primary/${theme}`, { boundary: false });
            assert.equal(metrics.weight, "600", "Disabling a primary action preserves its strong role and label width");
            assert.equal(await primary.evaluate(node => getComputedStyle(node).cursor), "not-allowed");
            matrix.push({ theme, selector: "#checkActivity", state: "disabled+hover", ...metrics });
        }
    } finally { release(); await ready(page); }
    if (proofs) await writeFile(path.join(proofs, "pill-state-measurements.json"), JSON.stringify(matrix, null, 2));
});

test("Home keeps primary, source context and secondary pills together at all widths and enlarged text", { timeout: 120000 }, async t => {
    const { page } = await setup(t), matrix = [];
    await page.locator("#freshHelp > summary").click();
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await page.keyboard.press("Escape");
        for (const selector of ["#checkActivity", ".fresh-links a:first-child", ".fresh-links a:last-child", "#pageAction", "#dateFilter-control"]) {
            const metrics = await measure(page.locator(selector));
            assertPaint(metrics, `${theme}/${width}/${scale}/${selector}`);
            assert.ok(metrics.height >= 44);
            assert.ok(metrics.x >= 0 && metrics.x + metrics.width <= width + 1);
            matrix.push({ theme, viewportWidth: width, scale, selector, ...metrics });
        }
        const group = await page.locator("#freshActivity").evaluate(node => {
            const box = selector => {
                const rect = node.querySelector(selector).getBoundingClientRect();
                return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width };
            };
            return { primary: box("#checkActivity"), context: box("#freshScope"), links: box(".fresh-links"),
                source: box(".fresh-links a:first-child"), collection: box(".fresh-links a:last-child"),
                gap: getComputedStyle(node.querySelector(".fresh-links")).gap };
        });
        assert.ok(group.primary.y <= group.context.y + 1, "Primary is never pushed below context");
        assert.ok(Math.abs(group.links.x - group.context.x) <= 1 || Math.abs(group.links.x - group.context.right - 16) <= 1,
            "Source group is aligned under or immediately beside context, never separated by leftover width");
        assert.equal(group.gap, "8px");
        assert.ok(group.links.width <= group.source.width + group.collection.width + 9, "Content-sized secondary group");
        if (proofs) await page.locator("#freshActivity").screenshot({ path: path.join(proofs, `home-${theme}-${width}-${scale}x.png`) });
    }
    await page.setViewportSize({ width: 2560, height: 1000 });
    await page.evaluate(() => { document.querySelector("#workspace").style.width = "375px"; });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const metrics = await measure(page.locator(".fresh-links a:last-child"));
        assertPaint(metrics, `narrow panel in wide host/${theme}`);
        const layout = await page.locator(".fresh-controls").evaluate(node => ({
            columns: getComputedStyle(node).gridTemplateColumns.split(" ").length,
            width: node.clientWidth, scroll: node.scrollWidth,
        }));
        assert.equal(layout.columns, 1);
        assert.ok(layout.scroll <= layout.width + 1);
    }
    if (proofs) await writeFile(path.join(proofs, "pill-responsive-measurements.json"), JSON.stringify(matrix, null, 2));
});

test("Source and collection pills keep full native hit targets, one route, Back, keyboard and touch", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t, true);
    const home = runtime.url + "#home?scope=all";
    for (const section of ["connection", "collection"]) for (const gesture of ["edge", "touch", "Enter"]) {
        await page.goto(home); await ready(page);
        if (!await page.locator("#freshHelp").evaluate(node => node.open)) await page.locator("#freshHelp > summary").click();
        const control = page.locator(`.fresh-links a[href*="section=${section}"]`);
        assert.equal(await control.evaluate(node => node.tagName), "A");
        assert.equal(await control.locator("a,button,[tabindex]").count(), 0);
        const before = await page.evaluate(() => window.pillRoutes);
        await control.hover(); await control.focus(); await page.keyboard.press("Shift");
        assert.equal(await page.evaluate(() => window.pillRoutes), before, "Focus/hover do not navigate");
        assert.equal((await measure(control)).decoration, "none");
        if (gesture === "Enter") await page.keyboard.press("Enter");
        else {
            const point = await control.evaluate(node => {
                const rect = node.getBoundingClientRect(), x = rect.x + 4, y = rect.y + rect.height / 2;
                return { x, y, owned: document.elementFromPoint(x, y)?.closest("a") === node };
            });
            assert.equal(point.owned, true, "Painted padding belongs to native anchor");
            if (gesture === "touch") await page.touchscreen.tap(point.x, point.y);
            else await page.mouse.click(point.x, point.y);
        }
        await ready(page);
        assert.equal(await page.evaluate(() => window.pillRoutes), before + 1);
        assert.equal(await page.locator(`[data-settings-section="${section}"]`).isVisible(), true);
        if (section === "connection") {
            assert.equal(await page.locator("#approvedSourceDetails").isVisible(), true);
            assert.equal(await page.locator("#approvedSourceTitle").evaluate(node => node === document.activeElement), true);
        }
        await page.goBack(); await ready(page);
        assert.equal(page.url(), home);
    }
    const select = page.locator("#dateFilter-control");
    await select.focus(); await page.keyboard.press("Space");
    assert.equal(await select.getAttribute("aria-expanded"), "true");
    assert.equal(await select.getAttribute("aria-controls"), "evidence-select-listbox");
    await page.keyboard.press("Escape");
    assert.equal(await select.getAttribute("aria-expanded"), "false");
});

test("Source and collection disclosure keeps its native action row fixed while details expand below", { timeout: 45000 }, async t => {
    const { page, runtime, context, posts } = await setup(t);
    const beforeState = await loadBoardState(context), beforeCollector = await runtime.collector.status();
    const measurements = [], failures = [];
    const summary = page.locator("#freshHelp > summary");
    for (const theme of ["light", "dark"]) for (const width of [1200, 375]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        if (await page.locator("#freshHelp").evaluate(node => node.open)) await summary.click();
        await page.evaluate(() => document.fonts.ready);
        await page.locator("#freshActivity").scrollIntoViewIfNeeded();
        await page.evaluate(() => {
            const box = document.querySelector("#freshActivity").getBoundingClientRect();
            const header = document.querySelector(".app-header").getBoundingClientRect();
            if (box.top < header.bottom || box.bottom > innerHeight) scrollTo(0, Math.max(0, scrollY + box.top - header.bottom - 8));
        });
        await summary.focus();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => {
            const selectors = ["#pageTitle", ".app-header", "#checkActivity", "#freshHelp > summary", "#freshActivity", "#filters"];
            const original = document.querySelector("#freshHelp > summary"), disclosure = document.querySelector("#freshHelp");
            const trace = [];
            let running = true;
            const sample = () => {
                const boxes = Object.fromEntries(selectors.map(selector => {
                    const r = document.querySelector(selector).getBoundingClientRect();
                    return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
                }));
                return { boxes, scrollY, open: disclosure.open, sameNode: original === document.querySelector("#freshHelp > summary"),
                    connected: original.isConnected, focused: document.activeElement === original,
                    basis: getComputedStyle(document.querySelector(".fresh-details")).flexBasis };
            };
            const next = () => { if (running) { trace.push(sample()); requestAnimationFrame(next); } };
            trace.push(sample()); requestAnimationFrame(next);
            window.sourceDisclosureSample = sample;
            window.stopSourceDisclosureTrace = () => { trace.push(sample()); running = false; return trace; };
        });
        const closed = await page.evaluate(() => window.sourceDisclosureSample());
        const check = (actual, label) => {
            for (const selector of ["#pageTitle", ".app-header", "#checkActivity", "#freshHelp > summary"]) {
                if (JSON.stringify(actual.boxes[selector]) !== JSON.stringify(closed.boxes[selector])) {
                    failures.push({ theme, width, scale, label, selector, before: closed.boxes[selector], after: actual.boxes[selector] });
                }
            }
            if (actual.scrollY !== closed.scrollY) failures.push({ theme, width, scale, label, scrollBefore: closed.scrollY, scrollAfter: actual.scrollY });
            assert.ok(actual.sameNode && actual.connected && actual.focused, label);
            assert.ok(actual.boxes["#freshHelp > summary"].height >= 44);
        };
        if (proofs) await page.screenshot({ path: path.join(proofs, `source-closed-${theme}-${width}-${scale}.png`) });
        for (const input of ["pointer", "keyboard"]) {
            if (input === "pointer") await summary.click(); else await page.keyboard.press("Enter");
            await page.waitForFunction(() => document.querySelector("#freshHelp").open);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const open = await page.evaluate(() => window.sourceDisclosureSample());
            check(open, `${input}-open`);
            assert.ok(open.boxes["#freshActivity"].height > closed.boxes["#freshActivity"].height);
            assert.ok(open.boxes["#filters"].y > closed.boxes["#filters"].y, "Downstream content expands naturally.");
            const contents = await page.locator("#freshHelp").evaluate(node => {
                const summary = node.querySelector("summary").getBoundingClientRect();
                const context = node.querySelector(".fresh-context").getBoundingClientRect();
                const button = document.querySelector("#checkActivity").getBoundingClientRect();
                return { below: context.top >= Math.max(summary.bottom, button.bottom),
                    fits: node.scrollWidth <= node.clientWidth + 1, links: [...node.querySelectorAll(".fresh-links a")].map(link => link.getAttribute("href")),
                    checkHit: document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)?.closest("button")?.id === "checkActivity" };
            });
            assert.ok(contents.below && contents.fits && contents.checkHit, JSON.stringify(contents));
            assert.deepEqual(contents.links, ["#settings?section=connection&setting=source-paths", "#settings?section=collection"]);
            assert.match(await page.locator("#freshHelp").innerText(), /does not run Work IQ or Graph queries/);
            if (proofs && input === "pointer") await page.screenshot({ path: path.join(proofs, `source-open-${theme}-${width}-${scale}.png`) });
            if (input === "pointer") await summary.click(); else await page.keyboard.press("Space");
            await page.waitForFunction(() => !document.querySelector("#freshHelp").open);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            check(await page.evaluate(() => window.sourceDisclosureSample()), `${input}-close`);
        }
        const trace = await page.evaluate(() => window.stopSourceDisclosureTrace());
        for (const sample of trace) check(sample, "frame");
        measurements.push({ theme, width, scale, closed, trace });
    }
    const afterState = await loadBoardState(context), afterCollector = await runtime.collector.status();
    assert.deepEqual(afterState.collection, beforeState.collection);
    assert.deepEqual(afterState.personalEvaluation, beforeState.personalEvaluation);
    assert.deepEqual(afterState.evidence, beforeState.evidence);
    assert.equal(afterCollector.lastCheckedAt, beforeCollector.lastCheckedAt);
    assert.ok(posts.every(url => ["/api/snapshot", "/api/collection/status"].includes(url)), "Toggling never runs collection or grants capture.");
    if (proofs) await writeFile(path.join(proofs, "source-disclosure-measurements.json"), JSON.stringify({ measurements, failures }, null, 2));
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 3)));
});
