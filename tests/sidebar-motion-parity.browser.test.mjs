import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { authorFilterFixture } from "./prompt-author-filter-fixture.mjs";

for (const [width, reducedMotion] of [[1920, "reduce"], [676, "reduce"], [1920, "no-preference"]])
test(`Filters and guide visibly glide like both reference sidebars (${width}px, ${reducedMotion})`, { timeout: 30000 }, async t => {
    const app = await authorFilterFixture(t, { serviceCases: true });
    const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const page = await browser.newPage({ viewport: { width, height: 1080 }, reducedMotion });
    const errors = [], denied = [];
    app.closeClient(async () => {
        await browser.close();
        assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.addInitScript(() => {
        window.motionParity = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
            const animation = animate.call(this, frames, options);
            if (!["sidebar", "navigationDrawer", "contextSidebar", "analyzeFilterDialog", "meaning"].includes(this.id)) return animation;
            const node = this, timing = animation.effect.getTiming();
            const run = { id: node.id, duration: timing.duration, easing: timing.easing, samples: [] };
            window.motionParity.push(run);
            function sample() {
                const box = node.getBoundingClientRect(), progress = animation.effect.getComputedTiming().progress;
                run.samples.push({ progress, x: box.x, width: box.width, visible: node.checkVisibility() });
                if (animation.playState === "running") requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
            return animation;
        };
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reducedMotion === "reduce");
    const settle = () => page.waitForFunction(() => document.getAnimations().filter(animation =>
        animation.effect.getTiming().iterations !== Infinity).every(animation => animation.playState !== "running"));
    if (width >= 700) {
        for (let i = 0; i < 2; i++) { await page.locator("#navigationCollapse").click(); await settle(); }
    } else {
        await page.locator("#navigationToggle").click(); await settle();
        await page.locator("#closeNavigation").click(); await expect(page.locator("#navigationDrawer")).toBeHidden(); await settle();
    }
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar")).toBeVisible(); await settle();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden(); await settle();
    for (const [trigger, panel, close] of [
        ["#openAnalyzeFilters", "#analyzeFilterDialog", "#closeAnalyzeFilters"],
        ["#openChartReference", "#meaning", "#closeChartReference"],
    ]) {
        await page.locator(trigger).click();
        await expect(page.locator(panel)).toBeVisible(); await settle();
        await page.locator(close).click();
        await expect(page.locator(panel)).toBeHidden(); await settle();
        await expect(page.locator(trigger)).toBeFocused();
    }
    const runs = await page.evaluate(() => window.motionParity);
    if (process.env.WIRE_MOTION_PARITY_PROOFS) {
        await mkdir(process.env.WIRE_MOTION_PARITY_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_MOTION_PARITY_PROOFS, `motion-${width}-${reducedMotion}.json`),
            JSON.stringify({ width, reducedMotion: reducedMotion === "reduce", runs }, null, 2));
    }
    for (const id of [width >= 700 ? "sidebar" : "navigationDrawer", "contextSidebar", "analyzeFilterDialog", "meaning"]) {
        const animations = runs.filter(run => run.id === id);
        assert.equal(animations.length, 2, `${id}: explicit opening and closing follow the reference policy`);
        for (const run of animations) {
            assert.equal(run.duration, 320); assert.equal(run.easing, "cubic-bezier(0.2, 0, 0, 1)");
            const interior = run.samples.filter(sample => sample.visible && sample.progress > .02 && sample.progress < .98);
            assert.ok(interior.length >= 2, `${id}: intermediate painted frames, not just animate() calls`);
            const values = interior.map(sample => id === "sidebar" ? sample.width : sample.x);
            assert.ok(Math.max(...values) - Math.min(...values) > 40, `${id}: visible horizontal travel matches the reference sidebars`);
        }
    }
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), reducedMotion === "reduce");
});
