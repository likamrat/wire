import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { searchFixture } from "./live-search-fixture.mjs";
import { frontendRecords, reviewRecords, overviewGeometry } from "./frontend-fixture.mjs";
import { scanSourceForExport } from "../lib/privacy.mjs";
import { chooseTheme, navigateMain, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";
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
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !allowed.has(url.pathname)) {
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

test("compact summaries keep diagnostic prose in the right reader while exact filtered calls remain reachable", { timeout: 60000 }, async t => {
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
    await expect(card).not.toContainText(/Call #|Requested:|WIRE interpretation|AccessDenied|ToolUnavailable|flag alone|completion event|end time/);
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
    await expect(author).toContainText("My prompt"); await expect(author.locator("svg")).toHaveCount(1);
    await expect(failure.locator("svg")).toHaveCount(1); await expect(row.locator(".returned-issue-ink")).toBeVisible();
    await expect(row.locator(".request-card-source")).toHaveCount(0);
    await expect(page.locator("#activityList .request-card-author").filter({hasText:"Agent prompt"}).first()).toBeVisible();
    const partial = page.locator("#activityList .activity-card").filter({hasText:"Part of the prompt was retained."});
    const resultOnly = page.locator("#activityList .activity-card").filter({has:page.locator(".request-card-author").filter({hasText:"Author unverified"})})
        .filter({has:page.locator(".returned-issue-ink")});
    await expect(resultOnly).toHaveCount(1); await expect(resultOnly.locator(".card-failure")).toHaveCount(0);
    await expect(partial.locator(".card-quotation")).toHaveCount(0);
    let wrapped = false;
    for (const palette of Object.keys(palettes)) for (const mode of ["dark","light"]) {
        await page.evaluate(id => document.documentElement.dataset.evidencePalette = id, palette);
        await chooseTheme(page, mode);
        for (const [width, scale] of [[1440,1],[1170,1],[390,2]]) {
            await page.setViewportSize({width,height:1000}); await page.evaluate(n => document.documentElement.style.fontSize = `${n * 100}%`, scale);
            const measured = await row.evaluate(node => {
                const list = node.querySelector(".card-tool-item").parentElement, left = list.getBoundingClientRect().left;
                let prevTop = -Infinity, lines = 0;
                for (const item of list.children) {
                    const r = item.getBoundingClientRect(), css = getComputedStyle(item);
                    if (Math.abs(prevTop - r.top) > 2) lines++;
                    if (Math.abs(prevTop - r.top) > 2 && Math.abs(r.left - left) > 1 || r.right > list.getBoundingClientRect().right + 1
                        || parseFloat(css.borderInlineStartWidth) || parseFloat(css.paddingInlineStart)) return {aligned:false};
                    prevTop = r.top;
                }
                const c = node.querySelector(".card-tool-count"), name = c.previousElementSibling, face = node.querySelector(".card-failure-face");
                return {aligned:true, lines, paper:getComputedStyle(node).backgroundColor, count:getComputedStyle(c).color,
                    failure:getComputedStyle(face).color, failPaper:getComputedStyle(face).backgroundColor,
                    author:getComputedStyle(node.querySelector(".request-card-author")).color,
                    size:getComputedStyle(c).fontSize, nameSize:getComputedStyle(name).fontSize};
            });
            assert.ok(measured.aligned, `${palette}/${mode} ${width}: wrapped tool names start on the value edge`);
            wrapped ||= measured.lines > 1;
            assert.equal(measured.size,measured.nameSize);
            assert.ok(contrast(measured.count,measured.paper)>=4.5 && contrast(measured.author,measured.paper)>=4.5
                && contrast(measured.failure,measured.failPaper)>=4.5, JSON.stringify(measured));
            const clipped = await partial.locator(".card-excerpt").evaluate(n => n.clientHeight < n.scrollHeight && n.clientHeight <= parseFloat(getComputedStyle(n).lineHeight)*4+1);
            assert.ok(clipped, "An incomplete URL and quotation cannot grow past the home preview.");
        }
    }
    assert.ok(wrapped, "Exercise an actual wrapped value group, not just a wide row.");
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
    await page.locator("#trendsView").getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByLabel("Trends from", { exact: true }).fill("2026-11-10");
    await page.getByLabel("Trends to", { exact: true }).fill("2026-11-16");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click();
    await expect(page.locator("#trendsView")).toHaveAttribute("aria-busy", "false");
    await page.locator('.trends-panel[data-family=tools] .trends-sizing button:first-child').click();
    await page.locator(".trends-panel[data-maximized=true] .trends-plot").getByRole("button", { name: /Nov 15.*fetch,/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "View evidence", exact: true }).click();
    const links = page.locator(".trends-evidence-row a");
    await expect(links).toHaveCount(23);
    assert.ok(new Set(await links.allTextContents()).size > 1);
    await expect(links.first().locator(".trends-evidence-time")).toContainText("Call started:");
    await expect(links.first().locator(".trends-evidence-time")).toContainText("Nov 15, 2026");
    await capture(page, "visual-trends-evidence");
    const call = new URLSearchParams((await links.first().getAttribute("href")).split("?")[1]).get("call");
    await links.first().click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("call"), call);
    await page.locator("#closeContextSidebar").click();
    await navigateMain(page, "compare");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".compare-period-key p")).toHaveCount(2);
    const buttons = await page.locator(".comparison-chart-views button").evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(new Set(buttons.map(Math.round)).size, 1);
    await capture(page, "visual-compare-mobile");
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
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("Nov 10");
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
