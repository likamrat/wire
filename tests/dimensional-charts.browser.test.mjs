import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { chooseTheme, openActivitySessions } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_DIMENSIONAL_PROOFS;
const definitions = [
    ["/me/messages", 81, "01"], ["/me/events", 39, "02"],
    ["/me/drive/root/children", 112, "04"], ["/teams/synthetic/channels", 65, "05"],
    ["/unknown", 1, "06"],
];
const records = definitions.flatMap(([endpoint, count, day]) => Array.from({ length: count }, (_, index) => ({
    scenarioId: `synthetic-column-${day}-${index}`, sourceSessionId: "synthetic-column-session",
    sourceSessionName: "Synthetic dimensional chart examples", projectId: "synthetic-chart-project", project: "Synthetic charts",
    capturedAt: `2026-09-${day}T12:00:00Z`, workflowState: "ready_to_export",
    userPrompt: { text: `SYNTHETIC ONLY column request ${day} ${index}`, status: "full" },
    toolCalls: [{
        tool: "workiq-fetch", toolCallId: `synthetic-column-call-${day}-${index}`,
        startedAt: `2026-09-${day}T12:00:00Z`, requestedApiPath: endpoint,
        requestArgs: { entityUrls: [endpoint] }, toolSucceeded: index % 7 !== 0,
        reportedOutcome: index % 7 !== 0 ? "succeeded" : "failed", apiResults: [],
    }],
})));

async function fixture(run, source = records) {
    const before = structuredClone(source), requests = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-dimensional-fixture'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
            res.end(renderHtmlShell("a".repeat(64), "dimensional-fixture")); return;
        }
        requests.push(req.url);
        let text = ""; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") res.end(JSON.stringify({
            revision: 1, scenarios: source, exports: [], coverage: { notes: [] },
            analytics: { ...buildActivityAnalytics(source, input), revision: 1 },
        }));
        else { res.statusCode = 403; res.end('{"error":"Only synthetic snapshot reads are allowed."}'); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const url = `http://127.0.0.1:${server.address().port}`;
    context.on("page", page => {
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => assert.equal(new URL(request.url()).origin, url, "Charts have no external resources"));
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        readText: () => { throw new Error("No clipboard reads in chart proof."); },
        writeText: () => { throw new Error("No clipboard writes in chart proof."); },
    } }));
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url, requests });
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => ["/api/snapshot", "/api/evaluation/automatic/summary"].includes(route)), "Only snapshot and read-only summary requests");
        assert.deepEqual(source, before);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
async function measure(page) {
    return page.locator(".dimensional-column,.flat-time-column").evaluateAll(nodes => nodes.map(svg => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const action = svg.closest("button,a");
        return {
            total: Number(svg.dataset.total), maximum: Number(svg.dataset.maximum),
            frontHeight: Number(svg.dataset.frontHeight ?? svg.getAttribute("height")), extent: Number(svg.dataset.plotHeight), depth: Number(svg.dataset.depth || 0),
            svg: rect(svg), action: rect(action),
            front: [...svg.querySelectorAll(".dimensional-front,.flat-time-segment")].map(node => {
                const matrix = node.getScreenCTM();
                return { ...rect(node), count: Number(node.dataset.count), edgeHeight: node.height.baseVal.value * matrix.d,
                    baseY: new DOMPoint(0, node.y.baseVal.value + node.height.baseVal.value).matrixTransform(matrix).y };
            }),
            cap: svg.querySelectorAll(".dimensional-cap").length,
            caption: action.closest(".dimensional-category")?.querySelector(".group-name")?.textContent,
        };
    }));
}

