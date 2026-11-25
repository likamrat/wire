import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { usagePreview } from "./usage-preview-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
import { paintedWidgetInsets } from "./color-measurements.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proof = process.env.WIRE_WIDGET_INSET_PROOFS;
const widgets = [
    ["time", ".analyze-chart-main"], ["outcomes", ".analyze-outcome-summary"], ["usage", "#analyzeUsage"],
    ...["tools", "models", "authors", "services"].map(key => [key, `[data-percentage-card="${key}"]`]),
];
async function ready(page) {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}
async function setup(t, frontend, sparse = false) {
    const cleanup = [], errors = [];
    let context, before;
    t.after(async () => {
        try {
            assert.deepEqual(errors, []);
            if (before) {
                const after = await loadBoardState(context);
                for (const key of ["evidence", "cards", "exports"]) assert.deepEqual(after[key], before[key], key);
            }
        } finally { for (const close of cleanup.reverse()) await close(); }
    });
    const app = await usagePreview({ after: close => cleanup.push(close) }, frontend, { sparse });
    context = app.context; before = await loadBoardState(context);
    const browser = await chromium.launch(); cleanup.push(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce", timezoneId: "UTC", hasTouch: sparse });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.runtime.url);
    await ready(page);
    if (frontend === "react") await expect(page.locator("body")).toHaveClass(/wire-frontend-react/);
    else await expect(page.locator("body")).not.toHaveClass(/wire-frontend-react/);
    return page;
}
async function measure(page, entries, prefix, readings) {
    await ready(page);
    await page.mouse.move(0, 0);
    for (const [key, selector] of entries) {
        const card = page.locator(selector).first();
        await expect(card).toBeVisible();
        const name = `${prefix}-${key}`;
        if (proof) await mkdir(proof, { recursive: true });
        readings.push({ name, ...await paintedWidgetInsets(card, proof && path.join(proof, `${name}.png`)) });
    }
    if (proof) await writeFile(path.join(proof, `${prefix}.json`), JSON.stringify(readings, null, 2));
}
function balanced(readings) {
    for (const { name, top, bottom } of readings) {
        assert.ok(Math.abs(top - bottom) <= 4, `${name}: painted top ${top.toFixed(1)}px / bottom ${bottom.toFixed(1)}px`);
        assert.ok(top >= 28 && top <= 35, `${name}: shares the established ~32px peer inset (${top.toFixed(1)}px)`);
    }
}

for (const frontend of ["react", "bundled"]) test(`${frontend}: compiled Analyze widgets balance painted edges, not just CSS padding`, async t => {
    const page = await setup(t, frontend), readings = [], models = page.locator('[data-percentage-card="models"]');
    const content = await page.locator("#percentageCharts").innerText();
    for (const [width, theme] of [[1920, "dark"], [390, "light"]]) {
        await page.setViewportSize({ width, height: 1080 }); await chooseTheme(page, theme);
        await measure(page, widgets, `${frontend}-${width}-${theme}`, readings);
        await models.getByRole("button", { name: "Token share", exact: true }).click();
        await measure(page, [["token-share", '[data-percentage-card="models"]']], `${frontend}-${width}-${theme}`, readings);
        await models.getByRole("button", { name: "Interactions", exact: true }).click();
        assert.equal(await page.locator("#percentageCharts").innerText(), content);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const target = models.locator(".analyze-trend-link");
        assert.ok((await target.boundingBox()).height >= 44, "Header target remains accessible");
        await target.focus(); await expect(target).toBeFocused();
        await page.mouse.move(0, 0);
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0)); await ready(page);
            await page.screenshot({ path: path.join(proof, `${frontend}-${width}-context.png`), fullPage: true });
        }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await navigateMain(page, "settings"); await navigateSettings(page, "analyze");
    await page.locator('#analyzeLayout [data-section="models"] [data-step="-1"]').click();
    await page.getByRole("link", { name: "View Analyze", exact: true }).click();
    await expect(page.locator(".analyze-ordered-widgets")).toBeVisible();
    await measure(page, widgets, `${frontend}-custom-order`, readings);
    balanced(readings);
});

