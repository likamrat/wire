import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportDocument, readSavedComparisonFile, loadSavedReportSource, reportHash } from "../lib/report-artifacts.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { privateFixture, fixture } from "./helpers.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { uiFontStack } from "../lib/typeface.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { adaptEvaluationReport } from "../lib/report-facts.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonHtml } from "../lib/report-presentation.mjs";
import { contrast, hue, measureChartPaint } from "./color-measurements.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";

async function inspectPdf(bytes, directory) {
    if (directory) await mkdir(directory, { recursive: true });
    const strict = await pdfDocumentText(bytes);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
    try {
        const document = await task.promise, pages = [], fonts = new Map(), margins = [];
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 });
            const operators = await page.getOperatorList();
            for (const id of new Set(operators.fnArray.flatMap((op, index) => op === OPS.setFont ? [operators.argsArray[index][0]] : []))) {
                const font = page.commonObjs.get(id);
                assert.equal(font.missingFile, false, font.name);
                assert.ok(font.data?.byteLength > 0 || font.isType3Font, `${font.name}: embedded font data or Type 3 glyph programs required`);
                fonts.set(id, { name: font.name, bytes: font.data?.byteLength ?? 0, type3Glyphs: font.isType3Font });
            }
            let paint = { font: null, color: null };
            const stack = [];
            for (const [index, op] of operators.fnArray.entries()) {
                const args = operators.argsArray[index];
                if (op === OPS.save) stack.push({ ...paint });
                if (op === OPS.restore) paint = stack.pop();
                if (op === OPS.setFillRGBColor) paint.color = args[0];
                if (op === OPS.setFont) paint.font = page.commonObjs.get(args[0]).name;
                if (op === OPS.showText) {
                    const text = args[0].map(glyph => glyph.unicode ?? "").join("");
                    if (text === "WIRE - local report" || text === "Page ") margins.push({ page: number, text, ...paint });
                }
            }
            const content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `Page ${number}: horizontal text clipping`);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `Page ${number}: vertical text clipping`);
            }
            pages.push(content.items.map(item => (item.str ?? "") + (item.hasEOL ? "\n" : " ")).join(""));
            if (directory) {
                const view = page.getViewport({ scale: 1.25 }), surface = document.canvasFactory.create(view.width, view.height);
                await page.render({ canvasContext: surface.context, viewport: view }).promise;
                await writeFile(path.join(directory, `pdf-page-${number}.png`), surface.canvas.toBuffer("image/png"));
                document.canvasFactory.destroy(surface);
            }
        }
        assert.equal(strict.pages, pages.length);
        return { pageCount: pages.length, pages, text: pages.join("\n"), fonts: [...fonts.values()], margins, strictReaderPages: strict.pages };
    } finally { await task.destroy(); }
}

async function keepProof(name, files) {
    if (!process.env.WIRE_NATIVE_PROOFS) return null;
    const directory = path.join(process.env.WIRE_NATIVE_PROOFS, name);
    await mkdir(directory, { recursive: true });
    for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(directory, file), bytes);
    return directory;
}

test("new human reports lead with their title and data, not repeated headings or machinery", { timeout: 60000 }, async t => {
    const records = matrixRecords("report-reading", ["failure", "success", "unknown", "success"], {
        groups: 2, durations: [100, 300, null, 500],
    });
    const title = "Calendar planning review";
    const bundle = await buildSanitizedBundle(records, "b".repeat(64), {
        title, promptMode: "none", formats: ["html", "pdf", "json", "markdown"],
    });
    const directory = await keepProof("human-report", bundle.files);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    const external = [], observations = [], violations = [];
    await context.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(bundle.previewHtml);
        await page.locator("html").evaluate((node, { theme, scale }) => {
            node.dataset.evidenceTheme = theme; node.style.fontSize = scale + "%";
        }, { theme, scale });
        await page.evaluate(() => document.fonts.ready);
        const reading = await page.evaluate(() => {
            const heading = document.querySelector("h1"), mark = [...document.querySelectorAll(".report-brand .brand-logo")].find(node => node.checkVisibility());
            const visible = node => node.checkVisibility();
            return {
                title: heading.textContent, titleTop: heading.getBoundingClientRect().top, markTop: mark.getBoundingClientRect().top,
                h1: document.querySelectorAll("h1").length,
                headings: [...document.querySelectorAll("h2")].filter(visible).map(node => node.textContent),
                overviewVisible: document.querySelector("#overview")?.checkVisibility(),
                overviewTop: document.querySelector("#overview")?.getBoundingClientRect().top,
                links: [...document.querySelectorAll(".report-nav a")].map(node => node.getAttribute("href")),
                text: document.querySelector("main").innerText,
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                font: getComputedStyle(heading).fontFamily,
                captionWidth: document.querySelector("#overview caption").getBoundingClientRect().width,
                tableWidth: document.querySelector("#overview table").getBoundingClientRect().width,
            };
        });
        observations.push({ theme, width, scale, ...reading });
        const fail = (condition, reason) => { if (condition) violations.push(`${theme}/${width}/${scale}: ${reason}`); };
        fail(reading.h1 !== 1 || reading.title !== title || reading.titleTop > reading.markTop + 1, "the actual title must lead the document");
        fail(!reading.overviewVisible || width === 1280 && reading.overviewTop > 400, "primary activity data is buried");
        fail(!["Activity", "Timing", "Examples", "Operations"].every(name => reading.headings.includes(name)), "data sections are not clear");
        fail(new Set(reading.links).size !== reading.links.length, "section navigation repeats destinations");
        fail(/scenario-[a-f0-9]|Request reference:|masked-copy|retained-original|schemaVersion|stored revision/.test(reading.text), "machinery competes with the main report");
        fail(reading.headings.includes("Reviewed prompt copies"), "No-prompts mode has a redundant empty section");
        fail(reading.overflow || !reading.font.includes("Asta Sans"), "reading must reflow without replacing typography");
        fail(Math.abs(reading.captionWidth - reading.tableWidth) > 1, "the activity caption must not collapse to a narrow strip");
        if (directory) await page.screenshot({ path: path.join(directory, `${theme}-${width}-${scale}.png`), fullPage: true });
    }
    const pdf = await inspectPdf(bundle.files["product-report.pdf"], directory);
    assert.ok(pdf.text.includes(title));
    assert.equal([...pdf.text.matchAll(/\/me\/drive\/items\/\{id\}/g)].length, 2, "The example and operation-table path both remain intact");
    assert.equal(JSON.parse(bundle.files["product-report.json"]).title, title);
    assert.deepEqual(external, []);
    if (directory) await writeFile(path.join(directory, "reading.json"), JSON.stringify({ observations, pdf }, null, 2));
    assert.deepEqual(violations, []);
});

