import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, navigateSettings, closeAnalyzeFilters, chooseTheme, fulfillFixtureUpdateStatus, selectActivityOption } from "./helpers.mjs";
import { palettes } from "../web/theme.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

// Two distinct prompts on Monday. The first uses fetch twice, including one
// Files + Mail call; the second uses retrieve. Wednesday has a returned error
// on a completed tool call; Tuesday has no calls.
function callsFixture() {
    return [["mon-a", 16, "user", [["fetch", ["messages", "drive/root"], 180, false], ["fetch", ["messages"], 0, true]]],
        ["mon-b", 16, "agent", [["retrieve", ["drive/root"], null, true]]],
        ["wed-c", 18, "unknown", [["fetch", ["calendarView"], 840, true]]]].map(([id, date, actor, specs]) => {
        const r = fixture(`chart-${id}`), stamp = `2026-11-${date}T12:15:00Z`, base = r.toolCalls[0];
        r.userPrompt = { text: `Review the invented harbor notes ${id}.`, status: "full", sourceTimestamp: stamp,
            sourceEventId: `prompt-${id}`, authorship: { actor, basis: actor === "unknown" ? "missing-source" : `source-${actor}` } };
        r.toolCalls = specs.map(([name, paths, durationMs, ok], i) => ({
            ...base, toolCallId: `${id}-${i}`, startEventId: `start-${id}-${i}`, completionEventId: durationMs === null ? null : `end-${id}-${i}`,
            tool: `workiq-${name}`, startedAt: new Date(Date.parse(stamp) + i * 60000).toISOString(), completedAt: durationMs === null ? null : new Date(Date.parse(stamp) + i * 60000 + durationMs).toISOString(),
            durationMs, requestArgs: { entityUrls: paths.map(p => `/me/${p}`) }, requestedApiPath: paths.length === 1 ? `/me/${paths[0]}` : null,
            toolSucceeded: ok, reportedOutcome: ok ? "succeeded" : "failed",
            apiResults: paths.map((p, index) => ({ index, path: `/me/${p}`, statusCode: id === "wed-c" ? 403 : 200 })),
        }));
        if (actor !== "unknown") r.originalModelEvidence = { version: 1, sourceSessionId: r.sourceSessionId,
            promptEventId: `prompt-${id}`, promptMessageId: `message-${id}`, partial: false, ambiguous: false,
            responses: (actor === "user" ? ["Alder", "Field notes extended reasoning model"] : ["Alder"]).map((model, i) => ({
                eventId: `reply-${id}-${i}`, apiCallId: `model-${id}-${i}`, at: stamp, turnId: `turn-${id}-${i}`, model, modelStatus: "recorded",
            })),
        };
        return r;
    });
}
async function setup(t, touch = false, { records = callsFixture(), now = "2026-11-18T19:00:00Z" } = {}) {
    let cleanup;
    const { context } = await privateFixture({ after(fn) { cleanup = fn; } }, records), original = await loadBoardState(context), errors = [], reads = [];
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react",
        collector: { timers: false }, evaluation: { evaluatorFactory() { throw Error("No evaluator in chart test"); }, readSource() { throw Error("No source in chart test"); } } });
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(async () => { try { await browser.close(); await server.close(); assert.deepEqual(errors, []); assert.deepEqual(await loadBoardState(context), original); } finally { await cleanup(); } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference", timezoneId: "UTC", hasTouch: touch });
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", async route => {
        if (await fulfillFixtureUpdateStatus(route, new URL(server.url).origin)) return;
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && ![
            "/api/session", "/api/access/watch", "/api/snapshot", "/api/collection/status", "/api/collection/sources/status",
            "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/trends", "/api/period-comparison", "/api/report-artifacts/list",
        ].includes(url.pathname)) { errors.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        if (url.pathname === "/api/trends") reads.push(request.postDataJSON()); return route.continue();
    });
    await page.clock.setFixedTime(new Date(now)); await page.goto(new URL("/trends?section=charts", server.url).href);
    const index = page.getByRole("navigation", { name: "Trend measures" });
    await expect(index.getByRole("button", { name: "Tool calls", exact: true })).toHaveAttribute("aria-current", "page");
    return { page, index, reads };
}
test("long option finders keep the current measure, filters and time zone until a deliberate choice", { timeout: 75_000 }, async t => {
    const tools = ["ask", "fetch", "fetch_blob", "retrieve", "get_schema", "call_function", "do_action", "search_paths", "create_entity", "update_entity", "delete_entity", "list_agents"];
    const records = Array.from({ length: 84 }, (_, i) => {
        const r = fixture(`picker-${i}`), day = 12 + i % 7, stamp = `2026-11-${day}T12:15:00Z`;
        r.project = `Harbor workspace ${1 + i % 22}`; r.projectId = `harbor-${1 + i % 22}`;
        r.sourceSessionId = `cedar-${1 + i % 64}`; r.sourceSessionName = `Cedar review ${1 + i % 64}`;
        r.userPrompt = { text: `Review the Cedar release notes, batch ${i + 1}.`, status: "full", sourceTimestamp: stamp,
            sourceEventId: `prompt-${i}`, authorship: { actor: "user", basis: "source-user" } };
        const apiPath = ["/me/messages", "/me/drive/root", "/me/calendarView"][i % 3];
        Object.assign(r.toolCalls[0], { tool: `workiq-${tools[i % tools.length]}`, startedAt: stamp, requestedApiPath: apiPath,
            requestArgs: { entityUrls: [apiPath] }, completedAt: new Date(Date.parse(stamp) + 800).toISOString(),
            durationMs: 800, completionEventId: `end-${i}`, toolSucceeded: i % 9 !== 0 });
        return r;
    });
    const { page } = await setup(t, true, { records });
    const proofDir = process.env.WIRE_PICKER_PROOFS;
    if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await page.context().tracing.start({ screenshots: true, snapshots: true });
    }
    const requests = [];
    page.on("request", req => { if (req.method() === "POST" && !req.url().endsWith("/api/access/watch")) requests.push(new URL(req.url()).pathname); });
    const popup = page.locator(".select-popup:visible");
    const option = label => popup.getByRole("option", { name: label, exact: true });
    const input = name => popup.getByRole("combobox", { name, exact: true });
    const trigger = id => page.locator(`#${id}-control`);
    const pressText = async (name, text) => {
        const edit = input(name); await edit.click(); await expect(edit).toBeFocused(); await page.keyboard.type(text);
        await expect(edit).toHaveValue(text);
    };
    await page.getByRole("navigation", { name: "Trends sections" }).getByRole("button", { name: "Overview" }).click();
    await page.locator(".trends-discover").getByRole("button", { name: "Compare measures", exact: true }).click();
    await trigger("trendsPairMeasure1").click(); await pressText("Find a measure", "errors share");
    await expect(popup.getByRole("option")).toHaveText(["Errors & failures · interaction share"]); await page.keyboard.press("Enter");
    await selectActivityOption(page, "trendsPairMeasure2", JSON.stringify(["tools", "workiq-fetch", "reach"]));
    const pair = page.locator(".trends-panel-pair"), title = await pair.locator("h2").innerText();
    const second = trigger("trendsPairMeasure2"), edit = input("Find a measure");
    await second.click(); await edit.click();
    // Sample actual painted frames, including the short zero-result interval, not just the final bounds.
    await page.evaluate(async () => {
        await document.fonts.ready;
        const popup = document.querySelector(".select-popup:popover-open"), trigger = document.querySelector("#trendsPairMeasure2-control");
        const field = popup.querySelector("input"), chart = document.querySelector(".trends-panel-pair .trends-plot svg");
        const bounds = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        const sample = () => {
            const r = popup.getBoundingClientRect();
            return [scrollX, scrollY, ...bounds(trigger), r.x, r.width, popup.dataset.side === "top" ? r.bottom : r.top, ...bounds(field), ...bounds(chart)];
        };
        const frames = [], sampleFrame = () => {
            frames.push({ t: performance.now(), q: field.value, geometry: sample(), open: popup.matches(":popover-open"),
                focused: field === document.activeElement, chart: chart.isConnected, opacity: getComputedStyle(popup).opacity });
            frame = requestAnimationFrame(sampleFrame);
        };
        let frame = requestAnimationFrame(sampleFrame);
        window.finishPickerFrames = () => { cancelAnimationFrame(frame); return frames; };
    });
    const before = requests.length;
    await edit.pressSequentially("ask reach", { delay: 24 });
    await expect(popup.getByRole("option")).toHaveText(["ask · interaction reach"]);
    await edit.pressSequentially("zzz", { delay: 22 }); await expect(popup.getByRole("status")).toHaveText("No matching choices.");
    await edit.press("ArrowDown"); await edit.press("Enter"); await expect(edit).not.toHaveAttribute("aria-activedescendant");
    await edit.press("Control+a"); await edit.press("Backspace"); await edit.pressSequentially("reach", { delay: 18 });
    await expect(popup.getByRole("option")).toHaveCount(12);
    const frames = await page.evaluate(() => window.finishPickerFrames());
    assert(frames.length > 5 && new Set(frames.map(f => f.q)).size > 3);
    assert(frames.every(f => f.open && f.focused && f.chart && f.opacity !== "0"));
    const drift = Math.max(...frames.flatMap(f => f.geometry.map((n, i) => Math.abs(n - frames[0].geometry[i]))));
    assert(drift <= 1, `Finder or chart drifted ${drift}px`);
    assert.equal(await pair.locator("h2").innerText(), title); assert.equal(requests.length, before);
    if (proofDir) {
        await writeFile(path.join(proofDir, "frames.json"), JSON.stringify({ drift, frames }));
        await page.screenshot({ path: path.join(proofDir, "trends-desktop.png") });
    }
    await edit.press("Escape"); await expect(second).toBeFocused(); await second.click(); await expect(edit).toHaveValue("");
    await pressText("Find a measure", "cordless"); await popup.getByRole("button", { name: "Clear option search" }).click();
    await expect(edit).toBeFocused(); await page.keyboard.type("ask"); await edit.press("ArrowDown"); await edit.press("Enter");
    await expect(page.locator("#trendsPairMeasure2")).toHaveValue(JSON.stringify(["tools","workiq-ask","reach"]));
    await chooseTheme(page, "dark"); await page.setViewportSize({ width: 390, height: 760 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "135%"; });
    await second.tap(); await expect(edit).not.toBeFocused(); await edit.tap(); await expect(edit).toBeFocused();
    // A smaller visual area exercises keyboard-like constraints; this is not a native OS keyboard test.
    await page.setViewportSize({ width: 390, height: 500 }); await page.keyboard.type("retrieve reach");
    const rect = await popup.boundingBox(); assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 500);
    assert(rect.x + rect.width <= await page.evaluate(() => document.body.getBoundingClientRect().right), "The popup must stay inside the reserved scrollbar gutter");
    if (proofDir) await page.screenshot({ path: path.join(proofDir, "trends-narrow.png") });
    await option("retrieve · interaction reach").tap(); await expect(page.locator("#trendsPairMeasure2")).toHaveValue(JSON.stringify(["tools","workiq-retrieve","reach"]));
    await page.evaluate(() => document.documentElement.style.removeProperty("font-size")); await page.setViewportSize({ width: 1280, height: 800 });
    await navigateMain(page, "analyze");
    await page.locator("#analyzeResultCommands").getByRole("button", { name: /^Filters/ }).click();
    const filters = page.locator("#analyzeFilterDialog[open]:not(:modal)");
    await expect(filters.getByRole("combobox", { name: "Tool", exact: true })).toBeVisible();
    if (!await trigger("projectFilter").isVisible()) await filters.getByText("More filters", { exact: true }).click();
    for (const [id, name, query, expected] of [
        ["toolFilter", "Find a tool", "blob", "workiq-fetch_blob"], ["projectFilter", "Find a project", "workspace 18", "Harbor workspace 18"],
        ["chatFilter", "Find a chat", "42", "Cedar review 42"],
    ]) {
        await trigger(id).click(); await pressText(name, query); await expect(popup.getByRole("option")).toHaveText([expected]);
        await expect(page.locator(`#${id}`)).toHaveValue("all"); await page.keyboard.press("Escape"); await expect(trigger(id)).toBeFocused();
    }
    await trigger("projectFilter").click(); await pressText("Find a project", "18"); await option("Harbor workspace 18").click();
    await expect(page.locator("#projectFilter")).toHaveValue("harbor-18"); await closeAnalyzeFilters(page);
    const members = records.filter(record => record.projectId === "harbor-18");
    const cards = page.locator("#activityView .request-card-prompt");
    await expect(cards).toHaveCount(members.length);
    for (const record of members) await expect(cards.filter({ hasText: record.userPrompt.text })).toHaveCount(1);
    await navigateMain(page, "settings"); await navigateSettings(page, "regional"); await trigger("displayTimeZone").click();
    await pressText("Find a city or time zone", "York"); await expect(popup.getByRole("option")).toHaveText(["New York time (America/New_York)"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), null);
    await page.keyboard.press("Escape"); await trigger("displayTimeZone").click(); await pressText("Find a city or time zone", "York");
    await page.keyboard.press("Enter"); await expect(page.locator("#displayTimeZone")).toHaveValue("America/New_York");
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.time-zone")), "America/New_York");
    if (proofDir) await page.context().tracing.stop({ path: path.join(proofDir, "picker-journeys.zip") });
});
test("custom pairs keep units, members, collapse and day through the real period comparison and Back", async t => {
    const {page,reads}=await setup(t),nav=page.getByRole("navigation",{name:"Trends sections"});
    await nav.getByRole("button",{name:"Overview"}).click();
    const cta=page.locator(".trends-discover").getByRole("button",{name:"Compare measures",exact:true});
    await expect(cta).toBeVisible();await cta.click();
    const pair=page.locator(".trends-panel-pair"), first=pair.locator("select#trendsPairMeasure1"), second=pair.locator("select#trendsPairMeasure2");
    await expect(first).toHaveValue("");await expect(second).toBeDisabled();
    const select = async (locator,values) => selectActivityOption(page,await locator.getAttribute("id"),JSON.stringify(values));
    await select(first,["problems","problems","share"]);await select(second,["tools","workiq-fetch","reach"]);
    const graph=pair.locator(".trends-plot:visible");
    await expect(graph).toHaveCount(1);
    const mark=graph.getByRole("button",{name:/Nov 16.*fetch.*50%/});
    await mark.focus();await mark.press("Enter");
    const reading=pair.locator(".trend-pair-readings");
    await expect(reading).toContainText("50% · 1 of 2 interactions that day");
    await expect(reading.getByRole("button",{name:"View 2 calls"}).locator('[data-icon-role="forward"]')).toBeVisible();
    await reading.getByRole("button",{name:"View 2 calls"}).click();
    await expect(page.locator(".trends-evidence-row")).toHaveCount(2);
    const record=page.locator(".trends-evidence-row a").first();
    await expect(record).toContainText("Review the invented harbor notes mon-a."); await record.click();
    await expect(page.locator("#requestContent")).toHaveAttribute("data-view-key","request:chart-mon-a");
    await page.goBack();await expect(reading.getByRole("button",{name:"View 2 calls"})).toBeFocused();
    await pair.getByRole("button",{name:"Aligned charts",exact:true}).click();await expect(graph).toHaveCount(2);
    await pair.locator(".trend-pair-scene").last().getByRole("button",{name:"Collapse",exact:true}).click();await expect(graph).toHaveCount(1);
    await pair.getByRole("button",{name:"Expand",exact:true}).click();
    await select(second,["timing","timing","p95"]);await expect(pair.getByRole("button",{name:"One graph"})).toBeDisabled();
    await expect(reading).toContainText("180 ms");
    await expect(pair.getByRole("button",{name:"Back to charts"}).locator('[data-icon-role="back"]')).toBeVisible();
    await nav.getByRole("button",{name:"Chart guide"}).click();await expect(page.locator(".trends-guide")).toContainText("95th percentile");
    await page.goBack();await expect(second).toHaveValue(JSON.stringify(["timing","timing","p95"]));
    const periodTransfer=page.locator("#trendsComparePeriods");
    await periodTransfer.click();await page.getByRole("button",{name:"Open comparison",exact:true}).click();
    await expect(page).toHaveURL(/\/compare\?/);
    const u=new URL(page.url());assert.deepEqual(["aFrom","aTo","bFrom","bTo"].map(k=>u.searchParams.get(k)),["2026-11-05","2026-11-11","2026-11-12","2026-11-18"]);
    await expect(page.locator("#analyzeResultCommands")).toBeHidden();
    await expect(page.locator("#analyzeRefresh")).toBeHidden();
    await expect(page.locator("#comparisonOptionsSlot #openAnalyzeFilters")).toBeVisible();
    await page.getByRole("button",{name:"Back to Trends",exact:true}).press("Enter");await expect(periodTransfer).toBeFocused();
    await expect(first).toHaveValue(JSON.stringify(["problems","problems","share"]));
    await expect(second).toHaveValue(JSON.stringify(["timing","timing","p95"]));
    await expect(reading).toContainText("Nov 16");await expect(reading).toContainText("180 ms");
    await pair.getByRole("button",{name:"Remove comparison"}).click();await expect(second).toHaveValue("");
    await expect(graph).toHaveCount(1);assert.equal(reads.length,1);
});

