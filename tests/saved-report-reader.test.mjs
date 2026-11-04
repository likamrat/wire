import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, symlink, rename, unlink, truncate } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { fixture, privateFixture, selectActivityOption, chooseTheme } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportDocument, reportHash } from "../lib/report-artifacts.mjs";
import * as reportArtifacts from "../lib/report-artifacts.mjs";
import { artifactDeletionKey } from "../lib/deletion-identities.mjs";
import { chooseReportScope, reportContents, scanReport, openReportLibrary } from "./report-journey-helpers.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { reportMatrixCases } from "./report-evidence-matrix-fixtures.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";
import { buildPeriodComparison } from "../lib/period-comparison.mjs";
import { brandMark, brandDarkMark, PRODUCT_TITLE } from "../lib/branding.mjs";

async function save(exports, context, formats = ["html", "json"], promptMode = "none", title) {
    const state = await loadBoardState(context);
    const preview = await exports.preview("saved-reader", undefined, { promptMode, formats, ...(title ? { title } : {}) },
        { kind: "all", revision: state.revision });
    await exports.review("saved-reader", preview.previewId, true);
    return (await exports.confirm("saved-reader", preview.previewId, true)).bundle;
}

test("saved files preview every format and switch without changing bytes or downgrading broken HTML", { timeout: 60000 }, async t => {
    const records = reportMatrixCases().find(item => item.name === "mixed-parallel-batches").records;
    const prompts = ["Find the planning discussion and identify unresolved decisions.",
        "Review the calendar changes and note any access failures.", "Summarize the handoff documents without guessing missing details."];
    records.forEach((record, index) => { record.userPrompt.text = prompts[index]; record.userPrompt.authorship = { actor: "user", basis: "source-user" }; });
    const { context } = await privateFixture(t, records);
    const controller = createExportController(context), bundles = [];
    for (const formats of [["json"], ["markdown"], ["pdf"], ["html", "pdf", "json", "markdown"], ["html", "json"]])
        bundles.push(await save(controller, context, formats, formats.length === 4 ? "masked" : "none",
            formats.length === 4 ? "Planning activity and release readiness: weekly evidence review for the next handoff" : undefined));
    await updateBoardState(context, state => { delete state.exports.find(entry => entry.bundleId === bundles[4].bundleId).formats; });
    const savedBytes = new Map();
    for (const bundle of bundles) for (const file of Object.values(bundle.files)) savedBytes.set(file, await readFile(file));
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage(), calls = [], downloads = [], foreign = [];
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            foreign.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });

    page.on("request", request => { if (request.method() === "POST") calls.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    page.on("download", download => downloads.push(download));
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    for (const [index, bundle] of bundles.slice(0, 3).entries()) {
        if (index) await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        await page.locator(`#bundleList [data-bundle-id="${bundle.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
        const reader = page.locator("#savedReportReader");
        assert.equal(downloads.length, 0, "Open must not download or run a PDF");
        await reader.getByRole("button", { name: "Download", exact: true }).waitFor();
        assert.equal(await page.locator("#pageTitle").textContent(), bundle.title);
        if (index === 0) {
            await reader.locator(".saved-json-tree").waitFor();
            assert.ok((await reader.locator(".saved-json-tree").textContent()).includes(bundle.bundleId));
            await reader.getByRole("button", { name: "About this file", exact: true }).click();
            const information = page.getByRole("dialog", { name: "About this file", exact: true });
            assert.match(await information.innerText(), /product-report\.json/);
            const retained = await information.locator(".dialog-body").elementHandle();
            await information.getByRole("button", { name: "Got it", exact: true }).click();
            await page.locator("dialog.saved-file-notice").waitFor({ state: "detached" });
            assert.equal(await retained.evaluate(node => node.textContent), "", "Closed file information does not retain metadata");
        } else if (index === 1) {
            await reader.locator(".saved-markdown table").first().waitFor();
            assert.equal(await reader.locator(".saved-markdown h1").textContent(), bundle.title);
            const tables = reader.locator(".saved-markdown table");
            assert.equal(await tables.first().locator("tr > :nth-child(2)").evaluateAll(nodes =>
                nodes.length > 1 && nodes.every(node => getComputedStyle(node).textAlign === "right")), true, "Counts retain Markdown alignment");
            const tools = tables.filter({ has: page.getByRole("columnheader", { name: "Tool", exact: true }) })
                .filter({ has: page.getByRole("columnheader", { name: "Share", exact: true }) });
            assert.equal(await tools.locator("tr > :nth-child(2), tr > :nth-child(3)").evaluateAll(nodes =>
                nodes.length > 2 && nodes.every(node => getComputedStyle(node).textAlign === "right")), true, "Tool counts and shares align with their headers");
            const examples = tables.filter({ has: page.getByRole("columnheader", { name: "Operation", exact: true }) });
            assert.ok(await examples.count());
            assert.equal(await examples.locator("tr").evaluateAll(rows => rows.every(row => [...row.children].every((cell, index) =>
                getComputedStyle(cell).textAlign === (index ? "left" : "right")))), true, "Call numbers align right; tool, operation and outcome fields align left");
        } else {
            await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            assert.ok((await reader.locator(".saved-pdf-text").textContent()).includes(bundle.title));
            assert.equal(await reader.locator(".saved-pdf-sheet canvas").count(), 1);
            const firstPage = await reader.locator(".saved-pdf-text").textContent();
            await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
            await reader.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            assert.equal(await reader.getByRole("spinbutton", { name: "PDF page", exact: true }).inputValue(), "2");
            assert.notEqual(await reader.locator(".saved-pdf-text").textContent(), firstPage);
            const ready = page.waitForEvent("download");
            await reader.getByRole("button", { name: "Download", exact: true }).click();
            const download = await ready;
            assert.equal(download.suggestedFilename(), "product-report.pdf");
            assert.deepEqual(await readFile(await download.path()), savedBytes.get(bundle.files["product-report.pdf"]));
        }
    }
    assert.equal(downloads.length, 1);
    for (const [file, bytes] of savedBytes) assert.deepEqual(await readFile(file), bytes);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator(`#bundleList [data-bundle-id="${bundles[4].bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: bundles[4].title, level: 1, exact: true }).waitFor();
    assert.equal(calls.some(call => call.path === "/api/report-original"), false, "Missing optional formats does not downgrade a verified HTML read");
    assert.equal(await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).count(), 0,
        "Do not offer a download that the stricter format-inventory endpoint cannot validate");
    const broken = bundles[3];
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.locator(`#bundleList [data-bundle-id="${broken.bundleId}"] .saved-report-summary`).click();
    await selectActivityOption(page, "savedInspectorFormat", "product-report.json");
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader .saved-json-tree").waitFor();
    assert.ok((await page.locator("#savedReportReader .saved-json-tree").textContent()).includes(broken.bundleId));
    let oldCanvas;
    for (const format of ["markdown", "pdf", "json", "manifest", "html"]) {
        await selectActivityOption(page, "savedReaderFormat", format);
        const preview = page.locator("#savedReportReader .saved-file-preview");
        if (format === "pdf") await preview.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else if (format === "html") await preview.frameLocator("iframe").locator("h1").waitFor();
        else await preview.locator(format === "markdown" ? ".saved-markdown" : ".saved-json-tree").waitFor();
        if (format !== "pdf") {
            const reader = page.locator("#savedReportReader"), name = await reader.locator(".document-file-name").textContent();
            await reader.getByRole("button", { name: "Source", exact: true }).click();
            assert.equal(await reader.locator(`pre[aria-label="${name}"]`).textContent(), savedBytes.get(broken.files[name]).toString("utf8"));
            await reader.getByRole("button", { name: ["json", "manifest"].includes(format) ? "Tree" : "Preview", exact: true }).click();
            if (format === "html") await preview.frameLocator("iframe").locator("h1").waitFor();
            else await preview.locator(format === "markdown" ? ".saved-markdown" : ".saved-json-tree").waitFor();
        }
        if (oldCanvas) assert.equal(await oldCanvas.evaluate(node => node.width + node.height), 0, "Retired PDF pixels are cleared");
        for (const [theme, width, scale] of [["light", 1440, 100], ["dark", 1440, 100], ["dark", 390, 200]]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            await page.waitForFunction(() => parseFloat(document.documentElement.style.getPropertyValue("--app-header-height"))
                === Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height));
            if (format === "pdf") await preview.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            if (format === "markdown") {
                assert.deepEqual(await preview.locator(".saved-report-mark .brand-logo").evaluateAll(nodes =>
                    nodes.filter(node => node.checkVisibility()).map(node => node.dataset.brandTheme)), [theme]);
                assert.equal(await preview.locator(".saved-report-mark [id]").evaluateAll(nodes =>
                    nodes.every(node => document.querySelectorAll("#" + CSS.escape(node.id)).length === 1)), true, "Cloned wordmarks have isolated paint IDs");
            }
            if (process.env.WIRE_FILE_READER_PROOFS) {
                await mkdir(process.env.WIRE_FILE_READER_PROOFS, { recursive: true });
                await page.screenshot({ path: path.join(process.env.WIRE_FILE_READER_PROOFS, `verified-${format}-${theme}-${scale}.png`) });
            }
            const geometry = await preview.evaluate(node => ({ rect: node.getBoundingClientRect().toJSON(),
                main: document.querySelector("#reportsView").getBoundingClientRect().toJSON(), height: innerHeight,
                stage: document.querySelector("#savedReportReader .document-stage").getBoundingClientRect().toJSON(),
                toolbar: document.querySelector("#savedReportReader .document-file-toolbar").getBoundingClientRect().toJSON(),
                overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
            assert.equal(await page.locator("#savedReportReader .document-file-footer").count(), 0);
            assert.equal(geometry.overflow, false);
            const modes = await page.locator("#savedReportReader .document-file-modes button").evaluateAll(buttons =>
                buttons.filter(button => button.checkVisibility()).map(button => {
                    const bounds = button.getBoundingClientRect(), range = document.createRange();
                    range.selectNodeContents(button);
                    return { label: button.textContent, bounds: bounds.toJSON(), text: range.getBoundingClientRect().toJSON(),
                        fontSize: getComputedStyle(button).fontSize,
                        hit: [bounds.left + 4, bounds.right - 4].every(x => button.contains(document.elementFromPoint(x, bounds.top + bounds.height / 2))) };
                }));
            if (format !== "pdf") assert.ok(modes.length > 0, "Text formats expose their preview/source modes.");
            assert.ok(modes.every(mode => mode.bounds.left >= geometry.toolbar.left && mode.bounds.right <= geometry.toolbar.right
                && mode.bounds.top >= geometry.toolbar.top && mode.bounds.bottom <= geometry.toolbar.bottom
                && mode.text.left >= mode.bounds.left && mode.text.right <= mode.bounds.right && mode.hit),
            `Complete file-view labels and hit areas fit their toolbar: ${format}/${width}/${scale} ${JSON.stringify(modes)} toolbar=${JSON.stringify(geometry.toolbar)}`);
            assert.ok(Math.abs(geometry.stage.width - geometry.main.width) < 2);
            assert.ok(Math.abs(geometry.rect.width - geometry.stage.width) <= 2);
            assert.ok(geometry.stage.bottom <= geometry.height && geometry.rect.height >= 160
                && Math.abs(geometry.rect.top - geometry.toolbar.bottom) < 2
                && Math.abs(geometry.rect.bottom - (geometry.stage.bottom - 1)) < 2,
                `The actual preview uses the remaining reading viewport: ${format}/${theme}/${scale} ${JSON.stringify(geometry)}`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        const downloaded = page.waitForEvent("download");
        await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
        const file = await downloaded;
        assert.deepEqual(await readFile(await file.path()), savedBytes.get(broken.files[file.suggestedFilename()]));
        if (format === "pdf") await preview.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        oldCanvas = format === "pdf" ? await preview.locator(".saved-pdf-sheet canvas").elementHandle() : null;
    }
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/artifact-file", async route => {
        const response = await route.fetch(); pending.resolve();
        await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const delayed = page.waitForResponse(response => response.url().endsWith("/api/artifact-file")
        && response.request().postDataJSON().format === "pdf");
    await selectActivityOption(page, "savedReaderFormat", "pdf"); await pending.promise;
    await selectActivityOption(page, "savedReaderFormat", "markdown");
    await page.locator(".saved-markdown table").first().waitFor();
    release.resolve(); await (await delayed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.locator("#savedReportReader canvas").count(), 0, "A late PDF read cannot replace the selected Markdown");
    assert.equal(await page.locator(".saved-markdown h1").textContent(), broken.title);
    assert.deepEqual(foreign, []);
    await writeFile(broken.files["product-report.html"], "changed saved HTML");
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    const start = calls.length;
    await page.locator(`#bundleList [data-bundle-id="${broken.bundleId}"]`).getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.locator("#savedReportReader .error").waitFor();
    assert.equal(await page.getByRole("button", { name: "Open original file", exact: true }).count(), 0);
    assert.equal(await page.locator("#savedReportReader pre, #savedReportReader iframe").count(), 0);
    assert.equal(calls.slice(start).some(call => call.path === "/api/report-original" || call.path === "/api/artifact-file"), false,
        "Declared but broken HTML must not fall through to JSON, PDF or legacy-original");
});

test("activity, period and comparison reports preview and download their actual persisted formats", { timeout: 90000 }, async t => {
    const { records, input } = periodFixture();
    records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const templates = records[0].toolCalls.slice(0, 3);
    records[0].toolCalls = Array.from({ length: 24 }, (_, index) => ({
        ...structuredClone(templates[index % templates.length]), toolCallId: `reader-call-${index}`,
        startEventId: `reader-start-${index}`, completionEventId: `reader-end-${index}`,
    }));
    const prompts = ["Find the planning notes and report any access errors.", "Check the project calendar for the review session.",
        "Summarize the handoff decisions in the available documents.", "Find the release checklist and identify its owners.",
        "Review the revised milestones against the team calendar.", "Find the notes from the planning discussion.",
        "List the follow-up decisions without guessing missing details.", "Check which documents remain unavailable.",
        "Review the earlier planning snapshot.", "Find the final handoff summary."];
    records.forEach((record, index) => { record.userPrompt.text = prompts[index]; record.userPrompt.authorship = { actor: "user", basis: "source-user" }; });
    const questions = ["Find the decision about the launch date.", "Check who owns the deployment checklist.",
        "List unresolved access requests.", "Find the planning review notes.", "Identify the next approval deadline.",
        "Summarize the rollout risk.", "Check whether the handoff is complete.", "List follow-ups for the next review."];
    records[0].toolCalls.filter(call => call.tool === "workiq-ask").forEach((call, index) => { call.requestArgs.question = questions[index]; });
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const formats = ["html", "pdf", "markdown", "json"], timeContext = input.options.timeContext;
    let state = await loadBoardState(context);
    const earlier = await controller.preview("file-examples", undefined, {
        title: "Earlier planning selection - invented example", promptMode: "none", formats: ["html"], timeContext,
    }, { kind: "selected", revision: state.revision, scenarioIds: records.slice(0, 2).map(record => record.scenarioId) });
    await controller.review("file-examples", earlier.previewId, true, timeContext);
    const first = (await controller.confirm("file-examples", earlier.previewId, true, timeContext)).bundle;
    state = await loadBoardState(context);
    const activity = await controller.preview("file-examples", undefined, {
        title: "Planning activity - invented example", promptMode: "masked", formats, timeContext,
    }, { kind: "all", revision: state.revision });
    await controller.review("file-examples", activity.previewId, true, timeContext);
    const savedActivity = (await controller.confirm("file-examples", activity.previewId, true, timeContext)).bundle;
    state = await loadBoardState(context);
    const pair = buildPeriodComparison(state, { ...input, expectedRevision: state.revision });
    const period = await controller.preview("file-examples", undefined, {
        title: "Planning periods - invented example", promptMode: "masked", formats, timeContext,
    }, undefined, pair);
    await controller.review("file-examples", period.previewId, true, timeContext);
    const savedPeriod = (await controller.confirm("file-examples", period.previewId, true, timeContext)).bundle;
    const comparison = await controller.previewComparison("file-examples", first.bundleId, savedActivity.bundleId,
        { title: "Planning comparison - invented example", formats, timeContext });
    await controller.reviewComparison("file-examples", comparison.previewId, true, timeContext);
    const savedComparison = (await controller.confirmComparison("file-examples", comparison.previewId, true, timeContext)).bundle;
    const before = JSON.stringify(await loadBoardState(context));
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], foreign = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            foreign.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    for (const [name, bundle] of [["activity", savedActivity], ["period-comparison", savedPeriod], ["saved-comparison", savedComparison]]) {
        await page.goto(runtime.url + "#reports?bundle=" + bundle.bundleId);
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await chooseTheme(page, "dark");
        const folder = process.env.WIRE_FILE_READER_PROOFS && path.join(process.env.WIRE_FILE_READER_PROOFS, "generated", name);
        if (folder) await mkdir(folder, { recursive: true });
        for (const format of [...formats, "manifest"]) {
            await selectActivityOption(page, "savedReaderFormat", format);
            const preview = page.locator("#savedReportReader .saved-file-preview");
            if (format === "html") await preview.frameLocator("iframe").getByRole("heading", { level: 1 }).waitFor();
            else if (format === "pdf") await preview.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            else await preview.locator(format === "markdown" ? ".saved-markdown" : ".saved-json-tree").waitFor();
            await page.evaluate(() => document.fonts.ready);
            if (format === "html" && name !== "period-comparison") {
                const numeric = preview.frameLocator("iframe").locator("th.report-numeric,td.report-numeric,.operation-table tr>:not(:first-child)");
                assert.equal(await numeric.evaluateAll(cells => cells.length > 0 && cells.every(cell => getComputedStyle(cell).textAlign === "right")), true);
            }
            await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
            const pending = page.waitForEvent("download");
            await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
            const download = await pending, bytes = await readFile(await download.path());
            assert.deepEqual(bytes, await readFile(bundle.files[download.suggestedFilename()]));
            if (folder) {
                await writeFile(path.join(folder, download.suggestedFilename()), bytes);
                await page.screenshot({ path: path.join(folder, `reader-${format}.png`) });
            }
            if (format === "html") {
                assert.ok(bytes.toString("utf8").includes(brandMark) && bytes.toString("utf8").includes(brandDarkMark),
                    "The generated file retains both exact original brand assets");
                const frame = preview.frameLocator("iframe");
                assert.equal(await frame.locator(".report-brand .brand-logo").evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).length), 1,
                    "Exactly one original wordmark is visible; no duplicate logo is inserted");
                if (name === "activity") assert.equal(await frame.getByText("Not shown for one sample", { exact: true })
                    .evaluate(node => getComputedStyle(node).textAlign), "left", "Text-only timing states align left, not like numeric measurements");
                if (name === "saved-comparison") assert.equal(await frame.locator("td .comparison-meta").evaluateAll(nodes =>
                    nodes.length > 0 && nodes.every(node => getComputedStyle(node).textAlign === "left")), true, "Coverage descriptions align left");
            }
            if (format === "markdown") {
                assert.ok(bytes.toString("utf8").trimEnd().endsWith(PRODUCT_TITLE), "Text-format reports retain the WIRE signature");
                assert.equal(await preview.locator(".saved-report-mark .brand-logo").count(), 2);
                assert.deepEqual(await preview.locator(".saved-report-mark .brand-logo").evaluateAll(nodes =>
                    nodes.filter(node => node.checkVisibility()).map(node => node.dataset.brandTheme)), ["dark"]);
                if (name === "activity") assert.equal(await preview.getByText("Not shown for one sample", { exact: true })
                    .evaluate(node => getComputedStyle(node).textAlign), "left");
                if (name === "saved-comparison") assert.equal(await preview.getByText("Unchanged", { exact: true }).evaluateAll(nodes =>
                    nodes.length > 0 && nodes.every(node => getComputedStyle(node).textAlign === "left")), true);
                if (name === "period-comparison") assert.equal(await preview.getByText("Not measured", { exact: true }).evaluateAll(nodes =>
                    nodes.length > 0 && nodes.every(node => getComputedStyle(node).textAlign === "left")), true);
            }
            if (folder && format === "html") {
                const target = preview.frameLocator("iframe").locator(name === "activity" ? "#timing" : name === "saved-comparison" ? ".comparison-metrics" : "#evidence").first();
                await target.scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(folder, "reader-html-detail.png") });
            }
        }
    }
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    assert.equal(JSON.stringify(await loadBoardState(context)), before, "Reading and downloading never rewrites the saved reports");
});

