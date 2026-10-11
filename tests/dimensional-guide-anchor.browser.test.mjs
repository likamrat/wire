import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "../lib/dimensional-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { dimensionalIcons } from "../web/dimensional-icons.mjs";
import { styles } from "../web/styles.mjs";

const proofDir = process.env.WORKIQ_GUIDE_PROOFS;
const groups = [
    { id: "calendar", label: "Calendar", total: 39, success: 39 },
    { id: "path", label: "/chats/{id}/messages", total: 112, success: 106, failure: 6 },
].map(group => ({ failure: 0, unknown: 0, partial: 0, other: 0, transport: 0, ...group }));

async function mount(page, serviceMode, source = groups, { theme = "light", fontScale = 1, panelWidth, time = false } = {}) {
    await page.setContent(`<html data-evidence-theme="${theme}" style="font-size:${fontScale * 100}%"><head><style>${styles}</style></head><body><main style="padding:20px;max-width:none;width:100%;margin:0"><section class="chart-panel" style="${panelWidth ? `width:${panelWidth}px;max-width:100%` : ""}"><h2>Synthetic guide geometry</h2><div id="chart"></div></section></main></body></html>`);
    await page.addScriptTag({ content: `window.charts = (${createDimensionalCharts.toString()})();` });
    await page.evaluate(({ source, serviceMode, icons, time }) => {
        window.selections = [];
        window.render = groups => {
            const target = document.querySelector("#chart");
            if (target.firstChild) window.charts.disposeView(target.firstChild);
            const options = {
                groups, points: groups, serviceMode, icons, label: group => group.label,
                summary: group => `${group.label}: ${group.total} synthetic calls.`,
                onSelect: group => window.selections.push(group.id), tooltip: () => {},
            };
            target.replaceChildren(time ? window.charts.timeView(options) : window.charts.comparisonView(options));
        };
        window.render(source);
    }, { source, serviceMode, icons: dimensionalIcons, time });
    await settle(page);
}

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measure(page) {
    return page.locator(".dimensional-category,.time-slot,.dimensional-report-category").evaluateAll(cells => cells.map((cell, index) => {
        const box = node => {
            if (!node) return null;
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height, center: b.x + b.width / 2 };
        };
        const svg = cell.querySelector(".dimensional-column,.flat-time-column");
        const caption = cell.querySelector(".dimensional-category-label,.dimensional-report-label");
        const label = cell.querySelector(".group-name,.dimensional-report-label") || document.querySelectorAll(".dimensional-time-labels>span")[index];
        const value = cell.querySelector(".dimensional-count,strong");
        const icon = cell.querySelector(".dimensional-category-icon");
        const css = caption && getComputedStyle(caption, "::before");
        const pseudo = css && !["none", "normal"].includes(css.content) && css.display !== "none";
        const line = cell.querySelector(".dimensional-guide");
        const faces = [...cell.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap,.flat-time-segment")].map(box);
        const record = {
            label: label.textContent, valueText: value.textContent, cell: box(cell), value: box(value), labelBox: box(label), icon: box(icon),
            guideCount: cell.querySelectorAll(".dimensional-guide").length + Number(Boolean(pseudo)),
            action: box(cell.querySelector("button")), zero: !svg,
            paintCenter: faces.length ? (Math.min(...faces.map(face => face.x)) + Math.max(...faces.map(face => face.right))) / 2 : null,
            total: Number(svg?.dataset.total || 0), maximum: Number(svg?.dataset.maximum || 1), extent: Number(svg?.dataset.plotHeight || 280),
            edge: Number(svg?.dataset.frontHeight ?? svg?.getAttribute("height") ?? 0),
            counts: [...cell.querySelectorAll(".dimensional-front,.flat-time-segment")].map(face => Number(face.dataset.count)),
        };
        if (!svg) return record;
        const front = cell.querySelector(".dimensional-front,.flat-time-segment");
        const vertex = new DOMPoint(front.x.baseVal.value, front.y.baseVal.value + front.height.baseVal.value)
            .matrixTransform(front.getScreenCTM());
        let guide = null;
        if (line) {
            const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(line.getScreenCTM());
            const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(line.getScreenCTM());
            guide = { x: start.x, y: start.y, bottom: end.y, endX: end.x,
                stroke: Number(getComputedStyle(line).strokeWidth.replace("px", "")),
                pointerEvents: getComputedStyle(line).pointerEvents };
        } else if (pseudo) {
            const b = caption.getBoundingClientRect();
            guide = {
                x: b.x + parseFloat(css.left) + parseFloat(css.borderLeftWidth) / 2,
                y: b.y + parseFloat(css.top), bottom: b.y + parseFloat(css.top) + parseFloat(css.height),
            };
        }
        return { ...record, vertex: { x: vertex.x, y: vertex.y }, guide,
            dx: guide ? guide.x - vertex.x : null, dy: guide ? guide.y - vertex.y : null,
            lane: (icon || label).getBoundingClientRect().y,
            base: vertex.y - cell.getBoundingClientRect().y,
        };
    }));
}