test("dimensional service columns: real geometry and bright named categories in both themes at 375/820/1200", { timeout: 60000 }, async () => fixture(async ({ context, url }) => {
    const all = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto(url + "/#home?chart=workload"); await ready(page);
        await chooseTheme(page, theme);
        assert.equal(await page.locator("#activityCount").innerText(), "298");
        const columns = await measure(page);
        assert.equal(columns.length, 5);
        assert.equal(columns.reduce((sum, column) => sum + column.total, 0), 298);
        for (let index = 0; index < columns.length; index++) {
            const column = columns[index];
            assert.ok(Math.abs(column.front.reduce((sum, face) => sum + face.edgeHeight, 0) - Math.max(36, Math.sqrt(column.total / column.maximum) * column.extent)) < .05);
            assert.equal(column.action.width, column.svg.width);
            assert.ok(Math.abs(column.action.height - column.svg.height) < 1);
            assert.ok(column.action.width <= 116);
            assert.ok(Math.abs(column.front.at(0).baseY - columns[0].front.at(0).baseY) < .05, "Every front base lies on the same horizontal zero line");
            if (index > 0) assert.ok(column.svg.x - columns[index - 1].svg.right >= 8, "Facets never overlap");
            if (column.total === 1) {
                assert.equal(column.cap, 1, "Small columns retain a neutral dimensional lid");
                assert.ok(column.depth > 0);
                assert.equal(column.frontHeight, 36, "The disclosed visual minimum preserves the one-action label");
            } else assert.equal(column.cap, 1);
        }
        assert.equal(await page.locator(".dimensional-category-icon svg").count(), 0, "Service names are directly below columns without a redundant icon lane");
        assert.equal(await page.locator("#chartReadingNotes").isVisible(), false);
        assert.match(await page.locator("#chartReadingNotes").textContent(), /color identifies the activity category/i);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const plot = await page.locator(".dimensional-plot").boundingBox();
        const before = page.url();
        await page.mouse.click(plot.x + 35, plot.y + 20);
        assert.equal(page.url(), before);
        if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `services-${theme}-${width}.png`) });
        const first = page.locator(".dimensional-action").first();
        await first.focus();
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Enter"); await ready(page);
        assert.match(page.url(), /#activity/);
        await page.goBack(); await ready(page);
        assert.equal(page.url(), before);
        await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
        assert.equal(new URL(page.url()).hash, "#home");
        all.push({ theme, width, columns });
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "dimensional-geometry.json"), JSON.stringify(all, null, 2));
}));

test("time and API path faces retain result counts, tiny values, gaps, labels and scale", { timeout: 30000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(url + "/#home?bucket=day"); await ready(page);
    assert.equal(await page.locator(".time-zero").count(), 1);
    for (const column of await measure(page)) {
        assert.equal(column.front.reduce((sum, face) => sum + face.count, 0), column.total);
        assert.ok(Math.abs(column.front.reduce((sum, face) => sum + face.edgeHeight, 0) - column.frontHeight) < .05);
    }
    assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), false);
    await page.locator("#tableDisclosure>summary").click();
    assert.deepEqual(await page.locator("#countTable tbody tr td:nth-child(2)").allTextContents(), ["81", "39", "0", "112", "65", "1"]);
    assert.equal(await page.locator(".dimensional-time-labels > span").count(), 6);
    if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, "time-light-1200.png") });
    await page.locator('[data-chart="endpoint"]').click(); await ready(page);
    const columns = await measure(page);
    assert.equal(columns.length, 5);
    assert.ok(columns.some(column => column.caption.includes("/me/messages")));
    assert.match(await page.locator("#chartReadingNotes").textContent(), /Colors match the recorded results/);
    assert.match(await page.locator("#chartReadingNotes").textContent(), /Neutral tops mark the end/);
    if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, "paths-light-1200.png") });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.keyboard.press("Tab");
    await page.locator(".dimensional-action").first().focus();
    assert.notEqual(await page.locator(".dimensional-action .dimensional-count").first().evaluate(node => getComputedStyle(node).outlineStyle), "none");
    assert.equal(await page.locator(".dimensional-front").first().evaluate(node => getComputedStyle(node).fill), "rgb(0, 0, 0)");
    if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, "forced-colors.png") });
}));

