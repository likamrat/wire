import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WORKIQ_NAV_SIZING_PROOFS;
const routes = ["home", "activity", "reports", "collection-status", "settings"];
const ready = page => page.locator("#workspace[aria-busy=false]").waitFor();
const link = (page, route) => page.locator(`.primary-navigation a[data-nav="${route}"]`);

async function setup(t) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) });
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], posts = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.addInitScript(() => {
        const push = history.pushState;
        window.navigationPushes = 0;
        history.pushState = function (...args) { window.navigationPushes++; return push.apply(this, args); };
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
            assert.ok(posts.every(url => ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview"].includes(url)), "Navigation never collects or changes protected state");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home"); await ready(page);
    return { page, runtime };
}

async function showNavigation(page) {
    await page.waitForFunction(() => {
        const narrow = matchMedia("(max-width:699px)").matches;
        return document.querySelector(".primary-navigation")?.closest(narrow ? "#navigationDrawer" : "#sidebar")
            && document.querySelector("#navigationToggle").hidden === !narrow;
    });
    if (!await page.locator(".primary-navigation").isVisible()) await page.locator("#navigationToggle").click();
}

async function measure(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.locator(".primary-navigation").evaluate(nav => {
        const box = rect => Object.fromEntries(["x", "y", "width", "height"].map(key => [key, rect[key]]));
        return [...nav.querySelectorAll("a")].map(node => {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(node.querySelector(".navigation-label"));
            const label = range.getBoundingClientRect(), lines = [...range.getClientRects()];
            const sizing = ["padding", "borderWidth", "borderRadius", "fontSize", "fontWeight", "lineHeight", "minHeight", "gap", "whiteSpace", "overflowWrap"];
            return { route: node.dataset.nav, name: node.textContent, rect: box(rect), label: box(label), lines: lines.map(box),
                metrics: Object.fromEntries(sizing.map(key => [key, style[key]])),
                fill: style.backgroundColor, ink: style.color, border: style.borderColor, shadow: style.boxShadow,
                outside: getComputedStyle(nav.closest("aside,dialog")).backgroundColor,
                focus: node.matches(":focus-visible"), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor,
                clipped: lines.some(line => line.left < rect.left || line.right > rect.right || line.top < rect.top || line.bottom > rect.bottom),
                decoration: style.textDecorationLine, current: node.getAttribute("aria-current"),
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
    });
}

function stable(before, after, label) {
    for (const row of before) {
        const next = after.find(item => item.route === row.route);
        assert.deepEqual(next.rect, row.rect, `${label}/${row.route}: no row or neighbor movement`);
        assert.deepEqual(next.label, row.label, `${label}/${row.route}: no changed label metrics`);
        assert.deepEqual(next.metrics, row.metrics, `${label}/${row.route}: interaction cannot change sizing`);
    }
}

function readable(rows, label, scale) {
    for (const row of rows) {
        assert.equal(row.clipped, false, `${label}/${row.route}: full label`);
        assert.equal(row.lines.length, 1, `${label}/${row.route}: latest user requirement keeps every full navigation label on one line`);
        assert.ok(row.overflow <= 1, `${label}: no page overflow`);
        assert.ok(row.rect.height >= 44 && row.rect.width >= 44, `${label}/${row.route}: minimum target`);
        assert.equal(row.metrics.fontSize, `${14 * scale}px`, `${label}: Fluent navigation control role`);
        assert.equal(row.metrics.whiteSpace, "nowrap");
        assert.equal(row.decoration, "none");
        const surface = row.fill === "rgba(0, 0, 0, 0)" ? row.outside : row.fill;
        assert.ok(contrast(row.ink, surface) >= 4.5, `${label}/${row.route}: readable text and icon`);
        if (row.current) {
            assert.notEqual(row.fill, "rgba(0, 0, 0, 0)", `${label}: selected fill remains`);
            assert.equal(row.metrics.borderWidth, "0px", `${label}: selected row is tonal, not outlined`);
        }
        if (row.focus) {
            assert.notEqual(row.outline, "none"); assert.ok(row.outlineWidth >= 2);
            assert.ok(contrast(row.outlineColor, row.outside) >= 3, `${label}: visible keyboard focus`);
        }
        const expectedHeight = Math.max(44, row.lines.length * parseFloat(row.metrics.lineHeight)
            + 2 * parseFloat(row.metrics.padding) + 2 * parseFloat(row.metrics.borderWidth));
        assert.equal(row.rect.height, expectedHeight, `${label}/${row.route}: predictable wrapped row spacing`);
    }
}

test("selected Collection status stays one compact desktop row, not a wrapped action capsule", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    const before = await measure(page);
    const iconControl = await page.locator("#themePreference").boundingBox();
    await link(page, "collection-status").click(); await ready(page);
    const selected = await measure(page), row = selected.find(item => item.route === "collection-status");
    if (proofs) await writeFile(path.join(proofs, "desktop-sizing.json"), JSON.stringify({ before, selected }, null, 2));
    assert.equal(row.rect.height, 44, "Selected Collection status must stay a 44px navigation row");
    assert.equal(row.lines.length, 1, "Full label fits without shrinking type or widening the sidebar");
    assert.equal(row.metrics.borderRadius, "6px", "Navigation follows the quiet reference row");
    assert.deepEqual(await page.locator(".navigation-group-label").allTextContents(), ["Explore", "Manage"]);
    assert.deepEqual(await page.locator(".navigation-group").evaluateAll(groups => groups.map(group => [...group.querySelectorAll("a")].map(a => a.dataset.nav))),
        [["home", "activity", "reports"], ["collection-status", "settings"]]);
    assert.equal(await page.locator(".navigation-group [tabindex],.navigation-group-label button").count(), 0);
    stable(before, selected, "selection");
    assert.equal(await page.locator("#sidebar").evaluate(node => node.getBoundingClientRect().width), 208);
    assert.equal(await page.locator("#sidebarExport,#mobileExportSlot").count(), 0, "Report creation belongs inside Reports");
    assert.deepEqual(await page.locator("#themePreference").boundingBox(), iconControl, "Compact icon control unchanged");
});

test("all five navigation rows keep geometry across themes, sizes, pointer and current/focus combinations", { timeout: 180000 }, async t => {
    const { page, runtime } = await setup(t), matrix = [];
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 1200, 2560]) for (const scale of [1, 2]) {
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme);
        await showNavigation(page);
        if (width < 700) {
            const heading = await page.locator("#navigationTitle").evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return [...range.getClientRects()].length;
            });
            assert.equal(heading, 1, "Drawer title stays intact; Close wraps instead of splitting Navigation");
            assert.ok((await page.locator("#closeNavigation").boundingBox()).height >= 44);
        }
        const baseline = await measure(page), label = `${theme}/${width}/${scale}x`;
        readable(baseline, label, scale);
        for (const route of routes) {
            const anchor = link(page, route);
            assert.equal(await anchor.getAttribute("href") !== null, true);
            assert.equal(await anchor.locator("a,button,[tabindex]").count(), 0);
            await anchor.hover();
            stable(baseline, await measure(page), `${label}/${route}/hover`);
            await page.mouse.down();
            stable(baseline, await measure(page), `${label}/${route}/pressed`);
            await page.mouse.up(); await ready(page);
            await showNavigation(page);
            await anchor.focus(); await page.keyboard.press("Shift");
            const current = await measure(page);
            stable(baseline, current, `${label}/${route}/selected+focus`);
            readable(current, label, scale);
            assert.equal(current.find(item => item.route === route).current, "page");
            assert.equal(current.find(item => item.route === route).focus, true);
            await anchor.hover();
            stable(baseline, await measure(page), `${label}/${route}/selected+focus+hover`);
            readable(await measure(page), label, scale);
            matrix.push({ theme, width, scale, route, rows: current });
        }
        if (proofs) await page.locator(".primary-navigation").screenshot({ path: path.join(proofs, `navigation-${theme}-${width}-${scale}x.png`) });
    }
    // A narrow embedded document in a wide host must follow its own viewport, not the host width.
    const host = await page.context().browser().newPage({ viewport: { width: 2560, height: 1000 }, reducedMotion: "reduce" });
    await host.setContent(`<iframe title="Narrow navigation test" src="${runtime.url}" style="width:375px;height:900px;border:0"></iframe>`);
    const frame = await (await host.locator("iframe").elementHandle()).contentFrame();
    await ready(frame);
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await frame.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(frame, theme);
        await showNavigation(frame);
        const before = await measure(frame);
        await link(frame, "collection-status").click(); await ready(frame); await showNavigation(frame);
        const after = await measure(frame);
        stable(before, after, `narrow host/${theme}/${scale}`); readable(after, `narrow host/${theme}/${scale}`, scale);
        matrix.push({ hostWidth: 2560, width: 375, theme, scale, rows: after });
        await frame.locator("#closeNavigation").click();
    }
    if (proofs) await writeFile(path.join(proofs, "responsive-state-matrix.json"), JSON.stringify(matrix, null, 2));
});

