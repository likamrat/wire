import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";

const proofDir = process.env.WORKIQ_LEVEL_PROOFS;
const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
const group = (label, total, index = 0) => ({
    id: `synthetic-level-${index}`, label, total,
    ...Object.fromEntries(outcomes.map((key, outcome) => [key, outcome === index % outcomes.length ? total : 0])),
});
const paths = [
    "workiq-retrieve", "workiq-search_paths", "workiq-ask", "/chats/{id}/messages",
    "/me/messages", "/me/calendarView", "/me/events",
].map((label, index) => group(label, [75, 34, 28, 12, 11, 7, 5][index], index));
const services = ["Mail", "Calendar", "Files", "Teams", "People", "Search", "Unknown"]
    .map((label, index) => group(label, [75, 34, 28, 12, 11, 7, 5][index], index));

async function mount(page, groups, { width, theme, scale = 1, mode = "path", confined = false }) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<html data-evidence-theme="${theme}" style="font-size:${scale * 100}%"><head><style>${styles}</style></head>
        <body><main style="padding:16px;max-width:none;width:100%;margin:0"><section class="chart-panel" style="${confined ? "max-width:620px;" : ""}">
        <h2>${mode === "service" ? "By service" : mode === "time" ? "Recorded activity" : "API paths requested"}</h2>
        <div id="chart"></div><p class="dimensional-reading">Synthetic only. Visual sizes are adjusted for readability; labels retain actual counts.</p>
        <details><summary>Label definitions</summary><p>Full labels remain available without an export.</p></details></section></main></body></html>`);
    await page.addScriptTag({ content: `window.charts=(${createDimensionalCharts.toString()})();window.ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    await page.evaluate(({ groups, mode, icons }) => {
        window.selections = [];
        const options = {
            label: item => item.label, summary: item => `${item.label}: ${item.total} synthetic actions.`,
            onSelect: item => window.selections.push(item.id), tooltip: window.ux.tooltip,
        };
        document.querySelector("#chart").append(mode === "time"
            ? window.charts.timeView({ ...options, points: groups })
            : window.charts.comparisonView({
                ...options, groups, serviceMode: mode === "service", icons,
                help: mode === "service" ? item => window.ux.helpButton(item.label, `Synthetic definition of ${item.label}.`) : undefined,
            }));
    }, { groups, mode, icons: dimensionalIcons });
    await page.locator(".dimensional-column,.flat-time-column,.time-zero").first().waitFor({ state: "attached" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measure(page) {
    return page.locator(".dimensional-scroll").evaluate(scroll => {
        const rect = node => {
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height, center: b.x + b.width / 2 };
        };
        const slots = [...scroll.querySelectorAll(".dimensional-category,.time-slot")];
        const timeLabels = [...scroll.querySelectorAll(".dimensional-time-labels>span")];
        const columns = slots.map((cell, index) => {
            const svg = cell.querySelector(".dimensional-column,.flat-time-column"), fronts = [...cell.querySelectorAll(".dimensional-front,.flat-time-segment")];
            const point = (front, y) => new DOMPoint(0, y).matrixTransform(front.getScreenCTM()).y;
            const label = cell.querySelector(".group-name") || timeLabels[index], range = document.createRange();
            range.selectNodeContents(label);
            const lines = [...range.getClientRects()].map(b => ({ x: b.x, y: b.y, right: b.right, bottom: b.bottom }));
            return {
                label: label.textContent, labelBox: rect(label), lines, cell: rect(cell),
                help: cell.querySelector(".ux-help") ? rect(cell.querySelector(".ux-help")) : null,
                value: rect(cell.querySelector(".dimensional-count")),
                total: Number(svg?.dataset.total || 0), maximum: Number(svg?.dataset.maximum || 1), extent: Number(svg?.dataset.plotHeight || 280),
                base: fronts.length ? point(fronts[0], fronts[0].y.baseVal.value + fronts[0].height.baseVal.value) : null,
                top: fronts.length ? point(fronts.at(-1), fronts.at(-1).y.baseVal.value) : null,
                edgeHeight: fronts.reduce((sum, front) => sum + front.height.baseVal.value * front.getScreenCTM().d, 0),
                counts: fronts.map(front => Number(front.dataset.count)),
                paint: svg ? rect(svg) : null,
                cap: cell.querySelectorAll(".dimensional-cap").length,
            };
        });
        const box = rect(scroll);
        const contentBottom = Math.max(...columns.flatMap(column => [...column.lines.map(line => line.bottom), column.help?.bottom || 0]));
        const scrollportBottom = box.y + scroll.clientTop + scroll.clientHeight;
        const caption = rect(scroll.closest(".chart-panel").querySelector(".dimensional-reading"));
        return {
            columns, scroll: box, contentBottom, scrollportBottom, labelGap: scrollportBottom - contentBottom,
            captionGap: caption.y - box.bottom,
            scrollbarReservation: scroll.offsetHeight - scroll.clientHeight,
            requiredGap: Math.max(16, parseFloat(getComputedStyle(document.documentElement).fontSize)),
            scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
            overflow: document.documentElement.scrollWidth - innerWidth,
        };
    });
}

async function save(name, values, page) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await writeFile(path.join(proofDir, `${name}.json`), JSON.stringify(values, null, 2));
    if (page) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${name}.png`) });
}

test("category positions never change the quantitative zero baseline or equal-count tops", { timeout: 45000 }, async () => {
    const browser = await chromium.launch(), failures = [], results = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        const cases = [
            paths, services, [group("Equal first", 28), group("Tall middle", 75, 1), group("Equal last", 28, 2)],
            [group("Zero", 0), group("Subpixel", 1, 1), group("Large", 100000, 2)],
            outcomes.map((label, index) => group(label, 9, index)),
            [{ ...group("Stacked", 75), success: 40, failure: 20, unknown: 10, partial: 5 }],
        ];
        for (const [index, source] of cases.entries()) for (const reverse of [false, true]) {
            const groups = reverse ? [...source].reverse() : source;
            const mode = index === 1 ? "service" : "path";
            await mount(page, groups, { width: 1200, theme: "dark", mode });
            const value = await measure(page);
            results.push({ index, reverse, ...value });
            const painted = value.columns.filter(column => column.paint), first = painted[0];
            for (const column of painted) {
                if (Math.abs(column.base - first.base) > .03) failures.push(`${index}/${reverse}/${column.label}: base ${column.base} != ${first.base}`);
                assert.ok(Math.abs(column.edgeHeight - Math.max(36, Math.sqrt(column.total / column.maximum) * column.extent)) < .03);
                assert.equal(column.counts.reduce((sum, count) => sum + count, 0), column.total);
                assert.equal(column.cap, 1);
                assert.ok(Math.abs(column.value.center - column.paint.center) < 1);
                assert.ok(Math.abs(column.labelBox.center - column.paint.center) < 1);
                assert.ok(column.value.bottom <= column.paint.y - 4);
                assert.ok(column.value.y >= value.scroll.y, "Count annotations fit in top headroom");
                for (const peer of painted.filter(peer => peer.total === column.total)) {
                    if (Math.abs(column.top - peer.top) > .03) failures.push(`${column.label}: equal-count top differs by ${column.top - peer.top}`);
                }
            }
            if (index < 2 && !reverse) await save(`reference-${mode}`, value, page);
        }
        await save("level-geometry", results);
        assert.deepEqual(failures, []);
    } finally { await browser.close(); }
});

test("intrinsic labels and help clear the real scrollport and caption at normal and enlarged text", { timeout: 90000 }, async () => {
    const browser = await chromium.launch(), failures = [], results = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1920, 2560]) for (const scale of [1, 2]) {
            for (const mode of ["path", "service", "time"]) {
                const groups = mode === "service" ? services : mode === "time" ? paths.map((item, index) => ({ ...item, label: `Sep ${index + 1}` })) : [
                    ...paths,
                    group("/sites/{site-id}/lists/{list-id}/items/{item-id}/fields", 3, 7),
                    group(`/${"longunbrokenpath".repeat(5)}`, 1, 8),
                ];
                await mount(page, groups, { width, theme, scale, mode, confined: width > 1200 });
                const value = await measure(page), key = `${theme}-${width}-${scale * 100}-${mode}`;
                results.push({ key, ...value });
                if (value.labelGap < value.requiredGap - .1) failures.push(`${key}: label gap ${value.labelGap} < ${value.requiredGap}`);
                if (value.captionGap < value.requiredGap - .1) failures.push(`${key}: caption gap ${value.captionGap} < ${value.requiredGap}`);
                assert.ok(value.overflow <= 1);
                for (const column of value.columns) {
                    assert.ok(column.lines.every(line => line.x >= column.labelBox.x - 1 && line.right <= column.labelBox.right + 1), "Full path wraps inside its label, including unbroken strings");
                }
                await page.locator("details>summary").click();
                const last = page.locator(".dimensional-category,.time-slot").last();
                await last.locator(".ux-help,.dimensional-action,.time-column").first().focus();
                const after = await measure(page);
                assert.ok(after.labelGap >= value.labelGap - .1, `${key}: focus/scroll cannot crowd bottom labels (${value.labelGap}px before, ${after.labelGap}px after)`);
                assert.ok(after.labelGap >= after.requiredGap - .1, `${key}: focused label gap ${after.labelGap} < ${after.requiredGap}`);
                await page.keyboard.press("Escape");
                if (width === 1200 && mode !== "time") await save(`spacing-${key}`, after, page);
            }
        }
        await save("label-spacing", results);
        assert.deepEqual(failures, []);
    } finally { await browser.close(); }
});

test("one and two monthly columns share one flat zero baseline without decorative surfaces", { timeout: 30000 }, async () => {
    const browser = await chromium.launch(), failures = [], results = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 1200]) for (const length of [1, 2]) {
            const groups = [group("Sep 1", 187), group("Oct 1", 30, 1)].slice(0, length);
            await mount(page, groups, { width, theme, mode: "time" });
            const floor = await page.locator(".flat-time-plot").evaluate(plot => ({
                decoration: plot.querySelectorAll(".dimensional-ground-surface,.dimensional-reflection").length,
                baselines: getComputedStyle(plot.querySelector(".time-chart")).borderBottomWidth,
                feet: [...plot.querySelectorAll(".flat-time-segment")].map(front =>
                    new DOMPoint(0, front.y.baseVal.value + front.height.baseVal.value).matrixTransform(front.getScreenCTM()).y),
            }));
            const key = `monthly-${theme}-${width}-${length}`;
            results.push({ key, ...floor });
            assert.equal(floor.decoration, 0);
            assert.equal(floor.baselines, "1px");
            if (floor.feet.some(y => Math.abs(y - floor.feet[0]) > .03)) failures.push(`${key}: columns disagree on zero baseline`);
            if (width === 1200 && length === 2) await save(key, floor, page);
        }
        await save("monthly-floor", results);
        assert.deepEqual(failures, []);
    } finally { await browser.close(); }
});