test("new comparison files keep long titles, source facts and readable light, dark and enlarged output", { timeout: 60000 }, async t => {
    const seed = qualityDisplayFixture({ requests: 3, calls: 7, timed: 6 }).state;
    const { context } = await privateFixture(t, seed.evidence), controller = createExportController(context), sources = [];
    for (const scenarioIds of [["quality-request-0", "quality-request-1"], ["quality-request-1", "quality-request-2"]]) {
        const state = await loadBoardState(context);
        const preview = await controller.preview("output-sources", undefined, { promptMode: "none", formats: ["html"] },
            { kind: "selected", revision: state.revision, scenarioIds });
        await controller.review("output-sources", preview.previewId, true);
        sources.push((await controller.confirm("output-sources", preview.previewId, true)).bundle);
    }
    const title = "Planning follow-through: comparing calendar and document retrieval across two recorded work periods";
    const preview = await controller.previewComparison("comparison-output", sources[0].bundleId, sources[1].bundleId,
        { title, formats: ["html", "pdf", "json", "markdown"] });
    const facts = JSON.stringify(preview.comparison);
    await controller.reviewComparison("comparison-output", preview.previewId, true);
    const saved = (await controller.confirmComparison("comparison-output", preview.previewId, true)).bundle;
    const state = await loadBoardState(context), files = {};
    for (const format of saved.formats) {
        const file = await readSavedComparisonFile(context, state, saved.bundleId, format);
        assert.equal(file.canonicalTitle, title);
        files[file.name] = file.bytes;
    }
    assert.equal(JSON.stringify(JSON.parse(files["comparison-report.json"]).comparison), facts);
    const directory = await keepProof("human-comparison", files), observations = [];
    const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, serviceWorkers: "block" }), external = [];
    await page.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1280, 100], [375, 100], [375, 200]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(files["comparison-report.html"].toString());
        await page.locator("html").evaluate((node, value) => {
            node.dataset.evidenceTheme = value.theme; node.style.fontSize = value.scale + "%";
        }, { theme, scale });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator("h1").textContent(), title);
        assert.equal(await page.locator("h1").count(), 1);
        const shape = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            font: getComputedStyle(document.querySelector("h1")).fontFamily,
            text: document.querySelector("main").innerText,
            paper: getComputedStyle(document.body).backgroundColor,
            failures: [...document.querySelectorAll(".comparison-outcome-failure")].map(node => getComputedStyle(node).backgroundColor),
            measureSize: parseFloat(getComputedStyle(document.querySelector(".comparison-metric-value")).fontSize),
            rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        }));
        assert.equal(shape.overflow, false);
        assert.match(shape.font, /Asta Sans/);
        assert.ok(!shape.text.includes(saved.bundleId), "Technical identities belong to coverage, not the reading lead");
        assert.match(shape.text, /Earlier/); assert.match(shape.text, /Later/);
        assert.match(shape.text, /Median tool latency/, "The named timing statistic remains visible beside its value");
        assert.ok(shape.measureSize <= shape.rootSize, "Table values use readable body type, not oversized headline type");
        assert.ok(shape.failures.length);
        for (const color of shape.failures) {
            assert.ok(hue(color) <= 15 || hue(color) >= 345, "Failed calls must be red, not orange");
            assert.ok(contrast(color, shape.paper) >= 3);
        }
        observations.push({ theme, width, scale, ...shape });
        if (directory) await page.screenshot({ path: path.join(directory, `${theme}-${width}-${scale}.png`), fullPage: true });
    }
    const pdf = await inspectPdf(files["comparison-report.pdf"], directory);
    assert.ok(pdf.text.replace(/\s+/g, " ").includes(title));
    assert.deepEqual(external, []);
    for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await readFile(saved.files[name]), bytes);
    if (directory) await writeFile(path.join(directory, "reading.json"), JSON.stringify({ observations, pdf }, null, 2));
});

