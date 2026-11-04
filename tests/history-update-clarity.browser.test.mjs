import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { chooseTheme, navigateMain, navigateSettings, revealSavedDataRead } from "./helpers.mjs";

async function capture(page, name) {
    if (!process.env.WIRE_HISTORY_REMOVAL_PROOF_DIR) return;
    await mkdir(process.env.WIRE_HISTORY_REMOVAL_PROOF_DIR, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(process.env.WIRE_HISTORY_REMOVAL_PROOF_DIR, `${name}.png`) });
}

async function fixture(t) {
    const f = await recollectionFixture(t), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (/\/api\/(?:collection\/(?:now|configure|enabled)|recollection\/(?:preview|confirm))$/.test(request.url())) {
            writes.push(new URL(request.url()).pathname);
        }
    });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(f.runtime.url).origin
        ? route.continue() : route.abort("blockedbyclient"));
    f.closeClient(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.goto(f.runtime.url); await page.locator("#workspace[aria-busy=false]").waitFor();
    return { f, page, writes };
}

test("Analyze has no activity-update entry, owner, menu or leftover slot at any navigation size", async t => {
    const { page, writes } = await fixture(t);
    for (const id of ["activityUpdateToggle", "activityUpdateLabel", "analyzeUpdateEntry", "activityUpdateSlot",
        "analyzeUpdatesTitle", "periodFeedback", "freshRecollect", "freshScope"]) {
        await expect(page.locator("#" + id)).toHaveCount(0);
    }
    await expect(page.locator("#freshActivity")).not.toBeVisible();
    await expect(page.locator("#collectionNotice")).not.toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#pageAction").focus(); await page.keyboard.press("Tab");
        await expect(page.locator('nav [data-nav="settings"]')).toBeFocused();
        assert.deepEqual(await page.locator("#analyzeTools").evaluate(node => [...node.children].map(child => child.id || child.tagName)),
            ["H2", "analyzeReturnActions", "analyzeToolActions"]);
        await capture(page, `${theme}-sidebar`);
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
        await capture(page, `${theme}-collapsed`);
        await page.locator("#navigationCollapse").click();
        await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
    }
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonSetup")).toBeVisible();
    await expect(page.locator("#activityUpdateToggle,#activityUpdateSlot")).toHaveCount(0);
    await navigateMain(page, "analyze");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator("#navigationToggle")).toBeVisible();
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#navigationToggle").click();
        await page.locator("#pageAction").scrollIntoViewIfNeeded();
        await capture(page, `${theme}-390-200-navigation`);
        await page.locator("#pageAction").focus(); await page.keyboard.press("Tab");
        await expect(page.locator('nav [data-nav="settings"]')).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator("#navigationDrawer")).not.toBeVisible();
    }
    assert.deepEqual(writes, [], "Navigation and themes cannot start collection or recollection");
});

test("Settings has one Refresh while diagnostic saved reads and explicit reread remain separate", async t => {
    const { f, page, writes } = await fixture(t);
    const configPath = path.join(f.context.dataDir, "collector", "config.json"), config = await readFile(configPath);
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    await expect(page.locator("#checkActivity")).toHaveAccessibleName("Refresh");
    await expect(page.locator("#freshStoredRead")).toBeHidden();
    await (await revealSavedDataRead(page)).focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#freshStatus")).toHaveText("Stored activity refreshed.");
    await expect(page.locator("#freshStoredRead")).toBeFocused();
    assert.deepEqual(writes, []);
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    const at = `${f.firstDay}T14:00:00.000Z`;
    await appendFile(f.files[0], [
        { id: "removal-start", type: "tool.execution_start", timestamp: at, data: {
            toolCallId: "removal-added", toolName: "workiq-fetch", mcpServerName: "workiq", mcpToolName: "fetch",
            arguments: { entityUrls: ["/me/messages"] },
        } },
        { id: "removal-complete", type: "tool.execution_complete", timestamp: at, data: { toolCallId: "removal-added", success: true } },
    ].map(event => JSON.stringify(event) + "\n").join(""));
    await page.locator("#checkActivity").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#freshStatus")).toHaveText("1 new activity record.");
    await expect(page.locator("#checkActivity")).toBeFocused();
    assert.deepEqual(writes, ["/api/collection/now"]);
    assert.deepEqual(await readFile(configPath), config);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#freshActivity").scrollIntoViewIfNeeded();
        await capture(page, `${theme}-settings-actions`);
    }
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const bounds = [];
    for (const id of ["checkActivity"]) {
        const node = page.locator("#" + id);
        await node.scrollIntoViewIfNeeded();
        bounds.push(await node.evaluate(node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y + scrollY, right: r.right, bottom: r.bottom + scrollY, height: r.height };
        }));
    }
    assert.ok(bounds.every(box => box.height >= 44 && box.x >= 0 && box.right <= 391));
    await expect(page.locator("#freshStoredRead")).toBeHidden();
    await capture(page, "dark-390-200-settings-actions");
    await navigateSettings(page, "privacy");
    await page.locator("#recollectActivity").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#recollectDialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#recollectActivity")).toBeFocused();
    assert.deepEqual(writes, ["/api/collection/now"], "Opening selection does not confirm a reread");
});

test("a lost source receipt remains discoverable off-task and recovers by saved read without sidebar ownership", async t => {
    const { page, writes } = await fixture(t);
    await navigateMain(page, "settings"); await navigateSettings(page, "connection");
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { started = resolve; });
    await page.route("**/api/collection/now", async route => {
        await route.fetch(); started(); await gate; await route.abort("connectionreset");
    }, { times: 1 });
    try {
        await page.locator("#checkActivity").click(); await reached;
        await navigateMain(page, "analyze");
        await expect(page.locator("#freshAwayNotice")).toContainText("Checking approved history");
        await expect(page.locator("#freshActivity")).not.toBeVisible();
        await expect(page.locator("#activityUpdateToggle")).toHaveCount(0);
    } finally { release(); }
    await expect(page.locator("#freshAwayNotice")).toContainText("outcome is unknown");
    await page.locator("#freshAwayLink").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#refreshBtn")).toBeVisible();
    await page.locator("#refreshBtn").click();
    await expect(page.locator("#freshStatus")).toContainText("source check unconfirmed");
    assert.deepEqual(writes, ["/api/collection/now"]);
    await page.reload(); await page.locator("#workspace[aria-busy=false]").waitFor();
    await expect(page.locator("#freshStatus")).toContainText("unconfirmed");
    await expect(page.locator("#checkActivity")).not.toBeVisible();
    assert.deepEqual(writes, ["/api/collection/now"]);
});