function aligned(rows, context, { time = false, scaledSvg = false, minimumClearance = 5 } = {}) {
    for (const row of rows) {
        const name = `${context}/${row.label}`;
        assert.equal(row.guideCount, 0, `${name}: centered glass columns need no redundant connector`);
        if (row.guide) {
            assert.ok(Math.abs(row.dx) <= 1 && Math.abs(row.dy) <= 1,
                `${name}: guide starts ${row.dx}px right and ${row.dy}px below the rendered corner (1 CSSpx tolerance including stroke)`);
            assert.ok(Math.abs(row.guide.endX - row.guide.x) <= .01, `${name}: guide stays vertical`);
            assert.ok(row.guide.bottom + row.guide.stroke / 2 <= row.lane - minimumClearance, `${name}: guide clears the icon/label lane`);
            assert.equal(row.guide.pointerEvents, "none", `${name}: guide cannot enlarge the hit target`);
        }
        assert.ok(Math.abs(row.value.center - row.labelBox.center) <= 1, `${name}: value/label midpoint is unchanged`);
        if (row.icon) assert.ok(Math.abs(row.icon.center - row.labelBox.center) <= 1, `${name}: icon midpoint is unchanged`);
        if (!row.zero) {
            if (!scaledSvg) {
                assert.ok(Math.abs(row.paintCenter - row.labelBox.center) <= 1, `${name}: text stays on the painted silhouette midpoint, not corner`);
                assert.ok(Math.abs(row.base - rows.find(item => !item.zero).base) < .03, `${name}: common zero baseline`);
            }
            assert.ok(Math.abs(row.edge - (time ? row.total / row.maximum * row.extent
                : Math.max(36, Math.sqrt(row.total / row.maximum) * row.extent))) < .01, `${name}: declared count scale`);
            assert.equal(row.counts.reduce((sum, count) => sum + count, 0), row.total, `${name}: exact segment counts`);
            if (row.action) {
                assert.ok(row.action.width <= 116.01 && row.action.height <= row.extent + 23.05, `${name}: no enlarged action rectangle`);
            }
        }
    }
}

async function saveProof(page, name, rows) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await writeFile(path.join(proofDir, `${name}.json`), JSON.stringify(rows, null, 2));
    await page.locator(".chart-panel,.dimensional-report").first().screenshot({ path: path.join(proofDir, `${name}.png`) });
}

