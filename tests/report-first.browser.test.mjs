import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { time } from "../lib/time.mjs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

function records() {
    return Array.from({ length: 8 }, (_, index) => {
        const record = fixture(`report-first-${index}`);
        record.capturedAt = new Date().toISOString();
        record.toolCalls[0].startedAt = record.capturedAt;
        record.userPrompt.text = `REPORT_FIRST_${index} Find mailbox messages for email@example.invalid.`;
        record.toolCalls[0].toolSucceeded = index < 2 ? false : true;
        record.toolCalls[0].reportedOutcome = index < 2 ? "failed" : "succeeded";
        record.toolCalls[0].apiResults = [{ index: 0, statusCode: index < 2 ? 403 : 200 }];
        return record;
    });
}
async function setup(t, { source = records(), route = "#reports", enforced = false } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, source);
    const access = enforced ? await createCopilotRuntimeAccess(context) : undefined;
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, ...(access ? { access } : {}) });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); await access?.close(); for (const work of cleanup) await work(); });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "America/Los_Angeles" });
    const page = await profile.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.stack));
    page.on("request", request => { if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
    await page.goto(runtime.url + route);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.deepEqual(errors, []);
    return { page, context, source, errors, requests, runtime };
}
async function prepare(page, preset = "errors") {
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator(`[data-report-preset="${preset}"]`).click();
    const result = await response, body = await result.json();
    assert.equal(result.status(), 200, body.error);
    await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
    return body;
}

test("gallery opens a real report and direct Save preserves the frozen failure cohort", { timeout: 60000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t);
    await expect(page.locator("[data-report-preset]")).toHaveCount(5);
    await expect(page.locator(".report-progress")).toBeHidden();
    const initial = await prepare(page);
    assert.equal(initial.snapshot.reportPopulation.reference.length, 8);
    assert.equal(initial.records.length, 2);
    assert.equal(initial.promptMode, "masked");
    assert.equal(await page.locator(".report-approval .attestation").count(), 0);
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Errors & failures");
    const state = await loadBoardState(context), added = fixture("arrived-after-preview");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Mailbox call failures");
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await expect(page.frameLocator(".report-frame").locator("h1")).toHaveText("Mailbox call failures");
    const updated = await (await rebuilt).json();
    assert.deepEqual(updated.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    let preparedFiles = updated.files;
    for (const format of ["pdf", "json", "markdown"]) {
        const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const result = await response, body = await result.json();
        assert.equal(result.status(), 200, body.error);
        assert.deepEqual(body.snapshot.reportPopulation, initial.snapshot.reportPopulation);
        preparedFiles = body.files;
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    const save = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Save report", exact: true }).dblclick();
    assert.equal((await save).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = await loadBoardState(context);
    assert.equal(saved.exports.length, 1);
    assert.equal(saved.exports[0].privacyReview.reviewerConfirmed, false);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await selectActivityOption(page, "savedReaderFormat", "html");
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        if (format !== "html") {
            await page.getByRole("combobox", { name: "Saved report view", exact: true }).click();
            await page.locator(`.select-popup [data-value="${format}"]`).click();
        }
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const file = await download, bytes = await readFile(await file.path());
        const expected = typeof preparedFiles[name] === "string" ? Buffer.from(preparedFiles[name]) : Buffer.from(preparedFiles[name].data, "base64");
        assert.deepEqual(bytes, expected);
    }
    assert.deepEqual(errors, []);
});

test("fresh reports ignore Analyze restrictions and custom dates replace only an explicit Current period", { timeout: 60000 }, async t => {
    const source = records();
    const today = time.day(new Date().toISOString(), "America/Los_Angeles");
    const prior = new Date(Date.now() - 10 * 86400000).toISOString();
    source[0].capturedAt = prior; source[0].toolCalls[0].startedAt = prior;
    for (const record of source.slice(0, 3)) {
        record.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
        record.toolCalls[0].requestedApiPath = "/me/messages";
    }
    const route = `#reports?task=create&service=Mail&range=custom&from=${today}&to=${today}`;
    const { page, errors } = await setup(t, { source, route });
    const fresh = await prepare(page, "all");
    assert.equal(fresh.records.length, 7, "Fresh scope includes Calendar despite the old Mail filter");
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    await page.locator('[name=reportScope][value=current]').check();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Show report", exact: true }).click();
    const current = await (await preparing).json();
    assert.equal(current.records.length, 2);
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator("#reportPeriodChoices [data-report-range=custom]").click();
    await expect(page.locator("#reportCustomDates")).toBeVisible();
    assert.equal(await page.locator("#reportCustomDates [data-report-range]").count(), 0);
    await page.locator("#reportCustomDates").getByLabel("From", { exact: true }).fill("2026-01-01");
    await page.locator("#reportCustomDates").getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.frameLocator(".report-frame").locator("[data-report-scenario]").count(), 2);
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator("#reportPeriodChoices [data-report-range=custom]").click();
    await page.locator("#reportCustomDates").getByLabel("From", { exact: true }).fill("2026-01-01");
    const response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Use dates", exact: true }).click();
    const widened = await response, body = await widened.json();
    assert.equal(widened.status(), 200, body.error);
    assert.equal(body.records.length, 3, "Mail is retained and the original older interaction is admitted");
    await expect(page.locator("#reportExperienceScope")).toContainText("Based on Analyze filters");
    assert.match(page.url(), new RegExp(`from=${today}&to=${today}`), "Analyze dates were not mutated");
    assert.deepEqual(errors, []);
});

test("JSON-only saved reports open as readable reports independently of their files", { timeout: 30000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    const downloads = [];
    page.on("download", download => downloads.push(download));
    await prepare(page);
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const [format, selected] of [["json", true], ["html", false]]) {
        const ready = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).setChecked(selected); await ready;
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const before = await loadBoardState(context), saved = before.exports[0];
    assert.deepEqual(saved.formats, ["json"]);
    const bytes = await readFile(saved.files["product-report.json"]);
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    const row = page.locator(".saved-library-row");
    await row.getByRole("button", { name: "View report: Errors & failures", exact: true }).click();
    const reader = page.locator("#savedReportReader");
    await expect(reader.frameLocator("iframe").locator("h1")).toHaveText("Errors & failures");
    await expect(reader.frameLocator("iframe").locator("body")).toContainText("2 of 8 interactions had recorded errors.");
    await expect(reader.locator(".saved-json-tree")).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "Download", exact: true })).toBeHidden();
    const reads = requests.filter(request => request.path === "/api/preview").length;
    await selectActivityOption(page, "savedReaderFormat", "json");
    await expect(reader.locator(".saved-json-tree")).toBeVisible();
    await expect(reader.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await selectActivityOption(page, "savedReaderFormat", "report");
    await expect(reader.frameLocator("iframe").locator("h1")).toHaveText("Errors & failures");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, reads, "Saved reading never prepares current activity.");
    assert.deepEqual(downloads, []);
    assert.deepEqual(await readFile(saved.files["product-report.json"]), bytes);
    assert.deepEqual(await loadBoardState(context), before);
    await selectActivityOption(page, "savedReaderFormat", "json");
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/report/open", async route => {
        const response = await route.fetch(); pending.resolve();
        await release.promise; await route.fulfill({ response });
    }, { times: 1 });
    const late = page.waitForResponse(response => response.url().endsWith("/api/report/open"));
    await selectActivityOption(page, "savedReaderFormat", "report"); await pending.promise;
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    release.resolve(); await (await late).finished();
    await expect(reader).toBeHidden();
    await expect(reader).toBeEmpty();
    assert.deepEqual(errors, []);
});

