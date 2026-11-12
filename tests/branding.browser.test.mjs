import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { FAVICON_PATH, logoSvg } from "../lib/branding.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

test("the selected identity paints correctly in the header, compact rail, drawer and favicon", { timeout: 60000 }, async t => {
    const record = fixture("magenta-brand");
    record.capturedAt = new Date().toISOString();
    record.toolCalls[0].startedAt = record.capturedAt;
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [record]);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        try { await browser.close(); }
        finally {
            try {
                await runtime.close();
                const after = await loadBoardState(context);
                for (const key of ["cards", "evidence", "exports"]) assert.deepEqual(after[key], before[key]);
            } finally { for (const work of cleanup) await work(); }
        }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const proofs = process.env.WIRE_BRAND_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const capture = async name => {
        if (proofs) await page.screenshot({ path: path.join(proofs, `${name}.png`), animations: "disabled" });
    };
    const settle = () => page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), FAVICON_PATH);
    for (const uri of [FAVICON_PATH, "/favicon.svg"]) {
        const response = await page.request.get(new URL(uri, runtime.url).href);
        assert.equal(response.status(), 200);
        assert.equal(response.headers()["content-type"], "image/svg+xml; charset=utf-8");
        assert.equal(await response.text(), logoSvg);
    }

    for (const [theme, low, high] of [
        ["light", "rgb(143, 41, 102)", "rgb(198, 57, 141)"],
        ["dark", "rgb(198, 57, 141)", "rgb(217, 124, 180)"],
    ]) {
        await chooseTheme(page, theme);
        const full = page.locator(`#shellBrand .brand-logo[data-brand-theme=${theme}]`);
        await expect(full).toBeVisible();
        await expect(full).toHaveCSS("width", "120px");
        assert.equal(await full.locator("text").count(), 0, "No expanded-name descriptor is painted");
        await expect(page.locator("#shellBrand .brand-home")).toHaveCSS("height", "44px");
        const header = await page.locator(".app-header").boundingBox();
        await capture(`header-${theme}`);

        await page.locator("#navigationCollapse").click(); await settle();
        const compact = page.locator("#shellBrand .brand-compact");
        await expect(compact).toHaveCSS("opacity", "1");
        await expect(full).toHaveCSS("opacity", "0");
        await expect(compact.locator(".brand-low").first()).toHaveCSS("stop-color", low);
        await expect(compact.locator(".brand-high").first()).toHaveCSS("stop-color", high);
        assert.equal((await page.locator(".app-header").boundingBox()).height, header.height);
        await capture(`compact-${theme}`);
        await page.locator("#navigationCollapse").click(); await settle();

        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator("#navigationToggle").click();
        const drawer = page.locator("#navigationDrawer");
        await expect(drawer.locator(`.brand-logo[data-brand-theme=${theme}]`)).toBeVisible();
        await expect(drawer.locator(".brand-compact")).toBeHidden();
        const target = await drawer.locator(".brand-home").boundingBox();
        assert.ok(target.width >= 44 && target.height >= 44);
        await capture(`drawer-${theme}`);
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
    }

    const favicon = await browser.newPage();
    for (const [scheme, expected] of [["light", "rgb(143, 41, 102)"], ["dark", "rgb(198, 57, 141)"]]) {
        await favicon.emulateMedia({ colorScheme: scheme });
        await favicon.goto(new URL(FAVICON_PATH, runtime.url).href);
        await expect(favicon.locator(".brand-low").first()).toHaveCSS("stop-color", expected);
    }
    assert.deepEqual(errors, []);
});