test("native report bars separate outcome pills and adjacent rows at normal and enlarged text", { timeout: 120000 }, async t => {
    const records = matrixRecords("native-spacing", ["failure", ...Array(6).fill("success")],
        { groups: 3, durations: [100, 200, 300, 400, 500, 600, 700] });
    for (const call of records.flatMap(record => record.toolCalls)) {
        const index = Number(call.toolCallId.split("-").at(-1));
        if (index === 5) Object.assign(call, { tool: "workiq-ask", requestArgs: { question: "Invented lookup" }, requestedApiPath: null });
        if (index === 6) Object.assign(call, { tool: "workiq-get_schema", requestArgs: { path: "/me/messages" }, requestedApiPath: null });
    }
    const { state } = qualityDisplayFixture({ records, judgments: ["pass", "fail"] });
    const facts = buildReportFacts(records, state, { preparedAt: "2026-10-11T18:00:00.000Z" }).facts;
    const bundle = await buildSanitizedBundle(records, state.pseudonymKey,
        { promptMode: "original", formats: ["html", "pdf", "json", "markdown"] }, undefined, undefined, facts);
    const frozen = JSON.stringify(bundle.snapshot);
    const directory = await keepProof("pill-spacing", bundle.files);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    const external = [];
    await context.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    const measure = () => page.evaluate(() => {
        const root = getComputedStyle(document.documentElement), size = parseFloat(root.fontSize);
        const rows = [...document.querySelectorAll(".native-bars li")].filter(row => row.querySelector(".native-bar-results"));
        return {
            expectedGap: Math.max(parseFloat(root.getPropertyValue("--space-sm")), size * .5),
            expectedRowGap: matchMedia("print").matches
                ? parseFloat(getComputedStyle(rows[0]).fontSize) * .65
                : Math.max(parseFloat(root.getPropertyValue("--space-lg")), size),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            rows: rows.map((row, index) => {
                const bar = row.querySelector(".native-bar-track").getBoundingClientRect();
                const pills = [...row.querySelectorAll(".native-outcome")].map(node => {
                    const rect = node.getBoundingClientRect();
                    return { text: node.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height };
                });
                return {
                    tool: row.querySelector(".native-bar-heading").textContent,
                    paintedGap: Math.min(...pills.map(pill => pill.y)) - bar.bottom,
                    nextRowGap: rows[index + 1] ? rows[index + 1].querySelector(".native-bar-heading").getBoundingClientRect().top
                        - Math.max(...pills.map(pill => pill.bottom)) : null,
                    pills,
                    fractions: [...row.querySelectorAll(".native-bar")].map(node => ({
                        count: Number(node.dataset.count), total: Number(node.dataset.denominator),
                        width: node.getBoundingClientRect().width, trackWidth: bar.width,
                    })),
                };
            }),
        };
    });
    const layouts = [];
    for (const theme of ["light", "dark"]) {
        const html = bundle.previewHtml.replace('data-evidence-theme="light"', `data-evidence-theme="${theme}"`);
        for (const enlarged of [false, true]) {
            await page.setViewportSize({ width: enlarged ? 375 : 1280, height: 1000 });
            await page.emulateMedia({ media: "screen" });
            await page.setContent(html);
            await page.evaluate(enlarged => { document.documentElement.style.fontSize = enlarged ? "200%" : "100%"; }, enlarged);
            const layout = { theme, enlarged, ...await measure() };
            layouts.push(layout);
            assert.equal(layout.overflow, false);
            assert.match(await page.locator(".native-bars").first().innerText(), /5 \/ 7 \(71.42%\)/);
            assert.match(await page.locator(".native-bar-results").first().innerText(), /4 succeeded \(80%\)/);
            assert.match(await page.locator(".native-bar-results").first().innerText(), /1 failed \(20%\)/);
            for (const row of layout.rows) for (const part of row.fractions) {
                assert.ok(Math.abs(part.width / part.trackWidth - part.count / part.total) < .002);
            }
            await page.locator('.report-nav a[href="#overview"]').focus();
            await page.keyboard.press("Enter");
            assert.ok(await page.locator("#overview").evaluate(node => Math.abs(node.getBoundingClientRect().top) < innerHeight));
            if (directory) {
                await page.evaluate(() => scrollTo(0, 0));
                await page.screenshot({ path: path.join(directory, `${theme}-${enlarged ? "375-200" : "1280"}-full.png`), fullPage: true });
                await page.locator("#breakdowns").screenshot({ path: path.join(directory, `${theme}-${enlarged ? "375-200" : "1280"}-breakdowns.png`) });
            }
        }
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.setContent(html);
        await page.emulateMedia({ media: "print" });
        layouts.push({ theme, print: true, ...await measure() });
        const bytes = theme === "light" ? bundle.files["product-report.pdf"] : await renderPdf(html);
        const extracted = await inspectPdf(bytes, directory ? path.join(directory, `pdf-${theme}`) : null);
        const compact = extracted.text.replace(/\s+/g, "");
        for (const text of ["5/7(71.42%)", "4succeeded(80%)", "1failed(20%)", "workiq-ask", "workiq-get_schema"]) {
            assert.ok(compact.includes(text), `Actual ${theme} PDF retains ${text}`);
        }
        if (directory) {
            await writeFile(path.join(directory, `product-report-${theme}.pdf`), bytes);
            await writeFile(path.join(directory, `pdf-${theme}-extraction.json`), JSON.stringify(extracted, null, 2));
        }
    }
    assert.deepEqual(external, []);
    assert.equal(JSON.stringify(bundle.snapshot), frozen);
    if (directory) await writeFile(path.join(directory, "spacing.json"), JSON.stringify(layouts, null, 2));
    for (const layout of layouts) {
        for (const row of layout.rows) {
            assert.ok(Math.abs(row.paintedGap - layout.expectedGap) < .05,
                `${layout.theme} enlarged=${Boolean(layout.enlarged)} print=${Boolean(layout.print)} ${row.tool}: ${row.paintedGap}px painted gap, expected ${layout.expectedGap}px shared text-scaled spacing`);
            if (row.nextRowGap !== null) assert.ok(Math.abs(row.nextRowGap - layout.expectedRowGap) < .05,
                `Adjacent rows retain compact grouping: ${row.nextRowGap}px / ${layout.expectedRowGap}px`);
        }
        const [first, second] = layout.rows[0].pills;
        const wrapped = second.y > first.y + 1;
        if (layout.enlarged) assert.equal(wrapped, true, "The narrow enlarged case must exercise wrapped outcome pills");
        const gap = wrapped ? second.y - first.bottom : second.x - first.right;
        assert.ok(Math.abs(gap - layout.expectedGap) < .05, `Outcome pills are separated by ${gap}px`);
    }
});

