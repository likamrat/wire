import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { fixture, chooseTheme, navigateMain, selectActivityOption } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_RESPONSIVE_PROOFS;
const paths = ["/me/messages", "/me/events", "/me/drive/root/children", "/teams/synthetic/channels",
    "/me/contacts", "/me/planner/tasks", "/me/onenote/pages", "/groups", "/search/query"];
const records = paths.flatMap((endpoint, category) => Array.from({ length: 10 - category }, (_, index) => {
    const row = fixture(`responsive-${category}-${index}`);
    row.userPrompt.text = "SYNTHETIC responsive chart request";
    row.sourceSessionName = "Synthetic responsive chart";
    row.toolCalls[0].requestedApiPath = endpoint;
    row.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
    row.toolCalls[0].startedAt = `2026-09-${String(category + 1).padStart(2, "0")}T12:00:00Z`;
    return row;
}));

async function setup(t) {
    const original = structuredClone(records), errors = [], requests = [];
    let revision = 1;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "responsive-fixture")); return;
        }
        requests.push(req.url);
        let body = ""; for await (const part of req) body += part;
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403; res.end('{"error":"Only synthetic snapshot reads are allowed."}'); return;
        }
        res.end(JSON.stringify({
            revision, scenarios: records, exports: [], coverage: { since: "2026-09-01", until: "2026-09-09", notes: [] },
            analytics: { ...buildActivityAnalytics(records, JSON.parse(body)), revision },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage({ reducedMotion: "reduce", hasTouch: true });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []); assert.deepEqual(records, original);
        assert.ok(requests.every(route => ["/api/snapshot", "/api/evaluation/automatic/summary"].includes(route)), "Only snapshot and read-only evaluator summary requests; unsupported summary is rejected by the fixture");
    });
    if (proofDir) await mkdir(proofDir, { recursive: true });
    return { page, url: `http://127.0.0.1:${server.address().port}/`, advance: () => revision++ };
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function measure(page) {
    return page.evaluate(() => {
        const rect = node => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, center: r.x + r.width / 2 };
        };
        const scroll = document.querySelector(".dimensional-scroll"), scene = document.querySelector(".dimensional-plot,.flat-time-plot");
        const main = document.querySelector("#main"), panel = document.querySelector(".chart-panel");
        return {
            viewport: innerWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth,
            main: main && rect(main), panel: rect(panel), scroll: { ...rect(scroll), client: scroll.clientWidth, extent: scroll.scrollWidth, left: scroll.scrollLeft },
            scene: rect(scene), flat: scene.classList.contains("flat-time-plot"), pitch: parseFloat(scene.style.getPropertyValue("--scene-pitch")),
            guidance: document.querySelector("#chartFooter")?.textContent || "",
            columns: [...scene.querySelectorAll(".dimensional-category,.time-slot")].map(node => {
                const faces = [...node.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap,.flat-time-segment")].map(rect);
                const svg = node.querySelector(".dimensional-column,.flat-time-column"), action = node.querySelector("button,a");
                return { slot: rect(node), label: node.querySelector(".group-name") && rect(node.querySelector(".group-name")),
                    count: rect(node.querySelector(".dimensional-count")), total: Number(svg?.dataset.total || 0), maximum: Number(svg?.dataset.maximum || 1),
                    edge: Number(svg?.dataset.frontHeight ?? svg?.getAttribute("height") ?? 0), extent: Number(svg?.dataset.plotHeight || 280), action: action && rect(action),
                    paintCenter: faces.length ? (Math.min(...faces.map(r => r.x)) + Math.max(...faces.map(r => r.right))) / 2 : null };
            }),
        };
    });
}
function valid(metrics) {
    assert.ok(metrics.pageOverflow <= 1, "No page-level horizontal overflow");
    for (const column of metrics.columns) {
        assert.ok(Math.abs(column.count.center - column.slot.center) < 1, "Exact value stays on the painted centerline");
        if (column.label) assert.ok(Math.abs(column.label.center - column.slot.center) < 1, "Label stays centered");
        if (column.paintCenter !== null) assert.ok(Math.abs(column.paintCenter - column.slot.center) < 1, "Glass silhouette stays centered");
        assert.ok(Math.abs(column.edge - (metrics.flat ? column.total / column.maximum * column.extent
            : column.total ? Math.max(36, Math.sqrt(column.total / column.maximum) * column.extent) : 0)) < .01, "Visual height matches the declared count scale");
        if (column.action) assert.ok(column.action.width <= 116 && column.action.height <= column.extent + 23.05, "No invisible expanded hit target");
    }
}
async function proof(page, name, metrics) {
    if (!proofDir) return;
    await writeFile(path.join(proofDir, `${name}.json`), JSON.stringify(metrics, null, 2));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proofDir, `${name}.png`), fullPage: false });
    const clip = await page.locator(".chart-panel").boundingBox();
    await page.screenshot({ path: path.join(proofDir, `${name}-chart.png`), fullPage: true, clip });
}

