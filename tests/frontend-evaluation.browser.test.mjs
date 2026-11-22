import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { frontendRecords, reviewRecords, overviewGeometry } from "./frontend-fixture.mjs";
import { scanSourceForExport } from "../lib/privacy.mjs";
import { chooseTheme, navigateMain, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters, fulfillFixtureUpdateStatus } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { palettes } from "../web/theme.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_FRONTEND_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
async function setup(t, frontend = "react", records = frontendRecords()) {
    const cleanup = [], errors = [], requests = [];
    const app = await searchFixture({ after: work => cleanup.push(work) }, { records, reply: false, frontend });
    const before = await loadBoardState(app.context);
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "no-preference" });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => {
        window.frontendMeasurements = { acceptedViewMs: null, inputToFrameMs: null, queryToResultsMs: null, longTasks: [] };
        let queryAt = null;
        const observer = new MutationObserver(() => {
            const measured = window.frontendMeasurements;
            if (measured.acceptedViewMs === null && document.getElementById("workspace")?.getAttribute("aria-busy") === "false"
                && document.querySelector("#activityList .request-card-open")) measured.acceptedViewMs = performance.now();
            if (queryAt !== null && measured.queryToResultsMs === null && document.querySelector(".wire-search-hit")) {
                measured.queryToResultsMs = performance.now() - queryAt;
            }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        document.addEventListener("input", event => {
            if (event.target.id !== "wireSearch") return;
            const started = performance.now();
            queryAt = started;
            window.frontendMeasurements.queryToResultsMs = null;
            requestAnimationFrame(() => {
                if (queryAt === started) window.frontendMeasurements.inputToFrameMs = performance.now() - started;
            });
        }, { capture: true });
        if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
            new PerformanceObserver(list => window.frontendMeasurements.longTasks.push(
                ...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })),
            )).observe({ type: "longtask", buffered: true });
        }
    });
    page.on("pageerror", error => errors.push(error.message));
    const allowed = new Set(["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview",
        "/api/assessment/detail", "/api/evaluation/automatic/summary", "/api/search/events", "/api/search/query",
        "/api/search/open", "/api/search/cancel", "/api/search/close", "/api/period-comparison", "/api/trends",
        "/api/report-artifacts/list"]);
    await page.route("**/*", async route => {
        if (await fulfillFixtureUpdateStatus(route, new URL(app.runtime.url).origin)) return;
        const request = route.request(), url = new URL(request.url());
        const updateStatus = url.pathname === "/api/app-update" && request.method() === "POST" && request.postDataJSON()?.action === "status";
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname) && !updateStatus) {
            errors.push(`Unexpected request: ${url.pathname}`);
            return route.abort();
        }
        requests.push(url.pathname);
        return route.continue();
    });
    t.after(async () => {
        await browser.close();
        try {
            assert.deepEqual(await loadBoardState(app.context), before);
            assert.deepEqual(errors, []);
        } finally { for (const work of cleanup.reverse()) await work(); }
    });
    const response = await page.goto(app.runtime.url + "#analyze?range=custom&from=2026-11-10&to=2026-11-16");
    const htmlBytes = Buffer.byteLength(await response.text());
    await ready(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    await chooseTheme(page, "light");
    return { ...app, page, requests, htmlBytes, browserVersion: browser.version() };
}
async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
    await page.screenshot({ path: path.join(proofs, `${name}.png`) });
}

function compactCardRecords() {
    const source = reviewRecords();
    return [source.at(-1), source[0], source[1], source[5], source[7], source[12], source[17], source[23]].map((record, index) => {
        const stamp = `2026-11-16T${String(20 - index).padStart(2, "0")}:00:00.000Z`;
        record.capturedAt = stamp; record.userPrompt.sourceTimestamp = stamp;
        if (index === 5) record.userPrompt = { ...record.userPrompt, text: "", status: "unavailable" };
        for (const [ordinal, call] of record.toolCalls.entries()) call.startedAt = new Date(Date.parse(stamp) + ordinal * 5000).toISOString();
        return record;
    });
}

test("Analyze groups exact tool names and counts in static labels beside genuine reader links", async t => {
    const records = compactCardRecords();
    const [mixed, repeated, single, example] = records;
    const long = ["workiq-call_function", "workiq-update_entity"];
    for (const [i, name] of long.entries()) mixed.toolCalls.push({
        ...mixed.toolCalls[0], tool: name, toolCallId: `long-${i}`, startEventId: `start-long-${i}`, completionEventId: `end-long-${i}`,
    });
    repeated.toolCalls.push({ ...repeated.toolCalls[0], toolCallId: "second-read", startEventId: "start-second-read", completionEventId: "end-second-read" });
    const retrieve = records.flatMap(record => record.toolCalls).find(c => c.tool === "workiq-retrieve" && c.toolSucceeded);
    example.userPrompt.text = "Find the latest studio move checklist and tell me which packing tasks are still open.";
    example.toolCalls = [retrieve, retrieve, single.toolCalls[0]].map((call, i) => ({
        ...call, toolCallId: `checklist-${i}`, startEventId: `checklist-start-${i}`, completionEventId: `checklist-end-${i}`,
        startedAt: new Date(Date.parse(example.capturedAt) + i * 5000).toISOString(),
        completedAt: new Date(Date.parse(example.capturedAt) + i * 5000 + call.durationMs).toISOString(),
    }));
    const { page } = await setup(t, "react", records);
    const cards = page.locator("#activityList .activity-card");
    const report = process.env.WIRE_TOOL_GROUP_PROOFS;
    if (report) await mkdir(report, { recursive: true });
    const card = cards.filter({ hasText: example.userPrompt.text });
    const labels = card.getByRole("listitem");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 900 }); await chooseTheme(page, theme);
        await page.evaluate(n => document.documentElement.style.fontSize = `${n * 100}%`, scale);
        await expect(cards.first().locator(".card-tool-name")).toHaveText([...long, "workiq-fetch", "workiq-retrieve"]);
        await expect(labels).toHaveText(["workiq-retrieve (2 calls)", "workiq-fetch"]);
        assert.ok(await cards.locator(".card-tool-item").evaluateAll(items => items.every(item =>
            item.scrollWidth <= item.clientWidth && item.getBoundingClientRect().right <= item.closest("dd").getBoundingClientRect().right + 1)),
        `${theme}/${width}: names and counts fit within the value column`);
        if (report) {
            for (const [i, name] of ["multiple", "repeated", "single", "checklist"].entries()) {
                await cards.nth(i).screenshot({ path: path.join(report, `after-${name}-${theme}-${width}.png`) });
            }
            await card.evaluate(n => n.scrollIntoView({ block: "center" }));
            await page.screenshot({ path: path.join(report, `after-screen-${theme}-${width}.png`) });
        }
    }
    const toolList = cards.first().locator(".card-identities").getByRole("list");
    await expect(toolList.getByRole("listitem")).toHaveText([...long, "workiq-fetch (3 calls)", "workiq-retrieve"]);
    await expect(cards.nth(1).locator(".card-identities").getByRole("listitem")).toHaveCount(1);
    await expect(cards.nth(1).locator(".card-tool-count")).toHaveText("(2 calls)");
    await expect(cards.nth(2).locator(".card-tool-count")).toHaveCount(0);
    await expect(toolList.getByRole("listitem").first()).toHaveCSS("list-style-type", "none");
    await expect(cards.nth(1).locator(".card-tool-item")).toHaveCSS("list-style-type", "none");
    const label = labels.first(), name = label.locator(".card-tool-name"), url = page.url();
    const fill = await label.evaluate(n => getComputedStyle(n).backgroundColor);
    assert.notEqual(fill, "rgba(0, 0, 0, 0)");
    await name.hover();
    await expect(name).not.toHaveCSS("cursor", "pointer");
    await expect(label).toHaveCSS("background-color", fill);
    await name.click(); expect(page.url()).toBe(url);
    await expect(card.locator(".card-tool-list").getByRole("link")).toHaveCount(0);
    const panel = card.locator(".card-panel-link");
    await card.locator(".request-card-open").focus(); await page.keyboard.press("Tab");
    await expect(panel).toBeFocused();
    await expect(panel).toHaveCSS("outline-style", "solid");
    await panel.press("Enter");
    await expect(page.locator("#requestContent .reader-tool-name")).toHaveText(example.toolCalls.map(c => c.tool));
    await page.locator("#closeContextSidebar").press("Enter");
    await expect(panel).toBeFocused();
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page); await closeAnalyzeFilters(page);
    await expect(labels).toHaveText(["workiq-retrieve (2 results)", "workiq-fetch"]);
});