test("native spacing preserves new period report HTML and PDF without an Analyze UI dependency", { timeout: 120000 }, async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const { context } = await privateFixture(t, fixture.records);
    const state = await loadBoardState(context), controller = createExportController(context);
    const value = buildPeriodComparison(state, { ...fixture.input, expectedRevision: state.revision });
    const preview = await controller.preview("native-period-spacing", undefined,
        { formats: ["html", "pdf", "json", "markdown"], promptMode: "masked", timeContext: value.timeContext }, undefined, value);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
    const snapshot = JSON.stringify(preview.snapshot);
    await assert.rejects(controller.confirm("native-period-spacing", preview.previewId, true, value.timeContext), /disclosure review/);
    await controller.review("native-period-spacing", preview.previewId, true, value.timeContext);
    const saved = (await controller.confirm("native-period-spacing", preview.previewId, true, value.timeContext)).bundle;
    const files = Object.fromEntries(await Promise.all(Object.entries(saved.files).map(async ([name, file]) => [name, await readFile(file)])));
    const directory = await keepProof("period-spacing", files);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false });
    const external = [];
    await page.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    const layouts = [];
    for (const theme of ["light", "dark"]) {
        const html = files["product-report.html"].toString().replace('data-evidence-theme="light"', `data-evidence-theme="${theme}"`);
        for (const enlarged of [false, true]) {
            await page.setViewportSize({ width: enlarged ? 375 : 1280, height: 1000 });
            await page.setContent(html);
            await page.evaluate(enlarged => { document.documentElement.style.fontSize = enlarged ? "200%" : "100%"; }, enlarged);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            assert.equal(await page.locator(".native-outcome").count(), 0, "Period rows do not acquire normal-report pills");
            assert.ok(await page.locator(".native-bar").count() > 0);
            layouts.push({ theme, enlarged, rows: await page.locator(".native-bars li").evaluateAll(nodes => nodes.map(node => ({
                text: node.textContent, rowMargin: getComputedStyle(node).marginBottom,
                barMargin: getComputedStyle(node.querySelector(".native-bar-track")).marginBottom,
            }))) });
            if (directory) await page.screenshot({ path: path.join(directory, `${theme}-${enlarged ? "375-200" : "1280"}-full.png`), fullPage: true });
        }
        const bytes = theme === "light" ? files["product-report.pdf"] : await renderPdf(html);
        const extracted = await inspectPdf(bytes, directory ? path.join(directory, `pdf-${theme}`) : null);
        assert.match(extracted.text, /Period A/);
        assert.match(extracted.text, /Period B/);
        assert.match(extracted.text, /Matching tools and records/);
        assert.equal([...extracted.text.matchAll(/\bOutcome\b/g)].length, 2, "Both full-width matching tables retain whole-word column headings");
        if (directory) {
            await writeFile(path.join(directory, `product-report-${theme}.pdf`), bytes);
            await writeFile(path.join(directory, `pdf-${theme}-extraction.json`), JSON.stringify(extracted, null, 2));
        }
    }
    for (const layout of layouts) for (const row of layout.rows) {
        assert.equal(row.rowMargin, layout.enlarged ? "32px" : "16px");
        assert.equal(row.barMargin, layout.enlarged ? "16px" : "8px");
    }
    assert.deepEqual(external, []);
    assert.equal(JSON.stringify(preview.snapshot), snapshot);
    for (const [name, file] of Object.entries(saved.files)) assert.deepEqual(await readFile(file), files[name]);
    if (directory) await writeFile(path.join(directory, "layout-proof.json"), JSON.stringify(layouts, null, 2));
});

