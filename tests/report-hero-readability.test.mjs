import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture, privateFixture } from "./helpers.mjs";
import { createExportController, buildSanitizedBundle } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { recordedToolScoreHtml, reportPresentationStyles, reportScreenHeroStyles } from "../lib/report-presentation.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function pdfLayout(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
        const document = await task.promise, pages = [];
        const rounded = value => Math.round(value * 100) / 100;
        for (let number = 1; number <= document.numPages; number++) {
            const content = await (await document.getPage(number)).getTextContent();
            pages.push(content.items.filter(item => typeof item.str === "string").map(item => ({
                text: item.str, x: rounded(item.transform[4]), y: rounded(item.transform[5]),
                width: rounded(item.width), height: rounded(item.height),
            })));
        }
        return pages;
    } finally { await task.destroy(); }
}

test("screen score narrative wraps into a readable track without changing fonts, metrics or print layout", { timeout: 120000 }, async t => {
    const records = Array.from({ length: 4 }, (_, index) => {
        const record = fixture(`hero-${index}`);
        record.followUpPrompts = [];
        record.userPrompt.text = `SYNTHETIC HERO READABILITY PROOF ${index}`;
        Object.assign(record.toolCalls[0], {
            toolSucceeded: [true, true, false, null][index],
            reportedOutcome: ["succeeded", "succeeded", "failed", "unknown"][index],
        });
        return record;
    });
    const { context } = await privateFixture(t, records);
    const controller = createExportController(context), state = await loadBoardState(context);
    const timeContext = { timeZone: "America/Los_Angeles", locale: "en-US" };
    const preview = await controller.preview("hero-proof", undefined, {
        promptMode: "none", formats: ["html", "pdf", "json", "markdown"],
        timeContext,
    }, { kind: "all", revision: state.revision });
    const html = preview.previewHtml;
    assert.equal(html.split(reportScreenHeroStyles).length - 1, 1);
    const beforeHtml = html.replace(reportScreenHeroStyles, "");
    const browser = await chromium.launch({ headless: true });
    const matrix = [];
    try {
        const context = await browser.newContext(), requests = [];
        await context.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
        const page = await context.newPage();
        await page.setViewportSize({ width: 320, height: 1200 });
        const setDocument = async value => {
            await page.setContent(value);
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(() => window.scrollTo(0, 0));
        };
        const geometry = () => page.evaluate(() => {
            const hero = document.querySelector(".report-tool-score");
            const score = hero.firstElementChild, copy = hero.querySelector(".report-tldr");
            const box = node => {
                const value = node.getBoundingClientRect();
                return { x: value.x, y: value.y, width: value.width, height: value.height, bottom: value.bottom, right: value.right };
            };
            const range = document.createRange(); range.selectNodeContents(copy);
            const scoreText = score.querySelector("strong");
            const glyphRange = document.createRange(); glyphRange.selectNodeContents(scoreText);
            const glyphs = range => [...range.getClientRects()].map(rect => ({
                x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, width: rect.width,
            }));
            const scoreGlyphs = glyphs(glyphRange);
            glyphRange.setEnd(scoreText.firstChild, scoreText.textContent.length - 1);
            const numberGlyphs = glyphs(glyphRange);
            glyphRange.setStart(scoreText.firstChild, scoreText.textContent.length - 1);
            glyphRange.setEnd(scoreText.firstChild, scoreText.textContent.length);
            return {
                hero: box(hero), score: box(score), copy: box(copy),
                copyFont: parseFloat(getComputedStyle(copy).fontSize),
                scoreFont: parseFloat(getComputedStyle(score.querySelector("strong")).fontSize),
                rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
                lineCount: range.getClientRects().length,
                text: copy.textContent, scoreText: scoreText.textContent,
                scoreGlyphs, numberGlyphs, unitGlyphs: glyphs(glyphRange),
                pageWidth: document.documentElement.scrollWidth,
            };
        });
        await setDocument(beforeHtml);
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        const before = await geometry();
        assert.ok(before.copy.width < before.hero.width / 2 && before.lineCount > 15, "The baseline reproduces the readable-track failure, not an overflow proxy");
        assert.equal(before.pageWidth, 320, "The original defect is present despite passing the old no-overflow check");
        await setDocument(html);
        for (const width of [320, 375, 414, 768, 1200, 2560]) for (const scale of [100, 200]) for (const theme of ["light", "dark"]) {
            await page.setViewportSize({ width, height: 1200 });
            await page.evaluate(({ scale, theme }) => {
                document.documentElement.style.fontSize = `${scale}%`;
                document.documentElement.dataset.evidenceTheme = theme;
            }, { scale, theme });
            const actual = await geometry();
            assert.ok(actual.copy.width >= Math.min(actual.hero.width, actual.rootFont * 24) - 1, `${width}/${scale}/${theme}: narrative keeps a meaningful text track`);
            assert.equal(actual.copyFont / actual.rootFont, 1, "Reading text is not shrunk");
            assert.equal(actual.scoreFont / actual.rootFont, 3, "Score text is not shrunk");
            assert.equal(actual.text, before.text);
            assert.equal(actual.scoreText, "50%");
            assert.equal(actual.scoreGlyphs.length, 1, "The compact percentage stays on one line");
            assert.ok(actual.scoreGlyphs.every(rect => rect.x >= actual.hero.x - 1 && rect.right <= actual.hero.right + 1));
            assert.ok(actual.pageWidth <= width + 1);
            const stacked = actual.copy.y >= actual.score.bottom - 1;
            assert.ok(stacked || actual.copy.x >= actual.score.right, "Score and narrative never overlap");
            if (width === 320 && scale === 200) {
                assert.ok(stacked);
                assert.ok(actual.lineCount <= 10, "The 110-character narrative does not turn into a vertical few-letter strip");
                assert.ok(actual.copy.height < before.copy.height / 2);
                assert.equal(actual.copyFont, before.copyFont);
                if (process.env.WIRE_REPORT_PROOFS && theme === "light") {
                    await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
                    await page.locator(".report-tool-score").screenshot({
                        path: path.join(process.env.WIRE_REPORT_PROOFS, "hero-fixed-320-root200.png"),
                    });
                }
            }
            if (width >= 1200 && scale === 100) assert.equal(stacked, false, "Wide layouts keep the side-by-side reading arrangement");
            matrix.push({ width, scale, theme, ...actual });
        }
        const rateCases = [];
        for (const [label, succeeded, total] of [["0%", 0, 4], ["100%", 4, 4], ["88.01%", 191, 217]]) {
            const source = fixture(`hero-rate-${succeeded}`);
            source.followUpPrompts = [];
            source.toolCalls = Array.from({ length: total }, (_, index) => ({
                ...structuredClone(source.toolCalls[0]), toolCallId: `rate-${succeeded}-${index}`, startEventId: `rate-start-${succeeded}-${index}`,
                toolSucceeded: index < succeeded, reportedOutcome: index < succeeded ? "succeeded" : "failed", apiResults: [],
            }));
            const formatted = await buildSanitizedBundle([source], "a".repeat(64), { promptMode: "none", formats: ["html"] });
            const count = formatted.snapshot.summary.metrics.find(metric => metric.layer === "tool");
            assert.equal(count.count, total);
            assert.equal(count.outcomes.success, succeeded);
            rateCases.push({ label, html: formatted.previewHtml, scope: "full-report" });
        }
        const smallPositiveSummary = {
            metrics: [{ layer: "tool", count: 10001, outcomes: { success: 1, failure: 10000, partial: 0, unknown: 0 } }],
            takeaways: ["", "1 of 10,001 calls succeeded; 10,000 failed. This is not verified task correctness."],
        };
        rateCases.push({
            label: "<0.01%", scope: "formatter-boundary-component",
            html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
                <style>${reportPresentationStyles}body{margin:0;padding:16px}</style></head>
                <body>${recordedToolScoreHtml(smallPositiveSummary)}</body></html>`,
        });
        for (const { label, html: rateHtml, scope } of rateCases) {
            await setDocument(rateHtml);
            for (const width of [320, 375]) for (const theme of ["light", "dark"]) {
                await page.setViewportSize({ width, height: 1200 });
                await page.evaluate(theme => {
                    document.documentElement.style.fontSize = "200%";
                    document.documentElement.dataset.evidenceTheme = theme;
                }, theme);
                const actual = await geometry();
                assert.equal(actual.scoreText, label);
                assert.ok((await page.locator(".report-tool-score").ariaSnapshot()).includes(label), "Assistive technology receives the unchanged percentage");
                assert.equal(actual.copyFont, before.copyFont);
                assert.equal(actual.scoreFont, before.scoreFont);
                assert.ok(actual.copy.width >= actual.hero.width - 1);
                assert.equal(actual.numberGlyphs.length, 1, `${label}/${width}: the numeric part never breaks between digits`);
                assert.equal(actual.unitGlyphs.length, 1, `${label}/${width}: the percent unit remains present`);
                assert.ok(actual.scoreGlyphs.length <= 2, "Only the percent unit may wrap after the intact numeric part");
                if (label === "0%" || label === "100%") assert.equal(actual.scoreGlyphs.length, 1);
                if (width >= 375) assert.equal(actual.scoreGlyphs.length, 1, "The whole percentage stays together whenever it fits");
                assert.ok(actual.scoreGlyphs.every(rect => rect.x >= actual.hero.x - 1 && rect.right <= actual.hero.right + 1), `${label}/${width}: all numeric glyphs remain visible`);
                assert.ok(actual.scoreGlyphs.every(rect => rect.y >= actual.score.y - 1 && rect.bottom <= actual.score.bottom + 1));
                assert.ok(actual.copy.y >= actual.score.bottom - 1, "The narrative starts below the complete score and its unit");
                assert.ok(actual.pageWidth <= width + 1);
                if (process.env.WIRE_REPORT_PROOFS && theme === "light" && ["88.01%", "<0.01%"].includes(label)) {
                    const name = label === "88.01%" ? "long-rate" : "small-positive-rate";
                    await page.locator(".report-tool-score").screenshot({
                        path: path.join(process.env.WIRE_REPORT_PROOFS, `hero-${name}-${width}-root200.png`),
                    });
                }
                matrix.push({ width, scale: 200, theme, scope, ...actual });
            }
        }
        await page.setViewportSize({ width: 1200, height: 1200 });
        await page.emulateMedia({ media: "print" });
        await setDocument(beforeHtml);
        const beforePrint = await geometry();
        await setDocument(html);
        assert.deepEqual(await geometry(), beforePrint, "The screen-only fix changes no print geometry or text");
        assert.deepEqual(requests, []);
        if (process.env.WIRE_REPORT_PROOFS) {
            await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, "hero-readability-matrix.json"), JSON.stringify({ before, matrix, printGeometryUnchanged: true }, null, 2));
        }
    } finally { await browser.close(); }
    const beforePdf = await renderPdf(beforeHtml);
    const afterPdf = Buffer.from(preview.files["product-report.pdf"].data, "base64");
    assert.deepEqual(await pdfLayout(afterPdf), await pdfLayout(beforePdf), "Actual PDF text positions, sizes, page count and text are unchanged");
    const reviewed = await controller.review("hero-proof", preview.previewId, true, timeContext);
    const saved = (await controller.confirm("hero-proof", preview.previewId, true, timeContext)).bundle;
    for (const [name, value] of Object.entries(reviewed.files)) {
        const expected = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.data, "base64");
        assert.deepEqual(await readFile(saved.files[name]), expected);
    }
    const stored = await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file))));
    const savedState = await loadBoardState(context);
    await controller.preview("hero-proof", undefined, { promptMode: "none", formats: ["html"] },
        { kind: "all", revision: savedState.revision });
    assert.deepEqual(await Promise.all(Object.values(saved.files).map(async file => hash(await readFile(file)))), stored);
    assert.deepEqual((await loadBoardState(context)).evidence, state.evidence);
});
