import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { buildExportCatalog } from "../lib/export-selection.mjs";
import { chooseTheme, fixture, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

const proofs = process.env.WIRE_SIDEBAR_ICON_PROOFS;
const selectors = ['nav [data-nav="analyze"]', 'nav [data-nav="reports"]',
    "#comparePeriods", "#pageAction", 'nav [data-nav="settings"]'];

async function setup(t) {
    const scenarios = [fixture("sidebar-icons")];
    scenarios[0].userPrompt.text = "Inspect the invented calendar request.";
    scenarios[0].followUpPrompts = [];
    const errors = [], unexpected = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            return res.end(renderHtmlShell("a".repeat(64), "sidebar-icons", UNBOUND_FIXTURE_BOOTSTRAP));
        }
        if (req.method === "GET" && req.url === "/favicon.svg") { res.statusCode = 204; return res.end(); }
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            unexpected.push(`${req.method} ${req.url}`);
            res.statusCode = 403;
            return res.end('{"error":"Only synthetic snapshot reads are allowed."}');
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        res.end(JSON.stringify({
            boardId: "synthetic-sidebar-icons", revision: 1, scenarios, exports: [],
            exportCatalog: buildExportCatalog(scenarios),
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic only."] },
            analytics: { ...buildActivityAnalytics(scenarios, input), revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, [], "No collection, profile, provider or external calls");
    });
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin
        ? route.continue() : (unexpected.push(route.request().url()), route.abort()));
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(origin);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return page;
}

// Compare real page paint with only the glyph hidden, so overlays and inherited
// backgrounds cannot pass merely because the SVG has a visible CSS box.
async function glyphPaint(page, selector) {
    await page.waitForFunction(() => !document.querySelector("#navigationContent").getAnimations({ subtree: true })
        .some(animation => animation.playState === "running"));
    const control = page.locator(selector);
    const icon = (await control.evaluate(node => node.matches(".analyze-tool-action"))
        ? control.locator("..") : control).locator(".wire-icon").first();
    const box = await icon.boundingBox();
    assert.ok(box, `${selector}: glyph exists`);
    const clip = { x: Math.floor(box.x) - 2, y: Math.floor(box.y) - 2,
        width: Math.ceil(box.width) + 4, height: Math.ceil(box.height) + 4 };
    const painted = await page.screenshot({ clip, scale: "css" });
    await icon.evaluate(node => node.style.visibility = "hidden");
    const hidden = await page.screenshot({ clip, scale: "css" });
    await icon.evaluate(node => node.style.removeProperty("visibility"));
    return page.evaluate(async ({ painted, hidden }) => {
        async function pixels(base64) {
            const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), char => char.charCodeAt(0))]));
            const canvas = document.createElement("canvas");
            canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0); image.close();
            return ctx.getImageData(0, 0, canvas.width, canvas.height);
        }
        const a = await pixels(painted), b = await pixels(hidden);
        const luminance = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const points = [];
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4;
            const foreground = [...a.data.slice(i, i + 3)], background = [...b.data.slice(i, i + 3)];
            const f = luminance(foreground), bg = luminance(background);
            if ((Math.max(f, bg) + .05) / (Math.min(f, bg) + .05) >= 3) points.push({ x, y });
        }
        return { pixels: points.length,
            centerX: points.length ? (Math.max(...points.map(p => p.x)) + Math.min(...points.map(p => p.x))) / 2 : 0,
            centerY: points.length ? (Math.max(...points.map(p => p.y)) + Math.min(...points.map(p => p.y))) / 2 : 0,
            width: points.length ? Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + 1 : 0,
            height: points.length ? Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) + 1 : 0 };
    }, { painted: painted.toString("base64"), hidden: hidden.toString("base64") });
}

async function geometry(page, selector) {
    return page.locator(selector).evaluate(control => {
        const icon = control.matches(".analyze-tool-action") ? control.parentElement.querySelector(".wire-icon")
            : control.querySelector(".wire-icon");
        const range = document.createRange();
        range.selectNodeContents(control.querySelector(".navigation-label") || control);
        const text = [...range.getClientRects()].filter(rect => rect.width > 0).at(-1);
        const box = node => node.getBoundingClientRect().toJSON();
        return { utility: Boolean(control.closest(".navigation-footer")), target: box(control), icon: box(icon), label: text?.toJSON(), stroke: getComputedStyle(icon).strokeWidth,
            name: control.getAttribute("aria-label") || control.textContent.trim(), focus: control.matches(":focus-visible"),
            outline: getComputedStyle(control).outlineStyle, font: getComputedStyle(control).fontFamily,
            hit: document.elementFromPoint(box(icon).x + box(icon).width / 2, box(icon).y + box(icon).height / 2)?.closest("a,button") === control };
    });
}

