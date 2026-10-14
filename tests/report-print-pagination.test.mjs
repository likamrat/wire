import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { reportPrintPaginationStyles } from "../lib/report-presentation.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
const contentText = pages => pages.map(page => page.text
    .replaceAll("WIRE - local report", "").replace(/Page\s*\d+\s*of\s*\d+$/, "")).join("").replace(/\s+/g, "");
const lastPage = (pages, text) => pages.filter(page => page.text.replace(/\s+/g, "").includes(text.replace(/\s+/g, ""))).at(-1)?.number;
const promptSummary = (record, index) => `Interaction ${index + 1}1 included copy · ${record.scenarioId}`;

test("PDF text comparison preserves digits at the start of the following page", () => {
    assert.equal(contentText([{ text: "FirstWIRE - local reportPage 1 of 2" },
        { text: "1 included copyWIRE - local reportPage 2 of 2" }]), "First1includedcopy");
});

function printRecords(long = false) {
    return Array.from({ length: 4 }, (_, index) => {
        const record = fixture(`logical-print-${index + 1}`);
        const endpoint = index % 2 ? "/me/calendarView" : "/me/messages";
        record.sourceSessionId = `synthetic-print-session-${index + 1}`;
        record.projectId = null;
        record.userPrompt.text = `SYNTHETIC UX FIXTURE ONLY: inspect the recorded ${index % 2 ? "Calendar" : "Mail"} request ${index + 1}. SHORT_BODY_${index + 1}`;
        if (long && index === 2) record.userPrompt.text = Array.from({ length: 240 }, (_, line) =>
            `LONG_LINE_${String(line).padStart(3, "0")} All of this retained synthetic prompt must remain readable.`).join("\n");
        record.userPrompt.sourceEventId = `print-prompt-${index + 1}`;
        record.followUpPrompts = [];
        const duration = [250, 1200, 2800, null][index];
        Object.assign(record.toolCalls[0], {
            requestArgs: { entityUrls: [endpoint] }, requestedApiPath: endpoint,
            toolSucceeded: [true, true, false, null][index], reportedOutcome: ["succeeded", "succeeded", "failed", "unknown"][index],
            startedAt: "2026-10-01T12:00:00.000Z",
            completedAt: duration === null ? null : new Date(Date.parse("2026-10-01T12:00:00.000Z") + duration).toISOString(),
            completionEventId: duration === null ? null : `print-completion-${index}`, durationMs: duration,
            apiResults: index < 3 ? [{ index: 0, statusCode: [200, 200, 429][index], evidenceLevel: "intermediary-reported" }] : [],
        });
        return record;
    });
}

async function reportFixture(t, long = false) {
    const records = printRecords(long), { context } = await privateFixture(t, records);
    let state = await loadBoardState(context);
    const model = buildAssessmentModel(state);
    await executeAssessmentAction(context, "print-proof", "set_personal_assessment", {
        schemaVersion: 1, mutationRef: `mutation-${randomBytes(16).toString("hex")}`, interactionRef: model.catalog[1].interactionRef,
        expectedBasis: model.basis, checkId: "semantic-answer-correctness", verdict: "pass", withdraw: false,
    });
    state = await loadBoardState(context);
    const controller = createExportController(context);
    const preview = await controller.preview("print-proof", undefined, {
        promptMode: "masked", formats: ["html", "pdf", "json", "markdown"], timeContext,
    }, { kind: "all", revision: state.revision });
    return { context, controller, preview, records };
}

async function readPages(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
        const document = await task.promise, pages = [];
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number), viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const items = content.items.filter(item => item.str?.trim());
            for (const item of items) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `Page ${number}: text stays within horizontal bounds`);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `Page ${number}: text stays within vertical bounds`);
                if (/SHORT_BODY_|LONG_LINE_|full source \/|Selected export inventory/.test(item.str)) {
                    assert.ok(item.height >= 9.9, `Page ${number}: prompt and metadata must not be shrunk below 10pt`);
                }
            }
            const body = items.filter(item => item.transform[5] > 35 && item.transform[5] < viewport.height - 36);
            pages.push({
                number, height: viewport.height,
                text: content.items.map(item => item.str ?? "").join(""),
                bodyBottom: body.length ? Math.min(...body.map(item => item.transform[5])) : viewport.height,
            });
        }
        return pages;
    } finally { await task.destroy(); }
}

