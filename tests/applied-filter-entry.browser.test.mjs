import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { frontendRecords } from "./frontend-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { chooseTheme, openAnalyzeFilters, closeAnalyzeFilters, selectActivityOption } from "./helpers.mjs";

const proof = process.env.WIRE_FILTER_ENTRY_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.mouse.move(2, 2);
    await page.screenshot({ path: path.join(proof, `${name}.png`) });
}
for (const [width, scale, theme] of [[1440, 1, "light"], [390, 2, "dark"]]) {
    test(`Analyze names only accepted filters at rest (${width}px, ${scale}×)`, async t => {
        const { runtime } = await searchFixture(t, { frontend: "react", records: frontendRecords(16), reply: false });
        const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "UTC" });
        await page.route(url => url.origin !== new URL(runtime.url).origin, route => route.abort());
        await page.goto(runtime.url); await ready(page);
        await chooseTheme(page, theme);
        await page.evaluate(async scale => {
            document.documentElement.style.fontSize = `${100 * scale}%`; await document.fonts.ready;
        }, scale);
        const trigger = page.locator("#openAnalyzeFilters");
        const targets = page.locator("#analyzeReferenceEntry button, #analyzeToolbar #analyzeRefresh, #analyzeToolbar #openAnalyzeFilters");
        const geometry = () => targets.evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(node => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { id: node.id, x: Math.round(x), y: Math.round(y + scrollY), width: Math.round(width), height: Math.round(height) };
        }));
        await expect(trigger).toHaveText("Filters", { useInnerText: true });
        const defaultBoxes = await geometry();
        assert.deepEqual(defaultBoxes.map(box => box.id), ["analyzeResultsSection", "openChartReference", "analyzeRefresh", "openAnalyzeFilters"]);
        await selectActivityOption(page, "toolFilter", "workiq-fetch"); await ready(page);
        await closeAnalyzeFilters(page); await capture(page, `analyze-${theme}-one`);
        await expect(trigger).toHaveText("1 filter applied");
        await expect(trigger).toHaveAccessibleName(/1 filter applied/);
        assert.deepEqual(await geometry(), defaultBoxes);
        await trigger.press("Enter"); await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await page.locator("#promptAuthorFilter-control").click();
        await page.locator('.select-popup .select-option[data-value="agent"]').click();
        await expect(trigger).toHaveText("1 filter applied");
        await page.keyboard.press("Escape");
        await selectActivityOption(page, "promptAuthorFilter", ["user"]); await ready(page);
        await closeAnalyzeFilters(page);
        await expect(trigger).toHaveText("2 filters applied");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        assert.deepEqual(await geometry(), defaultBoxes);
        // A nested reader and Back return to the same accepted membership.
        await page.locator("#activityList .request-card-open").first().click();
        await page.goBack(); await ready(page);
        await expect(trigger).toHaveText("2 filters applied");
        await openAnalyzeFilters(page); await page.locator("#resetView").click(); await ready(page);
        await closeAnalyzeFilters(page); await expect(trigger).toHaveText("Filters");
        assert.deepEqual(await geometry(), defaultBoxes);
        await page.goto(runtime.url + "analyze?bucket=week"); await ready(page);
        await expect(page.locator("#chartTitle")).toContainText("by week");
        await expect(trigger).toHaveText("Filters");
    });
}

test("Compare distinguishes grouping from accepted population, including an author-only quick choice", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", records: frontendRecords(16), reply: false });
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "UTC" });
    await page.route(url => url.origin !== new URL(runtime.url).origin, route => route.abort());
    await page.goto(runtime.url + "compare?aFrom=2026-11-10&aTo=2026-11-12&bFrom=2026-11-13&bTo=2026-11-16");
    const entry = page.locator("#openAnalyzeFilters"), pair = page.locator("#periodComparisonStatus");
    await expect(pair).toHaveText("Comparison ready.");
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await openAnalyzeFilters(page); await selectActivityOption(page, "comparisonBucket", "week"); await closeAnalyzeFilters(page);
    await expect(page.getByRole("heading", { name: "Activity by week" })).toBeVisible();
    await expect(entry).toHaveText("Filters");
    await selectActivityOption(page, "comparisonQuickChoice", "mine");
    await expect(entry).toHaveText("1 filter applied");
    await capture(page, "compare-author");
    await selectActivityOption(page, "comparisonQuickChoice", "all");
    await expect(pair).toHaveText("Comparison ready."); await expect(entry).toHaveText("Filters");
});

test("Analyze does not promote a requested second restriction on a held or failed read", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", records: frontendRecords(16), reply: false });
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route(url => url.origin !== new URL(runtime.url).origin, route => route.abort());
    await page.goto(runtime.url); await ready(page);
    const entry = page.locator("#openAnalyzeFilters");
    await selectActivityOption(page, "toolFilter", "workiq-fetch"); await ready(page);
    await expect(entry).toHaveText("1 filter applied");
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route("**/api/snapshot", async route => {
        await held;
        await route.fulfill({ status: 503, json: { error: "Invented read failure." } });
    }, { times: 1 });
    try {
        await selectActivityOption(page, "promptAuthorFilter", ["user"]);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        await closeAnalyzeFilters(page);
        await expect(entry).toHaveText("1 filter applied");
    } finally { release(); }
    await ready(page);
    await expect(page.locator("#analyzeScopeError")).toContainText("Previous results");
    await expect(entry).toHaveText("1 filter applied");
    await expect(entry).toHaveAccessibleDescription(/Tool: workiq-fetch/);
    await expect(entry).not.toHaveAccessibleDescription(/Author:/);
});
