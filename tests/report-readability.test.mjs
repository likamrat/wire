import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle, createExportController } from "../lib/export.mjs";
import { buildReportFacts, buildAssessmentModel, assessmentDependencies } from "../lib/assessment-read-model.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { acceptPeriodReport, freezePeriodReport } from "../lib/period-report.mjs";
import { periodReportDisplay } from "../lib/period-report-output.mjs";
import { nativeReportEvidence, nativeQualityHtml, nativeQualityMarkdown } from "../lib/native-report-output.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { pdfDocumentText } from "../lib/search-corpus-pdf.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { matrixRecords } from "./report-evidence-matrix-fixtures.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { reportContextFixture } from "./report-context-fixture.mjs";
import { compareFrozenReportFacts } from "../lib/frozen-report-comparison.mjs";
import { renderComparisonHtml, renderComparisonMarkdown, reportPresentationStyles } from "../lib/report-presentation.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { createAssessmentWording } from "../web/assessment-presentation.mjs";

const key = "a".repeat(64), preparedAt = "2026-10-12T02:00:00.000Z";
const formats = ["html", "pdf", "json", "markdown"];
async function inspect(t, name, bundle) {
    const files = Object.fromEntries(Object.entries(bundle.files).map(([name, value]) =>
        [name, typeof value === "string" || Buffer.isBuffer(value) ? value : Buffer.from(value.data, "base64")]));
    const directory = process.env.WIRE_READABILITY_PROOFS ? path.join(process.env.WIRE_READABILITY_PROOFS, name) : null;
    if (directory) {
        await mkdir(directory, { recursive: true });
        for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(directory, file), bytes);
    }
    const strict = await pdfDocumentText(files["product-report.pdf"]);
    const loading = getDocument({ data: new Uint8Array(files["product-report.pdf"]), useSystemFonts: false, disableFontFace: true });
    const pages = [], fonts = [];
    try {
        const document = await loading.promise;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            for (const item of content.items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `Page ${number} horizontal clipping: ${item.str}`);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `Page ${number} vertical clipping`);
                const marginTemplate = item.transform[5] < 35 || item.transform[5] > viewport.height - 35;
                const points = Math.hypot(item.transform[2], item.transform[3]);
                assert.ok(points >= (marginTemplate ? 5.9 : 8.9), `Page ${number} undersized PDF text: ${item.str}`);
                assert.ok(content.styles[item.fontName]?.fontFamily, `Page ${number} missing font mapping`);
                fonts.push({ page: number, points, family: content.styles[item.fontName].fontFamily, marginTemplate });
            }
            pages.push(content.items.map(item => (item.str ?? "") + (item.hasEOL ? "\n" : " ")).join(""));
            if (directory) {
                const view = page.getViewport({ scale: 1.25 }), surface = document.canvasFactory.create(view.width, view.height);
                await page.render({ canvasContext: surface.context, viewport: view }).promise;
                await writeFile(path.join(directory, `pdf-page-${number}.png`), surface.canvas.toBuffer("image/png"));
                document.canvasFactory.destroy(surface);
            }
        }
    } finally { await loading.destroy(); }
    if (directory) {
        const images = (await readdir(directory)).filter(name => /^pdf-page-\d+\.png$/.test(name))
            .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        assert.deepEqual(images, pages.map((_, index) => `pdf-page-${index + 1}.png`), "The current proof directory must contain exactly the parsed PDF pages");
        await writeFile(path.join(directory, "pdf-page-inventory.json"), JSON.stringify({ pageCount: pages.length, strictPages: strict.pages, images }, null, 2));
        await writeFile(path.join(directory, "pdf-extraction.json"), JSON.stringify({ pages, pageCount: pages.length, strictPages: strict.pages, fonts }, null, 2));
    }
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
    const external = [];
    await page.route("**/*", route => { external.push(route.request().url()); return route.abort(); });
    await page.setContent(bundle.previewHtml);
    await page.locator("details").evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
    const htmlText = await page.locator("body").innerText();
    const compact = value => value.replace(/\s+/g, "").toLowerCase();
    const pdfPages = pages.map(compact);
    const samePage = texts => pdfPages.some(text => texts.every(part => text.includes(compact(part))));
    const timingWarning = createReportComparison().readingNotes[3];
    assert.ok(samePage([timingWarning]), "A complete timing warning must not leave its final sentence on another page");
    const groups = await page.evaluate(() => ({
        tables: [...document.querySelectorAll(".native-table,.comparison-metrics,.comparison-patterns")].filter(table => table.tBodies[0]?.rows.length)
            .map(table => [table.caption?.textContent, table.tBodies[0].rows[0].cells[0].textContent].filter(Boolean)),
        disclosures: [...document.querySelectorAll(".comparison-document .comparison-unavailable")].filter(section => section.querySelector("tbody tr"))
            .map(section => [section.querySelector("summary").textContent, section.querySelector("caption").textContent,
                section.querySelector("tbody tr th").textContent]),
        charts: [...document.querySelectorAll(".native-breakdowns section")].filter(section => section.querySelector(".native-bar-heading"))
            .map(section => [section.querySelector("h3").textContent, section.querySelector(".native-bar-heading").textContent]),
        coverage: [...document.querySelectorAll("#coverage>ul>li")].map(item => item.textContent),
        notes: [...document.querySelectorAll(".reading-notes p,#definitions>p")].map(item => item.textContent),
        noteLeads: [...document.querySelectorAll(".comparison-document .reading-notes")].filter(section => section.querySelector("h2") && section.querySelector("p"))
            .map(section => [section.querySelector("h2").textContent, section.querySelector("p").textContent]),
    }));
    for (const group of [...groups.tables, ...groups.charts, ...groups.disclosures, ...groups.noteLeads]) assert.ok(samePage(group), `A heading/caption must stay with first data: ${group.join(" / ")}`);
    if (groups.coverage.length) assert.ok(samePage(["Coverage and reading notes", ...groups.coverage]), "The bounded coverage notes must retain their heading and full list");
    for (const note of groups.notes) assert.ok(samePage([note]), `Keep the complete short reading note together: ${note}`);
    const semanticText = await page.locator("p,li,pre,th,td,h2,h3,h4,summary").evaluateAll(nodes => nodes.map(node => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll(".comparison-mobile-label").forEach(label => label.remove());
        return copy.textContent;
    }));
    const completePdf = pages.map(text => compact(text.replace(/WIRE\s*-\s*local report/g, "").replace(/Page\s+\d+\s+of\s+\d+/g, ""))).join("");
    for (const text of semanticText.filter(text => text.trim())) assert.ok(completePdf.includes(compact(text)),
        `PDF must retain complete HTML reading content: ${text}`);
    const anchors = await page.locator('a[href^="#"]').evaluateAll(nodes =>
        nodes.filter(node => !document.getElementById(node.getAttribute("href").slice(1))).map(node => node.getAttribute("href")));
    assert.deepEqual(anchors, []);
    if (directory) {
        await page.screenshot({ path: path.join(directory, "html-opening.png") });
        for (const selector of ["#quality", "#full-interaction", "#recorded-context"]) {
            const section = page.locator(selector);
            if (await section.count()) await section.screenshot({ path: path.join(directory, `html-${selector.slice(1)}.png`) });
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => {
            document.documentElement.dataset.evidenceTheme = "dark";
            document.documentElement.style.fontSize = "200%";
        });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Human output remains readable at narrow 200% text");
        await page.screenshot({ path: path.join(directory, "dark-390-200-opening.png") });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.evaluate(() => {
            document.documentElement.dataset.evidenceTheme = "light";
            document.documentElement.style.fontSize = "100%";
        });
        await writeFile(path.join(directory, "pdf-extraction.json"), JSON.stringify({ pages, pageCount: pages.length, strictPages: strict.pages, fonts }, null, 2));
    }
    assert.deepEqual(external, []);
    return { page, browser, directory, pdfPages: pages, texts: [htmlText, bundle.files["product-report.md"], pages.join("\n")] };
}