test("withdrawal clears a hidden cached report while an original file is being viewed", { timeout: 30000 }, async t => {
    const { page, runtime, errors } = await setup(t, { enforced: true });
    await prepare(page);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toBeVisible();
    await page.evaluate(() => { window.heldReportFrame = document.querySelector("#savedReportReader iframe"); });
    await selectActivityOption(page, "savedReaderFormat", "html");
    assert.equal(await page.evaluate(() => heldReportFrame.isConnected && !heldReportFrame.checkVisibility()), true);
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(await page.evaluate(() => [heldReportFrame.isConnected, heldReportFrame.srcdoc]), [false, ""]);
    assert.deepEqual(errors, []);
});

for (const paired of [false, true]) test(`a lost ${paired ? "paired " : ""}direct-Save response recovers the original exact-content receipt without a second write`, { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t, paired ? { source: periodFixture().records,
        route: "#analyze?compare=periods&aFrom=2026-03-07&aTo=2026-03-07&bFrom=2026-03-08&bTo=2026-03-09" } : {});
    let preview;
    if (paired) {
        await expect(page.locator("#createPeriodReport")).toBeEnabled();
        const prepared = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator("#createPeriodReport").click();
        preview = await (await prepared).json();
        assert.ok(preview.snapshot.periodComparison);
    } else preview = await prepare(page);
    await page.route("**/api/export", async route => { await route.fetch(); await route.abort("connectionreset"); }, { times: 1 });
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
    const back = page.getByRole("link", { name: paired ? "Back to comparison" : "Back to Reports", exact: true });
    await expect(back).toBeDisabled();
    await back.press("Enter");
    await expect(page.locator("#reportGallery")).toBeHidden();
    await expect(page.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    await page.getByRole("button", { name: "Check save status", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports[0];
    assert.equal(saved.bundleId, preview.bundleId);
    assert.equal(saved.privacyReview.localSave.contentHash, preview.localSaveRequest.contentHash);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.deepEqual(errors, []);
});

test("new library metadata and saved comparisons use frozen files and direct local Save", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    for (const preset of ["errors", "all"]) {
        await prepare(page, preset);
        if (preset === "all") {
            const patterns = page.frameLocator(".report-contained-frame").locator("#patterns");
            await expect(patterns.locator("h2")).toHaveCount(2);
            await expect(patterns.locator("h2").first()).toBeVisible();
        }
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    }
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    await expect(page.locator(".saved-report-privacy").first()).toHaveAttribute("aria-label", "Personal details hidden where detected");
    await expect(page.locator(".saved-report-period").first()).not.toHaveText("Not recorded");
    await expect(page.locator("[data-report-preset]")).toHaveCount(5);
    await page.locator("#reportCompareLink").click();
    const entries = (await loadBoardState(context)).exports;
    for (const [label, id] of [["Earlier report", entries[0].bundleId], ["Later report", entries[1].bundleId]]) {
        await page.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup [data-value="${id}"]`).click();
    }
    const preparation = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await page.getByRole("button", { name: "Compare reports", exact: true }).click();
    const prepared = await preparation, body = await prepared.json();
    assert.equal(prepared.status(), 200, body.error);
    await expect(page.getByRole("button", { name: "Approve for local saving", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Save comparison", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open saved comparison", exact: true })).toBeVisible();
    const comparison = (await loadBoardState(context)).exports.find(entry => entry.kind === "comparison");
    assert.equal(comparison.privacyReview.reviewerConfirmed, false);
    assert.equal(comparison.privacyReview.localSave.contentHash, body.localSaveRequest.contentHash);
    assert.equal(requests.filter(request => /\/(?:privacy-review|report-comparison\/review)$/.test(request.path)).length, 0);
    assert.deepEqual(errors, []);
});

for (const resumePrepared of [false, true]) test(`fresh Reports entry after comparison returns to Reports (${resumePrepared ? "prepared return" : "direct Save"})`, { timeout: 30000 }, async t => {
    const { page, context, errors } = await setup(t, { route: "#analyze" });
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.getByRole("button", { name: "By tool", exact: true }).click();
    const comparison = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    await page.locator('nav [data-nav="reports"]').click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    const period = await page.locator("#reportGallery .report-period-caption").textContent();
    const prepared = await prepare(page);
    assert.equal(prepared.snapshot.periodComparison, undefined);
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to Reports");
    if (resumePrepared) {
        await page.locator("#reportLibraryLink").click();
        await expect(page.locator("#reportGallery")).toBeVisible();
        await expect(page.locator("#reportGallery .report-period-caption")).toHaveText(period);
        await page.locator('[data-report-preset="errors"]').click();
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal((await loadBoardState(context)).exports[0].bundleId, prepared.bundleId);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator(".saved-reader-heading .document-back")).toHaveText("Back to Reports");
    await page.locator(".saved-reader-heading .document-back").click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#reportGallery .report-period-caption")).toHaveText(period);
    await expect(page.locator('nav [data-nav="reports"]')).toHaveAttribute("aria-current", "page");
    const [view, query] = new URL(page.url()).hash.split("?");
    assert.equal(view, "#reports");
    for (const key of ["compare", "comparisonView", "comparisonFocus", "aFrom", "aTo", "bFrom", "bTo", "task", "bundle"]) {
        assert.equal(new URLSearchParams(query).has(key), false, key);
    }
    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await expect(page.getByRole("button", { name: "By tool", exact: true })).toHaveAttribute("aria-pressed", "true");
    const restored = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
    for (const key of ["aFrom", "aTo", "bFrom", "bTo", "comparisonView"]) assert.equal(restored.get(key), comparison.get(key), key);
    assert.deepEqual(errors, []);
});

test("retained-period comparison opens its report directly and saves the accepted pair", { timeout: 60000 }, async t => {
    const { page, context, errors } = await setup(t, { source: periodFixture().records, route: "#analyze" });
    await page.locator("#comparePeriods").click();
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    for (const [label, value] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) {
        await page.getByLabel(label, { exact: true }).fill(value);
    }
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    const origin = new URL(page.url()).hash;
    const pending = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const response = await pending;
    let prepared = await response.json();
    assert.equal(response.status(), 200, prepared.error);
    assert.ok(prepared.snapshot.periodComparison);
    assert.equal(prepared.localSaveRequest.version, 1);
    await expect(page.locator("#reportStage3")).toBeVisible();
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to comparison");
    const acceptedComparison = prepared.snapshot.periodComparison.comparison;
    await page.locator("#reportLibraryLink").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.equal(new URL(page.url()).hash, origin);
    await expect(page.getByRole("button", { name: "Timing", exact: true })).toHaveAttribute("aria-pressed", "true");
    const repeated = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#createPeriodReport").click();
    const repeatedResponse = await repeated;
    prepared = await repeatedResponse.json();
    assert.equal(repeatedResponse.status(), 200, prepared.error);
    assert.deepEqual(prepared.snapshot.periodComparison.comparison, acceptedComparison);
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to comparison");
    let preparedFiles = prepared.files;
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const next = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const rebuilt = await (await next).json();
        const stablePair = value => {
            const copy = structuredClone(value);
            for (const side of Object.values(copy.periods)) {
                assert.ok(Number.isFinite(Date.parse(side.facts.preparedAt)));
                assert.match(side.facts.snapshotRef, /^snapshot-[a-f0-9]+$/);
                delete side.facts.preparedAt; delete side.facts.snapshotRef;
            }
            return copy;
        };
        assert.deepEqual(stablePair(rebuilt.snapshot.periodComparison), stablePair(prepared.snapshot.periodComparison));
        preparedFiles = rebuilt.files;
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    assert.equal((await loadBoardState(context)).exports[0].reportType, "period-comparison");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await expect(page.locator(".saved-reader-heading .document-back")).toHaveText("Back to comparison");
    await selectActivityOption(page, "savedReaderFormat", "html");
    for (const [format, name] of [["html", "product-report.html"], ["pdf", "product-report.pdf"], ["json", "product-report.json"], ["markdown", "product-report.md"]]) {
        if (format !== "html") {
            await page.getByRole("combobox", { name: "Saved report view", exact: true }).click();
            await page.locator(`.select-popup [data-value="${format}"]`).click();
        }
        const downloaded = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        const bytes = await readFile(await (await downloaded).path());
        const expected = typeof preparedFiles[name] === "string" ? Buffer.from(preparedFiles[name]) : Buffer.from(preparedFiles[name].data, "base64");
        assert.deepEqual(bytes, expected);
    }
    await page.locator(".saved-reader-heading .document-back").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    assert.equal(new URL(page.url()).hash, origin);
    await expect(page.getByRole("button", { name: "Timing", exact: true })).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(errors, []);
});

test("access withdrawal erases held example editors and never resumes their old save intent", { timeout: 30000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, { enforced: true });
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    const note = frame.getByLabel("Your note", { exact: true }).first();
    await note.fill("PRIVATE_UNSAVED_NOTE");
    await page.evaluate(() => {
        const source = document.querySelector(".report-frame").contentDocument;
        window.heldReportNote = source.querySelector(".wire-example-editor textarea");
        window.heldReportTitle = source.querySelector("h1").firstChild;
    });
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.equal(await page.evaluate(() => window.heldReportNote.value), "");
    assert.equal(await page.evaluate(() => window.heldReportTitle.data), "");
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.equal(requests.filter(request => request.path === "/api/export").length, 0);
    assert.deepEqual(errors, []);
});

test("keep-details warning can cancel or regenerate masked notes and copies before one Save", { timeout: 60000 }, async t => {
    const { page, context, requests, errors } = await setup(t);
    await prepare(page);
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Your note", { exact: true }).first().fill("Expected a result for note@example.invalid.");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update note", exact: true }).first().click();
    assert.equal((await response).status(), 200);
    await page.getByRole("button", { name: "Hide personal details", exact: true }).click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check();
    assert.equal((await response).status(), 200);
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Hide details and save", exact: true }).click();
    const result = await saved;
    assert.equal(result.status(), 200, JSON.stringify(await result.json()));
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context);
    assert.equal(state.exports.length, 1);
    assert.equal(state.exports[0].promptMode, "masked");
    assert.equal(requests.filter(request => request.path === "/api/export").length, 1);
    assert.equal(requests.filter(request => request.path === "/api/privacy-review").length, 0);
    assert.deepEqual(errors, []);
});

test("returning to the gallery during preparation retires that result and leaves report choices usable", { timeout: 30000 }, async t => {
    const { page, context, errors } = await setup(t);
    const held = Promise.withResolvers();
    await page.route("**/api/preview", async route => { const response = await route.fetch(); await held.promise; await route.fulfill({ response }); }, { times: 1 });
    await page.locator('[data-report-preset="errors"]').click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "scanning");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    held.resolve();
    await expect(page.locator('[data-report-preset="errors"]')).toBeEnabled();
    await expect(page.locator("#reportStage1")).toBeVisible();
    await prepare(page);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("one Reports entry retains an edited frozen draft across Back, same-tile resume and browser history", { timeout: 30000 }, async t => {
    const { page, context, source, requests, errors } = await setup(t, { route: "#reports?task=create" });
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#pageAction")).toBeHidden();
    await expect(page.locator("#reportCreateLink")).toBeHidden();
    const initial = await prepare(page);
    await expect(page.locator("#savedReportsPanel")).toBeHidden();
    const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Unfinished mailbox report"); await renamed;
    const frame = page.frameLocator(".report-frame");
    await frame.locator(".wire-reading-interaction>summary").first().click();
    await frame.locator(".wire-example-editor summary").first().click();
    await frame.getByLabel("Your note", { exact: true }).first().fill("Check this permission boundary.");
    const noted = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await frame.getByRole("button", { name: "Update note", exact: true }).first().click();
    const edited = await (await noted).json();
    assert.deepEqual(edited.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    const requestCount = requests.filter(request => request.path === "/api/preview").length;
    const state = await loadBoardState(context), added = fixture("later-not-in-resumed-copy");
    added.capturedAt = new Date().toISOString(); added.toolCalls[0].startedAt = added.capturedAt;
    await replaceEvidence(context, () => ({ records: [...source, added], importCoverage: state.importCoverage }));
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    await expect(page.locator("#reportPreset-errors")).toBeFocused();
    await page.locator("#reportPreset-errors").click();
    await expect(page.getByLabel("Report name", { exact: true })).toHaveValue("Unfinished mailbox report");
    await expect(page.frameLocator(".report-frame").locator("body")).toContainText("Check this permission boundary.");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, requestCount);
    await page.goBack();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await page.goForward();
    await expect(page.getByLabel("Report name", { exact: true })).toHaveValue("Unfinished mailbox report");
    assert.equal(requests.filter(request => request.path === "/api/preview").length, requestCount);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    assert.deepEqual(errors, []);
});

test("saved names, Files and options preserve exact files, paging, search, focus and deletion confirmation", { timeout: 60000 }, async t => {
    const { page, context, errors } = await setup(t);
    let expectedFile;
    for (let index = 1; index <= 8; index++) {
        await prepare(page);
        const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.getByLabel("Report name", { exact: true }).fill("Return report " + index);
        const prepared = await (await renamed).json();
        if (index === 7) expectedFile = Buffer.from(prepared.files["product-report.html"]);
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    }
    await page.locator("#savedReportSearch").fill("Return report");
    await page.locator("#savedReportOrder-control").click();
    await page.locator('.select-popup [data-value="oldest"]').click();
    assert.equal(await page.locator("#bundleList .list-pager").evaluate(node =>
        Boolean(node.previousElementSibling?.classList.contains("saved-report-table"))), true,
    "Saved-report paging follows the rows in both reading and keyboard order.");
    await page.getByRole("button", { name: "Next saved reports", exact: true }).click();
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    const title = page.locator(".saved-report-title").first();
    await expect(title).toHaveText("Return report 7");
    await title.focus();
    const y = await page.evaluate(() => scrollY);
    await title.click();
    await expect(page.locator("#savedReportReader")).toBeVisible();
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#savedReportSearch")).toHaveValue("Return report");
    await expect(page.locator("#savedReportOrder")).toHaveValue("oldest");
    await expect(page.locator(".saved-report-title")).toHaveCount(2);
    await expect(page.locator(".saved-report-title").first()).toBeFocused();
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - y) < 3);
    const row = page.locator(".saved-library-row").first();
    await row.locator(".saved-report-files").click();
    await expect(row.getByRole("dialog", { name: "Files for Return report 7", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "HTML", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const file = await download, saved = (await loadBoardState(context)).exports.find(entry => entry.title === "Return report 7");
    assert.ok(saved);
    const bytes = await readFile(await file.path());
    assert.deepEqual(bytes, expectedFile);
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await expect(row.locator(".saved-report-files")).toBeFocused();
    await row.locator(".saved-report-row-options").click();
    await row.getByRole("button", { name: "Inspect details", exact: true }).click();
    await expect(page.locator("#contextSidebar")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(page.locator("#contextSidebar")).toBeHidden();
    await row.locator(".saved-report-row-options").click();
    await row.getByRole("button", { name: "Delete report", exact: true }).click();
    const deletion = page.locator('[aria-labelledby="savedArtifactDeleteTitle"]');
    await expect(deletion).toBeVisible();
    await expect(deletion).toHaveAttribute("aria-busy", "false");
    assert.equal((await loadBoardState(context)).exports.length, 8, "Opening deletion confirmation writes nothing");
    await page.keyboard.press("Escape");
    await page.locator("#savedLibraryOptions").click();
    await expect(page.getByRole("button", { name: "Delete all saved reports", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#savedLibraryManagement")).toBeHidden();
    let legacyId;
    await updateBoardState(context, state => {
        const entry = state.exports.find(entry => entry.title === "Return report 8");
        legacyId = entry.bundleId;
        delete entry.promptMode; delete entry.reportPeriod;
    });
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#savedReportSearch").fill(legacyId);
    await expect(page.locator(".saved-report-privacy")).toHaveCount(1);
    await expect(page.locator(".saved-report-privacy")).toHaveAttribute("aria-label", "Text treatment not recorded");
    await expect(page.locator(".saved-report-period")).toHaveText("Not recorded");
    assert.deepEqual(errors, []);
});

test("one-chat and explicit Selected entry keep their complete scope and contextual return", { timeout: 30000 }, async t => {
    const source = records();
    source.forEach((record, index) => {
        record.sourceSessionId = index < 3 ? "first-chat" : "second-chat";
        record.sourceSessionName = index < 3 ? "First chat" : "Second chat";
    });
    const { page, errors } = await setup(t, { source, route: "#analyze?session=first-chat" });
    await page.locator("#createSessionReport").click();
    const chat = await prepare(page, "all");
    assert.equal(chat.records.length, 3);
    await page.getByRole("link", { name: "Back to Analyze", exact: true }).click();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("session"), "first-chat");
    await page.locator('[data-nav="reports"]').click();
    await page.locator("#reportPreset-all").click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    await page.locator('[name=reportScope][value=selected]').check();
    const picks = page.locator("#reportActivityOptions input[data-report-request]");
    await expect(picks.first()).toBeVisible();
    await picks.first().uncheck();
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#reportActivityOptions").getByRole("button", { name: "Show report", exact: true }).click();
    const selected = await (await preparing).json();
    assert.equal(selected.records.length, 2);
    assert.ok(selected.records.every(record => chat.records.some(original => original.scenarioId === record.scenarioId)));
    assert.deepEqual(errors, []);
});

test("withdrawal scrubs retained saved-row titles and menu labels and blocks their old actions", { timeout: 30000 }, async t => {
    const { page, runtime, context, requests, errors } = await setup(t, { enforced: true });
    await prepare(page);
    const renamed = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("PRIVATE_SAVED_TITLE"); await renamed;
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await page.locator(".saved-report-files").click();
    await page.evaluate(() => {
        window.heldSavedTitle = document.querySelector(".saved-report-name").firstChild;
        window.heldSavedLabel = document.querySelector(".saved-report-files").getAttributeNode("aria-label");
        window.heldSavedMenuLabel = document.querySelector(".saved-library-row .saved-report-menu").getAttributeNode("aria-label");
        window.heldSavedAction = document.querySelector(".saved-report-menu button");
    });
    const controller = await page.context().newPage();
    await controller.goto(runtime.url);
    await expect(controller.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await controller.locator("#wireAccountTrigger").click();
    await controller.locator("#wireAccountGate").click();
    await expect(page.locator("#workspace")).toBeHidden();
    assert.deepEqual(await page.evaluate(() => [heldSavedTitle.data, heldSavedLabel.value, heldSavedMenuLabel.value]), ["", "", ""]);
    const before = requests.filter(request => /report-artifacts|\/api\/export/.test(request.path)).length;
    await page.evaluate(() => heldSavedAction.click());
    assert.equal(requests.filter(request => /report-artifacts|\/api\/export/.test(request.path)).length, before);
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.deepEqual(errors, []);
});

test("report-first controls retain equal geometry, readable themes and narrow enlarged-text access", { timeout: 60000 }, async t => {
    const { page, errors } = await setup(t);
    const proofs = process.env.WIRE_REPORT_FIRST_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    async function capture(name) {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, name);
        if (proofs) await page.screenshot({ path: path.join(proofs, name + ".png") });
    }
    await page.locator('[data-report-preset="errors"]').hover();
    await expect(page.getByRole("tooltip")).toBeHidden();
    for (const label of ["all activity", "errors & failures", "completed calls", "my prompts", "agent prompts"]) {
        const control = page.getByRole("button", { name: "About " + label, exact: true });
        await control.focus();
        await expect(page.getByRole("tooltip")).toBeVisible();
        assert.ok((await page.getByRole("tooltip").textContent()).length > 20);
        await page.keyboard.press("Escape");
        await control.click();
        await expect(page.getByRole("tooltip")).toBeVisible();
        await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "About errors & failures", exact: true }).click();
    await expect(page.getByRole("tooltip")).toBeVisible();
    const help = await page.getByRole("button", { name: "About errors & failures", exact: true }).boundingBox();
    const tip = await page.getByRole("tooltip").boundingBox();
    const distance = Math.hypot(Math.max(tip.x - help.x - help.width, help.x - tip.x - tip.width, 0),
        Math.max(tip.y - help.y - help.height, help.y - tip.y - tip.height, 0));
    assert.ok(distance <= help.height, JSON.stringify({ help, tip, distance }));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    for (const [theme, width, size] of [["light", 1280, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; }, size);
        const heights = await page.locator(".report-tile").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.ok(heights.every(height => Math.abs(height - heights[0]) < 1));
        await capture(`gallery-${theme}-${width}-${size}`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator("#reportGallery [data-report-range=custom]").click();
    await expect(page.locator("#reportCustomDates")).toBeVisible();
    await capture("calendar-dark-1280");
    await page.keyboard.press("Escape");
    await prepare(page);
    for (const [theme, width, size] of [["dark", 1280, 100], ["light", 1280, 100], ["dark", 375, 200]]) {
        await chooseTheme(page, theme); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + "%"; scrollTo(0, 0); }, size);
        const name = page.getByLabel("Report name", { exact: true });
        await name.focus();
        const gap = await name.evaluate(node => node.getBoundingClientRect().top - node.previousElementSibling.getBoundingClientRect().bottom);
        assert.ok(gap >= 8);
        await capture(`report-${theme}-${width}-${size}`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.getByRole("button", { name: "Hide personal details", exact: true }).click();
    const ready = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[name=promptMode][value=original]').check(); await ready;
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    const buttons = await page.locator(".report-warning-actions>button:not(.report-warning-back)").evaluateAll(nodes =>
        nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.deepEqual(buttons[0], buttons[1]);
    await capture("warning-dark-375");
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    assert.deepEqual(errors, []);
});