async function legacyReport(context, title = "Release exercise - recorded requests and follow-up") {
    const bundleId = `export-${randomUUID()}`, bundleDir = path.join(context.dataDir, "exports", bundleId, "files");
    const formats = ["html", "pdf", "json", "markdown"], preparedAt = "2026-10-12T12:00:00.000Z";
    const snapshot = { schemaVersion: 3, bundleId, preparedAt, promptMode: "none", formats, records: [] };
    const content = {
        "product-report.html": "<!doctype html><html lang=\"en\"><title>Archived exercise</title><body><h1>Archived exercise</h1><p>INVENTED_LEGACY_ORIGINAL</p></body></html>",
        "product-report.pdf": await renderPdf('<!doctype html><html><body><h1>Archived exercise</h1><p>INVENTED_LEGACY_ORIGINAL</p><p style="break-before:page">Second archived page</p></body></html>'),
        "product-report.json": JSON.stringify(snapshot),
        "product-report.md": "# Archived exercise\n\nINVENTED_LEGACY_ORIGINAL\n\n[Recorded calls](#calls)\n\n<a id=\"calls\"></a>\n## Recorded calls\n\n| Call | Result | Duration |\n|---|---|---:|\n"
            + Array.from({ length: 30 }, (_, index) => `| workiq-fetch ${index + 1} | ${index % 5 ? "Worked" : "Tool failed"} | ${(index + 1) * 100} ms |`).join("\n") + "\n",
    };
    const manifest = {
        schemaVersion: 3, bundleId, preparedAt, promptMode: "none", formats,
        snapshotHash: reportHash(JSON.stringify(snapshot)), privacyReview: { reviewerConfirmed: true },
        files: Object.fromEntries(Object.entries(content).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: reportHash(text) }])),
    };
    content["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest);
    await mkdir(bundleDir, { recursive: true });
    for (const [name, text] of Object.entries(content)) await writeFile(path.join(bundleDir, name), text);
    const entry = {
        bundleId, kind: "report", title, preparedAt, formats, promptMode: "none", bundleDir,
        privacyReview: { reviewerConfirmed: true },
        files: Object.fromEntries(Object.keys(content).map(name => [name, path.join(bundleDir, name)])),
        selectionScope: { kind: "selected", requestGroups: 3 },
    };
    await updateBoardState(context, state => { state.exports.push(entry); });
    return { entry, content, manifest };
}