test("responsive scene pitch is bounded, font-aware and keeps the entire projected floor inside its gutters", () => {
    const charts = createDimensionalCharts();
    for (const time of [false, true]) for (const length of [0, 1, 2, 9, 13, 45]) for (const availableWidth of [280, 620, 1600, 2240, 3120]) {
        const maximum = 100000;
        const scene = charts.scene({ length, maximum, time, availableWidth });
        assert.ok(scene.pitch >= (time ? 96 : 160));
        assert.ok(scene.pitch <= (time ? 144 : 248));
        assert.equal(scene.dimensions.frontHeight, 280);
        assert.equal(scene.dimensions.width, time ? 60 : 116);
        if (!length) continue;
        const floor = charts.plane(scene, Array.from({ length }, () => ({ total: maximum, service: "Mail" })));
        assert.match(floor, /dimensional-ground-edge/);
        assert.match(floor, /dimensional-ground-surface/);
    }
    assert.equal(charts.scene({ length: 9, maximum: 10, availableWidth: 1600 }).width, 1600);
    assert.equal(charts.scene({ length: 9, maximum: 10, availableWidth: 2240, minimumPitch: 232 }).width, 2240);
    assert.ok(charts.scene({ length: 2, maximum: 10, availableWidth: 3120 }).width < 600);
    for (const options of [{ availableWidth: -1 }, { availableWidth: Infinity }, { minimumPitch: 60 }, { maximumPitch: 100 }]) {
        assert.throws(() => charts.scene({ length: 9, maximum: 10, ...options }), /Scene spacing/);
    }
});

test("nine services use available widescreen workspace instead of overflowing a capped card", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.setViewportSize({ width: 2560, height: 1100 });
    await page.goto(url + "#home?chart=workload"); await ready(page);
    const metrics = await measure(page); await proof(page, "widescreen-regression", metrics);
    assert.equal(metrics.columns.length, 9);
    assert.equal(metrics.scroll.extent, metrics.scroll.client, "All nine categories fit when the workspace has sufficient usable width");
    assert.ok(metrics.panel.right >= metrics.viewport - 30, "Chart reaches the main right gutter instead of stopping at 1440px");
    assert.ok(metrics.scene.width >= metrics.scroll.client - 12, "Useful scene spacing consumes the released width at 2560px");
    valid(metrics);
});

