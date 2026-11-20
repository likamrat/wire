import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { reviewRecords } from "./frontend-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, openAnalyzeFilters, closeAnalyzeFilters } from "./helpers.mjs";
import { contrast, rgb, measureChartPaint, measureControlSurface, visibleInk } from "./color-measurements.mjs";
import { loadBoardState } from "../lib/store.mjs";

test("the built workbench carries each palette through screens and nested reading states", { timeout: 360000 }, async t => {
    const cleanups = [], errors = [], proof = [], output = process.env.WIRE_PALETTE_PROOFS;
    const app = await searchFixture({ after: work => cleanups.push(work) }, { records: reviewRecords(), reply: false, frontend: "react" });
    const before = await loadBoardState(app.context), browser = await chromium.launch();
    const profile = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const page = await profile.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => assert.equal(new URL(request.url()).origin, new URL(app.runtime.url).origin));
    t.after(async () => {
        await browser.close();
        try {
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "exports", "collection"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []);
        } finally { for (const work of cleanups.reverse()) await work(); }
    });
    if (output) await mkdir(output, { recursive: true });
    const ready = () => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const settle = () => page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    async function inspect(name, theme) {
        await settle();
        const ink = await page.evaluate(visibleInk);
        const failures = ink.filter(value => contrast(value.ink, value.background) < 4.5
            || value.placeholder && contrast(value.placeholder, value.background) < 4.5);
        assert.deepEqual(failures, [], `${theme} ${name}: actual composed text contrast`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name);
        proof.push({ name, theme, textCount: ink.length, minimum: Math.min(...ink.map(value => contrast(value.ink, value.background))) });
        if (output) await page.screenshot({ path: path.join(output, `${theme}-${name}.png`) });
    }
    for (const palette of ["petrol", "linen", "blue", "field", "midnight"]) for (const mode of ["light", "dark"]) {
        const theme = `${palette}-${mode}`;
        await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
        await ready(); await chooseTheme(page, mode);
        await navigateMain(page, "settings"); await navigateSettings(page, "themes");
        const option = page.locator(`.palette-option:has(#palette-${palette})`);
        await option.click();
        await expect(page.locator("html")).toHaveAttribute("data-evidence-palette", palette);
        await expect(option.getByRole("radio")).toBeChecked();
        await option.getByRole("radio").focus();
        // Simulate denial for the next palette write only; the app must keep the new
        // choice locally, announce the failure, and save it on deliberate retry.
        await page.evaluate(() => {
            const write = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key !== "workiq-evidence.palette.v1") return write.call(this, key, value);
                Storage.prototype.setItem = write;
                throw new DOMException("Test quota", "QuotaExceededError");
            };
        });
        await page.keyboard.press("ArrowRight"); await expect(page.locator("#paletteStorageNotice")).toBeVisible();
        await page.locator("#retryPalette").click(); await expect(page.locator("#paletteStorageNotice")).toBeHidden();
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
        await expect(option.getByRole("radio")).toBeChecked();
        const ring = await option.evaluate(node => ({ width:parseFloat(getComputedStyle(node).outlineWidth),
            color:getComputedStyle(node).outlineColor, backdrop:getComputedStyle(node.closest(".settings-section")).backgroundColor,
            paper:getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() }));
        assert.ok(ring.width >= 2 && contrast(ring.color,ring.paper) >= 3);
        await option.hover(); await inspect("palette-hover",theme); await page.mouse.down();
        try { await inspect("palette-pressed",theme); } finally { await page.mouse.up(); }
        await page.locator("#paletteEmpty").waitFor({state:"hidden"});
        await page.emulateMedia({forcedColors:"active"});
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowLeft");
        await expect(option.getByRole("radio")).toBeChecked();
        assert.equal(await option.evaluate(n => getComputedStyle(n).outlineStyle),"dashed");
        await page.emulateMedia({forcedColors:"none"});
        await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
        await ready(); await page.evaluate(() => document.fonts.ready);
        await inspect("analyze", theme);
        const counts = await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes =>
            nodes.map(node => ({ category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage })));
        const expected = Object.fromEntries(await page.locator("html").evaluate((node) =>
                [["success","--tool-positive"],["failure","--tool-negative"],["partial","--warning"],["unknown","--unknown"]]
                    .map(([id,role]) => [id, getComputedStyle(node).getPropertyValue(role).trim()])));
        const colors = await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            category: node.dataset.category, ink: getComputedStyle(node.querySelector(".percentage-label")).color,
        })));
        for (const { category, ink } of colors) if (expected[category]) assert.deepEqual(rgb(ink), rgb(expected[category]), category);
        assert.ok(colors.some(value => value.category === "partial") && colors.some(value => value.category === "unknown"));
        const marks = await page.evaluate(measureChartPaint, ".percentage-face,.percentage-bar,.flat-time-segment");
        for (const mark of marks) {
            assert.ok(mark.local && mark.opacity === 1, JSON.stringify(mark));
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
        }
        await page.locator("#wireSearch").focus();
        const field = await page.locator("#wireSearch").evaluate(measureControlSurface);
        assert.ok(field.focusWidth >= 2 && contrast(field.focus, field.face) >= 3);
        assert.ok(contrast(field.border, field.face) >= 3);
        proof.push({ name:"chart and control", theme, chart:Math.min(...marks.flatMap(mark => mark.colors.map(ink => contrast(ink,mark.background)))),
            edge:contrast(field.border,field.face), focus:contrast(field.focus,field.face) });
        await page.keyboard.press("Escape");
        await openAnalyzeFilters(page);
        await page.locator("#outcomeFilter-control").click();
        await inspect("outcome-menu", theme);
        const states = await page.locator(".select-popup .result-option-label").evaluateAll(nodes => nodes.map(node => ({
            text: node.textContent, ink: getComputedStyle(node).color,
            icon: node.closest(".select-option").querySelector("svg").dataset.lucideIcon,
        })));
        assert.equal(new Set(states.map(state => state.icon)).size, 6, "All recorded outcomes retain their distinct icons");
        await page.locator(".select-popup .select-all").click();
        const apply = page.locator(".select-popup .select-apply");
        await expect(apply).toBeDisabled();
        const disabled = await apply.evaluate(measureControlSurface);
        assert.ok(contrast(disabled.ink, disabled.face) >= 4.5);
        await page.keyboard.press("Escape"); await closeAnalyzeFilters(page);
        await page.locator('#activityList .request-card-open').filter({ hasText: /Cedar/ }).first().click();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await inspect("reader", theme);
        await page.locator("#requestContent .reader-call-toggle").first().hover();
        await inspect("reader-hover", theme);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await inspect("reader-narrow-enlarged", theme);
        await page.locator("#closeContextSidebar").click();
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator("#wireSearch").fill("Cedar");
        await expect(page.locator(".wire-search-hit").first()).toBeVisible();
        await inspect("search", theme); await page.keyboard.press("Escape");
        await navigateMain(page, "trends");
        await page.locator("#trendsPeriod").click();
        await page.locator("#trendsView").getByRole("button", { name: "Custom dates", exact: true }).click();
        await page.getByLabel("Trends from", { exact: true }).fill("2026-11-10");
        await page.getByLabel("Trends to", { exact: true }).fill("2026-11-16");
        await page.getByRole("button", { name: "Apply dates", exact: true }).click();
        await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
        await inspect("trends", theme);
        const trendInks = await page.locator("#trendsView [data-trend-line],#trendsView [data-trend-bar]").evaluateAll(nodes => nodes.filter(n => n.checkVisibility())
            .map(n => { const css = getComputedStyle(n), rect = n.closest(".trends-plot");
                let surface = rect;
                while (surface && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)") surface = surface.parentElement;
                return { ink: n.hasAttribute("data-trend-line") ? css.stroke : css.fill, bg: getComputedStyle(surface).backgroundColor }; }));
        assert.ok(trendInks.length, "Rendered series in current Trends");
        const minTrend = Math.min(...trendInks.map(mark => contrast(mark.ink,mark.bg)));
        assert.ok(minTrend >= 3, `${theme}: Trends marks ${minTrend}`); proof.push({name:"trends marks",theme,minTrend});
        await page.goto(app.runtime.url + "#analyze?compare=periods&aFrom=2026-11-10&aTo=2026-11-12&bFrom=2026-11-14&bTo=2026-11-16");
        await ready(); await expect(page.locator(".compare-period-key p")).toHaveCount(2);
        await inspect("compare", theme);
        await navigateMain(page, "reports"); await inspect("reports", theme);
        await page.locator('[data-report-preset="errors"]').click();
        await expect(page.locator(".report-frame")).toBeVisible();
        await inspect("report-reading", theme);
        const editorFrame = page.locator("iframe.report-frame").first();
        const editorBody = editorFrame.contentFrame().locator("body"), frameId = await editorFrame.elementHandle();
        await expect(editorBody).toBeVisible();
        const previous = await editorBody.innerText();
        const control = await profile.newPage();
        await control.goto(new URL("/settings?section=display", app.runtime.url).href);
        const alternate = palette === "linen" ? "blue" : "linen";
        await control.locator(`.palette-option:has(#palette-${alternate})`).click();
        const sheet = await control.locator("html").evaluate(n => getComputedStyle(n).getPropertyValue("--report-sheet").trim());
        await expect.poll(() => editorBody.evaluate(n => n.ownerDocument.documentElement.style.getPropertyValue("--report-sheet").trim())).toBe(sheet);
        assert.ok(await editorFrame.evaluate((n,original) => n === original,frameId));
        assert.equal(await editorBody.innerText(),previous);
        await control.locator(`.palette-option:has(#palette-${palette})`).click(); await control.close();
        await navigateMain(page, "settings");
        for (const category of ["connection", "privacy", "themes", "regional", "troubleshooting"]) {
            await navigateSettings(page, category);
            await inspect(`settings-${category}`, theme);
        }
        await navigateSettings(page, "privacy");
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteDialog")).toBeVisible();
        await inspect("settings-dialog", theme); await page.locator("#deleteCancel").click();
        await navigateSettings(page, "themes"); await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await inspect("settings-narrow", theme);
        await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
        await ready();
        assert.deepEqual(await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes =>
            nodes.map(node => ({ category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage }))), counts);
        if (output && palette === "petrol") {
            await page.evaluate(() => scrollTo(0, 0));
            await settle();
            const cdp = await page.context().newCDPSession(page);
            for (const type of ["protanopia", "deuteranopia", "tritanopia"]) {
                await cdp.send("Emulation.setEmulatedVisionDeficiency", { type });
                await page.screenshot({ path: path.join(output, `${theme}-${type}.png`) });
            }
            await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }); await cdp.detach();
        }
    }
    if (output) await writeFile(path.join(output, "contrast.json"), JSON.stringify(proof, null, 2));
});