for (const frontend of ["react", "bundled"]) test(`${frontend}: short and unavailable model readings retain the same edge inset`, async t => {
    const page = await setup(t, frontend, true), readings = [], models = page.locator('[data-percentage-card="models"]');
    for (const width of [1920, 390]) {
        await page.setViewportSize({ width, height: 1080 });
        await models.getByRole("button", { name: "Token share", exact: true }).click();
        await expect(models.locator(".percentage-bar-track")).toHaveCount(0);
        await measure(page, [["single-token-model", '[data-percentage-card="models"]']], `${frontend}-${width}`, readings);
        await models.getByRole("button", { name: "Interactions", exact: true }).click();
        await measure(page, [["single-model", '[data-percentage-card="models"]']], `${frontend}-${width}`, readings);
    }
    const chat = await page.locator("#chatFilter option").evaluateAll(options => options.find(option => option.textContent.includes("Recent question"))?.value);
    assert.ok(chat, "The fixture contains an interaction with no recorded model");
    await selectActivityOption(page, "chatFilter", chat); await closeAnalyzeFilters(page);
    await expect(models.locator(".percentage-empty")).toBeVisible();
    await measure(page, [["unavailable-model", '[data-percentage-card="models"]']], `${frontend}-390`, readings);
    await models.getByRole("button", { name: "Token share", exact: true }).click();
    await measure(page, [["unavailable-token-model", '[data-percentage-card="models"]']], `${frontend}-390`, readings);
    balanced(readings);
});

test("Trends widgets keep their content-sized frames and balanced exterior paint", async t => {
    const page = await setup(t, "react"), readings = [];
    await page.setViewportSize({ width: 1440, height: 1080 });
    await navigateMain(page, "trends");
    await measure(page, [["overview", ".trends-landing"], ["compare-intro", ".trends-start"], ["explore", ".trends-explore"]], "trends", readings);
    await page.locator(".trends-start").first().getByRole("button", { name: "Compare measures", exact: true }).click();
    await measure(page, [["pair", ".trends-panel-pair"]], "trends", readings);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "View chart", exact: true }).click();
    await measure(page, [["chart", ".trends-panel:visible"]], "trends", readings);
    await page.setViewportSize({ width: 390, height: 1080 });
    await measure(page, [["chart-narrow", ".trends-panel:visible"]], "trends", readings);
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.getByRole("button", { name: "Show or hide charts", exact: true }).click();
    await page.getByRole("button", { name: "Open all charts", exact: true }).click();
    await measure(page, ["problems", "rhythm", "tools", "services", "models", "authors", "timing", "usage"]
        .map(key => [`all-${key}`, `.trends-panel[data-family="${key}"]`]), "trends", readings);
    balanced(readings);
});

for (const frontend of ["react", "bundled"]) test(`${frontend}: collapsed Trends rows center title ink with their controls`, async t => {
    const page = await setup(t, frontend), readings = [];
    await page.setViewportSize({ width: 1440, height: 1100 }); await chooseTheme(page, "light");
    await navigateMain(page, "trends");
    await page.getByRole("button", { name: "View chart", exact: true }).click();
    await page.getByRole("button", { name: "Show or hide charts", exact: true }).click();
    await page.getByRole("button", { name: "Open all charts", exact: true }).click();
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    const cards = page.locator(".trends-panel[data-collapsed=true]");
    await expect(cards).toHaveCount(8); await ready(page); await page.mouse.move(0, 0);
    if (proof) await mkdir(proof, { recursive: true });
    for (const card of await cards.all()) {
        const title = await paintedWidgetInsets(card, undefined, ".trends-title-group h2");
        const icon = await paintedWidgetInsets(card, undefined, ".trends-sizing>button:first-child svg");
        readings.push({ name: await card.getAttribute("data-family"), title, icon });
        for (const control of await card.locator(".trends-sizing>button").all()) {
            const box = await control.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44, "Collapsed controls keep their hit areas");
        }
    }
    if (proof) {
        await page.evaluate(() => scrollTo(0, 0)); await ready(page);
        await page.screenshot({ path: path.join(proof, `${frontend}-trends-collapsed.png`) });
        await writeFile(path.join(proof, `${frontend}-trends-collapsed.json`), JSON.stringify(readings, null, 2));
    }
    for (const { name, title, icon } of readings) {
        assert.ok(Math.abs(title.height - 82) <= 1, `${name}: retains the compact 80px interior plus border`);
        assert.ok(Math.abs(title.top - title.bottom) <= 4, `${name}: title ink centered (${title.top.toFixed(1)} / ${title.bottom.toFixed(1)}px)`);
        assert.ok(Math.abs((title.top - title.bottom) - (icon.top - icon.bottom)) <= 4, `${name}: title and control ink align`);
    }
    const first = page.locator('.trends-panel[data-family="problems"]');
    await first.getByRole("button", { name: "Expand Errors & failures", exact: true }).click();
    await expect(first.locator(".trends-plot")).toBeVisible();
    balanced([{ name: "expanded again", ...await paintedWidgetInsets(first) }]);
    await first.getByRole("button", { name: "Collapse Errors & failures", exact: true }).click();
    await expect(first.locator(".trends-plot")).toBeHidden();
    const again = await paintedWidgetInsets(first, undefined, ".trends-title-group h2");
    assert.ok(Math.abs(again.height - readings[0].title.height) <= 1, "Repeated collapse preserves the compact row height");
    assert.ok(Math.abs(again.top - again.bottom) <= 4, "Repeated collapse centers the title");
});
