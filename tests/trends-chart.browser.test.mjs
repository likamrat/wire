import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { loadBrowserAssets } from "../lib/browser-assets.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { buildTrends } from "../lib/trends.mjs";
import { fixture as record, exportCatalogFor, automaticScoreOffSummary, UNBOUND_FIXTURE_BOOTSTRAP } from "./helpers.mjs";

// Renderer-level fixture: a legitimate zero-reach tool, an empty day, and two
// tools that can reach the same interaction. No host, store or external network.
const definitions = ["fetch", "retrieve", "ask"].map(label => ({ id: `workiq-${label}`, label }));
const days = [
    { calls: 4, interactions: 2, counts: [3, 1, 0], reaches: [2, 1, 0] },
    { calls: 0, interactions: 0, counts: [0, 0, 0], reaches: [0, 0, 0] },
    { calls: 1, interactions: 1, counts: [0, 1, 0], reaches: [0, 1, 0] },
    { calls: 2, interactions: 1, counts: [2, 0, 0], reaches: [1, 0, 0] },
].map(({ calls, interactions, counts, reaches }, index) => ({
    date: `2026-03-0${index + 1}`, calls, interactions,
    values: { tools: definitions.map((definition, slot) => ({ ...definition, count: counts[slot], eligible: calls,
        percent: calls ? counts[slot] * 100 / calls : null, calls: counts[slot], interactions: reaches[slot],
        reachEligible: interactions, reach: interactions ? reaches[slot] * 100 / interactions : null })) },
}));
const data = { from: days[0].date, to: days.at(-1).date, window: { offset: 0 }, definitions: { tools: definitions }, days };

async function fixture(t) {
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route("**/*", route => {
        switch (route.request().url()) {
        case "http://chart.test/": return route.fulfill({ contentType: "text/html", body: `<!doctype html>
            <style>body{margin:0;--paper:white;--ink:black}#plot{overflow:auto;width:700px;height:240px}svg{display:block}
            #tip{position:fixed;z-index:2;background:white}#tip dl{margin:0}#tip svg{width:24px;height:12px}</style>
            <header class="app-header">Chart test</header><main id="main"><div id="plot"></div><aside role="tooltip" id="tip" hidden></aside></main>` });
        case "http://chart.test/chart.mjs": return route.fulfill({ contentType: "text/javascript", path: fileURLToPath(new URL("../web/trends-chart.mjs", import.meta.url)) });
        default: return route.abort();
        }
    });
    await page.goto("http://chart.test/");
    await page.evaluate(async data => {
        const { mountTrendsChart } = await import("/chart.mjs");
        const root = document.getElementById("plot");
        let allowed = true, selection = null;
        const chart = mountTrendsChart({ root, tooltip: document.getElementById("tip"), canInspect: () => allowed,
            color: id => ({ "workiq-ask": "red", "workiq-retrieve": "blue", "workiq-fetch": "green" })[id],
            formatDate: date => date, formatAxisDate: date => date.slice(5), onInspect() {},
            onSelect(date, id) { selection = { date, id }; chart.select(selection); } });
        window.draw = (mode = "reach", type, hidden = []) => chart.render(data, "tools", mode, new Set(hidden), selection, type);
        window.size = (width, height) => {
            root.style.width = `${width}px`; root.style.height = `${height}px`;
            chart.resize({ width, height });
        };
        window.withdraw = () => { allowed = false; chart.withdrawAccess(); };
        window.draw();
    }, data);
    return page;
}

