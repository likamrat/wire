import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { buildActivityAnalytics } from "../../lib/activity-analytics.mjs";
import { createPercentageCharts } from "../../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../../lib/service-categories.mjs";
import { createRecordedResults } from "../../web/recorded-results.mjs";
import { createEvidenceUX } from "../../web/ux.mjs";
import { uxIcons } from "../../web/ux-icons.mjs";
import { dimensionalIcons } from "../../web/dimensional-icons.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters, fulfillFixtureUpdateStatus } from "../support/helpers.mjs";

const proof = process.env.WIRE_RECORDED_OUTCOMES_PROOFS;
const ready = async page => {
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.playState !== "running" || animation.effect.getComputedTiming().iterations === Infinity));
    await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
};

function records(total) {
    const worked = total === 239 ? 206 : Math.floor(total * .86);
    return Array.from({ length: Math.ceil(total / 100) }, (_, group) => {
        const record = fixture(`recorded-outcomes-sizing-${group}`);
        record.userPrompt.text = "Synthetic recorded outcomes sizing";
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: Math.min(100, total - group * 100) }, (_, offset) => {
            const index = group * 100 + offset;
            return { tool: "workiq-fetch", toolCallId: `sizing-${index}`, startEventId: `sizing-start-${index}`,
                startedAt: "2026-09-30T12:00:00.000Z",
                requestedApiPath: "/me/calendarView",
                toolSucceeded: index < worked ? true : index < total - 1 ? false : undefined,
                reportedOutcome: index < worked ? "succeeded" : index < total - 1 ? "failed" : "unknown" };
        });
        return record;
    });
}

async function setup(t, total, frontend) {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records(total));
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No provider calls in outcome sizing proof"); },
            readSource: async () => { throw new Error("No source reads in outcome sizing proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
        if (await fulfillFixtureUpdateStatus(route,new URL(runtime.url).origin)) return;
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list"];
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try { assert.deepEqual(errors, []); assert.deepEqual(denied, []); }
        finally { for (const action of cleanup.reverse()) await action(); }
    });
    const snapshot = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.goto(runtime.url); await snapshot; await ready(page);
    return page;
}

async function renderCount(page, total) {
    const source = records(239), analytics = buildActivityAnalytics(source);
    await page.evaluate(({ analytics, source, total, factories, icons, serviceIcons }) => {
        const make = value => (0, eval)(`(${value})`);
        const template = analytics.rows[0], worked = Math.floor(total * .86);
        // Minimal in-memory canonical chart rows avoid constructing a large retained collection.
        analytics.rows = Array.from({ length: total }, (_, index) => ({
            id: `size-${index}`, outcome: index < worked ? "success" : index < total - 1 ? "failure" : "unknown",
            tool: template.tool, workload: template.workload, serviceAssociation: template.serviceAssociation,
            endpoint: template.endpoint, targetCount: template.targetCount, targets: template.targets,
        }));
        const counts = { count: analytics.rows.length, success: 0, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 };
        for (const row of analytics.rows) counts[row.outcome]++;
        analytics.totals = counts;
        analytics.workloadGroups = [{ ...analytics.workloadGroups[0], ...counts, total: counts.count }];
        analytics.serviceInvolvement.denominator = counts.count;
        analytics.serviceInvolvement.groups = [{ ...analytics.serviceInvolvement.groups[0],
            total: counts.count, drilldownIds: analytics.rows.map(row => row.id) }];
        const links = new Map([...document.querySelectorAll(".percentage-legend-row")].map(row =>
            [`${row.closest(".percentage-card").dataset.breakdown}:${row.dataset.category}`, row.querySelector("a")?.getAttribute("href")]));
        document.getElementById("outcomeChart").replaceChildren();
        document.getElementById("percentageData").replaceChildren();
        const chart = make(factories.percentage)({ dimensional: make(factories.dimensional)(),
            categories: make(factories.categories)(), results: make(factories.results)(),
            ux: make(factories.ux)(icons), icons: serviceIcons,
            createLink(kind, row) {
                const href = links.get(`${kind}:${row.id}`);
                if (!href) return null;
                const link = document.createElement("a"); link.href = href; return link;
            } }).mount(document.getElementById("percentageCharts"), {
            outcomesHost: document.getElementById("outcomeChart"), dataHost: document.getElementById("percentageData"), includeModels: true,
        });
        chart.update(analytics, { layer: "tool", filters: { scope: "history" } }, source);
    }, { analytics, source, total, factories: { percentage: createPercentageCharts.toString(),
        dimensional: createDimensionalCharts.toString(), categories: createServiceCategories.toString(),
        results: createRecordedResults.toString(), ux: createEvidenceUX.toString() }, icons: uxIcons, serviceIcons: dimensionalIcons });
}

