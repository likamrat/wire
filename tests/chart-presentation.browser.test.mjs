import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { fixture, navigateMain, chooseTheme } from "./helpers.mjs";

const results = createRecordedResults();
const totals = [9, 28, 9, 121, 50];
const source = totals.map((total, week) => {
    const record = fixture(`chart-reading-${week}`);
    record.userPrompt.text = "Synthetic chart reading request";
    record.capturedAt = `2026-09-${String(1 + week * 7).padStart(2, "0")}T12:00:00Z`;
    record.toolCalls = Array.from({ length: total }, (_, index) => ({
        ...record.toolCalls[0], startedAt: record.capturedAt,
        toolCallId: `reading-call-${week}-${index}`, startEventId: `reading-start-${week}-${index}`,
    }));
    return record;
});
const ready = page => page.locator('#workspace[aria-busy="false"]').waitFor();
const proofDir = process.env.WORKIQ_PRESENTATION_PROOFS;

test("chart help is closed, unit-bearing and preserves reading state without changing evidence", { timeout: 60000 }, async t => {
    const before = structuredClone(source), requests = [], errors = [];
    let revision = 1;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") { res.end(renderHtmlShell("a".repeat(64), "reading-fixture")); return; }
        let text = ""; for await (const part of req) text += part;
        requests.push({ route: req.url, input: JSON.parse(text) });
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403; res.end('{"error":"Only synthetic snapshot reads are allowed."}'); return;
        }
        res.end(JSON.stringify({ revision, scenarios: source, exports: [], coverage: { notes: [] },
            analytics: { ...buildActivityAnalytics(source, JSON.parse(text)), revision } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ hasTouch: true, reducedMotion: "reduce", viewport: { width: 1600, height: 1200 } });
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(source, before); assert.deepEqual(errors, []);
        assert.ok(requests.every(request => request.route === "/api/snapshot"));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await ready(page);
    assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), totals.map(n => `${n} calls`));
    assert.equal(await page.locator("#chart .ux-help,.chart-heading .ux-help,#chartMeta").count(), 0, "No redundant chart-local info controls; filter-field help is independent");
    assert.equal(await page.locator("#tableDisclosure").evaluate(n => n.open), false);
    assert.equal(await page.locator("#chartReadingNotes").isVisible(), false);
    assert.doesNotMatch(await page.locator("#homeView").innerText(), /Peak|Vertical edge height|Tiny values|projected area|not task correctness/);
    assert.match(await page.locator("#chartReadingNotes").textContent(), /Colors match the recorded results/);
    assert.ok((await page.locator("#tableDisclosure>summary").boundingBox()).height >= 44);
    const matrix = [];
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1600, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1200 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.locator("#homeView").evaluate(root => {
            const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height, bottom: r.bottom + scrollY, right: r.right }; };
            const baseline = node => {
                const marker = document.createElement("span");
                marker.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0";
                node.append(marker); const y = marker.getBoundingClientRect().y; marker.remove(); return y;
            };
            return {
                overflow: document.documentElement.scrollWidth - innerWidth,
                regions: [".chart-panel", ".percentage-section"].map(selector => box(root.querySelector(selector))),
                panels: [...root.querySelectorAll(".percentage-card")].map(card => ({
                    card: box(card), content: box(card.querySelector(".percentage-content")), counter: box(card.querySelector(".percentage-center")),
                    baselineDifference: Math.abs(baseline(card.querySelector(".percentage-center strong")) - baseline(card.querySelector(".percentage-center span"))),
                })),
            };
        });
        assert.ok(measured.overflow <= 1);
        for (const panel of measured.panels) assert.ok(panel.baselineDifference < 1, "Total and in-this-view caption share a baseline");
        if (Math.abs(measured.panels[0].card.y - measured.panels[1].card.y) < 1) {
            assert.ok(Math.abs(measured.panels[0].card.height - measured.panels[1].card.height) < 1);
            assert.ok(Math.abs(measured.panels[0].counter.y - measured.panels[1].counter.y) < 1);
        }
        matrix.push({ theme, width, scale, ...measured });
        if (proofDir) {
            await page.evaluate(() => document.activeElement.blur());
            const first = measured.regions.reduce((a, b) => a.y < b.y ? a : b), last = measured.regions.at(-1);
            await page.screenshot({ path: path.join(proofDir, `section-${theme}-${width}-text${scale}.png`), fullPage: true,
                clip: { x: first.x, y: first.y, width: measured.regions[0].width, height: last.bottom - first.y } });
        }
    }
    if (proofDir) await writeFile(path.join(proofDir, "full-section-layout.json"), JSON.stringify(matrix, null, 2));
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    const firstInput = requests.at(-1).input;
    await page.locator("#tableDisclosure>summary").click();
    await page.locator("#tableDisclosure>summary").focus();
    assert.match(await page.locator("#chartReadingNotes").textContent(), /Weeks start Monday/);
    assert.equal(await page.locator("#countTable tbody tr").count(), 5);
    assert.equal(requests.length, 1, "Opening help and exact data makes no new read or mutation");
    revision++;
    await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
    assert.deepEqual(requests.at(-1).input, firstInput);
    assert.equal(await page.locator("#tableDisclosure").evaluate(n => n.open), true);
    assert.equal(await page.locator("#tableDisclosure>summary").evaluate(n => n === document.activeElement), true);
    for (const mode of ["workload", "endpoint", "time"]) {
        await page.locator(`[data-chart=${mode}]`).click(); await ready(page);
        assert.equal(await page.locator("#tableDisclosure").evaluate(n => n.open), true);
        assert.match(await page.locator("#chartReadingNotes").textContent(), mode === "time" ? /linear count scale from zero/ : /square-root scale and minimum visible sizes/);
        assert.doesNotMatch(await page.locator(".chart-panel").innerText(), /Peak/);
        assert.ok((await page.locator(".dimensional-count").allTextContents()).every(text => /^\d[\d,]* calls?$/.test(text)));
    }
    await page.locator("#tableDisclosure>summary").tap();
    await navigateMain(page, "activity"); await page.goBack(); await ready(page);
    assert.equal(await page.locator("#tableDisclosure").evaluate(n => n.open), false);
    assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), totals.map(n => `${n} calls`));
});