test("sidebar pointer, keyboard and current states preserve paint and geometry expanded and collapsed", async t => {
    const page = await setup(t), evidence = [];
    for (const theme of ["light", "dark"]) for (const mode of ["expanded", "collapsed"]) {
        await chooseTheme(page, theme);
        if (await page.locator("html").getAttribute("data-navigation") !== mode) await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        const column = (await geometry(page, selectors[0])).label.x;
        for (const selector of selectors) {
            const control = page.locator(selector);
            await page.mouse.move(1000, 900);
            await page.locator("#navigationCollapse").focus();
            const baseline = await geometry(page, selector);
            const normal = await glyphPaint(page, selector);
            for (const state of ["rest", "hover", "pressed", "focus"]) {
                if (state === "hover") await control.hover();
                if (state === "pressed") await page.mouse.down();
                if (state === "focus") {
                    await page.mouse.move(1000, 900);
                    await page.mouse.up();
                    await control.focus();
                    await page.keyboard.press("Shift");
                }
                const paint = state === "rest" ? normal : await glyphPaint(page, selector);
                const layout = await geometry(page, selector);
                evidence.push({ theme, mode, selector, state, ...paint, ...layout });
                assert.equal(layout.icon.width, 24, `${selector}: one native sidebar role`);
                assert.equal(layout.icon.height, 24);
                assert.ok(Math.abs(layout.icon.y + 12 - layout.target.y - layout.target.height / 2) < 1);
                if (layout.utility) {
                    assert.equal(layout.name, "Settings");
                    assert.ok(Math.abs(layout.icon.x + 12 - layout.target.x - layout.target.width / 2) < 1);
                } else if (mode === "expanded") assert.ok(Math.abs(layout.label.x - column) < 1, `${selector}: shared label column`);
                assert.ok(paint.pixels >= 35, `${selector}: absolute painted-pixel floor`);
                assert.ok(paint.pixels >= normal.pixels * .8 && paint.height >= 20 && paint.width >= 17,
                    `${theme}/${mode}/${selector}/${state}: readable unoccluded strokes ${JSON.stringify(paint)}`);
                assert.ok(Math.abs(paint.centerX - normal.centerX) <= 1 && Math.abs(paint.centerY - normal.centerY) <= 1);
                assert.deepEqual(layout.icon, baseline.icon, "Glyph does not jump");
                assert.deepEqual(layout.target, baseline.target, "Target does not jump");
                assert.deepEqual(layout.label, baseline.label, "Label does not jump");
                assert.ok(layout.hit, "The painted glyph never intercepts the actual control");
                assert.ok(layout.target.width >= 44 && layout.target.height >= 44);
                assert.match(layout.font, /Asta Sans/);
                if (state === "focus") assert.ok(layout.focus && layout.outline !== "none");
            }
        }
        for (const view of ["reports", "settings", "analyze"]) {
            const selector = `nav [data-nav="${view}"]`;
            await page.locator(selector).press("Enter");
            await page.locator('#workspace[aria-busy="false"]').waitFor();
            assert.equal(await page.locator(selector).getAttribute("aria-current"), "page");
            const paint = await glyphPaint(page, selector);
            evidence.push({ theme, mode, selector, state: "current", ...paint });
            assert.ok(paint.pixels >= 80);
        }
        for (const selector of ["#navigationCollapse"]) {
            const control = page.locator(selector), baseline = await geometry(page, selector);
            for (const state of ["hover", "pressed", "focus"]) {
                if (state === "hover") await control.hover();
                if (state === "pressed") await page.mouse.down();
                if (state === "focus") {
                    await page.mouse.move(1000, 900); await page.mouse.up();
                    await control.focus(); await page.keyboard.press("Shift");
                }
                const paint = await glyphPaint(page, selector), layout = await geometry(page, selector);
                evidence.push({ theme, mode, selector, state, ...paint, ...layout });
                assert.ok(paint.pixels >= 35 && layout.hit);
                assert.deepEqual(layout.icon, baseline.icon);
                assert.deepEqual(layout.target, baseline.target);
                assert.ok(layout.target.width >= 44 && layout.target.height >= 44);
                if (state === "focus") assert.ok(layout.focus && layout.outline !== "none");
            }
        }
        await page.locator("#comparePeriods").press("Enter");
        assert.equal(await page.locator("#comparePeriods").getAttribute("aria-expanded"), "true");
        const paint = await glyphPaint(page, "#comparePeriods");
        evidence.push({ theme, mode, selector: "#comparePeriods", state: "expanded-comparison", ...paint });
        assert.ok(paint.pixels >= 120);
        if (proofs) await page.locator("#sidebar").screenshot({ path: path.join(proofs, `${theme}-${mode}-current.png`) });
        await page.locator("#comparePeriods").press("Enter");
    }
    if (proofs) await writeFile(path.join(proofs, "states.json"), JSON.stringify(evidence, null, 2));
});

test("sidebar glyphs fit the narrow drawer and 200 percent text without overlapping targets", async t => {
    const page = await setup(t), evidence = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[768, 2], [390, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await page.waitForFunction(() => document.querySelector("#navigationContent").closest(
            matchMedia("(max-width:699px)").matches ? "#navigationDrawer" : "#sidebar"));
        if (width < 700) {
            await page.locator("#navigationToggle").click();
            await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
        }
        const rows = [];
        for (const selector of selectors) {
            const control = page.locator(selector);
            await control.scrollIntoViewIfNeeded();
            await control.hover();
            const layout = await geometry(page, selector), paint = await glyphPaint(page, selector);
            evidence.push({ theme, width, scale, selector, ...layout, ...paint });
            rows.push(layout.target);
            assert.equal(layout.icon.width, 24);
            assert.ok(paint.width >= 17 && paint.height >= 20);
            assert.ok(layout.hit && layout.target.width >= 44 && layout.target.height >= 44);
            if (layout.utility) assert.ok(Math.abs(layout.icon.x + 12 - layout.target.x - layout.target.width / 2) < 1);
            else assert.ok(layout.label.right <= layout.target.right && layout.label.left >= layout.icon.right + 9);
            assert.ok(Math.abs(layout.icon.y + 12 - layout.target.y - layout.target.height / 2) < 1);
        }
        for (let i = 1; i < rows.length; i++) assert.ok(rows[i].top >= rows[i - 1].bottom, "44px targets never overlap");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-${width}-text${scale}.png`) });
        if (width < 700) {
            await page.keyboard.press("Escape");
            await page.locator("#navigationDrawer").waitFor({ state: "hidden" });
            assert.ok(await page.locator("#navigationToggle").evaluate(node => node === document.activeElement));
        }
    }
    if (proofs) await writeFile(path.join(proofs, "responsive.json"), JSON.stringify(evidence, null, 2));
});
