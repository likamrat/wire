import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { closeAnalyzeFilters, fulfillFixtureUpdateStatus, navigateMain, navigateSettings, selectActivityOption } from "./helpers.mjs";
import { openDatePicker } from "./analytics-date-picker.mjs";

test("page settings retain a nonempty format choice on reload and expose keyboard-searchable defaults", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await page.goto(new URL("/settings", runtime.url).href);
    await expect(page.locator("#generalTitle")).toBeVisible();
    const nav = page.locator("#settingsCategoryNav");
    await expect(nav.getByRole("link")).toHaveCount(10);
    const group = nav.getByRole("group", { name: "WIRE defaults" });
    await expect(group.getByRole("link")).toHaveText(["Analyze", "Trends", "Reports", "Compare"]);
    await expect(nav.getByRole("link", { name: "Help" })).toHaveCount(0);
    const namedDefaults = {
        analyze: [["defaultAnalyzeRange-control", "Default date range"], ["defaultGuideStart-control", "Open Guide to"]],
        trends: [["defaultTrendChart-control", "Default trend chart"]],
        reports: [["defaultReportFormats", "Default formats"], ["defaultReportPeriod-control", "Default reporting period"]],
        compare: [["defaultCompareDays-control", "Default comparison period"]],
    };
    const ids = await nav.getByRole("link").evaluateAll(links => links.map(a => a.dataset.category));
    for (const id of ids) {
        await nav.locator(`[data-category="${id}"]`).click();
        if (id === "general") {
            const card = page.locator("#generalTitle + .app-version-card");
            await expect(card.getByRole("heading", { name: /^WIRE v/ })).toBeVisible();
            await expect(card.getByRole("link", { name: "Update instructions" })).toBeVisible();
        } else {
            await expect(page.locator(`[data-settings-section="${id}"] > h2 + .settings-intro`)).toBeVisible();
        }
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

for (const frontend of ["react", "bundled"]) test(`workspace addresses name destinations, not their controls (${frontend})`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const records = searchRecords();
    for (const row of records) row.toolCalls[0].startedAt = row.capturedAt;
    const { runtime } = await searchFixture(t, { frontend, records, reply: false });
    const page = await browser.newPage({ timezoneId: "UTC" });
    await page.clock.setFixedTime(new Date("2026-10-01T12:00:00Z"));
    const visit = async (view, path) => {
        await navigateMain(page, view);
        await expect(page).toHaveURL(new URL(path, runtime.url).href);
    };
    await page.goto(runtime.url);
    await page.locator("#openEvidenceHelp").click();
    await expect(page.locator("#help-reports")).toBeVisible();
    await visit("settings", "/settings");
    await navigateSettings(page, "analyze");
    const category = page.url();
    await selectActivityOption(page, "defaultAnalyzeRange", "7");
    await expect(page).toHaveURL(category);
    await visit("reports", "/reports");
    await page.locator("#reportDeskDates").click();
    await page.locator("#reportPeriodChoices").getByRole("button", { name: "Last 14 days", exact: true }).click();
    await expect(page.locator("#reportDeskDates")).toContainText(/Sep 18.*Oct 1/);
    await expect(page).toHaveURL(new URL("/reports", runtime.url).href);
    await visit("compare", "/compare");
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await openDatePicker(page, "compare", "Last 14 days");
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(page.locator(".comparison-timeline")).toBeVisible();
    await expect(page).toHaveURL(new URL("/compare", runtime.url).href);
    await visit("trends", "/trends");
    await openDatePicker(page, "trends", "Last 14 days");
    await expect(page.locator("#trendsPeriod")).toHaveAccessibleName(/Sep 18.*Oct 1/);
    await expect(page).toHaveURL(new URL("/trends", runtime.url).href);
    await page.getByRole("button", { name: "Charts", exact: true }).click();
    const chartUrl = new URL("/trends?section=charts", runtime.url).href;
    await expect(page).toHaveURL(chartUrl);
    const measure = page.getByRole("navigation", { name: "Trend measures" }).getByRole("button", { name: "Services", exact: true });
    await measure.click();
    await expect(measure).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(chartUrl);
    await page.goBack();
    await expect(page.locator(".trends-landing")).toBeVisible();
    await expect(page).toHaveURL(new URL("/trends", runtime.url).href);
    await visit("analyze", "/");
    await expect(page.locator("#periodResult")).toContainText("3 Work IQ tool calls");
});

for (const frontend of ["react", "bundled"]) test(`Analyze entry uses the saved date range without overriding an explicit view (${frontend})`, async t => {
    const records = searchRecords(4);
    const starts = ["2026-09-17T03:59:59Z", "2026-09-17T04:00:00Z", "2026-09-30T21:00:00Z", "2026-10-01T04:00:00Z"];
    for (const [i, row] of records.entries()) row.toolCalls[0].startedAt = row.capturedAt = starts[i];
    records[1].toolCalls[0].tool = "workiq-ask";
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const { runtime } = await searchFixture(t, { frontend, reply: false, records });
    const profile = await browser.newContext({ timezoneId: "America/New_York" });
    const page = await profile.newPage();
    await page.clock.setFixedTime(new Date("2026-10-01T02:00:00Z"));
    const refused = [];
    await page.route(/\/api\/(?:collection\/|recollection\/|import$|refresh$|app-update$)/, async route => {
        if (await fulfillFixtureUpdateStatus(route, new URL(runtime.url).origin)) return;
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/collection/status") return route.continue();
        refused.push(path);
        await route.abort();
    });
    const viewAnalyze = page.getByRole("link", { name: "View Analyze", exact: true });
    const rows = page.locator("#activityList article[data-view-key]");
    async function expectScope(range, dates, ids) {
        await expect(page.locator("#dateFilter")).toHaveValue(range);
        await expect(page.locator("#periodResult")).toHaveText(`${ids.length} Work IQ tool call${ids.length === 1 ? "" : "s"} (${dates})`);
        await expect.poll(() => rows.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey).sort()))
            .toEqual(ids.map(id => `request:search-${id}`));
        await expect(page).toHaveURL(runtime.url);
        const hrefs = await page.locator("a[href]").evaluateAll(links => links.map(link => link.getAttribute("href")).join("\n"));
        assert.doesNotMatch(hrefs, /[?&](?:range|from|to|tool|result|authors|aFrom|aTo|bFrom|bTo|period|layer)=/);
    }
    await page.goto(runtime.url);
    await expectScope("capture", "All dates", [0, 1, 2, 3]);
    await navigateMain(page, "settings");
    await navigateSettings(page, "analyze");
    await expect(page.locator("#defaultAnalyzeRange option")).toHaveText(["All dates", "Last 7 days", "Last 14 days", "Last 30 days"]);
    await selectActivityOption(page, "defaultAnalyzeRange", "7");
    await expect(viewAnalyze).toHaveAttribute("href", "/");
    await viewAnalyze.click();
    await expectScope("7", "Sep 24–30, 2026", [2]);
    await page.goBack();
    await page.reload();
    await expect(page.locator("#defaultAnalyzeRange-control")).toContainText("Last 7 days");
    await navigateMain(page, "analyze");
    await expectScope("7", "Sep 24–30, 2026", [2]);
    await page.goto(runtime.url);
    await expectScope("7", "Sep 24–30, 2026", [2]);

    await selectActivityOption(page, "dateFilter", "14");
    await expectScope("14", "Sep 17–30, 2026", [1, 2]);
    await selectActivityOption(page, "dateFilter", "custom");
    await expect(page.locator("#fromFilter")).toHaveValue("2026-09-17");
    await expect(page.locator("#toFilter")).toHaveValue("2026-09-30");
    await page.locator("#analyzeDates").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#dateFilter-control")).toHaveAccessibleName("Dates: Sep 17–30, 2026");
    await page.reload();
    await expectScope("14", "Sep 17–30, 2026", [1, 2]);

    await selectActivityOption(page, "toolFilter", "workiq-ask");
    await expectScope("14", "Sep 17–30, 2026", [1]);
    const explicit = page.url();
    await navigateMain(page, "settings");
    await navigateSettings(page, "analyze");
    await selectActivityOption(page, "defaultAnalyzeRange", "30");
    await viewAnalyze.click();
    await expectScope("14", "Sep 17–30, 2026", [1]);
    await expect(page).toHaveURL(explicit);
    const length = await page.evaluate(() => history.length);
    await selectActivityOption(page, "dateFilter", "7");
    await expectScope("7", "Sep 24–30, 2026", []);
    assert.equal(await page.evaluate(() => history.length), length);
    await page.goBack();
    await expect(viewAnalyze).toBeVisible();
    await page.goForward();
    await expectScope("7", "Sep 24–30, 2026", []);
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-16");
    await page.locator("#toFilter").fill("2026-09-17");
    await page.locator("#applyDates").click();
    await expectScope("custom", "Sep 16–17, 2026", [1]);
    await closeAnalyzeFilters(page);
    const reader = rows.getByRole("link", { name: /open call/ });
    await reader.click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await expect(page).toHaveURL(url => url.pathname === "/request" && !url.searchParams.has("from") && !url.searchParams.has("tool"));
    await page.goBack(); await expect(reader).toBeFocused();
    await expectScope("custom", "Sep 16–17, 2026", [1]);
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(history.state)), /workiq-ask|2026-09-16/);
    await page.reload();
    await page.getByRole("button", { name: "Open this view without the private selection" }).click();
    await expectScope("capture", "All dates", [0, 1, 2, 3]);
    await page.goto(new URL("/?range=custom&from=2026-10-01&to=2026-10-01", runtime.url).href);
    await expectScope("custom", "Oct 1, 2026", [3]);
    const fresh = await page.context().newPage();
    await fresh.clock.setFixedTime(new Date("2026-10-01T02:00:00Z"));
    await fresh.goto(page.url());
    await expect(fresh).toHaveURL(runtime.url);
    await expect(fresh.locator("#dateFilter")).toHaveValue("30");
    await expect.poll(() => fresh.locator("#activityList article").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey).sort()))
        .toEqual(["request:search-0", "request:search-1", "request:search-2"]);
    await fresh.close();
    assert.deepEqual(refused, []);
});
