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

const proofDir = process.env.WORKIQ_ALIGNMENT_PROOFS;
const names = ["Search and retrieval", "Service not identified", "Calendar", "Mail", "Teams", "Files", "More than one service", "People", "Other categories"];
const services = ["Search", "Unknown", "Calendar", "Mail", "Teams", "Files", "Multiple workloads", "People", "Other"];
const groups = names.map((name, index) => ({
    id: `synthetic-${index}`, label: services[index], name, total: [91, 67, 28, 23, 17, 8, 2, 1, 0][index],
}));

async function mount(page, source, width, theme) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<html data-evidence-theme="${theme}"><head><style>${styles}</style></head><body><main style="padding:20px;max-width:none;width:100%;margin:0"><section class="chart-panel"><h2>Synthetic services involved</h2><div id="chart"></div><p class="dimensional-reading">Visual sizes are adjusted for readability; labels retain actual counts. Color identifies the service, not its result.</p><div class="chart-footer">Select a column to explore. Scroll for more categories.</div></section></main></body></html>`);
    await page.addScriptTag({ content: `window.charts = (${createDimensionalCharts.toString()})(); window.ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    await page.evaluate(({ source, icons }) => {
        window.selections = [];
        document.querySelector("#chart").append(window.charts.comparisonView({
            groups: source, serviceMode: true, label: group => group.name, icons,
            summary: group => `${group.name}: ${group.total} synthetic actions.`,
            onSelect: group => window.selections.push(group.id), tooltip: window.ux.tooltip,
            help: group => window.ux.helpButton(group.name, `Definition of ${group.name}. Synthetic fixture only.`),
        }));
    }, { source, icons: dimensionalIcons });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measure(page) {
    return page.locator(".dimensional-category").evaluateAll(cells => cells.map(cell => {
        const box = node => {
            if (!node) return null;
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom, center: b.x + b.width / 2 };
        };
        const name = cell.querySelector(".group-name"), range = document.createRange();
        range.selectNodeContents(name);
        const lines = [...range.getClientRects()].map(box => ({ y: box.y, bottom: box.bottom, right: box.right, center: box.x + box.width / 2 }));
        const faces = [...cell.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap")].map(box);
        const paint = faces.length ? { center: (Math.min(...faces.map(face => face.x)) + Math.max(...faces.map(face => face.right))) / 2 } : null;
        return {
            name: name.textContent, cell: box(cell), stage: box(cell.querySelector(".dimensional-stage")),
            paint, front: box(cell.querySelector(".dimensional-front")), action: box(cell.querySelector(".dimensional-action")),
            count: box(cell.querySelector(".dimensional-count")), icon: box(cell.querySelector(".dimensional-category-icon")),
            glyph: box(cell.querySelector(".dimensional-category-icon svg")),
            label: box(name), track: box(cell.querySelector(".dimensional-label-line")),
            help: box(cell.querySelector(".ux-help")), helpIcon: box(cell.querySelector(".ux-help svg")), lines,
        };
    }));
}

test("one projected centerline aligns values and first text lines without an under-column icon row", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    const results = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [2000, 375, 820, 1200]) {
            await mount(page, groups, width, theme);
            const rows = await measure(page);
            results.push({ theme, width, rows });
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await writeFile(path.join(proofDir, "alignment.json"), JSON.stringify(results, null, 2));
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `alignment-${theme}-${width}.png`) });
            }
            for (const row of rows) {
                for (const [name, box] of Object.entries({ paint: row.paint, value: row.count, icon: row.icon, glyph: row.glyph, label: row.label })) {
                    if (box) assert.ok(Math.abs(box.center - row.cell.center) <= 1, `${theme}/${width} ${row.name}: ${name} is ${box.center - row.cell.center}px off its category centerline`);
                }
                assert.ok(Math.abs(row.track.y - rows[0].track.y) <= 1, "Labels start in one shared lane");
                assert.ok(Math.abs(row.lines[0].bottom - rows[0].lines[0].bottom) <= 1, "Single and multiline labels share their first visible text baseline");
                assert.equal(row.icon, null, "No redundant standalone service icon");
                assert.equal(row.glyph, null);
                assert.equal(row.help, null, "Repeated per-column info controls are removed");
                assert.equal(row.helpIcon, null);
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
    } finally { await browser.close(); }
});

test("reference composition has one glass plane and only painted faces activate each column", { timeout: 30000 }, async () => {
    const source = ["Mail", "Calendar", "Files", "Teams"].map((label, index) => ({
        id: `reference-${index}`, label, name: label, total: [81, 39, 112, 65][index],
    }));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
            await mount(page, source, width, theme);
            assert.equal(await page.locator(".dimensional-ground-edge").count(), 1);
            assert.ok(await page.locator(".dimensional-side,.dimensional-cap").count() > 0);
            assert.equal(await page.locator(".dimensional-reflection").count(), 0);
            const materials = await page.locator(".dimensional-column").first().evaluate(svg => ({
                front: getComputedStyle(svg.querySelector(".dimensional-front")).fillOpacity,
                slope: svg.querySelector(".dimensional-front").getCTM().b,
            }));
            assert.ok(Number(materials.front) > 0 && Number(materials.front) < 1);
            assert.ok(Math.abs(materials.slope + .18) < 1e-7, "The restrained glass projection is real geometry");
            const ground = page.locator(".dimensional-ground");
            assert.equal(await ground.getAttribute("aria-hidden"), "true");
            assert.equal(await ground.evaluate(node => getComputedStyle(node).pointerEvents), "none");
            if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `reference-composition-${theme}-${width}.png`) });
        }
        await mount(page, source, 1200, "light");
        const action = page.locator(".dimensional-action").first();
        const box = await action.boundingBox();
        await page.mouse.move(box.x - 4, box.y + 2);
        await page.mouse.click(box.x - 4, box.y + 2);
        await page.waitForTimeout(220);
        assert.deepEqual(await page.evaluate(() => window.selections), [], "The empty corner inside the SVG bounding box is inert");
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "No empty-corner hover tooltip");
        for (const face of [".dimensional-front", ".dimensional-count"]) {
            await action.locator(face).click();
            await page.keyboard.press("Escape");
        }
        assert.deepEqual(await page.evaluate(() => window.selections), ["reference-0", "reference-0"], "Painted mark and visible count activate the same action");
        await page.mouse.click(box.x + box.width * .7, box.y + box.height + 10);
        assert.equal(await page.evaluate(() => window.selections.length), 2, "Empty baseline never selects a column");
        const session = await page.context().newCDPSession(page);
        await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
        assert.equal(await action.locator(".dimensional-front").evaluate(node => getComputedStyle(node).fillOpacity), "1");
        assert.equal(await page.locator(".dimensional-ground-effects").count(), 0);
        await session.detach();
    } finally { await browser.close(); }
});