test("real native report: both themes, narrow 200%, offline font, keyboard details and PDF page boundaries", { timeout: 120000 }, async t => {
    const records = qualityDisplayFixture({ requests: 3, calls: 7, timed: 6 }).state.evidence;
    records[0].toolCalls[0].failureEvidence = {
        version: 1, messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required",
    };
    for (const call of records.flatMap(record => record.toolCalls)) {
        const index = Number(call.toolCallId.split("-").at(-1));
        call.requestedApiPath = null;
        if (index === 5) Object.assign(call, { tool: "workiq-ask", requestArgs: { question: "Invented source-backed lookup" } });
        else if (index === 6) Object.assign(call, { tool: "workiq-get_schema", requestArgs: { path: "/me/messages" } });
        else call.requestArgs = { entityUrls: [0, 1, 4].includes(index)
            ? ["/me/drive/root/children", "/me/messages"] : ["/me/calendarView"] };
    }
    records[0].httpRecords = [false, true].map((failed, index) => ({
        recordId: `invented-http-${index}`, classification: "direct-graph-http", synthetic: false,
        observedGraphHttp: !failed, responseOrigin: failed ? null : "https://graph.microsoft.com",
        apiVersion: "v1.0", method: "GET", requestedPath: { path: "/me/messages", query: [] },
        responsePath: failed ? null : { path: "/me/messages", query: [] }, status: failed ? null : 202,
        transportError: failed ? "TimeoutError" : null, startedAt: "2026-10-01T12:00:00.000Z",
        durationMs: failed ? 40 : 12, durationBoundary: "request dispatch to response headers",
    }));
    const { state } = qualityDisplayFixture({ records, judgments: ["pass", "fail", "error"] });
    const facts = buildReportFacts(state.evidence, state).facts;
    const bundle = await buildSanitizedBundle(state.evidence, state.pseudonymKey,
        { promptMode: "original", formats: ["html", "pdf", "json", "markdown"] }, undefined, undefined, facts);
    const pdf = await inspectPdf(bundle.files["product-report.pdf"]);
    assert.match(pdf.text, /Activity/);
    assert.doesNotMatch(pdf.text, /Work IQ sign-in required|Completion checks:/);
    assert.match(pdf.text, /41100 ms/);
    assert.match(pdf.text, /677960 ms/);
    assert.match(pdf.text, /6 of 7 calls timed/);
    assert.match(pdf.text, /1 of 3 requests timed/);
    assert.match(pdf.text, /12 ms/);
    assert.match(pdf.text, /40 ms/);
    assert.match(pdf.text, /transport error/);
    assert.equal(bundle.snapshot.summary.metrics.find(row => row.layer === "http").count, 2);
    assert.equal(bundle.snapshot.summary.metrics.find(row => row.layer === "http").outcomes.transport, 1);
    assert.equal(bundle.snapshot.evaluationFacts.serviceInvolvement.groups.reduce((count, group) => count + group.count, 0), 8);
    for (const text of [bundle.previewHtml, bundle.files["product-report.md"], pdf.text]) {
        assert.equal([...text.matchAll(/Completion checks:/g)].length, 0, "Current reports do not revive retired check recitals");
        assert.match(text, /6 of 7 calls timed/);
    }
    assert.ok(pdf.margins.length >= pdf.pageCount * 2);
    assert.ok(pdf.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === "#565656"));
    const directory = await keepProof("normal", { ...bundle.files, "pdf-extraction.json": JSON.stringify(pdf, null, 2) });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    const external = [];
    await context.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    const layouts = [];
    for (const theme of ["light", "dark"]) for (const narrow of [false, true]) {
        await page.setViewportSize({ width: narrow ? 390 : 1280, height: 1000 });
        await page.setContent(bundle.previewHtml);
        await page.evaluate(({ theme, narrow }) => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = narrow ? "200%" : "100%";
        }, { theme, narrow });
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => ({
            width: innerWidth, bodyWidth: document.documentElement.scrollWidth,
            background: getComputedStyle(document.documentElement).backgroundColor,
            fontFamily: getComputedStyle(document.body).fontFamily,
            fonts: [...document.fonts].map(font => ({ family: font.family, status: font.status })),
            radius: getComputedStyle(document.querySelector(".native-bar-track")).borderRadius,
            capsules: [...document.querySelectorAll(".native-outcome")].map(node => ({
                radius: getComputedStyle(node).borderRadius, text: node.textContent,
            })),
            bars: [...document.querySelectorAll(".native-bar")].map(node => ({
                count: Number(node.dataset.count), denominator: Number(node.dataset.denominator),
                actual: node.getBoundingClientRect().width / node.parentElement.getBoundingClientRect().width,
            })),
        }));
        assert.ok(layout.bodyWidth <= layout.width + 1, `${theme} narrow=${narrow}: body overflow`);
        assert.equal(layout.background, theme === "dark" ? "rgb(16, 16, 16)" : "rgb(255, 255, 255)");
        assert.ok(layout.fontFamily.startsWith('"Asta Sans"'));
        assert.equal(layout.fonts.some(font => font.family === "Asta Sans" && font.status === "loaded"), true, "The new report font is embedded, not fetched from the screen");
        assert.equal(layout.radius, "999px");
        assert.ok(layout.capsules.length);
        assert.ok(layout.capsules.every(capsule => capsule.radius === "999px"));
        assert.ok(layout.bars.length);
        for (const bar of layout.bars) assert.ok(Math.abs(bar.actual - bar.count / bar.denominator) < 0.002, "No inflated small values");
        layout.paint = await page.evaluate(measureChartPaint, ".native-bar");
        for (const mark of layout.paint) {
            assert.ok(mark.local && !mark.gradient && mark.colors.length === 1, "New native marks use one local semantic color");
            assert.equal(mark.opacity, 1);
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, `${theme}: entire native fade is readable`);
        }
        layout.failures = await page.evaluate(measureChartPaint, ".native-bar[data-outcome=failure]");
        assert.ok(layout.failures.length > 0, "Recorded failure marks are present");
        for (const mark of layout.failures) for (const color of mark.colors) {
            assert.ok(hue(color) < 15 || hue(color) > 345, `${theme}: failures are red`);
        }
        layout.outcomeLabels = await page.locator(".native-outcome").evaluateAll(nodes => nodes.map(node => ({
            text: node.textContent, color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
        })));
        for (const label of layout.outcomeLabels) assert.ok(contrast(label.color, label.background) >= 4.5, label.text);
        await page.locator("#coverage > summary").focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#coverage").getAttribute("open"), "");
        assert.match(await page.locator("#coverage").innerText(), /Prompt coverage/);
        layout.expandedWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(layout.expandedWidth <= layout.width + 1, "Expanded coverage must also fit at 200%");
        assert.equal(await page.locator("#coverage > summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        if (directory) await page.locator("#coverage").screenshot({ path: path.join(directory, `${theme}-${narrow ? "390-200" : "1280"}-coverage.png`) });
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#coverage").getAttribute("open"), null);
        layouts.push({ theme, narrow, ...layout });
        if (directory) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(directory, `${theme}-${narrow ? "390-200" : "1280"}.png`) });
            await page.locator("#breakdowns").screenshot({ path: path.join(directory, `${theme}-${narrow ? "390-200" : "1280"}-breakdowns.png`) });
        }
    }
    assert.deepEqual(external, []);
    assert.equal(await page.locator("script,iframe,img,link").count(), 0);
    const darkHtml = bundle.previewHtml.replace('data-evidence-theme="light"', 'data-evidence-theme="dark"');
    const darkPdf = await renderPdf(darkHtml), darkExtraction = await inspectPdf(darkPdf);
    assert.ok(darkExtraction.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === "#515767"),
        "Dark content still has readable shared-light text in white PDF margins");
    if (directory) {
        await writeFile(path.join(directory, "product-report-dark.pdf"), darkPdf);
        await writeFile(path.join(directory, "pdf-dark-extraction.json"), JSON.stringify(darkExtraction, null, 2));
    }
    if (directory) await writeFile(path.join(directory, "layout-proof.json"), JSON.stringify(layouts, null, 2));
    const tiny = await buildSanitizedBundle(matrixRecords("tiny-native", ["failure", ...Array(99).fill("success")]), "a".repeat(64),
        { promptMode: "none", formats: ["html", "json", "markdown"] });
    const tinyDirectory = await keepProof("tiny", tiny.files);
    const tinyPaint = [];
    for (const theme of ["light", "dark"]) {
        await page.setContent(tiny.previewHtml);
        await page.evaluate(theme => { document.documentElement.dataset.evidenceTheme = theme; }, theme);
        const small = await page.locator('.native-bar[data-count="1"][data-denominator="100"]').evaluate(node =>
            node.getBoundingClientRect().width / node.parentElement.getBoundingClientRect().width);
        assert.ok(Math.abs(small - 0.01) < 0.002, "A 1% outcome must not become a minimum-sized segment");
        assert.match(await page.locator(".native-bar-results").innerText(), /1 failed \(1%\)/);
        const paint = await page.evaluate(measureChartPaint, '.native-bar[data-count="1"][data-denominator="100"]');
        assert.equal(paint.length, 1);
        assert.ok(!paint[0].gradient && paint[0].colors.length === 1);
        for (const color of paint[0].colors) {
            assert.ok(contrast(color, paint[0].background) >= 3);
            assert.ok(hue(color) < 15 || hue(color) > 345);
        }
        tinyPaint.push({ theme, fraction: small, paint });
        if (tinyDirectory) await page.locator("#breakdowns").screenshot({ path: path.join(tinyDirectory, `${theme}-exact-one-percent.png`) });
    }
    if (tinyDirectory) await writeFile(path.join(tinyDirectory, "paint-proof.json"), JSON.stringify(tinyPaint, null, 2));
});