test("all evidence units and large values fit flat time and projected comparison columns at 100/200% text", { timeout: 30000 }, async () => {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce" });
    try {
        await page.setContent(`<style>${styles}</style><div id="test-host" style="width:360px;max-width:100%"></div>`);
        const counts = [0, 1, 2, Number.MAX_SAFE_INTEGER];
        for (const layer of results.layers) for (const time of [true, false]) {
            await page.evaluate(({ dimensional, recorded, ux, icons, layer, time, counts }) => {
                const make = text => (0, eval)(`(${text})`);
                const charts = make(dimensional)(), results = make(recorded)();
                const help = window.chartProofUX ||= make(ux)(icons);
                for (const previous of document.querySelectorAll(".dimensional-scroll")) charts.disposeView(previous);
                const groups = counts.map((total, index) => ({
                    id: String(index), label: `Synthetic category ${index}`, total,
                    success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0,
                }));
                const options = { points: groups, groups, label: g => g.label, summary: g => `${g.total} ${results.unit(layer, g.total)}`,
                    unit: n => results.columnUnit(layer, n), onSelect: () => {}, tooltip: help.tooltip };
                const chart = time ? charts.timeView(options) : charts.comparisonView(options);
                document.querySelector("#test-host").replaceChildren(chart);
                charts.refreshView(chart);
            }, { dimensional: createDimensionalCharts.toString(), recorded: createRecordedResults.toString(), ux: createEvidenceUX.toString(), icons: uxIcons, layer, time, counts });
            for (const scale of [1, 2]) {
                await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const measured = await page.locator(".dimensional-plot,.flat-time-plot").evaluate(root => {
                    const box = n => { const r = n.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width }; };
                    return { plot: box(root), documentOverflow: document.documentElement.scrollWidth - innerWidth,
                        labels: [...root.querySelectorAll(".dimensional-count")].map(n => ({ ...box(n), text: n.textContent, font: parseFloat(getComputedStyle(n).fontSize) })),
                        columns: [...root.querySelectorAll(".dimensional-column,.flat-time-column")].map(n => ({
                            total: Number(n.dataset.total), maximum: Number(n.dataset.maximum), height: Number(n.dataset.frontHeight ?? n.getAttribute("height")), extent: Number(n.dataset.plotHeight),
                        })),
                        centers: [...root.querySelectorAll(".time-slot,.dimensional-category")].map(n => { const r = box(n); return r.x + r.width / 2; }) };
                });
                assert.ok(measured.documentOverflow <= 1);
                measured.labels.forEach((label, index) => {
                    assert.equal(label.text, `${counts[index].toLocaleString()} ${results.columnUnit(layer, counts[index])}`);
                    assert.ok(label.font >= 16 * scale, "Unit labels enlarge instead of shrinking or clipping");
                    assert.ok(Math.abs(label.x + label.width / 2 - measured.centers[index]) < 1, "Count/unit share the projected-silhouette axis");
                    assert.ok(label.x >= measured.plot.x && label.right <= measured.plot.right);
                    assert.ok(label.y >= measured.plot.y, "Labels stay within measured headroom");
                    if (index) assert.ok(measured.labels[index - 1].right + 8 <= label.x,
                        `Neighboring values never overlap: ${layer}/${time}/${scale} ${JSON.stringify({ previous: measured.labels[index - 1], label, plot: measured.plot })}`);
                });
                for (const column of measured.columns) assert.ok(Math.abs(column.height - (time
                    ? column.total / column.maximum * column.extent : Math.max(36, Math.sqrt(column.total / column.maximum) * column.extent))) < 1e-10);
            }
            await page.locator(".dimensional-plot button,.flat-time-plot button").last().focus();
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("Tab");
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.match(await page.locator(".dimensional-plot button,.flat-time-plot button").last().getAttribute("aria-label"), new RegExp(String(Number.MAX_SAFE_INTEGER)));
            await page.keyboard.press("Escape");
        }
    } finally { await browser.close(); }
});

