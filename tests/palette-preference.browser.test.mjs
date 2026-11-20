import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { selectActivityOption } from "./helpers.mjs";

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
