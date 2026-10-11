import test from "node:test";
import assert from "node:assert/strict";
import { reportContents, chooseReportScope } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { exportCatalogFor, selectActivityOption, chooseTheme, openActivitySessions, automaticScoreOffSummary } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_CHART_PROOF_DIR;
function recordsFor(days) {
    return days.flatMap(([day, count]) => Array.from({ length: count }, (_, index) => ({
        scenarioId: `synthetic-${day}-${index}`, sourceSessionId: "synthetic-session", sourceHost: "copilot-app",
        sourceSessionName: "Synthetic chart requests", projectId: "synthetic-project", project: "Synthetic project",
        capturedAt: `2026-09-${day}T12:00:00Z`, workflowState: "ready_to_export",
        userPrompt: { text: `SYNTHETIC ONLY request ${day} ${index}`, status: "full" },
        toolCalls: [{
            tool: "workiq-fetch", toolCallId: `synthetic-call-${day}-${index}`,
            startedAt: `2026-09-${day}T12:00:00Z`, requestedApiPath: "/me/events",
            requestArgs: { entityUrls: ["/me/events"] }, toolSucceeded: index % 6 !== 0,
            reportedOutcome: index % 6 !== 0 ? "succeeded" : "failed", apiResults: [],
        }],
    })));
}
async function fixture(days, run) {
    const records = recordsFor(days), requests = [], errors = [];
    let releasePreview;
    const state = { boardId: "synthetic-chart", revision: 1, scenarios: records, exports: [], coverage: { since: "2026-09-01", until: "2026-09-30", notes: [] } };
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "synthetic-chart-nonce")); return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push({ path: req.url, input });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") {
            res.end(JSON.stringify({ ...state, exportCatalog: exportCatalogFor(records), analytics: { ...buildActivityAnalytics(records, input), revision: 1 } })); return;
        }
        if (req.url === "/api/preview") {
            await new Promise(resolve => { releasePreview = resolve; });
            res.end(JSON.stringify({
                previewId: "synthetic-preview", records: [{}], files: { "product-report.md": "# Synthetic only" },
                privacy: { allSelectedFieldsScanned: true, reviewerConfirmed: false, categories: {}, limitations: [] },
            })); return;
        }
        if (req.url === "/api/cancel-preview") { res.end(JSON.stringify({ cancelled: true })); return; }
        if (req.url === "/api/evaluation/automatic/summary") { res.end(JSON.stringify(automaticScoreOffSummary())); return; }
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "Synthetic fixture permits snapshot reads only." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1200, height: 960 }, reducedMotion: "reduce" });
        context.setDefaultTimeout(5000);
        context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, requests, releasePreview: () => releasePreview?.(), url: `http://127.0.0.1:${server.address().port}` });
        assert.deepEqual(errors, []);
        assert.ok(requests.every(request => ["/api/snapshot", "/api/preview", "/api/cancel-preview", "/api/evaluation/automatic/summary"].includes(request.path)), "Navigation never mutates the evidence store");
    } finally {
        releasePreview?.();
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
async function screenshot(page, name) {
    if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${name}.png`) });
}
async function geometry(page, index = 0) {
    return page.locator(".time-stack").nth(index).evaluate(stack => {
        const action = stack.closest("button,a");
        const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { stack: box(stack), action: box(action), plot: box(stack.closest(".time-chart")), background: getComputedStyle(action).backgroundColor };
    });
}

test("single weekly column bounds hover and pointer action to the visible column", async () => fixture([["14", 17]], async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    await page.locator(".time-stack").hover();
    const measured = await geometry(page);
    console.log("Single column measured geometry:", JSON.stringify(measured));
    await screenshot(page, "single-column-hover");
    assert.ok(measured.action.width <= measured.stack.width + 8, `Hit width ${measured.action.width} exceeds painted width ${measured.stack.width} plus 8px padding`);
    assert.ok(measured.action.height <= Math.max(24, measured.stack.height + 8));
    assert.equal(measured.background, "rgba(0, 0, 0, 0)", "Hover must not paint a selection slab");
    await page.mouse.click(measured.plot.x + 10, measured.plot.y + measured.plot.height / 2);
    assert.equal(new URL(page.url()).hash, "", "Empty plot space never filters");
    await page.locator(".time-stack .failure").click();
    await page.locator("#activityView").waitFor({ state: "visible" }); await ready(page);
    assert.match(new URL(page.url()).hash, /^#activity\?range=custom&from=2026-09-14/);
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).hash, "", "One stacked-column activation produces exactly one history entry");
}));

test("pointer section inspection survives a small scroll without stealing keyboard focus", async () => fixture([["14", 17]], async ({ context, url }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.goto(url); await ready(page);
    const column = page.locator(".time-column").first();
    await column.hover();
    await page.mouse.wheel(0, 1);
    assert.equal(await page.getByRole("tooltip").isVisible(), true);
    assert.match(await page.getByRole("tooltip").innerText(), /Worked: 14 of 17 Work IQ tool calls/);
    assert.match(await column.getAttribute("aria-label"), /17 Work IQ tool calls/);
    assert.equal(await column.evaluate(node => node.matches(":hover")), true);
    assert.equal(await column.evaluate(node => node === document.activeElement), false, "Pointer inspection never steals keyboard focus");
}));

test("Reset to Home is one visible affordance for chart-only deviation and restores canonical Home", async () => fixture([["14", 17]], async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/#home?chart=endpoint&bucket=month"); await ready(page);
    const reset = page.getByRole("button", { name: "Reset to Home", exact: true });
    assert.equal(await reset.count(), 1, "Chart/timescale deviations must expose the same obvious reset");
    await reset.click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#bucketFilter").inputValue(), "week");
    assert.equal(await page.locator('[data-chart="time"]').getAttribute("aria-pressed"), "true");
    assert.equal(await reset.isVisible(), false);
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home?chart=endpoint&bucket=month");
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    await selectActivityOption(page, "dateFilter", "custom");
    assert.equal(await reset.isVisible(), true, "Unsubmitted custom date mode also has an escape route");
    await reset.click(); await ready(page);
    assert.equal(await page.locator("#dateFields").isVisible(), false);
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#dateFields").isVisible(), true);
}));

for (const shape of ["single", "multiple"]) test(`${shape} columns: both themes at 375/820/1200, bounded hit geometry, gaps, keyboard and exact-data alternative`, { timeout: 60000 }, async () => fixture(shape === "single" ? [["14", 17]] : [["14", 200], ["15", 1], ["17", 3]], async ({ context, url }) => {
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url + "/#home?bucket=day"); await ready(page);
        await chooseTheme(page, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const columns = page.locator(".time-column");
        assert.equal(await columns.count(), shape === "single" ? 1 : 3);
        for (let index = 0; index < await columns.count(); index++) {
            const column = columns.nth(index);
            await page.keyboard.press("Tab");
            await column.focus();
            const tooltip = page.getByRole("tooltip");
            await tooltip.waitFor({ state: "hidden" });
            const measured = await geometry(page, index);
            assert.equal(measured.action.width, measured.stack.width);
            assert.ok(Math.abs(measured.action.height - measured.stack.height) < 1, "Only a subpixel viewport remainder is unpainted");
            assert.ok(measured.action.width <= 84, "Only affected time scenes use the bounded 84px projected footprint");
            assert.equal(await column.locator("button,a").count(), 0, "One button owns the entire stack");
            assert.equal(await column.locator(".dimensional-count").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
            const before = new URL(page.url()).hash;
            await page.keyboard.press("Escape");
            assert.equal(await tooltip.isVisible(), false);
            if (measured.action.height < measured.plot.height - 20) {
                await page.mouse.click(measured.plot.x + 8, measured.plot.y + 10);
                assert.equal(new URL(page.url()).hash, before, "Empty space above a short column is inert");
            }
        }
        await page.locator(".chart-panel").scrollIntoViewIfNeeded();
        await columns.first().hover();
        assert.equal(await page.getByRole("tooltip").isVisible(), true, "Painted sections retain the user's requested inspection");
        await screenshot(page, `${shape}-${theme}-${width}-hover`);
        await page.keyboard.press("Escape");
        if (shape === "multiple") {
            const zero = page.locator(".time-zero");
            assert.equal(await zero.count(), 1);
            assert.match(await zero.getAttribute("aria-label"), /0 Work IQ tool calls/);
            assert.equal(await zero.evaluate(node => Boolean(node.closest("button,a"))), false);
            await zero.click();
            assert.equal(new URL(page.url()).hash, "#home?bucket=day");
            await page.keyboard.press("Escape");
            assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), false);
            await page.locator("#tableDisclosure>summary").click();
            const data = page.locator("#countTable tbody tr");
            assert.equal(await data.count(), 4);
            assert.deepEqual(await data.locator("td:nth-child(2)").allTextContents(), ["200", "1", "0", "3"]);
            const shortAction = data.nth(1).getByRole("button");
            assert.ok((await shortAction.boundingBox()).height >= 24);
            await shortAction.focus(); await page.keyboard.press("Enter"); await ready(page);
            assert.match(new URL(page.url()).hash, /^#activity\?bucket=day&range=custom&from=2026-09-15/);
            assert.equal(await page.locator("#activityList .request-row").count(), 1);
            await page.locator("#activityList .request-link").click();
            assert.match(new URL(page.url()).hash, /^#request/);
            await page.goBack(); await ready(page);
            assert.equal(await page.locator("#activityList .request-row").count(), 1);
            await page.goBack(); await ready(page);
        }
        await columns.first().focus(); await page.keyboard.press("Enter"); await ready(page);
        assert.match(new URL(page.url()).hash, /^#activity/);
        await page.goBack(); await ready(page);
        assert.match(new URL(page.url()).hash, /^#home/);
        await page.close();
    }
}));

test("Reset clears all navigation scope, search and pagination; Back restores them without resetting theme/report choices", async () => fixture([["14", 17], ["17", 3]], async ({ context, url, requests }) => {
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem("workiq-evidence.theme", "dark"));
    const previous = "#activity?chart=endpoint&bucket=month&range=custom&from=2026-09-14&to=2026-09-17&project=synthetic-project&service=Calendar&result=failure&scope=all&session=synthetic-session&page=2&expanded=true&layer=direct-request&endpoint=synthetic-path";
    await page.goto(url + "/" + previous); await ready(page);
    await page.locator("#activitySearch").fill("SYNTHETIC PRIVATE SEARCH");
    assert.equal(page.url().includes("PRIVATE"), false, "Search text is never put in the URL");
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("scope"), "all");
    const slice = new URL(page.url()).hash;
    await page.locator("nav [data-nav=reports]").click();
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator('[name=promptMode][value=original]').check();
    await page.locator('#formatOptions input[value=json]').check();
    await page.locator("nav [data-nav=activity]").click(); await ready(page);
    const beforeReset = new URL(page.url()).hash;
    await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    const timeContext = await page.evaluate(() => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZoneFallback: false, localeFallback: false }));
    assert.deepEqual(requests.filter(request => request.path === "/api/snapshot").at(-1).input, { layer: "tool", groupBy: "workload", bucket: "week", filters: { scope: "history", includeMetadata: false }, limit: 8, timeContext });
    assert.equal(await page.locator("#message").isVisible(), false, "A successful Reset needs no routine narration.");
    assert.equal(await page.locator("#dateFilter").inputValue(), "capture");
    for (const id of ["projectFilter", "serviceFilter"]) assert.equal(await page.locator("#" + id).inputValue(), "all");
    assert.deepEqual(await page.locator("#outcomeFilter").evaluate(node => [...node.selectedOptions].map(option => option.value)),
        await page.locator("#outcomeFilter option").evaluateAll(nodes => nodes.map(node => node.value)));
    assert.equal(await page.locator('[name=promptMode][value=original]').isChecked(), true);
    assert.equal(await page.locator('#formatOptions input[value=json]').isChecked(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("workiq-evidence.theme")), "dark");
    assert.equal(await page.locator("#filterChips").innerText(), "");
    assert.equal(await page.locator("#resetView").count(), 1, "There is only one reset node, not competing empty-state resets");
    assert.equal(await page.getByRole("button", { name: /^Reset/ }).count(), 0, "The reset is hidden at canonical Home");
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).hash, beforeReset);
    assert.equal(await page.locator("#activitySearch").inputValue(), "SYNTHETIC PRIVATE SEARCH");
    assert.equal(requests.filter(request => request.path === "/api/snapshot").at(-1).input.filters.scope, "all", "Both collections survives reset and Back");
    await page.goForward(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    assert.equal(await page.locator("#activitySearch").inputValue(), "");
    await page.goto(url + "/" + slice); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "", "A copied deep link does not recover private search text");
}));

test("Both collections is a meaningful route scope and reset restores Current activity", async () => fixture([["14", 17]], async ({ context, url, requests }) => {
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    await page.locator("#coverage > summary").click();
    await selectActivityOption(page, "scopeFilter", "all"); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home?scope=all");
    assert.equal(requests.filter(row => row.path === "/api/snapshot").at(-1).input.filters.scope, "all");
    await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
    assert.equal(requests.filter(row => row.path === "/api/snapshot").at(-1).input.filters.scope, "history");
    await page.goBack(); await ready(page);
    assert.equal(await page.locator("#scopeFilter").inputValue(), "all");
    assert.equal(requests.filter(row => row.path === "/api/snapshot").at(-1).input.filters.scope, "all");
}));

test("reset preserves report selection and invalidates a pending preview without late resurrection or writes", async () => fixture([["14", 17]], async ({ context, url, requests, releasePreview }) => {
    const page = await context.newPage();
    await page.goto(url + "/#activity"); await ready(page);
    await page.locator("#activityList input").first().check();
    await page.locator("nav [data-nav=reports]").click();
    const response = page.waitForResponse("**/api/preview");
    await reportContents(page);
    await page.locator("#exportBtn").click();
    await page.getByText("Scanning selected evidence locally. No files are being written.", { exact: true }).waitFor();
    await page.goBack(); await ready(page);
    await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
    releasePreview(); await response;
    assert.equal(await page.locator("#overlay").evaluate(node => node.open), false);
    assert.equal(new URL(page.url()).hash, "#home");
    await page.locator("nav [data-nav=reports]").click();
    assert.equal(await page.locator("#exportBtn").isEnabled(), true, "Selection remains ready; reset only changed navigation");
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1/);
    assert.equal(requests.filter(request => request.path === "/api/preview").length, 1);
}));

test("empty captured data has no fake zero column or redundant reset", async () => fixture([], async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    assert.equal(await page.locator(".time-column,.time-zero").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Reset/ }).count(), 0);
    await page.locator('[data-chart=endpoint]').click();
    await ready(page);
    assert.equal(await page.getByRole("button", { name: "Reset to Home", exact: true }).count(), 1);
}));

test("reset from paginated Activity and request deep links preserves the prior entry for Back", async () => fixture([["14", 26]], async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/#activity?page=1"); await ready(page);
    await page.getByRole("button", { name: "Next request groups", exact: true }).click();
    assert.match(await page.locator(".session-requests .pager").innerText(), /7-12 of 26/);
    await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#activity?page=1");
    assert.match(await page.locator(".session-requests .pager").innerText(), /7-12 of 26/);
    await page.locator("#activityList .request-link").first().click();
    const requestRoute = new URL(page.url()).hash;
    assert.match(requestRoute, /^#request.*request=/);
    await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
    assert.equal(new URL(page.url()).hash, "#home");
    await page.goBack(); await ready(page);
    assert.equal(new URL(page.url()).hash, requestRoute);
    assert.equal(await page.locator("#requestView").isVisible(), true);
    await page.goBack(); await ready(page);
    assert.match(await page.locator(".session-requests .pager").innerText(), /7-12 of 26/);
}));

test("Reset stays usable during a pending slice read and its snapshot wins over the late response", async () => fixture([["14", 17]], async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url); await ready(page);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let received;
    const receivedSlice = new Promise(resolve => { received = resolve; });
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch();
        if (route.request().postDataJSON().filters.outcomes?.[0] === "failure") {
            received(); await held;
        }
        await route.fulfill({ response });
    });
    try {
        await selectActivityOption(page, "outcomeFilter", "failure");
        await receivedSlice;
        assert.equal(await page.getByRole("button", { name: "Reset to Home", exact: true }).isVisible(), true);
        await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
        assert.equal(new URL(page.url()).hash, "#home");
        assert.equal(await page.locator("#activityCount").textContent(), "17");
        const late = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.request().postDataJSON().filters.outcomes?.[0] === "failure");
        release(); await late;
        await page.locator("nav [data-nav=activity]").click();
        await openActivitySessions(page);
        assert.equal(await page.locator("#activityList .request-row").count(), 6);
        const resultDefaults = await page.locator("#outcomeFilter").evaluate(node => ({
            selected: [...node.selectedOptions].map(option => option.value),
            available: [...node.options].map(option => option.value),
        }));
        assert.deepEqual(resultDefaults.selected, resultDefaults.available, "Reset retains all canonical result options after the late response");
        assert.match(await page.locator(".session-requests .pager").textContent(), /of 17 request groups/);
    } finally { release(); }
}));
