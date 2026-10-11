import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { buildReportFacts } from "../lib/assessment-read-model.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportDocument, loadSavedReportSource, reportHash } from "../lib/report-artifacts.mjs";
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

async function inspectPdf(bytes) {
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
                assert.ok(font.data?.byteLength > 0, `${font.name}: embedded font program required`);
                fonts.set(id, { name: font.name, bytes: font.data.byteLength });
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
    assert.match(pdf.text, /What the record shows/);
    assert.match(pdf.text, /sign-in was required/);
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
        assert.equal([...text.matchAll(/Completion-evidence checks:/g)].length, 1, "Only Work IQ tool checks use the call-completion boundary");
        assert.match(text, /7 eligible Work IQ calls/);
    }
    assert.ok(pdf.margins.length >= pdf.pageCount * 2);
    assert.ok(pdf.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === "#515767"));
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
        assert.equal(layout.background, theme === "dark" ? "rgb(15, 17, 26)" : "rgb(244, 245, 249)");
        assert.equal(layout.fontFamily.replaceAll(" ", ""), uiFontStack.replaceAll(" ", ""));
        assert.equal(layout.fonts.some(font => font.family === "Asta Sans"), false, "New native output does not embed the historical CSS font");
        assert.equal(layout.radius, "999px");
        assert.ok(layout.capsules.length);
        assert.ok(layout.capsules.every(capsule => capsule.radius === "999px"));
        assert.ok(layout.bars.length);
        for (const bar of layout.bars) assert.ok(Math.abs(bar.actual - bar.count / bar.denominator) < 0.002, "No inflated small values");
        await page.locator("#quality > summary").focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#quality").getAttribute("open"), "");
        assert.match(await page.locator("#quality").innerText(), /Counts and coverage/);
        layout.expandedWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(layout.expandedWidth <= layout.width + 1, "Expanded quality rows must also fit at 200%");
        assert.equal(await page.locator("#quality > summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
        if (directory) await page.locator("#quality").screenshot({ path: path.join(directory, `${theme}-${narrow ? "390-200" : "1280"}-quality.png`) });
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#quality").getAttribute("open"), null);
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
    await page.setContent(tiny.previewHtml);
    const small = await page.locator('.native-bar[data-count="1"][data-denominator="100"]').evaluate(node =>
        node.getBoundingClientRect().width / node.parentElement.getBoundingClientRect().width);
    assert.ok(Math.abs(small - 0.01) < 0.002, "A 1% outcome must not become a minimum-sized 3D segment");
    assert.match(await page.locator(".native-bar-results").innerText(), /1 failed \(1%\)/);
    const tinyDirectory = await keepProof("tiny", tiny.files);
    if (tinyDirectory) await page.locator("#breakdowns").screenshot({ path: path.join(tinyDirectory, "exact-one-percent.png") });
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
        assert.ok(text.indexOf("Recorded context") < text.indexOf("Representative technical scenarios"));
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
        assert.equal(await page.locator("#recorded-context pre").first().evaluate(node => getComputedStyle(node).borderRadius), "6px");
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

test("mixed saved origins stay beside each native finding in HTML, Markdown and PDF", { timeout: 120000 }, async t => {
    const records = matrixRecords("mixed-native-origins", ["success"], { durations: [1000] });
    const { state } = qualityDisplayFixture({ records, judgments: ["pass"] });
    const facts = structuredClone(buildReportFacts(records, state).facts);
    const origins = [
        { provider: "github-copilot", model: "saved-model-a", rubricId: "wire-recorded-interaction-review", rubricVersion: 2 },
        { provider: "github-copilot", model: "saved-model-b", rubricId: "wire-recorded-interaction-review", rubricVersion: 7 },
    ];
    const metrics = facts.metrics.filter(metric => metric.origin === "model-assessed");
    for (const [index, metric] of metrics.entries()) {
        metric.evaluator = { ...origins[0] };
        facts.metrics.push({ ...structuredClone(metric), metricRef: `metric-${(700 + index).toString(16).padStart(32, "0")}`,
            evaluator: { ...origins[1] } });
    }
    const assessments = facts.assessments.filter(assessment => assessment.origin === "model-assessed");
    for (const [index, assessment] of assessments.entries()) {
        assessment.evaluator = { ...origins[0] };
        facts.assessments.push({ ...structuredClone(assessment), assessmentRef: `assessment-${(700 + index).toString(16).padStart(32, "0")}`,
            evaluator: { ...origins[1] } });
    }
    const before = structuredClone(facts);
    const bundle = await buildSanitizedBundle(records, state.pseudonymKey,
        { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] }, undefined, undefined, facts);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
    await page.route("**/*", route => route.abort());
    await page.setContent(bundle.previewHtml);
    const htmlFindings = await page.locator("#findings li").allTextContents();
    const markdownFindings = bundle.files["product-report.md"].split("## What the record shows")[1]
        .split('<a id="overview"></a>')[0].split("\n").filter(line => line.startsWith("- AI assessment:"));
    const pdf = await inspectPdf(bundle.files["product-report.pdf"]);
    const pdfFindings = pdf.text.split("What the record shows")[1].split("Recorded numbers")[0].replace(/\s+/g, " ");
    const directory = await keepProof("mixed-origins", { ...bundle.files, "pdf-extraction.json": JSON.stringify(pdf, null, 2) });
    const claims = ["answer correct in 1 request", "answer supported in 1 request", "actions matching the request in 1 request"];
    for (const origin of origins) for (const claim of claims) {
        const label = `Model assessment · ${origin.model} · rubric ${origin.rubricId} v${origin.rubricVersion}`;
        assert.equal(htmlFindings.filter(line => line.includes(claim) && line.includes(label)).length, 1,
            `HTML finding must carry its own saved origin: ${label} / ${claim}`);
        assert.equal(markdownFindings.filter(line => line.includes(claim) && line.includes(label)).length, 1,
            `Markdown finding must carry its own saved origin: ${label} / ${claim}`);
        assert.ok(pdfFindings.replace(/\s/g, "").includes(`AI assessment: ${claim}. ${label}`.replace(/\s/g, "")),
            `PDF finding must carry its own saved origin: ${label} / ${claim}`);
    }
    assert.equal(htmlFindings.filter(line => line.startsWith("AI assessment:")).length, 6);
    assert.equal(markdownFindings.length, 6);
    assert.deepEqual(bundle.snapshot.evaluationFacts, before);
    assert.deepEqual(facts, before);
    if (directory) await page.locator("#findings").screenshot({ path: path.join(directory, "finding-origins.png") });
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
        ["Numbers", "#overview"], ["Timing", "#timing"], ["Recorded context", "#recorded-context"],
        ["Examples", "#examples"], ["Operation detail", "#operations"], ["Quality results", "#quality"],
        ["Prompt appendix", "#prompts"], ["Coverage", "#coverage"], ["Complete JSON records", "product-report.json"],
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
        assert.ok(extracted.margins.every(margin => /Arial|LiberationSans/.test(margin.font) && margin.color === "#515767"));
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