test("actual chart containers respond across themes, text enlargement, drawer changes and live resize", { timeout: 90000 }, async t => {
    const { page, url } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.goto(url + `?responsive-proof=${theme}-${scale}#home?chart=workload`); await ready(page); await chooseTheme(page, theme);
        assert.equal(await page.locator("#serviceDefinitions").evaluate(node => node.open), false);
        assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), false, "Exact data starts collapsed behind its named disclosure");
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        for (const width of [375, 820, 1200, 1466, 1920, 2560, 3440]) {
            await page.setViewportSize({ width, height: 1300 }); await ready(page);
            const metrics = await measure(page); valid(metrics);
            assert.equal(metrics.columns.length, 9);
            assert.ok(metrics.panel.right >= width - 30, "Chart keeps the available workspace budget");
            const overflowing = metrics.scroll.extent > metrics.scroll.client + 1;
            assert.equal(/Scroll for more categories/.test(metrics.guidance), overflowing, "Guidance follows measured overflow");
            if (width >= (scale === 1 ? 1920 : 2560)) assert.equal(overflowing, false);
            if (width === 375) {
                assert.equal(overflowing, true);
                await page.locator("#navigationToggle").click();
                assert.equal(await page.locator("#navigationDrawer").evaluate(node => node.open), true);
                await page.keyboard.press("Escape");
            }
            measurements.push({ theme, scale, width, ...metrics });
            if ([375, 3440].includes(width)) await proof(page, `${theme}-${width}-text-${scale}`, metrics);
        }
        if (!await page.locator("#tableDisclosure").evaluate(node => node.open)) await page.locator("#tableDisclosure > summary").click();
        assert.ok(await page.locator("#countTable table").evaluate(node => node.getBoundingClientRect().width < 1500), "Exact table stays compact, not chart-wide");
        if (!await page.locator("#serviceDefinitions").evaluate(node => node.open)) await page.locator("#serviceDefinitions > summary").click();
        assert.equal(await page.locator("#serviceDefinitions").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "First opening after text enlargement stays contained");
    }
    if (proofDir) await writeFile(path.join(proofDir, "responsive-matrix.json"), JSON.stringify(measurements, null, 2));
});

test("overflow remains reachable and chart reading position survives snapshots and Back", { timeout: 30000 }, async t => {
    const { page, url, advance } = await setup(t);
    await page.setViewportSize({ width: 820, height: 1100 });
    await page.goto(url + "#home?chart=workload"); await ready(page);
    const last = page.locator(".dimensional-action").last();
    await last.focus();
    await page.keyboard.press("Escape");
    const before = await measure(page);
    assert.ok(before.scroll.left > 0);
    const key = await last.getAttribute("data-group-id");
    advance();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await ready(page);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.groupId), key, "Live snapshot preserves focused category");
    assert.ok(Math.abs((await measure(page)).scroll.left - before.scroll.left) < 2, "Live snapshot preserves horizontal reading");
    await page.keyboard.press("Enter"); await ready(page);
    assert.match(page.url(), /#home.*expanded=true|#activity/);
    await page.goBack(); await ready(page);
    assert.ok(Math.abs((await measure(page)).scroll.left - before.scroll.left) < 2, "Back restores chart scroll");
    await page.setViewportSize({ width: 2560, height: 1100 }); await ready(page);
    assert.equal((await measure(page)).scroll.extent, (await measure(page)).scroll.client);
    await page.setViewportSize({ width: 375, height: 1100 }); await ready(page);
    const scroll = page.locator(".dimensional-scroll");
    await scroll.scrollIntoViewIfNeeded();
    await scroll.evaluate(node => { node.scrollLeft = 0; });
    await scroll.focus(); await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".dimensional-scroll").scrollLeft > 0);
    await scroll.evaluate(node => { node.scrollLeft = 0; });
    const bounds = await scroll.boundingBox(), cdp = await page.context().newCDPSession(page);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 120 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    for (const distance of [20, 40, 80, 120, 160]) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x - distance }] });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => document.querySelector(".dimensional-scroll").scrollLeft > 0);
    await cdp.detach();
    await page.locator(".dimensional-action").last().focus();
    assert.ok(await scroll.evaluate(node => node.scrollLeft > 0));
    assert.equal(await page.locator(".dimensional-category .ux-help").count(), 0);
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await page.keyboard.press("Escape");
    await navigateMain(page, "reports"); await ready(page);
    await navigateMain(page, "home"); await ready(page);
    await page.setViewportSize({ width: 2560, height: 1100 }); await ready(page);
    assert.equal((await measure(page)).scroll.extent, (await measure(page)).scroll.client);
});