test("hovering a section or utility paints a compact face without reducing the hit target", async t => {
    const { page } = await setup(t);
    const guide = page.locator("#trends-section-guide");
    for (const theme of ["light","dark"]) {
        await chooseTheme(page,theme);
        for (const control of [guide, page.locator("#openEvidenceHelp"), page.locator("#wireFeedback"), page.locator("#navigationCollapse")]) {
            await control.hover();
            await expect.poll(() => control.evaluate(node => getComputedStyle(node,"::before").backgroundColor),
                {message: `Hover face on ${await control.getAttribute("id")}`}).not.toBe("rgba(0, 0, 0, 0)");
            const geometry = await control.evaluate(node => {
                const box = node.getBoundingClientRect(), face = getComputedStyle(node,"::before"), target = getComputedStyle(node);
                return { height:box.height, faceHeight:parseFloat(face.height), faceInk:face.backgroundColor, surface:target.backgroundColor,
                    outerHit:node.contains(document.elementFromPoint(box.left+box.width/2,box.bottom-2)) };
            });
            assert.ok(geometry.outerHit && geometry.height >= 44);
            assert.equal(geometry.surface,"rgba(0, 0, 0, 0)");
            assert.notEqual(geometry.faceInk,"rgba(0, 0, 0, 0)");
            assert.ok(geometry.faceHeight >= 20 && geometry.faceHeight <= geometry.height-10, JSON.stringify(geometry));
        }
        await guide.focus(); await page.keyboard.press("Shift");
        await expect(guide).toBeFocused(); await expect(guide).toHaveCSS("outline-style","solid");
        await expect(page.locator("#trends-section-charts")).toHaveAttribute("aria-current","page");
    }
});

