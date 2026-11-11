import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";

const filenames = ["product-report.html", "product-report.pdf", "product-report.json", "product-report.md", "coverage-and-redaction-manifest.json"];
const formats = ["html", "pdf", "json", "markdown", "manifest"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bytesOf = value => typeof value === "string" ? Buffer.from(value) : Buffer.from(value.data, "base64");

test("all file viewers preserve the edited report through regeneration, reading and exact saved download", { timeout: 120000 }, async t => {
    const records = Array.from({ length: 6 }, (_, index) => {
        const record = fixture(`format-journey-${index}`);
        record.capturedAt = new Date(Date.now() - index * 86400000).toISOString();
        record.followUpPrompts = [];
        record.userPrompt = { text: index === 5 ? null : `Cedar request ${index + 1} for jordan@example.invalid. `
            + "Keep recorded mailbox decisions separate from open calendar questions and document changes. ".repeat(index < 2 ? 35 : 3),
            status: index === 5 ? "unavailable" : index === 4 ? "partial" : "full",
            sourceTimestamp: record.capturedAt, sourceEventId: `format-prompt-${index}`,
            ...(index === 5 ? {} : { authorship: { actor: index % 2 ? "agent" : "user", basis: index % 2 ? "source-agent" : "source-user" } }) };
        record.toolCalls = ["/me/messages", "/me/calendarView"].map((target, call) => ({
            ...structuredClone(record.toolCalls[0]), toolCallId: `format-call-${index}-${call}`,
            startEventId: `format-start-${index}-${call}`, startedAt: record.capturedAt,
            requestArgs: { entityUrls: [target] }, durationMs: 150 * (call + 1),
            toolSucceeded: index === 5 ? null : index >= 2 || call > 0,
            reportedOutcome: index === 5 ? "unknown" : index < 2 && call === 0 ? "failed" : "succeeded",
            apiResults: index === 5 ? [] : [{ index: 0, statusCode: index < 2 && call === 0 ? 403 : 200 }],
        }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const fn of cleanup) await fn(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: "light" });
    page.setDefaultTimeout(10000);
    const errors = [], outside = [], receipts = [], output = process.env.WIRE_FORMAT_JOURNEY_PROOFS;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(runtime.url).origin && !["blob:", "data:"].includes(url.protocol)) {
            outside.push(url.href); return route.abort();
        }
        return route.continue();
    });
    async function capture(name, screenshot) {
        if (!output) return;
        await mkdir(output, { recursive: true });
        if (screenshot) await writeFile(path.join(output, name + ".png"), screenshot);
        else await page.screenshot({ path: path.join(output, name + ".png"), animations: "disabled" });
    }
    async function regenerate(action) {
        const response = page.waitForResponse(value => value.url().endsWith("/api/preview"));
        await action();
        const result = await response, value = await result.json();
        assert.equal(result.status(), 200, value.error);
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        return value;
    }
    async function readyFile(scope, format) {
        const file = scope.locator(".saved-file-preview:visible");
        if (format === "pdf") await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else if (format === "html") await expect(file.frameLocator("iframe").locator("h1")).toContainText("Cedar");
        else await expect(file.locator(format === "markdown" ? ".saved-markdown" : ".saved-json-tree")).toBeVisible();
        return file;
    }
    async function visibleDocument(file, format, title) {
        const documentView = format === "html" ? file.frameLocator("iframe") : file.locator(".saved-markdown");
        const heading = documentView.locator("h1");
        await expect(heading).toHaveText(title);
        await expect(heading).toBeInViewport({ ratio: 1 });
        await expect(documentView.getByText("Retained activity", { exact: true })).toBeInViewport();
        await expect.poll(() => heading.evaluate(() => document.fonts.status)).toBe("loaded");
        let screenshot;
        await expect.poll(async () => {
            const bounds = await heading.boundingBox(), color = await heading.evaluate(node => getComputedStyle(node).color);
            screenshot = await page.screenshot({ animations: "disabled", scale: "css" });
            return page.evaluate(async ({ png, bounds, color }) => {
                const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))]));
                const canvas = document.createElement("canvas");
                canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d");
                context.fillStyle = color; context.fillRect(0, 0, 1, 1);
                const ink = context.getImageData(0, 0, 1, 1).data;
                context.drawImage(image, 0, 0); image.close();
                const pixels = context.getImageData(Math.floor(bounds.x), Math.floor(bounds.y),
                    Math.ceil(bounds.width), Math.ceil(bounds.height)).data;
                let painted = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] > 0 && Math.abs(pixels[index] - ink[0])
                        + Math.abs(pixels[index + 1] - ink[1]) + Math.abs(pixels[index + 2] - ink[2]) < 60) painted++;
                }
                return painted < pixels.length / 4 * .6 ? painted : 0;
            }, { png: screenshot.toString("base64"), bounds, color });
        }, { message: `${format} heading must be painted in the visible document, not just present in its DOM.` }).toBeGreaterThan(100);
        return screenshot;
    }
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    let prepared = await regenerate(() => page.locator('[data-report-preset="all"]').click());
    prepared = await regenerate(() => page.getByLabel("Report name", { exact: true }).fill("Cedar format review"));
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) prepared = await regenerate(() => page.locator(`#formatOptions input[value=${format}]`).check());
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    await selectActivityOption(page, "preparedReportView", "text");
    await page.getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".report-copy-controls textarea").fill("Cedar revised copy for jordan@example.invalid.");
    prepared = await regenerate(() => page.getByRole("button", { name: "Update report copy", exact: true }).click());
    await page.getByRole("button", { name: "Next report copies", exact: true }).click();
    await page.getByText("Edit or omit this report copy", { exact: true }).click();
    await page.locator(".report-copy-controls input[type=checkbox]").check();
    prepared = await regenerate(() => page.getByRole("button", { name: "Update report copy", exact: true }).click());
    const population = prepared.snapshot.reportPopulation;
    const inspection = page.locator("#reportFileInspection");
    for (const [index, format] of formats.entries()) {
        const name = filenames[index];
        await selectActivityOption(page, "preparedReportView", name);
        let file = await readyFile(inspection, format);
        if (format !== "pdf") await inspection.getByRole("button", { name: "Source", exact: true }).click();
        prepared = await regenerate(() => page.getByLabel("Report name", { exact: true }).fill(`Cedar ${format} review`));
        await expect(page.locator("#preparedReportView")).toHaveValue(name);
        assert.deepEqual(prepared.snapshot.reportPopulation, population);
        if (format !== "pdf") {
            assert.equal(await inspection.locator("pre:visible").textContent(), prepared.files[name]);
            await inspection.getByRole("button", { name: ["json", "manifest"].includes(format) ? "Tree" : "Preview", exact: true }).click();
        }
        file = await readyFile(inspection, format);
        if (format === "pdf") {
            await page.getByRole("button", { name: "Next PDF page", exact: true }).click();
            await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("2");
            await file.locator(".saved-pdf-pages").focus();
            await page.keyboard.press("PageDown");
            await expect.poll(() => file.locator(".saved-pdf-pages").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        } else if (format === "json" || format === "manifest") {
            const summary = file.locator("summary").filter({ has: page.getByText(format === "json" ? "records" : "files", { exact: true }) });
            await summary.focus(); await page.keyboard.press("Enter");
            await expect(summary.locator("..")).toHaveAttribute("open", "");
        }
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            if (theme === "dark") {
                await page.setViewportSize({ width: 390, height: 950 });
                await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
                await page.locator(".report-reading-toolbar").evaluate(node => node.scrollIntoView({ block: "start", behavior: "instant" }));
                if (format === "pdf") await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.ok((await file.boundingBox()).height >= 200);
            const view = await page.getByRole("combobox", { name: "Prepared report view", exact: true }).boundingBox();
            const header = await page.getByRole("banner").boundingBox();
            assert.ok(view.y >= header.y + header.height, "The View control must not be covered by the sticky header.");
            const label = await page.locator(".report-reading-toolbar .select-field>label").evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                return range.getBoundingClientRect().toJSON();
            });
            assert.ok(label.bottom <= view.y || label.right <= view.x - 4,
                "The complete View label must not overlap its select.");
            const screenshot = ["html", "markdown"].includes(format) ? await visibleDocument(file, format, prepared.title) : undefined;
            await capture(`prepared-${format}-${theme}`, screenshot);
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
        await file.click({ position: { x: 25, y: 25 } });
        await expect(page.locator("#reportPeriodChoices")).toBeHidden();
        receipts.push({ format, prepared: true, regeneration: true, keyboard: true, themesAndNarrow: true });
    }
    const loading = getDocument({ data: new Uint8Array(bytesOf(prepared.files["product-report.pdf"])), useSystemFonts: false, isEvalSupported: false });
    const pdf = await loading.promise, pages = [];
    try {
        for (let index = 1; index <= pdf.numPages; index++) {
            const page = await pdf.getPage(index);
            pages.push((await page.getTextContent()).items.map(item => item.str ?? "").join(" "));
        }
    } finally { await loading.destroy(); }
    for (const content of [prepared.files["product-report.html"], prepared.files["product-report.md"],
        prepared.files["product-report.json"], pages.join(" ")]) {
        assert.match(content, /Cedar revised copy/);
        assert.doesNotMatch(content, /Cedar request 2 |jordan@example\.invalid/);
    }
    assert.equal(prepared.records.length, 6);
    assert.equal(prepared.promptReview.some(copy => copy.status === "partial"), true);
    assert.equal(prepared.promptReview.some(copy => copy.original === null), true);
    if (output) await writeFile(path.join(output, "edited-pdf-extracted.txt"), pages.join("\n\n"));
    // Changing population still regenerates the selected real file, never a substitute Report view.
    await inspection.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    prepared = await regenerate(() => page.locator("#reportPeriodChoices [data-report-range='14']").click());
    await expect(page.locator("#preparedReportView")).toHaveValue(filenames[4]);
    assert.equal(await inspection.locator("pre:visible").textContent(), prepared.files[filenames[4]]);
    await capture("date-change-keeps-source");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    prepared = await regenerate(() => selectActivityOption(page, "reportOutcome", "errors"));
    if (await page.locator("#reportIncludeOptions").isVisible()) await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("#preparedReportView")).toHaveValue(filenames[4]);
    assert.equal(prepared.records.length, 2);
    prepared = await regenerate(() => page.getByLabel("Report name", { exact: true }).fill("Cedar saved format review"));
    const manifest = JSON.parse(prepared.files[filenames[4]]);
    for (const name of filenames.filter(name => name !== filenames[4])) {
        const bytes = bytesOf(prepared.files[name]);
        assert.deepEqual(manifest.files[name], { sha256: sha(bytes), bytes: bytes.length });
    }
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports[0], originals = new Map();
    for (const [name, file] of Object.entries(saved.files)) {
        originals.set(file, await readFile(file));
        if (name !== filenames[4]) assert.deepEqual(originals.get(file), bytesOf(prepared.files[name]));
    }
    const savedManifest = JSON.parse(originals.get(saved.files[filenames[4]]));
    assert.deepEqual(savedManifest.files, manifest.files);
    assert.equal(savedManifest.snapshotHash, manifest.snapshotHash);
    assert.equal(savedManifest.privacyReview.localSave.method, "explicit-local-save");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    const reader = page.locator("#savedReportReader");
    for (const [index, format] of formats.entries()) {
        await selectActivityOption(page, "savedReaderFormat", format);
        const file = await readyFile(reader, format);
        await chooseTheme(page, "light"); await capture(`saved-${format}-light`);
        if (format === "pdf") {
            await page.setViewportSize({ width: 768, height: 1000 });
            await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            await capture("pdf-tablet-toolbar");
            const select = await reader.getByRole("combobox", { name: "Saved report view", exact: true }).boundingBox();
            const info = await reader.getByRole("button", { name: "About this file", exact: true }).boundingBox();
            assert.ok(Math.abs(select.y + select.height / 2 - info.y - info.height / 2) < 2,
                "File selection and its info action must share a row above PDF controls.");
        }
        await chooseTheme(page, "dark"); await page.setViewportSize({ width: 390, height: 950 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        if (format === "pdf") await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        assert.ok((await file.boundingBox()).height >= 120);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (format === "pdf") {
            const zoom = await reader.getByRole("combobox", { name: "PDF zoom", exact: true }).boundingBox();
            const toolbar = await reader.locator(".saved-pdf-toolbar").boundingBox();
            assert.ok(zoom.x >= toolbar.x && zoom.x + zoom.width <= toolbar.x + toolbar.width,
                "The PDF zoom control must be fully visible without scrolling its toolbar.");
        }
        await capture(`saved-${format}-dark`);
        if (format !== "pdf") {
            await reader.getByRole("button", { name: "Source", exact: true }).click();
            assert.equal(await reader.locator("pre:visible").textContent(), originals.get(saved.files[filenames[index]]).toString());
        }
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const value = await download;
        assert.deepEqual(await readFile(await value.path()), originals.get(saved.files[filenames[index]]));
        receipts[index].savedAndDownloaded = true;
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await selectActivityOption(page, "savedReaderFormat", "report");
    await expect(reader.frameLocator("iframe").locator("h1")).toHaveText(prepared.title);
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes);
    if (output) {
        for (const [name, content] of Object.entries(prepared.files)) await writeFile(path.join(output, name), bytesOf(content));
        for (const [file, bytes] of originals) await writeFile(path.join(output, "saved-" + path.basename(file)), bytes);
        await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipts, null, 2));
    }
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
});