test("explicit legacy-original reading recognizes the supported unanchored v3 format without certifying it", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-original")]);
    const { entry, content } = await legacyReport(context);
    const state = await loadBoardState(context), before = JSON.stringify(state);
    const result = await reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html");
    assert.equal(result.source, "legacy-original");
    assert.equal(result.verification, "unverified");
    assert.equal(result.artifact.bundleId, entry.bundleId);
    assert.equal(result.artifact.title, entry.title);
    assert.equal(result.currentDigest, reportHash(content["product-report.html"]));
    assert.equal(result.bytes.toString("utf8"), content["product-report.html"]);
    assert.equal(result.manifestHash, undefined);
    assert.equal(result.artifact.comparisonEligibility, undefined);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    for (const [name, text] of Object.entries(content)) assert.deepEqual(await readFile(entry.files[name]), Buffer.from(text));
    await assert.rejects(readSavedReportDocument(context, state, entry.bundleId), /saved disclosure approval cannot be verified/);
});

test("legacy-original eligibility rejects partial, malformed, false and mismatched verification", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-eligibility")]);
    const { entry, content, manifest } = await legacyReport(context);
    const state = await loadBoardState(context);
    for (const change of [
        value => { value.manifestHash = null; },
        value => { value.manifestHash = "a".repeat(64); },
        value => { value.snapshotHash = "a".repeat(64); },
        value => { value.evaluationFactsHash = "a".repeat(64); },
        value => { value.reportType = "period-comparison"; },
        value => { value.privacyReview.reviewerConfirmed = false; },
        value => { value.privacyReview.reviewerConfirmed = "true"; },
        value => { value.privacyReview.reviewedAt = null; },
        value => { value.privacyReview.reviewedAt = "2026-10-12T12:00:00.000Z"; },
        value => { value.privacyReview = null; },
        value => { value.formats = ["html", "html"]; },
    ]) {
        const altered = structuredClone(state);
        change(altered.exports.find(value => value.bundleId === entry.bundleId));
        await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, altered, entry.bundleId, "report", "html"));
    }
    const metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    for (const change of [
        value => { value.kind = "report"; },
        value => { value.kind = "comparison"; },
        value => { value.bundleId = `export-${randomUUID()}`; },
        value => { value.schemaVersion = 2; },
        value => { value.snapshotHash = "not-a-hash"; },
        value => { value.privacyReview.reviewerConfirmed = false; },
        value => { value.privacyReview = { reviewerConfirmed: "true" }; },
        value => { value.privacyReview.reviewedAt = null; },
        value => { value.privacyReview.reviewedAt = "2026-10-12T12:00:00.000Z"; },
        value => { value.evaluationFacts = {}; },
        value => { value.sourceReports = []; },
        value => { value.fileHashes = {}; },
        value => { value.files["product-report.html"].bytes = "42"; },
        value => { value.files["product-report.html"].sha256 = "not-a-hash"; },
        value => { value.files["product-report.html"].sha256 = "0".repeat(64); },
        value => { value.files["product-report.html"].extra = true; },
        value => { delete value.files["product-report.html"]; },
    ]) {
        const altered = structuredClone(manifest);
        change(altered);
        await writeFile(metadataFile, JSON.stringify(altered));
        await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html"));
    }
    await writeFile(metadataFile, content["coverage-and-redaction-manifest.json"]);
    assert.equal((await reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "html")).verification, "unverified");
    for (const [name, text] of Object.entries(content)) assert.deepEqual(await readFile(entry.files[name]), Buffer.from(text));
});

