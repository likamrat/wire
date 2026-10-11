import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture, chooseTheme, navigateMain } from "./helpers.mjs";
import { scopeRecords } from "./analysis-scope-fixture.mjs";
import { contrast, rgb, hue, measureChartPaint } from "./color-measurements.mjs";

const proofs = process.env.WIRE_FOUNDATION_PROOFS;
const baseline = process.env.WIRE_FOUNDATION_BASELINE === "1";
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function inspect(page, label) {
    const measured = await page.evaluate(() => {
        const rgba = value => {
            const channels = value.match(/[\d.]+/g).map(Number);
            return value.startsWith("color(srgb ") ? channels.map((v, i) => i < 3 ? v * 255 : v) : channels;
        };
        const composite = (color, base, opacity = 1) => {
            const a = (color[3] ?? 1) * opacity;
            return base.map((v, i) => color[i] * a + v * (1 - a));
        };
        function surface(node) {
            if (!node) return [255, 255, 255];
            const css = getComputedStyle(node), bg = rgba(css.backgroundColor);
            const base = composite(bg, bg[3] === 1 ? [0, 0, 0] : surface(node.parentElement));
            const face = getComputedStyle(node, "::before");
            return face.content !== "none" && face.display !== "none" && face.zIndex === "-1"
                ? composite(rgba(face.backgroundColor), base, Number(face.opacity)) : base;
        }
        const color = channels => `rgb(${channels.slice(0, 3).join(",")})`;
        const text = [], controls = [], focus = [], marks = [], targets = [], surfaces = [], pills = [], overflow = [];
        const root = getComputedStyle(document.documentElement);
        const tokens = Object.fromEntries(["page", "paper", "canvas", "hover", "ink", "muted", "control", "focus", "accent",
            "accent-soft", "accent-fill", "on-accent", "pill-pressed", "danger", "success", "warning", "unknown",
            "performance-red", "performance-orange", "performance-gold", "performance-teal", "prompt-author-user", "copilot-chat-title",
            ...[...root].filter(name => /^--chart-.*-label$/.test(name)).map(name => name.slice(2))]
            .map(name => [name, root.getPropertyValue("--" + name).trim()]));
        for (const node of document.body.querySelectorAll("*")) {
            if (!node.checkVisibility({ visibilityProperty: true }) || node.closest(".visually-hidden,.skip-link") || node.tagName === "OPTION") continue;
            const css = getComputedStyle(node), face = getComputedStyle(node, "::before"), bg = surface(node);
            const id = node.id || (typeof node.className === "string" ? node.className : node.tagName);
            if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())
                || node.matches("input:not([type=checkbox],[type=radio]),textarea")) {
                text.push({ id, ink: color(composite(rgba(css.color), bg, Number(css.opacity))), bg: color(bg) });
            }
            if (node.matches("input[placeholder]")) text.push({ id: id + ":placeholder", ink: getComputedStyle(node, "::placeholder").color, bg: color(bg) });
            if (node.matches(".percentage-cue svg,.semantic-cue svg,.result-legend-icon svg,.recorded-result svg")) {
                marks.push({ id, ink: css.color, bg: color(bg) });
            }
            if (node.matches(".swatch,.percentage-bar")) marks.push({ id, ink: css.backgroundColor, bg: color(surface(node.parentElement)) });
            if (node.matches("input:not([type=checkbox],[type=radio]),.select-trigger")) {
                const paint = node.matches(".select-trigger") ? face : css;
                if (!node.disabled && parseFloat(paint.borderTopWidth)) controls.push({ id, ink: paint.borderTopColor, bg: color(bg), outside: color(surface(node.parentElement)) });
            }
            for (const [part, paint] of [["", css], [":before", face]]) {
                if (parseFloat(paint.outlineWidth) && paint.outlineStyle !== "none") focus.push({
                    id: id + part, ink: paint.outlineColor, bg: color(surface(node.parentElement)),
                });
            }
            if (node.matches(".select-trigger,.primary-navigation a,#themePreference,.interaction-select,.settings-category-link,#checkActivity")) {
                const box = node.getBoundingClientRect();
                targets.push({ id, width: box.width, height: box.height });
            }
            if (node.matches(".app-header,.chart-panel,.percentage-card,.request-intro,.settings-pane,.select-popup,dialog")) {
                surfaces.push({ id, bg: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow, radius: css.borderRadius });
            }
            if (node.matches(".recorded-result")) pills.push({ id, radius: css.borderRadius, bg: color(bg), ink: css.color });
            const box = node.getBoundingClientRect();
            if (!node.closest(".dimensional-scroll,#countTable,.percentage-scroll") && box.width && (box.right > innerWidth + 1 || box.left < -1)) overflow.push(id);
        }
        const state = {
            route: location.hash, count: document.querySelector("#activityCount")?.textContent ?? null,
            rows: [...document.querySelectorAll("#activityList .request-row")].map(node => node.dataset.viewKey),
            selected: [...document.querySelectorAll("#activityList input:checked")].length,
            inputs: [...document.querySelectorAll("#activitySearch,.select-source")].map(node => [node.id, node.value]),
        };
        const material = {
            glint: root.getPropertyValue("--glass-glint").trim(),
            rim: root.getPropertyValue("--glass-rim").trim(),
            shadow: root.getPropertyValue("--glass-shadow").trim(),
            faces: ["orange", "cyan", "teal", "pink", "slate", "violet"].map(tone =>
                ["top", "mid", "base", "side", "cap"].map(face => root.getPropertyValue(`--chart-${tone}-${face}`).trim())),
        };
        return { tokens, text, controls, focus, marks, targets, surfaces, pills, overflow, state,
            material,
            rootOverflow: document.documentElement.scrollWidth - innerWidth,
            fontFamily: getComputedStyle(document.body).fontFamily,
            fontLoaded: document.fonts.check('14px Arial') };
    });
    const ratios = entries => entries.map(entry => ({ ...entry, ratio: Math.min(contrast(entry.ink, entry.bg),
        entry.outside ? contrast(entry.ink, entry.outside) : Infinity) }));
    measured.text = ratios(measured.text);
    measured.controls = ratios(measured.controls);
    measured.focus = ratios(measured.focus);
    measured.marks = ratios(measured.marks);
    measured.chartPaint = await page.evaluate(measureChartPaint, ".flat-time-segment,.percentage-slice,.percentage-bar,.flat-comparison-segment");
    for (const mark of measured.chartPaint) {
        assert.equal(mark.local, true, `${label}: chart paint resolves inside its SVG`);
        assert.ok(mark.colors.length > 0, `${label}: chart paint is resolved`);
        for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, `${label}: entire chart fade is readable`);
    }
    assert.equal(measured.fontLoaded, true, `${label}: reference-aligned system font available`);
    if (!baseline) assert.match(measured.fontFamily, /^Arial,/, `${label}: reference-aligned sans-serif`);
    assert.ok(measured.rootOverflow <= 1, `${label}: document overflow`);
    assert.deepEqual(measured.overflow, [], `${label}: unclipped content`);
    for (const [kind, minimum] of [["text", 4.5], ["controls", 3], ["focus", 3], ["marks", 3]]) {
        assert.deepEqual(measured[kind].filter(entry => entry.ratio < minimum), [], `${label}: ${kind} contrast`);
    }
    assert.deepEqual(measured.targets.filter(box => box.height < 44 || box.width < 44), [], `${label}: 44px targets`);
    if (!baseline) {
        assert.equal(measured.material.glint, "0");
        assert.equal(measured.material.rim, "transparent");
        assert.equal(measured.material.shadow, "transparent");
        for (const faces of measured.material.faces) assert.notEqual(faces[0], faces[2], `${label}: intentional high-to-low outcome fade`);
        const semanticRoles = ["ink", "muted", "accent", "danger", "success", "warning", "unknown", "prompt-author-user",
            "copilot-chat-title", "performance-red", "performance-orange", "performance-gold", "performance-teal",
            ...Object.keys(measured.tokens).filter(name => /^chart-.*-label$/.test(name))];
        measured.semantic = semanticRoles.flatMap(role => ["paper", "canvas", "hover", "accent-soft"].map(surface => ({
            role, surface, ratio: contrast(measured.tokens[role], measured.tokens[surface]),
        })));
        assert.deepEqual(measured.semantic.filter(item => item.ratio < 4.5), [], `${label}: readable semantic labels and marks on shared surfaces`);
        const reference = label.includes("dark")
            ? { page: "#0f111a", paper: "#171923", canvas: "#141622", accent: "#06b6d4", success: "#10b981", danger: "#ed58a5", warning: "#f2a262" }
            : { page: "#f4f5f9", paper: "#ffffff", canvas: "#eceef5", accent: "#006580", success: "#007458", danger: "#a52b75", warning: "#a14d16" };
        for (const [name, expected] of Object.entries(reference)) assert.equal(measured.tokens[name], expected, `${label}: METROPOLIS-derived ${name}`);
        for (const role of ["warning", "chart-pink-label", "chart-service-mail-label"]) {
            const angle = hue(measured.tokens[role]);
            assert.ok(angle >= 20 && angle <= 32, `${label}: ${role} leans orange, not yellow/gold`);
        }
        assert.deepEqual(measured.surfaces.filter(item => item.image !== "none" || item.shadow !== "none"), [], `${label}: flat shared surfaces`);
        assert.deepEqual(measured.surfaces.filter(item => parseFloat(item.radius) > 8), [], `${label}: compact panel corners, not rounded cards`);
        assert.deepEqual(measured.pills.filter(item => parseFloat(item.radius) < 999), [], `${label}: semantic status capsules`);
    }
    return { label, ...measured };
}

