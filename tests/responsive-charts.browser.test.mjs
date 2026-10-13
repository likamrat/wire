import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { styles } from "../web/styles.mjs";

const settle = page => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const group = (total, index) => ({
    id: String(index), label: `Recorded category ${index}`, total,
    success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0,
});
async function setup(t) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(requests, []); });
    await page.setContent(`<style>${styles}</style><div id="host" style="width:360px;max-width:100%"></div>`);
    await page.evaluate(({ charts, results }) => {
        window.charts = (0, eval)(`(${charts})`)();
        window.results = (0, eval)(`(${results})`)();
        window.selections = [];
        window.observers = new Set();
        const NativeObserver = ResizeObserver;
        window.ResizeObserver = class extends NativeObserver {
            constructor(callback) { super(callback); window.observers.add(this); }
            disconnect() { super.disconnect(); window.observers.delete(this); }
        };
    }, { charts: createDimensionalCharts.toString(), results: createRecordedResults.toString() });
    return page;
}
async function mount(page, groups, time = true, layer = "tool") {
    await page.evaluate(({ groups, time, layer }) => {
        const host = document.querySelector("#host");
        const previous = host.querySelector(".dimensional-scroll");
        if (previous) window.charts.disposeView(previous);
        const options = { points: groups, groups, label: row => row.label,
            summary: row => `${row.total} ${window.results.unit(layer, row.total)}`,
            unit: total => window.results.columnUnit(layer, total), onSelect: row => window.selections.push(row.id) };
        const chart = time ? window.charts.timeView(options) : window.charts.comparisonView(options);
        host.replaceChildren(chart);
        window.charts.refreshView(chart);
    }, { groups, time, layer });
    await settle(page);
}

test("sparse, dense and empty time views reset sizing while enlarged labels and focused counts survive host resize", async t => {
    const page = await setup(t);
    for (const length of [1, 3, 7, 0, 1]) {
        const groups = Array.from({ length }, (_, index) => group(index === 1 ? 0 : index ? 15 : 1500, index));
        await mount(page, groups);
        assert.equal(await page.locator(".flat-time-scroll").getAttribute("data-density"), length < 4 ? "sparse" : "dense");
        assert.equal(await page.evaluate(() => window.observers.size), 1);
        assert.equal(await page.locator(".dimensional-time-labels > span").count(), length);
        assert.equal(await page.locator(".flat-time-column").count(), groups.filter(row => row.total).length);
        if (!length) continue;
        const extent = Number(await page.locator(".flat-time-column").first().getAttribute("data-plot-height"));
        assert.equal(extent, Math.min(200, 40 * (length + 1)), "Extent follows displayed bins, not the magnitude of 1,500 calls");
        await page.locator(".time-column").last().focus();
        for (const [width, text] of [[1200, 100], [280, 200]]) {
            await page.evaluate(({ width, text }) => {
                document.querySelector("#host").style.width = width + "px";
                document.documentElement.style.fontSize = text + "%";
            }, { width, text });
            await settle(page);
            const measured = await page.locator(".flat-time-scroll").evaluate(scroll => {
                const clip = scroll.getBoundingClientRect(), plot = scroll.querySelector(".flat-time-plot").getBoundingClientRect();
                const focused = document.activeElement, count = focused.querySelector(".dimensional-count");
                const box = count.getBoundingClientRect();
                return {
                    focus: focused.classList.contains("time-column"), x: box.x, right: box.right, width: box.width, height: box.height,
                    left: clip.left, clipRight: clip.right, top: box.top, plotTop: plot.top,
                    marks: [...scroll.querySelectorAll(".flat-time-column")].map(node => ({
                        total: Number(node.dataset.total), maximum: Number(node.dataset.maximum), extent: Number(node.dataset.plotHeight),
                        height: Number(node.getAttribute("height")),
                    })),
                };
            });
            assert.ok(measured.focus && measured.width >= 44 && measured.height >= 44);
            assert.ok(measured.x >= measured.left && measured.right <= measured.clipRight);
            assert.ok(measured.top >= measured.plotTop, "Measured headroom cannot clip enlarged count targets");
            for (const mark of measured.marks) {
                assert.equal(mark.extent, extent);
                assert.equal(mark.height, mark.total / mark.maximum * extent);
            }
        }
    }
    await page.evaluate(() => window.charts.disposeView(document.querySelector(".dimensional-scroll")));
    assert.equal(await page.evaluate(() => window.observers.size), 0);
});