test("F11 default formatter is unchanged while explicit origin omission retains reasons and coverage", () => {
    const format = createReportComparison();
    const fact = { metric: "accuracy", kind: "pass-rate", state: "available", unit: "percent", value: 50,
        basis: "model-assessment", numerator: 1, denominator: 2, coverage: { count: 2, eligible: 4 },
        counts: { evaluatorError: 1 }, qualifiers: { checkId: "request-requirements-corroborated", checkVersion: 1,
            evaluatorModel: "saved-model", rubricId: "saved-rubric", rubricVersion: 7 } };
    const expected = { value: "50%", tone: "performance-orange",
        note: "Model assessment · saved-model · rubric saved-rubric v7 · 1 of 2 passed · 2 of 4 assessed · 2 not assessed · 1 check errors (not failed results)" };
    assert.deepEqual(format.metricPresentation(fact, "accuracy"), expected);
    assert.deepEqual(format.metricPresentation(fact, "accuracy", { includeOrigin: true }), expected);
    const compact = format.metricPresentation(fact, "accuracy", { includeOrigin: false });
    assert.equal(compact.note, "1 of 2 passed · 2 of 4 assessed · 2 not assessed · 1 check errors (not failed results)");
    assert.equal(compact.value, expected.value);
    const missing = { ...fact, state: "unavailable", reason: "missing-evidence", coverage: { count: 0, eligible: 4 } };
    assert.match(format.metricPresentation(missing, "accuracy", { includeOrigin: false }).note, /^Not enough saved evidence.*0 of 4 assessed/);
});

test("F11 normal outputs retain metric origins once per row and use singular service counts", async t => {
    const records = matrixRecords("editorial-documents", ["failure", "success", "success"], { groups: 3, durations: [0, 400, 900] });
    records.forEach((record, index) => {
        record.userPrompt.text = ["Find the research documents; report any access problem.", "Summarize the three documents we can access.", "Inspect the file lookup schema, without making another request."][index];
        record.userPrompt.authorship = { actor: "user", basis: "source-user" };
    });
    records[0].toolCalls[0].failureEvidence = { version: 1, messageStatus: "text-excluded", messageSignal: "access-denial" };
    Object.assign(records[1].toolCalls[0], { tool: "workiq-ask", requestedApiPath: null, requestArgs: { question: records[1].userPrompt.text } });
    Object.assign(records[2].toolCalls[0], { tool: "workiq-get_schema", requestedApiPath: null, requestArgs: { path: "/me/drive/root" } });
    const { state } = qualityDisplayFixture({ records, judgments: ["fail", "pass", "unassessed"] });
    const first = [...buildAssessmentModel(state).details.values()][0];
    state.personalEvaluation.feedback.records.push({
        schemaVersion: 1, dependencies: assessmentDependencies(first),
        assessment: { ...first.assessments.find(item => item.checkId === "action-authorization-compliance"),
            origin: "user-personal", assessmentRef: "assessment-" + "e".repeat(32), verdict: "pass", reason: "user-verdict" },
    });
    state.personalEvaluation.feedback.revision = 1;
    state.personalEvaluation.overrideRevision = 1;
    const facts = buildReportFacts(records, state, { preparedAt }).facts, before = JSON.stringify(facts);
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "masked", formats }, undefined, undefined, facts);
    const { page, texts } = await inspect(t, "normal-metrics", bundle);
    for (const text of texts.map(text => text.replace(/-\s+/g, "-").replace(/\s+/g, " "))) {
        assert.match(text, /1 call has missing service details/);
        assert.match(text, /1 preparation call has no applicable data service/);
        assert.match(text, /recorded error mentions access denial/);
        assert.match(text, /1 of 2 passed/);
        assert.match(text, /2 of 3 assessed/);
        assert.match(text, /Tool use vs\. request/);
        assert.match(text, /Permission for tool use/);
        assert.match(text, /Your feedback/);
        assert.doesNotMatch(text, /AI action trust|Action trust|Trust: actions/);
        assert.doesNotMatch(text, /1 calls\b|1 preparation calls\b|All calls timed/);
    }
    const rows = await page.locator("#quality tbody tr").allTextContents();
    for (const row of rows.filter(row => row.includes("synthetic-quality-fixture"))) {
        assert.equal(row.split("synthetic-quality-fixture").length - 1, 1);
        assert.equal(row.split("wire-recorded-interaction-review").length - 1, 1);
    }
    assert.equal(JSON.stringify(bundle.snapshot.evaluationFacts), before);
    assert.equal(JSON.stringify(facts), before);
});