test("first entry finds the latest retained week; an explicitly empty period stays empty and names the way back", async t => {
    const {page, index, reads} = await setup(t, false, { now: "2026-12-05T19:00:00Z" });
    const region = page.locator("#trendsView"), card = panelOf(page,"rhythm"), period = region.locator("#trendsPeriod");
    await navigateMain(page,"settings"); await navigateSettings(page,"themes");
    await page.locator(".palette-option:has(#palette-blue)").click(); await navigateMain(page,"trends");
    await screenshot(page,"historical-first-entry");
    await expect(card.locator(".trends-index-scope")).toContainText("4 dated calls");
    assert.equal(reads.at(-1).from,"2026-11-12"); assert.equal(reads.at(-1).to,"2026-11-18");
    await expect(period).toContainText("Nov 12–18, 2026"); await expect(card.locator("[data-trend-bar]")).toHaveCount(2);
    await period.click(); await region.getByRole("button",{name:"Last 7 days",exact:true}).click();
    await expect(card.locator(".trends-index-scope")).toContainText("0 dated calls");
    for (const id of ["rhythm","problems","services","tools","models","timing","authors"]) {
        await index.locator(`[data-measure="${id}"]`).click();
        await expect(panelOf(page,id).locator(".trends-plot")).toBeHidden();
        await expect(panelOf(page,id).getByRole("button",{name:"Data table"})).toBeVisible();
    }
    await index.locator('[data-measure="rhythm"]').click();
    await screenshot(page,"explicit-empty-week");
    await region.getByRole("button",{name:/Show week ending Nov 18/}).click();
    await expect(card.locator(".trends-index-scope")).toContainText("4 dated calls");
    await period.click(); await region.getByRole("button",{name:"Last 30 days",exact:true}).click();
    await expect(card.locator("svg [data-trend-bar]")).toHaveCount(2);
    await screenshot(page,"sparse-30-days");
});
test("the first clipped 30-day view shows the busiest dated span without rebasing the total or overriding later scrolling", async t => {
    const records = Array.from({length:21}, (_,i) => {
        const r = callsFixture()[1], key = `invented-window-${i}`, stamp = i === 20 ? "2026-12-05T12:00:00Z"
            : `2026-11-${String(7 + Math.floor(i / 4)).padStart(2,"0")}T12:0${i % 4}:00Z`;
        r.scenarioId = key; r.sourceSessionId = key; r.userPrompt.sourceEventId = key;
        Object.assign(r.toolCalls[0], {toolCallId:key, startEventId:key, startedAt:stamp});
        return r;
    });
    const {page} = await setup(t,false,{records,now:"2026-12-05T19:00:00Z"});
    const card = panelOf(page,"rhythm"), plot = card.locator(".trends-plot");
    await page.setViewportSize({width:768,height:820});
    await page.locator("#trendsPeriod").click(); await page.getByRole("button",{name:"Last 30 days",exact:true}).click();
    await expect(card.locator(".trends-index-scope")).toContainText("21 dated calls");
    await screenshot(page,"dense-30-days");
    const at = () => plot.evaluate(n => {
        const left = n.querySelector(".trends-y-axis rect").getBoundingClientRect().right, right = n.getBoundingClientRect().right;
        const bars = [...n.querySelectorAll("[data-trend-bar]")].filter(col => {
            const box = col.getBoundingClientRect(); return box.left >= left && box.right <= right;
        });
        return { count:bars.reduce((sum,b)=>sum + Number(b.closest("[data-trend-mark]").getAttribute("aria-label").match(/, (\d+) calls?$/)[1]),0),
            scroll:n.scrollLeft, overflow:n.scrollWidth - n.clientWidth };
    });
    const first = await at(); assert(first.overflow > 10 && first.count >= 20,JSON.stringify(first));
    await plot.evaluate(n => { n.scrollLeft = n.scrollWidth; });
    await expect.poll(async () => (await at()).count).toBe(1);
    await expect(card.locator(".trends-visible-days")).toContainText("Today in view");
    await card.getByRole("button",{name:"Lines",exact:true}).click();
    assert(Math.abs((await at()).scroll - first.overflow) < 2);
    await expect(card.locator(".trends-index-scope")).toContainText("21 dated calls");
});
const panelOf = (page, id) => page.locator(`.trends-panel[data-family="${id}"]`);
const proof = process.env.WIRE_TRENDS_PROOFS;
async function screenshot(page, name) {
    if (!proof) return; await mkdir(proof, { recursive: true }); await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proof, `${name}.png`) });
}

