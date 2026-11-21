import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { reviewRecords } from "./frontend-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { navigateMain, openAnalyzeFilters, privateFixture, selectActivityOption } from "./helpers.mjs";
import { prepareLandingReport } from "./report-journey-helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";

const painted = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");

// Exercise the real splitter while this particular surface is mounted. A viewport
// resize or navigating to a page after changing the width does not test this.
async function dragOn(page, name, marker, { limit, dismisses } = {}) {
    await expect(marker).toBeVisible();
    const address = page.url(), original = await marker.elementHandle();
    const divider = page.locator(".navigation-resize"), rail = page.locator("#sidebar");
    const box = await divider.boundingBox();
    assert.ok(box, name + ": desktop divider missing");
    const start = Math.round((await rail.boundingBox()).width);
    const max = limit ?? Number(await divider.getAttribute("aria-valuemax"));
    const min = Number(await divider.getAttribute("aria-valuemin"));
    const x = box.x + box.width / 2, y = box.y + Math.min(90, box.height / 2);
    await page.evaluate(() => {
        window.resizeSamples = [];
        let observing = true;
        const sample = () => {
            const width = node => node.getBoundingClientRect().width;
            window.resizeSamples.push({ rail: width(document.querySelector("#sidebar")),
                left: document.querySelector("#main").getBoundingClientRect().x, top: document.querySelector(".app-header").getBoundingClientRect().y,
                overflow: document.documentElement.scrollWidth - innerWidth, y: scrollY, focus: document.activeElement.id || document.activeElement.className });
        };
        const next = () => { if (observing) requestAnimationFrame(() => setTimeout(() => { if (observing) {sample(); next();} }, 0)); };
        sample(); next();
        window.stopResizeSamples = () => { observing = false; sample(); return window.resizeSamples; };
    });
    await page.mouse.move(x, y); await page.mouse.down();
    try {
        for (const size of [max, min, start]) {
            await page.mouse.move(x + size - start, y, { steps: 8 }); await painted(page);
            const actual = (await rail.boundingBox()).width;
            assert.ok(Math.abs(actual - size) <= 1, `${name}: drag to ${size} painted ${actual}`);
        }
    } finally { await page.mouse.up(); }
    await painted(page);
    const rows = await page.evaluate(() => window.stopResizeSamples());
    const overflow = Math.max(...rows.map(r => r.overflow));
    const firstBadEdge = rows.find(r => Math.abs(r.left - r.rail) > 1);
    assert.ok(new Set(rows.map(r => Math.round(r.rail))).size >= 3, name + ": no intermediate widths");
    assert.ok(overflow <= 1, `${name}: page overflow ${overflow}px`);
    assert.ok(!firstBadEdge, `${name}: main detached from rail ${JSON.stringify(firstBadEdge)}`);
    assert.ok(rows.every(r => r.top === 0), name + ": sticky shell moved");
    assert.equal(page.url(), address, name + ": location changed");
    if (dismisses) await expect(marker).toBeHidden();
    else {
        await expect(marker).toBeVisible();
        assert.ok(await original.evaluate(n => n.isConnected), name + ": resized surface remounted");
    }
    console.log(`resized ${page.viewportSize().width} ${name} (${min}-${max}px)`);
}

async function blockedByModal(page, dialog) {
    await expect(dialog).toBeVisible();
    assert.ok(await dialog.evaluate(node => node.matches(":modal")));
    const width = await page.locator("#sidebar").evaluate(node => node.offsetWidth);
    const box = await page.locator(".navigation-resize").boundingBox();
    const x = box.x + box.width / 2, y = box.y + 50;
    assert.equal(await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.matches(".navigation-resize"), [x,y]), false);
    await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+80,y,{steps:4}); await page.mouse.up();
    assert.equal(await page.locator("#sidebar").evaluate(node => node.offsetWidth), width);
    if (await dialog.isVisible()) await page.keyboard.press("Escape");
}

