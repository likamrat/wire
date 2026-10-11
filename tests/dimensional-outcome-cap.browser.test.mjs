import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createPercentageCharts } from "../lib/percentage-charts.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "../lib/dimensional-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { selectActivityOption } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_OUTCOME_CAP_PROOFS;
const keys = ["success", "failure", "unknown", "partial", "other", "transport"];
const group = (parts, index = 0) => ({
    id: `synthetic-${index}`, label: `Synthetic ${index + 1}`,
    total: keys.reduce((sum, key) => sum + (parts[key] || 0), 0),
    ...Object.fromEntries(keys.map(key => [key, parts[key] || 0])),
});
const points = [
    group({ success: 9 }), group({ success: 19, failure: 9 }, 1),
    group({ success: 6, failure: 3 }, 2), group({ success: 113, failure: 7, unknown: 1 }, 3),
    group({ success: 44, failure: 6 }, 4),
];
const api = [group({ success: 80 }, 0), group({ success: 22, failure: 5, unknown: 1 }, 1)];

async function mount(page, groups, { width = 1200, theme = "light", scale = 1, time = true, narrow = false } = {}) {
    await page.setViewportSize({ width, height: 1050 });
    await page.setContent(`<html data-evidence-theme="${theme}" style="font-size:${scale * 100}%"><head><style>${styles}</style></head><body><main style="padding:16px;max-width:none;width:100%;margin:0"><section class="chart-panel" style="${narrow ? "max-width:320px" : ""}"><h2>Synthetic outcome geometry</h2><div id="chart"></div></section></main></body></html>`);
    await page.addScriptTag({ content: `window.charts=(${createDimensionalCharts})();window.ux=(${createEvidenceUX})(${JSON.stringify(uxIcons)});window.results=(${createRecordedResults})();window.percent=(${createPercentageCharts})().percent;` });
    await page.evaluate(({ groups, time }) => {
        const names = window.results.labels("tool");
        const breakdown = (g, keys = Object.keys(names)) => keys.map(key => `${g[key]} ${names[key].toLowerCase()} (${window.percent(g[key], g.total)})`).join("; ");
        const summary = g => `${g.label}: ${g.total} calls. ${breakdown(g)}. Shares of this column.`;
        window.selections = [];
        const options = {
            points: groups, groups, serviceMode: false, label: g => g.label,
            summary, detail: breakdown, unit: total => total === 1 ? "call" : "calls",
            tooltip: window.ux.tooltip, onSelect: g => window.selections.push(g.id),
            help: g => window.ux.helpButton(`${g.label}: recorded results`, summary(g) + (g.unknown ? " No completion was retained; this is not evidence of success or failure." : "")),
        };
        document.querySelector("#chart").append(time ? window.charts.timeView(options) : window.charts.comparisonView(options));
    }, { groups, time });
}

async function geometry(page) {
    return page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(svg => {
        const box = svg.getBoundingClientRect(), action = svg.closest("button");
        const fronts = [...svg.querySelectorAll(".dimensional-front")];
        const cap = svg.querySelector(".dimensional-cap");
        const faces = [...svg.querySelectorAll(".dimensional-front,.dimensional-side")];
        const measurements = fronts.map(front => {
            const h = front.height.baseVal.value, top = front.y.baseVal.value;
            const matrix = front.getScreenCTM();
            const point = new DOMPoint(front.width.baseVal.value / 2, top + h / 2).matrixTransform(matrix);
            const candidates = document.elementsFromPoint(point.x, point.y);
            return {
                count: +front.dataset.count, h, exactHeight: +front.getAttribute("height"), edge: h * matrix.d, stroke: getComputedStyle(front).stroke,
                point: { x: point.x, y: point.y }, hit: candidates.includes(front),
                frontArea: front.width.baseVal.value * h,
                actualFill: front.isPointInFill(new DOMPoint(front.width.baseVal.value / 2, top + h / 2)),
            };
        });
        return {
            total: +svg.dataset.total, maximum: +svg.dataset.maximum, height: +svg.dataset.frontHeight, extent: +svg.dataset.plotHeight,
            x: box.x, right: box.right, cap: cap && { fill: getComputedStyle(cap).fill, beforeData: !!(cap.compareDocumentPosition(fronts[0]) & Node.DOCUMENT_POSITION_FOLLOWING) },
            faces: measurements,
            sideStrokes: faces.filter(n => n.classList.contains("dimensional-side")).map(n => getComputedStyle(n).stroke),
            label: action.getAttribute("aria-label"),
            countText: action.querySelector(".dimensional-count").textContent,
            valueBottom: action.querySelector(".dimensional-count").getBoundingClientRect().bottom,
            shapeTop: box.y,
        };
    }));
}