test("Analyze chart, controls and grouped interactions share the available workspace", { timeout: 60000 }, async t => {
    const records = reviewRecords();
    const { page } = await setup(t, "react", [records.at(-1), ...records.slice(0, 7)]);
    const list = page.locator("#activityList"), card = list.locator(".activity-card").first();
    const opener = card.locator(".card-panel-link"), measurements = [], failures = [];
    const captureDir = process.env.WIRE_ANALYZE_FRAME_PROOFS;
    if (captureDir) await mkdir(captureDir, { recursive: true });
    for (const state of ["wide", "narrow", "resized", "reader"]) {
        const narrow = state === "narrow";
        await page.setViewportSize({ width: narrow ? 390 : 1900, height: narrow ? 900 : 1080 });
        if (state === "resized") {
            await chooseTheme(page, "dark");
            const handle = page.locator(".navigation-resize");
            await handle.press("End");
            await expect(handle).toHaveAttribute("aria-valuenow", await handle.getAttribute("aria-valuemax"));
        }
        if (state === "reader") {
            await opener.press("Enter");
            await expect(page.locator("body")).toHaveAttribute("data-context-docked", /.*/);
            await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(4);
        }
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
        const value = await page.evaluate(() => {
            const el = selector => document.querySelector(selector);
            const edges = node => {
                const { left, right } = node.getBoundingClientRect();
                return [left, right];
            };
            const surface = node => {
                const s = getComputedStyle(node);
                return [s.borderTopLeftRadius, s.borderTopWidth, s.borderTopColor, s.backgroundColor, s.boxShadow];
            };
            const chart = el(".analyze-chart-grid"), list = el("#activityList"), rows = [...list.querySelectorAll(".activity-card")];
            const prompt = rows[0].querySelector(".card-request-context");
            return {
                frame: edges(el("#workspace")), chart: edges(chart), heading: edges(el("#workspace > .page-heading")),
                toolbar: edges(el("#analyzeToolbar")), filters: edges(el("#openAnalyzeFilters")),
                listHeading: edges(el("#activityListContext")), list: edges(list),
                rows: rows.map(edges), chartSurface: surface(chart), listSurface: surface(list),
                borders: rows.map(row => [getComputedStyle(row).borderTopWidth, getComputedStyle(row).borderBottomWidth].map(parseFloat)),
                rowShadows: rows.map(row => getComputedStyle(row).boxShadow),
                promptWidth: prompt.getBoundingClientRect().width, promptMeasure: parseFloat(getComputedStyle(prompt).maxWidth),
                contents: [...rows[0].querySelectorAll(".card-tool-item,.request-card-summary,.request-card-open,.card-evidence-link,.card-panel-link")].map(edges),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
        });
        measurements.push({ state, ...value });
        const check = (ok, label) => { if (!ok) failures.push(`${state}: ${label}`); };
        for (const key of ["chart", "heading", "listHeading", "list"]) {
            check(value[key].every((x, i) => Math.abs(x - value.frame[i]) <= 1), `${key} edges ${value[key]} vs ${value.frame}`);
        }
        check(Math.abs(value.toolbar[1] - value.chart[1]) <= 1, `toolbar right ${value.toolbar[1]} vs ${value.chart[1]}`);
        check(Math.abs(value.filters[1] - value.toolbar[1]) <= 1, "Filters ends the control row");
        check(value.rows.every(row => row.every((x, i) => Math.abs(x - value.frame[i]) <= 1)), "row edges");
        check(value.listSurface.every((x, i) => x === value.chartSurface[i]), "group corner, edge and surface");
        check(value.borders[0][0] === 0 && value.borders.at(-1)[1] === 0
            && value.borders.slice(1).every(([top], i) => value.borders[i][1] + top === 1), "only inter-row dividers");
        check(value.rowShadows.every(x => x === "none") && value.overflow <= 0, "flat rows, no page overflow");
        check(value.promptWidth <= value.promptMeasure + 1, "the excerpt keeps its inner reading measure");
        check(value.contents.every(([left, right]) => left >= value.list[0] && right <= value.list[1] && right > left),
            "tool labels, metadata and actions fit within the row");
        await expect(card.locator(".card-tool-item")).toHaveCount(2);
        await expect(card.locator(".card-identities")).toContainText("Mail");
        await expect(opener).toBeVisible();
        if (captureDir) {
            await page.screenshot({ path: path.join(captureDir, `${state}.png`) });
            if (state === "wide") {
                await list.locator(".activity-card").last().scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(captureDir, "list-end.png") });
            }
            if (narrow) {
                await page.locator("#activityListContext").evaluate(node => scrollBy(0,
                    node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 12));
                await page.screenshot({ path: path.join(captureDir, "narrow-list.png") });
            }
        }
        if (narrow) {
            const scroll = page.locator("#chart .dimensional-scroll");
            await scroll.press("ArrowRight");
            await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
        }
    }
    await page.locator("#closeContextSidebar").press("Enter");
    await expect(opener).toBeFocused();
    await expect(opener).toHaveCSS("outline-style", "solid");
    assert.ok(await opener.evaluate(node => {
        const outline = getComputedStyle(node), outset = parseFloat(outline.outlineWidth) + parseFloat(outline.outlineOffset);
        const ring = node.getBoundingClientRect(), group = node.closest("#activityList").getBoundingClientRect();
        return ring.left - outset >= group.left && ring.right + outset <= group.right
            && ring.top - outset >= group.top && ring.bottom + outset <= group.bottom;
    }), "the group does not clip the restored keyboard focus ring");
    if (captureDir) await writeFile(path.join(captureDir, "geometry.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("React and retained controls paint the same light outline from compact status to page heading", async t => {
    const { page } = await setup(t, "react", compactCardRecords());
    const selectors = [
        "#wireSearchHome [data-icon-role=search]", "#openAnalyzeFilters [data-icon-role=filter]",
        ".primary-navigation [data-icon-role=navigation-analyze]", "#pageTitle [data-icon-role=navigation-analyze]",
        "#activityList .card-outcome [data-icon-role]", "#activityList .service-cue [data-icon-role]",
    ];
    for (const selector of selectors) {
        const icon = page.locator(selector).first();
        await expect(icon).toBeVisible();
        const result = await icon.evaluate(svg => {
            const shape = svg.firstElementChild, style = getComputedStyle(shape);
            return { weight: parseFloat(style.strokeWidth), stroke: style.stroke, ink: getComputedStyle(svg).color,
                scale: svg.getScreenCTM().a, box: svg.viewBox.baseVal.width, size: svg.getBoundingClientRect().width };
        });
        assert.equal(result.stroke, result.ink, selector);
        assert.equal(result.box, 24, selector);
        assert.equal(result.weight, 1.5, selector);
        assert.ok(result.weight * result.scale >= 1, `${selector}: readable stroke at ${result.size}px`);
    }
});

test("completed status opens every counted call and no uncounted sibling", {timeout:60000}, async t => {
    const records=compactCardRecords(), group=records[0];
    for (const call of group.toolCalls) {
        call.toolSucceeded=true; call.reportedOutcome="succeeded"; delete call.failureEvidence;
    }
    const {page}=await setup(t,"react",records);
    const unknown=page.locator('#activityList [data-view-key="request:search-5"] .card-outcome');
    await expect(unknown).toContainText("No result recorded");await expect(unknown.locator("[data-icon-role=forward]")).toHaveCount(0);
    const card=page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    const link=card.locator(".card-orientation a.card-outcome");
    const activity=page.locator('#requestContent [data-reader-section=activity]');
    const list=activity.locator(".reader-call-row");
    if (proofs) {await mkdir(proofs,{recursive:true}); await card.screenshot({path:path.join(proofs,"completed-card.png")});}
    await expect(link).toHaveAccessibleName("4 tool calls completed",{timeout:1500});
    await expect(link.locator('[data-icon-role=forward]')).toBeVisible();
    await link.hover();const size=await link.boundingBox();await page.mouse.down();
    assert.deepEqual(await link.boundingBox(),size);
    await expect(link).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
    await page.mouse.up();
    async function check(ids) {
        await expect(activity.locator(".reader-section-heading")).toContainText(`${ids.length} completed ${ids.length===1?"call":"calls"}`);
        assert.deepEqual(await list.evaluateAll(ns=>ns.map(n=>n.dataset.toolCallId)),ids);
        assert.doesNotMatch(page.url(),/review-call|review-plural/);
        assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(history.state)),/review-call|review-plural/);
    }
    await check(group.toolCalls.map(c=>c.toolCallId));
    await page.goBack();await expect(link).toBeFocused();
    for(const [tool,wanted] of [["workiq-fetch",[0,2,3]],["workiq-retrieve",[1]]]) {
        await selectActivityOption(page,"toolFilter",tool);await ready(page);await closeAnalyzeFilters(page);
        await expect(link).toHaveText(`${wanted.length} tool ${wanted.length===1?"call":"calls"} completed`);
        await link.focus();await page.keyboard.press("Enter");
        await check(wanted.map(i=>group.toolCalls[i].toolCallId));
        await expect(activity).not.toContainText("The full recorded interaction follows");
        if(wanted.length===3)await expect(activity).not.toContainText("Call #2 (Search");
        if(proofs)await capture(page,`completed-reader-${wanted.length}`);
        if(wanted.length===3){
            await activity.getByRole("link",{name:"Show full activity"}).click();
            await expect(list).toHaveCount(4);
        }
        await page.goBack();await expect(link).toBeFocused();
        if(wanted.length===1) {
            await page.goForward();await check([group.toolCalls[1].toolCallId]);
            await page.goBack();await expect(link).toBeFocused();
        }
    }
    await chooseTheme(page,"dark");await page.setViewportSize({width:390,height:844});
    const cdp=await page.context().newCDPSession(page);
    try {
        await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
        await link.scrollIntoViewIfNeeded();const box=await link.boundingBox();
        await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
        await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
        await check([group.toolCalls[1].toolCallId]);
        await page.locator("#closeContextSidebar").click();await expect(link).toBeFocused();
    } finally {await cdp.detach();}
});

