import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState } from "../../lib/store.mjs";
import { recordedInteractionModels } from "../../lib/interaction-model.mjs";
import { fixture, privateFixture, navigateMain, navigateSettings, closeAnalyzeFilters, chooseTheme, fulfillFixtureUpdateStatus, selectActivityOption } from "../support/helpers.mjs";
import { palettes } from "../../web/theme.mjs";
import { contrast, measureControlSurface } from "../support/color-measurements.mjs";

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
    await pair.getByRole("button",{name:"Collapse both charts",exact:true}).press("Enter");await expect(graph).toHaveCount(0);
    const expandBoth = pair.getByRole("button",{name:"Expand both charts",exact:true});await expect(expandBoth).toBeFocused();
    await pair.getByRole("button",{name:"One graph",exact:true}).click();await expect(graph).toHaveCount(1);
    await pair.getByRole("button",{name:"Aligned charts",exact:true}).click();await expect(graph).toHaveCount(0);
    await expandBoth.press("Space");await expect(graph).toHaveCount(2);await expect(reading).toContainText("Nov 16");
    await select(second,["timing","timing","p95"]);await expect(pair.getByRole("button",{name:"One graph"})).toBeDisabled();
    await expect(reading).toContainText("180 ms");
    await expect(pair.getByRole("button",{name:"Back to charts"}).locator('[data-icon-role="back"]')).toBeVisible();
    await nav.getByRole("button",{name:"Chart guide"}).click();await expect(page.locator(".trends-guide")).toContainText("95th percentile");
    await page.goBack();await expect(second).toHaveValue(JSON.stringify(["timing","timing","p95"]));
    const periodTransfer=page.locator("#trendsComparePeriods");
    const comparing = page.waitForRequest("**/api/period-comparison");
    await periodTransfer.click();await page.getByRole("button",{name:"Open comparison",exact:true}).click();
    await expect(page).toHaveURL(/\/compare$/);
    assert.deepEqual((await comparing).postDataJSON().periods, { baseline: { from: "2026-11-05", to: "2026-11-11" }, later: { from: "2026-11-12", to: "2026-11-18" } });
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
        await expect(panelOf(page,id).getByRole("button",{name:"View daily values"})).toBeVisible();
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
function obscuredValues(plot) {
    const bars=[...plot.querySelectorAll("[data-trend-bar]")];
    return [...plot.querySelectorAll("[data-trend-mark] text")].filter(n=>getComputedStyle(n).visibility==="visible").flatMap(label=>{
        const a=label.getBoundingClientRect();
        return bars.filter(bar=>{
            if (bar.closest("[data-trend-mark]")===label.closest("[data-trend-mark]")) return false;
            const b=bar.getBoundingClientRect();
            return a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top;
        }).map(bar=>`${label.textContent} overlaps ${bar.closest("[data-trend-mark]").getAttribute("aria-label")}`);
    });
}
const proof = process.env.WIRE_TRENDS_PROOFS;
async function screenshot(page, name) {
    if (!proof) return; await mkdir(proof, { recursive: true }); await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    await page.screenshot({ path: path.join(proof, `${name}.png`) });
}

test("Overview keeps View chart beside its independent download action", async t => {
    const { page, index } = await setup(t);
    const overview = page.getByRole("navigation", { name: "Trends sections" }).getByRole("button", { name: "Overview" });
    await overview.click();
    await chooseTheme(page, "dark");
    const header = page.locator(".trends-landing > .trends-landing-head");
    const view = header.getByRole("button", { name: "View chart" });
    const download = header.getByRole("button", { name: "Download chart as PNG" });
    async function bounds(head, first, last) {
        const [row, a, b] = await Promise.all([head.boundingBox(), first.boundingBox(), last.boundingBox()]);
        assert.ok(row && a && b);
        return { gap: b.x - (a.x + a.width), edge: row.x + row.width - (b.x + b.width), dy: Math.abs(a.y - b.y) };
    }
    const sizes = [];
    for (const width of [1440, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(download).toBeVisible();
        await screenshot(page, `overview-chart-actions-${width}`);
        sizes.push({ width, ...await bounds(header, view, download) });
    }
    for (const box of sizes) {
        assert.ok(box.gap >= 0 && box.gap <= 8 && Math.abs(box.edge) <= 1 && box.dy <= 1, JSON.stringify(box));
    }
    await view.focus(); await page.keyboard.press("Tab"); await expect(download).toBeFocused();
    const plot = page.locator("#trendsOverviewPlot");
    const reading = () => plot.evaluate(node => [node.scrollLeft, node.clientWidth, node.scrollWidth, getComputedStyle(node).overflowX]);
    const before = await reading();
    assert.ok(before[0] > 0 && before[1] < before[2] && before[3] === "auto", "the narrow live chart is scrolled");
    const [file] = await Promise.all([page.waitForEvent("download"), download.press("Enter")]);
    assert.equal(file.suggestedFilename(), "WIRE-Errors & failures.png");
    if (proof) await file.saveAs(path.join(proof, "overview-chart-download.png"));
    const bytes = await readFile(await file.path());
    const band = await page.evaluate(async png => {
        const img = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))]));
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        // The native track is a thick, full-width band below the marks. A
        // gridline is thin; date labels and their caption don't fill a row.
        let consecutive = 0, tallest = 0;
        for (let y = Math.floor(img.height * .7); y < img.height; y++) {
            let filled = 0;
            for (let n = 1; n < 20; n++) {
                const x = Math.floor(img.width * (.1 + .8 * n / 20)), i = (y * img.width + x) * 4;
                if (Math.abs(data[i]-data[0]) + Math.abs(data[i+1]-data[1]) + Math.abs(data[i+2]-data[2]) > 90) filled++;
            }
            consecutive = filled >= 18 ? consecutive + 1 : 0;
            tallest = Math.max(tallest, consecutive);
        }
        return tallest;
    }, bytes.toString("base64"));
    assert.ok(band < 8, `download contains a ${band}px scrollbar band`);
    assert.deepEqual(await reading(), before, "export must not restyle or move the live viewport");
    await expect(view).toBeVisible(); await view.click();
    await expect(index.getByRole("button", { name: "Errors & failures", exact: true })).toHaveAttribute("aria-current", "page");
    await overview.click();
    await page.getByRole("button", { name: "Call volume and duration", exact: true }).click();
    const pair = page.locator(".trends-panel-pair > .trends-landing-head");
    const box = await bounds(pair, pair.getByRole("button", { name: "Collapse both charts" }), pair.getByRole("button", { name: "Download chart as PNG" }));
    assert.ok(box.gap >= 0 && box.gap <= 8 && Math.abs(box.edge) <= 1 && box.dy <= 1, JSON.stringify(box));
});