test("dotted category guides start on the actual projected front-bottom corner", async () => {
    const browser = await chromium.launch();
    const proof = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, reducedMotion: "reduce" });
        for (const serviceMode of [true, false]) {
            await mount(page, serviceMode);
            const rows = await measure(page);
            proof.push({ view: serviceMode ? "service" : "api", rows });
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${serviceMode ? "service" : "api"}-1200-light.png`) });
                await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(proof, null, 2));
            }
        }
        for (const { view, rows } of proof) aligned(rows, view);
    } finally { await browser.close(); }
});

const fixtureGroups = (totals, stacked = false) => totals.map((total, index) => ({
    id: `guide-${index}`, label: ["Calendar", "Mail", "/chats/{id}/messages", "Teams", "Files"][index % 5],
    total, success: total - (stacked ? Math.floor(total / 3) : 0),
    failure: stacked ? Math.floor(total / 3) : 0, unknown: 0, partial: 0, other: 0, transport: 0,
}));

test("service/API guides retain actual corner attachment across themes, responsive pitch and enlarged root text", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const serviceMode of [true, false]) for (const theme of ["light", "dark"]) for (const fontScale of [1, 2]) {
            for (const width of [375, 820, 1200, 2560]) {
                await page.setViewportSize({ width, height: 1000 });
                await mount(page, serviceMode, fixtureGroups([121, 9, 28, 1, 0], true), { theme, fontScale });
                const rows = await measure(page);
                const name = `${serviceMode ? "service" : "api"}-${theme}-${width}-text${fontScale}`;
                aligned(rows, name);
                assert.deepEqual(rows.map(row => row.total), [121, 9, 28, 1, 0]);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                if (width === 375 || width === 2560) await saveProof(page, name, rows);
            }
        }
    } finally { await browser.close(); }
});

test("zero, subpixel, tiny, single, stacked and reordered data retain one honest corner guide without changing time labels", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
        const cases = [[0], [1], [9], [0, 0], [200, 1, 0], [201, 1, 0], [100000, 1, 0], [121, 9, 121, 50, 28]];
        for (const serviceMode of [true, false]) for (const totals of cases) for (const stacked of [false, true]) {
            const source = fixtureGroups(totals, stacked);
            await mount(page, serviceMode, source);
            aligned(await measure(page), `shape/${serviceMode}/${totals}/${stacked}`);
            for (const next of [source.slice().reverse(), source.filter(group => group.total > 0), source.slice(0, 1)]) {
                await page.evaluate(source => window.render(source), next);
                await settle(page);
                const rows = await measure(page);
                aligned(rows, "filtered/order");
                assert.deepEqual(rows.map(row => row.total), next.map(group => group.total));
                assert.deepEqual(rows.map(row => row.label), next.map(group => group.label));
            }
        }
        await mount(page, false, fixtureGroups([100000, 1, 0], true), { time: true });
        aligned(await measure(page), "time/subpixel", { time: true });
        await mount(page, false, fixtureGroups([121, 9, 28, 0], true), { time: true, fontScale: 2 });
        aligned(await measure(page), "time/stacked", { time: true });
        const charts = createDimensionalCharts();
        assert.equal(charts.svg({ total: 0, maximum: 1, service: "Calendar", guide: true }), "");
        assert.throws(() => charts.svg({ total: -1, maximum: 1, service: "Calendar", guide: true }), /nonnegative safe count/);
    } finally { await browser.close(); }
});

test("container resize, scroll, SVG viewBox scaling and CSS zoom keep the same corner without extending hit targets", { timeout: 30000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 2560, height: 1300 }, reducedMotion: "reduce" });
        for (const serviceMode of [true, false]) {
            await mount(page, serviceMode, fixtureGroups([121, 9, 28, 50], true));
            const labels = (await measure(page)).map(row => ({ label: row.label, value: row.valueText }));
            for (const width of [360, 780, 2400]) {
                await page.locator(".chart-panel").evaluate((panel, width) => { panel.style.width = `${width}px`; }, width);
                await settle(page);
                aligned(await measure(page), `container/${width}`);
                await page.locator(".dimensional-scroll").evaluate(node => { node.scrollLeft = node.scrollWidth; });
                aligned(await measure(page), `scrolled/${width}`);
                assert.deepEqual((await measure(page)).map(row => ({ label: row.label, value: row.valueText })), labels);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
            await page.locator(".dimensional-column").evaluateAll(nodes => nodes.forEach(svg => {
                const { width, height } = svg.viewBox.baseVal;
                svg.setAttribute("viewBox", `0 0 ${width * 1.25} ${height * 1.25}`);
            }));
            const scaled = await measure(page);
            aligned(scaled, "actual SVG viewBox scaling", { scaledSvg: true });
            await saveProof(page, `viewbox-${serviceMode}`, scaled);
            await mount(page, serviceMode, fixtureGroups([121, 9, 28, 50], true));
            await page.locator(".chart-panel").evaluate(panel => { panel.style.zoom = "1.25"; });
            await settle(page);
            const zoomed = await measure(page);
            // CSS zoom is a distinct coordinate-transform probe, not native browser zoom.
            for (const row of zoomed) {
                assert.equal(row.guide, null);
                assert.ok(row.value.bottom < row.lane);
            }
            await mount(page, serviceMode, fixtureGroups([121], true));
            const row = (await measure(page))[0];
            await page.mouse.click(row.cell.x + 4, row.cell.y + 4);
            assert.deepEqual(await page.evaluate(() => window.selections), [], "Clicking the decorative guide does not select a column");
            await page.locator(".dimensional-front").first().click();
            assert.deepEqual(await page.evaluate(() => window.selections), ["guide-0"], "Painted faces still select the same data");
        }
    } finally { await browser.close(); }
});

test("frozen script-free report HTML and PDF use the same corner guides and preserve exact labels/counts", { timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    const source = fixtureGroups([121, 9, 28, 1, 0], true);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:24px;font-family:Arial;color:#18344d}
        ${dimensionalReportStyles}
        @page{size:A4;margin:16mm}
        </style></head><body><h1>Synthetic corner guides</h1>${createDimensionalReportChart()({
        layer: "tool-call", unit: "synthetic calls", visibleGroups: source,
    })}</body></html>`;
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        await page.route("**/*", route => { throw new Error(`Unexpected report request: ${route.request().url()}`); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 1100 });
            await page.emulateMedia({ media });
            const rows = await measure(page);
            aligned(rows, `report/${media}/${width}`);
            assert.deepEqual(rows.map(row => row.total), source.map(group => group.total));
            assert.deepEqual(rows.map(row => row.label), source.map(group => group.label));
            if (media === "screen") assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (width === 820) await saveProof(page, `report-${media}`, rows);
        }
        const bytes = await renderPdf(html);
        const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
        try {
            const pdf = await loading.promise;
            const text = [];
            for (let number = 1; number <= pdf.numPages; number++) {
                const pdfPage = await pdf.getPage(number);
                const content = await pdfPage.getTextContent();
                text.push(content.items.map(item => item.str).join(" "));
                for (const item of content.items.filter(item => item.str?.trim())) {
                    assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= pdfPage.view[2] + 1, "PDF text stays inside its real page horizontally");
                    assert.ok(item.transform[5] >= 0 && item.transform[5] + item.height <= pdfPage.view[3] + 1, "PDF text stays inside its real page vertically");
                }
                if (proofDir) {
                    const viewport = pdfPage.getViewport({ scale: 1.5 });
                    const rendered = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await pdfPage.render({ canvasContext: rendered.context, viewport }).promise;
                    await writeFile(path.join(proofDir, `guide-report-page-${number}.png`), rendered.canvas.toBuffer("image/png"));
                    pdf.canvasFactory.destroy(rendered);
                }
            }
            for (const row of source) {
                assert.ok(text.join(" ").includes(row.label), `${row.label}: PDF label retained`);
                assert.match(text.join(" "), new RegExp(`\\b${row.total}\\b`), `${row.total}: PDF count retained`);
            }
            if (proofDir) {
                await writeFile(path.join(proofDir, "guide-report.html"), html);
                await writeFile(path.join(proofDir, "guide-report.pdf"), bytes);
            }
        } finally { await loading.destroy(); }
    } finally { await browser.close(); }
});
