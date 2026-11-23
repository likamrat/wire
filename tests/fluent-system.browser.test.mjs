import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

test("Analyze paints the bundled screen face offline and falls back for other writing systems in the prompt", async t => {
    const item = fixture("multilingual-screen");
    item.userPrompt.text = "Compare the plans: 日本語 العربية.";
    const { context } = await privateFixture(t, [item]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
    const outside = [];
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === new URL(runtime.url).origin) return route.continue();
        outside.push(route.request().resourceType()); return route.abort();
    });
    const response = await page.goto(runtime.url);
    assert.match(response.headers()["content-security-policy"], /(?:^|;\s*)font-src data:(?:;|$)/);
    const excerpt = page.locator("#activityList .card-excerpt");
    await expect(excerpt).toHaveText(item.userPrompt.text);
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#activityList .card-excerpt" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some(font => font.glyphCount && font.isCustomFont && font.familyName.startsWith("Asta Sans")), JSON.stringify(fonts));
    assert.ok(fonts.some(font => font.glyphCount && !font.isCustomFont), "Non-Latin glyphs use local fallback fonts");
    assert.deepEqual(outside, []);
});