test("choosing charts keeps only the requested families on screen", async t => {
    const { page, index, reads } = await setup(t, true);
    await page.goto(new URL("/",page.url()).href); await navigateMain(page, "trends");
    const nav = page.getByRole("navigation", {name:"Trends sections"});
    await nav.getByRole("button", {name:"Overview"}).click();
    await page.locator(".trends-explore").getByRole("button",{name:"Token usage"}).click();
    const usage = panelOf(page,"usage"), families = page.locator(".trends-panel:visible h2");
    const choose = page.getByRole("group",{name:"Trend scope and options"}).getByRole("button",{name:"Show or hide charts",exact:true});
    const dates = await page.locator("#trendsPeriod").innerText(), before = reads.length;
    await expect(usage.locator(".trends-plot")).toBeHidden();
    await expect(usage.getByRole("button",{name:"Tokens",exact:true})).toHaveCount(0);
    await expect(usage.getByRole("heading",{name:"No token counts available"})).toBeVisible();
    await expect(usage.locator(".trends-no-activity")).toContainText("0 of 3 interactions metered");
    await choose.press("Enter");
    const popup = page.getByRole("dialog",{name:"Show or hide charts"});
    await expect(popup.getByRole("heading")).toHaveText("Show below Token usage");
    for (const name of ["Services","Call duration"]) await popup.getByRole("checkbox",{name,exact:true}).check();
    await screenshot(page,"choose-charts");
    await popup.getByRole("button",{name:"Apply"}).click();
    const selected = ["Token usage","Services","Call duration"];
    await expect(families).toHaveText(selected); await expect(choose).toBeFocused();
    await screenshot(page,"selected-charts");
    await usage.getByRole("button",{name:"View daily values"}).click();
    const table = page.getByRole("dialog",{name:"Daily values"}).getByRole("table");
    await expect(table.locator("caption")).toContainText(selected[0]);
    await expect(table.locator("tbody tr")).toHaveCount(8);
    await expect(table.getByRole("row",{name:/Entire period/})).toContainText("Unavailable");
    await page.keyboard.press("Escape"); await expect(usage.getByRole("button",{name:"View daily values"})).toBeFocused();
    await choose.click(); await popup.getByRole("checkbox",{name:"Services",exact:true}).uncheck();
    await page.keyboard.press("Escape"); await expect(choose).toBeFocused(); await expect(families).toHaveText(selected);
    await panelOf(page,"timing").getByRole("button",{name:"Hide chart"}).click(); await expect(choose).toBeFocused();
    await expect(families).toHaveText(selected.slice(0,2));
    await choose.click(); await expect(popup.getByRole("checkbox",{name:"Call duration"})).not.toBeChecked();
    await popup.getByRole("button",{name:"Open all charts"}).click();
    const all = await index.getByRole("button").allTextContents();
    await expect(families).toHaveText(all);
    await page.getByRole("button",{name:"Back to selected charts"}).press("Enter");
    await expect(choose).toBeFocused(); await expect(families).toHaveText(selected.slice(0,2));
    await nav.getByRole("button",{name:"Chart guide"}).click(); await expect(choose).toBeHidden();
    await page.goBack(); await expect(families).toHaveText(selected.slice(0,2));
    await index.getByRole("button",{name:"Prompt authors"}).click();
    await expect(families).toHaveText(["Prompt authors"]);
    await page.setViewportSize({width:390,height:844}); await chooseTheme(page,"dark");
    await choose.tap();
    await expect(popup.getByRole("checkbox",{checked:true})).toHaveCount(0);
    await popup.getByRole("checkbox",{name:"Tool calls",exact:true}).tap(); await popup.getByRole("button",{name:"Apply"}).tap();
    await expect(families).toHaveText(["Prompt authors","Tool calls"]);
    await panelOf(page,"rhythm").getByRole("button",{name:"Lines",exact:true}).tap();
    await choose.scrollIntoViewIfNeeded(); await screenshot(page,"selected-charts-narrow-dark");
    await choose.tap(); await popup.getByRole("checkbox",{name:"Tool calls",exact:true}).tap(); await popup.getByRole("button",{name:"Apply"}).tap();
    await expect(families).toHaveText(["Prompt authors"]);
    assert.equal(await page.locator("#trendsPeriod").innerText(),dates); assert.equal(reads.length,before);
    await page.reload(); await expect(families).toHaveText(["Prompt authors"]); await expect(page.locator("#trendsPeriod")).toHaveText(dates);
    await choose.tap(); await expect(popup.getByRole("checkbox",{checked:true})).toHaveCount(0);
});

test("a filter that removes a paired reading keeps only the measure still available", async t => {
    const { page, index } = await setup(t), card = panelOf(page,"usage");
    await index.getByRole("button",{name:"Token usage"}).click();
    await selectActivityOption(page,"trendsUsagequestion","author");
    await expect(card.getByRole("checkbox",{name:"Show Human"})).toBeVisible();
    await card.getByRole("button",{name:"Compare measures"}).click();
    await selectActivityOption(page,"trendsPairMeasure1",JSON.stringify(["usage","author:Human","tokens"]));
    await expect(page.locator(".trend-pair-scene:visible")).toContainText("No daily values available");
    await expect(page.locator(".trend-pair-scene .trends-plot:visible")).toHaveCount(0);
    await selectActivityOption(page,"trendsPairMeasure2",JSON.stringify(["rhythm","rhythm","count"]));
    await page.locator("#trendsView .filter-entry").click();
    await selectActivityOption(page,"trendsService","Calendar");
    await page.getByRole("button",{name:"Apply filters"}).click();
    const pair = page.locator(".trends-panel-pair");
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy","false");
    await expect(pair.locator("#trendsPairMeasure1")).toHaveValue(JSON.stringify(["rhythm","rhythm","count"]));
    await expect(pair.locator("#trendsPairMeasure2")).toHaveValue("");
    await expect(pair.locator(".trends-plot:visible")).toHaveCount(1);
    await expect(pair.locator(".trend-pair-readings")).toContainText("Tool calls · calls");
    await expect(pair.locator(".trends-index-scope")).toContainText("The other measure is unavailable");
    await pair.getByText("Daily values",{exact:true}).click();
    await expect(pair.getByRole("columnheader")).toHaveText(["Date","Tool calls · calls"]);
    await expect(page.locator("#trendsView .notice:visible")).toHaveCount(0);
    await page.locator("#trendsView .filter-entry").click();
    await page.getByRole("button",{name:"Clear filters",exact:true}).click();
    await expect(page.locator("#trendsView .filter-entry")).toHaveText("Filters");
    await expect(pair.locator("#trendsPairMeasure2")).toHaveValue("");
    await expect(pair.getByRole("columnheader")).toHaveText(["Date","Tool calls · calls"]);
});