test("compact summaries name the scoped causes and open the full diagnostic in the exact reader", { timeout: 60000 }, async t => {
    const { page } = await setup(t, process.env.WIRE_TEST_FRONTEND ?? "react", compactCardRecords());
    const phase = process.env.WIRE_CARD_BASELINE ? "before" : "after";
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await page.screenshot({ path: path.join(proofs, `compact-${phase}-light-full.png`), fullPage: true });
    }
    const card = page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    const promptLink = card.locator(".request-card-open");
    await expect(card).toContainText("Review the Cedar handover");
    await expect(card.locator(".request-card-exception")).toHaveText(["1 tool call failed", /result: HTTP 403/]);
    await expect(card.locator(".card-tool-item").filter({hasText:"workiq-fetch"})).toHaveText("workiq-fetch (3 calls)");
    await expect(card.locator(".card-identities")).toContainText("Mail");
    await expect(card).not.toContainText(/Partial completion|No result recorded|Read more|More services/i);
    await expect(card.locator(".request-card-cause").filter({ hasText: "workiq-retrieve" })).toContainText("ToolUnavailable");
    await expect(card.locator(".request-card-cause").filter({ hasText: "returned entry 2" })).toContainText("AccessDenied");
    const timestampSize = await card.locator(".request-card-time").evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const reasons = await card.locator(".request-card-cause").evaluateAll(nodes => nodes.map(el => parseFloat(getComputedStyle(el).fontSize)));
    assert.ok(reasons.every(size => size > timestampSize), "Both failure explanations must read as body text, not timestamp captions.");
    await expect(card).not.toContainText(/Call #|Requested:|WIRE interpretation|flag alone|completion event|end time/);
    await expect(card.locator(".call-reason-list,[data-interpretation],.request-card-reasons")).toHaveCount(0);
    await expect(card.locator("button,input,details")).toHaveCount(0);
    await promptLink.focus(); await page.keyboard.press("Enter");
    const reader = page.locator("#requestContent");
    await expect(reader.locator(".reader-call-row")).toHaveCount(4);
    await expect(reader.locator(".reader-tool-name")).toHaveText(["workiq-fetch", "workiq-retrieve", "workiq-fetch", "workiq-fetch"]);
    await expect(reader).toContainText("AccessDenied");
    await expect(reader).toContainText("ToolUnavailable");
    await expect(reader).toContainText("WIRE interpretation");
    const partial = reader.locator('[data-tool-call-id="review-call-2"]').first();
    await expect(partial).toContainText("The call was saved as partial.");
    await expect(partial).toContainText("No completion event or end time is retained.");
    await expect(reader).toContainText("No path returned for this batch entry.");
    await expect(reader.getByRole("button", { name: /Copy/ }).first()).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(promptLink).toBeFocused();
    await page.locator('#outcomeChart li[data-category="partial"] a').click(); await ready(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(1);
    await expect(card.locator(".request-card-count")).toHaveText("1 of 4 Work IQ tool calls matches this view");
    await expect(card.locator(".request-card-exception")).toHaveText("Partial completion");
    await expect(card).not.toContainText(/WIRE interpretation|flag alone|Call #|Requested:/);
    await promptLink.click();
    await expect(reader.locator(".reader-call-row")).toHaveCount(4);
    await expect(partial).toContainText("The call was saved as partial.");
    await page.locator("#closeContextSidebar").click();
    await expect(promptLink).toBeFocused();
    await page.goBack(); await ready(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
    await page.locator("#wireSearch").fill("Cedar handover");
    const hit = page.locator('.wire-search-hit').filter({ hasText: "Review the Cedar handover" }).first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(reader).toContainText("AccessDenied");
    await expect(reader).toContainText("WIRE interpretation");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#wireSearch")).toHaveValue("Cedar handover");
});

test("heterogeneous summary cards stay readable in complete Light Dark narrow and enlarged compositions", { timeout: 60000 }, async t => {
    const { page } = await setup(t, "react", compactCardRecords());
    for (const [theme, width, scale] of [["light", 1440, 1], ["dark", 1440, 1], ["dark", 390, 1], ["light", 1024, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await chooseTheme(page, theme); await page.mouse.move(0, 0);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator("#activityList .request-card-open")).toHaveCount(8);
        await expect(page.locator("#activityList")).not.toContainText(/WIRE interpretation|The call was saved as partial|Requested:|ToolUnavailable/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (proofs) {
            await page.screenshot({ path: path.join(proofs, `compact-after-${theme}-${width}-text${scale}-full.png`), fullPage: true });
            const first = page.locator("#activityList .activity-card").first();
            await first.screenshot({ path: path.join(proofs, `recognition-${theme}-${width}-text${scale}-row.png`) });
            await first.scrollIntoViewIfNeeded();
            await capture(page, `compact-after-${theme}-${width}-text${scale}-reading`);
        }
    }
});

test("wrapped card identities keep their value edge, named counts and distinct origin and failure cues", { timeout: 90000 }, async t => {
    const records = compactCardRecords(), mixed = records[0], failed = mixed.toolCalls[1];
    records[1].userPrompt.status = "partial";
    records[1].userPrompt.text = "Review this reference:\n\n> https://example.invalid/" + "workshop-notes/".repeat(90);
    records[2].userPrompt.authorship = { actor: "unknown", basis: "missing-source" };
    records[2].toolCalls[0].apiResults = [{ index: 0, path: "/me/messages", statusCode: 403, evidenceLevel: "intermediary-reported" }];
    mixed.toolCalls.push(...Array.from({ length: 10 }, (_, i) => ({ ...mixed.toolCalls[0],
        toolCallId: `repeat-${i}`, startEventId: `repeat-start-${i}`, completionEventId: `repeat-end-${i}`, apiResults: [] })));
    mixed.toolCalls.push({ ...failed, tool: "workiq-search_paths", toolCallId: "prepare", startEventId: "prepare-start",
        completionEventId: "prepare-end", toolSucceeded: true, reportedOutcome: "succeeded", failureEvidence: undefined });
    const { page } = await setup(t, "react", records);
    const row = page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    const count = row.locator(".card-tool-count"), failure = row.locator(".card-failure"), author = row.locator(".request-card-author");
    await expect(count).toHaveText("(13 calls)"); await expect(failure).toHaveAccessibleName("1 tool call failed");
    await expect(author).toContainText("Human prompt"); await expect(author.locator("svg")).toHaveCount(1);
    await expect(failure.locator(".card-failure-face svg")).toHaveCount(1); await expect(row.locator(".returned-issue-ink")).toBeVisible();
    await expect(row.locator(".request-card-source")).toHaveCount(0);
    await expect(page.locator("#activityList .request-card-author").filter({hasText:"Agent prompt"}).first()).toBeVisible();
    const partial = page.locator("#activityList .activity-card").filter({hasText:"Part of the prompt was retained."});
    const resultOnly = page.locator("#activityList .activity-card").filter({has:page.locator(".request-card-author").filter({hasText:"Author unverified"})})
        .filter({has:page.locator(".returned-issue-ink")});
    await expect(resultOnly).toHaveCount(1); await expect(resultOnly.locator(".card-failure")).toHaveCount(0);
    await expect(resultOnly.locator(".card-orientation .result-tone-success")).toContainText("1 tool call completed");
    await expect(partial.locator(".card-quotation")).toHaveCount(0);
    let wrapped = false;
    for (const palette of Object.keys(palettes)) for (const mode of ["dark","light"]) {
        await chooseTheme(page, mode);
        await page.evaluate(id => document.documentElement.dataset.evidencePalette = id, palette);
        for (const [width, scale] of [[1440,1],[1170,1],[390,2]]) {
            await page.setViewportSize({width,height:1000}); await page.evaluate(n => document.documentElement.style.fontSize = `${n * 100}%`, scale);
            const measured = await row.evaluate(node => {
                const list = node.querySelector(".card-tool-list"), left = list.getBoundingClientRect().left + parseFloat(getComputedStyle(list).paddingInlineStart);
                let prevTop = -Infinity, lines = 0;
                for (const item of list.children) {
                    const r = item.getBoundingClientRect();
                    if (Math.abs(prevTop - r.top) > 2) lines++;
                    if (Math.abs(prevTop - r.top) > 2 && Math.abs(r.left - left) > 1 || r.right > list.getBoundingClientRect().right + 1
                        || item.scrollWidth > item.clientWidth) return {aligned:false};
                    prevTop = r.top;
                }
                const c = node.querySelector(".card-tool-count"), name = c.previousElementSibling, face = node.querySelector(".card-failure-face");
                return {aligned:true, lines, paper:getComputedStyle(node.closest("#activityList")).backgroundColor,
                    label:getComputedStyle(c.closest("li")).backgroundColor, count:getComputedStyle(c).color,
                    failure:getComputedStyle(face).color, failPaper:getComputedStyle(face).backgroundColor,
                    author:getComputedStyle(node.querySelector(".request-card-author")).color,
                    size:getComputedStyle(c).fontSize, nameSize:getComputedStyle(name).fontSize};
            });
            assert.ok(measured.aligned, `${palette}/${mode} ${width}: wrapped tool names start on the value edge`);
            wrapped ||= measured.lines > 1;
            assert.equal(measured.size,measured.nameSize);
            assert.ok(contrast(measured.count,measured.label)>=4.5 && contrast(measured.author,measured.paper)>=4.5
                && contrast(measured.failure,measured.failPaper)>=4.5, JSON.stringify(measured));
            const clipped = await partial.locator(".card-excerpt").evaluate(n => n.clientHeight < n.scrollHeight && n.clientHeight <= parseFloat(getComputedStyle(n).lineHeight)*4+1);
            assert.ok(clipped, "An incomplete URL and quotation cannot grow past the home preview.");
            const slots = await page.locator("#activityList .card-orientation:has(.card-outcome)").evaluateAll(nodes => nodes.map(n => {
                const r=n.getBoundingClientRect(), status=n.querySelector(".card-outcome"), face=status.firstElementChild, b=face.getBoundingClientRect();
                return {x:b.x-r.x, y:b.y-r.y, ink:getComputedStyle(face).color, paper:getComputedStyle(face).backgroundColor, key:status.className};
            }));
            const success = slots.find(s=>s.key.includes("result-tone-success")), failed = slots.find(s=>s.key.includes("result-tone-failure"));
            assert.ok(Math.abs(success.x-failed.x)<1 && Math.abs(success.y-failed.y)<1, `${palette}/${mode}: stable outcome slot at ${width}`);
            assert.ok(contrast(success.ink,success.paper)>=4.5 && contrast(failed.ink,failed.paper)>=4.5);
        }
    }
    assert.ok(wrapped, "Exercise an actual wrapped value group, not just a wide row.");
});

test("reading a retained prompt never paints or underlines the passage or floats a title over it", async t => {
    const { page } = await setup(t, "react", compactCardRecords());
    const card = page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    const link = card.locator(".request-card-open");
    const original = await link.textContent();
    for (const [mode, width, scale] of [["light", 1440, 1], ["dark", 390, 2]]) {
        await chooseTheme(page, mode); await page.setViewportSize({width, height: 900});
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await link.scrollIntoViewIfNeeded(); await link.hover(); await capture(page, `reading-action-${mode}`);
        const area = await link.boundingBox();
        await expect(link).toHaveCSS("background-color","rgba(0, 0, 0, 0)",{timeout:1000});
        await expect(link).toHaveCSS("text-decoration-line","none");
        assert.equal(await link.getAttribute("title"),null);
        await page.mouse.down();
        try {
            await expect(link).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
            assert.deepEqual(await link.boundingBox(),area);
        } finally { await page.mouse.move(0, 0); await page.mouse.up(); }
        await link.focus(); await page.keyboard.press("Enter");
        await expect(page.locator("#requestContent")).toContainText(original);
        await page.goBack(); await expect(link).toBeFocused();
    }
});

test("decorated selected values and list options align their glyph to the first label line", async t => {
    const {page} = await setup(t, "react", compactCardRecords());
    await openAnalyzeFilters(page);
    await selectActivityOption(page, "promptAuthorFilter", "agent");
    await selectActivityOption(page, "outcomeFilter", "failure");
    await ready(page);
    const trigger = page.locator("#promptAuthorFilter-control");
    async function spacing(value) {
        return value.evaluate(node => {
            const icon = node.querySelector("svg").getBoundingClientRect(), text = node.lastElementChild;
            const label = text.getBoundingClientRect(), height = parseFloat(getComputedStyle(node).lineHeight);
            return {gap:label.left-icon.right, offset:icon.y+icon.height/2-label.y-height/2, width:icon.width};
        });
    }
    for (const [width,scale] of [[1440,1],[390,2]]) {
        await page.setViewportSize({width,height:900});
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await trigger.scrollIntoViewIfNeeded(); await capture(page, `decorated-filters-${width}`);
        const author = await spacing(trigger.locator(".select-value"));
        const outcome = await spacing(page.locator("#outcomeFilter-control .select-value"));
        assert.ok(author.gap >= 6 && Math.abs(author.gap - outcome.gap) <= 1, JSON.stringify({author,outcome}));
        assert.ok(Math.abs(author.width - outcome.width) <= 1 && Math.abs(author.offset) <= 1.5, JSON.stringify({author,outcome}));
        await trigger.focus(); await page.keyboard.press("Enter");
        const active = page.locator('.select-popup [data-value="agent"]');
        await active.hover(); await expect(active).toHaveAttribute("aria-selected","true");
        const row = await spacing(active.locator(".select-option-label"));
        assert.ok(Math.abs(row.gap-author.gap) <= 1 && Math.abs(row.width-author.width) <= 1);
        await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    }
});

test("exact evidence links keep hover and press paint off the full hit target", async t => {
    const { page } = await setup(t, "react", compactCardRecords());
    const card = page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    for (const [mode, width, scale] of [["light", 1440, 1], ["dark", 390, 2]]) {
        await page.setViewportSize({width, height: 900});
        await chooseTheme(page, mode);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const [selector, name] of [[".returned-issue-ink", "Mail result: HTTP 403"], [".card-failure", "1 tool call failed"]]) {
            const link = card.locator(selector);
            await link.scrollIntoViewIfNeeded();
            await page.mouse.move(0, 0);
            await expect(link).toHaveAccessibleName(name);
            await expect(link.locator('[data-icon-role="forward"]')).toBeVisible();
            await link.hover();
            if (proofs && selector === ".returned-issue-ink") {
                await mkdir(proofs, {recursive:true});
                await card.screenshot({path:path.join(proofs, `evidence-hover-${mode}.png`)});
                await link.hover(); // Capturing a card taller than the viewport can move the pointer off its link.
            }
            const box = await link.boundingBox();
            assert.ok(box.height >= 44 && box.width >= 44);
            await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)", {timeout: 1000});
            await expect(link).toHaveCSS("text-decoration-line", "none");
            const cue = link.locator('[data-icon-role="forward"]');
            await expect(cue).toBeVisible();
            const hover = await cue.evaluate(n => getComputedStyle(n).backgroundColor);
            assert.notEqual(hover, "rgba(0, 0, 0, 0)");
            await page.mouse.down();
            try {
                assert.notEqual(await cue.evaluate(n => getComputedStyle(n).backgroundColor), hover);
                assert.deepEqual(await link.boundingBox(), box);
                await expect(link).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
            } finally { await page.mouse.move(0, 0); await page.mouse.up(); }
            await link.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
            await expect(link).toBeFocused();
            assert.ok(await link.evaluate(n => n.matches(":focus-visible") && parseFloat(getComputedStyle(n).outlineWidth) >= 2));
            if (selector === ".returned-issue-ink") {
                await page.keyboard.press("Enter");
                await expect(page.locator(".api-result-entry:focus")).toContainText("403");
                await page.goBack(); await expect(link).toBeFocused();
            }
        }
    }
});

test("the activity panel cue retains its painted size on hover and restores focus on toggle and Back", {timeout:60000}, async t => {
    const {page} = await setup(t,"react",compactCardRecords());
    const row=page.locator('#activityList [data-view-key="request:review-plural-activity"]');
    const panel=row.locator(".card-panel-link"), issue=row.locator(".returned-issue-ink");
    const settle=()=>page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=="running" || a.effect?.getTiming().iterations===Infinity));
    await panel.scrollIntoViewIfNeeded(); await settle(); await expect(panel).toHaveAccessibleName("Open activity panel: 4 tool calls");
    const initial=await panel.boundingBox(); await panel.hover(); await page.mouse.down();
    assert.deepEqual(await panel.boundingBox(),initial);
    await page.mouse.up(); await expect(panel).toHaveAttribute("aria-expanded","true"); await settle();
    await expect(page.locator('[data-reader-section="activity"] .reader-section-heading')).toBeFocused();
    const calls=page.locator('[data-reader-section="activity"] .reader-call-row');
    for (const [ordinal,key] of [[0,"success"],[1,"failure"],[2,"partial"],[3,"unknown"]]) {
        const toggle=calls.nth(ordinal).locator(".reader-call-toggle");
        await expect(toggle.locator(".reader-call-identity-line + .reader-call-summary")).toHaveCount(1);
        await expect(toggle.locator(`.recorded-result[data-outcome="${key}"]`)).toHaveCount(1);
    }
    await expect(panel).toHaveAccessibleName("Close activity panel: 4 tool calls");
    await panel.focus(); await page.keyboard.press("Enter"); await expect(panel).toHaveAttribute("aria-expanded","false");
    await expect(panel).toBeFocused(); await settle();
    await issue.focus(); await page.keyboard.press("Enter"); await expect(page.locator(".api-result-entry:focus")).toContainText("403");
    await page.goBack(); await expect(issue).toBeFocused();
    const cdp=await page.context().newCDPSession(page);
    try {
        await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
        await page.setViewportSize({width:390,height:844}); await panel.scrollIntoViewIfNeeded(); await settle();
        async function tap(target) {
            await target.scrollIntoViewIfNeeded();
            const box=await target.boundingBox();
            await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
            await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
        }
        await tap(panel);
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").click(); await expect(panel).toBeFocused();
        await settle(); await tap(issue);
        await expect(page.locator(".api-result-entry:focus")).toContainText("403");
        await page.goBack(); await expect(issue).toBeFocused();
    } finally {await cdp.detach();}
});

test("partial outcome opens the exact retained call and explains its limited provenance", async t => {
    const { page } = await setup(t, "react", reviewRecords());
    const card = page.locator('#outcomeChart [data-percentage-card="outcomes"]');
    await expect(card.locator(".percentage-total-value")).toHaveText("244");
    await expect(card.locator('li[data-category="partial"]')).toHaveAttribute("data-count", "1");
    await card.locator('li[data-category="partial"] a').click(); await ready(page);
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(1);
    await page.locator("#activityList .request-card-open").click();
    const call = page.locator('#contextSidebar [data-tool-call-id="review-call-2"]').first();
    await expect(call).toContainText("The call was saved as partial.");
    await expect(call).toContainText("That flag alone does not say which part completed.");
    await expect(call).toContainText("No completion event or end time is retained.");
    await expect(call).toContainText("Tool-reported HTTP 200");
    await expect(call).toContainText("No status recorded");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(1);
    await expect(card.locator('li[data-category="partial"]')).toHaveAttribute("data-count", "1");
});

test("the richer review fixture satisfies the unchanged report privacy producer contract", () => {
    const records = reviewRecords(), scan = scanSourceForExport(records, Buffer.alloc(32, 7));
    assert.equal(scan.allSelectedFieldsScanned, true);
    assert.equal(scan.toolArgumentObjects, records.reduce((sum, record) => sum + record.toolCalls.length, 0));
    assert.equal(scan.selectedScenarioCount, records.length);
});

test("the populated overview gives its total breathing room, completes its own divider and uses sentence-case headings", async t => {
    const { page } = await setup(t);
    const geometry = await overviewGeometry(page), defects = [];
    assert.ok(geometry.ring, "The reproduced wide overview must actually show the donut.");
    if (Math.min(geometry.ring.value.clearance, geometry.ring.unit.clearance) < 4) {
        defects.push(`Total/unit lacks one 4px spacing step inside the painted ring: ${JSON.stringify(geometry.ring)}`);
    }
    if (geometry.divider.inline > 0) {
        const gap = geometry.grid.bottom - geometry.gridBorder.bottom - geometry.summary.bottom;
        if (Math.abs(gap) > 1) defects.push(`The overview's own divider ends ${gap}px before its enclosing frame.`);
    }
    const uppercase = geometry.headings.filter(heading => heading.transform === "uppercase");
    if (uppercase.length) defects.push(`Screen headings are forced uppercase: ${uppercase.map(heading => heading.text).join(", ")}`);
    assert.deepEqual(defects, []);
});

test("the normal-entry overview keeps a long total readable in both themes", { timeout: 60000 }, async t => {
    const { page } = await setup(t, "react", frontendRecords(1000));
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const geometry = await overviewGeometry(page);
        assert.equal(geometry.ring.value.text, "1,000");
        assert.ok(Math.min(geometry.ring.value.clearance, geometry.ring.unit.clearance) >= 4, JSON.stringify(geometry.ring));
        await capture(page, "visual-long-total-" + theme);
    }
});

