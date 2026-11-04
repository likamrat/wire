import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain, navigateSettings, selectActivityOption, chooseTheme, revealAnalyzeRecords } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { chooseReportScope, reportContents, scanReport } from "./report-journey-helpers.mjs";

async function setup(t, width = 1440) {
    const { context } = await privateFixture(t, [fixture("sidebar-destinations")]);
    const controller = createExportController(context);
    const state = await loadBoardState(context), timeContext = { timeZone: "UTC", locale: "en-US" };
    const preview = await controller.preview("sidebar-fixture", undefined, { title: "Saved navigation exercise",
        promptMode: "none", formats: ["html"], timeContext }, { kind: "all", revision: state.revision });
    await controller.review("sidebar-fixture", preview.previewId, true, timeContext);
    const { bundle } = await controller.confirm("sidebar-fixture", preview.previewId, true, timeContext);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST" && /\/(?:export|refresh|evaluate|save|privacy-review)$/.test(new URL(request.url()).pathname))
            mutations.push(request.url());
    });
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(mutations, []); });
    return { page, url: runtime.url, bundle };
}

async function ready(page) {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.waitForFunction(() => !document.querySelector("#sidebar").hasAttribute("data-navigation-moving"));
}

async function revealNavigation(page) {
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    if (await page.locator("#contextSidebar").evaluate(node => node.matches(":modal"))) {
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
    }
    if (await page.locator("#navigationToggle").isVisible()) {
        await page.locator("#navigationToggle").click();
        await expect(page.locator("#navigationDrawer")).toBeVisible();
        await page.waitForFunction(() => !document.querySelector("#navigationDrawer").getAnimations().length);
    }
}

test("every main interface retains all persistent sidebar destinations", { timeout: 30000 }, async t => {
    const { page, url, bundle } = await setup(t);
    const failures = [];
    for (const route of ["#analyze", "#analyze?compare=periods", "#request?request=sidebar-destinations", "#reports",
        "#reports?task=create", "#reports?task=compare", `#reports?bundle=${bundle.bundleId}`, "#settings", "#collection-status"]) {
        await page.goto(url + route); await ready(page);
        for (const id of ["comparePeriods", "pageAction"]) {
            const target = page.locator("#analyzeTools #" + id);
            if (!await target.isVisible()) failures.push(`${route}: ${id} is absent from sidebar`);
        }
        if (process.env.WIRE_SIDEBAR_DESTINATION_PROOFS) {
            await mkdir(process.env.WIRE_SIDEBAR_DESTINATION_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_SIDEBAR_DESTINATION_PROOFS,
                route.slice(1).replaceAll("?", "-").replaceAll("=", "-") + ".png"), fullPage: true });
        }
    }
    assert.deepEqual(failures, []);
});

for (const mode of ["expanded", "collapsed", "drawer"]) test(`sidebar destinations operate from every interface (${mode})`, { timeout: 90000 }, async t => {
    const { page, url, bundle } = await setup(t, mode === "drawer" ? 390 : 1440);
    await page.goto(url + "#reports"); await ready(page);
    if (mode === "collapsed") {
        await page.locator("#navigationCollapse").click(); await ready(page);
    }
    await chooseTheme(page, mode === "expanded" ? "light" : "dark");
    const nodes = await page.evaluateHandle(() => ["comparePeriods", "pageAction"].map(id => document.getElementById(id)));
    for (const origin of ["#analyze", "#analyze?compare=periods", "#request?request=sidebar-destinations", "#reports", "#reports?task=create", "#reports?task=compare",
        `#reports?bundle=${bundle.bundleId}`, "#settings?section=connection", "#collection-status"]) {
        for (const [id, label] of [["comparePeriods", "Compare periods"], ["pageAction", "Create report"],
            ["analyze", "Analyze"], ["reports", "Reports"], ["settings", "Settings"]]) {
            await page.evaluate(hash => { location.hash = hash; }, origin);
            await expect.poll(() => new URL(page.url()).hash).toBe(origin);
            await ready(page);
            await revealNavigation(page);
            const target = page.locator(["analyze", "reports", "settings"].includes(id) ? `nav [data-nav="${id}"]` : "#analyzeTools #" + id);
            await expect(target).toBeVisible();
            await expect(target).toHaveAccessibleName(label);
            await expect(target).not.toHaveAttribute("aria-disabled", "true");
            await target.focus(); await page.keyboard.press("Enter"); await ready(page);
            if (mode === "drawer") await expect(page.locator("#navigationDrawer")).not.toBeVisible();
            if (id === "comparePeriods") {
                const toggledOff = origin === "#analyze?compare=periods";
                await expect(page.locator("#periodComparisonSetup")).toBeVisible({ visible: !toggledOff });
                if (!toggledOff) await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
            } else if (id === "pageAction") {
                await expect(page.locator("#reportCreatePanel")).toBeVisible();
                await expect(page.locator("#pageTitle")).toHaveText("Create a report");
            } else if (id === "analyze") {
                await expect(page.locator("#activityView")).toBeVisible();
            } else if (id === "reports") {
                await expect(page.locator("#savedReportsPanel")).toBeVisible();
            } else {
                await expect(page.locator("#settingsView")).toBeVisible();
            }
            assert.equal(await nodes.evaluate(nodes => nodes.every(node => node === document.getElementById(node.id)
                && node.closest("#analyzeTools"))), true, `${origin} -> ${id}: same persistent nodes and owners`);
        }
    }
    await nodes.dispose();
});