test("clear outcome lids, true thin edges and exact numeric help survive both chart types, themes and text sizes", { timeout: 60000 }, async () => {
    const browser = await chromium.launch(), evidence = [];
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        for (const time of [true, false]) for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            const groups = time ? points : api;
            await mount(page, groups, { time, theme, width, scale });
            const rows = await geometry(page);
            evidence.push({ time, theme, width, scale, rows });
            assert.deepEqual(rows.map(row => row.total), groups.map(g => g.total));
            for (const [index, row] of rows.entries()) {
                assert.ok(row.cap?.beforeData, "Neutral lids paint before the full exact outcome faces");
                assert.ok(row.faces.every(face => face.stroke === "none" && face.actualFill), "No 1px outlines can consume thin bands");
                assert.ok(row.sideStrokes.every(stroke => stroke === "none"));
                assert.ok(Math.abs(row.faces.reduce((sum, face) => sum + face.edge, 0) - Math.max(36, Math.sqrt(row.total / row.maximum) * row.extent)) < .03);
                assert.equal(row.faces.reduce((sum, face) => sum + face.count, 0), row.total);
                assert.ok(row.valueBottom <= row.shapeTop - 4, "Counts never overlap the lid or data");
                if (index) assert.ok(row.x - rows[index - 1].right >= 8, "No overlapping column targets");
            }
            const index = time ? 3 : 1, control = page.locator(time ? ".time-column" : ".dimensional-action").nth(index);
            await control.focus();
            const tooltip = page.getByRole("tooltip");
            assert.equal(await tooltip.isVisible(), false);
            assert.match(await control.getAttribute("aria-label"), time ? /1 no result recorded \(0.8%\)/ : /1 no result recorded \(3.6%\)/);
            await page.keyboard.press("Escape");
            assert.equal(await tooltip.isVisible(), false);
            assert.equal(await page.locator(".ux-help").count(), 0);
            assert.ok((await control.locator(".dimensional-count").boundingBox()).height >= 44);
            await page.keyboard.press("Escape");
            await control.focus();
            await page.keyboard.press("Enter");
            assert.deepEqual(await page.evaluate(() => window.selections), [groups[index].id]);
            assert.equal(await tooltip.isVisible(), false, "Native action dismissal cannot pin a stale chart tooltip");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await page.locator(".dimensional-small-results").count(), 0);
            if (proofDir && scale === 1) {
                await mkdir(proofDir, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${time ? "time" : "api"}-${theme}-${width}-focus.png`) });
                await page.locator("h2").click();
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `${time ? "time" : "api"}-${theme}-${width}.png`) });
            }
        }
        if (proofDir) await writeFile(path.join(proofDir, "rendered-geometry.json"), JSON.stringify(evidence, null, 2));
    } finally { await browser.close(); }
});

test("integrated client keeps exact outcome/help/table shares and help focus through filtered snapshot replacement", { timeout: 30000 }, async () => {
    const source = [points[3], api[1]].flatMap((g, index) => keys.flatMap(key => Array.from({ length: g[key] }, (_, ordinal) => ({
        scenarioId: `synthetic-cap-${index}-${key}-${ordinal}`, sourceSessionId: "synthetic-cap-session",
        sourceSessionName: "Synthetic outcome proof", workloadKind: "recorded-history",
        capturedAt: `2026-09-${index ? "28" : "21"}T12:00:00Z`,
        workflowState: "ready_to_export", userPrompt: { text: "SYNTHETIC ONLY", status: "full" },
        toolCalls: [{
            toolCallId: `synthetic-call-${index}-${key}-${ordinal}`, tool: index ? "workiq-ask" : "workiq-fetch",
            startedAt: `2026-09-${index ? "28" : "21"}T12:00:00Z`,
            ...(index ? {} : { requestedApiPath: "/me/messages", requestArgs: { entityUrls: ["/me/messages"] } }),
            ...(key === "unknown" ? {} : { toolSucceeded: key === "success", reportedOutcome: key === "success" ? "succeeded" : "failed" }),
        }],
    }))));
    const before = structuredClone(source), requests = [], errors = [];
    let revision = 1;
    const server = createServer(async (req, res) => {
        if (req.method === "GET") { res.setHeader("Content-Type", "text/html"); res.end(renderHtmlShell("a".repeat(64), "cap-fixture")); return; }
        requests.push(req.url);
        if (req.url !== "/api/snapshot") { res.writeHead(403); res.end('{"error":"Synthetic read-only fixture"}'); return; }
        let text = ""; for await (const chunk of req) text += chunk;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ revision, scenarios: source, exports: [], coverage: { notes: [] },
            analytics: { ...buildActivityAnalytics(source, JSON.parse(text)), revision } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const ready = async page => {
        await page.locator("#workspace").waitFor({ state: "visible" });
        await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    };
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
        page.setDefaultTimeout(3000);
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/`); await ready(page);
        assert.deepEqual(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.map(n => +n.dataset.total)), [121, 28]);
        const control = page.locator(".time-column").first();
        await control.focus();
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.match(await control.getAttribute("aria-label"), /113 worked \(93.4%\).*7 tool failed \(5.8%\).*1 no result recorded \(0.8%\)/);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".dimensional-time-labels .ux-help").count(), 0);
        const helpKey = await control.getAttribute("data-view-key");
        revision++;
        await page.evaluate(() => document.querySelector("#refreshBtn").click()); await ready(page);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.viewKey), helpKey, "Snapshot replacement retains the same accessible help target");
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "Restored focus cannot reopen dismissed help");
        assert.equal(await page.locator("#tableDisclosure").evaluate(node => node.open), false);
        await page.locator("#tableDisclosure>summary").click();
        assert.deepEqual(await page.locator("#countTable tbody tr").first().locator("td").allTextContents(), ["Sep 21, 2026", "121", "113", "7", "1"]);
        await selectActivityOption(page, "outcomeFilter", "unknown"); await ready(page);
        assert.deepEqual(await page.locator(".flat-time-column").evaluateAll(nodes => nodes.map(n => +n.dataset.total)), [1, 1]);
        await page.locator(".time-column").first().focus();
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
        assert.match(await page.locator(".time-column").first().getAttribute("aria-label"), /1 no result recorded \(100%\)/);
        await page.keyboard.press("Escape");
        await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
        await page.locator('[data-chart="endpoint"]').click(); await ready(page);
        const ask = page.locator(".dimensional-category").filter({ hasText: "workiq-ask" });
        assert.equal(await ask.locator("svg.dimensional-column").getAttribute("data-total"), "28");
        assert.match(await ask.locator(".dimensional-action").getAttribute("aria-label"), /22 worked \(78.6%\).*5 tool failed \(17.9%\).*1 no result recorded \(3.6%\)/);
        assert.equal(await ask.locator(".dimensional-cap-clear").count(), 1);
        assert.equal(await ask.locator(".ux-help").count(), 0);
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => route === "/api/snapshot"));
        assert.deepEqual(source, before);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test("tiny upper/middle/lower, singles, zeros and many stacks preserve exact geometry with real-face hit targets", { timeout: 30000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce", hasTouch: true });
        page.setDefaultTimeout(3000);
        const cases = [
            { success: 99999, unknown: 1 }, { success: 1, failure: 99999 }, { success: 99998, failure: 1, unknown: 1 },
            ...keys.map(key => ({ [key]: 100000 })), ...keys.map(key => ({ [key]: 1 })),
            Object.fromEntries(keys.map(key => [key, 1])), {},
        ].map(group);
        for (const theme of ["light", "dark"]) {
            await mount(page, cases, { theme, width: 1200, narrow: true });
            const rows = await geometry(page);
            assert.equal(rows.length, cases.filter(g => g.total).length);
            for (const row of rows) for (const face of row.faces) {
                assert.ok(face.exactHeight >= 6 - 1e-10, "Every positive result has its declared readable visual band");
                assert.ok(Math.abs(face.edge - face.exactHeight) < .03 && Math.abs(face.edge / face.exactHeight - 1) < .002,
                    `Chromium layout rounding must not inflate even subpixel data: ${JSON.stringify(face)}`);
                assert.ok(face.frontArea > 0, "Small values are neither inflated nor omitted");
            }
            assert.equal(await page.locator(".time-zero").count(), 1);
            await page.locator(".time-column").first().focus();
            await page.keyboard.press("Escape");
            const front = page.locator(".time-column").first().locator(".success");
            const hit = await front.evaluate(node => {
                const p = new DOMPoint(node.width.baseVal.value / 2, node.y.baseVal.value + node.height.baseVal.value / 2).matrixTransform(node.getScreenCTM());
                return { x: p.x, y: p.y, target: document.elementFromPoint(p.x, p.y)?.closest("button") === node.closest("button") };
            });
            assert.equal(hit.target, true);
            await page.mouse.move(8, 8);
            await page.mouse.move(hit.x, hit.y);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.match(await page.locator(".time-column").first().getAttribute("aria-label"), /1 no result recorded \(<0.1%\)/);
            await page.keyboard.press("Escape");
            assert.match(await page.locator(".time-column").first().getAttribute("aria-label"), /99999 worked \(>99.9%\)/);
            await page.locator("h2").tap();
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            await page.locator(".time-column").first().focus();
            await page.locator(".chart-panel").evaluate(node => { node.style.maxWidth = "290px"; });
            assert.equal(await page.locator(".time-column").first().evaluate(node => node === document.activeElement), true);
            await page.emulateMedia({ forcedColors: "active" });
            assert.equal(await page.locator(".dimensional-cap-clear").count(), cases.filter(g => g.total).length);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.emulateMedia({ forcedColors: "none" });
        }
    } finally { await browser.close(); }
});

