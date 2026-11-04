import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport, findReportCopy, openReportComparison } from "./report-journey-helpers.mjs";

function record(flag) {
    const value = fixture("result-browser");
    value.toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError: flag,
        statusCode: null, resultCount: null, contentStatus: "body-excluded",
        ...(flag ? { diagnostic: { version: 1, source: "mcp-result-text", status: "recorded",
            message: "Required scope [Tasks.ReadWrite] is missing." } } : {}) };
    return value;
}

test("normal report and saved comparison separately review, save and reopen masked result text", { timeout: 120000 }, async t => {
    const { context } = await privateFixture(t, [record(false)]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const savedIds = [];
    for (const flag of [false, true]) {
        if (flag) {
            await page.getByRole("button", { name: "Start a new report", exact: true }).click();
            await replaceEvidence(context, () => ({ records: [record(true)] }));
            await page.reload();
        }
        await page.goto(runtime.url + "#reports?task=create");
        await page.locator('#workspace[aria-busy="false"]').waitFor();
        await chooseReportScope(page, "all");
        await reportContents(page);
        await page.locator('[name=promptMode][value=none]').check();
        await expect(page.locator("#reportResultText")).not.toBeChecked();
        await page.locator("#reportResultText").check();
        await page.locator("#formatOptions input[value=json]").check();
        const preview = await scanReport(page);
        assert.equal(preview.snapshot.resultFacts.calls[0].observations[0].applicationError, flag);
        assert.equal((await loadBoardState(context)).exports.length, savedIds.length);
        if (flag) {
            const copy = await findReportCopy(page, "Required scope");
            await expect(copy.locator("h4")).toContainText("Recorded error");
            await expect(copy.locator("h4")).not.toContainText("Author unverified");
            await copy.getByText("Edit or omit this report copy", { exact: true }).click();
            await expect(copy.locator("textarea")).toBeEnabled();
            await expect(copy).toContainText("personal values will be masked again");
            await copy.locator("textarea").fill("Required scope [Tasks.ReadWrite] is missing. Reviewed report wording.");
            const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
            await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
            const updated = await (await rebuilt).json();
            assert.equal(updated.snapshot.resultText.copies[0].representation, "edited-copy");
            await page.locator("#reportsView[data-report-phase=ready]").waitFor();
        }
        await page.locator(".attestation input[data-review-control]").check();
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
        assert.equal((await loadBoardState(context)).exports.length, savedIds.length);
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await page.locator("#reportsView[data-report-phase=saved]").waitFor();
        savedIds.push((await loadBoardState(context)).exports.at(-1).bundleId);
    }
    await openReportComparison(page);
    for (const [name, id] of [["Earlier report", savedIds[0]], ["Later report", savedIds[1]]]) {
        await page.getByRole("combobox", { name, exact: true }).click();
        await page.locator(`.select-popup .select-option[data-value="${id}"]`).click();
    }
    const comparison = page.locator("#comparisonWorkspace");
    await comparison.getByRole("button", { name: "Compare reports", exact: true }).click();
    await expect(comparison.locator(".comparison-result-evidence")).toContainText("+100.0 percentage points");
    await expect(page.locator("#comparisonResultText")).not.toBeChecked();
    await page.locator("#comparisonResultText").check();
    await page.locator("#comparisonResultTerms").fill("Tasks.ReadWrite");
    const pending = page.waitForResponse(response => response.url().endsWith("/api/report-comparison/preview"));
    await comparison.getByRole("button", { name: "Prepare comparison copy", exact: true }).click();
    const response = await pending, prepared = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(prepared));
    assert.equal(prepared.comparison.toolComparison.raw.change.success, 0);
    assert.equal(prepared.comparison.resultComparison.groups[0].applicationErrorDelta, 100);
    assert.equal(prepared.comparison.resultTextSources.sources[1].resultText.copies[0].representation, "edited-copy");
    await expect(comparison.frameLocator(".report-frame").locator("body")).toContainText("Required scope");
    await comparison.frameLocator(".report-frame").locator("h1").scrollIntoViewIfNeeded();
    await expect(comparison.frameLocator(".report-frame").locator("body")).not.toContainText("Tasks.ReadWrite");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await expect(comparison.frameLocator(".report-frame").locator("body")).toContainText("Required scope");
        await comparison.frameLocator(".report-frame").locator("p").last().scrollIntoViewIfNeeded();
        await comparison.frameLocator(".report-frame").locator("h1").scrollIntoViewIfNeeded();
        // Let Chromium composite the newly reattached sandboxed document after theme repaint.
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.WIRE_REPORT_PROOFS) await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS, `result-report-comparison-${theme}.png`), fullPage: true });
    }
    await comparison.getByLabel("I reviewed this frozen comparison for disclosure.", { exact: true }).check();
    await comparison.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await expect(comparison.getByRole("button", { name: "Save comparison", exact: true })).toBeVisible();
    assert.equal((await loadBoardState(context)).exports.filter(value => value.kind === "comparison").length, 0);
    await comparison.getByRole("button", { name: "Save comparison", exact: true }).click();
    await comparison.getByRole("button", { name: "Open saved comparison", exact: true }).click();
    await expect(page.getByRole("region", { name: "Saved file preview", exact: true }).frameLocator("iframe").locator("body")).toContainText("Required scope");
    assert.deepEqual(errors, []);
});

test("normal live-period selection carries the independent result change into reviewed report Save", { timeout: 90000 }, async t => {
    const records = [false, true].map((flag, index) => {
        const value = record(flag);
        value.scenarioId += index;
        value.toolCalls[0].toolCallId += index;
        value.toolCalls[0].startEventId += index;
        value.toolCalls[0].startedAt = `2026-10-0${index + 1}T12:00:00.000Z`;
        return value;
    });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(12000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#analyze?scope=all");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#comparePeriods").click();
    for (const [label, value] of [["Period A from", "2026-10-01"], ["Period A to", "2026-10-01"],
        ["Period B from", "2026-10-02"], ["Period B to", "2026-10-02"]]) await page.getByLabel(label, { exact: true }).fill(value);
    const pending = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
    await page.locator("#applyPeriodComparison").click();
    const response = await pending, live = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(live));
    assert.equal(live.resultComparison.groups[0].applicationErrorDelta, 100);
    await expect(page.locator("#periodComparisonResults .comparison-result-evidence")).toContainText("+100.0 percentage points");
    await page.locator("#createPeriodReport").click();
    await reportContents(page);
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#reportResultText").check();
    const prepared = await scanReport(page);
    assert.deepEqual(prepared.snapshot.periodComparison.resultComparison, live.resultComparison);
    assert.equal(prepared.snapshot.resultFacts, undefined);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.deepEqual(errors, []);
});