test("the prompt leads and a separate evidence link names the scoped failure", async t => {
    const { page } = await setup(t);
    await page.goto(page.url() + "&result=failure");
    await ready(page);
    const geometry = await page.locator("#activityList .activity-card").first().evaluate(node => {
        const box = selector => node.querySelector(selector).getBoundingClientRect();
        return { gap: box(".request-card-summary").top - box(".request-card-prompt").bottom,
            promptSize: parseFloat(getComputedStyle(node.querySelector(".request-card-prompt")).fontSize),
            contextSize: parseFloat(getComputedStyle(node.querySelector(".request-card-summary")).fontSize) };
    });
    assert.ok(geometry.gap >= 0 && geometry.gap <= 8 && geometry.promptSize > geometry.contextSize, JSON.stringify(geometry));
    await expect(page.locator("#activityList .activity-card").first().locator(".request-card-exception").first()).toContainText(/failed/);
    await expect(page.locator("#activityList")).not.toContainText(/WIRE interpretation|Requested:/);
    await capture(page, "visual-failure-rows");
});

test("plural reading groups call identities and each call's returned evidence without singleton paging", async t => {
    const { page } = await setup(t, "react", reviewRecords());
    await page.locator('#activityList [data-view-key="request:review-plural-activity"] .request-card-open').click();
    const calls = page.locator('#requestContent [data-reader-section=activity] .reader-call-row');
    await expect(calls).toHaveCount(4);
    await expect(calls.first().locator(".reader-call-identity-line")).toContainText("Call #1");
    await expect(calls.first().locator(".returned-api-entries")).toContainText("AccessDenied");
    await expect(calls.nth(2).locator(".returned-api-entries")).toContainText("No path returned for this batch entry.");
    await expect(page.locator("#requestContent .returned-api-entries .list-pager")).toHaveCount(0);
    await expect(page.locator("#requestContent .returned-entries-heading")).toHaveCount(2);
    await capture(page, "visual-reader-plural");
    for (const theme of ["light", "dark"]) {
        await page.locator("#closeContextSidebar").click();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await chooseTheme(page, theme);
        await page.locator('#activityList [data-view-key="request:review-plural-activity"] .request-card-open').click();
        await page.setViewportSize({ width: 390, height: 844 });
        await calls.nth(2).locator(".reader-call-toggle").evaluate(node => node.scrollIntoView({ block: "start" }));
        await capture(page, "visual-reader-long-narrow-" + theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.setViewportSize({ width: 1024, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await calls.nth(2).locator(".reader-call-toggle").evaluate(node => node.scrollIntoView({ block: "start" }));
        await capture(page, "visual-reader-long-enlarged-" + theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator('#activityList [data-view-key="request:review-plural-activity"] .request-card-open')).toBeFocused();
});

test("narrow outcomes align three readable rows and four breakdowns form paired columns", async t => {
    const { page } = await setup(t);
    const columns = await page.locator("#frontendBreakdowns .percentage-card").evaluateAll(nodes =>
        [...new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left)))]);
    assert.equal(columns.length, 2);
    await page.setViewportSize({ width: 390, height: 844 });
    const rows = await page.locator("#outcomeChart .percentage-legend-row").evaluateAll(nodes =>
        nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, bottom: box.bottom }; }));
    assert.equal(new Set(rows.map(row => Math.round(row.left))).size, 1);
    assert.ok(rows.every((row, i) => !i || row.top >= rows[i - 1].bottom));
    const firstLine = await page.locator("#activityList .request-card-prompt").first().evaluate(node =>
        node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).lineHeight));
    assert.ok(firstLine < 844, "The initial narrow screen includes actual interaction text, not just its section heading.");
    await capture(page, "visual-analyze-mobile");
});