test("time, API paths, filters and empty states share responsive workspace without changing category semantics", { timeout: 30000 }, async t => {
    const { page, url } = await setup(t);
    await page.setViewportSize({ width: 2560, height: 1100 });
    await page.goto(url + "#home?bucket=day"); await ready(page);
    for (const chart of ["time", "workload", "endpoint"]) {
        await page.locator(`[data-chart="${chart}"]`).click(); await ready(page);
        const metrics = await measure(page); valid(metrics);
        assert.equal(metrics.scroll.extent, metrics.scroll.client);
        const button = page.getByRole("button", { name: "Show all", exact: true });
        if (await button.count()) {
            const sum = metrics.columns.reduce((total, column) => total + column.total, 0);
            await button.click(); await ready(page);
            assert.equal((await measure(page)).columns.reduce((total, column) => total + column.total, 0), sum);
        }
    }
    await selectActivityOption(page, "serviceFilter", "Mail"); await ready(page);
    assert.equal((await measure(page)).columns.length, 1);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    assert.equal(await page.locator(".dimensional-scroll").count(), 0);
    assert.match(await page.locator("#chart").textContent(), /No matching results in this view/);
    assert.equal(await page.getByRole("button", { name: "Clear recorded result filter", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "Clear recorded result filter", exact: true }).click(); await ready(page);
    assert.equal((await measure(page)).columns.length, 1);
    assert.equal(await page.locator("#serviceFilter").inputValue(), "Mail");
});

test("a wide host with a narrow hidden panel measures its own container and keeps bounded sparse scenes", { timeout: 40000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 3440, height: 1200 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<html><head><style>${styles}</style></head><body><div id="host" style="width:420px" hidden><section class="chart-panel"><div id="chart"></div></section></div></body></html>`);
    await page.evaluate(() => {
        const NativeObserver = ResizeObserver;
        window.chartObservers = new Set();
        window.ResizeObserver = class extends NativeObserver {
            constructor(callback) { super(callback); window.chartObservers.add(this); }
            disconnect() { super.disconnect(); window.chartObservers.delete(this); }
        };
    });
    await page.addScriptTag({ content: `window.charts = (${createDimensionalCharts.toString()})(); window.ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    for (const amount of [0, 1, 2, 9, 13]) {
        await page.evaluate(({ amount, icons }) => {
            const current = document.querySelector(".dimensional-scroll");
            if (current) window.charts.disposeView(current);
            const groups = Array.from({ length: amount }, (_, index) => ({
                id: `synthetic-${index}`, label: Object.keys(window.charts.servicePalette)[index],
                name: `Synthetic long category name ${index}`, total: index === 0 ? amount === 13 ? Number.MAX_SAFE_INTEGER : 100000 : index === 1 ? 1 : index + 2,
            }));
            document.querySelector("#chart").replaceChildren(window.charts.comparisonView({
                groups, serviceMode: true, label: group => group.name, summary: group => `${group.name}: ${group.total}`,
                icons, onSelect() {}, tooltip: window.ux.tooltip,
                help: group => window.ux.helpButton(group.name, "Synthetic definition"),
            }));
        }, { amount, icons: dimensionalIcons });
        await page.evaluate(() => {
            document.documentElement.style.fontSize = "200%";
            document.querySelector("#host").hidden = false;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        let metrics = await measure(page); valid(metrics);
        assert.ok(metrics.scroll.client < 420, "Uses panel width, not3440px viewport");
        if (amount >= 9) assert.ok(metrics.scroll.extent > metrics.scroll.client);
        if (amount <= 2) assert.ok(metrics.pitch <= 336, "Sparse scenes never stretch bars or invent giant gaps");
        if (amount === 2) await page.locator(".dimensional-action").first().focus();
        await page.evaluate(() => document.querySelector("#host").style.width = "2400px");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        metrics = await measure(page); valid(metrics);
        if (amount === 9) assert.equal(metrics.scroll.client, metrics.scroll.extent);
        assert.equal(await page.evaluate(() => window.chartObservers.size), 1, "Replacing a view disconnects its old observer");
        if (amount === 2) {
            assert.equal(await page.locator(".dimensional-action").first().evaluate(node => node === document.activeElement), true);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            await page.keyboard.press("Escape");
        }
        await page.evaluate(() => {
            document.querySelector("#host").hidden = true;
            document.querySelector("#host").style.width = "420px";
        });
    }
    await page.evaluate(() => window.charts.disposeView(document.querySelector(".dimensional-scroll")));
    assert.equal(await page.evaluate(() => window.chartObservers.size), 0, "Explicit cleanup leaves no chart observer");
    assert.deepEqual(errors, []);
});