test("F11 period outputs explain each unavailable reason and unequal samples beside unchanged deltas", async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    fixture.records.forEach((record, index) => { record.userPrompt.text = `Review the available project documents for recorded lookup ${index + 1}; report missing access rather than guess.`; });
    fixture.records = JSON.parse(JSON.stringify(fixture.records));
    const { state } = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"] });
    const value = buildPeriodComparison(state, fixture.input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), preparedAt).frozen;
    const selected = new Set(Object.values(value.periods).flatMap(side => side.scenarioIds));
    const before = JSON.stringify(frozen);
    const bundle = await buildSanitizedBundle(fixture.records.filter(record => selected.has(record.scenarioId)), key,
        { promptMode: "masked", formats, timeContext: value.timeContext }, undefined, undefined, undefined, undefined, frozen);
    const { texts, page } = await inspect(t, "period-metrics", bundle);
    for (const text of texts.map(text => text.replace(/-\s+/g, "-").replace(/\s+/g, " "))) {
        assert.doesNotMatch(text, /unsupported-check|unverified-association|missing-evidence|\+1 records\b|1 missing-service context records\b|percentage-points/);
        assert.match(text, /Tool outcomes do not tell us whether the answer was correct/);
        assert.match(text, /No verified request-to-final-answer timing/);
        assert.match(text, /Not enough saved evidence/);
        assert.match(text, /Tool use vs\. request/);
        assert.doesNotMatch(text, /AI action trust|Action trust|Trust: actions/);
        assert.match(text, /\+1 record\b/);
        assert.match(text, /1 missing-service context record\b/);
        assert.match(text, /2 of 2 assessed/);
        assert.match(text, /1 of 4 assessed/);
        assert.match(text, /\+50 percentage points/);
        assert.match(text, /2 \/ 3 calls timed/);
        assert.match(text, /2 \/ 4 calls timed/);
        assert.match(text, /different.*assessed|unequal.*coverage/i);
        assert.match(text, /do not establish causal improvement/);
        assert.match(text, /current retained collection/);
        assert.match(text, /Files/);
        assert.match(text, /missing or unusable service details.*context.*not.*confirmed/i);
    }
    assert.doesNotMatch(await page.locator("#full-interaction").innerText(), /\bcovered\b/);
    assert.equal(JSON.stringify(bundle.snapshot.periodComparison), before);
    assert.equal(JSON.stringify(frozen), before);
    for (const reason of ["unsupported-check", "unverified-association", "missing-evidence"]) assert.ok(bundle.files["product-report.json"].includes(reason));
    assert.equal(periodReportDisplay(frozen).rows[0][3], "+1 record");
});

function changedDefinitionComparison() {
    const raw = (version, index, checkId = "action-intent-alignment") => ({
        comparisonKey: `side-${index}`, metric: "action-trust", kind: "pass-rate", definitionId: "check-pass-share", definitionVersion: 1,
        unit: "percent", basis: "model-assessment", aggregation: "pass-rate", boundary: "one-rule-per-eligible-unit", state: "available",
        numerator: 1, denominator: 2, coverage: { count: 2, eligible: 3 }, counts: { pass: 1, fail: 1, unassessed: 1, evaluatorError: 0 },
        qualifiers: { ...(checkId ? { checkId, checkVersion: version } : {}),
            evaluatorModel: "invented-side-model", rubricId: "saved-rubric", rubricVersion: 1 },
    });
    const pairs = [
        [raw(1, 0), raw(2, 0)], [raw(2, 1), raw(3, 1)], [raw(2, 2), raw(1, 2)],
        [raw(2, 3), null], [null, raw(2, 4)],
        [raw(1, 5, null), raw(1, 5, "action-authorization-compliance")], [raw(2, 6), raw(2, 6)],
    ];
    const report = (id, side) => ({
        schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true, patternVersion: 1,
        metrics: pairs.map(pair => pair[side]).filter(Boolean), toolRows: [{ id: "invented-call", patternId: "read", outcome: "success" }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "invented", callTimesAvailable: false, historyComplete: false },
    });
    const originals = [report("a", 0), report("b", 1)], oldBytes = originals.map(value => Buffer.from(JSON.stringify(value)));
    const comparison = compareFrozenReportFacts(...originals), before = JSON.stringify(comparison);
    const snapshot = { bundleId: "export-side-correction", preparedAtDisplay: "Invented side-by-side definitions", sourceReports: [comparison.baseline, comparison.later] };
    const html = renderComparisonHtml(comparison, snapshot), markdown = renderComparisonMarkdown(comparison, snapshot);
    return { pairs, originals, oldBytes, comparison, before, html, markdown };
}