test("legacy-original reads keep managed ownership, link, size, encoding and current-identity fences", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-file-guards")]);
    const { entry, content, manifest } = await legacyReport(context), state = await loadBoardState(context);
    const read = value => reportArtifacts.readLegacyReportOriginal(context, value, entry.bundleId, "report", "html");
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, `export-${randomUUID()}`, "report", "html"), /no longer available/);
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "comparison", "html"), /legacy report/);
    await assert.rejects(reportArtifacts.readLegacyReportOriginal(context, state, entry.bundleId, "report", "../html"), /Choose an HTML/);
    const deleted = structuredClone(state);
    deleted.artifactDeletion = { identities: [artifactDeletionKey("report", entry.bundleId)] };
    await assert.rejects(read(deleted), /no longer available/);
    const foreign = structuredClone(state);
    foreign.exports[0].files["product-report.html"] = path.join(context.dataDir, "outside.html");
    await assert.rejects(read(foreign), /outside its registered bundle/);
    const held = read(state);
    state.exports[0].title = "Changed while reading";
    await assert.rejects(held, /changed during this read/);
    state.exports[0].title = entry.title;
    const result = await read(state), replaced = structuredClone(state);
    replaced.exports[0].title = "Later indexed identity";
    assert.throws(() => reportArtifacts.assertLegacyReportOriginalCurrent(replaced, result.binding), /changed during this read/);
    const file = entry.files["product-report.html"], metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    await truncate(file, reportArtifacts.SAVED_REPORT_MAX_BYTES + 1);
    await assert.rejects(read(state), /too large/);
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xff]));
    const invalidText = structuredClone(manifest);
    invalidText.files["product-report.html"] = { bytes: 3, sha256: reportHash(Buffer.from([0xff, 0xfe, 0xff])) };
    await writeFile(metadataFile, JSON.stringify(invalidText));
    await assert.rejects(read(state), /not valid UTF-8/);
    await writeFile(file, content["product-report.html"]);
    await writeFile(metadataFile, content["coverage-and-redaction-manifest.json"]);
    const parked = entry.bundleDir + "-original";
    await rename(entry.bundleDir, parked);
    try {
        await symlink(parked, entry.bundleDir, process.platform === "win32" ? "junction" : "dir");
        try { await assert.rejects(read(state), /Linked report folders/); }
        finally { await unlink(entry.bundleDir); }
    } finally { await rename(parked, entry.bundleDir); }
    for (const [name, text] of Object.entries(content)) assert.deepEqual(await readFile(entry.files[name]), Buffer.from(text));
    assert.equal((await read(state)).verification, "unverified");
});

