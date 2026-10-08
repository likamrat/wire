import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture } from "./helpers.mjs";

test("percentage summaries stay in place as paired and stacked exact-data bodies expand below them", async t => {
    const { context } = await privateFixture(t);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    t.after(async () => { await browser.close(); await runtime.close(); });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const card = page.locator('[data-percentage-card="composition"]');
    const summary = card.locator(".percentage-exact>summary");
    const measure = () => summary.evaluate(node => {
        const r = node.getBoundingClientRect(), card = node.closest(".percentage-card").getBoundingClientRect();
        return { x: r.x, y: r.y, documentY: r.y + scrollY, scrollY, bottom: r.bottom, cardHeight: card.height };
    });
    for (const width of [1600, 375]) {
        await page.setViewportSize({ width, height: 1000 }); await settle();
        await summary.scrollIntoViewIfNeeded(); await summary.focus();
        const before = await measure();
        await summary.click();
        await card.locator(".percentage-table").waitFor({ state: "visible" }); await settle();
        const open = await measure();
        for (const key of ["x", "y", "documentY", "scrollY"]) assert.ok(Math.abs(open[key] - before[key]) < 1, `${width}px: opening moves ${key} from ${before[key]} to ${open[key]}`);
        assert.ok(open.cardHeight > before.cardHeight, "Expanded content is not hidden or constrained to the closed height");
        assert.ok((await card.locator(".percentage-table").boundingBox()).y >= open.bottom, "The exact table expands below the stationary summary");
        await summary.click(); await settle();
        const closed = await measure();
        for (const key of ["x", "y", "documentY", "scrollY"]) assert.ok(Math.abs(closed[key] - before[key]) < 1, `${width}px: closing changes ${key}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
});