test("F13 follow-up renders each changed definition beside its own comparison value in UI HTML and Markdown", async t => {
    const { pairs, originals, oldBytes, comparison, before, html, markdown } = changedDefinitionComparison();
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 1000 } });
    await page.route("**/*", route => route.abort());
    await page.setContent(html);
    const directory = process.env.WIRE_READABILITY_PROOFS ? path.join(process.env.WIRE_READABILITY_PROOFS, "F13-side-correction") : null;
    const current = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await current.route("**/*", route => route.abort());
    await current.setContent(`<html data-evidence-theme="light"><head><style>${reportPresentationStyles}</style></head><body class="comparison-document"><main id="current"></main></body></html>`);
    await current.addScriptTag({ content: `window.comparison = (${createReportComparison.toString()})((${createAssessmentWording.toString()})());` });
    await current.evaluate(value => window.comparison.render(document.getElementById("current"), value), comparison);
    const markdownRows = markdown.split("\n").filter(line => line.startsWith("| ") && line.includes("1 of 2 passed")).map(line => line.split("|").slice(1, -1));
    const htmlRows = await page.locator(".comparison-metrics").first().locator("tbody tr").evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.textContent)));
    const currentRows = await current.locator(".comparison-metrics").first().locator("tbody tr").evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.textContent)));
    for (const rows of [markdownRows, htmlRows, currentRows]) {
        assert.equal(rows.length, pairs.length);
        pairs.forEach((pair, index) => {
            const shared = index === 6, row = rows[index];
            if (pair.every(Boolean)) {
                assert.equal(row[0].split("invented-side-model").length - 1, 1);
                assert.ok(!row[1].includes("invented-side-model") && !row[2].includes("invented-side-model"));
            } else {
                assert.ok(!row[0].includes("invented-side-model"));
                assert.equal(row[pair[0] ? 1 : 2].split("invented-side-model").length - 1, 1);
                assert.ok(!row[pair[0] ? 2 : 1].includes("invented-side-model"));
            }
            pair.forEach((value, side) => {
                const cell = row[side + 1];
                if (!value) {
                    assert.match(cell, /Not saved/); assert.doesNotMatch(cell, /check version|action-intent-alignment/);
                    return;
                }
                assert.match(cell, /50%/); assert.match(cell, /1 of 2 passed/); assert.match(cell, /2 of 3 assessed/);
                const detail = shared ? row[0] : cell, { checkId, checkVersion } = value.qualifiers;
                if (checkId) {
                    assert.ok(detail.includes(checkId), `row${index} side${side} ID`);
                    assert.ok(detail.includes(`check version ${checkVersion}`), `row${index} side${side} version`);
                } else assert.match(detail, /Check ID not recorded.*Check version not recorded/s);
                if (shared) assert.doesNotMatch(cell, /Saved check|check version/);
                else {
                    const other = pair[1 - side]?.qualifiers;
                    if (other?.checkVersion && other.checkVersion !== checkVersion) assert.ok(!cell.includes(`check version ${other.checkVersion}`));
                }
            });
            if ([0, 1, 2, 5].includes(index)) assert.match(row[3], /Not comparable|Different definitions/);
        });
    }
    const metrics = comparison.metrics.filter(row => row.metric === "action-trust");
    for (const index of [0, 1, 2, 5]) { assert.equal(metrics[index].status, "incompatible"); assert.equal(metrics[index].delta, null); }
    assert.equal(metrics[6].delta.value, 0);
    assert.equal(JSON.stringify(comparison), before);
    originals.forEach((value, index) => assert.deepEqual(Buffer.from(JSON.stringify(value)), oldBytes[index]));
    if (directory) {
        await mkdir(directory, { recursive: true });
        await current.screenshot({ path: path.join(directory, "current-side-correction.png"), fullPage: true });
        await writeFile(path.join(directory, "side-cells.json"), JSON.stringify({ markdownRows, htmlRows, currentRows }, null, 2));
    }
});

test("F13 print blocker keeps the seven-pair comparison's complete timing note on one PDF page", async t => {
    const { html, markdown, before, comparison, originals, oldBytes } = changedDefinitionComparison();
    const result = await inspect(t, "F13-side-correction", {
        previewHtml: html, files: { "product-report.html": html, "product-report.md": markdown,
            "product-report.json": before, "product-report.pdf": await renderPdf(html) },
    });
    const metricPages = result.pdfPages.filter(page => page.includes("1 of 2") && page.includes("2 of 3"));
    assert.ok(metricPages.length > 1, "The unchanged seven-pair table must remain a naturally paginated oversized control");
    for (const page of metricPages) assert.match(page, /Measure\s+Earlier\s+Later\s+Change/, "Metric continuation pages repeat the original table headings");
    assert.equal(JSON.stringify(comparison), before);
    originals.forEach((value, index) => assert.deepEqual(Buffer.from(JSON.stringify(value)), oldBytes[index]));
});