function measure() {
    const root = document.querySelector("#outcomeChart"), svg = root.querySelector("svg.percentage-ring");
    const box = node => node.getBoundingClientRect().toJSON();
    const matrix = svg.getScreenCTM(), center = new DOMPoint(120, 120).matrixTransform(matrix);
    const scale = matrix.a, innerRadius = 66 * scale;
    const text = selector => {
        const node = root.querySelector(selector), css = getComputedStyle(node);
        const range = document.createRange(); range.selectNodeContents(node);
        const rectangles = [...range.getClientRects()].map(rect => rect.toJSON());
        return { text: node.textContent, size: parseFloat(css.fontSize),
            rectangles, clearance: Math.min(...rectangles.flatMap(rect =>
                [rect.left, rect.right].flatMap(x => [rect.top, rect.bottom].map(y =>
                    innerRadius - Math.hypot(x - center.x, y - center.y))))),
            clipped: node.scrollWidth > node.clientWidth + 1, ellipsis: css.textOverflow === "ellipsis" };
    };
    const legend = root.querySelector(".percentage-legend");
    const card = root.querySelector(".percentage-card"), scope = document.querySelector("#analyzeScopeSummary");
    const ring = box(root.querySelector(".percentage-visual"));
    return { paintedDiameter: 208 * scale, value: text(".percentage-total-value"),
        unit: text(".percentage-total-unit"), widget: box(card), legend: box(legend),
        ring, bottomGap: box(card).bottom - Math.max(box(legend).bottom,ring.bottom),
        strip: [...root.querySelectorAll(".outcome-share-strip>*")].map(segment=>
            box(segment).width / box(segment.parentElement).width),
        scopeInWidget: card.contains(scope), scopeInCommands: document.getElementById("analyzeResultCommands").contains(scope),
        rows: [...legend.children].map(row => ({ category: row.dataset.category, count: +row.dataset.count,
            percentage: row.dataset.percentage, label: box(row.querySelector(".percentage-label")),
            value: box(row.querySelector(".percentage-value")) })),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        fontLoaded: document.fonts.check('600 30px "Asta Sans"'),
        slices: [...root.querySelectorAll(".percentage-slice")].map(node => ({
            count: +node.dataset.count, fraction: +node.dataset.exactFraction, d: node.getAttribute("d"),
            href: node.parentElement.getAttribute("href"),
        })) };
}

test("the tool-call widget names its measured result and fits five-digit totals without a default footer", async t => {
    const page = await setup(t, 239);
    for (const total of [239, 10000, 99999]) {
        if (total !== 239) {
            await page.reload(); await ready(page);
            await renderCount(page, total);
        }
        const states = total === 239 ? [["light", 1440, 100], ["dark", 1440, 100], ["light", 375, 200], ["dark", 375, 200]]
            : total === 10000 ? [["light", 1440, 100]]
                : [["light", 1440, 100], ["dark", 1440, 100], ["dark", 768, 100],
                    ["light", 375, 100], ["dark", 375, 100], ["light", 1440, 200], ["dark", 375, 200], ["light", 1440, 100, 2]];
        let first;
        for (const [theme, width, textScale, zoom = 1] of states) {
            await page.setViewportSize({ width: width / zoom, height: 1000 / zoom });
            if (zoom !== 1) {
                const cdp = await page.context().newCDPSession(page);
                await cdp.send("Emulation.setDeviceMetricsOverride", { width: width / zoom, height: 1000 / zoom,
                    deviceScaleFactor: zoom, mobile: false, screenWidth: width, screenHeight: 1000 });
            }
            await chooseTheme(page, theme);
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, textScale);
            await ready(page);
            if (total === 239) {
                const card = page.locator('#outcomeChart [data-percentage-card="outcomes"]');
                await expect(card).toHaveAccessibleName("Tool call results");
                await expect(card.locator(".percentage-ring")).toHaveAttribute("aria-label", /^Tool call results\. 239 Work IQ tool calls\./);
            }
            const current = await page.evaluate(measure);
            const key = `${total}/${theme}/${width}/${textScale}/${zoom}`;
            assertSizing(current, { total, width, textScale, zoom, key });
            const readings = { slices: current.slices, rows: current.rows.map(({ category, count, percentage }) => ({ category, count, percentage })) };
            if (first) assert.deepEqual(readings, first, `${key}: resizing must not alter paths, destinations or amounts`);
            else first = readings;
        }
    }
});

