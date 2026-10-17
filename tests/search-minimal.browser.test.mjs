import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture, searchRecords } from "./live-search-fixture.mjs";
import { chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";

test("compact Search keeps one stationary field and readable live rows without an empty deck", { timeout: 30000 }, async t => {
    const cleanup = [], app = await searchFixture({ after: fn => cleanup.push(fn) });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); for (const fn of cleanup) await fn(); assert.deepEqual(errors, []); });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const input = page.getByRole("searchbox", { name: "Search", exact: true });
    await input.focus();
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(page.locator(".app-header #wireSearch")).toHaveCount(1);
    await expect(page.locator("#wireSearchStatus")).toBeEmpty();
    const field = await input.evaluate(node => {
        const label = node.labels[0], box = node.getBoundingClientRect(), owner = node.parentElement.getBoundingClientRect();
        return { labelWidth: label.getBoundingClientRect().width, labelClip: getComputedStyle(label).clipPath,
            width: box.width, ownerWidth: owner.width, left: box.x, ownerLeft: owner.x };
    });
    assert.ok(field.labelWidth <= 1 && field.labelClip !== "none", "Accessible label does not occupy visible header space");
    assert.ok(Math.abs(field.width - field.ownerWidth) < 1 && Math.abs(field.left - field.ownerLeft) < 1);
    await input.fill("Failed calls");
    const view = page.locator("#wireSearchResults button").filter({ hasText: "Failed calls" });
    await expect(view).toBeVisible({ timeout: 15000 });
    await expect(view).toHaveAttribute("data-search-type", "view");
    await expect(view).not.toContainText("#analyze");
    await expect(view).not.toContainText("WIRE navigation");
    if (process.env.WIRE_MINIMAL_SEARCH_PROOFS) {
        await mkdir(process.env.WIRE_MINIMAL_SEARCH_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_MINIMAL_SEARCH_PROOFS, "minimal-search-reference-query.png") });
    }
    await input.fill("Theme");
    await expect(page.locator("#wireSearchResults button")).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#wireSearchOptions,#wireSearchFilterSummary")).toHaveCount(0);
    await expect(page.locator(".wire-search-filters .select-trigger")).toHaveCount(2);
    await expect(page.locator(".wire-search-filters")).toBeVisible();
    const surfaces = await page.locator("#wireSearchPanel").evaluate(node => {
        const style = getComputedStyle(node), hit = node.querySelector(".wire-search-hit"), row = getComputedStyle(hit, "::before");
        return { border: style.borderTopWidth, background: style.backgroundColor, radius: style.borderTopLeftRadius,
            rowContent: row.content };
    });
    assert.equal(surfaces.border, "1px"); assert.equal(surfaces.background, "rgb(255, 255, 255)");
    assert.equal(surfaces.radius, "16px");
    assert.equal(surfaces.rowContent, "none");
    const row = page.locator("#wireSearchResults button");
    await expect(row).toContainText("Theme");
    await expect(page.locator(".wire-search-group-label")).toHaveText("Settings");
    await expect(row).not.toContainText("Open setting");
    await expect(row).not.toContainText("#settings");
    await expect(page.locator("#wireSearchScopeNote")).toBeHidden();
    await expect(page.getByRole("button", { name: "Close search", exact: true })).toHaveCount(0);
    const group = await page.locator("#wireSearchMatches").evaluate(node => {
        const css = getComputedStyle(node);
        return { background: css.backgroundColor, border: css.borderTopWidth, shadow: css.boxShadow };
    });
    assert.equal(group.background, "rgba(0, 0, 0, 0)");
    assert.equal(group.border, "0px"); assert.equal(group.shadow, "none");
    const status = await page.locator("#wireSearchStatus").evaluate(node => getComputedStyle(node).clipPath);
    assert.notEqual(status, "none", "Routine counts are announced without adding a visible status paragraph");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const width of [1280, 375]) {
            await page.setViewportSize({ width, height: 950 });
            await page.evaluate(width => { document.documentElement.style.fontSize = width === 375 ? "200%" : ""; }, width);
            await input.focus();
            if (process.env.WIRE_MINIMAL_SEARCH_PROOFS) {
                await mkdir(process.env.WIRE_MINIMAL_SEARCH_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_MINIMAL_SEARCH_PROOFS, `minimal-search-${theme}-${width}.png`) });
            }
            await input.press("ArrowDown");
            await expect(row).toBeFocused();
            assert.ok(await row.evaluate(node => node.getBoundingClientRect().height >= 44));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (process.env.WIRE_MINIMAL_SEARCH_PROOFS) {
                await mkdir(process.env.WIRE_MINIMAL_SEARCH_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_MINIMAL_SEARCH_PROOFS, `minimal-search-focus-${theme}-${width}.png`) });
            }
        }
    }
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await selectActivityOption(page, "wireSearchType", "setting");
    await expect(page.locator('[data-select-id="wireSearchType"] .select-value')).toHaveText("Settings");
    await expect(row).toHaveCount(1);
    await input.focus(); await input.press("ArrowDown"); await expect(row).toBeFocused(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/setting=theme/);
    await page.goBack();
    await expect(input).toHaveValue("Theme");
    await expect(row).toBeFocused();
    await expect(page.locator("#wireSearchType")).toHaveValue("setting");
    await expect(page.locator(".wire-search-filters")).toBeVisible();
});

test("minimal row accessible names retain recorded outcomes and partial/unavailable text facts", { timeout: 15000 }, async t => {
    const results = createRecordedResults();
    const records = searchRecords();
    records[1].toolCalls[0].toolSucceeded = null;
    records[1].toolCalls[0].reportedOutcome = "partial";
    records[1].userPrompt = { ...records[1].userPrompt, text: "Partially saved workshop request.", status: "partial" };
    records[2].userPrompt = { ...records[2].userPrompt, text: null, status: "unavailable" };
    const cleanup = [], app = await searchFixture({ after: fn => cleanup.push(fn) }, {
        records, reply: false,
    });
    const browser = await chromium.launch(), page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); for (const fn of cleanup) await fn(); assert.deepEqual(errors, []); });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#wireSearchRelated")).toHaveCount(0);
    for (const [query, type, fact] of [
        ["403", "action", results.labels("http").failure],
        ["workiq-fetch", "action", results.labels("tool").partial],
        ["Partially saved workshop request", "interaction", "Only part of this text was saved."],
        ["Invented local conversation 2", "interaction", "Saved text is unavailable."],
    ]) {
        await page.locator("#wireSearch").fill(query);
        await selectActivityOption(page, "wireSearchType", type);
        const row = page.locator("#wireSearchResults button").filter({ hasText: fact }).first();
        await expect(row).toBeVisible();
        await expect(row).toHaveAccessibleName(new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 1000 });
        await row.focus(); await expect(row).toBeFocused();
        assert.equal(await row.locator(".wire-search-meta,.wire-search-limitation").evaluateAll((nodes, fact) =>
            nodes.reduce((count, node) => count + (node.textContent.includes(fact) ? 1 : 0), 0), fact), 1,
        "The correction must not duplicate visible factual text");
    }
});
