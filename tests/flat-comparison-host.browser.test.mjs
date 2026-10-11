import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { styles } from "../web/styles.mjs";

test("flat comparison preserves labels, exact counts and keyboard actions when its host resizes independently of the viewport", async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent(`<style>${styles}</style><div id="host" style="width:360px;max-width:100%"></div>`);
    await page.evaluate(() => document.fonts.ready);
    const results = createRecordedResults(), totals = [0, 1, 2, Number.MAX_SAFE_INTEGER];
    const proofs = process.env.WIRE_COMPARISON_HOST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const layer of ["recorded-http", ...results.layers.filter(layer => layer !== "recorded-http")]) {
        await page.evaluate(({ factory, recorded, layer, totals }) => {
            const charts = (0, eval)(`(${factory})`)(), results = (0, eval)(`(${recorded})`)();
            window.hostSelections = [];
            const groups = totals.map((total, index) => ({
                id: String(index), label: `Recorded category ${index}`, total,
                success: Math.max(0, total - 1), failure: Math.min(1, total),
                unknown: 0, partial: 0, other: 0, transport: 0,
            }));
            document.querySelector("#host").replaceChildren(charts.comparisonView({
                groups, label: group => group.label,
                summary: group => `${group.label}: ${group.total.toLocaleString()} ${results.unit(layer, group.total)}`,
                unit: total => results.columnUnit(layer, total),
                createAction: group => {
                    const link = document.createElement("a");
                    link.href = `#analyze?group=${group.id}`;
                    link.addEventListener("click", event => { event.preventDefault(); window.hostSelections.push(group.id); });
                    return link;
                },
            }));
        }, { factory: createDimensionalCharts.toString(), recorded: createRecordedResults.toString(), layer, totals });
        const last = page.locator(".flat-comparison-action").last();
        await last.focus();
        for (const scale of [1, 2]) for (const width of [360, 280, 1200, 360]) {
            await page.evaluate(({ scale, width }) => {
                document.documentElement.style.fontSize = `${scale * 100}%`;
                document.querySelector("#host").style.width = `${width}px`;
            }, { scale, width });
            const measurement = await page.locator(".flat-comparison").evaluate(chart => {
                const box = node => {
                    const r = node.getBoundingClientRect();
                    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
                };
                const textRects = node => {
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    return [...range.getClientRects()].map(r => ({ x: r.x, right: r.right, y: r.y, bottom: r.bottom }));
                };
                return {
                    host: box(chart), viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
                    rows: [...chart.querySelectorAll(".flat-comparison-action")].map(action => {
                        const label = action.querySelector(".group-name"), count = action.querySelector(".flat-comparison-count");
                        const track = action.querySelector(".flat-comparison-track");
                        const text = document.createElement("canvas").getContext("2d");
                        text.font = getComputedStyle(label).font;
                        return {
                            action: box(action), label: box(label), count: box(count),
                            labelText: label.textContent, countText: count.textContent,
                            labelRects: textRects(label), countRects: textRects(count),
                            fontSize: parseFloat(getComputedStyle(label).fontSize),
                            longestWord: Math.max(...label.textContent.split(" ").map(word => text.measureText(word).width)),
                            track: box(track), tag: action.tagName, href: action.getAttribute("href"),
                            segments: [...track.children].map(mark => ({
                                count: Number(mark.dataset.count), percent: parseFloat(mark.style.width),
                                width: mark.getBoundingClientRect().width,
                            })),
                        };
                    }),
                };
            });
            const context = `${layer}, host ${width}px, text ${scale * 100}%`;
            assert.equal(measurement.viewport, 1600, "Only the host changes size");
            assert.equal(measurement.host.width, width, context);
            assert.equal(measurement.overflow, false, context);
            for (const [index, row] of measurement.rows.entries()) {
                assert.equal(row.labelText, `Recorded category ${index}`, context);
                assert.equal(row.countText, `${totals[index].toLocaleString()} ${results.columnUnit(layer, totals[index])}`, context);
                assert.ok(row.fontSize >= 14 * scale, `${context}: text must enlarge, not shrink to fit`);
                assert.ok(row.label.width >= Math.min(width, row.longestWord), `${context}: label is starved to ${row.label.width}px; a word needs ${row.longestWord}px`);
                assert.ok(row.action.height >= 44 && row.action.width >= 44, context);
                assert.ok(row.action.x >= measurement.host.x && row.action.right <= measurement.host.right + .1, context);
                assert.ok(row.label.right <= row.count.x + .1 || row.label.bottom <= row.count.y + .1, `${context}: label/count overlap`);
                for (const [rects, bounds] of [[row.labelRects, row.label], [row.countRects, row.count]]) {
                    for (const rect of rects) {
                        assert.ok(rect.x >= bounds.x - .5 && rect.right <= bounds.right + .5, `${context}: clipped text`);
                        assert.ok(rect.y >= row.action.y - .5 && rect.bottom <= row.action.bottom + .5, `${context}: text escapes action`);
                    }
                }
                assert.equal(row.tag, index ? "A" : "DIV");
                assert.equal(row.href, index ? `#analyze?group=${index}` : null);
                assert.equal(row.segments.reduce((sum, mark) => sum + mark.count, 0), totals[index]);
                for (const mark of row.segments) {
                    const expectedPercent = mark.count / Number.MAX_SAFE_INTEGER * 100;
                    assert.ok(Math.abs(mark.percent - expectedPercent) / expectedPercent < .000005, `${context}: CSS percentage serialization`);
                    assert.ok(Math.abs(mark.width - row.track.width * mark.count / Number.MAX_SAFE_INTEGER) < .02, `${context}: distorted mark`);
                }
                if (index === 0) assert.equal(row.segments.length, 0);
            }
            if (width === 1200) assert.ok(measurement.rows.every(row => row.label.y === row.count.y), `${context}: wider host reflows to two columns`);
            await expect(last).toBeFocused();
            if (proofs && layer === "recorded-http" && scale === 2) {
                await page.locator("#host").screenshot({ path: path.join(proofs, `host-${width}-text-${scale}.png`) });
            }
        }
        await page.keyboard.press("Shift+Tab");
        await expect(page.locator(".flat-comparison-action").nth(2)).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(last).toBeFocused();
        assert.notEqual(await last.evaluate(node => getComputedStyle(node).outlineStyle), "none");
        await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.hostSelections), ["3"]);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
});