test("Trends exact evidence is recognizable before opening and Compare keeps both periods compact", async t => {
    const { page } = await setup(t, "react", reviewRecords());
    await navigateMain(page, "trends");
    await page.getByRole("button", { name: "Charts", exact: true }).click();
    await page.locator("#trendsPeriod").click();
    await page.locator("#trendsView").getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Trends from", { exact: true }).fill("2026-11-10");
    await page.getByLabel("Trends to", { exact: true }).fill("2026-11-16");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("navigation", { name: "Trend measures" }).getByRole("button", { name: "Tool usage", exact: true }).click();
    await page.locator(".trends-panel[data-family=tools] .trends-plot").getByRole("button", { name: /Nov 15.*fetch,/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "View 23 calls", exact: true }).click();
    const links = page.locator(".trends-evidence-row a");
    await expect(links).toHaveCount(23);
    assert.ok(new Set(await links.allTextContents()).size > 1);
    await expect(links.first().locator(".trends-evidence-time")).toContainText("Call started:");
    await expect(links.first().locator(".trends-evidence-time")).toContainText("Nov 15, 2026");
    await capture(page, "visual-trends-evidence");
    await links.first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#selectedCall")).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.has("call"), false);
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "compare");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".compare-period-key p")).toHaveCount(2);
    const buttons = await page.locator(".comparison-chart-views button").evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(buttons.map(Math.round)).size, 1);
    await capture(page, "visual-compare-mobile");
});