function assertSizing(current, { total, width, textScale, zoom, key }) {
    assert.equal(current.value.text, total.toLocaleString("en-US"), key);
    assert.equal(current.unit.text, "tool calls", key);
    assert.equal(current.fontLoaded, true, key);
    assert.ok(current.value.size > current.unit.size, key);
    assert.ok(current.unit.size >= 14 * textScale / 100, key);
    if (width === 1440 && textScale === 100 && zoom === 1) {
        assert.ok(current.paintedDiameter >= 160, `${key}: the wheel anchors the full-width card`);
    }
    if (current.legend.y < current.ring.bottom) {
        assert.ok(current.legend.x >= current.ring.right + 15, `${key}: labels and values sit on the wheel's right`);
        assert.ok(current.legend.bottom > current.ring.y, `${key}: one aligned horizontal group`);
    }
    assert.equal(current.scopeInWidget, false, `${key}: default scope leaves no footer or divider`);
    assert.equal(current.scopeInCommands, true, `${key}: result commands retain the scope`);
    assert.ok(current.bottomGap <= 32, `${key}: no empty footer band (${current.bottomGap})`);
    for (const label of [current.value, current.unit]) {
        assert.ok(label.clearance >= 4, `${key}: both center labels need padding inside the inner edge (${label.clearance}px clearance)`);
        assert.equal(label.rectangles.length, 1, `${key}: center text stays on one line`);
        assert.equal(label.clipped || label.ellipsis, false, key);
    }
    assert.ok(current.pageOverflow <= 1, key);
    assert.equal(current.rows.reduce((sum, row) => sum + row.count, 0), total);
    assert.ok(current.rows.every(row => row.label.right <= current.widget.right && row.value.right <= current.widget.right));
    const horizontal = current.rows[1].label.x > current.rows[0].label.right;
    if (horizontal) assert.ok(current.rows.every(row=>Math.abs(row.value.top-current.rows[0].value.top)<=1
        && row.value.top >= row.label.bottom-1), `${key}: a shared value line below the outcome labels`);
    else assert.ok(Math.max(...current.rows.map(row=>row.value.right))-Math.min(...current.rows.map(row=>row.value.right))<1
        || Math.max(...current.rows.map(row=>row.value.left))-Math.min(...current.rows.map(row=>row.value.left))<1,
        `${key}: narrow legend values share an edge`);
    for (const slice of current.slices) assert.equal(slice.fraction, slice.count / total);
    assert.equal(current.strip.length, current.slices.length, key);
    current.strip.forEach((fraction,i) => assert.ok(Math.abs(fraction-current.slices[i].fraction)<.001, key));
}

