import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, closeAnalyzeFilters } from "./helpers.mjs";

const proof = process.env.WIRE_RECORDED_OUTCOMES_PROOFS;
const baselinePath = process.env.WIRE_RECORDED_OUTCOMES_BASE;
const previousPath = process.env.WIRE_RECORDED_OUTCOMES_PREVIOUS;
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

async function setup(t, total) {
    const cleanup = [], { context } = await privateFixture({ after: action => cleanup.push(action) }, records(total));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory: async () => { throw new Error("No provider calls in outcome sizing proof"); },
            readSource: async () => { throw new Error("No source reads in outcome sizing proof"); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", timezoneId: "UTC" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
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
        const scope = document.getElementById("analyzeScopeSummary");
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
        document.querySelector("#outcomeChart .percentage-card").append(scope);
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
        return { text: node.textContent, font: css.fontFamily, size: parseFloat(css.fontSize),
            rectangles, clearance: Math.min(...rectangles.flatMap(rect =>
                [rect.left, rect.right].flatMap(x => [rect.top, rect.bottom].map(y =>
                    innerRadius - Math.hypot(x - center.x, y - center.y))))),
            clipped: node.scrollWidth > node.clientWidth + 1, ellipsis: css.textOverflow === "ellipsis" };
    };
    const legend = root.querySelector(".percentage-legend");
    const card = root.querySelector(".percentage-card"), scope = document.querySelector("#analyzeScopeSummary");
    return { paintedDiameter: 208 * scale, innerDiameter: 132 * scale, value: text(".percentage-total-value"),
        unit: text(".percentage-total-unit"), widget: box(card), legend: box(legend),
        ring: box(root.querySelector(".percentage-visual")),
        bottomGap: box(card).bottom - Math.max(box(legend).bottom, box(root.querySelector(".percentage-visual")).bottom),
        footerVisible: scope.checkVisibility(), footer: scope.innerText,
        rows: [...legend.children].map(row => ({ category: row.dataset.category, count: +row.dataset.count,
            percentage: row.dataset.percentage, label: box(row.querySelector(".percentage-label")),
            value: box(row.querySelector(".percentage-value")) })),
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        fontLoaded: document.fonts.check('600 30px "Asta Sans"'),
        slices: [...root.querySelectorAll(".percentage-slice")].map(node => ({
            count: +node.dataset.count, fraction: +node.dataset.exactFraction, d: node.getAttribute("d"),
            href: node.parentElement.getAttribute("href"),
        })) };
}

test("the tool-call widget names its measured result in the normal shell", async t => {
    const page = await setup(t, 239), url = page.url();
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
        await ready(page);
        const card = page.locator('#outcomeChart [data-percentage-card="outcomes"]');
        await expect(card).toHaveAccessibleName("Tool call results");
        await expect(card.locator(".percentage-total-value")).toHaveText("239");
        await expect(card.locator(".percentage-ring")).toHaveAttribute("aria-label", /^Tool call results\. 239 Work IQ tool calls\./);
        if (proof) await card.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-title.png`) });
    }
});

test("Recorded outcomes fits full five-digit totals in the normal shell without a default footer", async t => {
    const measurements = [], baseline = baselinePath ? JSON.parse(await readFile(baselinePath, "utf8")) : [];
    const previous = previousPath ? JSON.parse(await readFile(previousPath, "utf8")) : [];
    if (proof) await mkdir(proof, { recursive: true });
    for (const total of [239, 10000, 99999]) {
        const cleanup = [];
        try {
            const page = await setup({ after: action => cleanup.push(action) }, 239);
            // Large totals exercise the production renderer, not source ingestion or snapshot latency.
            if (total !== 239) await renderCount(page, total);
            const states = total === 239 ? [["light", 1440, 100], ["dark", 1440, 100]]
                : total === 10000 ? [["light", 1440, 100]]
                    : [["light", 1440, 100], ["dark", 1440, 100], ["dark", 768, 100],
                        ["light", 375, 100], ["dark", 375, 100], ["light", 1440, 200], ["dark", 375, 200],
                        ["light", 1440, 100, 2]];
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
                const key = `${total}-${theme}-${width}-${textScale}${zoom === 1 ? "" : "-zoom2"}`, value = await page.evaluate(measure);
                measurements.push({ key, total, theme, width, textScale, zoom,
                    fixture: total === 239 ? "native snapshot" : "canonical renderer in native shell", ...value });
                if (proof) {
                    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
                    await page.screenshot({ path: path.join(proof, `${key}-context.png`) });
                    await page.locator(".analyze-outcome-summary").screenshot({ path: path.join(proof, `${key}-widget.png`) });
                }
            }
        } finally { for (const action of cleanup.reverse()) await action(); }
    }
    if (proof) await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
    for (const current of measurements) {
        assert.equal(current.value.text, current.total.toLocaleString("en-US"), current.key);
        assert.equal(current.unit.text, "tool calls", current.key);
        assert.equal(current.fontLoaded, true, current.key);
        assert.equal(current.reducedMotion, false, "Proof waits for real motion; it does not disable it");
        assert.equal(current.value.size, (current.total === 239 ? 30 : 20) * current.textScale / 100, current.key);
        assert.equal(current.unit.size, 14 * current.textScale / 100, current.key);
        if (current.width === 1440 && current.textScale === 100 && current.zoom === 1) {
            assert.ok(Math.abs(current.paintedDiameter - 208 * 208 / 240) < .01, current.key);
            assert.ok(current.bottomGap <= 12, `${current.key}: tightened space below the legend`);
            assert.ok(current.widget.height <= 280, `${current.key}: side-by-side widget stays content-sized`);
        }
        if (current.width / current.zoom >= 768) {
            assert.ok(current.legend.x >= current.ring.right + 15, `${current.key}: labels and values sit on the wheel's right`);
            assert.ok(current.legend.y < current.ring.bottom && current.legend.bottom > current.ring.y, `${current.key}: one aligned horizontal group`);
        } else assert.ok(current.legend.y >= current.ring.bottom, `${current.key}: narrow widths stack without squeezing the legend`);
        assert.equal(current.footerVisible, false, `${current.key}: default scope leaves no footer or divider`);
        assert.ok(current.bottomGap <= 32, `${current.key}: no empty footer band (${current.bottomGap})`);
        for (const label of [current.value, current.unit]) {
            assert.ok(label.clearance >= 2, `${current.key}: text rectangles conservatively clear the inner edge by ${label.clearance}px`);
            assert.equal(label.rectangles.length, 1, `${current.key}: center text stays on one line`);
            assert.equal(label.clipped || label.ellipsis, false, current.key);
        }
        assert.ok(current.pageOverflow <= 1, current.key);
        assert.equal(current.rows.reduce((sum, row) => sum + row.count, 0), current.total);
        assert.ok(current.rows.every(row => row.label.right <= current.widget.right && row.value.right <= current.widget.right));
        assert.ok(Math.max(...current.rows.map(row => row.value.x)) - Math.min(...current.rows.map(row => row.value.x)) < 1
            || Math.max(...current.rows.map(row => row.value.right)) - Math.min(...current.rows.map(row => row.value.right)) < 1,
        `${current.key}: legend values align on a shared edge`);
        for (const slice of current.slices) assert.equal(slice.fraction, slice.count / current.total);
        const before = baseline.find(row => row.key === current.key);
        if (before) {
            assert.ok(current.paintedDiameter > before.paintedDiameter, current.key);
            assert.ok(current.value.size > before.value.size, current.key);
            assert.ok(current.unit.size > before.unit.size, current.key);
            assert.deepEqual(current.slices, before.slices, "Sizing does not change paths, math or destinations");
            assert.deepEqual(current.rows.map(({ category, count, percentage }) => ({ category, count, percentage })),
                before.rows.map(({ category, count, percentage }) => ({ category, count, percentage })));
        }
        const admitted = previous.find(row => row.key === current.key);
        if (admitted && current.width === 1440 && current.textScale === 100 && current.zoom === 1) {
            assert.ok(current.paintedDiameter >= admitted.paintedDiameter * 1.3 - .01, current.key);
            assert.ok(current.widget.height <= admitted.widget.height + 8, "The larger wheel fills existing space instead of inflating the widget");
            assert.ok(current.widget.height < admitted.widget.height - 100, "Side-by-side composition removes the unused vertical band");
            assert.equal(current.value.size, admitted.value.size, "Keep the admitted center typography");
            assert.equal(current.unit.size, admitted.unit.size, "Keep the admitted center typography");
        }
    }
});

