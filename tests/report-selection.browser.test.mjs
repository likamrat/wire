import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, openActivitySessions } from "./helpers.mjs";
import { openDatePicker } from "./analytics-date-picker.mjs";
import { periodFixture } from "./period-comparison-fixture.mjs";

async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    if (await page.locator("#moreFilters").isVisible() && await page.locator("#moreFilters").getAttribute("open") === null) await page.locator("#moreFilters>summary").click();
    await openActivitySessions(page);
}
async function inventory(root) {
    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    return Object.fromEntries(await Promise.all(files.map(async entry => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), createHash("sha256").update(await readFile(file)).digest("hex")];
    })));
}
async function setup(t, { total = 18, sharedPair = [0, 1] } = {}) {
    const records = Array.from({ length: total }, (_, index) => {
        const record = fixture(`selection-${index}`);
        record.userPrompt.text = `Selection request ${String(index).padStart(2, "0")}`;
        record.toolCalls[0].toolSucceeded = index % 3 === 2 ? undefined : index % 3 === 0;
        record.toolCalls[0].reportedOutcome = index % 3 === 0 ? "succeeded" : index % 3 === 1 ? "failed" : "unknown";
        return record;
    });
    records[sharedPair[1]].toolCalls.unshift(structuredClone(records[sharedPair[0]].toolCalls[0]));
    const { context } = await privateFixture(t, records), controller = createExportController(context);
    const initial = await loadBoardState(context);
    const previous = await controller.preview("existing-synthetic-report", undefined, { promptMode: "none", formats: ["html"] }, { kind: "selected", revision: initial.revision, scenarioIds: ["selection-0"] });
    await controller.review("existing-synthetic-report", previous.previewId, true);
    await controller.confirm("existing-synthetic-report", previous.previewId, true);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const before = await inventory(context.dataDir);
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
    page.setDefaultTimeout(10000);
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        readText: () => { throw new Error("Clipboard is excluded from selection proof."); },
        writeText: () => { throw new Error("Clipboard is excluded from selection proof."); },
    } }));
    async function preserved() {
        assert.deepEqual(await inventory(context.dataDir), before, "All evidence, classifications and previously saved report bytes remain unchanged");
        assert.ok(!requests.some(request => ["/api/export", "/api/move", "/api/import", "/api/record", "/api/report-file"].includes(request.path)));
        assert.deepEqual(errors, []);
    }
    return { page, runtime, context, requests, errors, preserved };
}
test("reader cannot replace paired report cohorts with individual selection", { timeout: 30000 }, async t => {
    const { records } = periodFixture();
    const { context } = await privateFixture(t, records);
    const initial = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, frontend: "react", collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    await page.goto(runtime.url); await ready(page);
    await page.locator("#comparePeriods").click();
    await openDatePicker(page, "compare", "Custom dates");
    for (const [name, value] of [["Period A from", "2026-03-07"], ["Period A to", "2026-03-07"],
        ["Period B from", "2026-03-08"], ["Period B to", "2026-03-09"]]) await page.getByLabel(name, { exact: true }).fill(value);
    await page.locator("#applyPeriodComparison").click();
    await expect(page.locator("#createPeriodReport")).toBeEnabled();
    await page.locator("#createPeriodReport").click(); await ready(page);
    await page.getByRole("button", { name: "Change what's included", exact: true }).click();
    await page.getByRole("button", { name: "Change activity selection", exact: true }).click();
    const scope = await page.locator("#periodReportScope").textContent();
    await page.locator("#reportList .request-card-open").first().click(); await ready(page);
    await expect(page.locator("#requestReportToggle")).toBeDisabled();
    await expect(page.locator("#requestReportToggle")).toBeHidden();
    await expect(page.locator("#requestReportContinue")).toHaveText("Back to activity");
    const location = page.url();
    await page.locator("#requestReportToggle").evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(page.url(), location);
    await expect(page.locator("#message")).toContainText("paired periods");
    await page.getByRole("button", { name: "Back to activity", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#periodReportScope").textContent(), scope);
    assert.deepEqual(requests.filter(value => ["/api/preview", "/api/privacy-review", "/api/export"].includes(value)), ["/api/preview"]);
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, initial.evidence);
    assert.deepEqual(after.exports, initial.exports);
    assert.deepEqual(errors, []);
});

test("picker checkboxes follow resolved shared-call membership without losing focus or hidden selections", { timeout: 30000 }, async t => {
    const { page, runtime, preserved } = await setup(t);
    await page.goto(new URL("/reports", runtime.url).href); await ready(page);
    await page.locator("#reportDeskActivity").click();
    await page.getByRole("radio", { name: /^Selected interactions/ }).check();
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    await page.locator("#report-select-selection-5").check();
    await page.getByRole("button", { name: "Previous report requests", exact: true }).click();
    const a = page.locator("#report-select-selection-0"), b = page.locator("#report-select-selection-1");
    await b.check();
    assert.equal(await a.isChecked(), true, "Selecting shared-call alias B includes canonical A and must paint its checkbox");
    assert.equal(await b.isChecked(), true);
    assert.equal(await b.evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator("#reportList").innerText(), /1-4 of 18/);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /3 interactions/);
    await a.uncheck();
    assert.equal(await a.isChecked(), false);
    assert.equal(await b.isChecked(), false, "Removing alias-expanded A removes its contributing explicit B selection too");
    assert.equal(await a.evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /1 interaction$/);
    await a.check(); await b.check(); await b.uncheck();
    assert.equal(await a.isChecked(), true, "An independently selected A survives removing B");
    assert.equal(await b.isChecked(), false);
    assert.match(await page.locator("#previewSelectionSummary").textContent(), /2 interactions/);
    await page.getByRole("button", { name: "Next report requests", exact: true }).click();
    assert.equal(await page.locator("#report-select-selection-5").isChecked(), true);
    await preserved();
});
