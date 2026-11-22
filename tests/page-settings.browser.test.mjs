import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
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
    const group = nav.getByRole("group", { name: "WIRE defaults" });
    await expect(group.getByRole("link")).toHaveText(["Analyze", "Trends", "Reports", "Compare"]);
    await expect(nav.getByRole("link", { name: "Help" })).toBeVisible();
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
        if (id in namedDefaults) await expect(page.locator(`[data-settings-section="${id}"] > .settings-intro`)).toHaveText(/default/i);
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

test("Last 14 days persists from Settings and opens Analyze on the matching activity", async t => {
    const records = searchRecords(4);
    const starts = ["2026-09-17T03:59:59Z", "2026-09-17T04:00:00Z", "2026-09-30T21:00:00Z", "2026-10-01T04:00:00Z"];
    for (const [i, row] of records.entries()) row.toolCalls[0].startedAt = row.capturedAt = starts[i];
    const { runtime } = await searchFixture(t, { frontend: "react", reply: false, records });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    await page.clock.setFixedTime(new Date("2026-10-01T02:00:00Z"));
    await page.goto(new URL("/settings?section=analyze", runtime.url).href);
    await expect(page.locator("#defaultAnalyzeRange option")).toHaveText(["All dates", "Last 7 days", "Last 14 days", "Last 30 days"]);
    await selectActivityOption(page, "defaultAnalyzeRange", "14");
    await page.reload();
    await expect(page.locator("#defaultAnalyzeRange-control")).toContainText("Last 14 days");
    await page.locator("nav [data-nav=analyze]").click();
    await expect(page.locator("#dateFilter")).toHaveValue("14");
    await expect(page.locator("#fromFilter")).toHaveValue("2026-09-17");
    await expect(page.locator("#toFilter")).toHaveValue("2026-09-30");
    await expect(page.locator("#activityListSummary")).toContainText("2 matching tool calls");
    const address = new URL(page.url());
    assert.equal(address.searchParams.get("range"), "14");
    assert.equal(address.searchParams.has("privateView"), false);
    await selectActivityOption(page, "dateFilter", "7");
    await expect(page.locator("#activityListSummary")).toContainText("1 matching tool call");
    await page.goBack();
    await expect(page.locator("#dateFilter")).toHaveValue("14");
    await expect(page.locator("#activityListSummary")).toContainText("2 matching tool calls");
});