test("bulk disclosure acts only on this chart stack and keeps the pinned reading", async t => {
    const { page, index, reads } = await setup(t,true);
    const toolbar = page.getByRole("group",{name:"Trend scope and options"}), cards = page.locator(".trends-panel:visible");
    const closeAll = toolbar.getByRole("button",{name:"Collapse all",exact:true}), openAll = toolbar.getByRole("button",{name:"Expand all",exact:true});
    const choose = toolbar.getByRole("button",{name:"Show or hide charts"}), popup = page.getByRole("dialog",{name:"Show or hide charts"});
    const opened = cards.filter({has:page.locator(".trends-content:visible")}).locator("h2");
    await expect(closeAll).toHaveCount(0);
    await choose.click();
    for (const name of ["Services","Call duration"]) await popup.getByRole("checkbox",{name,exact:true}).check();
    await popup.getByRole("button",{name:"Apply"}).click();
    const before = reads.length, period = await toolbar.locator("#trendsPeriod").innerText(), rhythm = panelOf(page,"rhythm");
    const point = rhythm.getByRole("button",{name:/Nov 16.*3 calls/});
    await point.press("Enter");
    await panelOf(page,"services").getByRole("button",{name:"Collapse chart"}).click();
    await expect(opened).toHaveText(["Tool calls","Call duration"]);
    await expect(closeAll).toBeVisible();
    assert.equal(await closeAll.getAttribute("aria-expanded"),null);
    await closeAll.press("Space"); await expect(opened).toHaveCount(0); await expect(openAll).toBeFocused();
    await expect(openAll).toHaveAttribute("aria-expanded","false");
    await expect(cards.locator("h2")).toHaveText(["Tool calls","Services","Call duration"]);
    await expect(cards.locator(".trends-period-label:visible")).toHaveCount(3);
    await openAll.press("Enter"); await expect(opened).toHaveText(["Tool calls","Services","Call duration"]);
    await expect(closeAll).toHaveAttribute("aria-expanded","true");
    await expect(point).toHaveAttribute("aria-pressed","true");
    await panelOf(page,"timing").getByRole("button",{name:"Collapse chart"}).click();
    await choose.tap(); await popup.getByRole("button",{name:"Open all charts"}).tap();
    const allNames = await index.getByRole("button").allTextContents(); await expect(opened).toHaveText(allNames);
    await page.getByRole("button",{name:"Collapse Services",exact:true}).press("Enter");
    await closeAll.tap(); await expect(opened).toHaveCount(0);
    await page.setViewportSize({width:390,height:844}); await chooseTheme(page,"dark");
    await screenshot(page,"expand-all-narrow");
    await openAll.tap(); await expect(opened).toHaveText(allNames);
    await toolbar.getByRole("button",{name:"Back to selected charts"}).tap();
    await expect(opened).toHaveText(["Tool calls","Services"]);
    await closeAll.tap(); await expect(openAll).toBeVisible();
    await panelOf(page,"services").locator("h2").tap();
    await expect(opened).toHaveText(["Services"]); await expect(closeAll).toBeVisible();
    await closeAll.tap(); await openAll.tap(); await expect(point).toHaveAttribute("aria-pressed","true");
    assert.equal(await toolbar.locator("#trendsPeriod").innerText(),period); assert.equal(reads.length,before);
    await index.getByRole("button",{name:"Token usage"}).tap(); await expect(closeAll).toHaveCount(0); await expect(openAll).toHaveCount(0);
});

test("response models keep known names on the chart and open the exact interactions with partial history", async t => {
    const stamp = "2026-11-23T19:00:00.000Z";
    const records = Array.from({ length: 8 }, (_, i) => {
        const key = `harbor-${i}`, record = fixture(key), messageId = `message-${key}`;
        record.userPrompt = { text: `Review harbor note ${i}.`, sourceEventId: key, sourceTimestamp: stamp, status: "full" };
        record.toolCalls[0].startedAt = stamp;
        const prompt = { id: key, type: "user.message", timestamp: stamp, data: { messageId } };
        const reply = { id: `reply-${key}`, type: "assistant.message", timestamp: stamp,
            data: { originatingMessageId: messageId, turnId: key, model: "Alder", phase: "final_answer", content: "Invented answer." } };
        const end = { id: `end-${key}`, type: "assistant.turn_end", timestamp: stamp, data: { turnId: key } };
        record.originalModelEvidence = recordedInteractionModels(i === 0 ? [prompt, reply] : i === 1
            ? [prompt, reply, { ...reply, id: `next-${key}`, data: { ...reply.data, model: null } }, end]
            : [prompt, reply, end], record, { partialWindow: i === 2 });
        if (i === 0) record.toolCalls.push({ ...record.toolCalls[0], toolCallId: "another-call", startEventId: "another-start" });
        return record;
    });
    const { page, index, reads } = await setup(t, false, { records, now: "2026-11-24T19:00:00Z" });
    await index.getByRole("button", { name: "Response models" }).click();
    const card = panelOf(page, "models"), daily = card.getByRole("button", { name: "View daily values" });
    assert.equal(reads.at(-1).from, "2026-11-18"); assert.equal(reads.at(-1).to, "2026-11-24");
    await expect(card.locator(".trends-index-scope")).toHaveText("8 originating interactions in this period");
    const mark = card.getByRole("button", { name: /Nov 23, 2026: Alder, 8 interactions/ });
    await expect(mark).toHaveCount(1);
    await screenshot(page, "response-models-week");
    await expect(card.locator(".trends-limits")).toBeHidden();
    const readsBefore = reads.length;
    await card.getByRole("button", { name: "Lines", exact: true }).click();
    await card.getByRole("button", { name: "Percentage", exact: true }).click();
    await card.getByRole("button", { name: /Nov 23, 2026: Alder, 100%/ }).press("Enter");
    await expect(card.getByRole("button", { name: "View 9 calls" })).toBeVisible();
    await card.getByRole("checkbox", { name: "Show Alder" }).uncheck();
    await page.setViewportSize({ width: 390, height: 844 }); await chooseTheme(page, "dark");
    await daily.press("Enter");
    const sheet = page.getByRole("dialog"), row = sheet.getByRole("row", { name: /Nov 23, 2026/ });
    await expect(row).toContainText("100% (8)");
    const partial = row.getByRole("button", { name: /Partial model history: 3 interactions/ });
    await partial.focus();
    const headerGeometry = await sheet.getByRole("columnheader", { name: "Partial model history (interactions)" }).evaluate(node => {
        const clip = node.closest(".trends-exact").getBoundingClientRect();
        const date = node.parentElement.firstElementChild.getBoundingClientRect(), text = document.createRange();
        text.selectNodeContents(node);
        return { left: date.right, right: clip.right,
            lines: [...text.getClientRects()].filter(rect => rect.width && rect.height).map(rect => ({ left: rect.left, right: rect.right })) };
    });
    assert.ok(headerGeometry.lines.every(rect => rect.left >= headerGeometry.left - 1 && rect.right <= headerGeometry.right + 1),
        `The focused model-history count keeps its whole column heading readable beside the sticky date: ${JSON.stringify(headerGeometry)}`);
    await screenshot(page, "response-models-detail-narrow"); await page.keyboard.press("Enter");
    const links = sheet.getByRole("link");
    await expect(links).toHaveCount(4);
    for (const [i, count] of [[0, 2], [1, 1], [2, 1]]) await expect(links.filter({ hasText: `Review harbor note ${i}.` })).toHaveCount(count);
    await links.filter({ hasText: "Review harbor note 0." }).first().press("Enter");
    await expect(page.locator("#requestContent .model-identity").first()).toHaveText("Alder");
    await expect(page.locator("#requestContent")).toContainText("the final response boundary was not verified");
    await page.goBack(); await expect(daily).toBeFocused();
    await daily.press("Enter"); await partial.press("Enter");
    await expect(links.filter({ hasText: "Review harbor note 0." }).first()).toBeFocused();
    await sheet.getByRole("button", { name: "Back to daily values" }).press("Enter"); await expect(partial).toBeFocused();
    await page.keyboard.press("Escape"); await expect(daily).toBeFocused();
    await expect(card.getByRole("checkbox", { name: "Show Alder" })).not.toBeChecked();
    await page.getByRole("button", { name: "Show or hide charts" }).click();
    await page.getByRole("button", { name: "Open all charts" }).click();
    await page.getByRole("button", { name: "Maximize Response models" }).click();
    await expect(card.locator(".trends-limits")).toBeHidden();
    await card.getByRole("button", { name: "View numbers" }).click();
    const expanded = page.getByRole("region", { name: "Daily exact values" }).getByRole("button", { name: /Partial model history: 3 interactions/ });
    await expanded.press("Enter"); await expect(sheet.getByRole("link")).toHaveCount(4);
    await sheet.getByRole("button", { name: "Back to daily values" }).press("Enter"); await expect(expanded).toBeFocused();
    assert.equal(reads.length, readsBefore);
});