test("F13 new saved comparison keeps known permission, matching and unknown historical definitions distinct", async t => {
    const raw = (checkId, basis = "model-assessment", checkVersion = 1) => ({
        comparisonKey: JSON.stringify(["invented-saved-lane", checkId, checkVersion, basis]),
        metric: "action-trust", kind: "pass-rate", definitionId: "check-pass-share", definitionVersion: 1,
        unit: "percent", basis, aggregation: "pass-rate", boundary: "one-rule-per-eligible-unit", state: "available",
        numerator: 1, denominator: 2, coverage: { count: 2, eligible: 3 },
        counts: { pass: 1, fail: 1, unassessed: 1, evaluatorError: 0 },
        qualifiers: { ...(checkId ? { checkId, checkVersion } : {}), ...(basis === "model-assessment"
            ? { evaluatorModel: "invented-archived-model", rubricId: "saved-rubric", rubricVersion: 1 } : {}) },
    });
    const report = id => ({
        schemaVersion: 1, bundleId: `export-${id}`, snapshotHash: id.repeat(64), disclosureReviewed: true, patternVersion: 1,
        metrics: [raw("action-intent-alignment"), raw("action-authorization-compliance", "user-assessment"), raw(null),
            raw("action-intent-alignment", "model-assessment", 2), raw("action-authorization-compliance", "model-assessment")],
        toolRows: [{ id: `${id}-call`, patternId: "read", outcome: "success" }],
        scope: { selectionKind: "selected", timeZone: "UTC", collectionDefinition: "invented", callTimesAvailable: false, historyComplete: false },
    });
    const originals = [report("a"), report("b")];
    Object.assign(originals[1].metrics.at(-1).qualifiers, { evaluatorModel: "invented-later-model", rubricId: "later-rubric", rubricVersion: 7 });
    const originalBytes = originals.map(value => Buffer.from(JSON.stringify(value)));
    const comparison = compareFrozenReportFacts(...originals);
    const differentOrigin = comparison.metrics.find(metric => metric.later?.qualifiers?.evaluatorModel === "invented-later-model");
    assert.equal(differentOrigin.status, "incompatible");
    assert.equal(differentOrigin.delta, null);
    const before = JSON.stringify(comparison);
    const snapshot = { bundleId: "export-f13-comparison", preparedAtDisplay: "Invented retained comparison",
        sourceReports: [comparison.baseline, comparison.later] };
    const html = renderComparisonHtml(comparison, snapshot), markdown = renderComparisonMarkdown(comparison, snapshot);
    const bundle = { previewHtml: html, files: { "product-report.html": html, "product-report.md": markdown,
        "product-report.json": before, "product-report.pdf": await renderPdf(html) } };
    const { page, texts, browser, directory } = await inspect(t, "F13-saved-comparison", bundle);
    for (const text of texts.map(text => text.replace(/\s+/g, " "))) {
        assert.match(text, /Tool use vs\. request/);
        assert.match(text, /Permission for tool use/);
        assert.match(text, /Saved review \(type not recorded\)/);
        assert.match(text, /saved definition does not identify whether this reviewed request matching or permission/);
        assert.match(text, /1 of 2 passed/);
        assert.match(text, /2 of 3 assessed/);
        assert.doesNotMatch(text, /AI action trust|Action trust|Trust: actions/);
    }
    assert.equal(JSON.stringify(comparison), before);
    originals.forEach((value, index) => assert.deepEqual(Buffer.from(JSON.stringify(value)), originalBytes[index]));
    const rows = await page.locator(".comparison-metrics tbody tr").allTextContents();
    assert.equal(rows.filter(row => row.includes("Tool use vs. request")).length, 1);
    assert.equal(rows.filter(row => row.includes("Permission for tool use")).length, 1);
    assert.equal(rows.filter(row => row.includes("Saved review (type not recorded)")).length, 3);
    assert.ok(rows.some(row => row.includes("Check ID not recorded")));
    assert.ok(rows.some(row => row.includes("action-intent-alignment") && row.includes("check version 2")));
    assert.ok(rows.some(row => row.includes("action-authorization-compliance") && row.includes("check version 1") && row.includes("Saved review (type not recorded)")));
    const htmlCells = await page.locator(".comparison-metrics").first().locator("tbody tr").evaluateAll(rows =>
        rows.map(row => [...row.children].map(cell => cell.textContent)));
    const markdownCells = markdown.split("\n").filter(line => line.startsWith("| ") && line.includes("1 of 2 passed"))
        .map(line => line.split("|").slice(1, -1));
    const checkOrigins = cells => {
        const changed = cells.find(row => row[2].includes("invented-later-model"));
        assert.ok(changed);
        assert.doesNotMatch(changed[0], /invented-archived-model|invented-later-model/);
        assert.equal(changed[1].split("invented-archived-model").length - 1, 1);
        assert.equal(changed[2].split("invented-later-model").length - 1, 1);
        assert.doesNotMatch(changed[1], /invented-later-model/);
        assert.doesNotMatch(changed[2], /invented-archived-model/);
        for (const row of cells.filter(row => row !== changed)) {
            const origin = row[0].includes("Your feedback") ? "Your feedback" : "invented-archived-model";
            assert.equal(row[0].split(origin).length - 1, 1);
            assert.ok(!row[1].includes(origin) && !row[2].includes(origin), "The shared header already owns this provenance");
            assert.match(row[1], /50%.*1 of 2 passed.*2 of 3 assessed/s);
            assert.match(row[2], /50%.*1 of 2 passed.*2 of 3 assessed/s);
        }
    };
    checkOrigins(htmlCells); checkOrigins(markdownCells);
    const current = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await current.route("**/*", route => route.abort());
    await current.setContent(`<html data-evidence-theme="light"><head><style>${reportPresentationStyles}</style></head><body class="comparison-document"><main id="current"></main></body></html>`);
    await current.addScriptTag({ content: `window.comparison = (${createReportComparison.toString()})((${createAssessmentWording.toString()})());` });
    await current.evaluate(value => window.comparison.render(document.getElementById("current"), value), comparison);
    const currentLabels = await current.locator(".comparison-metrics tbody th").allTextContents();
    assert.ok(currentLabels.some(label => label.includes("Tool use vs. request")));
    assert.ok(currentLabels.some(label => label.includes("Permission for tool use")));
    assert.ok(currentLabels.some(label => label.includes("Saved review (type not recorded)")));
    checkOrigins(await current.locator(".comparison-metrics").first().locator("tbody tr").evaluateAll(rows =>
        rows.map(row => [...row.children].map(cell => cell.textContent))));
    if (directory) {
        await writeFile(path.join(directory, "current-view.txt"), await current.locator("#current").innerText());
        await current.screenshot({ path: path.join(directory, "current-comparison-light-1280.png"), fullPage: true });
    }
});