test("service columns share their card surface and label sparse daily groups without losing any series", async t => {
    const { page, index } = await setup(t,true);
    await index.getByRole("button",{name:"Services",exact:true}).click();
    const card = panelOf(page,"services"), plot = card.locator(".trends-plot");
    for (const theme of ["light","dark"]) {
        await chooseTheme(page,theme);
        const surface = await card.evaluate(card => {
            const plot=card.querySelector(".trends-plot");
            return [getComputedStyle(card).backgroundColor,getComputedStyle(plot).backgroundColor,getComputedStyle(plot.querySelector(".trends-y-axis rect")).fill];
        });
        assert.equal(surface[1],surface[0]); assert.equal(surface[2],surface[0]);
    }
    for (const name of ["Mail","Files"]) await expect(plot.getByRole("button",{name:`Nov 16, 2026: ${name}, 2 calls`})).toHaveText(`${name} 2`);
    await expect(plot.getByText("0",{exact:true})).toHaveCount(6); // Five all-zero days and the scale origin.
    await expect(plot.locator("[data-trend-mark]")).toHaveCount(21);
    await plot.getByRole("button",{name:"Nov 16, 2026: Mail, 2 calls"}).tap();
    await expect(card.getByRole("button",{name:"Data table"}).locator('[data-icon-role="forward"]')).toBeVisible();
    await expect(card.getByRole("button",{name:"View 2 calls"}).locator('[data-icon-role="forward"]')).toBeVisible();
    await card.getByRole("button",{name:"View 2 calls"}).click();
    await expect(page.locator(".trends-evidence-row")).toHaveCount(2);
});