test("the explicit legacy-original endpoint is capability-gated, closed and read-only", async t => {
    const { context } = await privateFixture(t, [fixture("legacy-api")]);
    const { entry, content } = await legacyReport(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    t.after(() => runtime.close());
    const origin = new URL(runtime.url).origin;
    const post = (route, body, capability, requestOrigin = origin) => fetch(origin + route, {
        method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json", "X-Wire-Session-Protocol": "1",
            ...(capability ? { "X-Board-Capability": capability } : {}) }, body: JSON.stringify(body),
    });
    const input = { bundleId: entry.bundleId, kind: "report", format: "html" };
    assert.equal((await post("/api/report-original", input)).status, 403);
    const { capability } = await (await post("/api/session", {})).json();
    assert.equal((await post("/api/report-original", input, "a".repeat(64))).status, 403);
    assert.equal((await post("/api/report-original", input, capability, "https://foreign.example.invalid")).status, 403);
    const before = JSON.stringify(await loadBoardState(context));
    for (const format of ["html", "json", "markdown", "pdf"]) {
        const response = await post("/api/report-original", { ...input, format }, capability);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.source, "legacy-original");
        assert.equal(result.verification, "unverified");
        assert.equal(result.currentDigest, reportHash(Buffer.from(result.data, "base64")));
        assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(content[result.name]));
        assert.equal(result.binding, undefined);
        assert.equal(result.manifestHash, undefined);
        assert.equal(result.artifact.comparisonEligibility, undefined);
    }
    for (const [change, status] of [[{ bundleId: `export-${randomUUID()}` }, 404], [{ kind: "comparison" }, 422],
        [{ format: "manifest" }, 422], [{ path: entry.files["product-report.html"] }, 400]]) {
        assert.equal((await post("/api/report-original", { ...input, ...change }, capability)).status, status);
    }
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    for (const [name, text] of Object.entries(content)) assert.deepEqual(await readFile(entry.files[name]), Buffer.from(text));
});

test("a legacy report opens or downloads directly from its warned sidebar without inventing disclosure", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("legacy-report-view")]);
    const { entry, content } = await legacyReport(context);
    const { title } = entry, file = entry.files["product-report.html"], original = content["product-report.html"];
    const before = JSON.stringify(await loadBoardState(context));
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const reads = [];
    page.on("request", request => { if (request.method() === "POST") reads.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(await page.locator(".saved-report-name").textContent(), title);
    await page.locator(".saved-report-summary").click();
    assert.equal(await page.locator("#contextSidebarTitle").textContent(), title);
    await page.locator("#savedOriginalNotice").waitFor();
    assert.equal(await page.locator("#savedReportReader").isVisible(), false, "File choice stays in the sidebar, not an intermediate page");
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.equal(reads.includes("/api/report-original"), false, "Opening indexed details never reads an original");
    assert.equal(reads.includes("/api/report/open"), false, "The known unverified original is not presented as a verified read");
    for (const [theme, width, scale] of [["light", 1440, 100], ["dark", 390, 200]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = scale + "%"; }, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
            .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
        assert.equal(await page.locator("#savedReportReader").isVisible(), false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const target = await page.getByRole("button", { name: "Open original file", exact: true }).boundingBox();
        assert.ok(target.width >= 44 && target.height >= 44 && target.x >= 0 && target.x + target.width <= width + 1);
        assert.match(await page.locator("#savedOriginalNotice").textContent(), /can't confirm the privacy review/);
        assert.match(await page.locator("#savedOriginalNotice").textContent(), /does not judge report accuracy or account identity/);
        assert.equal(await page.getByRole("button", { name: "Open original file", exact: true }).getAttribute("aria-describedby"), "savedOriginalNotice");
        const placement = await page.locator("#contextSidebar").evaluate(node => {
            const controls = node.querySelector(".original-file-controls"), note = node.querySelector("#savedOriginalNotice");
            return { sameInspector: note.closest("#contextSidebar") === node,
                noticeFirst: Boolean(note.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
                noteBottom: note.getBoundingClientRect().bottom, rowTop: controls.getBoundingClientRect().top };
        });
        assert.ok(placement.sameInspector && placement.noticeFirst, "The historical privacy notice precedes the explicit Open action in the same inspector");
        if (width > 700) assert.ok(placement.rowTop >= placement.noteBottom);
        if (process.env.WIRE_LEGACY_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_LEGACY_REPORT_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, `legacy-sidebar-${theme}.png`) });
        }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    if (process.env.WIRE_LEGACY_REPORT_PROOFS) {
        await page.waitForFunction(() => [...document.querySelectorAll("#main,#sidebar,#contextSidebar")]
            .every(node => node.getAnimations({ subtree: true }).every(animation => animation.playState !== "running")));
        await page.screenshot({ path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, "legacy-sidebar-ready.png") });
        await page.locator(".saved-inspector-actions").screenshot({ path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, "file-actions-ready.png") });
    }
    await page.getByRole("button", { name: "Open original file", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").getByText("INVENTED_LEGACY_ORIGINAL", { exact: true }).waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    const sharing = page.getByRole("button", { name: "Before sharing", exact: true });
    await sharing.click();
    const notice = page.getByRole("dialog", { name: "Before you share this file", exact: true });
    assert.match(await notice.innerText(), /Check that its contents are appropriate to share/);
    assert.match(await notice.innerText(), /does not mean the report is inaccurate, your account is unverified, or the file is damaged/);
    if (process.env.WIRE_LEGACY_REPORT_PROOFS) await page.screenshot({
        path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, "before-sharing.png"),
    });
    await notice.getByRole("button", { name: "Got it", exact: true }).click();
    assert.equal(reads.filter(route => route === "/api/report-original").length, 1);
    if (process.env.WIRE_LEGACY_REPORT_PROOFS) {
        await mkdir(process.env.WIRE_LEGACY_REPORT_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_LEGACY_REPORT_PROOFS, "legacy-open.png"), fullPage: true });
    }
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), title);
    assert.equal(await page.locator("#main").getByRole("heading", { name: title, exact: true }).count(), 1);
    for (const format of ["markdown", "json", "pdf", "html"]) {
        await selectActivityOption(page, "savedReaderFormat", format);
        const preview = page.locator("#savedReportReader .saved-file-preview");
        if (format === "html") await preview.frameLocator("iframe").locator("h1").waitFor();
        else if (format === "pdf") await preview.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else await preview.locator(format === "markdown" ? ".saved-markdown table" : ".saved-json-tree").waitFor();
        assert.equal(await sharing.isVisible(), true);
        if (process.env.WIRE_FILE_READER_PROOFS) {
            await mkdir(process.env.WIRE_FILE_READER_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_FILE_READER_PROOFS, `legacy-${format}.png`) });
        }
        const download = page.waitForEvent("download");
        await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
        const item = await download;
        assert.deepEqual(await readFile(await item.path()), Buffer.from(content[item.suggestedFilename()]));
    }
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await selectActivityOption(page, "savedOriginalFormat", "pdf");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download original PDF", exact: true }).click();
    const downloaded = await downloading;
    assert.equal(downloaded.suggestedFilename(), "product-report.pdf");
    assert.deepEqual(await readFile(await downloaded.path()), content["product-report.pdf"]);
    assert.equal(await page.locator("#savedReportReader").isVisible(), false);
    assert.equal(await page.locator("#contextSidebar").isVisible(), true);
    let lateDownloads = 0;
    page.on("download", () => lateDownloads++);
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/report-original", async route => {
        const response = await route.fetch(); pending.resolve();
        await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const completed = page.waitForResponse(response => response.url().endsWith("/api/report-original"));
    await page.getByRole("button", { name: "Download original PDF", exact: true }).click();
    await pending.promise;
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    release.resolve(); await (await completed).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(lateDownloads, 0, "Closing the sidebar retires its pending original download");
    const originalReads = reads.filter(route => route === "/api/report-original").length;
    await page.goto(runtime.url + "#reports?bundle=" + entry.bundleId);
    await page.locator("#contextSidebar[open]").waitFor();
    assert.equal(await page.locator("#savedReportReader").isVisible(), false, "Old reader links land on the same sidebar file choice");
    assert.equal(reads.filter(route => route === "/api/report-original").length, originalReads);
    await page.getByRole("button", { name: "Close saved report details", exact: true }).click();
    await page.locator("#contextSidebar[open]").waitFor({ state: "hidden" });
    assert.doesNotMatch(page.url(), /bundle=|inspect=/);
});