test("four-format recorded context keeps changed requests, omissions and exact anchors through real review and save", { timeout: 120000 }, async t => {
    const { context, records } = await reportContextFixture(t);
    const controller = createExportController(context), state = await loadBoardState(context);
    const selection = { kind: "selected", revision: state.revision, scenarioIds: [records[1].scenarioId], promptAuthors: ["user"] };
    const initial = await controller.preview("native-context", undefined,
        { promptMode: "masked", recordedContext: true, formats: ["json"] }, selection);
    const reply = initial.contextReview.find(entry => entry.kind === "response" && entry.original?.includes("Here are three"));
    const earlier = initial.contextReview.find(entry => entry.kind === "prompt");
    assert.ok(reply && earlier);
    const preview = await controller.preview("native-context", undefined, {
        promptMode: "masked", recordedContext: true, formats: ["html", "pdf", "json", "markdown"],
        overrides: [{ key: reply.key, text: "Reviewed three documents: Research, Architecture, Design." }, { key: earlier.key, omit: true }],
    }, selection);
    await assert.rejects(controller.confirm("native-context", preview.previewId, true), /review/i);
    await controller.review("native-context", preview.previewId, true);
    const saved = (await controller.confirm("native-context", preview.previewId, true)).bundle;
    const files = Object.fromEntries(await Promise.all(Object.entries(saved.files).map(async ([name, file]) => [name, await readFile(file)])));
    const pdf = await inspectPdf(files["product-report.pdf"]);
    for (const text of [files["product-report.html"].toString(), files["product-report.md"].toString(), pdf.text]) {
        assert.match(text, /Reviewed three documents/);
        assert.match(text, /Omitted from this report/);
        assert.match(text, /finality unverified/);
        assert.doesNotMatch(text, /first@example|reply@example|UNRELATED_CONTEXT|Find five synthetic/);
        if (text === pdf.text) assert.ok(text.indexOf("Recorded context") < text.indexOf("Examples"));
    }
    const snapshot = JSON.parse(files["product-report.json"]);
    assert.ok(files["product-report.html"].toString().indexOf('<section id="recorded-context">')
        < files["product-report.html"].toString().indexOf('<section id="examples">'));
    assert.ok(files["product-report.md"].toString().indexOf('<a id="recorded-context"></a>')
        < files["product-report.md"].toString().indexOf('<a id="examples"></a>'));
    assert.equal(snapshot.selectionScope.requestGroups, 1);
    assert.equal(snapshot.recordedContext.anchors.length, 1);
    assert.deepEqual(snapshot.recordedContext.anchors[0].groups.map(group => group.relation), ["preceding", "selected"]);
    const loaded = await readSavedReportDocument(context, await loadBoardState(context), saved.bundleId);
    assert.equal(loaded.html, files["product-report.html"].toString());
    await controller.preview("native-context", undefined, { promptMode: "none", formats: ["json"] },
        { ...selection, revision: (await loadBoardState(context)).revision });
    for (const [name, file] of Object.entries(saved.files)) assert.deepEqual(await readFile(file), files[name], "Later report preparation cannot rewrite saved bytes");
    const directory = await keepProof("context", { ...files, "pdf-extraction.json": JSON.stringify(pdf, null, 2) });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 1000 } });
    await page.route("**/*", route => route.abort());
    for (const theme of ["light", "dark"]) {
        await page.setContent(files["product-report.html"].toString());
        await page.evaluate(theme => {
            document.documentElement.dataset.evidenceTheme = theme;
            document.documentElement.style.fontSize = "200%";
        }, theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator("#recorded-context .context-reference > summary").first().focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#recorded-context .context-reference").first().getAttribute("open"), "");
        assert.match(await page.locator("#recorded-context").innerText(), /Reviewed three documents/);
        assert.deepEqual(await page.locator("#recorded-context pre").first().evaluate(node => {
            const style = getComputedStyle(node);
            return [style.borderRadius, style.borderLeftWidth];
        }), ["0px", "2px"]);
        if (directory) await page.locator("#recorded-context").screenshot({ path: path.join(directory, `${theme}-390-200-context.png`) });
    }
});

