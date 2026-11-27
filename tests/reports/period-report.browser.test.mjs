import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, updateBoardState } from "../../lib/store.mjs";
import { readSavedReportFile, loadSavedReportSource, createSavedArtifactDescriptor } from "../../lib/report-artifacts.mjs";
import { extractReportFile } from "../../lib/search-corpus-report-content.mjs";
import { reportContextRef } from "../../lib/report-context.mjs";
import { periodFixture, periodQuery } from "../comparison/period-comparison-fixture.mjs";
import { compareAnalyzePeriods } from "../analyze/analytics-date-picker.mjs";
import { privateFixture, chooseTheme, restoreLegacySearch } from "../support/helpers.mjs";
import { qualityDisplayFixture } from "../evaluation/quality-display-fixtures.mjs";
import { assessmentSource } from "../../lib/assessment-read-model.mjs";
import { reportActivityActionGeometry, clickReportOption } from "./report-journey-helpers.mjs";

for (const lostSaveResponse of [false, true]) test(lostSaveResponse
    ? "paired report recovers its lost Save reply without replay and reopens exact HTML/JSON"
    : "normal paired report, all formats and frozen reopen", { timeout: 120000 }, async t => {
    const formats = lostSaveResponse ? ["html", "json"] : ["html", "pdf", "json", "markdown"];
    const promptMode = lostSaveResponse ? "original" : "none";
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
    const profile = await browser.newContext({ viewport: { width: 1365, height: 1000 }, timezoneId: "America/New_York", reducedMotion: "reduce" });
    const page = await profile.newPage();
    page.setDefaultTimeout(12000);
    const errors = [], denied = [], requests = [], saves = [];
    page.on("pageerror", error => errors.push(error.message));
    let saved;
    await profile.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/report-artifacts/list",
            "/api/evaluation/automatic/summary", "/api/period-comparison", "/api/preview", "/api/export", "/api/cancel-preview", "/api/report/open"];
        if (url.origin !== new URL(server.url).origin || request.method() !== "GET" && !allowed.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        requests.push(url.pathname);
        if (url.pathname === "/api/export") {
            saves.push(request.postDataJSON());
            if (lostSaveResponse && saves.length === 1) {
                saved = await (await route.fetch()).json();
                return route.abort("failed");
            }
        }
        return route.continue();
    });
    await page.goto(server.url + "#analyze?services=Files&includeMissingService=true");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await restoreLegacySearch(page, periodQuery);
    const live = await compareAnalyzePeriods(page, ["2026-03-07", "2026-03-07"], ["2026-03-08", "2026-03-09"]);
    assert.deepEqual([live.periods.baseline.rowIds.length, live.periods.later.rowIds.length], [3, 4]);
    assert.deepEqual([...live.periods.baseline.scenarioIds].sort(), ["period-request-0", "period-request-1"]);
    assert.deepEqual([...live.periods.later.scenarioIds].sort(), ["period-request-2", "period-request-3", "period-request-4", "period-request-5"]);
    await page.getByRole("button", { name: "View 4 calls", exact: true }).click();
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("3 calls across 2 interactions");
    await expect(page.locator('[data-period-side="later"]')).toContainText("4 calls across 4 interactions");
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    const compareUrl = page.url();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.ok((await page.locator("#createPeriodReport").boundingBox()).height >= 44);
    async function prepareWith(action) {
        const response = page.waitForResponse(r => r.url().endsWith("/api/preview"), { timeout: 60000 });
        await action();
        const value = await (await response).json();
        assert.equal(value.error, undefined, value.error);
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        assert.deepEqual(value.snapshot.periodComparison.comparison, live.comparison);
        for (const key of ["baseline", "later"]) {
            const frozen = value.snapshot.periodComparison.periods[key], accepted = live.periods[key];
            assert.deepEqual(frozen.range, accepted.range);
            assert.deepEqual(frozen.rows.map(row => row.id), accepted.rowIds.map(id => reportContextRef(assessed.pseudonymKey, "row", id)));
            assert.deepEqual(frozen.scenarioRefs, accepted.scenarioIds.map(id => reportContextRef(assessed.pseudonymKey, "scenario", id)));
        }
        return value;
    }
    await prepareWith(() => page.locator("#createPeriodReport").press("Space"));
    await expect(page.locator("#reportDeskDates")).toBeHidden();
    const activity = page.locator("#reportActivityOptions");
    const openActivity = async () => {
        await clickReportOption(page, "Change what's included");
        await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
        await expect(activity).toBeVisible();
    };
    await openActivity();
    await expect(page.locator("#periodReportScope")).toContainText("Authors and matching records are fixed");
    await expect(page.locator("#reportPromptAuthorFilter")).toBeDisabled();
    await expect(page.locator("#reportPromptAuthorFilter-control")).toBeHidden();
    await expect(page.locator("#reportsView .scope-choices")).toBeHidden();
    await expect(page.locator('[data-period-report-side="baseline"]')).toContainText("Mar 7, 2026");
    await expect(page.locator('[data-period-report-side="baseline"]')).toContainText("3 matching Work IQ tool calls");
    await expect(page.locator('[data-period-report-side="later"]')).toContainText("Mar 8, 2026 to Mar 9, 2026");
    await expect(page.locator('[data-period-report-side="later"]')).toContainText("4 matching Work IQ tool calls");
    assert.ok((await activity.getByRole("button", { name: "Back to comparison", exact: true }).boundingBox()).height >= 44);
    await expect(page.locator("#reportPopulationNote")).toHaveText("Copy text does not combine the measured activity in the two periods.");
    const footerMeasurements = [];
    if (!lostSaveResponse) for (const theme of ["light", "dark"]) for (const [width, text] of [[1365, 100], [375, 200]]) {
        await activity.getByRole("button", { name: "Close", exact: true }).click();
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(text => { document.documentElement.style.fontSize = text + "%"; }, text);
        await page.evaluate(() => document.fonts.ready);
        await openActivity();
        const footer = await reportActivityActionGeometry(page);
        footerMeasurements.push({ theme, width, text, ...footer });
        if (process.env.WIRE_REPORT_FOOTER_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_FOOTER_PROOFS, { recursive: true });
            await writeFile(path.join(process.env.WIRE_REPORT_FOOTER_PROOFS, "period-footer.json"), JSON.stringify(footerMeasurements, null, 2));
            await page.locator("#reportActivityActions").screenshot({ path: path.join(process.env.WIRE_REPORT_FOOTER_PROOFS, `period-${theme}-${width}-${text}.png`) });
        }
        for (const control of footer.controls) {
            assert.ok(control.box.height >= 44);
            assert.ok(control.box.x >= footer.box.x - 1 && control.box.right <= footer.box.right + 1);
            assert.equal(control.fontSize, 14 * text / 100);
            for (const word of control.words) {
                assert.equal(word.rects.length, 1, `${theme}/${width}/${text}: ${control.label} splits ${word.word}: ${JSON.stringify(control)}`);
                assert.ok(word.rects[0].x >= control.box.x - 1 && word.rects[0].right <= control.box.right + 1);
            }
        }
        for (const [index, control] of footer.controls.entries()) for (const other of footer.controls.slice(index + 1)) {
            assert.ok(Math.min(control.box.right, other.box.right) - Math.max(control.box.x, other.box.x) <= 1
                || Math.min(control.box.bottom, other.box.bottom) - Math.max(control.box.y, other.box.y) <= 1,
            `${theme}/${width}/${text}: footer actions cannot overlap`);
        }
        const measured = await page.locator("#periodReportScope").evaluate(node => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            right: node.getBoundingClientRect().right, width: innerWidth,
            target: node.querySelector("button").getBoundingClientRect().height,
        }));
        assert.equal(measured.overflow, false);
        assert.ok(measured.right <= measured.width + 1 && measured.target >= 44);
        if (process.env.WIRE_PERIOD_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_PERIOD_REPORT_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, `activity-${theme}-${width}-${text}.png`), fullPage: true });
        }
    }
    await page.setViewportSize({ width: 1365, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await expect(page.locator("#reportList input")).toHaveCount(0);
    const interaction = activity.locator("#reportList .request-card-open").first();
    await interaction.click();
    await expect(page.locator("#requestReportToggle")).toBeHidden();
    await expect(page.locator("#requestReportTitle")).toContainText("fixed paired periods");
    await page.goBack();
    await expect(activity).toBeVisible();
    await expect(interaction).toBeFocused();
    await activity.getByRole("button", { name: "Close", exact: true }).click();
    await clickReportOption(page, /^Report text:/);
    let preview = await prepareWith(() => page.locator(`[name=promptMode][value=${promptMode}]`).check());
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await clickReportOption(page, "Formats: HTML");
    for (const format of formats.slice(1)) preview = await prepareWith(() => page.locator(`#formatOptions input[value=${format}]`).check());
    await page.keyboard.press("Escape");
    assert.equal(preview.promptMode, promptMode);
    const copies = preview.records.flatMap(record => record.prompts);
    if (promptMode === "none") assert.ok(copies.every(copy => copy.text === null), "Omitted text stays out of prepared copies");
    else assert.deepEqual(copies.filter(copy => copy.kind === "origin").map(copy => copy.text).sort(),
        fixture.records.slice(0, 6).map(record => record.userPrompt.text).sort());
    assert.deepEqual(errors, []);
    assert.equal(live.definitions.metricProjectionVersion, 4);
    assert.ok(live.comparison.metrics.every(item => (item.baseline ?? item.later).metric === "speed"), "Current reports retain timing, not historical feedback lanes");
    assert.equal(preview.snapshot.evaluationFacts, undefined);
    const frame = page.frameLocator(".report-frame");
    await expect(frame.getByRole("heading", { name: preview.title, level: 1, exact: true })).toBeVisible();
    await expect(frame.getByRole("heading", { name: "Recorded outcomes", level: 2, exact: true })).toBeVisible();
    await expect(frame.locator("#period-a-results")).toBeAttached();
    await expect(frame.locator("#period-a-results")).not.toContainText("Work IQ sign-in was required");
    await expect(frame.locator("body")).not.toContainText("synthetic-quality-fixture");
    assert.ok(preview.records.every(record => !record.toolCalls.length));
    if (process.env.WIRE_PERIOD_REPORT_PROOFS && !lostSaveResponse) {
        const outputPage = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
        await outputPage.route("**/*", route => { denied.push(route.request().url()); return route.abort(); });
        await outputPage.setContent(preview.previewHtml);
        await mkdir(process.env.WIRE_PERIOD_REPORT_PROOFS, { recursive: true });
        await outputPage.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "frozen-output-light.png") });
        await outputPage.setViewportSize({ width: 375, height: 950 });
        await outputPage.locator("html").evaluate(node => { node.style.fontSize = "200%"; node.dataset.evidenceTheme = "dark"; });
        await outputPage.screenshot({ path: path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "frozen-output-dark-375-200.png") });
        await outputPage.close();
    }

    if (!lostSaveResponse) for (const theme of ["light", "dark"]) {
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
    assert.equal((await loadBoardState(context)).exports.length, 0, "preparation and reading do not save");
    await updateBoardState(context, state => { state.cards["period-request-9"].workflowState = "reviewing"; });
    const savedResponse = lostSaveResponse ? null : page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    if (lostSaveResponse) {
        const warning = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Save with chat details", exact: true }) });
        await expect(warning).toContainText("HTML");
        await expect(warning).toContainText("JSON");
        assert.equal(saves.length, 0, "Keeping chat details requires a decision for these files");
        await warning.getByRole("button", { name: "Save with chat details", exact: true }).click();
        await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        let heldRequest;
        t.after(() => release.resolve());
        await page.route("**/api/snapshot", async route => {
            heldRequest = route.request();
            const response = await route.fetch();
            entered.resolve();
            await release.promise;
            await route.fulfill({ response });
        }, { times: 1 });
        const staleRead = page.waitForResponse(response => response.request() === heldRequest);
        await page.getByRole("button", { name: "Check save status", exact: true }).click();
        await entered.promise;
        const newerRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot")
            && response.request() !== heldRequest);
        await page.evaluate(() => window.dispatchEvent(new Event("online")));
        await (await newerRead).finished();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        release.resolve(); await (await staleRead).finished();
        await expect(page.locator("#reportJourneyError")).toContainText("Saved history is unavailable");
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "blocked");
        assert.equal(requests.filter(route => route === "/api/export").length, 1);
        const acceptedActivity = await page.locator("#activityList .request-card-open").first().elementHandle();
        assert.ok(acceptedActivity, "The accepted activity frame exists before receipt recovery.");
        await page.getByRole("button", { name: "Check save status", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        assert.equal(await page.locator("#activityList .request-card-open").first()
            .evaluate((node, original) => node === original, acceptedActivity), true,
        "Receipt recovery publishes the file inventory without replacing the accepted activity frame.");
    } else saved = await (await savedResponse).json();
    assert.equal(saved.error, undefined, saved.error);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal(requests.filter(route => route === "/api/export").length, 1);
    const state = await loadBoardState(context), entry = state.exports[0];
    assert.equal(state.exports.length, 1);
    assert.equal(entry.bundleId, preview.bundleId, "Recovery identifies the original prepared report, not a new Save.");
    assert.equal(entry.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    assert.equal(entry.privacyReview.localSave.keepChatDetailsConfirmed, lostSaveResponse);
    assert.equal(entry.privacyReview.reviewerConfirmed, false);
    assert.deepEqual(saves.map(({ previewId, localSave }) => [previewId, localSave]),
        [[preview.previewId, { ...preview.localSaveRequest, keepChatDetailsConfirmed: lostSaveResponse }]]);
    assert.equal(entry.kind, "report"); assert.equal(entry.reportType, "period-comparison");
    const filesBefore = new Map(await Promise.all(Object.entries(entry.files).map(async ([name, file]) => [name, await readFile(file)])));
    for (const [name, bytes] of filesBefore) if (name !== "coverage-and-redaction-manifest.json") {
        const prepared = preview.files[name];
        assert.deepEqual(bytes, typeof prepared === "string" ? Buffer.from(prepared) : Buffer.from(prepared.data, "base64"), name);
    }
    const preparations = requests.filter(route => route === "/api/preview").length;
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    await expect(page.frameLocator("#savedReportReader iframe").getByRole("heading", { name: entry.title, level: 1, exact: true })).toBeVisible();
    await assert.rejects(loadSavedReportSource(context, state, entry.bundleId), /two frozen cohorts/);
    const inventory = await createSavedArtifactDescriptor(context)(state, { artifactKind: "report", artifactId: entry.bundleId });
    assert.equal(inventory.files.length, formats.length + 1);
    const extracted = {};
    for (const format of formats) {
        const document = await readSavedReportFile(context, state, entry.bundleId, format);
        const text = (await extractReportFile(document)).content;
        if (format === "json") assert.deepEqual(document.snapshot.periodComparison, preview.snapshot.periodComparison);
        extracted[format] = text;
        assert.match(text, /Period A/); assert.match(text, /Period B/);
        assert.match(text, /3/); assert.match(text, /4/);
        assert.match(text, /33\.33/); assert.match(text, /25/);
        assert.match(text, /America\/New_York|New York/);
        assert.equal(text.includes(periodQuery), promptMode === "original", `${format} must respect the chosen text treatment`);
        assert.doesNotMatch(text, /Outside query request 9/);
    }
    const fonts = [];
    if (!lostSaveResponse) {
        const task = getDocument({ data: new Uint8Array(filesBefore.get("product-report.pdf")), useSystemFonts: false, disableFontFace: true, fontExtraProperties: true });
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
    }
    await page.getByRole("button", { name: "Back to comparison", exact: true }).click();
    await expect(page).toHaveURL(compareUrl);
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.getByRole("button", { name: "View 4 calls", exact: true }).click();
    await expect(page.locator('[data-period-side="baseline"]')).toContainText("3 calls across 2 interactions");
    await expect(page.locator('[data-period-side="later"]')).toContainText("4 calls across 4 interactions");
    assert.equal(requests.filter(route => route === "/api/preview").length, preparations, "Open and return never reprepare");
    assert.equal(saves.length, 1, "Open and return never replay Save");
    for (const [name, file] of Object.entries(entry.files)) assert.deepEqual(await readFile(file), filesBefore.get(name), "reopen/corpus never rewrites saved bytes");
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    if (process.env.WIRE_PERIOD_REPORT_PROOFS) {
        for (const [name, bytes] of filesBefore) await writeFile(path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, name), bytes);
        await writeFile(path.join(process.env.WIRE_PERIOD_REPORT_PROOFS, "proof.json"), JSON.stringify({ comparison: live.comparison, fonts, extracted, requests }, null, 2));
    }
});
