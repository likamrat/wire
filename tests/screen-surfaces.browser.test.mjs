import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { tokens, typographyTokens, screenTokens, screenFontStack } from "../web/tokens.mjs";
import { uiFontStack, fontFaceStyles } from "../lib/typeface.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme, navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";
import { scopeRecords } from "./analysis-scope-fixture.mjs";
import { contrast, hue, rgb, measureChartPaint } from "./color-measurements.mjs";

function visibleInk() {
    const rgba = value => {
        if (value.startsWith("color(srgb")) {
            const [color, alpha] = value.slice(11, -1).split("/");
            return [...color.trim().split(/\s+/).map(v => Number(v) * 255), Number(alpha ?? 1)];
        }
        const values = value.match(/[\d.]+/g).map(Number);
        return [...values.slice(0, 3), values[3] ?? 1];
    };
    const blend = (a, b) => a.slice(0, 3).map((n, i) => n * a[3] + b[i] * (1 - a[3]));
    function background(node) {
        if (!node) return [255, 255, 255];
        const css = getComputedStyle(node), surface = blend(rgba(css.backgroundColor), background(node.parentElement));
        const before = getComputedStyle(node, "::before");
        // Inset button faces cover text; thin navigation indicators do not.
        const coversText = parseFloat(before.width) >= node.getBoundingClientRect().width * .8
            && parseFloat(before.height) >= parseFloat(css.lineHeight);
        return before.content !== "none" && before.display !== "none" && coversText
            ? blend(rgba(before.backgroundColor), surface) : surface;
    }
    return [...document.querySelectorAll("body *")].filter(node => node.checkVisibility({ visibilityProperty: true })
        && !node.closest(".visually-hidden,.skip-link,svg,iframe") && !node.matches("option")
        && ([...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())
            || node.matches("input:not([type=checkbox],[type=radio]),textarea")))
        .map(node => {
            const css = getComputedStyle(node), bg = background(node), color = value => `rgb(${value.slice(0, 3).join(",")})`;
            return { target: node.id || node.tagName + "." + node.className, background: color(bg),
                ink: color(blend(rgba(css.color), bg)), font: css.fontFamily, weight: css.fontWeight,
                cardEmphasis: node.matches("#requestContent .reader-facts dt, #requestContent .facts dt") ? "600"
                    : node.matches("#activityList>.activity-card .activity-card-facts dt") ? "500"
                        : node.matches("#activityList>.activity-card .card-tool-name") ? "400" : null,
                placeholder: node.hasAttribute("placeholder") ? color(blend(rgba(getComputedStyle(node, "::placeholder").color), bg)) : null,
                code: !!node.closest("code,kbd,samp,.mono,pre:not(.full-text-content)") };
        });
}