test("analytics destinations keep date context in the task and align the title with its section links", async t => {
    const { page, runtime } = await setup(t);
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const headers = [];
        for (const target of ["reports", "trends?period=custom&from=2026-11-10&to=2026-11-16",
            "compare?aFrom=2026-11-03&aTo=2026-11-09&bFrom=2026-11-10&bTo=2026-11-16"]) {
            await page.goto(runtime.url + target);
            await ready(page);
            const links = page.locator("nav.wire-section-nav:visible");
            await expect(links).toBeVisible();
            if (target === "reports") await expect(page.locator("#reportDeskDates")).toHaveText(/\d.*\d{4}/);
            if (target.startsWith("trends")) await expect(page.locator("#trendsPeriod")).toContainText("Nov 10–16, 2026");
            if (target.startsWith("compare")) await expect(page.locator(".compare-period-key")).toContainText(/Nov 3–9, 2026.*Nov 10–16, 2026/);
            await expect(page.locator("#pageIntro")).toBeHidden();
            headers.push(await links.evaluate(nav => {
                const title = document.querySelector("#pageTitle"), r = title.getBoundingClientRect(), active = nav.querySelector('[aria-current=page]');
                return { x: r.x, y: r.y, font: getComputedStyle(title).fontSize, gap: nav.getBoundingClientRect().y - r.bottom,
                    icon: title.querySelector("svg").getBoundingClientRect().width, activeColor: getComputedStyle(active).borderBottomColor };
            }));
        }
        assert.deepEqual(headers[0], headers[1]);
        assert.deepEqual(headers[0], headers[2]);
    }
});

