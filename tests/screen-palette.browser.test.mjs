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

test("the built workbench carries Petrol and coral through every screen and nested reading state", { timeout: 120000 }, async t => {
    const cleanups = [], errors = [], proof = [], output = process.env.WIRE_PALETTE_PROOFS;
    const app = await searchFixture({ after: work => cleanups.push(work) }, { records: reviewRecords(), reply: false, frontend: "react" });
    const before = await loadBoardState(app.context), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
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
    for (const theme of ["light", "dark"]) {
        await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
        await ready(); await chooseTheme(page, theme); await page.evaluate(() => document.fonts.ready);
        await inspect("analyze", theme);
        const counts = await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes =>
            nodes.map(node => ({ category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage })));
        const expected = theme === "light"
            ? { success: "#006677", failure: "#af3e37", partial: "#7e6116", unknown: "#536171" }
            : { success: "#75c6d3", failure: "#f0a097", partial: "#dcc080", unknown: "#b4c0cf" };
        const colors = await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            category: node.dataset.category, ink: getComputedStyle(node.querySelector(".percentage-label")).color,
        })));
        for (const { category, ink } of colors) if (expected[category]) assert.deepEqual(rgb(ink), rgb(expected[category]), category);
        assert.ok(colors.some(value => value.category === "partial") && colors.some(value => value.category === "unknown"));
        for (const mark of await page.evaluate(measureChartPaint, ".percentage-face,.percentage-bar,.flat-time-segment")) {
            assert.ok(mark.local && mark.opacity === 1, JSON.stringify(mark));
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
        }
        await page.locator("#wireSearch").focus();
        const field = await page.locator("#wireSearch").evaluate(measureControlSurface);
        assert.ok(field.focusWidth >= 2 && contrast(field.focus, field.face) >= 3);
        assert.ok(contrast(field.border, field.face) >= 3);
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
        await page.locator('#activityList .request-card-open[href*="review-plural-activity"]').click();
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
        await page.locator("#trendsView").getByRole("button", { name: "Custom dates", exact: true }).click();
        await page.getByLabel("Trends from", { exact: true }).fill("2026-11-10");
        await page.getByLabel("Trends to", { exact: true }).fill("2026-11-16");
        await page.getByRole("button", { name: "Apply dates", exact: true }).click();
        await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
        await inspect("trends", theme);
        await page.goto(app.runtime.url + "#analyze?compare=periods&aFrom=2026-11-10&aTo=2026-11-12&bFrom=2026-11-14&bTo=2026-11-16");
        await ready(); await expect(page.locator(".compare-period-key p")).toHaveCount(2);
        await inspect("compare", theme);
        await navigateMain(page, "reports"); await inspect("reports", theme);
        await page.locator('[data-report-preset="errors"]').click();
        await expect(page.locator(".report-frame")).toBeVisible();
        await inspect("report-reading", theme);
        await navigateMain(page, "settings");
        for (const category of ["connection", "privacy", "display", "troubleshooting"]) {
            await navigateSettings(page, category);
            await inspect(`settings-${category}`, theme);
        }
        await navigateSettings(page, "privacy");
        await page.locator("#deleteActivity").click();
        await expect(page.locator("#deleteDialog")).toBeVisible();
        await inspect("settings-dialog", theme); await page.locator("#deleteCancel").click();
        await navigateSettings(page, "display"); await page.setViewportSize({ width: 390, height: 844 });
        await inspect("settings-narrow", theme);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
        await ready();
        assert.deepEqual(await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes =>
            nodes.map(node => ({ category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage }))), counts);
        if (output) {
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
