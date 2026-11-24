import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";

test("sidebar Help reads topics and returns to the exact workspace without changing settings", async t => {
    const { runtime } = await searchFixture(t, { frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const effects = [];
    page.on("request", r => { if (r.method() !== "GET" && /\/api\/(?:collection\/(?:now|configure|enabled)|preview|export)$/.test(r.url())) effects.push(r.url()); });
    for (const [origin, narrow] of [["/settings?section=reports", false], ["/?range=14", true]]) {
        await page.goto(new URL(origin, runtime.url).href);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const previous = page.url();
        if (narrow) {
            await page.locator("#themePreference").click();
            await page.setViewportSize({ width: 390, height: 900 });
            await page.evaluate(() => document.documentElement.style.fontSize = "200%");
            await page.locator("#navigationToggle").click();
        } else {
            await expect(page.locator("#settingsCategoryNav [data-category]").first()).toHaveText("General");
            await expect(page.locator("#settingsCategoryNav").getByRole("link", { name: "Help" })).toHaveCount(0);
        }
        const prefs = await page.evaluate(() => JSON.stringify(localStorage));
        await page.locator("#openEvidenceHelp").click();
        const nav = page.getByRole("navigation", { name: "Help topics" });
        await expect(page.getByRole("heading", { level: 1, name: "WIRE Help" })).toBeVisible();
        await expect(page.locator("#wireHelpView").getByRole("button", { name: /^Back to / })).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 2, name: "Prepare a report" })).toBeVisible();
        const topic = nav.getByRole("link", { name: "Understand activity counts" });
        await topic.focus(); await page.keyboard.press("Enter");
        await expect(topic).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { level: 2, name: "Understand activity counts" })).toBeVisible();
        await page.goBack(); await expect(nav.getByRole("link", { name: "Prepare a report" })).toHaveAttribute("aria-current", "page");
        await page.goForward(); await expect(topic).toHaveAttribute("aria-current", "page");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const proof = process.env.WIRE_HELP_PROOFS;
        if (proof) {
            await mkdir(proof, { recursive: true });
            await page.screenshot({ path: path.join(proof, narrow ? "help-narrow-enlarged.png" : "help-desktop.png"), fullPage: narrow });
        }
        await page.goBack();
        await expect(nav.getByRole("link", { name: "Prepare a report" })).toHaveAttribute("aria-current", "page");
        await page.goBack();
        await expect(page).toHaveURL(previous);
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), prefs);
    }
    await page.goto(new URL("/help", runtime.url).href);
    await expect(page.locator("#help-reports")).toBeVisible();
    await page.getByRole("link", { name: "When an update stops" }).click();
    await expect(page).toHaveURL(/\/help\?topic=updates$/);
    await page.reload();
    await expect(page.locator("#wireHelpView").getByText("Check restart status", { exact: true })).toBeVisible();
    await expect(page.locator("#wireHelpView").getByText(/^Back to /)).toHaveCount(0);
    await page.goto(new URL("/settings?section=troubleshooting&setting=activity-counts", runtime.url).href);
    await expect(page.locator("#help-counts")).toBeVisible();
    await expect(page).toHaveURL(/\/help\?topic=counts$/);
    assert.deepEqual(effects, []);
});