test("F11 frozen scope describes collection membership, service OR, context and within-service AND", () => {
    const fixture = periodFixture();
    const cases = [
        { scope: "history", services: ["Files"], context: true, words: /current retained collection/, a: 3 },
        { scope: "history", services: ["Files"], context: false, words: /Strict service matching/, a: 2 },
        { scope: "history", services: [], context: true, words: /No service filter.*not an extra context expansion/, a: 4 },
        { scope: "legacy", services: ["Files"], context: true, words: /earlier-snapshot retained records only/, a: 1 },
        { scope: "all", services: ["Files"], context: true, words: /current and earlier-snapshot retained records/, a: 3, currentOnly: true },
        { scope: "history", services: ["Files", "Mail"], context: true, within: ["Files", "Mail"],
            words: /Files or Mail.*every.*Files and Mail.*after/s, a: 1 },
    ];
    for (const row of cases) {
        const input = structuredClone(fixture.input);
        Object.assign(input.options.filters, { scope: row.scope, services: row.services, includeMissingService: row.context });
        input.withinServices = row.within ?? [];
        const state = row.currentOnly ? { ...fixture.state, evidence: fixture.records.filter(record => !record.isLegacy) } : fixture.state;
        if (row.currentOnly) input.scenarioIds = input.scenarioIds.filter(id => state.evidence.some(record => record.scenarioId === id));
        const value = buildPeriodComparison(state, input);
        const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), preparedAt).frozen;
        const before = JSON.stringify(frozen), display = periodReportDisplay(frozen);
        assert.match(display.scope, row.words);
        assert.equal(frozen.periods.baseline.rows.length, row.a);
        assert.equal(JSON.stringify(frozen), before);
        if (!row.services.length) assert.doesNotMatch(display.scope, /known matches plus/);
        if (row.services.length && row.context) assert.match(display.scope, /not confirmed.*service matches/);
        if (!row.context) assert.equal(frozen.periods.baseline.serviceSelection.contextOnlyRefs.length, 0);
    }
});

test("F11 explicitly selected unknown service rows are matches, not optional missing-detail context", () => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs =
        { entityUrls: ["/me/messages", "/unrecognized/root"] };
    fixture.records[1].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/unrecognized/root"] };
    const { state } = qualityDisplayFixture({ records: fixture.records });
    for (const services of [["Unknown"], ["Unknown", "Files"]]) {
        for (const context of [undefined, false, true]) for (const within of [[], ["Files"]]) {
            const input = structuredClone(fixture.input);
            input.options.filters.services = services;
            if (context === undefined) delete input.options.filters.includeMissingService;
            else input.options.filters.includeMissingService = context;
            input.withinServices = within;
            const compared = buildPeriodComparison(state, input);
            const frozen = freezePeriodReport(state, acceptPeriodReport(state, compared), preparedAt).frozen;
            const before = JSON.stringify(frozen), display = periodReportDisplay(frozen);
            const named = services.includes("Files");
            const expected = within.length ? named ? 2 : context === true ? 1 : 0
                : named ? context === true ? 4 : 3 : context === true ? 3 : 1;
            assert.equal(frozen.periods.baseline.rows.length, expected);
            assert.match(display.scope, /Service not shown.*explicitly selected.*matches.*not.*confirmed service/i);
            assert.doesNotMatch(display.scope, /missing or unusable details alone do not qualify/);
            if (context === true) {
                assert.match(display.scope, /additional.*missing or unusable.*context/i);
            } else {
                assert.match(display.scope, /No additional missing-detail context/);
                assert.equal(frozen.periods.baseline.serviceSelection.contextOnlyRefs.length, 0);
            }
            if (named) assert.match(display.scope, /Service not shown or Files.*\(OR\)/);
            if (within.length) {
                assert.match(display.scope, /every named service: Files \(AND\).*after/);
                assert.ok(frozen.periods.baseline.rows.every(row => row.services.includes("Files")));
            } else assert.ok(frozen.periods.baseline.serviceSelection.knownMatchRefs.length >= 1,
                "The explicitly selected no-target row counts as a selected category match");
            assert.equal(JSON.stringify(frozen), before);
        }
    }
});

