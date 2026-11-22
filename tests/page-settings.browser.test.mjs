import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { navigateSettings, selectActivityOption } from "./helpers.mjs";

test("page settings retain a nonempty format choice on reload and expose keyboard-searchable defaults", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await page.goto(new URL("/settings", runtime.url).href);
    await expect(page.locator("#generalTitle")).toBeVisible();
    const nav = page.locator("#settingsCategoryNav");
    await expect(nav.getByRole("link")).toHaveCount(11);
    await expect(nav.getByText("Page defaults", { exact: true })).toBeVisible();
    const namedDefaults = {
        analyze: [["defaultAnalyzeRange-control", "Default date range"]],
        trends: [["defaultTrendChart-control", "Default trend chart"]],
        reports: [["defaultReportFormats", "Default file formats"], ["defaultReportPeriod-control", "Default reporting period"]],
        compare: [["defaultCompareDays-control", "Default comparison period"]],
    };
    const ids = await nav.getByRole("link").evaluateAll(links => links.map(a => a.dataset.category));
    for (const id of ids) {
        await nav.locator(`[data-category="${id}"]`).click();
        await expect(page.locator(`[data-settings-section="${id}"] > h2 + .settings-intro`)).toBeVisible();
        for (const [control, name] of namedDefaults[id] ?? []) {
            await expect(page.locator("#" + control)).toHaveAccessibleName(name);
        }
    }
    const query = page.getByRole("searchbox", { name: "Search settings" });
    await query.fill("default file formats");
    const result = page.locator('#settingsSearchResults [data-setting="report-formats"]');
    await result.focus(); await page.keyboard.press("Enter");
    const html = page.locator("#defaultFormat-html"), json = page.locator("#defaultFormat-json");
    await expect(html).toBeFocused();
    await page.keyboard.press("Space");
    await expect(html).toBeChecked();
    await expect(page.locator("#defaultReportFormatsStatus")).toHaveText(/at least one/);
    await json.check(); await html.uncheck();
    await page.goBack(); await expect(result).toBeFocused();
    await page.goto(new URL("/settings?section=reports", runtime.url).href);
    await expect(json).toBeChecked(); await expect(html).not.toBeChecked();
    await selectActivityOption(page, "defaultReportPeriod", "14");
    await page.reload(); await expect(page.locator("#defaultReportPeriod-control")).toContainText("Last 14 days");
    await page.setViewportSize({ width: 375, height: 850 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await navigateSettings(page, "compare");
    await page.locator("#defaultCompareDays-control").focus();
    await page.keyboard.press("Enter"); await page.getByRole("option", { name: "Last 30 complete days" }).click();
    await expect(page.locator("#defaultCompareDays")).toHaveValue("30");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
});

test("a real storage refusal is visible beside the edited default without claiming persistence", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.addInitScript(() => {
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === "wire.page-defaults.v1.trendChart") throw new DOMException("Full fixture storage", "QuotaExceededError");
            return write.call(this, key, value);
        };
    });
    await page.goto(new URL("/settings?section=trends", runtime.url).href);
    await selectActivityOption(page, "defaultTrendChart", "timing");
    await expect(page.locator("#defaultTrendChart-control")).toContainText("Call duration");
    await expect(page.locator("#defaultTrendChartStatus")).toHaveText(/could not be saved.*this panel only/i);
    await page.reload(); await expect(page.locator("#defaultTrendChart-control")).toContainText("Errors & failures");
});
