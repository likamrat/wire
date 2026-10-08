import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";

const proofDir = process.env.WORKIQ_SMALL_COLUMN_PROOFS;
const screenshotPoints = [9, 28, 9, 121, 50].map((total, index) => ({
    id: `synthetic-${index}`, total, success: total - [0, 6, 3, 8, 11][index],
    failure: [0, 6, 3, 8, 11][index], unknown: 0, partial: 0, other: 0, transport: 0,
    label: ["Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28"][index],
}));

async function mount(page, points, width, theme) {
    await page.setViewportSize({ width, height: 700 });
    await page.setContent(`<html data-evidence-theme="${theme}"><head><style>${styles}</style></head><body><main style="padding:20px;max-width:none;width:100%;margin:0"><section class="chart-panel"><h2>Synthetic weekly recorded results</h2><div id="chart"></div></section></main></body></html>`);
    await page.addScriptTag({ content: `window.charts = (${createDimensionalCharts.toString()})(); window.ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    await page.evaluate(points => {
        window.selections = [];
        document.querySelector("#chart").append(window.charts.timeView({
            points, label: point => point.label, summary: point => `${point.label}: ${point.total} synthetic actions.`,
            onSelect: point => window.selections.push(point.id), tooltip: window.ux.tooltip,
        }));
    }, points);
}

async function measure(page) {
    return page.locator(".time-slot").evaluateAll(slots => slots.map((slot, index) => {
        const box = node => {
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height, center: b.x + b.width / 2 };
        };
        const svg = slot.querySelector(".dimensional-column");
        const fronts = [...slot.querySelectorAll(".dimensional-front")];
        const faces = [...slot.querySelectorAll(".dimensional-front, .dimensional-side, .dimensional-cap")].map(node => {
            let points;
            if (node.tagName === "rect") {
                const x = node.x.baseVal.value, y = node.y.baseVal.value, w = node.width.baseVal.value, h = node.height.baseVal.value;
                points = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
            } else {
                const tokens = node.getAttribute("d").match(/[MLHVZ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
                points = [];
                let x = 0, y = 0;
                while (tokens.length) {
                    const command = tokens.shift();
                    if (command === "M" || command === "L") { x = Number(tokens.shift()); y = Number(tokens.shift()); }
                    else if (command === "V") y = Number(tokens.shift());
                    else if (command === "H") x = Number(tokens.shift());
                    else if (command === "Z") continue;
                    else throw new Error(`Unsupported fixture path command ${command}`);
                    points.push([x, y]);
                }
            }
            const area = Math.abs(points.reduce((sum, [x, y], i) => {
                const next = points[(i + 1) % points.length];
                return sum + x * next[1] - y * next[0];
            }, 0)) / 2;
            const turns = points.map(([x, y], i) => {
                const a = points[(i + 1) % points.length], b = points[(i + 2) % points.length];
                return Math.sign((a[0] - x) * (b[1] - a[1]) - (a[1] - y) * (b[0] - a[0]));
            });
            return { ...box(node), area, convex: turns.every(turn => turn !== 0 && turn === turns[0]) };
        });
        const date = document.querySelectorAll(".dimensional-time-labels > span")[index];
        const dateRange = document.createRange();
        dateRange.selectNodeContents(date);
        const boundedGlints = [...slot.querySelectorAll(".dimensional-glint")].every(glint => {
            const targets = [...slot.querySelectorAll(glint.classList.contains("dimensional-glint-front") ? ".dimensional-front" : ".dimensional-side")];
            return Array.from({ length: 33 }, (_, index) => glint.getPointAtLength(glint.getTotalLength() * index / 32))
                .every(point => {
                    const screen = new DOMPoint(point.x, point.y).matrixTransform(glint.getScreenCTM());
                    return targets.some(face => face.isPointInFill(screen.matrixTransform(face.getScreenCTM().inverse())));
                });
        });
        const left = Math.min(...faces.map(face => face.x)), right = Math.max(...faces.map(face => face.right));
        return {
            total: Number(svg?.dataset.total || 0), extent: Number(svg?.dataset.plotHeight || 280), value: box(slot.querySelector(".dimensional-count")),
            date: box(date), dateText: box(dateRange),
            text: date.textContent,
            paintCenter: svg ? (left + right) / 2 : null, faces, boundedGlints,
            capCount: slot.querySelectorAll(".dimensional-cap").length,
            sideCount: slot.querySelectorAll(".dimensional-side").length,
            edgeHeight: fronts.reduce((sum, face) => sum + face.height.baseVal.value * face.getScreenCTM().d, 0),
            counts: fronts.map(face => Number(face.dataset.count)),
            base: fronts.length ? new DOMPoint(0, fronts[0].y.baseVal.value + fronts[0].height.baseVal.value).matrixTransform(fronts[0].getScreenCTM()).y : null,
        };
    }));
}

test("9/28/9/121/50 retains proportional glass values and one count/date axis", { timeout: 30000 }, async () => {
    const browser = await chromium.launch();
    const failures = [], proof = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
            await mount(page, screenshotPoints, width, theme);
            const rows = await measure(page);
            proof.push({ theme, width, rows });
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `small-columns-${theme}-${width}.png`) });
                await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(proof, null, 2));
            }
            for (const [index, row] of rows.entries()) {
                const context = `${theme}/${width}/${index} total=${row.total}`;
                if (row.capCount !== 1 || row.sideCount !== row.counts.length) failures.push(`${context}: missing actual glass facets`);
                if (Math.abs(row.value.center - row.paintCenter) > 1) failures.push(`${context}: value off paint center by ${row.value.center - row.paintCenter}px`);
                if (Math.abs(row.date.center - row.paintCenter) > 1) failures.push(`${context}: date off paint center by ${row.date.center - row.paintCenter}px`);
                assert.ok(Math.abs(row.dateText.center - row.date.center) < 1, "Visible date text shares its anchor");
                assert.ok(row.faces.every(face => face.area > 0 && face.convex), "Every actual painted face is a nondegenerate convex polygon");
                assert.ok(row.boundedGlints, "Small-column glints remain inside real faces");
                assert.ok(Math.abs(row.edgeHeight - Math.max(36, Math.sqrt(row.total / 121) * row.extent)) < .03, context);
                assert.equal(row.counts.reduce((sum, count) => sum + count, 0), row.total);
                assert.equal(row.text, screenshotPoints[index].label);
                assert.ok(Math.abs(row.base - rows[0].base) < .02, "All front bases share one ground line");
                assert.ok(row.value.bottom <= Math.min(...row.faces.map(face => face.y)) - 4, "Value does not occlude glass");
            }
            assert.ok(Math.abs(rows[0].edgeHeight / rows[3].edgeHeight - Math.sqrt(9 / 121)) < .0001);
            assert.ok(Math.abs(rows[1].edgeHeight / rows[3].edgeHeight - Math.sqrt(28 / 121)) < .0001);
            assert.ok(Math.abs(rows[0].edgeHeight - rows[2].edgeHeight) < .00001);
        }
        assert.deepEqual(failures, []);
    } finally { await browser.close(); }
});

test("zero, subpixel, unit, equal, mixed, dense and single timelines keep one proportional painted axis", { timeout: 30000 }, async () => {
    const cases = [[0], [1], [9], [9, 9], [0, 1, 9, 28, 121], [1, 200], [0, 1, 201], [0, 1, 100000], Array.from({ length: 45 }, (_, i) => [0, 1, 9, 121][i % 4])];
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const totals of cases) {
            const maximum = Math.max(1, ...totals);
            const points = totals.map((total, i) => ({ ...screenshotPoints[0], total, success: total, id: `case-${i}`, label: `Sep ${i + 1}` }));
            await mount(page, points, width, theme);
            const rows = await measure(page);
            for (const row of rows) {
                const extent = 320;
                const expected = row.total ? Math.max(36, Math.sqrt(row.total / maximum) * extent) : 0;
                if (row.total) assert.equal(row.extent, extent);
                assert.ok(Math.abs(row.edgeHeight - expected) < .03);
                assert.equal(row.capCount, row.total ? 1 : 0);
                assert.ok(row.faces.every(face => face.area > 0 && face.convex));
                assert.ok(row.boundedGlints);
                assert.ok(Math.abs(row.value.center - row.date.center) < 1);
                if (row.paintCenter !== null) {
                    assert.ok(Math.abs(row.paintCenter - row.date.center) < 1);
                    assert.ok(row.value.bottom <= Math.min(...row.faces.map(face => face.y)) - 4);
                }
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const last = page.locator(".time-slot").last();
            const control = last.locator(".time-column, .time-zero");
            if (totals.at(-1)) await control.focus();
            else await control.scrollIntoViewIfNeeded();
            const value = await control.locator(".dimensional-count").boundingBox();
            assert.ok(value.x >= 0 && value.x + value.width <= width);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            await page.keyboard.press("Escape");
            await page.keyboard.press("Enter");
            assert.deepEqual(await page.evaluate(() => window.selections), totals.at(-1) ? [`case-${totals.length - 1}`] : []);
        }
    } finally { await browser.close(); }
});

test("every small painted face selects once, keyboard selects once, and empty corners/plane are inert", { timeout: 20000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        page.setDefaultTimeout(3000);
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
            await mount(page, screenshotPoints, width, theme);
            const expected = [];
            for (const index of [0, 2]) {
                const action = page.locator(".time-column").nth(index);
                await action.scrollIntoViewIfNeeded();
                const box = await action.boundingBox();
                await page.mouse.move(box.x - 4, box.y + 1);
                await page.mouse.click(box.x - 4, box.y + 1);
                assert.deepEqual(await page.evaluate(() => window.selections), expected);
                assert.equal(await page.getByRole("tooltip").isVisible(), false);
                for (const selector of [".dimensional-front", ".dimensional-count"]) {
                    await action.locator(selector).first().click();
                    expected.push(`synthetic-${index}`);
                    assert.deepEqual(await page.evaluate(() => window.selections), expected);
                    await page.keyboard.press("Escape");
                }
                await page.locator(".dimensional-scroll").focus();
                await action.focus();
                assert.equal(await page.getByRole("tooltip").isVisible(), false);
                await page.keyboard.press("Escape");
                await page.keyboard.press("Enter");
                expected.push(`synthetic-${index}`);
                assert.deepEqual(await page.evaluate(() => window.selections), expected);
                await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12);
                assert.deepEqual(await page.evaluate(() => window.selections), expected, "Reflection and nearby empty plane have no hit target");
            }
        }
    } finally { await browser.close(); }
});