test("the selected evaluation layout retains complete membership, native reading, paging and peer routes", { timeout: 60000 }, async t => {
    const { page, requests } = await setup(t);
    await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
    const heading = await page.locator("#pageTitle").boundingBox();
    assert.ok(heading.width > 60 && heading.height > 25, "Analyze keeps its visible page heading.");
    const order = await page.evaluate(() => {
        const box = id => document.getElementById(id).getBoundingClientRect();
        return { overview: box("homeView").top, rows: box("activityView").top, breakdowns: box("frontendBreakdowns").top };
    });
    assert.ok(order.overview < order.rows && order.rows < order.breakdowns);
    await expect(page.locator("#frontendHeadingActions #openAnalyzeFilters")).toBeVisible();
    await expect(page.locator("#pageIntro")).toBeHidden();
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Nov 10–16, 2026");
    await expect(page.locator("#activityListScope")).toBeHidden();
    await expect(page.locator("#analyzeScopeStatus")).toContainText("Checked history is unknown");
    await capture(page, "react-analyze-light");
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator("#activityPager")).toContainText("9-16 of 240");
    const link = page.locator("#activityList .request-card-open").first();
    const origin = page.url(), name = await link.getAttribute("aria-label"), reads = requests.filter(url => url === "/api/snapshot").length;
    await link.evaluate(node => { window.retainedActivityLink = node; });
    await link.click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await capture(page, "react-reader-light");
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await expect(page).toHaveURL(origin);
    await expect(page.locator("#activityPager")).toContainText("9-16 of 240");
    await expect(page.locator("#activityList .request-card-open").first()).toHaveAttribute("aria-label", name);
    if (requests.filter(url => url === "/api/snapshot").length === reads) {
        assert.equal(await page.evaluate(() => window.retainedActivityLink === document.querySelector("#activityList .request-card-open")), true);
    }
    for (const destination of ["trends", "reports", "settings", "compare"]) {
        await navigateMain(page, destination);
        await expect(page.locator("#frontendBreakdowns")).toBeHidden();
    }
    await navigateMain(page, "analyze");
    await ready(page);
    await expect(page.locator("#frontendBreakdowns")).toBeVisible();
    await chooseTheme(page, "dark");
    await page.locator("#activityList .request-card-open").first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await capture(page, "react-reader-dark");
    await page.locator("#closeContextSidebar").click();
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "react-analyze-narrow");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.evaluate(() => { window.originalBrand = document.getElementById("shellBrand"); window.originalSearch = document.getElementById("wireSearch"); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#navigationToggle").click();
    await expect(page.locator("#navigationDrawer")).toBeVisible();
    await page.locator("#closeNavigation").click();
    await capture(page, "react-analyze-mobile");
    assert.equal(await page.evaluate(() => document.getElementById("shellBrand") === window.originalBrand
        && document.getElementById("wireSearch") === window.originalSearch), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; scrollTo(0, 0); });
    await capture(page, "react-analyze-enlarged");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
});

test("closing the interaction reader retires its retained response host", async t => {
    const { page } = await setup(t);
    await page.locator("#activityList .request-card-open").first().click();
    const response = page.locator("#requestContent .reader-response-availability").first();
    await expect(response).toContainText("No assistant reply was saved");
    await response.evaluate(node => { window.retiredResponseHost = node; });
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({
        text: window.retiredResponseHost.textContent,
        identity: window.retiredResponseHost.getAttribute("data-context-group"),
        insight: window.retiredResponseHost.getAttribute("data-insight-key"),
    })), { text: "", identity: null, insight: null });
});