test("F11 period lanes keep distinct saved model and rubric origins on the correct side", async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    fixture.records = JSON.parse(JSON.stringify(fixture.records));
    const { state } = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"] });
    const evaluation = state.personalEvaluation.modelEvaluation;
    for (const record of evaluation.records.slice(2)) {
        for (const assessment of record.assessments) assessment.evaluator = {
            ...assessment.evaluator, model: "later-saved-model", rubricVersion: 7,
        };
    }
    const value = buildPeriodComparison(state, fixture.input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), preparedAt).frozen;
    const frozenBefore = Buffer.from(JSON.stringify(frozen));
    const displayed = periodReportDisplay(frozen);
    frozen.comparison.metrics.forEach((metric, index) => {
        if (metric.baseline && metric.later) return;
        const missing = metric.baseline ? 2 : 1;
        const kind = (metric.baseline ?? metric.later).kind;
        assert.equal(displayed.metrics[index][missing], kind === "pass-rate"
            ? "No comparable saved review on this side" : "No comparable saved measure on this side");
    });
    const selected = new Set(Object.values(value.periods).flatMap(side => side.scenarioIds));
    const bundle = await buildSanitizedBundle(fixture.records.filter(record => selected.has(record.scenarioId)), key,
        { promptMode: "none", formats, timeContext: value.timeContext }, undefined, undefined, undefined, undefined, frozen);
    const { page, texts } = await inspect(t, "different-origins", bundle);
    assert.equal(await page.locator("#full-interaction caption").textContent(), "Saved reviews and measurements by source and method");
    for (const text of [texts[0], texts[2]]) assert.match(text.replace(/\s+/g, " "), /Saved reviews and measurements by source and method/);
    for (const text of texts) {
        assert.ok(text.replace(/\s/g, "").includes("later-saved-model"));
        assert.ok(text.replace(/\s/g, "").includes("rubricwire-recorded-interaction-reviewv7"));
        assert.ok(text.replace(/\s/g, "").includes("synthetic-quality-fixture"));
    }
    const cells = await page.locator("#full-interaction tbody tr").evaluateAll(rows =>
        rows.map(row => [...row.children].map(cell => cell.textContent)));
    const later = cells.find(row => row[2].includes("later-saved-model"));
    const earlier = cells.find(row => row[1].includes("synthetic-quality-fixture"));
    assert.ok(later && earlier, "Different origins remain separate comparison lanes");
    assert.equal(later[1], "No comparable saved review on this side");
    assert.match(later[2], /1 of 4 assessed/);
    assert.match(earlier[1], /2 of 2 assessed/);
    assert.equal(earlier[2], "No comparable saved review on this side");
    assert.ok(!later[1].includes("later-saved-model"));
    assert.ok(!earlier[2].includes("synthetic-quality-fixture"));
    assert.equal(later[3], "Not comparable");
    assert.deepEqual(bundle.snapshot.periodComparison, frozen);
    assert.deepEqual(Buffer.from(JSON.stringify(frozen)), frozenBefore);
    for (const text of texts.map(text => text.replace(/\s+/g, " "))) {
        assert.match(text, /No comparable saved review on this side/);
        assert.doesNotMatch(text, /No compatible saved lane/);
    }
});

test("period export missing peers distinguish reviews from timing without changing frozen values", async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    fixture.records = JSON.parse(JSON.stringify(fixture.records));
    const { state } = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"] });
    fixture.input.periods.later = { from: "2026-04-15", to: "2026-04-16" };
    const value = buildPeriodComparison(state, fixture.input);
    const frozen = freezePeriodReport(state, acceptPeriodReport(state, value), preparedAt).frozen;
    const oldBytes = Buffer.from(JSON.stringify(frozen));
    const display = periodReportDisplay(frozen);
    assert.equal(frozen.periods.later.rows.length, 0);
    assert.ok(frozen.comparison.metrics.some(item => item.baseline?.kind === "pass-rate"));
    assert.ok(frozen.comparison.metrics.some(item => item.baseline?.kind === "duration"));
    assert.ok(frozen.comparison.metrics.every(item => item.baseline?.kind !== "cost"), "Current period reports do not introduce a retired cost measure");
    frozen.comparison.metrics.forEach((item, index) => {
        assert.equal(item.later, null);
        assert.equal(display.metrics[index][2], item.baseline.kind === "pass-rate"
            ? "No comparable saved review on this side" : "No comparable saved measure on this side");
        assert.equal(display.metrics[index][3], "Not comparable");
    });
    const selected = new Set(Object.values(value.periods).flatMap(side => side.scenarioIds));
    const bundle = await buildSanitizedBundle(fixture.records.filter(record => selected.has(record.scenarioId)), key,
        { promptMode: "none", formats, timeContext: value.timeContext }, undefined, undefined, undefined, undefined, frozen);
    const { page, texts } = await inspect(t, "missing-period-peers", bundle);
    assert.equal(await page.locator("#full-interaction caption").textContent(), "Saved reviews and measurements by source and method");
    for (const text of texts.map(text => text.replace(/\s+/g, " "))) {
        assert.match(text, /No comparable saved review on this side/);
        assert.match(text, /No comparable saved measure on this side/);
        assert.doesNotMatch(text, /No compatible saved lane/);
    }
    const rows = await page.locator("#full-interaction tbody tr").evaluateAll(rows =>
        rows.map(row => [...row.children].map(cell => cell.textContent)));
    assert.deepEqual(rows, display.metrics);
    assert.deepEqual(bundle.snapshot.periodComparison, frozen);
    assert.deepEqual(Buffer.from(JSON.stringify(frozen)), oldBytes);
    const formatter = createReportComparison();
    assert.equal(formatter.absentPeerLabel({ kind: "cost" }), "No comparable saved measure on this side");
    assert.equal(formatter.absentPeerLabel(undefined), "No comparable saved measure on this side");
    assert.equal(formatter.absentPeerLabel({ kind: "unknown" }), "No comparable saved measure on this side");
});