test("all evidence units and extreme counts reflow in flat comparisons and measured time lanes", async t => {
    const page = await setup(t), counts = [0, 1, 2, Number.MAX_SAFE_INTEGER];
    const results = createRecordedResults();
    for (const layer of results.layers) for (const time of [true, false]) {
        await mount(page, counts.map(group), time, layer);
        for (const scale of [1, 2]) {
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await settle(page);
            const values = await page.locator(time ? ".dimensional-count" : ".flat-comparison-count").allTextContents();
            assert.deepEqual(values, counts.map(total => `${total.toLocaleString()} ${results.columnUnit(layer, total)}`));
            const measured = await page.locator("#host").evaluate((host, time) => ({
                overflow: document.documentElement.scrollWidth - innerWidth,
                clipped: [...host.querySelectorAll(time ? ".dimensional-count" : ".flat-comparison-count,.group-name")]
                    .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
                marks: time ? [...host.querySelectorAll(".flat-time-column")].map(node => ({
                    actual: +node.getAttribute("height"), expected: +node.dataset.total / +node.dataset.maximum * +node.dataset.plotHeight,
                })) : [...host.querySelectorAll(".flat-comparison-segment")].map(node => ({
                    actual: parseFloat(node.style.width), expected: +node.dataset.count / +node.closest(".flat-comparison").dataset.maximum * 100,
                })),
            }), time);
            assert.ok(measured.overflow <= 1);
            assert.deepEqual(measured.clipped, []);
            for (const mark of measured.marks) {
                assert.ok(mark.actual > 0, "Tiny positives are never rounded to zero");
                assert.ok(Math.abs(mark.actual / mark.expected - 1) < 1e-5, "CSSOM serialization retains six significant digits");
            }
            const last = page.locator(time ? ".time-column" : ".flat-comparison-action").last();
            await last.focus(); await page.keyboard.press("Enter");
            assert.equal(await page.evaluate(() => window.selections.at(-1)), "3");
            assert.match(await last.getAttribute("aria-label"), /9007199254740991/);
        }
    }
});

test("monthly baselines, dense dates and font/container changes preserve exact paint and observer ownership", async t => {
    const page = await setup(t);
    for (const theme of ["light", "dark"]) for (const length of [1, 2, 45]) {
        const groups = Array.from({ length }, (_, index) => group(index ? 30 : 187, index));
        await mount(page, groups);
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        const initial = await page.locator(".flat-time-column").evaluateAll(nodes => nodes.map(node => ({
            total: node.dataset.total, height: node.getAttribute("height"),
            base: (() => { const mark = node.querySelector("rect"); return new DOMPoint(0, mark.y.baseVal.value + mark.height.baseVal.value).matrixTransform(mark.getScreenCTM()).y; })(),
        })));
        assert.equal(initial.length, length);
        assert.ok(initial.every(mark => Math.abs(mark.base - initial[0].base) < .03));
        assert.equal(await page.locator(".dimensional-ground,.dimensional-cap,.dimensional-side").count(), 0);
        assert.equal(await page.evaluate(() => window.observers.size), 1);
        if (length === 45) {
            await page.locator(".time-column").last().focus();
            assert.ok(await page.locator(".dimensional-scroll").evaluate(node => node.scrollLeft > 0));
            assert.equal(await page.locator(".dimensional-time-labels > span").count(), 45);
        }
        for (const width of [280, 1200, 360]) {
            await page.evaluate(width => { document.querySelector("#host").style.width = width + "px"; }, width);
            await settle(page);
            assert.deepEqual(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.map(node => ({
                total: node.dataset.total, height: node.getAttribute("height"),
            }))), initial.map(({ total, height }) => ({ total, height })));
        }
    }
    await mount(page, [0, 1, 2, Number.MAX_SAFE_INTEGER].map(group));
    await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
        document.documentElement.style.setProperty("--font", "monospace");
    });
    await settle(page);
    const measure = () => page.locator(".flat-time-plot").evaluate(plot => ({
        pitch: plot.querySelector(".time-slot").getBoundingClientRect().width,
        widths: [...plot.querySelectorAll(".dimensional-count")].map(node => node.getBoundingClientRect().width),
        paint: [...plot.querySelectorAll(".flat-time-column")].map(node => node.outerHTML),
    }));
    const before = await measure();
    await page.evaluate(() => document.documentElement.style.removeProperty("--font")); await settle(page);
    const after = await measure();
    assert.notDeepEqual(after.widths, before.widths);
    assert.notEqual(after.pitch, before.pitch);
    assert.deepEqual(after.paint, before.paint);
    assert.ok(after.pitch >= Math.max(...after.widths) + 23.9);
    await page.evaluate(() => { document.querySelector("#host").hidden = true; });
    await mount(page, [group(1, 0), group(2, 1)]);
    await page.evaluate(() => { document.querySelector("#host").hidden = false; }); await settle(page);
    assert.equal(await page.evaluate(() => window.observers.size), 1);
    await mount(page, [group(1, 0)], false);
    assert.equal(await page.evaluate(() => window.observers.size), 0, "Flat comparisons do not retain a dead scene observer");
});
