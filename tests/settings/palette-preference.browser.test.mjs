import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "../search/live-search-fixture.mjs";
import { selectActivityOption } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

for (const frontend of ["bundled", "react"]) test(`${frontend} navigation rows distinguish hover, current location and keyboard focus from prose links`, async t => {
    const { runtime } = await searchFixture(t, { frontend, records: [], reply: false });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const paint = node => { const s = getComputedStyle(node); return { line: s.textDecorationLine, fill: s.backgroundColor, ink: s.color, ring: s.outlineStyle }; };
    for (const [mode, width, scale, palette] of [["light", 1440, 100, "petrol"], ["dark", 390, 200, "midnight"]]) {
        await page.setViewportSize({width,height:900});
        await page.goto(new URL("/settings?section=themes",runtime.url).href);
        await page.locator(`.palette-option:has(#palette-${palette})`).click();
        if (await page.locator("html").getAttribute("data-evidence-theme") !== mode) await page.locator("#settingsThemePreference").click();
        await page.evaluate(s => document.documentElement.style.fontSize = s+"%",scale);
        const category = page.locator('#settingsCategoryNav [data-category=regional]');
        if (!await category.isVisible()) await page.locator("#settingsCategorySummary").click();
        await category.hover();
        const hovered = await category.evaluate(paint);
        if (process.env.WIRE_NAV_STATE_PROOFS) {
            await mkdir(process.env.WIRE_NAV_STATE_PROOFS,{recursive:true});
            await page.screenshot({path:path.join(process.env.WIRE_NAV_STATE_PROOFS,`${frontend}-${mode}-hover.png`)});
        }
        assert.equal(hovered.line,"none");
        assert.notEqual(hovered.fill,"rgba(0, 0, 0, 0)");
        assert.ok(contrast(hovered.ink,hovered.fill)>=4.5);
        await page.mouse.down(); const pressed=await category.evaluate(paint); await page.mouse.up();
        assert.equal(pressed.line,"none"); assert.notEqual(pressed.fill,hovered.fill);
        await expect(page.locator("#regionalTitle")).toBeFocused();
        if (!await category.isVisible()) await page.locator("#settingsCategorySummary").click();
        await category.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
        await expect(category).toBeFocused(); await expect(category).toHaveAttribute("aria-current","page");
        assert.equal((await category.evaluate(paint)).ring,"solid");
        assert.equal(await category.evaluate(n=>getComputedStyle(n,"::before").width),"2px");
        await page.locator("#settingsSearch").fill("Midnight");
        const result=page.locator('#settingsSearchResults a[data-setting=palette]');
        await result.hover(); const hit=await result.evaluate(paint); assert.equal(hit.line,"none"); assert.ok(contrast(hit.ink,hit.fill)>=4.5);
        await result.click(); await expect(page.locator(`#palette-${palette}`)).toBeFocused();
        await page.goBack(); await expect(result).toBeFocused();
        const sidebar=page.locator('a[data-nav=reports]');
        if (!await sidebar.isVisible()) await page.locator("#navigationToggle").click();
        await sidebar.hover(); assert.equal((await sidebar.evaluate(paint)).line,"none");
        await page.goto(new URL("/settings?section=source-access",runtime.url).href);
        await expect(page.locator("#connectionTitle")).toHaveText("Sources");
    }
});

for (const frontend of [undefined, "bundled", "react"]) {
    test(`${frontend ?? "serialized"} shell applies the stored palette before mount and recovers failed writes`, async t => {
        const { runtime } = await searchFixture(t, { frontend, records: [], reply: false });
        const browser = await chromium.launch();
        t.after(() => browser.close());
        const context = await browser.newContext({ colorScheme: "dark", reducedMotion: "reduce" });
        await context.addInitScript(() => {
            if (!sessionStorage.seededPalette) {
                sessionStorage.seededPalette = "yes";
                localStorage.setItem("workiq-evidence.theme", "light");
                localStorage.setItem("workiq-evidence.palette.v1", "midnight");
            }
            // This microtask runs just after the synchronous head bootstrap, before client mounting.
            const watch = new MutationObserver(() => {
                if (!document.documentElement?.dataset.evidencePalette) return;
                window.firstPalette = [document.documentElement.dataset.evidencePalette, document.documentElement.dataset.evidenceTheme,
                    !!document.getElementById("wireBrowserEntry"), document.body !== null];
                watch.disconnect();
            });
            watch.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-evidence-palette"] });
        });
        const page = await context.newPage(), url = new URL("/settings?section=display",runtime.url).href;
        await page.goto(url); await expect(page.locator("#palette-midnight")).toBeChecked();
        await expect(page).toHaveURL(/\/settings\?section=themes$/);
        await expect(page.locator(".palette-scene").first()).toHaveText("");
        await expect(page.getByRole("radio", { name: "Midnight", exact: true })).toBeVisible();
        await expect(page.locator("#displayTimeZone-control")).toBeHidden();
        assert.deepEqual(await page.evaluate(() => window.firstPalette), ["midnight","light",false,false]);
        const first = page.locator("#palette-midnight"), earlier = await first.elementHandle();
        await page.evaluate(() => {
            const set = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
                if (key === "workiq-evidence.palette.v1" && !window.allowPalette) throw new DOMException("Test quota", "QuotaExceededError");
                return set.call(this, key, value);
            };
        });
        await page.locator("label:has(>#palette-linen)").click();
        await expect(page.locator("#paletteStorageNotice")).toBeVisible();
        assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.palette.v1")), "midnight");
        await page.evaluate(() => { window.allowPalette = true; });
        await page.locator("#retryPalette").click();
        await expect(page.locator("#paletteStorageNotice")).toBeHidden();
        assert.ok(await first.evaluate((n,original) => n === original, earlier));
        await page.reload(); await expect(page.locator("#palette-linen")).toBeChecked();
        const other = await context.newPage(); await other.goto(url);
        await other.locator("label:has(>#palette-field)").click();
        await expect(page.locator("#palette-field")).toBeChecked();
        await other.evaluate(() => localStorage.setItem("workiq-evidence.palette.v1","future"));
        await other.locator("#settingsThemePreference").click(); // Later storage event is a delivery barrier.
        await expect(page.locator("html")).toHaveAttribute("data-evidence-theme", "dark");
        await expect(page.locator("#palette-field")).toBeChecked();
        await page.reload(); await expect(page.locator("#palette-petrol")).toBeChecked();
        assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.palette.v1")), "future");
        await page.locator("label:has(>#palette-linen)").click();
        await page.locator("#resetPalette").click(); await expect(other.locator("#palette-petrol")).toBeChecked();
        await expect(page.locator("html")).toHaveAttribute("data-evidence-theme","dark");
        await page.goto(new URL("/settings?section=display&setting=time-zone",runtime.url).href);
        await expect(page).toHaveURL(/section=regional&setting=time-zone/);
        await expect(page.locator("#displayTimeZone-control")).toBeVisible();
        await selectActivityOption(page,"displayTimeZone","UTC");
        assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), "UTC");
        await page.locator("#settingsSearch").fill("Midnight");
        await page.locator("#settingsSearchResults a[data-setting=palette]").click();
        await expect(page).toHaveURL(/section=themes&setting=palette/);
        await expect(page.locator("#palette-petrol")).toBeFocused();
    });
}