test("screen surfaces leave report-facing tokens, typography and embedded font exports byte-exact", () => {
    const expected = {
        tokens: "bc1c376cd50c984b828eb834fb239fcaee543fdcee860faddfd3753921e27900",
        typographyTokens: "0647f3f7c10ec869b55c08c783ab7e2b5a9585f219218564f4002386d3c1edfc",
        uiFontStack: "dcb6924f7ae20eaf3ec5d91e22aef8b2d56c256217ce24d2ac446465dbf1094c",
        fontFaceStyles: "0ab1b95c57a5e174e0f445aa734e50d5d4654056d0c451bb69312ababcb99beb",
    };
    for (const [name, value] of Object.entries({ tokens, typographyTokens, uiFontStack, fontFaceStyles })) {
        assert.equal(createHash("sha256").update(value).digest("hex"), expected[name], name);
    }
    assert.ok(renderHtmlShell("a".repeat(64), "screen-surfaces").includes(screenTokens));
    const overrides = screenTokens.slice(tokens.length);
    assert.doesNotMatch(overrides, /--(?:type-|success|warning|copilot-chat-title)|@font-face|Segoe Sans/);
    assert.match(overrides, /--chart-failure:#b3261e/);
    assert.match(overrides, /--chart-failure:#f28b82/);
    assert.equal(screenFontStack.split(",")[0], '"Asta Sans"');
    assert.match(overrides, /--weight-regular:400;--weight-medium:500;--weight-strong:600/);
});

test("production screens use a cool light canvas, charcoal depth, IQOS Asta Sans and distinct red failures", async t => {
    const cleanups = [], { context } = await privateFixture({ after: cleanup => cleanups.push(cleanup) }, scopeRecords());
    const before = await loadBoardState(context);
    let providers = 0;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { providers++; throw new Error("No providers in surface proof"); },
            readSource: async () => { providers++; throw new Error("No source reads in surface proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []); assert.equal(providers, 0);
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const proofs = process.env.WIRE_SURFACE_PROOFS, measurements = [];
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const surfaces = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const variable = name => root.getPropertyValue("--" + name).trim();
            const identity = node => node.id ? "#" + node.id : node.tagName.toLowerCase() + "." + [...node.classList].join(".");
            function paintedBackground(node) {
                for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor), color = style.backgroundColor;
                    const alpha = Number(color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/)?.[1]
                        ?? color.match(/\/\s*([\d.]+)\s*\)$/)?.[1] ?? 1);
                    if (style.backgroundImage !== "none" || Number(style.opacity) !== 1) throw new Error("Unsupported background paint: " + identity(ancestor));
                    if (alpha === 0) continue;
                    if (alpha !== 1) throw new Error("Translucent background needs compositing: " + identity(ancestor));
                    return { color, owner: identity(ancestor) };
                }
                throw new Error("No painted background for " + identity(node));
            }
            const targets = "#analyzePopulation,#outcomeChart>.percentage-card,.analyze-chart-main .chart-panel,#percentageCharts .percentage-card";
            return [...document.querySelectorAll(targets)].filter(node => node.checkVisibility()).map(node => {
                const style = getComputedStyle(node), background = paintedBackground(node);
                let boundary = node;
                while (boundary && (parseFloat(getComputedStyle(boundary).borderTopWidth) === 0
                    || getComputedStyle(boundary).borderTopStyle === "none")) boundary = boundary.parentElement;
                if (!boundary) throw new Error("No painted boundary for " + identity(node));
                const border = getComputedStyle(boundary);
                return { target: identity(node), label: node.querySelector("h2,h3")?.textContent.trim() || identity(node),
                    rawBackground: style.backgroundColor, surfaceOwner: background.owner,
                    shadow: border.boxShadow,
                    boundaryOwner: identity(boundary), page: paintedBackground(boundary.parentElement).color, paper: background.color,
                    rule: border.borderTopColor, borderWidth: border.borderTopWidth, ink: style.color,
                    muted: variable("muted"), control: variable("control"), canvas: variable("canvas"),
                    success: variable("chart-success"), failure: variable("chart-failure"), font: variable("font") };
            });
        });
        assert.equal(surfaces.length, 6, "Filter, outcome, timeline, tools, services and Model containers are covered");
        const outcome = surfaces.find(value => value.surfaceOwner === "div.analyze-outcome-summary");
        assert.ok(outcome, "Transparent outcome internals resolve to their painted outer summary");
        assert.equal(outcome.rawBackground, "rgba(0, 0, 0, 0)");
        assert.equal(outcome.boundaryOwner, outcome.surfaceOwner);
        for (const measured of surfaces) {
            const ratios = { text: contrast(measured.ink, measured.paper), muted: contrast(measured.muted, measured.paper),
                boundary: contrast(measured.rule, measured.paper), outerBoundary: contrast(measured.rule, measured.page),
                control: contrast(measured.control, measured.canvas), surface: contrast(measured.paper, measured.page) };
            assert.ok(ratios.text >= 7, measured.target); assert.ok(ratios.muted >= 4.5, measured.target);
            // Structural panel separators are not control boundaries.
            assert.ok(ratios.boundary >= 1.5, measured.target); assert.ok(ratios.outerBoundary >= 1.4, measured.target);
            assert.ok(ratios.control >= 3, measured.target); assert.ok(ratios.surface >= 1.05, measured.target);
            for (const role of ["paper", "page", "canvas", "ink", "muted", "control", "rule"]) {
                const channels = rgb(measured[role]);
                if (theme === "light" && role === "page") {
                    assert.ok(channels[2] > channels[0] && channels[2] - channels[0] <= 8, "Light canvas has only a subtle cool tint");
                } else assert.ok(channels.every(channel => channel === channels[0]), `${role} is neutral: ${measured[role]}`);
            }
            assert.equal(measured.borderWidth, "1px");
            assert.notEqual(measured.shadow, "none");
            assert.equal(measured.font, screenFontStack);
            assert.equal(measured.success, theme === "light" ? "#086d7c" : "#48bfd2");
            assert.equal(measured.failure, theme === "light" ? "#b3261e" : "#f28b82");
            measured.ratios = ratios;
        }
        measurements.push({ theme, surfaces });
        if (proofs) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `${theme}-whole-page.png`), fullPage: true });
            await page.screenshot({ path: path.join(proofs, `${theme}-workspace.png`) });
            await page.locator("#percentageCharts").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofs, `${theme}-bounded-cards.png`) });
        }
        await page.locator("#wireSearch").focus();
        const inputPaint = await page.locator("#wireSearch").evaluate(node => {
            const css = getComputedStyle(node);
            return { background: css.backgroundColor, border: css.borderTopColor, focus: css.outlineColor,
                outlineWidth: parseFloat(css.outlineWidth), font: css.fontFamily };
        });
        assert.ok(contrast(inputPaint.border, inputPaint.background) >= 3);
        assert.ok(contrast(inputPaint.focus, inputPaint.background) >= 3);
        assert.ok(inputPaint.outlineWidth >= 2);
        assert.match(inputPaint.font, /^"Asta Sans"/);
        measurements.at(-1).inputPaint = inputPaint;
        await page.locator("#wireSearch").press("Escape");
        await expect(page.locator("#wireSearchPanel")).toBeHidden();
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    async function paintedFont(selector, expectedWeight) {
        await expect(page.locator(selector).first()).toBeVisible();
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        assert.ok(nodeId, selector);
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        assert.ok(fonts.some(font => font.glyphCount > 0), `${selector} paints actual text`);
        assert.ok(fonts.every(font => font.familyName.startsWith("Asta Sans") && font.isCustomFont),
            `${selector} paints the actual bundled IQOS face: ${JSON.stringify(fonts)}`);
        const style = await page.locator(selector).first().evaluate(node => {
            const css = getComputedStyle(node);
            return { family: css.fontFamily, weight: css.fontWeight };
        });
        if (expectedWeight) assert.equal(style.weight, expectedWeight, `${selector} uses its explicit card role`);
        else assert.ok(["400", "500", "600"].includes(style.weight), `${selector} uses an IQOS weight role`);
        return { selector, fonts, style };
    }
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.evaluate(() => [...document.fonts].filter(font => font.family === "Asta Sans")
        .map(font => ({ weight: font.weight, status: font.status }))), [{ weight: "300 800", status: "loaded" }]);
    const fontPaint = [];
    for (const selector of ["#periodHint", "#pageTitle", "#checkActivity", ".chart-heading h2", ".flat-time-axis > span"]) fontPaint.push(await paintedFont(selector));
    fontPaint.push(await paintedFont("#activityList .full-text-preview", "600"));
    assert.equal(fontPaint.find(value => value.selector === "#periodHint").style.weight, "400");
    assert.equal(fontPaint.find(value => value.selector === "#pageTitle").style.weight, "600");
    assert.equal(fontPaint.find(value => value.selector === "#checkActivity").style.weight, "600");
    const svgText = await page.locator("#workspace svg text").count();
    if (svgText) fontPaint.push(await paintedFont("#workspace svg text"));
    const screenPaint = [];
    async function inspect(name, theme) {
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const ink = await page.evaluate(visibleInk);
        assert.ok(ink.length > 10, name);
        for (const text of ink) {
            assert.ok(contrast(text.ink, text.background) >= 4.5, `${theme} ${name} ${JSON.stringify(text)}`);
            if (text.placeholder) assert.ok(contrast(text.placeholder, text.background) >= 4.5, text.target);
            if (!text.code) assert.match(text.font, /^"Asta Sans"/, text.target);
            if (text.cardEmphasis) assert.equal(text.weight, text.cardEmphasis, `${name} ${text.target}: explicit key/tool role`);
            else assert.ok(["400", "500", "600"].includes(text.weight), `${name} ${text.target}: ${text.weight}`);
        }
        const widths = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        assert.ok(widths.content <= widths.viewport + 1, `${name}: horizontal page overflow`);
        screenPaint.push({ name, theme, ink, widths });
    }
    const counts = await page.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
        category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage,
    })));
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await inspect("analyze", theme);
        await page.locator('[data-analyze-mode="calls"]').click();
        await inspect("calls", theme);
        fontPaint.push(await paintedFont("#activityList .full-text-preview", "600"));
        await page.locator('[data-analyze-mode="interactions"]').click();
        assert.deepEqual(await page.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage,
        }))), counts);
        const controls = [];
        for (const selector of ["#checkActivity", "#dateFilter-control", "#outcomeFilter-control",
            "#resultsLink", "#activityList a.request-link", ".percentage-label[href]"]) {
            const control = page.locator(selector).first();
            await control.hover();
            await inspect(`hover-${selector}`, theme);
            await control.focus();
            const paint = await control.evaluate(node => {
                const css = getComputedStyle(node), face = getComputedStyle(node, "::before");
                let parent = node.parentElement;
                while (parent && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
                const outside = getComputedStyle(parent || document.body).backgroundColor;
                const background = face.content !== "none" && face.backgroundColor !== "rgba(0, 0, 0, 0)" ? face.backgroundColor
                    : css.backgroundColor !== "rgba(0, 0, 0, 0)" ? css.backgroundColor : outside;
                const ring = parseFloat(css.outlineWidth) ? css : face;
                const border = face.content !== "none" && parseFloat(face.borderTopWidth) ? face : css;
                return { background, outside, ring: ring.outlineColor, width: parseFloat(ring.outlineWidth),
                    border: border.borderTopColor, borderWidth: parseFloat(border.borderTopWidth) };
            });
            assert.ok(paint.width >= 2, selector);
            assert.ok(contrast(paint.ring, paint.outside) >= 3, `${selector} outer focus`);
            assert.ok(contrast(paint.ring, paint.background) >= 3, `${selector} inner focus`);
            if (paint.borderWidth) assert.ok(contrast(paint.border, paint.background) >= 3, `${selector} control boundary`);
            controls.push({ selector, ...paint });
        }
        screenPaint.push({ name: "controls", theme, controls });
        await page.mouse.move(0, 0);
        for (const mark of await page.evaluate(measureChartPaint, ".percentage-face,.percentage-bar,.flat-time-segment")) {
            assert.ok(mark.local && mark.opacity === 1, JSON.stringify(mark));
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
            if (mark.category === "failure") for (const color of mark.colors) assert.ok(hue(color) < 15, color);
        }
        await page.locator("#outcomeFilter-control").click();
        await inspect("outcome-menu", theme);
        fontPaint.push(await paintedFont(".select-popup .result-option-label"));
        const statusColors = await page.locator(".select-popup .result-legend-icon").evaluateAll(nodes =>
            nodes.map(node => ({ tone: node.className, color: getComputedStyle(node).color })));
        assert.equal(new Set(statusColors.map(status => status.color)).size, 6, "Six outcome identities stay distinct");
        const failure = statusColors.find(status => status.tone.includes("result-tone-failure"));
        assert.ok(hue(failure.color) < 15);
        assert.equal(await page.locator('.select-option[data-value=failure] .result-option-label').evaluate(node => getComputedStyle(node).color), failure.color);
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-open-outcome-menu.png`) });
        await expect(page.locator(".select-popup")).toBeVisible();
        await page.keyboard.press("Escape");
        for (const node of await page.locator(".recorded-result.result-tone-failure").all()) {
            assert.equal(await node.evaluate(node => getComputedStyle(node).color), failure.color);
            assert.equal(await node.locator("svg").evaluate(node => getComputedStyle(node).fill), failure.color);
        }
        await selectActivityOption(page, "outcomeFilter", "failure");
        await expect(page.locator("#activityCount")).toHaveText("5");
        assert.equal(await page.locator("#outcomeFilter-control .result-option-label").evaluate(node => getComputedStyle(node).color), failure.color);
        await selectActivityOption(page, "outcomeFilter", "all");
        await expect(page.locator("#activityCount")).toHaveText("12");
        await page.locator("#activityList a.request-link").first().click();
        await inspect("interaction", theme);
        fontPaint.push(await paintedFont("#requestView h2"), await paintedFont("#requestView .full-text-content"));
        await navigateMain(page, "reports");
        await inspect("reports-library", theme);
        await page.locator("#reportCreateLink").click();
        await inspect("report-setup", theme);
        fontPaint.push(await paintedFont(".report-author-choice>label"));
        await navigateMain(page, "settings");
        for (const category of ["connection", "privacy", "ai", "display", "troubleshooting"]) {
            await navigateSettings(page, category);
            await inspect(`settings-${category}`, theme);
        }
        fontPaint.push(await paintedFont(".settings-section:not([hidden]) h2"));
        await navigateSettings(page, "privacy");
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteDialog")).toBeVisible();
        await inspect("delete-dialog", theme);
        fontPaint.push(await paintedFont("#deleteBoundary"), await paintedFont("#deleteTitle"));
        await page.locator("#deleteCancel").click();
        await navigateMain(page, "analyze");
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await inspect("analyze-200-percent-text", theme);
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
        await page.setViewportSize({ width: 375, height: 900 });
        await inspect("analyze-narrow", theme);
        await page.locator("#outcomeFilter-control").click();
        await inspect("menu-narrow", theme);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator("#outcomeFilter-control").click();
    assert.equal(await page.locator('.select-option[data-value=failure] .result-option-label').evaluate(node => getComputedStyle(node).color),
        await page.locator('.select-option[data-value=failure] .result-tone-failure').evaluate(node => getComputedStyle(node).color));
    await page.keyboard.press("Escape");
    await page.emulateMedia({ forcedColors: "none" });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.locator("#navigationToggle").click();
    fontPaint.push(await paintedFont("#navigationTitle"));
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationToggle")).toBeFocused();
    await cdp.detach();
    if (proofs) {
        await writeFile(path.join(proofs, "actual-paint-contrast.json"), JSON.stringify(measurements, null, 2));
        await writeFile(path.join(proofs, "platform-font-paint.json"), JSON.stringify({ fontPaint, svgText }, null, 2));
        await writeFile(path.join(proofs, "screen-text-paint.json"), JSON.stringify(screenPaint, null, 2));
        await page.screenshot({ path: path.join(proofs, "dark-narrow-workspace.png") });
    }
});