test("native row edges, Tab/Enter, deep links, Back/Forward and polling preserve navigation identity and size", { timeout: 60000 }, async t => {
    const { page, runtime } = await setup(t);
    const nav = await page.locator(".primary-navigation").elementHandle();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await link(page, "home").click(); await ready(page);
        const baseline = await measure(page);
        await link(page, "reports").focus(); await page.keyboard.press("Tab");
        assert.equal(await link(page, "collection-status").evaluate(node => node === document.activeElement && node.matches(":focus-visible")), true);
        await page.keyboard.press("Enter"); await ready(page);
        assert.equal(new URL(page.url()).hash, "#collection-status");
        stable(baseline, await measure(page), "Tab/Enter");
        await page.goBack(); await ready(page); assert.equal(new URL(page.url()).hash, "#home");
        await page.goForward(); await ready(page); assert.equal(new URL(page.url()).hash, "#collection-status");
        for (const route of ["activity", "collection-status", "settings", "home", "collection-status"]) {
            const anchor = link(page, route), expected = await anchor.getAttribute("href");
            const point = await anchor.evaluate(node => {
                const rect = node.getBoundingClientRect(), x = rect.left + 3, y = rect.top + rect.height / 2;
                return { x, y, owns: document.elementFromPoint(x, y)?.closest("a") === node };
            });
            assert.equal(point.owns, true, "The painted row edge is part of the anchor");
            const count = await page.evaluate(() => window.navigationPushes);
            await page.mouse.click(point.x, point.y); await ready(page);
            assert.equal(new URL(page.url()).hash, expected);
            assert.equal(await page.evaluate(() => window.navigationPushes), count + 1);
            stable(baseline, await measure(page), "repeated native navigation");
        }
        await link(page, "collection-status").focus(); await page.keyboard.press("Shift");
        const beforePoll = await measure(page), currentUrl = page.url();
        await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        await page.waitForResponse(response => response.url().endsWith("/api/collection/status"));
        stable(beforePoll, await measure(page), "polling");
        assert.equal(await nav.evaluate(node => node === document.querySelector(".primary-navigation")), true);
        assert.equal(await link(page, "collection-status").evaluate(node => node === document.activeElement), true);
        assert.equal(page.url(), currentUrl);
    }
    await page.goto(runtime.url + "#collection-status"); await ready(page);
    assert.equal(await link(page, "collection-status").getAttribute("aria-current"), "page", "Fresh deep link");
    await page.setViewportSize({ width: 375, height: 1000 });
    assert.equal(await page.locator(".primary-navigation").isVisible(), false);
    await page.locator("#navigationToggle").click();
    assert.equal(await nav.evaluate(node => node === document.querySelector("#navigationDrawer .primary-navigation")), true, "Same nodes in drawer");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement), true);
});
