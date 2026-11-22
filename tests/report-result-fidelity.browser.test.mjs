import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport, findReportCopy } from "./report-journey-helpers.mjs";

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