test("opening a verified historical report preserves all four format bytes and its manifest", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t);
    let files;
    if (process.env.WIRE_NATIVE_LEGACY) {
        files = Object.fromEntries(await Promise.all(["product-report.html", "product-report.pdf", "product-report.md", "product-report.json",
            "coverage-and-redaction-manifest.json"].map(async name => [name, await readFile(path.join(process.env.WIRE_NATIVE_LEGACY, name))])));
        assert.match(files["product-report.html"].toString(), /class="dimensional-report/);
    } else {
        const record = fixture(), state = { revision: 1, pseudonymKey: "a".repeat(64), evidence: [record] };
        const facts = structuredClone(buildReportFacts([record], state).facts);
        delete facts.reviewStatuses;
        delete facts.serviceInvolvement;
        const old = await buildSanitizedBundle([record], state.pseudonymKey, { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] },
            undefined, undefined, facts);
        files = Object.fromEntries(Object.entries(old.files).map(([name, bytes]) => [name, Buffer.from(bytes)]));
    }
    const manifest = JSON.parse(files["coverage-and-redaction-manifest.json"]);
    assert.equal(Object.hasOwn(manifest.evaluationFacts, "reviewStatuses"), false);
    assert.equal(Object.hasOwn(manifest.evaluationFacts, "serviceInvolvement"), false);
    // Register an owned invented historical artifact with its own fixture attestation.
    manifest.privacyReview.reviewerConfirmed = true;
    files["coverage-and-redaction-manifest.json"] = Buffer.from(JSON.stringify(manifest));
    const folder = path.join(context.dataDir, "exports", manifest.bundleId);
    await mkdir(folder, { recursive: true });
    const paths = {};
    for (const [name, bytes] of Object.entries(files)) { paths[name] = path.join(folder, name); await writeFile(paths[name], bytes); }
    await updateBoardState(context, state => { state.exports.push({
        kind: "report", bundleId: manifest.bundleId, preparedAt: manifest.preparedAt, formats: manifest.formats,
        ...(manifest.title === undefined ? {} : { title: manifest.title }),
        promptMode: manifest.promptMode, bundleDir: folder, files: paths, privacyReview: manifest.privacyReview,
        manifestHash: reportHash(files["coverage-and-redaction-manifest.json"]), snapshotHash: manifest.snapshotHash,
        evaluationFactsHash: manifest.evaluationFactsHash,
    }); });
    const before = await loadBoardState(context);
    const document = await readSavedReportDocument(context, before, manifest.bundleId);
    const source = await loadSavedReportSource(context, before, manifest.bundleId);
    assert.equal(document.html, files["product-report.html"].toString());
    assert.equal(source.reference.bundleId, manifest.bundleId);
    await buildSanitizedBundle([fixture("later")], "a".repeat(64), { promptMode: "none", formats: ["html", "markdown"] });
    for (const [name, file] of Object.entries(paths)) assert.deepEqual(await readFile(file), files[name]);
    assert.deepEqual(await loadBoardState(context), before);
    await keepProof("legacy", { "byte-proof.json": JSON.stringify({
        baseline: process.env.WIRE_NATIVE_LEGACY ?? "owned legacy-shape fixture",
        bundleId: manifest.bundleId, hashes: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, reportHash(bytes)])),
        unchangedAfterVerifiedOpenAndNewRendering: true,
    }, null, 2) });
});

test("new native files omit retired review claims without changing retained source reviews or recorded facts", { timeout: 120000 }, async t => {
    const records = matrixRecords("mixed-native-origins", ["success"], { durations: [1000] });
    const { state } = qualityDisplayFixture({ records, judgments: ["pass"] });
    const facts = structuredClone(buildReportFacts(records, state).facts);
    const before = structuredClone(facts), sourceBefore = structuredClone(state);
    assert.equal(facts.metricProjectionVersion, 4);
    assert.ok(state.personalEvaluation.modelEvaluation.records.length > 0, "The source fixture contains retained historical reviews");
    const bundle = await buildSanitizedBundle(records, state.pseudonymKey,
        { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] }, undefined, undefined, facts);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
    await page.route("**/*", route => route.abort());
    await page.setContent(bundle.previewHtml);
    const pdf = await inspectPdf(bundle.files["product-report.pdf"]);
    const directory = await keepProof("current-observations", { ...bundle.files, "pdf-extraction.json": JSON.stringify(pdf, null, 2) });
    for (const text of [bundle.previewHtml, bundle.files["product-report.md"], bundle.files["product-report.json"], pdf.text]) {
        assert.doesNotMatch(text, /Saved AI review|Model assessment|Personal feedback|Answer: Correct|Tool use: Matched request/);
    }
    assert.match(await page.locator("#findings").textContent(), /recorded Work IQ call/);
    assert.equal(await page.locator("#quality").count(), 0);
    assert.deepEqual(bundle.snapshot.evaluationFacts, before);
    assert.deepEqual(facts, before);
    assert.deepEqual(state, sourceBefore);
    if (directory) await page.locator("#findings").screenshot({ path: path.join(directory, "recorded-patterns.png") });
});