test("visible count labels work without repeated category help or value tooltips", { timeout: 30000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
        await mount(page, groups.slice(0, 2), 1200, "dark");
        const first = page.locator(".dimensional-category").first(), action = first.locator(".dimensional-action");
        assert.equal(await first.locator(".ux-help").count(), 0);
        await action.locator(".dimensional-count").hover();
        await page.waitForTimeout(250);
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.ok((await first.locator(".dimensional-count").boundingBox()).height >= 44);
        if (proofDir) await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, "value-tooltip.png") });
        await page.keyboard.press("Escape");
        const stage = await first.locator(".dimensional-stage").boundingBox();
        await page.mouse.click(stage.x + 3, stage.y + 80);
        assert.deepEqual(await page.evaluate(() => window.selections), []);
        await action.focus();
        await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.selections), ["synthetic-0"]);
    } finally { await browser.close(); }
});

test("one, two and many categories retain readable shared tracks, honest tiny values and bounded touch help", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    const cases = [
        groups.slice(0, 1), groups.slice(0, 2),
        [...groups, ...Array.from({ length: 15 }, (_, index) => ({ id: `synthetic-long-${index}`, label: "Unknown", name: `Synthetic long service category with several words ${index}`, total: index === 0 ? 1 : 0 }))],
        [{ ...groups[0], total: 100000 }, { ...groups[1], total: 1 }, { ...groups[2], total: 0 }],
        groups.slice(0, 2).map(group => ({ ...group, total: 0 })),
    ];
    try {
        const page = await browser.newPage({ hasTouch: true, reducedMotion: "reduce" });
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const source of cases) {
            await mount(page, source, width, theme);
            const rows = await measure(page);
            for (const row of rows) {
                assert.ok(Math.abs(row.label.center - row.cell.center) < 1);
                assert.equal(row.icon, null);
                assert.ok(Math.abs(row.track.y - rows[0].track.y) < 1);
                assert.ok(Math.abs(row.lines[0].bottom - rows[0].lines[0].bottom) < 1);
                assert.ok(row.track.width <= 184, "Names retain a readable measure");
                assert.equal(row.help, null);
                assert.ok(row.count.height >= 44, "Visible values, not invisible chart regions, supply usable targets");
                if (row.paint) assert.ok(Math.abs(row.paint.center - row.cell.center) < 1);
                if (row.action) assert.ok(row.action.width <= 116 && row.action.height <= 343.05);
                assert.ok(row.count && Math.abs(row.count.center - row.cell.center) < 1, "Zero retains an explicit centered count");
            }
            const last = page.locator(".dimensional-category").last();
            await last.locator(".dimensional-count").scrollIntoViewIfNeeded();
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.deepEqual(await page.evaluate(() => window.selections), []);
            const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
            await page.keyboard.press("Escape");
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), scroll);
            if (source.length > 9) {
                assert.ok(await page.locator(".dimensional-scroll").evaluate(node => node.scrollLeft > 0), "Later categories remain reachable");
                await page.locator(".dimensional-scroll").evaluate(node => { node.scrollLeft = 0; });
                await page.getByRole("tooltip").waitFor({ state: "hidden", timeout: 1000 });
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (source[0].total === 100000) {
                const tiny = page.locator(".dimensional-category").nth(1);
                assert.equal(await tiny.locator(".dimensional-cap-clear").count(), 1);
                assert.equal(Number(await tiny.locator(".dimensional-column").getAttribute("data-front-height")), 36);
                assert.equal(Number(await tiny.locator(".dimensional-front").getAttribute("height")), 36, "The visible minimum does not change the one-record count");
                assert.equal(await last.locator("button.dimensional-action, .dimensional-column").count(), 0);
                await tiny.locator(".dimensional-action").focus();
                await page.keyboard.press("Enter");
                assert.deepEqual(await page.evaluate(() => window.selections), ["synthetic-1"], "Subpixel columns still have a keyboard drilldown");
            }
            if (source.every(group => group.total === 0)) {
                assert.equal(await page.locator(".dimensional-action, .dimensional-column").count(), 0);
                const marker = page.locator(".time-zero").first();
                assert.equal(await marker.getAttribute("tabindex"), null, "Zero is a readable value, not a false action");
                assert.deepEqual(await page.evaluate(() => window.selections), [], "Zero never implies requests exist");
            }
        }
    } finally { await browser.close(); }
});