test("loaded-font changes invalidate count-label pitch without changing values or column scale", { timeout: 30000 }, async t => {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(async () => { await browser.close(); assert.deepEqual(errors, [], "No resize-observer loop or browser errors"); });
    await page.setContent(`<style>${styles}</style><div id="font-chart" style="width:360px;max-width:100%"></div>`);
    await page.evaluate(async dimensional => {
        document.documentElement.style.fontSize = "32px";
        await document.fonts.load("700 32px Arial");
        await document.fonts.ready;
        document.documentElement.style.setProperty("--font", "monospace");
        const charts = (0, eval)(`(${dimensional})`)();
        const groups = [0, 1, 2, Number.MAX_SAFE_INTEGER].map((total, index) => ({
            id: String(index), label: `Synthetic category ${index}`, total,
            success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0,
        }));
        const view = charts.timeView({ points: groups, label: group => group.label,
            summary: group => String(group.total), unit: () => "tool-returned API results", onSelect() {}, tooltip() {} });
        document.querySelector("#font-chart").append(view);
        charts.refreshView(view);
    }, createDimensionalCharts.toString());
    const measure = () => page.locator(".flat-time-plot").evaluate(plot => ({
        container: plot.parentElement.clientWidth, sampleSize: getComputedStyle(plot.querySelector(".dimensional-time-labels>span")).fontSize,
        pitch: plot.querySelector(".time-slot").getBoundingClientRect().width,
        counts: [...plot.querySelectorAll(".dimensional-count")].map(node => ({
            width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, text: node.textContent,
        })),
        columns: [...plot.querySelectorAll(".flat-time-column")].map(node => ({
            total: node.dataset.total, maximum: node.dataset.maximum, height: node.getAttribute("height"),
        })),
    }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await measure();
    await page.evaluate(() => document.documentElement.style.removeProperty("--font"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await measure();
    assert.equal(after.container, before.container);
    assert.equal(after.sampleSize, before.sampleSize);
    assert.notDeepEqual(after.counts.map(node => node.width), before.counts.map(node => node.width), "Actual glyph widths changed at the same font size");
    assert.notEqual(after.pitch, before.pitch, "A font-width change must invalidate cached layout");
    assert.deepEqual(after.columns, before.columns, "Counts, maximum and encoded heights stay exact");
    assert.deepEqual(after.counts.map(node => node.text), before.counts.map(node => node.text));
    assert.ok(after.pitch >= Math.max(...after.counts.map(node => node.width)) + 15.9, "Measured glyph width retains the full label spacing budget");
});