test("grouped columns preserve the population, complete selected-tool facts, and exactly one described mark", async t => {
    const page = await fixture(t), plot = page.locator("#plot"), tip = page.getByRole("tooltip");
    const marks = plot.locator("[data-trend-mark]"), columns = plot.locator("[data-trend-bar]");
    await expect(marks).toHaveCount(12);
    const rects = await columns.evaluateAll(nodes => nodes.slice(0, 2).map(node => {
        const { x, y, width, height } = node.getBBox(); return { x, y, width, height };
    }));
    assert.ok(rects[0].x + rects[0].width < rects[1].x);
    assert.equal(rects[0].y + rects[0].height, rects[1].y + rects[1].height);
    assert.equal(rects[0].height, rects[1].height * 2);
    await page.evaluate(() => draw("reach", "columns", ["workiq-ask"]));
    const fetch = plot.getByRole("button", { name: "2026-03-01: fetch, 100%", exact: true });
    await fetch.hover();
    await expect(tip).toContainText("2 of 2 interactions");
    await expect(tip).toContainText("75% (3 of 4 calls)");
    await expect(tip.getByText("Additional calls", { exact: true }).locator("+ dd")).toHaveText("1");
    await page.keyboard.press("Escape");
    const retrieve = plot.getByRole("button", { name: "2026-03-01: retrieve, 50%", exact: true });
    await retrieve.tap();
    await expect(retrieve).toHaveAttribute("aria-pressed", "true");
    await expect(retrieve).toHaveAccessibleDescription(/1 of 2 interactions/);
    await expect(plot.locator("[aria-describedby]")).toHaveCount(1);
    await expect(fetch).not.toHaveAttribute("aria-describedby");
    await page.keyboard.press("ArrowRight");
    await expect(tip).toContainText("Unavailable");
    await expect(tip).toContainText("0 of 0 interactions");
    await expect(plot.locator("[aria-describedby]")).toHaveCount(1);
    await expect(retrieve).not.toHaveAttribute("aria-describedby");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await expect(tip.locator(".trends-tip-value")).toHaveText("0%");
    await expect(tip).toContainText("0 of 1 interaction");
    await page.keyboard.press("Space");
    const zero = plot.getByRole("button", { name: "2026-03-03: fetch, 0%", exact: true });
    await expect(zero).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await expect(plot.locator("[aria-describedby]")).toHaveCount(0);
    await page.evaluate(() => draw("reach", "lines"));
    await expect(zero).toBeFocused();
    await expect(zero).toHaveAttribute("aria-pressed", "true");
    await expect(plot.locator('[data-trend-mark][tabindex="0"]')).toHaveCount(1);
});

test("straight lines break only at null, retain count zero, and reuse correct geometry after scroll and resize", async t => {
    const page = await fixture(t), plot = page.locator("#plot"), tip = page.getByRole("tooltip");
    await page.evaluate(() => draw("reach", "lines"));
    await expect(plot.locator("[data-trend-line]")).toHaveCount(3); // Only day 3 → day 4, including the never-used tool.
    const missing = plot.getByRole("button", { name: "2026-03-02: ask, Unavailable", exact: true });
    await missing.tap();
    await expect(missing).toHaveAttribute("aria-pressed", "true");
    await expect(tip).toContainText("Unavailable");
    await page.evaluate(() => draw("count", "lines"));
    await expect(plot.locator("line[data-trend-line]")).toHaveCount(9);
    const mark = plot.getByRole("button", { name: "2026-03-02: ask, 0 calls", exact: true });
    await expect(mark).toHaveAttribute("aria-pressed", "true");
    const shared = await mark.boundingBox(), visited = new Set();
    for (let i = 0; i < 3; i++) {
        await page.touchscreen.tap(shared.x + shared.width / 2, shared.y + shared.height / 2);
        const selected = plot.locator('[aria-pressed="true"]');
        await expect(selected).toHaveAccessibleName(/2026-03-02: .+, 0 calls$/);
        visited.add(await selected.getAttribute("data-series"));
    }
    assert.deepEqual(visited, new Set(definitions.map(row => row.id)));
    const old = await mark.elementHandle();
    await page.evaluate(() => { size(180, 300); document.getElementById("plot").scrollLeft = 64; });
    assert.equal(await old.evaluate(node => node.isConnected), true);
    await expect.poll(() => plot.locator(".trends-y-axis").getAttribute("transform")).toBe("translate(64 0)");
    await page.evaluate(() => draw("count", "columns"));
    assert.equal(await plot.evaluate(node => node.scrollLeft), 64);
    const fetch = plot.getByRole("button", { name: "2026-03-01: fetch, 3 calls", exact: true });
    const visibleLeft = () => fetch.evaluate(node => node.getBoundingClientRect().left -
        node.closest("svg").querySelector(".trends-y-axis rect").getBoundingClientRect().right);
    assert.ok(await visibleLeft() < 0, "Scrolled fixture must start with the first column behind the sticky axis");
    await fetch.focus();
    await expect.poll(visibleLeft).toBeGreaterThan(0);
    await expect(tip.locator(".trends-tip-value")).toHaveText("3 calls");
    await page.evaluate(() => { size(580, 280); });
    await fetch.hover();
    await expect(tip.locator(".trends-tip-value")).toHaveText("3 calls");
    const held = await fetch.evaluateHandle(node => node.getAttributeNode("aria-label"));
    await page.evaluate(() => { withdraw(); draw(); });
    await expect(plot.locator("svg")).toHaveCount(0);
    await expect(tip).toBeHidden();
    assert.equal(await held.evaluate(attr => attr.value), "");
    assert.equal(await page.locator("#tip").textContent(), "");
});