test("HTML-absent reports use their real saved formats and refuse an altered selected file", { timeout: 60000 }, async t => {
    const record = fixture("format-without-html");
    record.capturedAt = new Date().toISOString(); record.toolCalls[0].startedAt = record.capturedAt;
    record.userPrompt.text = "Cedar older saved copy, with a retained user request.";
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record]);
    const controller = createExportController(context), originals = new Map(), bundles = [];
    for (const format of ["pdf", "json", "markdown"]) {
        const owner = "older-" + format;
        const prepared = await controller.preview(owner, undefined, {
            title: `Cedar ${format}-only report`, formats: [format], promptMode: "masked",
        }, { kind: "all", revision: (await loadBoardState(context)).revision });
        await controller.review(owner, prepared.previewId, true);
        const bundle = (await controller.confirm(owner, prepared.previewId, true)).bundle;
        bundles.push(bundle);
        for (const file of Object.values(bundle.files)) originals.set(file, await readFile(file));
    }
    const before = await loadBoardState(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const fn of cleanup) await fn(); });
    const page = await browser.newPage({ viewport: { width: 768, height: 1000 } }), posts = [], errors = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const reader = page.locator("#savedReportReader"), output = process.env.WIRE_FORMAT_JOURNEY_PROOFS;
    for (const [index, format] of ["pdf", "json", "markdown"].entries()) {
        await page.getByRole("button", { name: `View report: Cedar ${format}-only report`, exact: true }).click();
        if (format === "pdf") await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else await expect(reader.frameLocator("iframe").locator("h1")).toHaveText(`Cedar ${format}-only report`);
        await selectActivityOption(page, "savedReaderFormat", format);
        if (format === "pdf") {
            await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            await expect(reader.locator(".saved-pdf-text")).toContainText("Cedar pdf-only report");
            await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
            await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            await expect(reader.locator(".saved-pdf-text")).toContainText("Cedar older saved copy");
        } else await expect(reader.locator(format === "json" ? ".saved-json-tree" : ".saved-markdown")).toBeVisible();
        if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, `older-${format}.png`), animations: "disabled" }); }
        const name = "product-report." + (format === "markdown" ? "md" : format);
        const download = page.waitForEvent("download");
        await reader.getByRole("button", { name: "Download", exact: true }).click();
        assert.deepEqual(await readFile(await (await download).path()), originals.get(bundles[index].files[name]));
        await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    }
    const target = bundles[1].files["product-report.json"];
    await writeFile(target, Buffer.concat([originals.get(target), Buffer.from("\n")]));
    try {
        await page.getByRole("button", { name: "View report: Cedar json-only report", exact: true }).click();
        await expect(reader).toContainText(/changed|integrity|match|altered/i);
        await expect(reader.locator("iframe,.saved-json-tree,.saved-pdf-sheet,.saved-markdown")).toHaveCount(0);
        await expect(reader.getByRole("button", { name: "Download", exact: true })).toBeHidden();
        await expect(reader.getByRole("button", { name: "Expand sections", exact: true })).toBeHidden();
        if (output) await page.screenshot({ path: path.join(output, "altered-file-refused.png"), animations: "disabled" });
        await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    } finally { await writeFile(target, originals.get(target)); }
    assert.deepEqual(await loadBoardState(context), before);
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes);
    assert.equal(posts.some(route => ["/api/preview", "/api/export"].includes(route)), false);
    assert.deepEqual(errors, []);
});