for (const width of [1840, 390]) test(`review, saved inspection and scoped reader keep working sidebar destinations (${width}px)`, { timeout: 45000 }, async t => {
    const { page, url } = await setup(t, width);
    await page.goto(url + "#reports"); await ready(page);
    await chooseReportScope(page, "all");
    const preview = await scanReport(page);
    await expect(page.locator("#reportReviewBody")).toBeVisible();
    await revealNavigation(page);
    await revealAnalyzeRecords(page); await ready(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await revealNavigation(page);
    await page.locator("#pageAction").click(); await ready(page);
    await expect(page.locator("#reportReviewBody")).toBeVisible();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    await expect(page.locator("#pageTitle")).toHaveText(preview.title);

    await navigateMain(page, "reports"); await ready(page);
    await page.locator(".saved-report-summary").first().click();
    await expect(page.locator("#contextSidebar .saved-report-inspection")).toBeVisible();
    await revealNavigation(page);
    await page.locator("#comparePeriods").click(); await ready(page);
    await expect(page.locator("#comparisonAPreset-control")).toBeFocused();
    await expect(page.locator(".saved-report-inspection")).not.toBeVisible();

    await page.evaluate(() => { location.hash = "#analyze?tool=workiq-fetch"; }); await ready(page);
    await page.locator(".request-card-open").first().click();
    await expect(page.locator("#requestView")).toBeVisible();
    await revealNavigation(page);
    await revealAnalyzeRecords(page); await ready(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("tool"), "workiq-fetch");
    await expect(page.locator("#requestView")).not.toBeVisible();
});

for (const theme of ["light", "dark"]) test(`all destinations fit enlarged narrow navigation (${theme})`, async t => {
    const { page, url } = await setup(t, 390);
    await page.goto(url + "#reports"); await ready(page);
    await chooseTheme(page, theme);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.setViewportSize({ width: 390, height: 600 });
    await revealNavigation(page);
    for (const selector of ['nav [data-nav="analyze"]', 'nav [data-nav="reports"]', "#comparePeriods", "#pageAction", 'nav [data-nav="settings"]']) {
        const target = page.locator(selector);
        await target.focus();
        await target.scrollIntoViewIfNeeded();
        const measured = await target.evaluate(node => {
            const box = node.getBoundingClientRect();
            return { x: box.x, right: box.right, top: box.top, bottom: box.bottom, height: box.height,
                visible: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
        });
        assert.ok(measured.height >= 44 && measured.x >= 0 && measured.right <= 390 && measured.top >= 0 && measured.bottom <= 600 && measured.visible,
            `${selector}: ${JSON.stringify(measured)}`);
    }
    if (process.env.WIRE_SIDEBAR_DESTINATION_PROOFS) {
        await page.locator('nav [data-nav="analyze"]').focus();
        await page.locator('nav [data-nav="analyze"]').scrollIntoViewIfNeeded();
        await expect(page.locator("#evidence-tooltip")).not.toBeVisible();
        await page.screenshot({ path: path.join(process.env.WIRE_SIDEBAR_DESTINATION_PROOFS, `drawer-${theme}-390-200.png`) });
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#navigationDrawer")).not.toBeVisible();
    await expect(page.locator("#navigationToggle")).toBeFocused();
});

for (const reducedMotion of ["reduce", "no-preference"]) test(`Analyze closes the reader using its existing transition (${reducedMotion})`, async t => {
    const { page, url } = await setup(t, 1840);
    await page.emulateMedia({ reducedMotion });
    await page.goto(url + "#analyze"); await ready(page);
    await page.locator(".request-card-open").first().click();
    await page.waitForFunction(() => document.querySelector("#contextSidebar").open
        && !document.querySelector("#contextSidebar").getAnimations().length);
    await page.locator('nav [data-nav="analyze"]').click();
    const animation = await page.locator("#contextSidebar").evaluateHandle(node => {
        const animation = node.getAnimations()[0];
        if (!animation) throw new Error("Reader exit must still be animated.");
        animation.pause();
        return animation;
    });
    await animation.evaluate(animation => animation.finish());
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#activityView")).toBeVisible();
    await expect(page.locator("#resultsLink")).toHaveCount(0);
    await animation.dispose();
});

for (const width of [1440, 390]) test(`persistent destinations retain report and Settings drafts (${width}px)`, { timeout: 30000 }, async t => {
    const { page, url } = await setup(t, width);
    await page.goto(url + "#reports"); await ready(page);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("#reportTitle").fill("Unfinished navigation review");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    const selection = await page.locator("#previewSelectionSummary").textContent();
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "connection");
    await selectActivityOption(page, "collectionWindow", "7");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await revealNavigation(page); await page.locator("#comparePeriods").click(); await ready(page);
    await page.getByLabel("Period A from", { exact: true }).fill("2026-03-01");
    await revealNavigation(page); await page.locator("#pageAction").click(); await ready(page);
    await expect(page.locator("#previewSelectionSummary")).toHaveText(selection);
    await reportContents(page);
    await expect(page.locator("#reportTitle")).toHaveValue("Unfinished navigation review");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await navigateMain(page, "settings"); await ready(page);
    await navigateSettings(page, "connection");
    await expect(page.locator("#collectionWindow")).toHaveValue("7");
    await expect(page.locator("#saveCollection")).toBeDisabled();
    await revealNavigation(page); await revealAnalyzeRecords(page); await ready(page);
    await expect(page.locator("#activityListSummary")).toBeFocused();
    await expect(page.locator("#settingsDraftNotice")).toBeVisible();
});