test("model records without a verified name stay inspectable without plotting models from another week", async t => {
    const records = callsFixture();
    const priorWeek = structuredClone(records[0]);
    for (const call of priorWeek.toolCalls) {
        call.startedAt = "2026-11-01T12:00:00Z"; call.startEventId += "-prior"; call.toolCallId += "-prior";
    }
    priorWeek.scenarioId += "-prior"; priorWeek.sourceSessionId += "-prior";
    priorWeek.originalModelEvidence.sourceSessionId = priorWeek.sourceSessionId;
    records[0].originalModelEvidence.conflict = true;
    records[1].originalModelEvidence.ambiguous = true;
    const { page, index } = await setup(t, false, { records: [...records, priorWeek] });
    await index.getByRole("button", { name: "Response models" }).click();
    const card = panelOf(page, "models"), sheet = page.getByRole("dialog");
    await expect(card.locator(".trends-plot")).toBeHidden();
    await expect(card.locator(".trends-no-activity")).toContainText("No verified response models");
    await card.getByRole("button", { name: "View daily values" }).click();
    for (const [label, prompt, calls] of [["Conflicting model records", "mon-a", 2], ["Model not verified", "mon-b", 1], ["No model recorded", "wed-c", 1]]) {
        await sheet.getByRole("button", { name: `${label}: 1 interaction, entire period` }).click();
        await expect(sheet.getByRole("link")).toHaveCount(calls);
        await expect(sheet.getByRole("link").filter({ hasText: `Review the invented harbor notes ${prompt}.` })).toHaveCount(calls);
        await sheet.getByRole("button", { name: "Back to daily values" }).click();
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show or hide charts" }).click();
    await page.getByRole("button", { name: "Open all charts" }).click();
    await expect(card.locator(".trends-plot")).toBeHidden();
    await expect(card.locator(".trends-no-activity")).toContainText("No verified response models");
});

test("daily tokens distinguish zero and missing, and lead back to the contributing interaction", async t => {
    const records = callsFixture();
    const unmetered = fixture("chart-no-token-count");
    unmetered.toolCalls[0].startedAt = records[0].toolCalls[0].startedAt;
    unmetered.userPrompt = {...records[0].userPrompt,text:"Review the unmetered harbor note.",sourceEventId:"unmetered-prompt"};
    records.push(unmetered);
    for (const [sample,total] of [[records[0],3200],[records[1],800],[records[2],0]]) {
        sample.usageCalls = [{receiptId:`receipt-${total}`,apiCallId:`call-${total}`,model:"gpt-4.1",at:sample.userPrompt.sourceTimestamp,
            tokens:{freshInput:total,cacheRead:0,cacheWrite:0,output:0}}];
    }
    const {page,index} = await setup(t,false,{records});
    await index.getByRole("button",{name:"Token usage"}).click();
    const card = panelOf(page,"usage");
    await expect(card.locator(".trends-heading")).toContainText("4,000 tokens · 3 of 4 interactions metered");
    await expect(card).not.toContainText("input read from cache",{ignoreCase:true});
    const point = card.locator(".trends-plot").getByRole("button",{name:/Nov 16.*4,000 tokens/});
    await point.press("Enter");
    await expect(card.locator(".trends-point")).toContainText("2 of 3 interactions metered");
    await screenshot(page,"token-day");
    const calls = card.getByRole("button",{name:"View 3 calls"});
    await calls.click();
    const links = page.getByRole("dialog").locator(".trends-evidence-row a");
    await expect(links).toHaveCount(3);
    const firstInteraction = links.filter({hasText:"Review the invented harbor notes mon-a."});
    await expect(firstInteraction).toHaveCount(2);
    await expect(links.filter({hasText:"Review the invented harbor notes mon-b."})).toHaveCount(1);
    await firstInteraction.last().click();
    await expect(page.locator("[data-reader-section=usage]:visible")).toContainText("3,200 tokens");
    await page.goBack(); await expect(calls).toBeFocused(); await expect(point).toHaveAttribute("aria-pressed","true");
    await card.getByRole("button",{name:"View daily values"}).click();
    const rows = page.getByRole("dialog",{name:"Daily values"}).getByRole("row");
    await expect(page.getByRole("dialog",{name:"Daily values"})).toContainText("Input read from cache this period: 0%");
    await expect(rows.filter({hasText:"Nov 16, 2026"}).getByRole("cell")).toHaveText(["4,000 tokens","2 of 3","3","4"]);
    await expect(rows.filter({hasText:"Nov 17, 2026"})).toContainText("No matching calls");
    await expect(rows.filter({hasText:"Nov 18, 2026"})).toContainText("0 tokens");
});

test("unmetered work remains visible and opens its own interaction across historical token days", async t => {
    const records=callsFixture(), measured=records[0];
    measured.toolCalls.push({...measured.toolCalls[0],toolCallId:"later-call",startEventId:"later-start",completionEventId:"later-end",
        startedAt:"2026-11-17T12:15:00Z",completedAt:"2026-11-17T12:15:00.180Z"});
    measured.usageCalls=[{receiptId:"invented-reading",apiCallId:"model-read",model:"gpt-4.1",at:measured.userPrompt.sourceTimestamp,
        tokens:{freshInput:3200,cacheRead:0,cacheWrite:0,output:0}}];
    const {page,index}=await setup(t,true,{records});
    await index.getByRole("button",{name:"Token usage"}).click();
    const card=panelOf(page,"usage"), plot=card.locator(".trends-plot"), pinned=card.locator(".trends-point");
    const days=plot.locator("[data-trend-mark]"), dates=page.locator("#trendsPeriod");
    const accepted=await dates.innerText();
    await expect(card.getByRole("button",{name:"Lines",exact:true})).toHaveAttribute("aria-pressed","true");
    for(const type of ["Columns","Lines"]) {
        await card.getByRole("button",{name:type,exact:true}).click();
        await expect(days.nth(4)).toHaveAccessibleName(/Nov 16.*3,200 tokens/);
        await expect(days.nth(3)).toHaveAccessibleName(/Nov 15.*No matching calls/i);
        await expect(days.nth(5)).toHaveAccessibleName(/Nov 17.*earlier day/i);
        await expect(days.nth(6)).toHaveAccessibleName(/Nov 18.*No token count/i);
        assert.equal(await days.nth(3).locator("text").count(),0,"Leave the no-activity day blank");
        await expect(days.nth(6).locator("text")).toBeVisible();
    }
    await days.nth(6).press("Enter"); await expect(pinned).toContainText("No token count");
    const open=pinned.getByRole("button",{name:"View 1 call",exact:true});
    await open.click();const sheet=page.getByRole("dialog");
    await expect(sheet.locator(".trends-evidence-row a")).toHaveCount(1);
    await sheet.getByRole("link",{name:/wed-c/}).click();
    await expect(page.locator("[data-reader-section=usage]:visible")).toContainText(/No token counts/);
    await page.goBack();await expect(open).toBeFocused();await expect(days.nth(6)).toHaveAttribute("aria-pressed","true");
    await days.nth(5).press("Enter");await expect(pinned).toContainText("Interaction counted on an earlier day");
    await open.click();await expect(sheet).toContainText("counted on an earlier date");await expect(sheet.locator(".trends-evidence-row a")).toHaveCount(1);
    await sheet.getByRole("link",{name:/mon-a/}).click();await expect(page.locator("[data-reader-section=usage]:visible")).toContainText("3,200 tokens");
    await page.goBack();await expect(open).toBeFocused();
    await days.nth(3).press("Enter");await expect(pinned).toContainText("No matching calls");await expect(pinned.getByRole("button")).toHaveCount(0);
    await card.getByRole("button",{name:"View daily values"}).click();
    const rows=sheet.getByRole("row");await expect(rows.filter({hasText:"Nov 15, 2026"})).toContainText("No matching calls");
    await expect(rows.filter({hasText:"Nov 17, 2026"})).toContainText("Interaction counted on an earlier day");
    await expect(rows.filter({hasText:"Nov 18, 2026"})).toContainText("No token count");
    await page.keyboard.press("Escape");
    const filters=page.locator("#trendsView .filter-entry");await filters.click();await selectActivityOption(page,"trendsService","Calendar");
    await page.getByRole("button",{name:"Apply filters"}).click();await expect(card.locator(".trends-no-activity")).toContainText("0 of 1 interaction metered");
    const unmetered=card.locator(".trends-no-activity").getByRole("button",{name:"View 1 call",exact:true});
    await unmetered.click();await sheet.getByRole("link",{name:/wed-c/}).click();await page.goBack();
    await expect(unmetered).toBeFocused();await expect(filters).toHaveText("1 filter applied");assert.equal(await dates.innerText(),accepted);
});

test("a clipped token chart initially includes the measured day, not just a busier unmetered week", async t => {
    const records=callsFixture(), measured=records.pop(), date="2026-10-24";
    measured.toolCalls[0].startedAt=`${date}T12:15:00Z`;
    measured.userPrompt.sourceTimestamp=measured.toolCalls[0].startedAt;
    measured.usageCalls=[{receiptId:"old-reading",apiCallId:"old-model",model:"gpt-4.1",at:measured.userPrompt.sourceTimestamp,
        tokens:{freshInput:200000,cacheRead:0,cacheWrite:0,output:0}}];
    const {page,index}=await setup(t,true,{records:[measured,...records]});
    await page.setViewportSize({width:390,height:844});await index.getByRole("button",{name:"Token usage"}).tap();
    await page.locator("#trendsPeriod").tap();await page.getByRole("button",{name:"Last 30 days",exact:true}).tap();
    const card=panelOf(page,"usage"), plot=card.locator(".trends-plot");
    await expect(plot.locator("[data-date-tick]")).toHaveCount(30);
    const seen=await plot.evaluate(n=>{
        const point=n.querySelector('[aria-label*="200,000 tokens"] circle').getBoundingClientRect();
        return point.left>=n.querySelector(".trends-y-axis rect").getBoundingClientRect().right && point.right<=n.getBoundingClientRect().right;
    });
    assert(seen,"The earlier measured point is within the visible date window");
    await card.getByRole("button",{name:"View daily values"}).tap();await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(31);
});

test("five-digit daily durations clear neighboring columns and reconcile across gaps and date changes", async t => {
    const values=[...Array(8).fill(9000),11184,...Array(7).fill(24000),90308];
    const records=[...values.map(ms=>[23,ms]),[17,null],[12,0]].map(([day,ms],i)=>{
        const r=fixture(`duration-day-${i}`),stamp=`2026-11-${day}T12:00:00Z`;
        Object.assign(r.toolCalls[0],{startedAt:stamp,durationMs:ms,completedAt:ms===null?null:new Date(Date.parse(stamp)+ms).toISOString(),
            completionEventId:ms===null?null:`timed-end-${i}`});
        return r;
    });
    const {page,index}=await setup(t,true,{records,now:"2026-11-24T18:00:00Z"});
    await page.setViewportSize({width:1600,height:900});await chooseTheme(page,"dark");
    await index.getByRole("button",{name:"Call duration"}).click();
    const card=panelOf(page,"timing"),plot=card.locator(".trends-plot"), table=page.getByRole("dialog",{name:"Daily values"});
    const read=card.getByRole("button",{name:"View daily values",exact:true});
    const label=plot.getByRole("button",{name:/Nov 23, 2026: Median, 11,184 ms/}).locator("text");
    await expect(label).toBeVisible();
    await screenshot(page,"duration-11184-columns");
    assert.deepEqual(await plot.evaluate(obscuredValues),[]);
    await expect(plot.getByRole("button",{name:/Nov 23, 2026: 95th percentile, 90,308 ms/}).locator("text")).toBeVisible();
    await page.setViewportSize({width:390,height:844});await chooseTheme(page,"light");
    await page.evaluate(()=>document.documentElement.style.fontSize="200%");
    await plot.locator('[data-trend-mark][data-series=timing]').nth(5).press("Enter");
    await expect(card.locator(".trends-point")).toContainText("11,184 ms");
    assert.deepEqual(await plot.evaluate(obscuredValues),[]);
    await screenshot(page,"duration-11184-narrow");
    await page.evaluate(()=>document.documentElement.style.removeProperty("font-size"));
    await page.setViewportSize({width:1600,height:900});await chooseTheme(page,"dark");
    await read.click();
    await expect(table.getByRole("row",{name:/Nov 23, 2026/})).toContainText("11,184 ms");
    await expect(table.getByRole("row",{name:/Nov 23, 2026/})).toContainText("90,308 ms");
    await page.keyboard.press("Escape");
    await card.getByRole("button",{name:"Lines",exact:true}).click();
    await expect(plot.locator("[data-trend-line]")).toHaveCount(0);
    await expect(plot.getByRole("button",{name:/Nov 22, 2026: Median, No matching calls/i})).toHaveCount(1);
    await screenshot(page,"duration-11184-lines");
    await page.locator("#trendsPeriod").click();await page.getByRole("button",{name:"Last 14 days"}).click();
    const earlier=plot.getByRole("button",{name:/Nov 12, 2026: Median, 0 ms/});
    await expect(earlier).toBeVisible();
    await expect(plot.getByRole("button",{name:/Nov 17, 2026: Median, No recorded duration/i})).toHaveCount(1);
    await read.click();
    await expect(table.getByRole("row",{name:/Nov 12, 2026/}).getByRole("cell")).toHaveText(["0 ms","0 ms","1","1","1"]);
    await expect(table.getByRole("row",{name:/Nov 17, 2026/}).getByRole("cell")).toHaveText(["No recorded duration","No recorded duration","0","1","1"]);
    await expect(table.getByRole("row",{name:/Nov 22, 2026/}).getByRole("cell")).toHaveText(["No matching calls","No matching calls","0","0","0"]);
});

test("service columns share their card surface and group sparse readings over their date", async t => {
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
    for (const name of ["Mail","Files"]) await expect(plot.getByRole("button",{name:`Nov 16, 2026: ${name}, 2 calls`})).toHaveText("2");
    await expect(plot.getByText("0",{exact:true})).toHaveCount(6); // Five all-zero days and the scale origin.
    await expect(plot.locator("[data-trend-mark]")).toHaveCount(21);
    await plot.getByRole("button",{name:"Nov 16, 2026: Mail, 2 calls"}).tap();
    await expect(card.getByRole("button",{name:"View daily values"}).locator('[data-icon-role="forward"]')).toBeVisible();
    await expect(card.getByRole("button",{name:"View 2 calls"}).locator('[data-icon-role="forward"]')).toBeVisible();
    await card.getByRole("button",{name:"View 2 calls"}).click();
    await expect(page.locator(".trends-evidence-row")).toHaveCount(2);
});

test("three nonzero services out of eight form one labeled date group", async t => {
    const targets = ["/me/messages","/me/calendarView",...Array(13).fill("/search/query"),"/unclassified","/unclassified"];
    const history = ["/me/drive/root","/me/onlineMeetings","/users/{id}/presence","/planner/plans","/groups"];
    const records = [...targets,...history].map((target,i) => {
        const r = fixture(`sparse-service-${i}`), stamp = `2026-11-${i < targets.length ? "23" : "10"}T12:00:00Z`;
        const paths = i === 0 ? [target,"/unclassified"] : [target];
        Object.assign(r.toolCalls[0],{startedAt:stamp,requestedApiPath:paths.length===1 ? target : null,requestArgs:{entityUrls:paths},
            apiResults:paths.map((path,index)=>({index,path,statusCode:200}))});
        return r;
    });
    const {page,index} = await setup(t,true,{records,now:"2026-11-24T19:00:00Z"});
    await page.setViewportSize({width:1440,height:900});
    await index.getByRole("button",{name:"Services",exact:true}).click();
    const card=panelOf(page,"services"), plot=card.locator(".trends-plot");
    await expect(card.locator(".trends-index-scope")).toContainText("17 dated calls in this period · Service names incomplete for 3 calls");
    await expect(card.locator(".trends-series")).toHaveCount(8);
    await expect(plot.locator("[data-trend-bar]")).toHaveCount(3);
    const bars = plot.locator('[data-trend-mark]:has([data-trend-bar])');
    await screenshot(page,"three-of-eight-services");
    const group = () => plot.evaluate(n => {
        const bars = [...n.querySelectorAll("[data-trend-bar]")].map(b=>b.getBoundingClientRect());
        const tick = n.querySelector('[data-date-tick="2026-11-23"]').getBoundingClientRect();
        return {offset:(bars[0].left+bars.at(-1).right-tick.left-tick.right)/2,
            gaps:bars.slice(1).map((box,i)=>box.left-bars[i].right),overflow:n.scrollWidth-n.clientWidth};
    });
    let geometry = await group();
    assert(Math.abs(geometry.offset)<1 && geometry.gaps.every(gap => gap>0 && gap<=8) && geometry.overflow===0,JSON.stringify(geometry));
    await expect(bars).toHaveText(["1","1","13"]);
    const labelsCentered=await bars.evaluateAll(marks=>marks.every(mark=>{
        const r=mark.querySelector("rect").getBoundingClientRect(), t=mark.querySelector("text").getBoundingClientRect();
        return Math.abs((r.left+r.right-t.left-t.right)/2)<1 && t.bottom<=r.top+1;
    }));
    assert(labelsCentered,"Each visible number sits immediately above its own column");
    const calendar = plot.getByRole("button",{name:"Nov 23, 2026: Calendar, 1 call"});
    const zero = plot.getByRole("button",{name:"Nov 23, 2026: Files, 0 calls"});
    await zero.press("Enter");
    await expect(card.locator(".trends-point")).toContainText("Files · 0 calls");
    await calendar.locator("rect").tap();
    await expect(card.locator(".trends-point")).toContainText("Calendar");
    await expect(card.getByRole("button",{name:"View 1 call",exact:true})).toBeVisible();
    const zeroDay = plot.locator('[data-trend-mark][aria-label^="Nov 22, 2026:"]').first().locator("text");
    await zeroDay.tap();
    const firstZero = await plot.locator('[aria-pressed="true"]').getAttribute("aria-label");
    await zeroDay.tap();
    const nextZero = await plot.locator('[aria-pressed="true"]').getAttribute("aria-label");
    assert.match(firstZero,/Nov 22, 2026:.+, 0 calls/); assert.match(nextZero,/Nov 22, 2026:.+, 0 calls/);
    assert.notEqual(firstZero,nextZero);
    await calendar.locator("rect").tap();
    await card.getByRole("checkbox",{name:"Show Mail",exact:true}).uncheck();
    geometry = await group(); assert(Math.abs(geometry.offset)<1 && geometry.overflow===0,JSON.stringify(geometry));
    await expect(calendar).toHaveAttribute("aria-pressed","true");
    await card.getByRole("button",{name:"Lines",exact:true}).click();
    await expect(calendar).toHaveAttribute("aria-pressed","true");
    await card.getByRole("button",{name:"View daily values"}).click();
    const row=page.getByRole("dialog",{name:"Daily values"}).getByRole("row",{name:/Nov 23, 2026/});
    await expect(row.getByRole("cell")).toHaveText(["1","1","0","0","0","0","0","13","17","17"]);
    await page.keyboard.press("Escape"); await card.getByRole("button",{name:"Percentage",exact:true}).click();
    await card.getByRole("button",{name:"Columns",exact:true}).click();
    const search=plot.getByRole("button",{name:/Nov 23, 2026: Search and retrieval, 76\.5%/});
    await search.focus();await expect(page.locator("#trendsTooltip")).toContainText("13 of 17 calls");
    await page.keyboard.press("Escape");await screenshot(page,"percentage-with-mail-hidden");
    const filters=page.locator("#trendsView .filter-entry");
    await filters.click();await selectActivityOption(page,"trendsService","Calendar");
    await page.getByRole("button",{name:"Apply filters",exact:true}).click();
    const only=plot.getByRole("button",{name:"Nov 23, 2026: Calendar, 100%"});
    await expect(only.locator("rect")).toBeVisible();await expect(bars).toHaveCount(1);
    await expect(card.locator(".trends-index-scope")).toContainText("1 dated call in this period");
    await expect(card.locator(".trends-index-scope")).toContainText("Service: Calendar");
    await expect(plot.getByRole("button",{name:/Nov 24, 2026: Calendar, Unavailable/})).toHaveCount(1);
    assert(Math.abs((await group()).offset)<1);
    await page.setViewportSize({width:390,height:844});await chooseTheme(page,"dark");
    await only.locator("rect").tap();await expect(page.locator("#trendsTooltip")).toContainText("1 of 1 call");
    await screenshot(page,"calendar-filtered-touch");
    await card.getByRole("button",{name:"View 1 call",exact:true}).click();
    await expect(page.locator(".trends-evidence-row a")).toHaveCount(1);await page.keyboard.press("Escape");
    await filters.click();await page.getByRole("button",{name:"Clear filters",exact:true}).click();
    await expect(bars).toHaveCount(2);await expect(card.getByRole("checkbox",{name:"Show Mail",exact:true})).not.toBeChecked();
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
    // Reading a point keeps View chart reachable and the line at its resting width.
    await page.setViewportSize({width:1440,height:1100});
    await expect.poll(()=>landing.locator(".trends-plot svg").evaluate(svg=>svg.getBoundingClientRect().width)).toBeGreaterThan(600);
    const viewChart=landing.getByRole("link",{name:/View chart/}).or(landing.getByRole("button",{name:/View chart/})).first();
    const strokes=()=>landing.locator("[data-trend-line]").evaluateAll(ns=>[...new Set(ns.map(n=>getComputedStyle(n).strokeWidth))]);
    const resting=await strokes();
    const window=await landing.locator(".trends-plot").boundingBox();
    for (const mark of await landing.locator("[data-trend-mark]:not([aria-label*='no matching dated calls'])").all()) {
        const at=await mark.boundingBox();
        if (!at || at.x < window.x + 40 || at.x + at.width > window.x + window.width) continue; // scrolled behind the axis or out of view
        await page.mouse.move(0,0); await expect(page.locator("#trendsTooltip")).toBeHidden(); await mark.hover();
        await expect(page.locator("#trendsTooltip"),await mark.getAttribute("aria-label")).toBeVisible();
        const [tip,link]=[await page.locator("#trendsTooltip").boundingBox(),await viewChart.boundingBox()];
        const overlap=Math.max(0,Math.min(tip.x+tip.width,link.x+link.width)-Math.max(tip.x,link.x))*Math.max(0,Math.min(tip.y+tip.height,link.y+link.height)-Math.max(tip.y,link.y));
        assert.equal(overlap,0,`${await mark.getAttribute("aria-label")}: reading covers View chart`);
        assert.deepEqual(await strokes(),resting);
    }
    await page.mouse.move(0,0); await page.setViewportSize({width:1280,height:800});
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
            await expect(card.locator(".trends-index-scope")).toContainText(`${expected[value]} dated ${expected[value] === 1 ? "call" : "calls"} in this period`);
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
    await card.getByRole("button", { name: "View daily values" }).click();
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
            if (width === 390) await page.waitForFunction(()=>getComputedStyle(document.querySelector("#appUpdateNotice")).display==="none");
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
            const anchor = await plot.evaluate(n=>({same:window.periodProbe.svg===n.firstElementChild,move:n.getBoundingClientRect().top-window.periodProbe.top,scroll:scrollY-window.periodProbe.scroll}));
            assert(anchor.same && Math.abs(anchor.move)<1 && !anchor.scroll,JSON.stringify({width,scale,...anchor}));
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
    const records = callsFixture();
    records[0].usageCalls = [{receiptId:"fixture-usage",apiCallId:"fixture-model-call",model:"gpt-4.1",at:records[0].userPrompt.sourceTimestamp,
        tokens:{freshInput:3000,cacheRead:200,cacheWrite:0,output:0}}];
    const { page, index, reads } = await setup(t,false,{records});
    const names = { problems: "Errors & failures", rhythm: "Tool calls", tools: "Tool usage", services: "Services", timing: "Call duration", authors: "Prompt authors", models: "Response models", usage:"Token usage" };
    const series = { problems: 1, rhythm: 1, tools: 2, services: 3, timing: 2, authors: 3, models: 2, usage:1 };
    // Hand-counted from the three source prompts above, not the Trends response.
    // Monday's Mail+Files call counts for both; its unrecorded third duration does not count as zero.
    const daily = {
        problems:[["1"],["1"]],rhythm:[["3"],["1"]],tools:[["2","1"],["1","0"]],
        services:[["2","0","2"],["0","1","0"]],timing:[["0 ms","180 ms","2"],["840 ms","840 ms","1"]],
        authors:[["1","1","0"],["0","0","1"]],models:[["2","1"],["0","0"]],
        usage:[["3,200 tokens","1 of 2"],["No token count available","0 of 1"]],
    };
    const counts = {
        problems:[1,1],rhythm:[3,1],tools:[2,1,1,0],services:[2,0,2,0,1,0],
        authors:[1,1,0,0,0,1],models:[2,1,0,0],timing:[0,180,840,840],usage:[3200],
    };
    const percentages={problems:[50,100],rhythm:[75,25],tools:[66.7,33.3,100,0],
        services:[66.7,0,66.7,0,100,0],authors:[50,50,0,0,0,100],models:[100,50,0,0]};
    const initial = reads.length;
    for (const [id, label] of Object.entries(names)) {
        await index.getByRole("button", { name: label, exact: true }).click(); const panel = panelOf(page, id);
        await expect(panel).toBeVisible(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
        await expect(panel.locator("[data-trend-mark]")).toHaveCount(7 * series[id]);
        const names = await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label")));
        await panel.getByRole("button",{name:"Columns",exact:true}).click();
        await screenshot(page, `measure-${id}-columns`);
        const markText=await panel.locator(".trends-plot [data-trend-mark]").evaluateAll(nodes=>nodes.filter(n=>/Nov (16|18), 2026:/.test(n.getAttribute("aria-label")))
            .flatMap(n=>{const m=n.getAttribute("aria-label").match(/, ([\d,]+) (?:calls?|interactions?|ms|tokens?)$/); return m?[Number(m[1].replaceAll(",",""))]:[];}));
        assert.deepEqual(markText,counts[id],`${label}: dated mark values from the source fixture`);
        assert.deepEqual(await panel.locator(".trends-plot").evaluate(obscuredValues),[],`${label} column values`);
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
        await screenshot(page, `measure-${id}-lines`);
        assert.deepEqual(await panel.locator("[data-trend-mark]").evaluateAll(ns => ns.map(n => n.getAttribute("aria-label"))), names);
        await panel.getByRole("button", { name: "Columns", exact: true }).click();
        if (id !== "timing" && id !== "usage") {
            await panel.getByRole("button", { name: id === "rhythm" ? "Share within week" : "Percentage", exact: true }).click();
            const shares=await panel.locator("[data-trend-mark]").evaluateAll(nodes=>nodes.filter(n=>/Nov (16|18), 2026:/.test(n.getAttribute("aria-label")))
                .map(n=>Number(n.getAttribute("aria-label").match(/, ([\d.]+)%$/)[1])));
            assert.deepEqual(shares,percentages[id],`${label}: daily denominators`);
            await screenshot(page, `share-${id}-columns`);
            assert.deepEqual(await panel.locator(".trends-plot").evaluate(obscuredValues),[],`${label} percentage values`);
            await panel.getByRole("button", { name: "Lines", exact: true }).click();
            await screenshot(page, `share-${id}-lines`);
            await panel.getByRole("button", { name: "Columns", exact: true }).click();
            await panel.getByRole("button", { name: "Count", exact: true }).click();
        }
        for (const check of await panel.locator(".trends-series input").all()) { await check.uncheck(); await expect(check).not.toBeChecked(); }
        if (series[id] > 1) {
            await expect(panel.locator(".trends-plot svg")).toHaveCount(0);
            await expect(panel.locator(".trends-chart-empty")).toHaveText("Choose a series to show in the chart.");
        }
        for (const check of await panel.locator(".trends-series input").all()) await check.check();
        await panel.getByRole("button", { name: "View daily values", exact: true }).click();
        const table = page.locator(".trends-dialog table"); await expect(table.locator("tbody tr")).toHaveCount(8);
        const monday = table.locator("tbody tr").filter({ hasText: "Nov 16" });
        await expect(monday.getByRole("cell")).toHaveText([...daily[id][0],"2","3",...(id === "models" ? ["0"] : [])]);
        await expect(table.getByRole("row",{name:/Nov 18, 2026/}).getByRole("cell")).toHaveText([...daily[id][1],"1","1",...(id === "models" ? ["1"] : [])]);
        if (id === "models") {
            await table.getByRole("button", { name: "No model recorded: 1 interaction, entire period" }).click();
            const sheet = page.getByRole("dialog"); await expect(sheet.getByRole("link")).toHaveCount(1);
            await expect(sheet.getByRole("link")).toContainText("Review the invented harbor notes wed-c.");
            await sheet.getByRole("button", { name: "Back to daily values" }).click();
        }
        const empty = id==="timing" ? ["No matching calls","No matching calls","0"] : id==="usage" ? ["No matching calls","0 of 0"] : Array(series[id]).fill("0");
        await expect(table.getByRole("row",{name:/Nov 17, 2026/}).getByRole("cell")).toHaveText([...empty,"0","0",...(id === "models" ? ["0"] : [])]);
        await page.keyboard.press("Escape"); await expect(panel.getByRole("button", { name: "View daily values" })).toBeFocused();
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
    const chooseCharts = page.getByRole("button", { name: "Show or hide charts" });
    await chooseCharts.click();
    const dialog = page.getByRole("dialog", { name: "Show or hide charts" }), choices = dialog.getByRole("checkbox");
    await dialog.getByRole("checkbox", { name: "Call duration", exact: true }).check();
    await dialog.getByRole("button", { name: "Cancel" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
    await chooseCharts.click();
    for (const check of await choices.all()) await check.check();
    await dialog.getByRole("button", { name: "Apply" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(8);
    await chooseCharts.click();
    for (const check of await choices.all()) await check.uncheck();
    await dialog.getByRole("button", { name: "Apply" }).click(); await expect(page.locator(".trends-panel:visible")).toHaveCount(1);
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
        if (width === 390) await page.waitForFunction(()=>getComputedStyle(document.querySelector("#appUpdateNotice")).display==="none");
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
        await choose(view,"Show or hide charts"); await view.getByRole("checkbox",{name:"Services",exact:true}).check();
        await choose(view,"Apply"); await expect(panelOf(page,"services")).toBeVisible();
        await expect(view.locator(".trends-panel:visible h2")).toHaveText(["Tool usage","Services"]);
        await expect(filters).toHaveText("Filters");
    }, {scene:true});
    await watch("remove comparison", async () => {
        await choose(view,"Show or hide charts"); await view.getByRole("checkbox",{name:"Services",exact:true}).uncheck();
        await choose(view,"Apply");
        await expect(view.locator(".trends-panel:visible h2")).toHaveText(["Tool usage"]);
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
        await navigateMain(page, "settings"); await expect(page.locator("#settingsView")).toBeVisible();
        await navigateSettings(page, "themes"); await page.locator(`.palette-option:has(#palette-${id})`).click();
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
            await expect(index.getByRole("button")).toHaveCount(8);
            const geometry = await page.locator(".trends-panel:visible").evaluate(panel => ({
                plot: panel.querySelector(".trends-plot").getBoundingClientRect().top,
                title: panel.querySelector("h2").getBoundingClientRect().top, focus: document.activeElement.tagName, y: scrollY, h: innerHeight,
            }));
            assert(geometry.plot < geometry.h, `${width}/${scale}/${label}: ${JSON.stringify(geometry)}`);
        }
        await screenshot(page, `product-narrow-${width}-${scale}`);
        if (scale === 2) {
            const duration = panelOf(page, "timing");
            await duration.getByRole("button", { name: "View daily values" }).tap();
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
        await view.getByRole("button",{name:"Show or hide charts"}).click();
        const row = view.getByRole("dialog").locator(".trends-compare-choices label").first(), check = row.locator("input");
        await states(row,`${id}/${mode} comparison unchecked`,check);
        await check.check(); await states(row,`${id}/${mode} comparison checked`,check);
        if (proof && id === "petrol") { await row.hover(); await screenshot(page,`compare-choice-${mode}`); }
        await page.keyboard.press("Escape");
      }
    if (proof) { await mkdir(proof,{recursive:true}); await writeFile(path.join(proof,"trends-choice-paint.json"),JSON.stringify(measured)); }
    assert.deepEqual(failures,[]);
});
