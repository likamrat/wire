import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, openAnalyzeFilters,
    closeAnalyzeFilters, restoreLegacySearch, navigateMain } from "./helpers.mjs";

const recordsFor = days => days.flatMap(([day, count]) => Array.from({ length: count }, (_, index) => {
    const record = fixture(`synthetic-${day}-${index}`), date = `2026-09-${day}T12:00:00Z`;
    record.sourceSessionId = "synthetic-session";
    record.userPrompt.text = `Synthetic chart request ${day} ${index}`;
    record.capturedAt = record.userPrompt.sourceTimestamp = record.toolCalls[0].startedAt = date;
    record.toolCalls[0].toolSucceeded = index % 6 !== 0;
    record.toolCalls[0].reportedOutcome = index % 6 === 0 ? "failed" : "succeeded";
    return record;
}));
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function setup(t, days, address = "/") {
    let remove;
    const { context } = await privateFixture({ after: fn => { remove = fn; } }, recordsFor(days));
    const before = await loadBoardState(context), requests = [], errors = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(await loadBoardState(context), before);
        } finally { await remove(); }
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 960 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", request => {
        if (request.method() === "POST") requests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) { errors.push("Unexpected external request"); return route.abort(); }
        return route.continue();
    });
    await page.goto(new URL(address, runtime.url).href); await ready(page);
    return { page, requests, url: runtime.url, snapshot: () => requests.filter(r => r.path === "/api/snapshot").at(-1).body };
}
async function reset(page) {
    await openAnalyzeFilters(page);
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await ready(page); await closeAnalyzeFilters(page);
}

test("weekly column and outcome segment reach different exact populations and Back returns to the mark", async t => {
    const { page } = await setup(t, [["14",17]], "/?bucket=week");
    const col = page.locator(".time-column");
    await expect(col).toHaveAccessibleName(/17 Work IQ tool calls/);
    const plot = await page.locator(".time-chart").boundingBox(), stack = await col.boundingBox();
    assert.ok(stack.width <= 84);
    const address = page.url();
    await page.mouse.click(plot.x + 2, plot.y + 2);
    assert.equal(page.url(), address);
    const failed = page.locator("a.time-segment-link[data-segment=failure]");
    await failed.click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("3");
    const prompts = page.locator("#activityList .request-card-prompt");
    assert.deepEqual((await prompts.allTextContents()).sort(), [0,6,12].map(i => `Synthetic chart request 14 ${i}`).sort());
    assert.equal(new URL(page.url()).searchParams.has("from"), false);
    assert.equal(new URL(page.url()).searchParams.has("to"), false);
    await page.goBack(); await ready(page); await expect(failed).toBeFocused();
    await col.focus(); await col.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("17");
    assert.equal(new URL(page.url()).searchParams.has("result"), false);
});

test("inspecting a segment on a narrow screen does not steal keyboard focus", async t => {
    const { page } = await setup(t, [["14",17]]);
    await page.setViewportSize({ width:375,height:1000 });
    const success = page.locator("a.time-segment-link[data-segment=success]");
    await success.hover(); await page.mouse.wheel(0,1);
    await expect(page.getByRole("tooltip")).toContainText("14 tool completed");
    await expect(success).not.toBeFocused();
    await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toBeHidden();
});

test("Reset filters restores the time chart; grouping survives and a cancelled date draft does not enter history", async t => {
    const { page, snapshot } = await setup(t,[["14",17]],"/?chart=endpoint&bucket=month");
    await reset(page);
    const previous = page.url();
    assert.equal(snapshot().bucket,"month");
    assert.equal(new URL(page.url()).searchParams.has("chart"),false);
    await expect(page.locator("#activityCount")).toHaveText("17");
    await openAnalyzeFilters(page); await expect(page.locator('[data-chart=time]')).toHaveAttribute("aria-pressed","true");
    await selectActivityOption(page,"dateFilter","custom");
    await page.locator("#fromFilter").fill("2026-09-01");
    await page.locator("#analyzeDates").getByRole("button",{name:"Cancel",exact:true}).click();
    assert.equal(page.url(),previous); await expect(page.locator("#dateFilter-control")).toBeFocused();
});