test("normal report navigation keeps every desktop target at least 44px with narrow keyboard access", async t => {
    const { context, records } = await reportContextFixture(t);
    const state = await loadBoardState(context);
    const bundle = await createExportController(context).preview("native-nav", undefined,
        { promptMode: "masked", recordedContext: true, formats: ["html", "json", "markdown"] },
        { kind: "selected", revision: state.revision, scenarioIds: [records[1].scenarioId], promptAuthors: ["user"] });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
    await page.route("**/*", route => route.abort());
    await page.setContent(bundle.previewHtml);
    const expected = [
        ["Activity", "#overview"], ["Timing", "#timing"], ["Recorded context", "#recorded-context"],
        ["Examples", "#examples"], ["Operations", "#operations"],
        ["Coverage", "#coverage"], ["Complete records (JSON)", "product-report.json"],
    ];
    const bounds = () => page.locator(".report-nav a").evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { label: node.textContent, href: node.getAttribute("href"), width: rect.width, height: rect.height,
            minHeight: style.minHeight, visible: rect.width > 0 && rect.height > 0 };
    }));
    const desktop = await bounds();
    assert.deepEqual(desktop.map(item => [item.label, item.href]), expected);
    await page.locator(".report-nav a").first().focus();
    for (let index = 0; index < expected.length; index++) {
        assert.equal(await page.locator(".report-nav a").nth(index).evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator(".report-nav a").nth(index).evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        if (index < expected.length - 1) await page.keyboard.press("Tab");
    }
    const directory = await keepProof("nav-target", { "product-report.html": bundle.previewHtml });
    if (directory) await page.locator(".report-nav").screenshot({ path: path.join(directory, "desktop-100.png") });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const narrow = await bounds();
    assert.deepEqual(narrow.map(item => [item.label, item.href]), expected);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator(".report-nav a").first().focus();
    await page.keyboard.press("Enter");
    assert.ok(await page.locator("#overview").evaluate(node => Math.abs(node.getBoundingClientRect().top) < innerHeight));
    if (directory) await page.locator(".report-nav").screenshot({ path: path.join(directory, "narrow-200.png") });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.emulateMedia({ media: "print" });
    const print = await bounds();
    if (directory) await writeFile(path.join(directory, "bounds.json"), JSON.stringify({ desktop, narrow, print }, null, 2));
    assert.ok(desktop.every(item => item.width >= 44 && item.height >= 44),
        `Every outlined desktop navigation anchor must be at least 44px: ${JSON.stringify(desktop)}`);
    assert.ok(narrow.every(item => item.width >= 44 && item.height >= 44));
    assert.ok(print.filter(item => item.visible).every(item => item.minHeight !== "44px"), "The screen target fix must not alter print minimum heights");
});

test("one new comparison PDF keeps shared margin typography in both themes and safe tokenless print fallback", { timeout: 120000 }, async () => {
    const report = name => {
        const records = matrixRecords(name, ["success", "failure"], { durations: [10, 20] });
        const facts = buildReportFacts(records, { revision: 1, pseudonymKey: "a".repeat(64), evidence: records }).facts;
        return adaptEvaluationReport(facts, { bundleId: `export-${name}`, snapshotHash: name === "earlier" ? "a".repeat(64) : "b".repeat(64),
            disclosureReviewed: true });
    };
    const comparison = compareFrozenReportFacts(report("earlier"), report("later"));
    const html = renderComparisonHtml(comparison, { bundleId: "export-print-compatibility", preparedAtDisplay: "Invented comparison",
        sourceReports: [comparison.baseline, comparison.later] });
    for (const theme of ["light", "dark"]) {
        const themed = html.replace('data-evidence-theme="light"', `data-evidence-theme="${theme}"`);
        const bytes = await renderPdf(themed), extracted = await inspectPdf(bytes);
        assert.match(extracted.text, /Report comparison/);
        assert.ok(extracted.margins.length >= extracted.pageCount * 2);
        assert.ok(extracted.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === (theme === "light" ? "#565656" : "#515767")));
        await keepProof("comparison-margins", {
            [`comparison-${theme}.html`]: themed, [`comparison-${theme}.pdf`]: bytes,
            [`comparison-${theme}-extraction.json`]: JSON.stringify(extracted, null, 2),
        });
    }
    for (const [name, style, expected] of [
        ["tokenless", "", "#515767"],
        ["print-override", ":root{--muted:#ffffff}@media print{:root{--muted:#345678}}", "#345678"],
        ["invalid-color", ':root{--muted:\'"><div>FONT_ESCAPE_CANARY</div>\'}', "#515767"],
    ]) {
        const source = `<!doctype html><style>${style}</style><h1>Invented legacy renderer input</h1><p>No font fetch is permitted.</p>`;
        const bytes = await renderPdf(source), extracted = await inspectPdf(bytes);
        assert.doesNotMatch(extracted.text, /FONT_ESCAPE_CANARY/);
        assert.ok(extracted.margins.length >= extracted.pageCount * 2);
        assert.ok(extracted.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === expected), name);
        await keepProof("comparison-margins", { [`${name}.pdf`]: bytes, [`${name}-extraction.json`]: JSON.stringify(extracted, null, 2) });
    }
});