test("new synthetic HTML and PDF share clear outcome caps and retain every tiny result in exact data", { timeout: 60000 }, async () => {
    const groups = [points[3], api[1], group({ unknown: 1 }, 6)];
    const chart = createDimensionalReportChart()({ layer: "tool", unit: "synthetic calls", visibleGroups: groups });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{font-family:Arial;margin:24px}${dimensionalReportStyles}@page{size:A4;margin:16mm}</style></head><body><h1>Synthetic outcome proof only</h1>${chart}<table><caption>Exact synthetic recorded results</caption><tr><th>Group</th><th>Total calls</th><th>Worked</th><th>Needs attention</th><th>No result recorded</th></tr>${groups.map(g => `<tr><td>${g.label}</td><td>${g.total}</td><td>${g.success}</td><td>${g.failure}</td><td>${g.unknown}</td></tr>`).join("")}</table><p>No result recorded is not evidence of success or failure.</p></body></html>`;
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        await page.setContent(html);
        for (const media of ["screen", "print"]) {
            await page.emulateMedia({ media });
            const caps = await page.locator(".dimensional-cap").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill));
            assert.equal(caps.length, groups.length);
            assert.ok(caps.every(fill => /-end"\)$/.test(fill)), "All tops use the shared neutral finish, never paper-colored holes or the final outcome");
            const counts = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(node => [...node.querySelectorAll(".time-segment")].map(s => +s.dataset.count)));
            assert.deepEqual(counts, [[1, 113, 7], [1, 22, 5], [1]]);
            if (proofDir) await page.screenshot({ path: path.join(proofDir, `outcome-report-${media}.png`), fullPage: true });
        }
        const bytes = await renderPdf(html);
        const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
        const pdf = await loading.promise;
        try {
            const texts = [];
            for (let number = 1; number <= pdf.numPages; number++) {
                const page = await pdf.getPage(number), content = await page.getTextContent();
                texts.push(content.items.map(item => item.str).join(" "));
                if (proofDir) {
                    const viewport = page.getViewport({ scale: 1.5 }), canvas = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await page.render({ canvasContext: canvas.context, viewport }).promise;
                    await writeFile(path.join(proofDir, `outcome-report-pdf-${number}.png`), canvas.canvas.toBuffer("image/png"));
                    pdf.canvasFactory.destroy(canvas);
                }
            }
            assert.match(texts.join(" "), /No result recorded/);
            assert.match(texts.join(" "), /113/);
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await writeFile(path.join(proofDir, "outcome-report.html"), html);
                await writeFile(path.join(proofDir, "outcome-report.pdf"), bytes);
            }
        } finally { await loading.destroy(); }
    } finally { await browser.close(); }
});