for (const multiple of [false,true]) test(`${multiple ? "unequal columns and a gap" : "single column"} retain bounded paint, keyboard controls and exact zero meaning`, async t => {
    const { page } = await setup(t,multiple ? [["14",200],["15",1],["17",3]] : [["14",17]],"/?bucket=day");
    const counts = multiple ? [200,1,3] : [17];
    for (const [theme,width] of [["light",1200],["dark",375],["light",820]]) {
        await page.setViewportSize({width,height:960}); await chooseTheme(page,theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const columns = page.locator(".time-column");
        await expect(columns).toHaveCount(counts.length);
        const height = (await columns.first().boundingBox()).height;
        for (const [i,count] of counts.entries()) {
            const col = columns.nth(i), bounds = await col.boundingBox(), stack = await col.locator(".time-stack").boundingBox();
            assert.ok(Math.abs(bounds.height - height * count / counts[0]) < 0.1);
            assert.ok(Math.abs(stack.width - bounds.width) < 1 && bounds.width <= 84);
            await expect(col.locator(".dimensional-count")).toHaveText(`${count} ${count === 1 ? "call" : "calls"}`);
            assert.ok((await col.locator(".dimensional-count").boundingBox()).height >= 44);
        }
    }
    if (multiple) {
        const zero = page.locator(".time-zero");
        await expect(zero).toHaveAccessibleName(/0 Work IQ tool calls.*Not applicable.*Read date definition/);
        await zero.focus(); await zero.press("Enter"); await expect(page.locator("#meaning")).toBeVisible();
        await page.locator("#chartReferenceShowData").click();
        const rows = page.locator("#chartReferenceExact tbody tr");
        await expect(rows.locator("td:nth-child(2)")).toHaveText(["200","1","0","3"]);
        await expect(rows.nth(2).getByRole("link")).toHaveCount(0);
        const short = rows.nth(1).locator("td").first().getByRole("link");
        await short.focus(); await short.press("Enter"); await ready(page);
        await expect(page.locator("#activityList .request-card-prompt")).toHaveText("Synthetic chart request 15 0");
        await page.goBack(); await expect(short).toBeFocused();
    }
});

test("Reset clears applied filters and private Search without publishing the text or adding a history step", async t => {
    const { page, snapshot } = await setup(t,[["14",17],["17",3]],"/?bucket=month&scope=all&result=failure&range=custom&from=2026-09-14&to=2026-09-17");
    await chooseTheme(page,"dark");
    const query = "Synthetic chart request 14";
    await restoreLegacySearch(page,query);
    const before = page.url(), length = await page.evaluate(() => history.length); assert.ok(!decodeURI(before).includes(query));
    await reset(page);
    assert.deepEqual(snapshot().filters, { scope:"history", includeMetadata:false });
    assert.equal(snapshot().bucket,"month");
    await expect(page.locator("#activitySearch")).toHaveValue("");
    await expect(page.locator("#activityCount")).toHaveText("20");
    assert.equal(await page.evaluate(() => history.length), length);
    assert.equal(page.url(),before);
    assert.ok(!(await page.evaluate(() => JSON.stringify(history.state))).includes(query));
    await expect(page.locator("html")).toHaveAttribute("data-evidence-theme","dark");
});

test("Resetting Both collections returns to the saved collection in place", async t => {
    const { page,snapshot } = await setup(t,[["14",17]]);
    await selectActivityOption(page,"scopeFilter","all"); await ready(page);
    assert.equal(snapshot().filters.scope,"all"); const before = page.url();
    await reset(page); assert.equal(snapshot().filters.scope,"history");
    assert.equal(page.url(),before); await expect(page.locator("#scopeFilter")).toHaveValue("history");
});

test("empty evidence has no invented time column or active filter", async t => {
    const {page} = await setup(t,[]);
    await expect(page.locator(".time-column,.time-zero")).toHaveCount(0);
    await expect(page.locator("#activityListSummary")).toContainText("0 interactions");
    await openAnalyzeFilters(page);
    await expect(page.locator("#filterChips")).toBeEmpty();
    await expect(page.locator("#openAnalyzeFilters")).toHaveText("Filters");
    await expect(page.locator("#resetView")).toBeDisabled();
});

test("Back restores the filtered record page and its exact reader target; reset clears its page", async t => {
    const { page } = await setup(t, [["14",26]], "/?result=success");
    const pager = page.getByRole("navigation",{name:"Analyze result pages"});
    await pager.getByRole("button",{name:"Next",exact:true}).click();
    await expect(pager).toContainText("9-16 of 21 interactions");
    const pageRoute = page.url(), links = page.locator("#activityList .request-card-open");
    const prompts = await links.allTextContents(), first = links.first();
    await first.click(); await expect(page.locator("#contextSidebar")).toBeVisible();
    await page.goBack(); await expect(first).toBeFocused(); await expect(pager).toContainText("9-16");
    assert.equal(page.url(),pageRoute);
    await expect(pager).toContainText("9-16 of 21");
    await expect(links).toHaveText(prompts);
    await reset(page); await expect(pager).toContainText("1-8 of 26");
});

test("reset keeps an interaction selected for a report without publishing a late preview or saving files", async t => {
    const {page,requests} = await setup(t,[["14",17]],"/?result=failure");
    await page.clock.setFixedTime(new Date("2026-09-18T12:00:00Z"));
    await navigateMain(page,"reports");
    const chosen = page.getByRole("checkbox",{name:"Select request for report: Synthetic chart request 14 0",exact:true});
    const enter = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/preview",async route => {
        const response = await route.fetch(); assert.ok(response.ok()); enter.resolve(); await release.promise;
        await route.fulfill({response});
    },{times:1});
    try {
        await page.getByRole("button",{name:/^Activity source:/}).click();
        await page.getByRole("radio",{name:/^Selected interactions/}).check();
        await chosen.check();
        await page.keyboard.press("Escape");
        await page.locator("#prepareReportPreview").click(); await enter.promise;
        await page.goBack(); await navigateMain(page,"analyze"); await ready(page);
        await reset(page);
        const late = page.waitForResponse(r=>r.url().endsWith("/api/preview"));
        release.resolve(); await (await late).finished();
        await expect(page.locator("#reportPreviewDrawer")).toBeHidden();
        assert.equal(requests.filter(r=>r.path==="/api/export").length,0);
        await navigateMain(page,"reports");
        await page.getByRole("button",{name:/^Activity source:/}).click();
        await expect(chosen).toBeChecked();
        const previews = requests.filter(r=>r.path==="/api/preview");
        assert.equal(previews.length,1);
        assert.deepEqual(previews[0].body.selection.scenarioIds,["synthetic-14-0"]);
    } finally { release.resolve(); }
});

test("a pending slice cannot replace reset scope with stale results", async t => {
    const {page,snapshot} = await setup(t,[["14",17],["17",3]]);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/snapshot",async route => {
        const res = await route.fetch();
        if (route.request().postDataJSON().filters.from === "2026-09-14") { entered.resolve(); await release.promise; }
        await route.fulfill({response:res});
    });
    try {
        await page.locator("a.time-segment-link[data-segment=failure]").first().click(); await entered.promise;
        await reset(page);
        const late = page.waitForResponse(r => r.url().endsWith("/api/snapshot") && r.request().postDataJSON().filters.from === "2026-09-14");
        release.resolve(); await (await late).finished();
        await expect(page.locator("#activityCount")).toHaveText("20");
        assert.deepEqual(snapshot().filters,{scope:"history",includeMetadata:false});
        await expect(page.locator("#activityListSummary")).toHaveText("20 interactions · 20 matching tool calls");
    } finally { release.resolve(); }
});