test("outcome scope, hover, keyboard, slices and zero/missing states retain their behavior", async t => {
    const page = await setup(t, 239);
    await expect(page.locator("#activityListSummary")).toHaveText("3 interactions with 239 matching Work IQ tool calls");
    const label = page.locator('#outcomeChart [data-category="failure"] .percentage-label');
    const slice = page.locator('#outcomeChart .percentage-slice[data-category="failure"]');
    await label.hover(); await expect(slice).toHaveClass(/percentage-active/);
    await page.mouse.move(0, 0); await label.focus();
    assert.ok(await label.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth) >= 2));
    await page.keyboard.press("Enter"); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("32");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Outcome: Tool failed");
    await expect(page.locator("#analyzeScopeSummary")).toBeVisible();
    await selectActivityOption(page, "outcomeFilter", "all"); await closeAnalyzeFilters(page); await ready(page);
    await slice.scrollIntoViewIfNeeded();
    const point = await slice.evaluate(node => {
        const angle = (+node.dataset.start + +node.dataset.end) * Math.PI + Math.PI / 2;
        return new DOMPoint(85 * Math.cos(angle), 85 * Math.sin(angle)).matrixTransform(node.getScreenCTM()).toJSON();
    });
    await page.mouse.click(point.x, point.y); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("32");
    await selectActivityOption(page, "outcomeFilter", "unknown"); await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("1");
    await expect(page.locator("#outcomeChart .percentage-total-unit")).toHaveText("tool call");
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction with 1 matching Work IQ tool call");
    await expect(page.locator("#outcomeChart .percentage-slice")).toHaveAttribute("data-exact-fraction", "1");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Outcome: No result recorded");
    await selectActivityOption(page, "outcomeFilter", "partial"); await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("0");
    await expect(page.locator("#activityListSummary")).toHaveText("0 interactions with 0 matching Work IQ tool calls");
    assert.equal(await page.locator("#outcomeChart .percentage-slice").count(), 0);
    await expect(page.locator("#analyzeEmptyScope")).toBeVisible();
    await expect(page.locator("#analyzeScopeCaption")).toContainText("Partly worked");
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await selectActivityOption(page, "scopeFilter", "all"); await closeAnalyzeFilters(page); await ready(page);
    await expect(page.locator("#outcomeChart .percentage-total-value")).toHaveText("239");
    await expect(page.locator("#analyzeScopeCaption")).toHaveText("Both collections");
    await expect(page.locator("#analyzeScopeSummary")).toBeVisible();
});
