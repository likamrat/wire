import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { privateFixture, fixture, chooseTheme } from "../support/helpers.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { contrast, measureControlSurface } from "../support/color-measurements.mjs";

for (const [path, name] of [["/", "Filters and view"], ["/reports", "Prepare preview"]])
test(`${name} stays readable under a stationary pointer through a keyboard theme change`, async t => {
    const { context } = await privateFixture(t, [fixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "no-preference" });
    await page.addInitScript({ content: `window.controlPaint = ${measureControlSurface};` });
        await page.goto(new URL(path, runtime.url).href);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await chooseTheme(page, "light");
        const target = page.getByRole("button", { name, exact: true });
        const toggle = page.getByRole("switch", { name: "Dark theme", exact: true });
        for (const theme of ["dark", "light"]) {
            await toggle.focus();
            await target.hover();
            const start = await target.evaluate(async node => {
                await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished));
                const label = node.querySelector(".filter-entry-label") ?? node;
                const frames = [], sample = () => {
                    const { face } = window.controlPaint(node), ink = getComputedStyle(label).color;
                    frames.push({ theme: document.documentElement.dataset.evidenceTheme, hovered: node.matches(":hover"), face, ink });
                    window.nextPaint = requestAnimationFrame(sample);
                };
                window.controlFrames = frames; sample();
                return node.getBoundingClientRect().height;
            });
            await page.keyboard.press("Space");
            await expect(page.locator("html")).toHaveAttribute("data-evidence-theme", theme);
            const frames = await target.evaluate(async node => {
                await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                cancelAnimationFrame(window.nextPaint);
                return window.controlFrames;
            });
            assert.ok(start >= 44, `${name}: usable target`);
            assert.deepEqual(new Set(frames.map(frame => frame.theme)), new Set(["light", "dark"]));
            for (const { theme: sampled, hovered, face, ink } of frames) {
                assert.ok(hovered, `${name}: pointer still on target`);
                assert.ok(contrast(ink, face) >= 4.5, `${name}/${sampled}: ${ink} on ${face}`);
            }
        }
});