test("shared foundation preserves real Analyze, reader and Settings in both themes and enlarged narrow text", { timeout: 90000 }, async t => {
    const records = scopeRecords(), { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No model in foundation proof"); },
            readSource: async () => { throw new Error("No source history in foundation proof"); } } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    t.after(async () => { await browser.close(); await runtime.close(); });
    page.setDefaultTimeout(7000);
    const errors = [], rejected = [], matrix = [];
    page.on("pageerror", error => errors.push(error.message));
    const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            rejected.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    async function capture(label, screenshot = false) {
        await frames(page);
        matrix.push(await inspect(page, label));
        if (proofs) {
            await writeFile(path.join(proofs, "computed-foundation.json"), JSON.stringify(matrix, null, 2));
            if (screenshot) await page.screenshot({ path: path.join(proofs, label + ".png"), fullPage: page.viewportSize().width < 600 });
        }
    }
    const routes = [["analyze", "analyze"], ["reader", "request?request=parity-request-0"], ["settings", "settings?section=connection"]];
    for (const [name, route] of routes) {
        await page.goto(runtime.url + "#" + route); await ready(page);
        await page.evaluate(() => document.fonts.ready);
        for (const [width, scale] of [[1280, 1], [375, 2]]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            for (const theme of ["light", "dark"]) {
                await chooseTheme(page, theme);
                await page.locator("#pageTitle").scrollIntoViewIfNeeded();
                await capture(`${name}-${theme}-${width}-${scale}`, width === 1280 || name === "settings");
            }
            assert.deepEqual(matrix.at(-1).state, matrix.at(-2).state, `${name}: theme leaves query/selection/results unchanged`);
        }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await navigateMain(page, "analyze"); await ready(page);
    await page.locator("#activityList input[type=checkbox]").first().check();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const trigger = page.locator('[data-select-id="outcomeFilter"]');
        await page.keyboard.press("Tab");
        await trigger.focus(); await capture(`${theme}-focus`);
        assert.ok(matrix.at(-1).focus.length, "A real focus indicator was measured");
        await trigger.click();
        await expect(page.locator(".select-popup")).toBeVisible();
        await capture(`${theme}-selected-dropdown`, true);
        await page.keyboard.press("Escape");
        const action = page.locator("#checkActivity");
        await action.hover(); await capture(`${theme}-hover`);
        await page.mouse.down(); await capture(`${theme}-pressed`);
        await page.mouse.move(0, 0); await page.mouse.up();
        const before = await action.boundingBox();
        const buttonPaint = async () => action.evaluate(node => {
            const paint = getComputedStyle(node, "::before");
            return { background: paint.backgroundColor, border: paint.borderTopColor, ink: getComputedStyle(node).color };
        });
        const rest = await buttonPaint();
        await action.hover(); const hover = await buttonPaint();
        await page.mouse.down(); const pressed = await buttonPaint();
        await page.mouse.move(0, 0); await page.mouse.up();
        if (!baseline) {
            assert.equal(new Set([rest.background, hover.background, pressed.background]).size, 3, "Primary states use distinct flat fills");
            assert.deepEqual(rgb(rest.background), rgb(matrix.at(-1).tokens["accent-soft"]), "Primary is a faded tint, not a broad pastel fill");
            for (const paint of [rest, hover, pressed]) {
                assert.deepEqual(rgb(paint.ink), rgb(matrix.at(-1).tokens.accent), "Cyan action label");
                assert.deepEqual(rgb(paint.border), rgb(matrix.at(-1).tokens.accent), "Cyan action boundary");
            }
        }
        await chooseTheme(page, theme === "light" ? "dark" : "light");
        assert.deepEqual(await action.boundingBox(), before, "Theme does not move the action");
        assert.equal(await page.locator("#activityList input:checked").count(), 1);
    }
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await capture(`${theme}-explicit`);
        const explicit = matrix.at(-1).tokens;
        await page.emulateMedia({ colorScheme: theme });
        await page.evaluate(() => { delete document.documentElement.dataset.evidenceTheme; });
        await capture(`${theme}-system`);
        assert.deepEqual(matrix.at(-1).tokens, explicit, "System CSS and explicit preference resolve the same palette");
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
    }
    // Paint-only inspection of the existing dialog shell; no source review or approval.
    await page.evaluate(() => {
        document.querySelector("#dialogTitle").textContent = "Invented details";
        document.querySelector("#detail").textContent = "Retained fixture details, without source access.";
        document.querySelector("#overlay").showModal();
    });
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        await capture(`${theme}-dialog`);
    }
    await page.locator("#closeDialog").click();
    await page.emulateMedia({ forcedColors: "active" });
    await page.keyboard.press("Tab");
    await page.locator('[data-select-id="outcomeFilter"]').focus();
    const forcedFocus = await page.locator('[data-select-id="outcomeFilter"]').evaluate(node => {
        const css = getComputedStyle(node, "::before");
        return { style: css.outlineStyle, width: parseFloat(css.outlineWidth) };
    });
    assert.equal(forcedFocus.style, "solid"); assert.ok(forcedFocus.width >= 2);
    await page.emulateMedia({ forcedColors: "none" });
    // Pause only the invented snapshot response, never the collection or provider.
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    await page.route("**/api/snapshot", async route => { await hold; await route.continue(); });
    const reload = page.reload();
    await expect(page.locator("#loading")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await capture(`${theme}-loading-disabled`);
        assert.ok(await page.locator("button:disabled").count(), "Real pending controls are disabled");
    }
    release(); await reload; await ready(page);
    await page.unroute("**/api/snapshot");
    await page.route("**/api/snapshot", route => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented snapshot is temporarily unavailable." }),
    }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Invented snapshot is temporarily unavailable.");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme); await capture(`${theme}-error`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(rejected, [], "No collection, disclosure, export, provider or external requests");
});