test("legacy original HTML is inert and late original reads cannot survive Back or changed indexed identity", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [fixture("legacy-inert")]);
    const { entry, manifest } = await legacyReport(context);
    const html = '<!doctype html><html><body><h1>Original archive</h1><p>ORIGINAL_VISIBLE_CANARY</p><script>parent.legacyRan=true</script><img src="https://foreign.example.invalid/image"><a href="https://foreign.example.invalid/leave">External</a><iframe src="https://foreign.example.invalid/frame"></iframe><form action="https://foreign.example.invalid/form"><button>Submit</button></form></body></html>';
    const markdown = '# Original Markdown\n\nMARKDOWN_VISIBLE_CANARY\n\n<a id="pageTitle"></a>\n[Local section](#pageTitle)\n\n| Operation | Calls |\n|---|---:|\n| Fetch | 2 |\n\n<script>parent.legacyRan=true</script><img src="https://foreign.example.invalid/markdown"><a href="javascript:alert(1)">No active link</a><svg class="brand-logo" data-untrusted-logo="true"><script>parent.legacyRan=true</script></svg>';
    const json = (await readFile(entry.files["product-report.json"], "utf8")).replace(/}$/, ',"preciseInteger":9007199254740993,"negativeZero":-0}');
    const metadataFile = entry.files["coverage-and-redaction-manifest.json"];
    manifest.files["product-report.html"] = { bytes: Buffer.byteLength(html), sha256: reportHash(html) };
    manifest.files["product-report.md"] = { bytes: Buffer.byteLength(markdown), sha256: reportHash(markdown) };
    manifest.files["product-report.json"] = { bytes: Buffer.byteLength(json), sha256: reportHash(json) };
    manifest.snapshotHash = reportHash(json);
    const metadata = JSON.stringify(manifest);
    await writeFile(entry.files["product-report.html"], html); await writeFile(metadataFile, metadata);
    await writeFile(entry.files["product-report.md"], markdown);
    await writeFile(entry.files["product-report.json"], json);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const external = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            external.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#reports"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    const open = page.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    const view = page.getByRole("button", { name: "Open original file", exact: true });
    await view.click();
    const frame = page.frameLocator("#savedReportReader iframe");
    await frame.getByText("ORIGINAL_VISIBLE_CANARY", { exact: true }).waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator("script,iframe,object,embed,base").count(), 0);
    assert.equal(await frame.locator("a[href]").count(), 0);
    assert.match(await frame.locator('meta[http-equiv="Content-Security-Policy"]').first().getAttribute("content"), /default-src 'none'.*form-action 'none'/);
    const location = page.url();
    await frame.getByRole("button", { name: "Submit", exact: true }).click();
    assert.equal(page.url(), location);
    await frame.getByText("ORIGINAL_VISIBLE_CANARY", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.legacyRan), undefined);
    assert.deepEqual(external, []);
    await selectActivityOption(page, "savedReaderFormat", "markdown");
    const rendered = page.locator(".saved-markdown");
    await rendered.locator("table").waitFor();
    assert.match(await rendered.textContent(), /MARKDOWN_VISIBLE_CANARY/);
    assert.equal(await rendered.locator("script,img,iframe,form,input").count(), 0);
    assert.equal(await rendered.locator("[data-untrusted-logo]").count(), 0, "File-provided SVG is still removed, even when styled as a logo");
    assert.equal(await rendered.locator("svg").count(), 2);
    assert.equal(await rendered.locator(".saved-report-mark > svg.brand-logo").count(), 2, "Only WIRE's two trusted theme assets enter the Markdown view");
    assert.equal(await rendered.locator('a[href]:not([href^="#saved-markdown-"])').count(), 0);
    assert.equal(await page.locator("#pageTitle").count(), 1, "Document anchors cannot shadow app controls");
    const oldText = await rendered.getByText("MARKDOWN_VISIBLE_CANARY", { exact: true }).evaluateHandle(node => node.firstChild);
    await selectActivityOption(page, "savedReaderFormat", "json");
    await page.locator(".saved-json-tree").waitFor();
    assert.equal(await page.locator(".saved-json-scalar").filter({ hasText: /^9007199254740993$/ }).count(), 1);
    assert.equal(await page.locator(".saved-json-scalar").filter({ hasText: /^-0$/ }).count(), 1);
    assert.equal(await oldText.evaluate(node => node.data), "", "Retired rich-text nodes are scrubbed, not just detached");
    assert.equal(await page.evaluate(() => window.legacyRan), undefined);
    assert.deepEqual(external, []);
    async function holdRead() {
        if (await page.locator("#savedReportReader").isVisible())
            await page.getByRole("button", { name: "Back to report library", exact: true }).click();
        const pending = Promise.withResolvers(), release = Promise.withResolvers(), delivered = Promise.withResolvers();
        t.after(() => release.resolve());
        await page.route("**/api/report-original", async route => {
            const response = await route.fetch(); pending.resolve();
            await release.promise; await route.fulfill({ response }); delivered.resolve();
        }, { times: 1 });
        await view.click(); await pending.promise;
        return { release: () => release.resolve(), delivered: delivered.promise };
    }
    const backRead = await holdRead();
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    backRead.release(); await backRead.delivered;
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.equal(await page.locator("#contextSidebar").isVisible(), true);
    await view.waitFor();
    const changedRead = await holdRead();
    await updateBoardState(context, state => { state.exports[0].title = "Changed archive identity"; });
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refreshed; await page.locator('#workspace[aria-busy="false"]').waitFor();
    changedRead.release(); await changedRead.delivered;
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0);
    assert.match(await page.locator("#savedReportReader").textContent(), /changed|no longer available/);
    await page.getByRole("button", { name: "Back to report library", exact: true }).click();
    await view.waitFor();
    const metadataRead = await holdRead();
    await updateBoardState(context, state => { state.exports[0].preparedAtDisplay = "Changed preparation label"; });
    const metadataRefresh = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await metadataRefresh; await page.locator('#workspace[aria-busy="false"]').waitFor();
    metadataRead.release(); await metadataRead.delivered;
    await page.locator("#savedReportReader .error").waitFor();
    assert.equal(await page.locator("#savedReportReader iframe").count(), 0, "Metadata-only index changes also fence a late original");
    assert.equal(await readFile(entry.files["product-report.html"], "utf8"), html);
    assert.equal(await readFile(metadataFile, "utf8"), metadata);
    assert.equal((await loadBoardState(context)).exports[0].manifestHash, undefined);
    assert.deepEqual(external, []);
});