for (const frontend of ["bundled","react"]) test(`${frontend}: outcome scope, hover, keyboard, slices and zero/missing states retain their behavior`, async t => {
    const page = await setup(t, 239, frontend);
    await expect(page.locator("#activityListSummary")).toHaveText("3 interactions · 239 matching tool calls");
    const label = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
    const slice = page.locator('#outcomeChart .percentage-slice[data-category="failure"]');
    await chooseTheme(page,"dark");
    const root = page.locator("#outcomeChart"), strip = root.locator(".outcome-share-strip");
    for (const [index,category] of ["success","failure","unknown"].entries()) {
        const wedge = root.locator(`.percentage-slice[data-category="${category}"]`);
        const item = root.locator(`li[data-category="${category}"]`), name = item.locator(".percentage-label");
        const expected = `${await name.textContent()}\n${await item.getAttribute("data-percentage")} (${await item.getAttribute("data-count")} of 239 tool calls).`;
        await wedge.scrollIntoViewIfNeeded();
        const point = await wedge.evaluate(n=>{
            const angle=(+n.dataset.start + +n.dataset.end)*Math.PI + Math.PI/2;
            return new DOMPoint(85*Math.cos(angle),85*Math.sin(angle)).matrixTransform(n.getScreenCTM()).toJSON();
        });
        const segment = strip.locator(":scope > *").nth(index);
        await expect(segment).toHaveAttribute("tabindex","-1");
        await expect(segment).toHaveAttribute("href",await name.getAttribute("href"));
        for (const mark of ["strip","ring"]) {
            if (mark === "ring") await page.mouse.move(point.x,point.y); else await segment.hover();
            await expect(page.getByRole("tooltip")).toHaveText(expected);
            await expect(name).not.toHaveCSS("background-color","rgba(0, 0, 0, 0)");
            await expect(name).toHaveCSS("text-decoration-line","none");
            await expect(wedge).toHaveClass(/percentage-active/); await expect(segment).toHaveClass(/percentage-active/);
            if (proof && category === "unknown") {
                await mkdir(proof,{recursive:true});
                await page.screenshot({path:path.join(proof,`${frontend}-unknown-${mark}.png`)});
            }
        }
    }
    await page.mouse.move(0,0); await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(root.locator(".percentage-active")).toHaveCount(0);
    await label.hover(); await expect(slice).toHaveClass(/percentage-active/);
    const row=label.locator("..");
    await expect(row).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
    await expect(label).toHaveCSS("text-decoration-line","none");
    const hover=await label.evaluate(n=>getComputedStyle(n).backgroundColor);
    assert.notEqual(hover,"rgba(0, 0, 0, 0)");
    await page.mouse.down(); assert.notEqual(await label.evaluate(n=>getComputedStyle(n).backgroundColor),hover);
    await expect(label).toHaveCSS("text-decoration-line","none");
    await page.mouse.move(0,0); await page.mouse.up();
    await page.mouse.move(0, 0); await label.focus();
    assert.ok(await label.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 2));
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("32");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Outcome: Tool failed");
    await expect(page.locator("#analyzeResultCommands #analyzeScopeSummary")).toBeVisible();
    await selectActivityOption(page, "outcomeFilter", "all"); await closeAnalyzeFilters(page); await ready(page);
    await slice.scrollIntoViewIfNeeded();
    const point = await slice.evaluate(node => {
        const angle = (+node.dataset.start + +node.dataset.end) * Math.PI + Math.PI / 2;
        return new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle)).matrixTransform(node.getScreenCTM()).toJSON();
    });
    await page.mouse.click(point.x, point.y); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("32");
    await page.goBack(); await ready(page); await expect(label).toBeFocused();
    await strip.locator('[data-category="unknown"]').click(); await ready(page);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("1");
    await expect(page.locator("#outcomeChart .percentage-total-unit")).toHaveText("tool call");
    await expect(page.locator("#outcomeChart .outcome-share-strip>*")).toHaveCount(1);
    await expect(page.locator("#outcomeChart .outcome-zeros li")).toHaveCount(2);
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 1 matching tool call");
    await expect(page.locator("#activityList article")).toHaveAttribute("data-view-key","request:recorded-outcomes-sizing-2");
    await expect(page.locator("#outcomeChart .percentage-slice")).toHaveAttribute("data-exact-fraction", "1");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Outcome: No result recorded");
    await selectActivityOption(page, "outcomeFilter", "partial"); await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityListSummary")).toHaveText("0 interactions · 0 matching tool calls");
    assert.equal(await page.locator("#outcomeChart .percentage-slice").count(), 0);
    await expect(page.locator("#outcomeChart .outcome-share-strip")).toHaveCount(0);
    await expect(page.locator("#activityList article")).toHaveCount(0);
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Partial completion");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await selectActivityOption(page, "scopeFilter", "all"); await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("239");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Both collections");
    await expect(page.locator("#analyzeScopeSummary")).toBeVisible();
});