test("four short prompt records remain complete on a page and avoid a nearly blank coverage tail", { timeout: 120000 }, async t => {
    const { controller, preview } = await reportFixture(t);
    assert.equal(preview.previewHtml.split(reportPrintPaginationStyles).length - 1, 1);
    const beforeHtml = preview.previewHtml.replace(reportPrintPaginationStyles, "");
    const beforePdf = await renderPdf(beforeHtml), afterPdf = Buffer.from(preview.files["product-report.pdf"].data, "base64");
    const before = await readPages(beforePdf), after = await readPages(afterPdf);
    if (process.env.WIRE_REPORT_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short.html"), preview.previewHtml);
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short-after.pdf"), afterPdf);
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short-pages.json"), JSON.stringify({ before, after }, null, 2));
    }
    // Flat charts reduce pagination pressure even with the former spacing.
    // Assert the complete current pages rather than requiring the old defect.
    for (const [index, record] of preview.records.entries()) {
        assert.equal(lastPage(after, record.scenarioId), lastPage(after, `SHORT_BODY_${index + 1}`), `Short record ${index + 1} heading/metadata/body stay together`);
        assert.ok(lastPage(after, `SHORT_BODY_${index + 1}`), "Every short copy remains in the PDF");
        if (preview.previewHtml.includes(`class="prompt-record" id="${record.scenarioId}"`)) {
            assert.equal(lastPage(after, promptSummary(record, index)), lastPage(after, `SHORT_BODY_${index + 1}`), "Additional-copy summary and reference stay with the opening text");
        }
    }
    assert.equal(lastPage(after, "Coverage and reading notes"), lastPage(after, "Evidence layers - separate units"), "Coverage heading stays with its first data");
    assert.ok(after.length <= before.length, "Current chart and spacing do not add a wasteful extra page");
    assert.ok(after.length <= 5, "Four short prompts do not need six pages");
    assert.ok(after.at(-1).bodyBottom < after.at(-1).height * 0.65, "The final page is not just a few orphaned bullets and footer");
    assert.equal(contentText(after), contentText(before), "Every report-body character remains in the same order");
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
        const layout = async html => {
            await page.setContent(html);
            await page.evaluate(() => document.fonts.ready);
            return page.locator(".report-brand,.report-dimensions,#prompts,#coverage").evaluateAll(nodes => nodes.map(node => {
                const box = node.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height };
            }));
        };
        assert.deepEqual(await layout(preview.previewHtml), await layout(beforeHtml), "Screen HTML layout is unchanged by print-only rules");
    } finally { await browser.close(); }
    const reviewed = await controller.review("print-proof", preview.previewId, true, timeContext);
    const saved = (await controller.confirm("print-proof", preview.previewId, true, timeContext)).bundle;
    for (const [name, content] of Object.entries(reviewed.files)) {
        const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content.data, "base64");
        assert.deepEqual(await readFile(saved.files[name]), bytes);
    }
    const hashes = await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file))));
    await renderPdf(preview.previewHtml);
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file)))), hashes, "Rendering a new copy never rewrites saved artifacts");
    if (process.env.WIRE_REPORT_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short-before.pdf"), beforePdf);
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short-after.pdf"), afterPdf);
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-short-pages.json"), JSON.stringify({ before, after }, null, 2));
    }
});

test("long prompt copies paginate completely while inline short copies stay grouped", { timeout: 120000 }, async t => {
    const { preview } = await reportFixture(t, true);
    const bytes = Buffer.from(preview.files["product-report.pdf"].data, "base64"), pages = await readPages(bytes);
    const text = contentText(pages);
    for (let line = 0; line < 240; line++) assert.ok(text.includes(`LONG_LINE_${String(line).padStart(3, "0")}`), `Long prompt line ${line} is retained`);
    const start = lastPage(pages, "LONG_LINE_000"), end = lastPage(pages, "LONG_LINE_239");
    assert.ok(end >= start + 2, "A truly long prompt splits across multiple pages instead of clipping or shrinking");
    assert.equal(lastPage(pages, preview.records[2].scenarioId), start, "Long prompt metadata stays with its opening text");
    assert.equal(lastPage(pages, promptSummary(preview.records[2], 2)), start, "Long prompt request title stays with its identifier and opening text");
    for (const index of [0, 1, 3]) {
        assert.equal(lastPage(pages, preview.records[index].scenarioId), lastPage(pages, `SHORT_BODY_${index + 1}`));
    }
    assert.ok(text.includes("Coverageandreadingnotes"));
    let previousLine = text.lastIndexOf("LONG_LINE_000");
    for (let line = 1; line < 240; line++) {
        const nextLine = text.indexOf(`LONG_LINE_${String(line).padStart(3, "0")}`, previousLine + 1);
        assert.ok(nextLine > previousLine, `The complete long copy retains original line order at ${line}`);
        previousLine = nextLine;
    }
    assert.ok(text.lastIndexOf("SHORT_BODY_4") < text.lastIndexOf("LONG_LINE_000"), "The complete short example is not repeated in the later appendix");
    if (process.env.WIRE_REPORT_PROOFS) {
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-long-after.pdf"), bytes);
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "logical-print-long-pages.json"), JSON.stringify(pages, null, 2));
    }
});