test("the desktop sidebar resizes at each built WIRE destination", { timeout: 360000 }, async t => {
    const rows = reviewRecords().slice(0, 24);
    rows.forEach((r,i) => {
        const at = new Date(Date.now() - i * 43200000).toISOString();
        r.capturedAt = r.userPrompt.sourceTimestamp = r.toolCalls[0].startedAt = r.toolCalls[0].completedAt = at;
    });
    const { runtime, context, exports, bundles } = await searchFixture(t, { frontend: "react", records: rows, reply: false });
    for (const [title, format] of [["Cedar workshop", "html"], ["Cedar follow-up", "json"]]) {
        const preview = await exports.preview("resize-test", undefined, { title, promptMode: "none", formats: [format] },
            {kind: "all", revision: (await loadBoardState(context)).revision});
        await exports.review("resize-test", preview.previewId, true);
        bundles.push((await exports.confirm("resize-test", preview.previewId, true)).bundle);
    }
    const before = await loadBoardState(context);
    const browser = await chromium.launch({ channel:process.platform === "win32" ? "msedge" : undefined, ignoreDefaultArgs:["--hide-scrollbars"] });
    t.after(() => browser.close());
    for (const width of [1440, 760]) for (const group of ["Analyze", "Trends", "Reports", "Compare", "Settings"]) await t.test(`${group} at ${width}px`, async t => {
        const page = await browser.newPage({ viewport:{width,height:900}, timezoneId:"UTC" });
        page.setDefaultTimeout(6500);
        const errors = [];
        page.on("pageerror", e => errors.push(e.message));
        await page.route(url => url.origin !== new URL(runtime.url).origin, route => { errors.push("External navigation");return route.abort(); });
        t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
        const seen = id => page.locator(id).first();
        const drag = (name, selector, options) => dragOn(page, name, seen(selector), options);
        const go = async route => { await page.goto(new URL(route, runtime.url).href); await ready(page); await page.evaluate(() => document.fonts.ready); };
        await go(group === "Analyze" ? "/" : "/" + group.toLowerCase());
        if (group === "Analyze") {
            await drag("Analyze charts and activity", "#activityList .activity-card");
            await page.locator("#wireSearch").fill("Cedar");
            await expect(page.locator(".wire-search-hit").first()).toBeVisible();
            await drag("global Search", "#wireSearchPanel", { dismisses:true });
            assert.equal(await page.locator("#wireSearch").inputValue(), "Cedar");
            await page.locator("#wireSearchClear").click(); await page.keyboard.press("Escape");
            await openAnalyzeFilters(page); await blockedByModal(page, seen("#analyzeFilterDialog"));
            await expect(page.locator("#analyzeFilterDialog")).toBeHidden();
            await page.locator("#openChartReference").click(); await blockedByModal(page, seen("#meaning"));
            await page.locator("#activityList .card-panel-link").first().click();
            const reader = seen("#contextSidebar"); await expect(reader).toBeVisible();
            if (await reader.evaluate(n => n.matches(":modal"))) await blockedByModal(page, reader);
            else {
                await drag("docked interaction reader", "#requestContent");
                await page.locator("#closeContextSidebar").click();
            }
            await page.locator("#wireFeedback").click(); await drag("feedback popover", "#wireFeedbackPanel", { dismisses:true });
        }
        if (group === "Trends") {
            await drag("Trends overview", ".trends-landing");
            await page.locator("#trends-section-charts").click();
            await drag("Trends charts", ".trends-panel:visible");
            await page.getByRole("button",{ name:"Arrange charts", exact:true }).first().click();
            await page.getByRole("button",{ name:"All charts", exact:true }).first().click();
            await drag("Trends all charts", '#trendsView[data-layout=all]');
            await page.locator(".trends-panel:visible .trends-sizing button:visible").first().click();
            await drag("Trends maximized chart", ".trends-panel[data-maximized=true]");
            await page.locator("#trends-section-guide").click();
            await drag("Trends chart guide", ".trends-guide");
        }
        if (group === "Reports") {
            await drag("Reports overview", "#reportGallery");
            await prepareLandingReport(page, "all");
            const name = page.getByRole("textbox", {name:"Report name",exact:true});
            await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/preview")), name.fill("Cedar draft stays here")]);
            await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Cedar draft stays here");
            await drag("prepared report", ".report-frame"); await expect(name).toHaveValue("Cedar draft stays here");
            await page.getByRole("button",{name:"Change what's included",exact:true}).click();
            await page.getByRole("button",{name:"Change activity selection",exact:true}).click();
            const picker = page.locator("#reportActivityOptions");
            await expect(picker).toBeVisible();
            // This top-layer picker can cover the rail edge; do not synthesize
            // a drag through it. Close it and verify the same draft is reachable.
            const handle = await page.locator(".navigation-resize").boundingBox();
            const behindPicker = await picker.evaluate((panel, {x, y}) => {
                const hit = document.elementFromPoint(x, y);
                return panel.contains(hit) || hit === panel;
            }, {x: handle.x + handle.width / 2, y: handle.y + 90});
            if (behindPicker) {
                await picker.getByRole("button",{name:"Close",exact:true}).click();
                await expect(name).toHaveValue("Cedar draft stays here");
            } else {
                await drag("report activity picker", "#reportActivityOptions", {dismisses:true});
            }
            await selectActivityOption(page, "preparedReportView", "text");
            await drag("prepared text review", "#reportStage3");
            await navigateMain(page,"reports"); await ready(page);
            await page.locator("#viewAllSavedReports").click(); await page.locator("#savedReportSearch").fill("Cedar");
            await drag("saved report library", "#savedReportSearch"); await expect(page.locator("#savedReportSearch")).toHaveValue("Cedar");
            await page.locator(".saved-library-row .saved-report-title").first().click();
            await drag("saved report reader", "#savedReportReader iframe");
        }
        if (group === "Compare") {
            await drag("Compare periods", "#periodComparisonSetup");
            for (const label of ["View calls","View numbers"]) {
                await page.getByRole("button",{name:label,exact:true}).click();
                const inspection = page.locator(".compare-inspection:visible").first(); await expect(inspection).toBeVisible();
                if(await inspection.evaluate(n=>!!n.closest("dialog:modal"))) await blockedByModal(page,page.locator("dialog:modal"));
                else {await dragOn(page,label,inspection);await page.getByRole("button",{name:"Back to comparison",exact:true}).click();}
            }
            await page.locator("#compareSectionSaved").click();
            for (const [i,label] of ["Baseline report","Selected report"].entries()) {
                await page.getByRole("combobox",{name:label,exact:true}).click();
                await page.locator(`.select-popup [data-value="${bundles[i].bundleId}"]`).click();
            }
            await drag("Compare saved report choices", "#comparisonWorkspace");
            await page.getByRole("button",{name:"Compare reports",exact:true}).click();
            const files = page.getByRole("tab",{name:/^Files \(/}); await expect(files).toBeVisible();
            await drag("saved-report comparison preview", "#comparisonWorkspace");
            await files.click(); await drag("comparison files", "#comparisonWorkspace"); await expect(files).toHaveAttribute("aria-selected","true");
        }
        if (group === "Settings") {
            for (const section of ["general","connection","source-access","themes","regional","privacy","troubleshooting"]) {
                await go("/settings?section="+section);
                await drag("Settings: "+section, `[data-settings-section="${section}"]`);
            }
            await go("/settings?section=source-access");
            await page.locator("#editSource").click(); await drag("source review draft", "#sourceEditor");
            await go("/settings?section=privacy");
            await page.locator("#deleteActivity").click(); await blockedByModal(page,seen("#deleteDialog"));
            await page.locator("#recollectActivity").click(); await blockedByModal(page,seen("#recollectDialog"));
            await go("/collection-status"); await drag("collection status and diagnostics","#collectionStatusView");
            await go("/settings"); await page.locator("#settingsSearch").fill("time");
            await drag("settings search results","#settingsSearch"); await expect(page.locator("#settingsSearch")).toHaveValue("time");
        }
    });
    assert.deepEqual(await loadBoardState(context), before);
});

test("onboarding, account access and the narrow drawer preserve their resize boundaries", async t => {
    const cleanups = [], { context, root } = await privateFixture({after: fn => cleanups.push(fn)}, []);
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = root;
    const access = await createCopilotRuntimeAccess(context);
    const runtime = await startServer(context, createExportController(context), { port:0, access, frontend:"react", collector:{timers:false} });
    const browser = await chromium.launch({channel: process.platform === "win32" ? "msedge" : undefined});
    t.after(async () => {
        await browser.close(); await runtime.close(); await access.close();
        if (previousHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previousHome;
        for (const fn of cleanups.reverse()) await fn();
    });
    const page = await browser.newPage({ viewport:{width:1280,height:800} });
    await page.route(url => url.origin !== new URL(runtime.url).origin, route => route.abort());
    await page.goto(runtime.url); await ready(page);
    await blockedByModal(page,page.locator("#firstConnectionWelcome"));
    await dragOn(page,"first connection",page.locator("#firstConnectionTitle"));
    const account = page.locator("#wireAccountTrigger"), menu = page.locator("#wireAccountMenu");
    await account.click(); await dragOn(page,"account menu",menu,{dismisses:true});
    await account.click(); await page.locator("#wireAccountGate").click();
    await expect(page.locator("#message")).toContainText("signed out");
    await dragOn(page,"signed-out access gate",page.locator("#accessShell"));
    await page.setViewportSize({width:390,height:800});
    await page.locator("#navigationToggle").click(); await expect(page.locator("#navigationDrawer")).toBeVisible();
    await expect(page.getByRole("separator",{name:"Navigation width"})).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(page.locator("#navigationToggle")).toBeFocused();
});
