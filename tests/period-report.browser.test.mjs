import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { readSavedReportFile, loadSavedReportSource, createSavedArtifactDescriptor } from "../lib/report-artifacts.mjs";
import { extractReportFile } from "../lib/search-corpus-report-content.mjs";
import { periodFixture, periodQuery } from "./period-comparison-fixture.mjs";
import { privateFixture, chooseTheme, restoreLegacySearch } from "./helpers.mjs";
import { qualityDisplayFixture } from "./quality-display-fixtures.mjs";
import { assessmentSource } from "../lib/assessment-read-model.mjs";
import { reportContents } from "./report-journey-helpers.mjs";

for (const lostSaveResponse of [false, true]) test(`normal paired report, all formats and frozen reopen${lostSaveResponse ? " after lost save response" : ""}`, { timeout: 120000 }, async t => {
    const fixture = periodFixture();
    fixture.records[0].toolCalls.find(call => call.toolCallId === "period-calendar").requestArgs = { entityUrls: ["/me/calendarView"] };
    const assessed = qualityDisplayFixture({ records: fixture.records, judgments: ["pass", "fail", "pass", "unassessed", "error"], finalDuration: null }).state;
    const { context } = await privateFixture(t, fixture.records);
    const config = { schemaVersion: 1, approved: true, enabled: false, windowDays: 30, pollSeconds: 5,
        sourceAdapter: "copilot-app-sqlite-v156", appDbPath: path.join(context.dataDir, "invented-only.db"),
        sessionRoot: path.join(context.dataDir, "invented-only-events") };
    await mkdir(path.join(context.dataDir, "collector"), { recursive: true });
    await writeFile(path.join(context.dataDir, "collector", "config.json"), JSON.stringify(config));
    await updateBoardState(context, state => {
        state.pseudonymKey = assessed.pseudonymKey;
        state.personalEvaluation = assessed.personalEvaluation;
        const source = assessmentSource(state, config);
        // Deliberately stale persisted source; the current collector source owns admission.
        state.personalEvaluation.source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
        for (const grant of state.personalEvaluation.modelEvaluation.grants) {
            grant.sourceConfigRef = source.sourceConfigRef; grant.sourceConfigRevision = source.sourceConfigRevision;
        }
    });
    const server = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    page.setDefaultTimeout(12000);
    const errors = [], denied = [], requests = [], comparisons = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
        if (response.url().endsWith("/api/period-comparison") && response.ok()) comparisons.push(await response.json());
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/preview", "/api/privacy-review", "/api/export", "/api/cancel-preview", "/api/report/open"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push(url.pathname); return route.continue();
    });
    await page.goto(server.url + "#analyze?services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, periodQuery);
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [
        ["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"],
    ]) await page.getByLabel(label, { exact: true }).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("Exact matching records (3)");
    await expect(page.locator('[data-period-side="later"]')).toContainText("Exact matching records (4)");
    const live = comparisons.at(-1);
    assert.ok(live);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.ok((await page.locator("#createPeriodReport").boundingBox()).height >= 44);
    await page.locator("#createPeriodReport").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#reportStage1")).toBeVisible();
    await expect(page.locator("#periodReportScope")).toContainText("Authors and matching records are fixed");
    await expect(page.locator("#reportPromptAuthorFilter")).toBeDisabled();
    assert.ok((await page.getByRole("button", { name: "Change comparison in Analyze", exact: true }).boundingBox()).height >= 44);
    await expect(page.locator("#reportPopulationNote")).toContainText("Period A: 3 matching records; Period B: 4");
    await reportContents(page);
    await expect(page.locator("#contextSidebarBody #reportStage2")).toBeVisible();
    await expect(page.locator("#reportList input")).toHaveCount(0);
    await page.locator("#reportList .request-link").first().click();
    await expect(page.locator("#requestReportToggle")).toBeHidden();
    await expect(page.locator("#requestReportTitle")).toContainText("fixed paired periods");
    await page.getByRole("button", { name: "Back to report setup", exact: true }).click();
    await expect(page.locator("#contextSidebarBody #reportStage2")).toBeVisible();
    await expect(page.locator("#reportPopulationNote")).toContainText("Period A: 3 matching records; Period B: 4");
    await page.locator("#formatOptions input[value=json]").check();
    await page.locator("#formatOptions input[value=markdown]").check();
    await page.locator("#formatOptions input[value=pdf]").check();
    assert.deepEqual(errors, []);
    await expect(page.locator("#exportBtn")).toBeEnabled();
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"), { timeout: 60000 });
    await page.locator("#exportBtn").click();
    const preview = await (await previewResponse).json();
    assert.equal(preview.error, undefined, preview.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    assert.deepEqual(preview.snapshot.periodComparison.comparison, live.comparison);
    assert.ok(live.comparison.metrics.some(item => (item.baseline ?? item.later).basis === "model-assessment"), "real fixture lanes remain qualified");
    assert.equal(preview.snapshot.evaluationFacts, undefined);
    const frame = page.frameLocator(".report-frame");
    await expect(frame.getByRole("heading", { name: "What differs", exact: true })).toBeVisible();
    await expect(frame.locator("#baseline")).toContainText("Work IQ sign-in was required");
    await expect(frame.locator("#baseline")).toContainText("synthetic-quality-fixture");
    assert.ok(preview.records.every(record => !record.toolCalls.length));
    const outputPage = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await outputPage.route("**/*", route => { denied.push(route.request().url()); return route.abort(); });
    await outputPage.setContent(preview.previewHtml);
    if (process.env.WIRE_PERIOD_REPORT_PROOFS) {
        await mkdir(process.env.WIRE_PERIOD_REPORT_PROOFS, { recursive: true });
        await outputPage.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "frozen-output-light.png") });
        await outputPage.setViewportSize({ width: 375, height: 950 });
        await outputPage.locator("html").evaluate(node => { node.style.fontSize = "200%"; node.dataset.evidenceTheme = "dark"; });
        await outputPage.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "frozen-output-dark-375-200.png") });
    }
    await outputPage.close();

    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width: 375, height: 950 });
        const zoom = await page.addStyleTag({ content: "html{font-size:200%}" });
        await frame.locator("html").evaluate((node, theme) => { node.style.fontSize = "200%"; node.dataset.evidenceTheme = theme; }, theme);
        const outer = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
            overflow: [...document.querySelectorAll("*")].filter(node => node.checkVisibility() && node.getBoundingClientRect().right > innerWidth + 1)
                .map(node => `${node.tagName}#${node.id}.${node.className}`).slice(0, 20) }));
        assert.ok(outer.scroll <= outer.width + 1, JSON.stringify(outer));
        const inner = await frame.locator("body").evaluate(node => ({ width: node.ownerDocument.documentElement.clientWidth, scroll: node.scrollWidth,
            overflow: [...node.querySelectorAll("*")].filter(item => item.checkVisibility() && item.getBoundingClientRect().right > node.ownerDocument.documentElement.clientWidth + 1)
                .map(item => `${item.tagName}#${item.id}.${item.className}: ${item.getBoundingClientRect().width}`).slice(0, 20),
            internal: [...node.querySelectorAll("*")].filter(item => item.checkVisibility() && item.scrollWidth > item.clientWidth + 1)
                .map(item => `${item.tagName}#${item.id}.${item.className}: ${item.clientWidth}/${item.scrollWidth}`).slice(0, 20) }));
        assert.ok(inner.scroll <= inner.width + 1, JSON.stringify(inner));
        if (process.env.WIRE_PERIOD_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_PERIOD_REPORT_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, `review-${theme}-375-200.png`), fullPage: true });
        }
        await zoom.evaluate(node => node.remove());
    }
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.locator("input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
    assert.equal((await loadBoardState(context)).exports.length, 0, "review does not save");
    await updateBoardState(context, state => { state.cards["period-request-9"].workflowState = "reviewing"; });
    let saved;
    if (lostSaveResponse) await page.route("**/api/export", async route => {
        requests.push("/api/export");
        saved = await (await route.fetch()).json();
        await route.abort("failed");
    });
    const savedResponse = lostSaveResponse ? null : page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    if (lostSaveResponse) {
        await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Check save status", exact: true }).click();
    } else saved = await (await savedResponse).json();
    assert.equal(saved.error, undefined, saved.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal(requests.filter(route => route === "/api/export").length, 1);
    const state = await loadBoardState(context), entry = state.exports[0];
    assert.equal(state.exports.length, 1);
    assert.equal(entry.kind, "report"); assert.equal(entry.reportType, "period-comparison");
    const filesBefore = new Map(await Promise.all(Object.entries(entry.files).map(async ([name, file]) => [name, await readFile(file)])));
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    await expect(page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: /Retained-period comparison report/ })).toBeVisible();
    await assert.rejects(loadSavedReportSource(context, state, entry.bundleId), /two frozen cohorts/);
    const inventory = await createSavedArtifactDescriptor(context)(state, { artifactKind: "report", artifactId: entry.bundleId });
    assert.equal(inventory.files.length, 5);
    const extracted = {};
    for (const format of ["html", "json", "markdown", "pdf"]) {
        const document = await readSavedReportFile(context, state, entry.bundleId, format);
        const text = (await extractReportFile(document)).content;
        extracted[format] = text;
        assert.match(text, /Period A/); assert.match(text, /Period B/);
        assert.match(text, /3/); assert.match(text, /4/);
        assert.match(text, /33\.33/); assert.match(text, /25/);
        assert.match(text, /America\/New_York|New York/);
    }
    const task = getDocument({ data: new Uint8Array(filesBefore.get("product-report.pdf")), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
    const fonts = [];
    try {
        const document = await task.promise;
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 }), operators = await page.getOperatorList();
            for (const id of new Set(operators.fnArray.flatMap((op, i) => op === OPS.setFont ? [operators.argsArray[i][0]] : []))) {
                const font = page.commonObjs.get(id);
                assert.equal(font.missingFile, false); assert.ok(font.data?.byteLength > 0 || font.isType3Font);
                fonts.push({ name: font.name, bytes: font.data?.byteLength ?? 0, type3Glyphs: font.isType3Font });
            }
            for (const item of (await page.getTextContent()).items.filter(item => item.str?.trim())) {
                assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= viewport.width + 2, `page ${index} horizontal clipping: ${item.str}`);
                assert.ok(item.transform[5] >= 0 && item.transform[5] <= viewport.height + 1, `page ${index} vertical clipping`);
            }
        }
    } finally { await task.destroy(); }
    for (const [name, file] of Object.entries(entry.files)) assert.deepEqual(await readFile(file), filesBefore.get(name), "reopen/corpus never rewrites saved bytes");
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    if (process.env.WIRE_PERIOD_REPORT_PROOFS) {
        for (const [name, bytes] of filesBefore) await writeFile(path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, name), bytes);
        await writeFile(path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "proof.json"), JSON.stringify({ comparison: live.comparison, fonts, extracted, requests }, null, 2));
    }
});