test("saved HTML reader verifies exact bytes, registered ownership, disclosure, integrity and availability", async t => {
    const { context } = await privateFixture(t), exports = createExportController(context), bundle = await save(exports, context);
    let state = await loadBoardState(context);
    const bytes = await readFile(bundle.files["product-report.html"]), before = JSON.stringify(state);
    const value = await readSavedReportDocument(context, state, bundle.bundleId);
    assert.equal(value.html, bytes.toString("utf8")); assert.equal(value.sha256, reportHash(bytes));
    assert.equal(JSON.stringify(await loadBoardState(context)), before);
    const noHtml = await save(exports, context, ["json"]);
    state = await loadBoardState(context);
    await assert.rejects(readSavedReportDocument(context, state, noHtml.bundleId), /HTML was not saved/);
    await assert.rejects(readSavedReportDocument(context, { ...state, exports: [] }, bundle.bundleId), /no longer available/);
    const forged = structuredClone(state), entry = forged.exports.find(item => item.bundleId === bundle.bundleId);
    entry.files["product-report.html"] = path.join(context.dataDir, "outside.html");
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /outside its registered bundle/);
    entry.files["product-report.html"] = bundle.files["product-report.html"]; entry.kind = "comparison";
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /no longer available/);
    entry.kind = "report"; entry.privacyReview.reviewerConfirmed = false;
    await assert.rejects(readSavedReportDocument(context, forged, bundle.bundleId), /disclosure approval cannot be verified/);
    await writeFile(bundle.files["product-report.html"], bytes + "\nchanged");
    await assert.rejects(readSavedReportDocument(context, state, bundle.bundleId), /HTML changed/);
    await writeFile(bundle.files["product-report.html"], bytes);
    const linkedState = structuredClone(state), linkedEntry = linkedState.exports.find(item => item.bundleId === bundle.bundleId);
    const linkedDir = path.join(context.dataDir, "reader-junction"), targetDir = path.join(context.dataDir, "reader-target");
    await mkdir(targetDir); await symlink(targetDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    linkedEntry.bundleDir = linkedDir; linkedEntry.files["product-report.html"] = path.join(linkedDir, "product-report.html");
    await assert.rejects(readSavedReportDocument(context, linkedState, bundle.bundleId), /outside its registered bundle/);
    assert.deepEqual(await readFile(bundle.files["product-report.html"]), bytes);
});