test("45 daily labels remain aligned and scrollable with exact flat geometry and count targets", { timeout: 20000 }, async () => {
    const dense = Array.from({ length: 45 }, (_, index) => {
        const record = structuredClone(records[0]);
        record.scenarioId = `synthetic-dense-${index}`;
        record.capturedAt = new Date(Date.UTC(2026, 7, index + 1, 12)).toISOString();
        record.toolCalls[0].toolCallId = `synthetic-dense-call-${index}`;
        record.toolCalls[0].startedAt = record.capturedAt;
        return record;
    });
    await fixture(async ({ context, url }) => {
        const page = await context.newPage();
        await page.setViewportSize({ width: 375, height: 900 });
        await page.goto(url + "/#home?bucket=day"); await ready(page);
        const columns = await measure(page);
        assert.equal(columns.length, 45);
        assert.equal(await page.locator(".dimensional-time-labels > span").count(), 45);
        for (let index = 0; index < columns.length; index++) {
            assert.equal(columns[index].frontHeight, 200, "Equal values stay equal even in a dense plot");
            assert.ok(columns[index].action.width <= 84);
            if (index) assert.ok(columns[index].svg.x - columns[index - 1].svg.right >= 8);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const scroll = page.locator(".dimensional-scroll");
        assert.equal(await scroll.getAttribute("tabindex"), "0");
        await page.locator(".time-column").last().scrollIntoViewIfNeeded();
        assert.ok(await scroll.evaluate(node => node.scrollLeft > 0), "Later buckets are genuinely reachable");
        await page.keyboard.press("Tab");
        await page.locator(".time-column").last().focus();
        await page.keyboard.press("Enter"); await ready(page);
        assert.equal(await page.locator("#activityList .request-row").count(), 1);
        await page.goBack(); await ready(page);
        assert.equal(await page.locator(".time-column").count(), 45);
    }, dense);
});

test("weekly 9/28/9/121/50 small faces drill down once with local dates and restore unchanged counts", { timeout: 30000 }, async () => {
    const totals = [9, 28, 9, 121, 50];
    const days = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"];
    const source = totals.flatMap((total, week) => Array.from({ length: total }, (_, index) => {
        const record = structuredClone(records[0]);
        record.scenarioId = `synthetic-week-${week}-${index}`;
        record.capturedAt = `${days[week]}T00:30:00Z`;
        record.toolCalls[0].startedAt = record.capturedAt;
        record.toolCalls[0].toolCallId = `synthetic-week-call-${week}-${index}`;
        record.toolCalls[0].toolSucceeded = !(week === 2 && index < 3);
        record.toolCalls[0].reportedOutcome = record.toolCalls[0].toolSucceeded ? "succeeded" : "failed";
        return record;
    }));
    await fixture(async ({ context, url, requests }) => {
        const local = await context.browser().newContext({ timezoneId: "America/Los_Angeles", locale: "en-US", reducedMotion: "reduce" });
        try {
            const page = await local.newPage();
            page.setDefaultTimeout(3000);
            await page.goto(url + "/#home?bucket=week"); await ready(page);
            assert.deepEqual(await page.locator(".dimensional-time-labels > span").allTextContents(), ["Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28"]);
            assert.deepEqual((await measure(page)).map(column => column.total), totals);
            const original = page.url();
            for (const index of [0, 2]) {
                const before = requests.length;
                await page.locator(".time-column").nth(index).locator(".dimensional-count").click(); await ready(page);
                assert.equal(requests.length, before + 1, "One face click makes exactly one drilldown read");
                assert.match(page.url(), /#activity/);
                assert.match(await page.locator("#viewingContext").innerText(), /9 Work IQ tool calls/);
                assert.equal(await page.locator("#activityList .request-row").count(), 6);
                assert.match(await page.locator(".session-requests .pager").innerText(), /of 9 request groups/);
                assert.equal(await page.locator("#fromFilter").inputValue(), index === 0 ? "2026-08-31" : "2026-09-14");
                await page.goBack(); await ready(page);
                assert.equal(page.url(), original);
                assert.deepEqual((await measure(page)).map(column => column.total), totals);
                assert.equal(await page.getByRole("tooltip").isVisible(), false, "Back restores focus, not the dismissed tooltip");
                await page.locator(".time-column").nth(index).focus();
                await page.keyboard.press("Tab");
                await page.keyboard.press("Shift+Tab");
                assert.equal(await page.getByRole("tooltip").isVisible(), false);
                assert.match(await page.locator("#displayTimeZoneLink").getAttribute("aria-label"), /America\/Los_Angeles/);
                await page.keyboard.press("Escape");
                const keyBefore = requests.length;
                await page.keyboard.press("Enter"); await ready(page);
                assert.equal(requests.length, keyBefore + 1);
                assert.equal(await page.locator("#activityList .request-row").count(), 6);
                assert.match(await page.locator(".session-requests .pager").innerText(), /of 9 request groups/);
                await page.goBack(); await ready(page);
            }
            await page.locator(".time-column").first().locator(".flat-time-segment").click(); await ready(page);
            await page.getByRole("button", { name: "Reset to Home", exact: true }).click(); await ready(page);
            assert.equal(await page.locator("#activityCount").innerText(), "217");
        } finally { await local.close(); }
    }, source);
});
