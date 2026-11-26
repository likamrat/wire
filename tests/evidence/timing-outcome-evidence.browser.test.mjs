import { historicalComparison } from "../comparison/historical-comparison-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../../lib/server.mjs";
import { createExportController } from "../../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../../lib/store.mjs";
import { readSavedArtifactFile, loadSavedReportSource, readSavedComparison } from "../../lib/report-artifacts.mjs";
import { pdfDocumentText } from "../../lib/search-corpus-pdf.mjs";
import { privateFixture, chooseTheme, navigateMain, selectActivityOption } from "../support/helpers.mjs";
import { prepareLandingReport } from "../reports/report-journey-helpers.mjs";
import { timeoutRecord } from "./timing-outcome-fixture.mjs";

test("retained timeout cause stays with its tool across reader, new files, saved reading and Compare", { timeout: 90000 }, async t => {
    const at = new Date(Date.now() - 86400000).toISOString();
    const timeout = timeoutRecord("timeout", 180024, at);
    const completed = timeoutRecord("slow-completed", 189438, at), unknown = timeoutRecord("missing-completion", 0, at);
    Object.assign(completed.toolCalls[0], { reportedOutcome: "succeeded", toolSucceeded: true, failureEvidence: null });
    Object.assign(unknown.toolCalls[0], { reportedOutcome: "unknown", toolSucceeded: null,
        completionEventId: null, completedAt: null, durationMs: null, failureEvidence: null });
    const previous = structuredClone(timeout);
    delete previous.toolCalls[0].failureEvidence.messageSignal;
    const cleanup = [], errors = [], denied = [], writes = [];
    let runtime, browser;
    t.after(async () => {
        try { await browser?.close(); await runtime?.close(); assert.deepEqual(errors, []); assert.deepEqual(denied, []); }
        finally { for (const work of cleanup) await work(); }
    });
    const { context } = await privateFixture({ after: work => cleanup.push(work) }, [previous, completed, unknown]);
    const controller = createExportController(context), state = await loadBoardState(context), owner = "timing-fixture";
    const oldPreview = await controller.preview(owner, undefined, { saveMode: "local", promptMode: "none", formats: ["json"],
        reportFocus: { version: 1, preset: "errors", outcome: "errors", services: [] } }, { kind: "all", revision: state.revision });
    const oldBundle = (await controller.confirm(owner, oldPreview.previewId, true, undefined, {
        localSave: { ...oldPreview.localSaveRequest, keepChatDetailsConfirmed: false },
    })).bundle;
    const oldBytes = new Map(await Promise.all(Object.values(oldBundle.files).map(async file => [file, await readFile(file)])));
    await replaceEvidence(context, () => ({ records: [timeout, completed, unknown] }));
    const retainedBefore = (await loadBoardState(context)).evidence;
    runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin
            || /\/api\/(?:collection\/(?:refresh|configure|approve)|recollection|evaluation\/run)/.test(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        if (request.method() !== "GET") writes.push(url.pathname);
        return route.continue();
    });
    await page.goto(runtime.url + "#analyze");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    const card = page.locator("#activityList article").filter({ hasText: "invented timeout request" }).locator(".request-card-open");
    await expect(card).toHaveText("1 tool call failed");
    await expect(card).not.toContainText("The tool did not respond in time");
    await card.click();
    const call = page.locator('[data-tool-call-id="timeout-call"]');
    await expect(call).toContainText("workiq-retrieve");
    await expect(call.locator(".call-duration")).toHaveAttribute("value", "180024");
    const toggle = call.locator(".reader-call-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(call).toContainText("The tool did not respond in time");
    await expect(call).toContainText("allowed waiting interval");
    await page.locator("#closeContextSidebar").click();
    for (const [name, outcome] of [["slow-completed", "success"], ["missing-completion", "unknown"]]) {
        const control = page.locator("#activityList article").filter({ hasText: `invented ${name} request` }).locator(".request-card-open");
        if (outcome === "success") await expect(control).toContainText("1 tool call completed");
        else await expect(control.locator("xpath=ancestor::article[1]")).toContainText(/no result recorded/i);
        await expect(control).not.toContainText(/timed out|did not respond in time|MCP -32001/);
    }
    await navigateMain(page, "reports");
    const preparedResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await prepareLandingReport(page, "errors");
    const response = await preparedResponse, prepared = await response.json();
    assert.equal(response.status(), 200, prepared.error);
    assert.equal(prepared.records.length, 1);
    assert.equal(prepared.snapshot.reportPopulation.reference.length, 3);
    assert.equal(prepared.snapshot.resultFacts.calls[0].observations[0].timingFailure.kind, "request-timeout");
    const report = page.frameLocator(".report-contained-frame");
    await expect(report.locator("body")).toContainText("Request timed out (MCP -32001)");
    await expect(report.locator("body")).toContainText("workiq-retrieve");
    const proofs = process.env.WIRE_TIMING_OUTCOME_PROOFS;
    for (const [theme, width] of [["light", 1280], ["dark", 390]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await expect(report.locator("body")).toContainText("Request timed out (MCP -32001)");
        await report.locator("#patterns").scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofs) {
            await mkdir(proofs, { recursive: true });
            await page.screenshot({ path: path.join(proofs, `timeout-report-${theme}.png`) });
        }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole("button", { name: "Formats: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        assert.equal((await rebuilt).status(), 200);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const savedState = await loadBoardState(context), newBundle = savedState.exports.at(-1);
    const saved = await loadSavedReportSource(context, savedState, newBundle.bundleId);
    assert.equal(saved.resultFacts.calls[0].observations[0].timingFailure.kind, "request-timeout");
    for (const format of ["html", "json", "markdown", "pdf"]) {
        const file = await readSavedArtifactFile(context, savedState, newBundle.bundleId, "report", format);
        if (format === "json") {
            assert.equal(JSON.parse(file.bytes).resultFacts.calls[0].observations[0].timingFailure.kind, "request-timeout");
        } else {
            const text = format === "pdf" ? (await pdfDocumentText(file.bytes)).content.replace(/\s+/g, " ") : file.bytes.toString().replaceAll("\\", "");
            assert.match(text, /Request timed out \(MCP -32001\)/, format);
            assert.match(text, /workiq-retrieve/, format);
            assert.match(text, /allowed waiting interval/, format);
        }
    }
    const [opened] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/report/open")
        && r.request().postDataJSON().view === true), page.getByRole("button", { name: "Open saved report", exact: true }).click()]);
    assert.ok(opened.ok());
    assert.equal((await opened.json()).artifact.bundleId, newBundle.bundleId);
    // Verified Open adds the full-document choice when the brief is ready.
    const reader = page.locator("#savedReportReader");
    await expect(reader.getByRole("article", { name: "Report brief" })).toBeVisible();
    await selectActivityOption(page, "savedReaderFormat", "html");
    const savedCall = reader.frameLocator(".saved-file-preview:visible iframe").locator(`[id="${saved.resultFacts.calls[0].ref}"]`);
    await expect(savedCall.getByRole("heading")).toContainText("workiq-retrieve");
    await expect(savedCall).toContainText("Request timed out (MCP -32001)");
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    const paired = await historicalComparison(context, oldBundle.bundleId, newBundle.bundleId,
        { formats: ["html", "markdown", "json", "pdf"] });
    assert.equal(paired.comparison.resultComparison.shared.changedTypedFacts, 1);
    for (const [name, content] of Object.entries(paired.files)) {
        const text = name.endsWith(".pdf") ? (await pdfDocumentText(Buffer.from(content.data, "base64"))).content.replace(/\s+/g, " ")
            : String(content).replaceAll("\\", "");
        assert.match(text, name.endsWith(".json") ? /timingFailure/ : /Request timed out \(MCP -32001\)/, name);
    }

    const savedPair = paired;
    const reopened = await readSavedComparison(context, await loadBoardState(context), savedPair.bundle.bundleId);
    assert.equal(reopened.comparison.resultComparison.changes[0].later[0].timingFailure.kind, "request-timeout");
    assert.deepEqual((await loadBoardState(context)).evidence, retainedBefore);
    for (const [file, bytes] of oldBytes) assert.deepEqual(await readFile(file), bytes);
    assert.equal(writes.filter(url => url === "/api/export").length, 1);
});
