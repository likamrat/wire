import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, selectActivityOption } from "./helpers.mjs";
import { selectReportFocus } from "./report-journey-helpers.mjs";
import { openDatePicker } from "./analytics-date-picker.mjs";

function record(flag) {
    const value = fixture("result-browser");
    value.toolCalls[0].resultEvidence = { version: 1, source: "sdk-result", applicationError: flag,
        statusCode: null, resultCount: null, contentStatus: "body-excluded",
        ...(flag ? { diagnostic: { version: 1, source: "mcp-result-text", status: "recorded",
            message: "Required scope [Tasks.ReadWrite] is missing." } } : {}) };
    return value;
}

test("recorded error text is an independent masked report copy, not chat disclosure or an edit to the source", async t => {
    const source = record(true);
    source.capturedAt = source.toolCalls[0].startedAt = new Date().toISOString();
    const { context } = await privateFixture(t, [source]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(new URL("/reports", runtime.url).href);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await selectReportFocus(page, "all");
    await page.locator('[name=promptMode][value=none]').check();
    await page.getByRole("button", { name: /^Formats:/ }).click();
    await page.locator("#formatOptions input[value=json]").check();
    await page.keyboard.press("Escape");
    const rebuild = async act => {
        const [response] = await Promise.all([page.waitForResponse("**/api/preview"), act()]);
        const preview = await response.json();
        assert.ok(response.ok(), preview.error);
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        return preview;
    };
    const initial = await rebuild(() => page.locator("#prepareReportPreview").click());
    assert.doesNotMatch(initial.previewHtml, /Required scope \[Tasks\.ReadWrite\] is missing/);
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const withText = await rebuild(() => page.locator("#reportResultText").check());
    assert.equal(withText.snapshot.resultFacts.calls[0].observations[0].applicationError, true);
    await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done" }).click();
    await selectActivityOption(page, "preparedReportView", "text");
    const copy = page.locator(".prompt-comparison").filter({ hasText: "Required scope" });
    while (!await copy.count()) await page.getByRole("button", { name: "Next report copies", exact: true }).click();
    await copy.getByText("Edit or omit this report copy", { exact: true }).click();
    await copy.locator("textarea").fill("Retained scope diagnostic for reviewer@example.invalid.");
    const edited = await rebuild(() => copy.getByRole("button", { name: "Update report copy" }).click());
    assert.equal(edited.snapshot.resultText.copies[0].representation, "edited-copy");
    assert.deepEqual(edited.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    assert.doesNotMatch(edited.previewHtml, /reviewer@example\.invalid/);
    assert.match(edited.previewHtml, /Retained scope diagnostic/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context), [saved] = state.exports;
    assert.deepEqual(JSON.parse(await readFile(saved.files["product-report.json"], "utf8")).resultText, edited.snapshot.resultText);
    assert.equal(state.evidence[0].toolCalls[0].resultEvidence.diagnostic.message, source.toolCalls[0].resultEvidence.diagnostic.message);
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
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(12000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#analyze?scope=all");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#comparePeriods").click();
    await openDatePicker(page, "compare", "Custom dates");
    for (const [label, value] of [["Period A from", "2026-10-01"], ["Period A to", "2026-10-01"],
        ["Period B from", "2026-10-02"], ["Period B to", "2026-10-02"]]) await page.getByLabel(label, { exact: true }).fill(value);
    const pending = page.waitForResponse(response => response.url().endsWith("/api/period-comparison"));
    await page.locator("#applyPeriodComparison").click();
    const response = await pending, live = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(live));
    assert.equal(live.resultComparison.groups[0].applicationErrorDelta, 100);
    await page.getByRole("button", { name: "View numbers", exact: true }).click();
    const groups = page.getByRole("table", { name: "Recorded application/API errors" });
    for (const [index, count] of [[1, "0"], [2, "1"]]) {
        const row = groups.getByRole("row").nth(index);
        await expect(row.locator('[data-label="Calls with recorded errors"]')).toHaveText(count);
        await expect(row.locator('[data-label="Selected calls"]')).toHaveText("1");
    }
    await page.keyboard.press("Escape");
    await page.locator("#createPeriodReport").click();
    await expect(page.locator("#reportDeskDates")).toBeHidden();
    await page.locator("#reportPrivacyChoice").click();
    await page.locator('[name=promptMode][value=none]').check();
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    const responseWithErrors = page.waitForResponse(value => value.url().endsWith("/api/preview") && value.request().postDataJSON().options.resultText);
    await page.locator("#reportResultText").check();
    const prepared = await (await responseWithErrors).json();
    assert.deepEqual(prepared.snapshot.periodComparison.resultComparison, live.resultComparison);
    assert.equal(prepared.snapshot.resultFacts, undefined);
    await page.locator("#reportIncludeOptions").getByRole("button", { name: "Done", exact: true }).click();
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    assert.equal((await loadBoardState(context)).exports.length, 1);
    assert.deepEqual(errors, []);
});