test("compiled Trends switches a selected dated service between columns and lines without changing evidence", async t => {
    const records = ["messages", "drive/root", "calendarView"].map((resource, index) => {
        const value = record(`chart-sample-${index}`);
        const stamp = `2026-03-0${index + 2}T12:00:00Z`, path = `/me/${resource}`;
        Object.assign(value.userPrompt, { text: `Read the invented ${resource} sample`, sourceEventId: `chart-prompt-${index}`, sourceTimestamp: stamp });
        Object.assign(value.toolCalls[0], { startedAt: stamp, requestedApiPath: path, requestArgs: { entityUrls: [path] } });
        return value;
    });
    const assets = await loadBrowserAssets({ renderer: process.env.WIRE_TEST_FRONTEND ?? "react" });
    const browser = await chromium.launch({ channel: process.env.WIRE_FRONTEND_BROWSER });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "UTC", reducedMotion: "no-preference" });
    const errors = [], reads = [];
    page.on("pageerror", error => errors.push(error.message));
    // Load the shipped shell/entry; only reads of the invented projection are admitted.
    await page.route("**/*", route => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin !== "https://wire.invalid") return route.abort();
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill({ contentType: asset.type, body: asset.bytes });
        if (url.pathname === "/trends") return route.fulfill({ contentType: "text/html",
            body: renderHtmlShell("a".repeat(64), "chart-proof", UNBOUND_FIXTURE_BOOTSTRAP, assets) });
        if (url.pathname === "/assets/assessment-contract.mjs") return route.fulfill({ contentType: "text/javascript",
            path: fileURLToPath(new URL("../lib/assessment-contract.mjs", import.meta.url)) });
        if (url.pathname === "/api/snapshot") return route.fulfill({ json: { revision: 1, scenarios: records, exports: [],
            analytics: { ...buildActivityAnalytics(records, r.postDataJSON()), revision: 1 },
            requestActivity: buildRequestActivity(records), exportCatalog: exportCatalogFor(records) } });
        if (url.pathname === "/api/evaluation/automatic/summary") return route.fulfill({ json: automaticScoreOffSummary() });
        if (url.pathname === "/api/trends") {
            const input = r.postDataJSON(); reads.push(input);
            return route.fulfill({ json: buildTrends({ revision: 1 }, input, { records }) });
        }
        return route.abort();
    });
    await page.clock.setFixedTime(new Date("2026-03-04T20:00:00Z"));
    await page.goto("https://wire.invalid/trends");
    const index = page.getByRole("navigation", { name: "Trend measures" });
    await index.getByRole("button", { name: "Services", exact: true }).click();
    const panel = page.locator("[data-family=services]"), plot = panel.locator(".trends-plot");
    const mark = plot.getByRole("button", { name: /Mar 3, 2026: Files, 1 calls?$/ });
    await expect(plot.locator("[data-trend-mark]")).toHaveCount(21);
    await expect(plot.locator("svg[data-chart-type=columns]")).toBeVisible();
    await mark.focus();
    await page.keyboard.press("Enter");
    await expect(mark).toHaveAttribute("aria-pressed", "true");
    const count = reads.length;
    await panel.getByRole("button", { name: "Lines", exact: true }).click();
    await expect(plot.locator("[data-trend-line]")).toHaveCount(18);
    await expect(mark).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Percentage", exact: true }).click();
    await expect(plot.locator("[data-trend-line]")).toHaveCount(6);
    const selected = plot.getByRole("button", { name: /Mar 3, 2026: Files, 100%$/ });
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    const kept = await selected.elementHandle(), before = await selected.boundingBox();
    await page.locator("#navigationCollapse").click();
    await expect.poll(async () => Math.abs((await selected.boundingBox()).x - before.x)).toBeGreaterThan(5);
    await expect(page.locator("#sidebar")).not.toHaveAttribute("data-navigation-moving");
    assert.equal(await kept.evaluate(node => node.isConnected), true);
    await selected.hover();
    await expect(page.locator("#trendsTooltip")).toContainText("1 of 1 call");
    await page.keyboard.press("Escape");
    await panel.getByRole("button", { name: /View (?:evidence|1 call)/i }).click();
    await expect(page.locator(".trends-evidence-row a")).toHaveCount(1);
    const href = await page.locator(".trends-evidence-row a").getAttribute("href");
    const link = new URL(href, page.url());
    assert.equal(link.pathname, "/request"); assert.equal(link.searchParams.get("privateView"), "required");
    assert.ok(!link.searchParams.has("call") && !link.searchParams.has("request"));
    await expect(page.locator(".trends-evidence-context")).toHaveText("Read the invented drive/root sample");
    assert.equal(reads.length, count);
    assert.deepEqual(errors, []);
});
