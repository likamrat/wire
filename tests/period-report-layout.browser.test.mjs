import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { privateFixture } from "./helpers.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { createExportController } from "../lib/export.mjs";
import { groupPeriodEvidence, renderPeriodReportMarkdown } from "../lib/period-report-output.mjs";

const proofRoot = process.env.WIRE_PERIOD_REPORT_PROOFS;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

for (const [name, callCount] of [["normal", null], ["long", 48], ["multi-page", 96]]) test(`fresh ${name} period output preserves sequential print traversal and continuation`, { timeout: 60000 }, async t => {
    const proof = proofRoot && path.join(proofRoot, name);
    const { records, input } = periodFixture();
    records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    if (callCount) {
        const templates = records[0].toolCalls.slice(0, 3);
        records[0].toolCalls = Array.from({ length: callCount }, (_, index) => ({
            ...structuredClone(templates[index % templates.length]),
            toolCallId: `layout-call-${index}`, startEventId: `layout-start-${index}`, completionEventId: `layout-end-${index}`,
        }));
    } else input.scenarioIds = records.map(record => record.scenarioId);
    const { context } = await privateFixture(t, records);
    const before = await loadBoardState(context);
    const value = buildPeriodComparison(before, { ...input, expectedRevision: before.revision });
    const controller = createExportController(context);
    const preview = await controller.preview("period-layout", undefined, {
        title: "Recorded period comparison", formats: ["html", "pdf", "json", "markdown"], promptMode: "none", timeContext: value.timeContext,
    }, undefined, value);
    const manifest = JSON.parse(preview.files["coverage-and-redaction-manifest.json"]);
    const bytes = Object.fromEntries(Object.entries(preview.files).map(([name, contents]) =>
        [name, typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents.data, "base64")]));
    for (const [name, entry] of Object.entries(manifest.files)) assert.equal(hash(bytes[name]), entry.sha256);
    assert.deepEqual(preview.snapshot.periodComparison.comparison, value.comparison);
    assert.deepEqual(JSON.parse(preview.files["product-report.json"]), preview.snapshot);
    assert.equal(preview.files["product-report.md"], renderPeriodReportMarkdown(preview.snapshot));
    assert.ok(preview.files["product-report.md"].indexOf("## Timing") <
        preview.files["product-report.md"].indexOf("## Exact matching evidence"), "Read the timing comparison before the full record roster");
    assert.equal(manifest.periodComparisonHash, hash(JSON.stringify(preview.snapshot.periodComparison)));
    assert.ok(!preview.previewHtml.includes("--context-paper"), "Screen theme roles stay outside output");
    if (proof) {
        await mkdir(proof, { recursive: true });
        for (const [name, data] of Object.entries(bytes)) await writeFile(path.join(proof, name), data);
    }
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", route => route.abort());
    await page.setContent(preview.previewHtml);
    await page.evaluate(() => document.fonts.ready);
    const views = [];
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
        await page.setViewportSize({ width, height });
        const rendered = await page.locator(".period-evidence-group").evaluateAll(groups => groups.map(group => ({
            period: group.dataset.period, ordinal: group.dataset.interactionOrdinal,
            records: [...group.querySelectorAll("tr[data-record-id]")].map(row => row.dataset.recordId),
        })));
        for (const [key, name] of [["baseline", "A"], ["later", "B"]]) {
            const side = preview.snapshot.periodComparison.periods[key], expected = groupPeriodEvidence(side, preview.snapshot);
            assert.deepEqual(rendered.filter(group => group.period === name).map(group => group.records),
                expected.map(group => group.records.map(record => record.row.id)));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const grid = await page.locator(".period-evidence-grid").first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
        assert.equal(grid, width === 390 ? 1 : 2);
        if (width === 390) assert.equal(await page.locator(".comparison-whole-values").first()
            .evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 1,
        "Narrow whole-interaction values use a full line per period");
        views.push({ width, grid, rendered });
        if (proof) {
            for (const [name, selector] of [["overview", "#numbers"], ["evidence", "#evidence"], ["coverage", "#definitions"]]) {
                await page.locator(selector).scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(proof, `${name}-${width}.png`) });
            }
        }
    }
    await page.emulateMedia({ media: "print" });
    const type = await page.locator(".period-evidence-group td").first().evaluate(node => ({
        font: getComputedStyle(node).fontFamily, size: parseFloat(getComputedStyle(node).fontSize),
        padding: getComputedStyle(node).paddingTop,
    }));
    assert.ok(type.size >= 13.3, "Record text remains at least10pt");
    const headingPadding = await page.locator(".period-evidence-group thead th").first().evaluate(node => parseFloat(getComputedStyle(node).paddingTop));
    assert.ok(Math.abs(headingPadding - 16 / 3) < 0.01, "Print header padding overrides the screen-specific selector");
    const task = getDocument({ data: new Uint8Array(bytes["product-report.pdf"]), useSystemFonts: false, disableFontFace: true });
    const pages = [], traversal = [];
    let activePeriod;
    try {
        const document = await task.promise;
        for (let index = 1; index <= document.numPages; index++) {
            const pdfPage = await document.getPage(index);
            const items = (await pdfPage.getTextContent()).items;
            pages.push(items.map(item => item.str ?? "").join(" "));
            const periodHeadings = items.filter(item => /^Period [AB]$/.test(item.str))
                .sort((a, b) => b.transform[5] - a.transform[5]);
            // Each period starts its own column flow, including below another period on the same page.
            const bands = [{ period: activePeriod, top: Infinity }, ...periodHeadings.map(item => ({
                period: item.str.match(/^Period ([AB])/)[1], top: item.transform[5],
            }))];
            for (const [bandIndex, band] of bands.entries()) {
                const bottom = bands[bandIndex + 1]?.top ?? -Infinity;
                const labels = items.flatMap(item => {
                    const ordinal = item.str === "Record" ? items.filter(value => /^\d+$/.test(value.str)
                        && Math.abs(value.transform[5] - item.transform[5]) < 0.1
                        && value.transform[4] >= item.transform[4] + item.width
                        && value.transform[4] - item.transform[4] - item.width <= 16)
                        .sort((a, b) => a.transform[4] - b.transform[4])[0] : null;
                    const match = /^(Interaction|Record) (\d+)$/.exec(ordinal ? `Record ${ordinal.str}` : item.str);
                    if (!match || item.transform[5] >= band.top || item.transform[5] <= bottom) return [];
                    return [{ period: band.period, kind: match[1], ordinal: Number(match[2]), page: index,
                        column: item.transform[4] < pdfPage.view[2] / 2 ? 0 : 1, y: item.transform[5] }];
                }).sort((a, b) => a.column - b.column || b.y - a.y);
                traversal.push(...labels);
            }
            activePeriod = bands.at(-1).period;
            if (proof) {
                const viewport = pdfPage.getViewport({ scale: 1.25 }), surface = document.canvasFactory.create(viewport.width, viewport.height);
                await pdfPage.render({ canvasContext: surface.context, viewport }).promise;
                await writeFile(path.join(proof, `pdf-${index}.png`), surface.canvas.toBuffer("image/png"));
                document.canvasFactory.destroy(surface);
            }
        }
    } finally { await task.destroy(); }
    const longGroup = groupPeriodEvidence(preview.snapshot.periodComparison.periods.baseline, preview.snapshot)
        .reduce((longest, group) => group.records.length > longest.records.length ? group : longest);
    const expectedTraversal = Object.entries(preview.snapshot.periodComparison.periods).flatMap(([key, side]) =>
        groupPeriodEvidence(side, preview.snapshot).flatMap(group => group.records.map(record => ({
            period: key === "baseline" ? "A" : "B", ordinal: record.ordinal, interaction: group.interactionOrdinal,
        }))));
    const actualRecords = traversal.filter(item => item.kind === "Record");
    assert.deepEqual(actualRecords.map(({ period, ordinal }) => ({ period, ordinal })),
        expectedTraversal.map(({ period, ordinal }) => ({ period, ordinal })),
        "Per-period print traversal must finish each group down left then down right before advancing to the next group or page");
    let fragment, interaction, recordIndex = 0, pendingHeader = false;
    for (const item of traversal) {
        const key = `${item.page}:${item.period}:${item.column}`;
        if (fragment !== key) {
            assert.equal(pendingHeader, false, "A group heading must stay with its first record");
            fragment = key; interaction = undefined;
        }
        if (item.kind === "Interaction") {
            assert.equal(pendingHeader, false, "A group heading must not be separated from its records");
            interaction = item.ordinal; pendingHeader = true;
        } else {
            assert.equal(interaction, expectedTraversal[recordIndex++].interaction,
                "Each column/page continuation must repeat its interaction identity before records");
            pendingHeader = false;
        }
    }
    assert.equal(pendingHeader, false, "The final group heading must have a record");
    if (callCount) {
        const headers = traversal.filter(item => item.period === "A" && item.kind === "Interaction"
            && item.ordinal === longGroup.interactionOrdinal);
        assert.ok(headers.length > 1, "A genuinely long group continues with its interaction identity across columns or pages");
        if (name === "multi-page") assert.ok(new Set(headers.map(item => item.page)).size > 1,
            "The stress group must exercise continuation across a real PDF page boundary");
    }
    const expectedOrdinals = Object.values(preview.snapshot.periodComparison.periods)
        .flatMap(side => groupPeriodEvidence(side, preview.snapshot).flatMap(group => group.records.map(record => record.ordinal))).sort((a, b) => a - b);
    assert.deepEqual([...pages.join(" ").matchAll(/\bRecord\s+(\d+)\b/g)].map(match => Number(match[1])).sort((a, b) => a - b), expectedOrdinals);
    const last = pages.at(-1);
    assert.ok(!last.includes("Interpretation") || last.includes("Timing method") || last.includes("Record "),
        "The final Interpretation fact must not be stranded alone with a footer");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(await loadBoardState(context), before);
    if (proof) await writeFile(path.join(proof, "proof.json"), JSON.stringify({
        pageCount: pages.length, pages, traversal, views, type, hashes: manifest.files, liveComparisonEqual: true,
        jsonUnchanged: true, markdownUnchanged: true, savedExports: 0,
    }, null, 2));
});