test("saved HTML open is capability-gated, inert, draft-preserving and fences closed or replaced reads", { timeout: 45000 }, async t => {
    const { context } = await privateFixture(t, [fixture("reader")]), exports = createExportController(context);
    const first = await save(exports, context), second = await save(exports, context), missing = await save(exports, context, ["json"]);
    const firstHtml = await readFile(first.files["product-report.html"], "utf8");
    const malicious = firstHtml.replace("</body>", '<h2>Historical Cost</h2><p>FROZEN_LEGACY_VALUE</p><img src="https://outside.invalid/image"><a href="https://outside.invalid/leave">External link</a><meta http-equiv="refresh" content="0;url=https://outside.invalid/refresh"><script>parent.readerExecuted=true</script></body>');
    await writeFile(first.files["product-report.html"], malicious);
    const manifestPath = first.files["coverage-and-redaction-manifest.json"], manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files["product-report.html"] = { sha256: reportHash(malicious), bytes: Buffer.byteLength(malicious) };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(manifestPath, manifestBytes);
    await updateBoardState(context, state => { state.exports.find(entry => entry.bundleId === first.bundleId).manifestHash = reportHash(manifestBytes); });
    const frozen = await Promise.all(Object.values(first.files).map(file => readFile(file)));
    const runtime = await startServer(context, exports, { port: 0, collector: { timers: false } }), browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const origin = runtime.url.slice(0, -1);
    const rejected = await fetch(origin + "/api/report/open", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ bundleId: first.bundleId }) });
    assert.equal(rejected.status, 403);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, colorScheme: "dark" }), external = [], writes = [], frameDocuments = [];
    page.setDefaultTimeout(10000);
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
    });
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
    page.on("request", request => { if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) frameDocuments.push(request.url()); });
    await page.goto(runtime.url + "#reports");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await chooseReportScope(page, "all"); await reportContents(page); await page.locator("[name=promptMode][value=none]").check();
    const draft = await scanReport(page);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    await openReportLibrary(page);
    const rowFor = id => page.locator(`[data-bundle-id="${id}"]`);
    const firstRow = rowFor(first.bundleId), secondRow = rowFor(second.bundleId);
    const open = firstRow.getByRole("button", { name: "Open saved report", exact: true });
    await open.click();
    const dialog = page.locator("#savedReportReader");
    assert.equal(await page.locator("#pageTitle").textContent(), first.title);
    await page.waitForFunction(() => document.querySelector("#savedReportReader iframe,#savedReportReader .error"));
    assert.equal(await dialog.locator("iframe").count(), 1, await dialog.innerText());
    await dialog.locator("iframe").waitFor();
    const frame = dialog.frameLocator("iframe");
    await frame.getByText("FROZEN_LEGACY_VALUE", { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /Report ID:/, "Full identifiers remain in library details rather than competing with the saved document");
    assert.equal(await dialog.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(await frame.locator('a[href]:not([href^="about:srcdoc#"])').count(), 0);
    assert.equal(await frame.locator("html").getAttribute("data-evidence-theme"), "light", "The frozen theme survives an OS-dark reader.");
    assert.equal(await frame.locator("html").getAttribute("lang"), "en");
    assert.equal(await frame.locator("script,base,iframe,meta[http-equiv=refresh]").count(), 0);
    await frame.getByText("External link", { exact: true }).click();
    assert.equal(new URL(page.url()).hash.split("?")[0], "#reports");
    const coverage = frame.getByRole("link", { name: "Coverage", exact: true });
    await coverage.click();
    await frame.locator("#coverage").waitFor({ state: "visible" });
    assert.match(await frame.locator("body").innerText(), /FROZEN_LEGACY_VALUE/);
    assert.ok(await frame.locator("#coverage").evaluate(node => Math.abs(node.getBoundingClientRect().top) < innerHeight));
    assert.deepEqual(frameDocuments, [], "Section links stay in the frozen document, never loading the app shell.");
    assert.equal(await page.evaluate(() => window.readerExecuted), undefined);
    assert.deepEqual(external, []);
    if (process.env.WIRE_QUALITY_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_QUALITY_PROOFS, "saved-report-reader-light.png") });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.evaluate(() => document.fonts.ready);
    const beforeHeaderSync = await page.evaluate(() => ({
        configured: parseFloat(document.documentElement.style.getPropertyValue("--app-header-height")),
        measured: Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height),
        readingBottom: document.querySelector("#savedReportReader .saved-file-preview").getBoundingClientRect().bottom,
    }));
    await page.waitForFunction(() => parseFloat(document.documentElement.style.getPropertyValue("--app-header-height"))
        === Math.ceil(document.querySelector(".app-header").getBoundingClientRect().height));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const headerLayout = await dialog.locator(".saved-reader-heading").evaluate(header => {
        const title = document.getElementById("pageTitle"), close = header.querySelector("button");
        const bounds = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const range = document.createRange();
        range.selectNodeContents(title);
        return {
            header: bounds(header), title: bounds(title), close: bounds(close),
            reading: bounds(document.querySelector("#savedReportReader .saved-file-preview")),
            toolbar: bounds(document.querySelector("#savedReportReader .document-file-toolbar")),
            modes: [...document.querySelectorAll("#savedReportReader .document-file-modes button")].map(button => {
                const box = button.getBoundingClientRect(), label = document.createRange(); label.selectNodeContents(button);
                return { label: button.textContent, bounds: bounds(button), text: bounds(label),
                    fontSize: getComputedStyle(button).fontSize,
                    hit: [box.left + 4, box.right - 4].every(x => button.contains(document.elementFromPoint(x, box.top + box.height / 2))) };
            }),
            titleLines: range.getClientRects().length,
            wordLines: [...title.textContent.matchAll(/\S+/g)].map(match => {
                const word = document.createRange();
                word.setStart(title.firstChild, match.index); word.setEnd(title.firstChild, match.index + match[0].length);
                return word.getClientRects().length;
            }),
            overflow: header.scrollWidth > header.clientWidth + 1,
        };
    });
    if (beforeHeaderSync.configured !== beforeHeaderSync.measured || beforeHeaderSync.readingBottom > 1000)
        t.diagnostic(`Header observer settled: ${JSON.stringify(beforeHeaderSync)}; final reading bottom ${headerLayout.reading.bottom}`);
    if (process.env.WIRE_READER_HEADER_PROOFS) {
        await mkdir(process.env.WIRE_READER_HEADER_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-375-200.png") });
        await writeFile(path.join(process.env.WIRE_READER_HEADER_PROOFS, "reader-header-layout.json"), JSON.stringify(headerLayout, null, 2));
    }
    assert.ok(headerLayout.wordLines.every(lines => lines === 1), `Saved report must wrap by words, not characters: ${JSON.stringify(headerLayout)}`);
    assert.ok(headerLayout.reading.height >= 200 && headerLayout.reading.bottom <= 1000,
        `The prominent report identity leaves a useful document viewport: ${JSON.stringify(headerLayout)}`);
    assert.ok(headerLayout.title.width >= 100 && headerLayout.close.width >= 44);
    assert.equal(headerLayout.overflow, false);
    assert.ok(headerLayout.modes.every(mode => mode.bounds.x >= headerLayout.toolbar.x && mode.bounds.right <= headerLayout.toolbar.right
        && mode.bounds.y >= headerLayout.toolbar.y && mode.bounds.bottom <= headerLayout.toolbar.bottom
        && mode.text.x >= mode.bounds.x && mode.text.right <= mode.bounds.right && mode.hit),
        `Preview and Source remain fully readable and clickable at 375px / 200%: ${JSON.stringify(headerLayout)}`);
    assert.ok(headerLayout.close.height >= 44 && headerLayout.close.x >= 0 && headerLayout.close.right <= 375);
    assert.ok(headerLayout.close.y >= 0 && headerLayout.close.bottom <= 1000);
    const keyboardClose = dialog.getByRole("button", { name: "Back to report library", exact: true });
    await keyboardClose.focus();
    assert.equal(await keyboardClose.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await open.click();
    await dialog.locator("iframe").waitFor();
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await open.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-phase"), "reviewed");
    assert.equal(await page.locator(".attestation input[data-review-control]").isChecked(), true);
    assert.equal(writes.filter(route => route === "/api/preview").length, 1);
    assert.equal(writes.includes("/api/export"), false);
    const read = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/report/open", async route => {
        if (route.request().postDataJSON().bundleId !== first.bundleId) return route.continue();
        const response = await route.fetch(); read.resolve(); await release.promise; await route.fulfill({ response });
    });
    await open.click(); await read.promise;
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    await secondRow.getByRole("button", { name: "Open saved report", exact: true }).click();
    await dialog.locator("iframe").waitFor();
    const staleResponse = page.waitForResponse(response => response.url().endsWith("/api/report/open")
        && response.request().postDataJSON().bundleId === first.bundleId);
    release.resolve(); await (await staleResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.match(await dialog.frameLocator("iframe").locator("body").textContent(), new RegExp(second.bundleId));
    assert.equal(await dialog.frameLocator("iframe").getByText("FROZEN_LEGACY_VALUE", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Back to report library", exact: true }).click();
    const missingRow = rowFor(missing.bundleId); await missingRow.locator(".saved-report-summary").click();
    assert.equal(await missingRow.getByRole("button", { name: "Open saved report", exact: true }).count(), 1);
    await page.locator("#contextSidebarFooter").getByRole("button", { name: "Open saved report", exact: true }).click();
    await dialog.locator(".saved-json-tree").waitFor();
    assert.ok((await dialog.locator(".saved-json-tree").textContent()).includes(missing.bundleId));
    assert.deepEqual(await Promise.all(Object.values(first.files).map(file => readFile(file))), frozen);
    assert.equal((await loadBoardState(context)).exports.length, 3);
    assert.ok(draft.previewId);
});