test("repeated complete journeys retain one shell and retire prior private presentations", { timeout: 120000 }, async t => {
    const { page } = await setup(t);
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
        window.shellNodes = ["wireReactShell", "shellBrand", "navigationContent", "wireAccountEntry", "wireSearch",
            "analyzeFilterPanel", "contextSidebarBody"].map(id => [id, document.getElementById(id)]);
    });
    async function cycle() {
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await closeAnalyzeFilters(page); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("160 interactions");
        await page.locator("#activityList .request-card-open").first().click();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
        await page.locator("#wireSearch").fill("Cedar");
        const hit = page.locator(".wire-search-hit[data-search-type=interaction]").first();
        await expect(hit).toBeVisible();
        await hit.focus(); await hit.press("Enter");
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        await page.locator("#closeContextSidebar").click();
        await expect(hit).toBeFocused();
        await page.locator("#wireSearchClear").click();
        await selectActivityOption(page, "toolFilter", "all");
        await closeAnalyzeFilters(page); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
        await navigateMain(page, "trends");
        await navigateMain(page, "settings");
        await navigateMain(page, "analyze"); await ready(page);
    }
    async function measure() {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await cdp.send("HeapProfiler.collectGarbage");
        return { ...await cdp.send("Memory.getDOMCounters"), ...await cdp.send("Runtime.getHeapUsage"),
            ...await page.evaluate(() => {
                const types = {}, walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    types[node.nodeType] = (types[node.nodeType] || 0) + 1;
                }
                return { connectedTypes: types };
            }) };
    }
    await cycle();
    const measurements = [{ phase: "warm", ...await measure() }];
    for (const phase of ["first-repeat", "second-repeat"]) {
        for (let count = 0; count < 3; count++) await cycle();
        measurements.push({ phase, ...await measure() });
    }
    const detached = await cdp.send("DOM.getDetachedDomNodes");
    const retiredResponseHosts = detached.detachedNodes.filter(({ treeNode }) => {
        const index = treeNode.attributes?.indexOf("class") ?? -1;
        return index >= 0 && treeNode.attributes[index + 1].split(" ").includes("reader-response-availability");
    }).length;
    assert.equal(retiredResponseHosts, 0, "Closed response presenters must not remain retained by their adapter.");
    assert.equal(await page.evaluate(() => window.shellNodes.every(([id, node]) => document.getElementById(id) === node)), true);
    await expect(page.locator("#wireReactShell")).toHaveCount(1);
    await expect(page.locator("#wireSearch")).toHaveCount(1);
    await expect(page.locator("#contextSidebar")).toHaveCount(1);
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "lifecycle-measurements.json"), JSON.stringify({ measurements, retiredResponseHosts }, null, 2));
    }
    t.diagnostic(JSON.stringify(measurements));
    assert.deepEqual(measurements.at(-1).connectedTypes, measurements.at(-2).connectedTypes);
    assert.equal(measurements.at(-1).jsEventListeners, measurements.at(-2).jsEventListeners);
    assert.equal(measurements.at(-1).documents, measurements.at(-2).documents);
    await cdp.detach();
});

test("accepted filters retire old row handlers and preserve the prior scope during a failed read", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.locator("#activityList .request-card-open").first().evaluate(node => {
        window.retiredActivityLink = node;
        window.retiredActivityName = node.getAttributeNode("aria-label");
    });

    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#activityListSummary")).toContainText("160 interactions");
    const location = page.url();
    assert.equal(await page.evaluate(() => window.retiredActivityName.value), "");
    await page.evaluate(() => window.retiredActivityLink.click());
    assert.equal(page.url(), location, "A removed row cannot reopen a retired selection.");
    const accepted = await page.locator("#activityListSummary").textContent();
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Invented stored read unavailable." } }), { times: 1 });
    await selectActivityOption(page, "toolFilter", "workiq-retrieve");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#message")).toContainText("Invented stored read unavailable.");
    await expect(page.locator("#activityListSummary")).toHaveText(accepted);
});

test("a failed activity presenter remains explicit through later accepted reads", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    await page.evaluate(() => {
        const append = Element.prototype.append;
        Element.prototype.append = function (...nodes) {
            if (this.classList.contains("frontend-record-slot")) {
                Element.prototype.append = append;
                throw new Error("Invented activity mounting failure.");
            }
            return append.apply(this, nodes);
        };
    });
    await selectActivityOption(page, "toolFilter", "workiq-fetch");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#message")).toContainText("Reload this panel.");
    await expect(page.locator("#activityList .request-card-open")).toHaveCount(0);
    await selectActivityOption(page, "toolFilter", "workiq-retrieve");
    await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#message")).toBeVisible();
    await expect(page.locator("#message")).toContainText("Recorded activity could not be displayed safely.");
    await expect(page.locator("#activityListSummary")).toHaveText("Recorded activity unavailable.");
});

test("a delayed filter read cannot reclaim a newer peer destination or its accepted origin", { timeout: 45000 }, async t => {
    const { page } = await setup(t);
    let release, observed, delivered;
    const gate = new Promise(resolve => { release = resolve; });
    const held = new Promise(resolve => { observed = resolve; });
    const sent = new Promise(resolve => { delivered = resolve; });
    let intercepted = false;
    await page.route("**/api/snapshot", async route => {
        if (intercepted) return route.continue();
        intercepted = true;
        const response = await route.fetch();
        observed();
        await gate;
        await route.fulfill({ response });
        delivered();
    });
    try {
        await selectActivityOption(page, "toolFilter", "workiq-fetch");
        await closeAnalyzeFilters(page);
        await held;
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
        await navigateMain(page, "settings");
        await expect(page.locator("#pageTitle")).toHaveText("Settings");
        release(); await sent;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator("#pageTitle")).toHaveText("Settings");
        await navigateMain(page, "analyze"); await ready(page);
        await expect(page.locator("#activityListSummary")).toContainText("240 interactions");
    } finally { release(); }
});

test("literal Search opens its exact interaction and returns to the current query through the React view", { timeout: 45000 }, async t => {
    const { page } = await setup(t), input = page.locator("#wireSearch");
    const origin = page.url();
    await input.fill("Cedar");
    const hit = page.locator(".wire-search-hit[data-search-type=interaction]").first();
    await expect(hit).toBeVisible();
    await expect(hit.locator("mark").first()).toHaveText(/Cedar/i);
    assert.equal(page.url(), origin);
    await hit.focus(); await hit.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#requestContent")).toContainText("Cedar");
    assert.deepEqual([new URL(page.url()).pathname, new URL(page.url()).hash], ["/request", ""]);
    assert.doesNotMatch(await page.evaluate(() => location.href + JSON.stringify(history.state)), /Cedar|review-call|search-0/i);
    await page.goBack();
    await expect(input).toHaveValue("Cedar");
    await expect(hit).toBeFocused();
    await capture(page, "react-search-return");
    await input.fill("no retained text matches this invented phrase");
    await expect(page.locator(".wire-search-hit")).toHaveCount(0);
    assert.ok(!page.url().includes("Cedar"));
});

test("delivery measurements distinguish the bundled control from the React evaluation without inventing a speed budget", { timeout: 45000 }, async t => {
    const measurements = [];
    for (const frontend of ["bundled", "react"]) {
        const { page, htmlBytes, browserVersion } = await setup(t, frontend);
        await page.locator("#wireSearch").fill("Cedar");
        await expect(page.locator(".wire-search-hit").first()).toBeVisible();
        measurements.push({ frontend, browser: process.env.WIRE_FRONTEND_BROWSER ?? "chromium", htmlBytes, browserVersion, ...await page.evaluate(() => {
            const navigation = performance.getEntriesByType("navigation")[0];
            const scripts = performance.getEntriesByType("resource").filter(entry => new URL(entry.name).pathname.startsWith("/assets/client/"));
            return { ...window.frontendMeasurements, domInteractiveMs: navigation.domInteractive, domContentLoadedMs: navigation.domContentLoadedEventEnd,
                clientAssetBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0) };
        }) });
    }
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await writeFile(path.join(proofs, "delivery-measurements.json"), JSON.stringify(measurements, null, 2));
    }
    t.diagnostic(JSON.stringify(measurements));
});