test("aligned call heights agree and changing weeks keep their own denominators", async t => {
    const records=callsFixture(), sun=fixture("harbor-sunday");
    Object.assign(sun.toolCalls[0],{startedAt:"2026-11-15T12:00:00Z"});
    const {page}=await setup(t,false,{records:[...records,sun]});
    await page.getByRole("navigation",{name:"Trends sections"}).getByRole("button",{name:"Overview"}).click();
    const landing=page.locator(".trends-landing:visible");
    await expect(landing).toContainText("No matching dated calls");
    await expect(landing.getByRole("button",{name:/Nov 17.*no matching dated calls/i})).toHaveAccessibleName(/0 interactions/);
    await expect(landing.getByRole("button",{name:"Nov 15, 2026: Errors & failures, 0 interactions",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"Call volume and duration",exact:true}).click();
    const pair=page.locator(".trends-panel-pair"), plots=pair.locator(".trends-plot:visible");
    const select=(i,v)=>selectActivityOption(page,`trendsPairMeasure${i}`,JSON.stringify(v));
    await select(2,["tools","workiq-retrieve","count"]);
    await pair.getByRole("button",{name:"Aligned charts",exact:true}).click();
    const heights=await plots.evaluateAll(plots=>plots.map(plot=>{
        const ys=plot.querySelectorAll(".trends-y-axis text"), baseline=+ys[0].getAttribute("y")-4;
        const mark=plot.querySelector('[aria-label^="Nov 16, 2026:"] :is(circle[cx], rect[x])');
        return {axis:[...ys].map(n=>n.textContent),height:baseline-(mark.tagName==="rect"?+mark.getAttribute("y")+mark.getBBox().height/2:+mark.getAttribute("cy"))};
    }));
    assert.deepEqual(heights[0].axis,heights[1].axis); assert.ok(Math.abs(heights[0].height-3*heights[1].height)<1);
    await select(1,["rhythm","rhythm","share"]);
    await expect(pair.getByRole("button",{name:"One graph"})).toBeDisabled();
    await expect(plots.first().locator("[data-week-boundary]")).toHaveCount(1);
    for (const [date,share,dates] of [[15,"100%","Nov 12 – Nov 15"],[16,"75%","Nov 16 – Nov 18"]]){
        const mark=plots.first().getByRole("button",{name:new RegExp(`Nov ${date}.*${share}`)});
        await mark.focus(); await mark.press("Enter");
        await expect(pair.locator(".trend-pair-readings")).toContainText(dates);
        await expect(page.locator("#trendsTooltip")).toContainText(dates);
    }
    await pair.getByText("Daily values",{exact:true}).click();
    await expect(pair.getByRole("row",{name:/Nov 16, 2026/})).toContainText("3 of 4");
    await expect(pair.getByRole("row",{name:/Nov 16, 2026/})).toContainText("Nov 16 – Nov 18");
});

test("compiled index applies every available filter, supports calendar navigation and pages without changing the full period", { timeout: 90000 }, async t => {
    const { page, reads } = await setup(t), region = page.locator("#trendsView"), card = panelOf(page, "rhythm");
    const period = page.locator("#trendsPeriod"), filter = region.locator(".filter-entry");
    const cases = { trendsPromptauthors: { "": 4, user: 2, agent: 1, unknown: 1 }, trendsTool: { "": 4, "workiq-fetch": 3, "workiq-retrieve": 1 },
        trendsService: { "": 4, Files: 2, Mail: 2, Calendar: 1, Discovery: 0, missing: 0 } };
    for (const [field, expected] of Object.entries(cases)) {
        await filter.click();
        const values = await page.locator(`#${field} option`).evaluateAll(options => options.map(option => option.value));
        assert.deepEqual(values.sort(), Object.keys(expected).sort());
        await page.keyboard.press("Escape"); await expect(filter).toBeFocused();
        for (const value of values) {
            await filter.click(); await selectActivityOption(page, field, value);
            await page.getByRole("button", { name: "Apply filters", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
            await expect(card.locator(".trends-index-scope")).toContainText(`${expected[value]} dated calls`);
        }
        await filter.click(); await region.getByRole("button", { name: "Clear filters", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
    }
    for (const days of [14, 30, 7]) {
        await period.click(); await region.getByRole("button", { name: `Last ${days} days`, exact: true }).click();
        await expect(card.locator("[data-date-tick]")).toHaveCount(days);
    }
    const before = reads.length;
    await period.click(); await region.getByRole("button", { name: "Custom dates", exact: true }).click();
    await region.getByRole("button", { name: "Trends: Previous month" }).click(); await region.getByRole("button", { name: "Trends: Next month" }).click();
    const cell = page.locator('[data-day="2026-11-16"]'); await cell.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
    await expect(page.getByLabel("Trends from", { exact: true })).toHaveValue("2026-11-17");
    await expect(page.getByLabel("Trends to", { exact: true })).toHaveValue("2026-11-18");
    await page.getByLabel("Trends to", { exact: true }).fill("2026-11-10");
    await expect(page.getByRole("button", { name: "Apply dates", exact: true })).toBeDisabled(); await expect(region.getByRole("dialog")).toBeVisible();
    assert.equal(reads.length, before, "invalid calendar drafts never read or replace the accepted range");
    await page.getByLabel("Trends from", { exact: true }).fill("2026-07-01"); await page.getByLabel("Trends to", { exact: true }).fill("2026-11-18");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(region.locator(".trends-paging")).toContainText("91–141 of 141");
    await card.getByRole("button", { name: "Data table" }).click();
    const table = region.getByRole("dialog").getByRole("table");
    await expect(table).toHaveAccessibleName(/Daily rows: 91–141 of 141 days/);
    await expect(table.getByRole("rowheader", { name: "Entire period" })).toBeVisible();
    await expect(table.getByRole("rowheader")).toHaveCount(52);
    await page.keyboard.press("Escape");
    const earlier = region.getByRole("button", { name: "Earlier days" }), later = region.getByRole("button", { name: "Later days" });
    await earlier.focus(); await earlier.press("Enter"); await expect(card.locator("[data-date-tick]")).toHaveCount(90);
    await expect(later).toBeFocused();
    await expect(card.locator(".trends-index-scope")).toContainText("4 dated calls");
    await later.press("Enter"); await expect(card.locator("[data-date-tick]")).toHaveCount(51);
    await expect(earlier).toBeFocused();
    await region.getByRole("button", { name: "Chart guide" }).click();
    await expect(region.locator(".trends-guide")).toContainText("Filters and series"); await page.goBack();
    await period.click();
    const retainedFocus = await region.getByRole("dialog").evaluate(async dialog => {
        const mark = document.querySelector("#trendsPlot-rhythm [data-trend-mark]");
        const closed = new Promise(resolve => dialog.addEventListener("toggle", resolve, { once: true }));
        dialog.hidePopover();
        mark.focus({ preventScroll: true });
        await closed;
        return document.activeElement === mark;
    });

    assert(retainedFocus, "A delayed close event must not steal an intentional chart focus");
});

test("Period edits stay beside their trigger without shifting the chart or reading unapplied dates", async t => {
        const {page,reads}=await setup(t,true), period=page.locator("#trendsPeriod"), panel=page.locator("#trendsDates");
        const count=page.locator('[data-family=rhythm] .trends-index-scope');
        const before=reads.length;
        for(const [width,scale] of [[1280,1],[390,1.5]]){
            await page.setViewportSize({width,height:850});
            await page.evaluate(s=>document.documentElement.style.fontSize=`${s*100}%`,scale);
            await period.scrollIntoViewIfNeeded();
            const plot=page.locator("#trendsPlot-rhythm");
            await plot.evaluate(n=>{window.periodProbe={svg:n.firstElementChild,top:n.getBoundingClientRect().top,scroll:scrollY}});
            await period.tap(); await expect(panel).toBeVisible();
            await screenshot(page,`local-period-${width}`);
            await panel.getByRole("button",{name:"Custom dates"}).tap();
            await expect(panel.getByRole("button",{name:"Last 14 days",exact:true})).toBeVisible();
            await expect(panel.getByLabel("Trends from",{exact:true})).toBeFocused();
            assert.equal(await page.locator(":modal:visible").count(),0);
            await expect(panel).not.toContainText(/inclusive dates|UTC/i);
            const geometry=await panel.evaluate(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:document.documentElement.clientWidth,height:innerHeight}});
            assert.ok(geometry.left>=0&&geometry.right<=geometry.width+1&&geometry.top>=0&&geometry.bottom<=geometry.height,JSON.stringify(geometry));
            assert(await plot.evaluate(n=>window.periodProbe.svg===n.firstElementChild&&Math.abs(n.getBoundingClientRect().top-window.periodProbe.top)<1&&scrollY===window.periodProbe.scroll));
            for (const [bound, day] of [["from","07"],["to","08"]]) {
                const input = panel.getByLabel(`Trends ${bound}`,{exact:true});
                await input.focus();
                await input.press("ArrowLeft"); await input.press("ArrowLeft");
                await input.press("ArrowRight"); await input.pressSequentially(day);
                await expect(input).toHaveValue(`2026-11-${day}`);
                await expect(input).toBeFocused();
                const field = await input.evaluate(n => {
                    const r = n.getBoundingClientRect(), caption = n.labels[0].querySelector("span").getBoundingClientRect();
                    const style = getComputedStyle(n), p = n.closest("[popover]");
                    return { gap: r.top - caption.bottom, offset: r.left - caption.left,
                        ring: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
                        overflow: p.scrollWidth - p.clientWidth };
                });
                assert(field.ring > 0 && field.gap >= field.ring && Math.abs(field.offset) < 1 && field.overflow <= 1,
                    `${width}/${bound}: ${JSON.stringify(field)}`);
            }
            await screenshot(page,`local-custom-${width}`);
            // Shorter viewports may scroll inside the panel, never cut off its actions.
            await page.setViewportSize({width,height:740});
            await panel.getByRole("button",{name:"Cancel"}).scrollIntoViewIfNeeded();
            await expect(panel.getByRole("button",{name:"Apply dates"})).toBeInViewport({ratio:.99}); // fractional CSS pixels at enlarged text
            await panel.getByRole("button",{name:"Cancel"}).tap();await expect(period).toBeFocused();
            assert.equal(reads.length,before);
            await expect(count).toContainText("4 dated calls");
        }
        await period.tap();await panel.getByRole("button",{name:"Custom dates"}).tap();
        await panel.getByLabel("Trends to",{exact:true}).fill("2026-11-19");
        await expect(panel.getByRole("status")).toHaveText("Choose today or an earlier date.");
        await expect(panel.getByRole("button",{name:"Apply dates"})).toBeDisabled();
        const day = panel.locator('[data-day="2026-11-16"]');
        await day.tap(); await day.tap();
        await panel.getByRole("button",{name:"Apply dates"}).tap();
        await expect(count).toContainText("3 dated calls");
        assert.equal(reads.length,before+1);assert.equal(reads.at(-1).from,reads.at(-1).to);
});

test("compiled Trends uses the exact daily populations on both chart types and keeps dates, data and comparisons independent", { timeout: 90000 }, async t => {
    const { page, index, reads } = await setup(t);
    const names = { problems: "Errors & failures", rhythm: "Tool calls", tools: "Tool usage", services: "Services", timing: "Call duration", authors: "Prompt authors", models: "Response models" };
    const series = { problems: 1, rhythm: 1, tools: 2, services: 3, timing: 2, authors: 3, models: 2 };
    const initial = reads.length;
    for (const [id, label] of Object.entries(names)) {
        await index.getByRole("button", { name: label, exact: true }).click(); const panel = panelOf(page, id);
        await expect(panel).toBeVisible(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
        await expect(panel.locator("[data-trend-mark]")).toHaveCount(7 * series[id]);
        const names = await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label")));
        await screenshot(page, `measure-${id}-columns`);
        if (id === "authors") {
            for (const [actor, text, role] of [["user","Human prompts","author-user"],["agent","Agent prompts","author-agent"],["unknown","Sender unclear","author-unknown"]]) {
                const legend = panel.locator(".trends-series").filter({has:page.getByRole("checkbox",{name:`Show ${text}`,exact:true})});
                const glyph = legend.locator(".trends-author-icon");
                await expect(glyph).toHaveAttribute("data-icon-role",role);
                await expect(glyph).toHaveAttribute("aria-hidden","true");
                const iconBox = await glyph.boundingBox(), labelBox = await legend.locator(".trends-series-label").boundingBox();
                assert(iconBox && labelBox && iconBox.width > 0 && iconBox.height > 0 && iconBox.x + iconBox.width <= labelBox.x
                    && Math.abs((iconBox.y + iconBox.height / 2) - (labelBox.y + labelBox.height / 2)) <= 2,
                    `${actor}: glyph stays centered beside, not over, its readable label`);
                const day = actor === "unknown" ? 6 : 4;
                await panel.locator(`[data-trend-mark][data-series="${actor}"]`).nth(day).focus();
                await expect(page.locator("#trendsTooltip .trends-tip-series")).toHaveText(text);
                await expect(page.locator("#trendsTooltip .trends-author-icon")).toHaveAttribute("data-icon-role",role);
                await expect(page.locator("#trendsTooltip .trends-tip-value")).toHaveText("1 interaction");
                await page.keyboard.press("Escape");
            }
        }
        await panel.getByRole("button", { name: "Lines", exact: true }).click();
        assert.deepEqual(await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label"))), names);
        await panel.getByRole("button", { name: "Columns", exact: true }).click();
        if (id !== "timing") {
            await panel.getByRole("button", { name: id === "rhythm" ? "Share within week" : "Percentage", exact: true }).click();
            await panel.getByRole("button", { name: "Count", exact: true }).click();
        }
        for (const check of await panel.locator(".trends-series input").all()) { await check.uncheck(); await expect(check).not.toBeChecked(); }
        if (series[id] > 1) await expect(panel.locator("[data-trend-mark]")).toHaveCount(0);
        for (const check of await panel.locator(".trends-series input").all()) await check.check();
        await panel.getByRole("button", { name: "Data table", exact: true }).click();
        const table = page.locator(".trends-dialog table"); await expect(table.locator("tbody tr")).toHaveCount(8);
        const monday = table.locator("tbody tr").filter({ hasText: "Nov 16" });
        await expect(monday.locator("td").nth(-2)).toHaveText("2"); await expect(monday.locator("td").last()).toHaveText("3");
        if (id === "rhythm") await expect(monday.locator("td").first()).toHaveText("3");
        if (id === "timing") { await expect(monday).toContainText("0 ms"); await expect(monday).toContainText("180 ms"); }
        if (id === "problems") { await expect(monday.locator("td").first()).toHaveText("1"); await expect(table.locator("tbody tr").filter({ hasText: /Nov 18|Today/ })).toContainText("1"); }
        await page.keyboard.press("Escape"); await expect(panel.getByRole("button", { name: "Data table" })).toBeFocused();
    }
    assert.equal(reads.length, initial, "Style, inspection, visibility and unit must not change the retained population");
    await index.getByRole("button", { name: "Tool usage", exact: true }).click();
    const tools = panelOf(page, "tools"), basis = tools.getByLabel("Percentage of", { exact: true });
    const percentage = tools.getByRole("button", { name: "Percentage", exact: true });
    await percentage.focus(); await page.keyboard.press("Space");
    await expect(percentage).toHaveAttribute("aria-pressed", "true");
    const fetch = tools.locator('[data-trend-mark][data-series="workiq-fetch"]').nth(4), tip = page.locator("#trendsTooltip");
    for (const [value, expected, fraction] of [["reach", "50%", "1 of 2 interactions"], ["share", "66.7%", "2 of 3 calls"]]) {
        await selectActivityOption(page, "trendsPercentageof", value); await fetch.focus();
        await expect(tip.locator(".trends-tip-value")).toHaveText(expected); await expect(tip).toContainText(fraction);
        await page.keyboard.press("Enter"); await expect(tools.getByRole("button", { name: "View 2 calls" })).toBeVisible();
    }
    await screenshot(page, "tool-percentage-inspected");
    await tools.getByRole("button", { name: "Count", exact: true }).click(); await expect(basis).toBeHidden();
    await index.getByRole("button", { name: "Services", exact: true }).click(); const services = panelOf(page, "services");
    const mail = services.locator('[data-trend-mark][data-series="Mail"]').nth(4);
    await mail.focus(); await expect(page.locator("#trendsTooltip")).toContainText("2 calls"); await page.keyboard.press("Enter");
    await expect(services.getByRole("button", { name: "View 2 calls" })).toBeVisible();
    await services.getByRole("button", { name: "Lines", exact: true }).click();
    await services.getByRole("button", { name: "Percentage", exact: true }).click(); await mail.focus();
    await expect(page.locator("#trendsTooltip")).toContainText("66.7%"); await expect(page.locator("#trendsTooltip")).toContainText("2 of 3 calls");
    await page.keyboard.press("Escape"); await services.getByRole("button", { name: "View 2 calls" }).click();
    const links = page.locator(".trends-evidence-row a");
    await expect(links).toHaveCount(2);
    const cue = links.first().locator('[data-icon-role="forward"]');
    await page.mouse.move(0,0);
    const linkFace = (await links.first().evaluate(measureControlSurface)).face, idleCue = await cue.evaluate(measureControlSurface);
    await links.first().hover(); await expect.poll(async () => (await cue.evaluate(measureControlSurface)).face).not.toBe(idleCue.face);
    const hoveredCue = await cue.evaluate(measureControlSurface);
    assert.equal((await links.first().evaluate(measureControlSurface)).face, linkFace, "Hover the cue without tinting the call and its prompt");
    await page.mouse.down(); await expect.poll(async () => (await cue.evaluate(measureControlSurface)).face).not.toBe(hoveredCue.face);
    await page.mouse.move(1,1); await page.mouse.up(); await page.evaluate(() => getSelection().removeAllRanges());
    for (const link of await links.all()) {
        assert(!new URL(await link.getAttribute("href"), page.url()).searchParams.has("call"));
        await expect(link).toContainText("Review the invented harbor notes mon-a.");
    }
    const times = await page.locator(".trends-evidence-time").allTextContents();
    assert(times.some(text => text.includes("12:15")) && times.some(text => text.includes("12:16")), times.join("; "));
    await page.keyboard.press("Escape");
    await services.getByRole("button", { name: "Arrange charts" }).click();
    const dialog = page.getByRole("dialog", { name: "Arrange charts" }), choices = dialog.getByRole("checkbox");
    await dialog.getByRole("checkbox", { name: "Call duration", exact: true }).check();
    await dialog.getByRole("button", { name: "Cancel" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
    await services.getByRole("button", { name: "Arrange charts" }).click();
    for (const check of await choices.all()) await check.check();
    await dialog.getByRole("button", { name: "Apply comparison" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(7);
    await services.getByRole("button", { name: "Arrange charts" }).click();
    for (const check of await choices.all()) await check.uncheck();
    await dialog.getByRole("button", { name: "Apply comparison" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
    assert.equal(reads.length, initial);
});

test("compiled Trends keeps its mounted chart and scroll during accepted, canceled, pending and failed filter reads", { timeout: 90000 }, async t => {
    const { page, index } = await setup(t);
    await index.getByRole("button", { name: "Services", exact: true }).click();
    const panel = panelOf(page, "services"), filters = page.locator("#trendsView .filter-entry");
    await page.setViewportSize({ width: 440, height: 650 });
    const marks = () => panel.locator("[data-trend-mark]").count(); const before = await marks();
    await filters.click(); await selectActivityOption(page, "trendsService", "Files"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await marks(), before); await expect(filters).toBeFocused();
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/trends", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); }, { times: 1 });
    await filters.click(); await selectActivityOption(page, "trendsService", "Files");
    await page.evaluate(() => { const chart = document.querySelector('[data-family="services"] .trends-plot'), control = document.querySelector(".trends-toolbar .filter-entry");
        const top = chart.getBoundingClientRect().top, y = scrollY;
        window.sampleFilter = { chart, control, frames: [], done: false };
        (function tick() { const s = window.sampleFilter; s.frames.push([scrollY - y, chart.getBoundingClientRect().top - top]); if (!s.done) requestAnimationFrame(tick); })();
    });

    await page.getByRole("button", { name: "Apply filters" }).click(); await expect(page.locator(".trends-pending")).toContainText("Loading");
    await expect(filters).toHaveText("Filters");
    await expect(panel.locator(".trends-index-scope")).toContainText("4 dated calls"); release();
    await expect(panel.locator(".trends-index-scope")).toContainText("2 dated calls");
    await expect(filters).toHaveText("1 filter applied");
    const motion = await page.evaluate(() => { const s = window.sampleFilter; s.done = true;
        return { frames: s.frames.length, mounted: s.chart.isConnected && s.control.isConnected, worst: Math.max(...s.frames.flat().map(Math.abs)) }; });
    assert(motion.frames > 2); assert(motion.mounted); assert(motion.worst <= 1, JSON.stringify(motion)); await expect(filters).toBeFocused();
    await page.route("**/api/trends", route => route.fulfill({ status: 422, json: { error: "Invented range failure" } }), { times: 1 });
    await filters.click(); await page.getByRole("button", { name: "Clear filters", exact: true }).click(); await expect(page.locator("#trendsView .notice")).toBeVisible();
    await expect(filters).toHaveText("1 filter applied");
    await expect(panel.locator(".trends-index-scope")).toContainText("2 dated calls");
    await page.getByRole("button", { name: "Read stored activity", exact: true }).click(); await expect(panel.locator(".trends-index-scope")).toContainText("4 dated calls");
    await expect(filters).toHaveText("Filters");
    if (proof) await writeFile(path.join(proof, "filter-motion.json"), JSON.stringify(motion));
});

test("Trends keeps its scope toolbar and hit targets in place through zero, one, two and clear", async t => {
    const { page } = await setup(t), view = page.locator("#trendsView"), filters = view.locator(".filter-entry");
    // The result caption below can grow to name the actual restrictions. The toolbar cannot.
    const boxes = () => view.locator(".trends-toolbar,#trendsPeriod,.trends-filter-actions>button").evaluateAll(nodes => nodes.map(n => {
        const r = n.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height].map(Math.round);
    }));
    for (const [width, scale] of [[1280, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(async scale => { document.documentElement.style.fontSize = `${scale * 100}%`; await document.fonts.ready; }, scale);
        const before = await boxes();
        for (const [field, value, text] of [["trendsPromptauthors", "user", "1 filter applied"], ["trendsTool", "workiq-fetch", "2 filters applied"]]) {
            await filters.press("Enter");
            await selectActivityOption(page, field, value);
            await view.getByRole("button", { name: "Apply filters", exact: true }).click();
            await expect(filters).toHaveText(text); await expect(filters).toBeFocused();
            assert.deepEqual(await boxes(), before);
        }
        await page.mouse.move(2, 2);
        await filters.scrollIntoViewIfNeeded();
        await screenshot(page, `applied-${width}`);
        await filters.click(); await view.getByRole("button", { name: "Clear filters", exact: true }).click();
        await expect(filters).toHaveText("Filters"); await expect(filters).toBeFocused();
        assert.deepEqual(await boxes(), before);
    }
});

test("compiled Trends keeps the reading anchor across refinements, compare, empty, failed and superseded reads", { timeout: 90000 }, async t => {
    const { page, index } = await setup(t), view = page.locator("#trendsView"), panel = panelOf(page, "tools");
    const filters = view.locator(".filter-entry"), period = view.locator("#trendsPeriod");
    const tool = index.getByRole("button", { name: "Tool usage", exact: true });
    await tool.click();
    const frames = [];
    async function watch(label, act, { scene = false } = {}) {
        await page.evaluate(() => {
            const tab = document.querySelector(".trends-measure-index"), toolbar = document.querySelector(".trends-toolbar");
            const host = document.querySelector("#trendsPlot-tools"), svg = host.querySelector("svg");
            const ref = [scrollY, tab.getBoundingClientRect().top, toolbar.getBoundingClientRect().top];
            const trace = window.trendsMotionTest = { ref, frames: [], alive: true };
            const tick = () => {
                if (!trace.alive) return;
                trace.frames.push({ pos: [scrollY, tab.getBoundingClientRect().top, toolbar.getBoundingClientRect().top],
                    joined: tab.isConnected && toolbar.isConnected && host.isConnected, scene: host.firstElementChild === svg,
                    focus: document.activeElement.id || document.activeElement.getAttribute("aria-label") || document.activeElement.tagName });
                requestAnimationFrame(tick);
            }; tick();
        });
        await act();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const trace = await page.evaluate(() => { const t = window.trendsMotionTest; t.alive = false; return t; });
        frames.push({ label, ...trace });
        const displacement = Math.max(...trace.frames.flatMap(frame => frame.pos.map((v,i)=>Math.abs(v-trace.ref[i]))));
        assert(trace.frames.length >= 2 && displacement <= 1, `${label}: ${displacement}px movement of unrelated controls`);
        assert(trace.frames.every(frame => frame.joined && (!scene || frame.scene)), `${label}: replaced retained content`);
    }
    async function applyService(value) {
        await filters.click(); await selectActivityOption(page, "trendsService", value);
        await view.getByRole("button", { name: "Apply filters" }).click();
        await expect(view).toHaveAttribute("aria-busy", "false");
    }
    const choose = (owner, name) => owner.getByRole("button", { name, exact: true }).click();
    await watch("cancel draft", async () => { await filters.click(); await selectActivityOption(page,"trendsService","Mail"); await choose(view,"Cancel"); await expect(filters).toBeFocused(); }, {scene:true});
    await watch("percentage then count", async () => { await choose(panel,"Percentage"); await choose(panel,"Count"); });
    await watch("lines then columns", async () => { await choose(panel,"Lines"); await choose(panel,"Columns"); });
    const check = panel.getByRole("checkbox").first();
    await watch("series visibility", async () => {
        await check.uncheck(); await expect(panel.locator(".trends-index-scope")).toContainText("1 of 2 series shown");
        await expect(filters).toHaveText("Filters");
        await check.check(); await expect(check).toBeFocused();
        await expect(panel.locator(".trends-index-scope")).not.toContainText("series shown");
    });
    await watch("change measure and return", async () => { await choose(index,"Response models"); await tool.click(); });
    await watch("add comparison", async () => {
        await choose(panel,"Arrange charts"); await view.getByRole("checkbox",{name:"Services",exact:true}).check();
        await choose(view,"Apply comparison"); await expect(panelOf(page,"services")).toBeVisible();
        await expect(panel.locator(".trends-index-scope")).toContainText("Comparing 2 measures");
        await expect(filters).toHaveText("Filters");
    }, {scene:true});
    await watch("remove comparison", async () => {
        await choose(panel,"Arrange charts"); await view.getByRole("checkbox",{name:"Services",exact:true}).uncheck();
        await choose(view,"Apply comparison");
        await expect(panel.locator(".trends-index-scope")).not.toContainText("Comparing");
    }, {scene:true});
    await watch("empty filter", async () => { await applyService("Discovery"); await expect(panel.locator(".trends-no-activity")).toContainText("No matching calls"); });
    await watch("clear empty", async () => { await filters.click(); await choose(view,"Clear filters"); await expect(panel.locator(".trends-index-scope")).toContainText("4 dated calls"); await expect(filters).toBeFocused(); });
    await watch("failed filter", async () => {
        await page.route("**/api/trends", route => route.fulfill({ status:503,json:{error:"Invented read failure"} }), {times:1});
        await applyService("Mail"); await expect(view.locator(".notice")).toContainText("Invented read failure");
    }, {scene:true});
    await watch("retry original filter", async () => { await choose(view,"Read stored activity"); await expect(panel.locator(".trends-index-scope")).toContainText("2 dated calls"); });
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { arrived = resolve; });
    t.after(() => release());
    await page.route("**/api/trends", async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({response}); }, {times:1});
    await watch("supersede pending date", async () => {
        await period.click(); await choose(view,"Last 14 days"); await held;
        await expect(view.locator(".trends-pending")).toContainText("14 days");
        await period.click(); await choose(view,"Last 30 days"); await expect(panel.locator("[data-date-tick]")).toHaveCount(30);
        release(); await expect(view).toHaveAttribute("aria-busy","false"); await expect(period).toBeFocused();
    });
    if (proof) await writeFile(path.join(proof,"trends-control-frames.json"),JSON.stringify(frames));
});

test("compiled Trends is readable in all five palettes, both modes, narrow and enlarged with the same keyboard and touch evidence", { timeout: 150000 }, async t => {
    const { page, index } = await setup(t, true);
    for (const id of Object.keys(palettes)) {
        await navigateMain(page, "settings"); await navigateSettings(page, "themes"); await page.locator(`.palette-option:has(#palette-${id})`).click();
        await navigateMain(page, "trends"); await index.getByRole("button", { name: "Services", exact: true }).click();
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme); await expect(page.locator("html")).toHaveAttribute("data-evidence-palette", id);
            await page.mouse.move(0, 0); await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            const active = await index.getByRole("button", { name: "Services", exact: true }).evaluate(measureControlSurface);
            const normal = await index.getByRole("button", { name: "Response models", exact: true }).evaluate(measureControlSurface);
            assert.notEqual(active.face, normal.face, `${id}/${theme}: the current measure has a painted state`);
            assert(contrast(active.ink, active.face) >= 4.5, `${id}/${theme}: current measure contrast`);
            await screenshot(page, `product-${id}-${theme}`);
            const panel = panelOf(page, "services"), point = panel.locator('[data-trend-mark][data-series="Mail"]').nth(4);
            await point.tap(); await expect(panel.getByRole("button", { name: "View 2 calls" })).toBeVisible();
            await expect(page.locator("#trendsTooltip")).toContainText("2 calls"); await page.keyboard.press("Escape");
        }
    }
    for (const [width, scale] of [[768, 1], [390, 1], [390, 2], [320, 2]]) {
        await page.setViewportSize({ width, height: 850 }); await page.evaluate(s => document.documentElement.style.fontSize = `${s * 100}%`, scale);
        for (const label of ["Response models", "Services", "Call duration"]) {
            await index.getByRole("button", { name: label, exact: true }).click();
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: ${width}px @ ${scale}`);
            await expect(index.getByRole("button")).toHaveCount(7);
            const geometry = await page.locator(".trends-panel:visible").evaluate(panel => ({
                plot: panel.querySelector(".trends-plot").getBoundingClientRect().top,
                title: panel.querySelector("h2").getBoundingClientRect().top, focus: document.activeElement.tagName, y: scrollY, h: innerHeight,
            }));
            assert(geometry.plot < geometry.h, `${width}/${scale}/${label}: ${JSON.stringify(geometry)}`);
        }
        await screenshot(page, `product-narrow-${width}-${scale}`);
        if (scale === 2) {
            const duration = panelOf(page, "timing");
            await duration.getByRole("button", { name: "Data table" }).tap();
            const region = page.getByRole("dialog").locator(".trends-exact");
            const sizes = await region.evaluate(node => {
                const heading = node.querySelector("th"), range = document.createRange();
                range.selectNodeContents(heading);
                return { lines: range.getClientRects().length, date: heading.getBoundingClientRect().width, total: node.clientWidth };
            });
            assert(sizes.lines === 1 && sizes.date < sizes.total * .55, `Date and values must both fit: ${JSON.stringify(sizes)}`);
            await page.keyboard.press("Escape");
        }
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    const duration = panelOf(page, "timing"), lines = duration.getByRole("button", { name: "Lines", exact: true });
    await lines.focus(); await page.keyboard.press("Space");
    await expect(lines).toHaveAttribute("aria-pressed", "true");
    assert.equal(await lines.evaluate(n => getComputedStyle(n).outlineStyle), "solid");
    await duration.locator('[data-trend-mark][data-series="timing"]').nth(4).focus();
    await expect(page.locator("#trendsTooltip")).toContainText("0 ms");
});

test("Trends choices keep their selected state distinct from hover and press without moving the label", {timeout:150000}, async t => {
    const { page, index } = await setup(t), view = page.locator("#trendsView"), card = panelOf(page, "authors");
    await index.getByRole("button", { name: "Prompt authors", exact: true }).click();
    const failures = [], measured = [];
    async function states(control, name, input = control) {
        const paint = async () => {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            return control.evaluate(measureControlSurface);
        };
        await page.mouse.move(1,1); const idle = await paint();
        await control.hover(); const hover = await paint();
        await page.mouse.down(); const press = await paint(); await page.mouse.move(1,1); await page.mouse.up();
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.keyboard.press("Tab"); await input.focus();
        const focus = await paint();
        measured.push({ name, idle, hover, press, focus });
        if (idle.face === hover.face || hover.face === press.face) failures.push(`${name}: idle/hover/pressed ${idle.face}, ${hover.face}, ${press.face}`);
        if (idle.box.height < 44 || hover.box.height !== idle.box.height || Math.abs(press.box.x-idle.box.x)>1) failures.push(`${name}: hit area ${idle.box.width} x ${idle.box.height}`);
        if (!focus.focus || focus.focusWidth < 2) failures.push(`${name}: no visible keyboard focus on target`);
    }
    // The palette matrix above covers theme variants; exercise the interactive states here.
    const id = await page.locator("html").getAttribute("data-evidence-palette");
      for (const mode of ["light", "dark"]) {
        await chooseTheme(page, mode);
        for (const [label,control] of [
            ["current measure", index.getByRole("button",{name:"Prompt authors",exact:true})],
            ["other measure", index.getByRole("button",{name:"Services",exact:true})],
            ["selected unit",card.getByRole("button",{name:"Count",exact:true})],
            ["other unit",card.getByRole("button",{name:"Percentage",exact:true})],
            ["selected encoding",card.getByRole("button",{name:"Columns",exact:true})],
            ["other encoding",card.getByRole("button",{name:"Lines",exact:true})],
        ]) await states(control,`${id}/${mode} ${label}`);
        const series = card.locator(".trends-series").first();
        await states(series,`${id}/${mode} series`,series.locator("input"));
        await card.getByRole("button",{name:"Arrange charts"}).click();
        const row = view.getByRole("dialog").locator(".trends-compare-choices label").first(), check = row.locator("input");
        await states(row,`${id}/${mode} comparison unchecked`,check);
        await check.check(); await states(row,`${id}/${mode} comparison checked`,check);
        if (proof && id === "petrol") { await row.hover(); await screenshot(page,`compare-choice-${mode}`); }
        await page.keyboard.press("Escape");
      }
    if (proof) { await mkdir(proof,{recursive:true}); await writeFile(path.join(proof,"trends-choice-paint.json"),JSON.stringify(measured)); }
    assert.deepEqual(failures,[]);
});