test("F11 revised requests and bounded no-JSON reports give honest evidence paths", async t => {
    const { context, records } = await reportContextFixture(t), controller = createExportController(context);
    const state = await loadBoardState(context);
    const preview = await controller.preview("editorial-context", undefined, { recordedContext: true, promptMode: "masked", formats },
        { kind: "selected", revision: state.revision, scenarioIds: [records[1].scenarioId], promptAuthors: ["user"] });
    const { texts } = await inspect(t, "revised-request", preview);
    for (const text of texts) {
        assert.match(text, /Find five synthetic documents/);
        assert.match(text, /Three synthetic documents are enough/);
        assert.match(text, /Here are three synthetic documents/);
        assert.match(text, /finality unverified/);
        assert.match(text, /adds no analytical requests/);
        assert.doesNotMatch(text, /first@example|reply@example|UNRELATED_CONTEXT|1 selected interaction records|1 Work IQ calls|1 have no numeric API status/);
    }
    assert.equal(preview.snapshot.selectionScope.requestGroups, 1);
    assert.equal(preview.snapshot.summary.metrics[0].count, 1);
    assert.equal(preview.snapshot.evaluationFacts.assessments.some(item => item.origin === "user-personal" && item.verdict === "fail"), false);
    await assert.rejects(controller.confirm("editorial-context", preview.previewId, true), /review/i);
    await controller.review("editorial-context", preview.previewId, true);
    const saved = (await controller.confirm("editorial-context", preview.previewId, true)).bundle;
    const bytes = Object.fromEntries(await Promise.all(Object.entries(saved.files).map(async ([name, file]) => [name, await readFile(file)])));
    const many = matrixRecords("bounded-editorial", Array(18).fill("success"));
    many[0].userPrompt.text = "Inspect the recorded project document lookups.";
    const call = many[0].toolCalls[14];
    Object.assign(call, { toolSucceeded: false, reportedOutcome: "failed" });
    const bounded = await buildSanitizedBundle(many, key, { promptMode: "none", formats: ["html", "pdf", "markdown"] });
    const boundedProof = await inspect(t, "bounded-no-json", bounded);
    for (const text of boundedProof.texts) {
        assert.doesNotMatch(text, /product-report\.json|see complete projected records/i);
        assert.match(text, /aggregate/i);
        assert.match(text, /11 earlier/);
        assert.match(text, /not.*full.*records|not.*omitted.*records/i);
    }
    assert.match(bounded.files["product-report.md"], /18\. [^\n]+\n\n11 earlier/);
    const noPdf = await buildSanitizedBundle(many, key, { promptMode: "original", formats: ["html", "markdown"] });
    await boundedProof.page.setContent(noPdf.previewHtml);
    const noPdfText = await boundedProof.page.locator("body").innerText();
    assert.doesNotMatch(noPdfText, /product-report\.json|The PDF|saved PDF/);
    assert.doesNotMatch(noPdf.files["product-report.md"], /product-report\.json|The PDF|saved PDF/);
    assert.equal(Object.hasOwn(noPdf.files, "product-report.pdf"), false);
    assert.equal(Object.hasOwn(noPdf.files, "product-report.json"), false);
    if (process.env.WIRE_READABILITY_PROOFS) {
        const directory = path.join(process.env.WIRE_READABILITY_PROOFS, "no-pdf-no-json");
        await mkdir(directory, { recursive: true });
        for (const [name, bytes] of Object.entries(noPdf.files)) await writeFile(path.join(directory, name), bytes);
    }
    for (const [name, file] of Object.entries(saved.files)) assert.deepEqual(await readFile(file), bytes[name]);
});

test("F11 print grouping permits natural oversized tables and long preserved copies", async t => {
    const records = matrixRecords("oversized-editorial", ["success"], { durations: [100] });
    const paragraphs = Array.from({ length: 72 }, (_, index) =>
        `Retained paragraph ${index + 1}: review the available research notes without inventing omitted source material.`);
    records[0].userPrompt.text = ["Long retained copy begins.", ...paragraphs, "Long retained copy ends."].join("\n");
    const { state } = qualityDisplayFixture({ records, judgments: ["pass"] });
    const facts = structuredClone(buildReportFacts(records, state, { preparedAt }).facts);
    const metric = facts.metrics.find(item => item.origin === "model-assessed" && item.dimension === "accuracy");
    for (let index = 0; index < 18; index++) facts.metrics.push({
        ...structuredClone(metric), metricRef: "metric-" + (500 + index).toString(16).padStart(32, "0"),
        evaluator: { ...metric.evaluator, model: `archived-review-${index + 1}`, rubricVersion: index + 2 },
    });
    const bundle = await buildSanitizedBundle(records, key, { promptMode: "original", formats }, undefined, undefined, facts);
    const output = await inspect(t, "oversized-control", bundle);
    assert.equal(bundle.records[0].prompts[0].text, records[0].userPrompt.text);
    assert.deepEqual(bundle.snapshot.evaluationFacts, facts);
    for (const paragraph of paragraphs) assert.ok(output.texts[2].replace(/\s/g, "").includes(paragraph.replace(/\s/g, "")));
    for (let index = 1; index <= 18; index++) assert.ok(output.texts[2].replace(/\s/g, "").includes(`archived-review-${index}`));
    assert.ok(output.texts[2].split("Measure / origin").length > 2, "Oversized tables must continue with repeated column headers");
    assert.match(output.texts[2], /Long retained copy ends/);
});
